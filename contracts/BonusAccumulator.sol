// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IBonusAccumulator} from "./interfaces/IBonusAccumulator.sol";

/// @title BonusAccumulator
/// @notice Distributes USDC from three independent revenue streams
///         (Bridge / SDM / Validator) to active ShadowVaultV15 position NFTs,
///         weighted by `depositAmount × tierMultiplier`.
///
/// @dev Synthetix-style checkpoint model, one accumulator per stream:
///
///   accPerShare[stream] += (incomingAmount * 1e18) / totalWeight
///   pending[tokenId][stream] += weight[tokenId] * (accPerShare[stream] - debt[tokenId][stream]) / 1e18
///   debt[tokenId][stream]    = accPerShare[stream]
///
/// Positions are registered by the vault on deposit (registerPosition) and
/// deregistered on withdraw (deregisterPosition) — deregister auto-claims
/// pending bonuses to the owner in one shot. This avoids the old V14 pattern
/// where accounting drifted across streams.
///
/// A zero-address accumulator is a no-op for the vault — the vault can be
/// deployed before the bridge / SDM / validator revenue wiring is live.
///
/// Roles:
///   DEFAULT_ADMIN_ROLE — deployer EOA → Gnosis Safe post-test. Can add
///                        authorized notifiers and revoke positions.
///   VAULT_ROLE        — the ShadowVaultV15 contract(s) that register positions.
///   NOTIFIER_ROLE     — revenue sources that push new funds into a stream
///                        (BridgeFeeDAO, SDM reward emitter, validator fee DAO).
contract BonusAccumulator is IBonusAccumulator, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant NOTIFIER_ROLE = keccak256("NOTIFIER_ROLE");

    // ───────── Constants ─────────
    IERC20 public constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);

    uint8 public constant STREAM_COUNT = 3;
    uint8 public constant STREAM_BRIDGE = 0;
    uint8 public constant STREAM_SDM = 1;
    uint8 public constant STREAM_VALIDATOR = 2;

    uint256 public constant ACC_PRECISION = 1e18;

    // ───────── State ─────────
    /// @notice Active position weight (depositAmount × tierMultiplier / BPS).
    mapping(uint256 => uint256) public positionWeight;
    /// @notice NFT owner at registration time. Used as claim destination.
    mapping(uint256 => address) public positionOwner;
    /// @notice Sum of all active position weights.
    uint256 public totalWeight;

    /// @notice Per-stream global accumulator (1e18-scaled USDC per weight unit).
    uint256[STREAM_COUNT] public accPerWeight;

    /// @notice Per-(tokenId, stream) debt baseline.
    mapping(uint256 => uint256[STREAM_COUNT]) public debt;

    /// @notice Cached pending from partial checkpoints (not yet paid out).
    mapping(uint256 => uint256[STREAM_COUNT]) public cached;

    /// @notice Total USDC ever routed through each stream (informational).
    uint256[STREAM_COUNT] public totalRouted;

    // ───────── Events ─────────
    event PositionRegistered(uint256 indexed tokenId, address indexed owner, uint256 weight, uint256 newTotalWeight);
    event PositionDeregistered(uint256 indexed tokenId, uint256 claimed);
    event BonusNotified(uint8 indexed stream, address indexed notifier, uint256 amount, uint256 newAccPerWeight);
    event BonusClaimed(uint256 indexed tokenId, address indexed to, uint256 amount);

    // ───────── Errors ─────────
    error InvalidStream();
    error ZeroAmount();
    error NoWeight();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();

    // ───────── Constructor ─────────
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════
    //  IBonusAccumulator
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IBonusAccumulator
    function registerPosition(uint256 tokenId, address owner, uint256 weight)
        external
        override
        onlyRole(VAULT_ROLE)
    {
        if (owner == address(0)) revert ZeroAddress();
        if (weight == 0) revert NoWeight();
        if (positionWeight[tokenId] != 0) revert AlreadyRegistered();

        positionWeight[tokenId] = weight;
        positionOwner[tokenId] = owner;
        totalWeight += weight;

        // Snap the debt baseline to the current accumulator so this position
        // only earns from *future* notifications, not historical ones.
        for (uint8 i; i < STREAM_COUNT; i++) {
            debt[tokenId][i] = accPerWeight[i];
        }

        emit PositionRegistered(tokenId, owner, weight, totalWeight);
    }

    /// @inheritdoc IBonusAccumulator
    function deregisterPosition(uint256 tokenId)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        uint256 weight = positionWeight[tokenId];
        if (weight == 0) revert NotRegistered();

        address owner = positionOwner[tokenId];
        uint256 totalPending = _pendingTotal(tokenId, weight);

        // Clear state BEFORE transfer (CEI).
        positionWeight[tokenId] = 0;
        positionOwner[tokenId] = address(0);
        for (uint8 i; i < STREAM_COUNT; i++) {
            debt[tokenId][i] = 0;
            cached[tokenId][i] = 0;
        }
        totalWeight -= weight;

        if (totalPending > 0) {
            USDC.safeTransfer(owner, totalPending);
        }

        emit PositionDeregistered(tokenId, totalPending);
    }

    /// @inheritdoc IBonusAccumulator
    function pendingForToken(uint256 tokenId) external view override returns (uint256) {
        uint256 weight = positionWeight[tokenId];
        if (weight == 0) return 0;
        return _pendingTotal(tokenId, weight);
    }

    /// @notice Pending accrual on a specific stream for a given tokenId.
    function pendingForStream(uint256 tokenId, uint8 stream) external view returns (uint256) {
        if (stream >= STREAM_COUNT) revert InvalidStream();
        uint256 weight = positionWeight[tokenId];
        if (weight == 0) return 0;
        return _pendingStream(tokenId, stream, weight);
    }

    // ═══════════════════════════════════════════════════════════
    //  Revenue-source entrypoints
    // ═══════════════════════════════════════════════════════════

    /// @notice Pull `amount` USDC from the caller and distribute it across
    ///         active positions on the given stream. Caller must approve first.
    /// @dev Only callable by contracts with NOTIFIER_ROLE (BridgeFeeDAO,
    ///      reward emitters, etc.). If totalWeight == 0 the funds are held
    ///      for the next notifier call — no ghost shares.
    function notifyBonus(uint8 stream, uint256 amount)
        external
        onlyRole(NOTIFIER_ROLE)
        nonReentrant
    {
        if (stream >= STREAM_COUNT) revert InvalidStream();
        if (amount == 0) revert ZeroAmount();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        if (totalWeight > 0) {
            accPerWeight[stream] += (amount * ACC_PRECISION) / totalWeight;
        }
        // If totalWeight == 0, the USDC just sits here. Next registration
        // starts earning from the bumped accumulator (no retro-dilution).

        totalRouted[stream] += amount;
        emit BonusNotified(stream, msg.sender, amount, accPerWeight[stream]);
    }

    /// @notice Claim all pending bonuses for a given position. Callable by
    ///         the NFT's current owner via the vault's integration OR by
    ///         anyone forwarding to the registered owner.
    function claim(uint256 tokenId) external nonReentrant {
        uint256 weight = positionWeight[tokenId];
        if (weight == 0) revert NotRegistered();

        address owner = positionOwner[tokenId];
        require(msg.sender == owner, "BonusAccumulator: not owner");

        uint256 total;
        for (uint8 i; i < STREAM_COUNT; i++) {
            uint256 pending = _pendingStream(tokenId, i, weight);
            if (pending > 0) {
                cached[tokenId][i] = 0;
                debt[tokenId][i] = accPerWeight[i];
                total += pending;
            }
        }

        if (total > 0) {
            USDC.safeTransfer(owner, total);
        }
        emit BonusClaimed(tokenId, owner, total);
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

    function addNotifier(address notifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(NOTIFIER_ROLE, notifier);
    }

    function removeNotifier(address notifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(NOTIFIER_ROLE, notifier);
    }

    /// @notice Admin escape hatch: push bonus funds from treasury directly
    ///         without NOTIFIER_ROLE (e.g. seeding an initial distribution).
    function adminNotifyBonus(uint8 stream, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (stream >= STREAM_COUNT) revert InvalidStream();
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        if (totalWeight > 0) {
            accPerWeight[stream] += (amount * ACC_PRECISION) / totalWeight;
        }
        totalRouted[stream] += amount;
        emit BonusNotified(stream, msg.sender, amount, accPerWeight[stream]);
    }

    /// @notice Rescue a non-USDC token. USDC is protocol-owned and can only
    ///         leave via the normal claim / deregister path.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(USDC), "protected");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _pendingTotal(uint256 tokenId, uint256 weight)
        internal
        view
        returns (uint256 total)
    {
        for (uint8 i; i < STREAM_COUNT; i++) {
            total += _pendingStream(tokenId, i, weight);
        }
    }

    function _pendingStream(uint256 tokenId, uint8 stream, uint256 weight)
        internal
        view
        returns (uint256)
    {
        uint256 delta = accPerWeight[stream] - debt[tokenId][stream];
        return cached[tokenId][stream] + (weight * delta) / ACC_PRECISION;
    }
}
