// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @title ERC4626Adapter
/// @notice One adapter for **any** natively-ERC-4626 yield vault, on any chain.
///
///         `MorphoAdapter` and `FluidAdapter` are byte-for-byte the same logic with a different
///         hardcoded vault and a hardcoded Arbitrum-USDC check — MorphoAdapter's own header says
///         *"Identical in structure to FluidAdapter — both wrap an ERC-4626 vault."* This contract
///         is that observation taken seriously: the vault address and the expected asset become
///         **constructor arguments**, so adding a new 4626 strategy is a deploy + `registerStrategy`
///         call rather than ~200 lines of new, separately-audited code.
///
///         Covers (non-exhaustively) MetaMorpho/Morpho curated vaults, Fluid fTokens, Aave
///         stataTokens, Yearn v3, Euler v2 eVaults, Spark/sUSDS, Moonwell — anything exposing a
///         real `asset()/deposit()/redeem()/convertToAssets()/maxWithdraw()` surface.
///
///         **Not** for venues that aren't natively 4626 — Compound v3 Comet (`baseToken()`, no
///         `asset()`), GMX GM pools, Pendle PT/YT, HLP. Those keep bespoke adapters, correctly.
///
/// @dev Semantics are preserved exactly from the adapters this replaces so that vault-side
///      accounting is unchanged:
///        - `totalAssets()` = `convertToAssets(balanceOf(this))`.
///        - `withdraw()` is capped by BOTH assets held and `maxWithdraw()`, returns actual delivered,
///          and never reverts merely because the venue is illiquid — it delivers what it can.
///        - `harvest()` realises **half** the excess over principal (`excess / 2`) and leaves the
///          rest compounding. This is the consistent convention across MorphoAdapter, FluidAdapter
///          AND AaveAdapterV5 — it is deliberate, not a rounding artifact, so it is kept.
///        - share burn uses ceiling division, capped at the balance.
///
/// @custom:security-contact di0zchain@diamondzshadow.net
contract ERC4626Adapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables ─────────
    IERC20   public immutable ASSET;
    IERC4626 public immutable YIELD_VAULT;

    /// @notice Human-readable label, e.g. "Morpho Gauntlet USDC Prime (Base)". Set once at deploy so
    ///         a deployed adapter is self-describing on a block explorer — with many strategies live
    ///         across chains, an unlabelled address is a liability.
    string public label;

    // ───────── State ─────────
    uint256 public totalPrincipal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 shares, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error ZeroAddress();
    error AssetMismatch(address expected, address actual);
    error VaultClosedToDeposits();
    error FeeOnTransferAsset();

    /// @param admin        Initial DEFAULT_ADMIN_ROLE holder (Safe in production).
    /// @param yieldVault   The ERC-4626 vault to wrap.
    /// @param expectedAsset The asset we require `yieldVault.asset()` to equal. Passed explicitly
    ///        rather than hardcoded, which is what makes this adapter chain-portable — but it is
    ///        still asserted, so a misconfigured deploy fails immediately instead of silently
    ///        wiring the wrong token.
    ///        🚨 On Polygon, native USDC and bridged USDC.e share the SAME symbol AND decimals;
    ///        only `name()` differs. Pass the address deliberately.
    /// @param label_       Human-readable strategy label.
    constructor(address admin, address yieldVault, address expectedAsset, string memory label_) {
        if (admin == address(0) || yieldVault == address(0) || expectedAsset == address(0)) {
            revert ZeroAddress();
        }

        YIELD_VAULT = IERC4626(yieldVault);
        address underlying = YIELD_VAULT.asset();
        if (underlying != expectedAsset) revert AssetMismatch(expectedAsset, underlying);

        ASSET = IERC20(underlying);
        label = label_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        ASSET.forceApprove(yieldVault, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(ASSET);
    }

    /// @inheritdoc IYieldAdapter
    function totalAssets() external view override returns (uint256) {
        return YIELD_VAULT.convertToAssets(YIELD_VAULT.balanceOf(address(this)));
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Reverts with `VaultClosedToDeposits` when the venue is at cap or winding down. This is a
    ///      real, live condition — Morpho's largest Polygon USDC vault reports `maxDeposit() == 0`
    ///      as a withdraw-only wind-down — and a named error is far easier to diagnose than the
    ///      venue's own internal revert.
    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (YIELD_VAULT.maxDeposit(address(this)) < amount) revert VaultClosedToDeposits();

        // Measure actual receipt rather than trusting `amount`: a fee-on-transfer asset would
        // otherwise inflate `totalPrincipal` above what we really hold and permanently suppress
        // harvest (which only pays out above principal).
        uint256 before = ASSET.balanceOf(address(this));
        ASSET.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = ASSET.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferAsset();

        uint256 shares = YIELD_VAULT.deposit(received, address(this));
        totalPrincipal += received;
        emit Deposited(msg.sender, received, shares, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Delivers what it can rather than reverting on partial liquidity — the vault above
    ///      relies on the returned `delivered` amount.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 shares = YIELD_VAULT.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = YIELD_VAULT.convertToAssets(shares);
        if (assetsHeld == 0) return 0;

        uint256 maxOut = YIELD_VAULT.maxWithdraw(address(this));
        uint256 cap = assetsHeld < maxOut ? assetsHeld : maxOut;
        uint256 toWithdraw = amount > cap ? cap : amount;

        if (toWithdraw == 0) {
            emit Withdrawn(msg.sender, amount, 0, totalPrincipal);
            return 0;
        }

        uint256 sharesToBurn = (toWithdraw * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        delivered = YIELD_VAULT.redeem(sharesToBurn, address(this), address(this));
        ASSET.safeTransfer(msg.sender, delivered);

        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Realises HALF the excess over principal and leaves the remainder compounding — the
    ///      convention shared by every existing V15 adapter. Do not "fix" this to harvest in full
    ///      without changing them all together; vault-side accounting assumes it.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 shares = YIELD_VAULT.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = YIELD_VAULT.convertToAssets(shares);
        if (assetsHeld <= totalPrincipal) return 0;

        uint256 excess = assetsHeld - totalPrincipal;
        uint256 toHarvest = excess / 2;
        if (toHarvest == 0) return 0;

        uint256 sharesToBurn = (toHarvest * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        profit = YIELD_VAULT.redeem(sharesToBurn, address(this), address(this));
        if (profit > 0) {
            ASSET.safeTransfer(msg.sender, profit);
        }

        emit Harvested(msg.sender, profit);
    }

    /// @inheritdoc IYieldAdapter
    function syncAccounting(uint256 newPrincipal) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views — useful for keepers / UI across many live strategies
    // ═══════════════════════════════════════════════════════════

    /// @notice Assets withdrawable from the venue right now. With many strategies live this is the
    ///         number that decides whether a strategy can honour an exit, so expose it explicitly.
    function availableLiquidity() external view returns (uint256) {
        return YIELD_VAULT.maxWithdraw(address(this));
    }

    /// @notice True when the venue still accepts deposits (not at cap, not winding down).
    function acceptingDeposits() external view returns (bool) {
        return YIELD_VAULT.maxDeposit(address(this)) > 0;
    }

    /// @notice Unrealised profit above recorded principal.
    function pendingYield() external view returns (uint256) {
        uint256 held = YIELD_VAULT.convertToAssets(YIELD_VAULT.balanceOf(address(this)));
        return held > totalPrincipal ? held - totalPrincipal : 0;
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault);
    }

    function removeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault);
    }

    /// @dev The managed asset and the vault's own shares are protected — rescue must never be able
    ///      to drain the position or the harvested principal.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(ASSET) && token != address(YIELD_VAULT), "protected");
        IERC20(token).safeTransfer(to, amount);
    }
}
