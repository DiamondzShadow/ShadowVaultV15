// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IBonusAccumulator} from "./interfaces/IBonusAccumulator.sol";

/// @title BonusAccumulatorV2
/// @notice Fixes the V1 collision bug where three ShadowVaultV15 pools
///         shared one flat `positionWeight[tokenId]` mapping while each
///         vault had an independent `nextPosId` counter. Pool A's posId=2
///         would clash with Pool C's posId=2 and revert `AlreadyRegistered`.
///
/// @dev V2 namespaces ALL per-position state by `msg.sender` (the calling
///      vault). Same external `IBonusAccumulator` surface so the vault
///      contracts need no code changes — just a `setBonusAccumulator(v2)`.
///
///      Stream accumulators remain GLOBAL across vaults — a bridge fee
///      notification dilutes across the combined weight of all active
///      positions in every pool, which matches the original design intent.
contract BonusAccumulatorV2 is IBonusAccumulator, AccessControl, ReentrancyGuard {
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

    // ───────── State (all namespaced by vault address) ─────────
    /// @notice vault => tokenId => weight
    mapping(address => mapping(uint256 => uint256)) public positionWeight;
    /// @notice vault => tokenId => owner
    mapping(address => mapping(uint256 => address)) public positionOwner;
    /// @notice vault => summed weight of its active positions
    mapping(address => uint256) public vaultTotalWeight;
    /// @notice Sum of all active weights across every registered vault.
    uint256 public totalWeight;

    /// @notice Global per-stream accumulator (1e18-scaled USDC per weight unit).
    uint256[STREAM_COUNT] public accPerWeight;

    /// @notice vault => tokenId => per-stream debt baseline
    mapping(address => mapping(uint256 => uint256[STREAM_COUNT])) public debt;
    /// @notice vault => tokenId => cached partial pending
    mapping(address => mapping(uint256 => uint256[STREAM_COUNT])) public cached;

    /// @notice Total USDC ever routed through each stream (informational).
    uint256[STREAM_COUNT] public totalRouted;

    // ───────── Events ─────────
    event PositionRegistered(
        address indexed vault,
        uint256 indexed tokenId,
        address indexed owner,
        uint256 weight,
        uint256 newTotalWeight
    );
    event PositionDeregistered(
        address indexed vault,
        uint256 indexed tokenId,
        uint256 claimed
    );
    event BonusNotified(
        uint8 indexed stream,
        address indexed notifier,
        uint256 amount,
        uint256 newAccPerWeight
    );
    event BonusClaimed(
        address indexed vault,
        uint256 indexed tokenId,
        address indexed to,
        uint256 amount
    );

    // ───────── Errors ─────────
    error InvalidStream();
    error ZeroAmount();
    error NoWeight();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error NotOwner();

    // ───────── Constructor ─────────
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════
    //  Vault interface — msg.sender IS the vault key
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IBonusAccumulator
    function registerPosition(uint256 tokenId, address owner, uint256 weight)
        external
        override
        onlyRole(VAULT_ROLE)
    {
        if (owner == address(0)) revert ZeroAddress();
        if (weight == 0) revert NoWeight();
        if (positionWeight[msg.sender][tokenId] != 0) revert AlreadyRegistered();

        positionWeight[msg.sender][tokenId] = weight;
        positionOwner[msg.sender][tokenId] = owner;
        vaultTotalWeight[msg.sender] += weight;
        totalWeight += weight;

        // Debt baseline = current accumulator → new position earns only
        // from future notifications.
        for (uint8 i; i < STREAM_COUNT; i++) {
            debt[msg.sender][tokenId][i] = accPerWeight[i];
        }

        emit PositionRegistered(msg.sender, tokenId, owner, weight, totalWeight);
    }

    /// @inheritdoc IBonusAccumulator
    function deregisterPosition(uint256 tokenId)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        uint256 weight = positionWeight[msg.sender][tokenId];
        if (weight == 0) revert NotRegistered();

        address owner = positionOwner[msg.sender][tokenId];
        uint256 totalPending = _pendingTotal(msg.sender, tokenId, weight);

        positionWeight[msg.sender][tokenId] = 0;
        positionOwner[msg.sender][tokenId] = address(0);
        for (uint8 i; i < STREAM_COUNT; i++) {
            debt[msg.sender][tokenId][i] = 0;
            cached[msg.sender][tokenId][i] = 0;
        }
        vaultTotalWeight[msg.sender] -= weight;
        totalWeight -= weight;

        if (totalPending > 0) {
            USDC.safeTransfer(owner, totalPending);
        }

        emit PositionDeregistered(msg.sender, tokenId, totalPending);
    }

    /// @inheritdoc IBonusAccumulator
    /// @dev V2 REQUIRES the vault address to identify a position. Kept
    ///      on the interface for ABI compat but always returns 0 — callers
    ///      should use `pendingForPosition(vault, tokenId)`.
    function pendingForToken(uint256) external pure override returns (uint256) {
        return 0;
    }

    /// @notice Canonical view — accrued pending bonus for a specific
    ///         position across all streams (USDC, 6-dec).
    function pendingForPosition(address vault, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        uint256 weight = positionWeight[vault][tokenId];
        if (weight == 0) return 0;
        return _pendingTotal(vault, tokenId, weight);
    }

    /// @notice Pending accrual on a specific stream for a given position.
    function pendingForStream(address vault, uint256 tokenId, uint8 stream)
        external
        view
        returns (uint256)
    {
        if (stream >= STREAM_COUNT) revert InvalidStream();
        uint256 weight = positionWeight[vault][tokenId];
        if (weight == 0) return 0;
        return _pendingStream(vault, tokenId, stream, weight);
    }

    // ═══════════════════════════════════════════════════════════
    //  Revenue-source entrypoints
    // ═══════════════════════════════════════════════════════════

    /// @notice Pull `amount` USDC from caller and dilute it across every
    ///         active position in every registered vault. Caller must
    ///         hold NOTIFIER_ROLE (bridge fee DAO, SDM reward emitter, etc).
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
        totalRouted[stream] += amount;
        emit BonusNotified(stream, msg.sender, amount, accPerWeight[stream]);
    }

    /// @notice Claim all pending bonuses for a specific (vault, tokenId).
    ///         Callable only by the current registered owner.
    function claim(address vault, uint256 tokenId) external nonReentrant {
        uint256 weight = positionWeight[vault][tokenId];
        if (weight == 0) revert NotRegistered();

        address owner = positionOwner[vault][tokenId];
        if (msg.sender != owner) revert NotOwner();

        uint256 total;
        for (uint8 i; i < STREAM_COUNT; i++) {
            uint256 pending = _pendingStream(vault, tokenId, i, weight);
            if (pending > 0) {
                cached[vault][tokenId][i] = 0;
                debt[vault][tokenId][i] = accPerWeight[i];
                total += pending;
            }
        }

        if (total > 0) {
            USDC.safeTransfer(owner, total);
        }
        emit BonusClaimed(vault, tokenId, owner, total);
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

    /// @notice Admin escape hatch — seed a stream without NOTIFIER_ROLE.
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

    /// @notice Rescue a non-USDC token. USDC is protocol-owned and can
    ///         only leave via claim / deregister.
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

    function _pendingTotal(address vault, uint256 tokenId, uint256 weight)
        internal
        view
        returns (uint256 total)
    {
        for (uint8 i; i < STREAM_COUNT; i++) {
            total += _pendingStream(vault, tokenId, i, weight);
        }
    }

    function _pendingStream(
        address vault,
        uint256 tokenId,
        uint8 stream,
        uint256 weight
    ) internal view returns (uint256) {
        uint256 delta = accPerWeight[stream] - debt[vault][tokenId][stream];
        return cached[vault][tokenId][stream] + (weight * delta) / ACC_PRECISION;
    }
}
