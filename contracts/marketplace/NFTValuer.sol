// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {INFTValuer, IVaultValue, IFloorOracle} from "../interfaces/INFTValuer.sol";
import {DiggerRegistry} from "./DiggerRegistry.sol";

/// @title NFTValuer
/// @notice Per-tokenId valuation + liquidation-strategy dispatcher for every
///         NFT collection registered in DiggerRegistry. LendingPool reads
///         `valueOf` during borrow / liquidation-health checks instead of
///         hard-coding `vault.estimatePositionValue`.
///
///         Rationale: the V15 stack originally tied lending directly to Pool
///         NFTs that expose a `vault()` getter, which silently broke any path
///         for outside JPEGs. This sidecar lets DiggerRegistry accept multiple
///         collection TYPES (vault-backed, floor-priced, static) without
///         migrating the existing registry deployment.
///
///         Config lifecycle:
///           1. Digger registers collection in DiggerRegistry (existing flow).
///           2. Valuer admin (Safe) calls `setVaultMode` / `setFloorMode` /
///              `setStaticMode` to pick the pricing source.
///           3. LendingPool reads `valueOf(nft, tokenId)` per request.
///           4. On liquidation, LendingPool branches on `strategy(nft)`.
///
///         Safety:
///           - `valueOf` is view-only. Never calls untrusted contracts at
///             a state-changing depth; any revert in the source propagates
///             and the borrow/liquidation trigger reverts cleanly.
///           - Optional `maxValueUSDC` clamp bounds the per-tokenId value even
///             in VAULT_POSITION mode — defensive cap against a compromised
///             or buggy vault returning an inflated value.
///           - `setVaultMode` verifies the source implements IVaultValue by
///             making a throwaway view call; bad sources revert at config time,
///             not at borrow time.
contract NFTValuer is AccessControl, INFTValuer {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    DiggerRegistry public immutable REGISTRY;

    struct Config {
        Mode     mode;
        address  source;         // vault (VAULT_POSITION) or oracle (FLOOR_ORACLE); 0 for STATIC
        uint256  staticValueUSDC;// exact value (STATIC_USDC) or max-clamp (other modes when != 0)
    }

    mapping(address => Config) private _configs;

    event VaultModeSet(address indexed nft, address indexed vault, uint256 maxValueClampUSDC);
    event FloorModeSet(address indexed nft, address indexed oracle, uint256 maxValueClampUSDC);
    event StaticModeSet(address indexed nft, uint256 staticValueUSDC);
    event MirrorModeSet(address indexed nft, address indexed source, uint256 maxValueClampUSDC);
    event Cleared(address indexed nft);

    error UnconfiguredCollection(address nft);
    error NotVaultMode(address nft);
    error ZeroAddress();
    error ZeroValue();
    error VaultInterfaceCheckFailed(address source);
    error NotRegisteredInDiggerRegistry(address nft);

    constructor(address admin, address registry) {
        if (admin == address(0) || registry == address(0)) revert ZeroAddress();
        REGISTRY = DiggerRegistry(payable(registry));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
    }

    // ════════════════════════════════════════════════════════════
    //  Config (CONFIG_ROLE)
    // ════════════════════════════════════════════════════════════

    /// @notice Configure `nft` to price from a live vault position.
    ///         `vault` must implement `estimatePositionValue(posId)`; we probe
    ///         with tokenId=0 at config time — the probe MAY revert (e.g. no
    ///         position #0) and we still accept as long as the call did not
    ///         trap on a missing selector.
    /// @param maxValueClampUSDC Optional upper bound on returned value
    ///         (0 = no clamp). Applied post-source to cap buggy/compromised
    ///         vault outputs.
    function setVaultMode(address nft, address vault, uint256 maxValueClampUSDC)
        external
        onlyRole(CONFIG_ROLE)
    {
        if (nft == address(0) || vault == address(0)) revert ZeroAddress();
        _requireRegistered(nft);

        // Reject EOAs up-front — Solidity's own extcodesize pre-check reverts
        // without a reason, which is harder to surface cleanly from a catch.
        if (vault.code.length == 0) revert VaultInterfaceCheckFailed(vault);

        // Strict ABI probe — MUST return the 3-tuple shape of
        // estimatePositionValue. Catches contracts whose selector doesn't
        // match (ERC20s, wrong contracts). V15 vaults return (0,0,0)
        // cleanly for unset posId=0, so this probe never false-rejects a
        // legitimate vault.
        try IVaultValue(vault).estimatePositionValue(0) returns (uint256, uint256, uint256) {
            // ok — vault returned the expected tuple shape
        } catch {
            revert VaultInterfaceCheckFailed(vault);
        }

        _configs[nft] = Config({
            mode: Mode.VAULT_POSITION,
            source: vault,
            staticValueUSDC: maxValueClampUSDC
        });
        emit VaultModeSet(nft, vault, maxValueClampUSDC);
    }

    /// @notice Configure `nft` to price from a collection-floor oracle.
    function setFloorMode(address nft, address oracle, uint256 maxValueClampUSDC)
        external
        onlyRole(CONFIG_ROLE)
    {
        if (nft == address(0) || oracle == address(0)) revert ZeroAddress();
        _requireRegistered(nft);
        _configs[nft] = Config({
            mode: Mode.FLOOR_ORACLE,
            source: oracle,
            staticValueUSDC: maxValueClampUSDC
        });
        emit FloorModeSet(nft, oracle, maxValueClampUSDC);
    }

    /// @notice Configure `nft` with a fixed admin-set value (USDC 6-dec).
    function setStaticMode(address nft, uint256 valueUSDC) external onlyRole(CONFIG_ROLE) {
        if (nft == address(0)) revert ZeroAddress();
        if (valueUSDC == 0) revert ZeroValue();
        _requireRegistered(nft);
        _configs[nft] = Config({
            mode: Mode.STATIC_USDC,
            source: address(0),
            staticValueUSDC: valueUSDC
        });
        emit StaticModeSet(nft, valueUSDC);
    }

    /// @notice Configure `nft` to price from a per-tokenId value source (same
    ///         as VAULT_POSITION), but with MARKETPLACE_AUCTION liquidation
    ///         strategy. For CCIP-bridged / wrapped NFTs that report their own
    ///         value via IVaultValue but can't be unwound via vault call.
    /// @param source  IVaultValue-shaped value source. MUST implement
    ///                `estimatePositionValue(uint256) -> (uint256,uint256,uint256)`.
    ///                Same strict probe as setVaultMode.
    function setMirrorMode(address nft, address source, uint256 maxValueClampUSDC)
        external
        onlyRole(CONFIG_ROLE)
    {
        if (nft == address(0) || source == address(0)) revert ZeroAddress();
        _requireRegistered(nft);
        if (source.code.length == 0) revert VaultInterfaceCheckFailed(source);
        try IVaultValue(source).estimatePositionValue(0) returns (uint256, uint256, uint256) {
            // ok
        } catch {
            revert VaultInterfaceCheckFailed(source);
        }
        _configs[nft] = Config({
            mode: Mode.VAULT_MIRROR,
            source: source,
            staticValueUSDC: maxValueClampUSDC
        });
        emit MirrorModeSet(nft, source, maxValueClampUSDC);
    }

    /// @notice Revert `nft` to NONE — LendingPool will refuse new borrows
    ///         against it (existing loans continue until repaid/liquidated).
    function clear(address nft) external onlyRole(CONFIG_ROLE) {
        delete _configs[nft];
        emit Cleared(nft);
    }

    function _requireRegistered(address nft) internal view {
        (, , , bool accepted, ) = REGISTRY.collections(nft);
        if (!accepted) revert NotRegisteredInDiggerRegistry(nft);
    }

    // ════════════════════════════════════════════════════════════
    //  Read API (INFTValuer)
    // ════════════════════════════════════════════════════════════

    /// @inheritdoc INFTValuer
    function liveValue(address nft, uint256 tokenId) external view returns (uint256 usdc) {
        Config memory c = _configs[nft];
        if (c.mode == Mode.NONE) return 0;

        if (c.mode == Mode.VAULT_POSITION || c.mode == Mode.VAULT_MIRROR) {
            // Both modes pull per-tokenId value from an IVaultValue source.
            // They differ only in liquidation strategy (VAULT_UNWIND vs AUCTION).
            (, , usdc) = IVaultValue(c.source).estimatePositionValue(tokenId);
        } else if (c.mode == Mode.FLOOR_ORACLE) {
            usdc = IFloorOracle(c.source).floorUSDC(nft);
        } else {
            // STATIC_USDC — tokenId ignored
            usdc = c.staticValueUSDC;
            return usdc;
        }

        // Optional max-value clamp (0 = no clamp) for dynamic modes.
        if (c.staticValueUSDC != 0 && usdc > c.staticValueUSDC) {
            usdc = c.staticValueUSDC;
        }
    }

    /// @inheritdoc INFTValuer
    function strategy(address nft) external view returns (Strategy) {
        Mode m = _configs[nft].mode;
        if (m == Mode.NONE) revert UnconfiguredCollection(nft);
        if (m == Mode.VAULT_POSITION) return Strategy.VAULT_UNWIND;
        // FLOOR_ORACLE, STATIC_USDC, VAULT_MIRROR all use marketplace-auction liquidation.
        return Strategy.MARKETPLACE_AUCTION;
    }

    /// @inheritdoc INFTValuer
    function modeOf(address nft) external view returns (Mode) {
        return _configs[nft].mode;
    }

    /// @inheritdoc INFTValuer
    function vaultFor(address nft) external view returns (address) {
        Config memory c = _configs[nft];
        if (c.mode != Mode.VAULT_POSITION) revert NotVaultMode(nft);
        return c.source;
    }

    /// @notice Full config view for off-chain tooling / UI.
    function configOf(address nft) external view returns (Mode, address, uint256) {
        Config memory c = _configs[nft];
        return (c.mode, c.source, c.staticValueUSDC);
    }

    // ════════════════════════════════════════════════════════════
    //  Rescue (admin) — contract holds no assets legitimately;
    //  all balances are strays.
    // ════════════════════════════════════════════════════════════

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error ZeroRescueAddress();
    error NativeRescueFailed();

    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroRescueAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroRescueAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    receive() external payable {}
}
