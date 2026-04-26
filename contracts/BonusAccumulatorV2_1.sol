// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IBonusAccumulator} from "./interfaces/IBonusAccumulator.sol";

/// @title BonusAccumulatorV2_1
/// @notice Identical to BonusAccumulatorV2 except `deregisterPosition` is
///         idempotent — if the position is not registered in the caller's
///         namespace, it emits and returns silently instead of reverting.
///
/// @dev Motivation: when migrating from an earlier accumulator (e.g. the
///      v1 flat-keyed BonusAccumulator), positions that were registered
///      on the previous version are invisible to the new one. The vault
///      still unconditionally calls `deregisterPosition` from its withdraw
///      path, so a revert in the accumulator would brick the withdraw
///      path for every migrated position. Forgiving semantics close that
///      gap permanently at the cost of one cheap no-op emit.
///
///      The "if already missing, treat as deregistered" behavior is also
///      a better general-purpose contract — downstream integrations can
///      safely call deregister without first checking existence.
contract BonusAccumulatorV2_1 is IBonusAccumulator, AccessControl, ReentrancyGuard {
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
    mapping(address => mapping(uint256 => uint256)) public positionWeight;
    mapping(address => mapping(uint256 => address)) public positionOwner;
    mapping(address => uint256) public vaultTotalWeight;
    uint256 public totalWeight;

    uint256[STREAM_COUNT] public accPerWeight;

    mapping(address => mapping(uint256 => uint256[STREAM_COUNT])) public debt;
    mapping(address => mapping(uint256 => uint256[STREAM_COUNT])) public cached;

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
    event PositionDeregisterNoop(
        address indexed vault,
        uint256 indexed tokenId
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

        for (uint8 i; i < STREAM_COUNT; i++) {
            debt[msg.sender][tokenId][i] = accPerWeight[i];
        }

        emit PositionRegistered(msg.sender, tokenId, owner, weight, totalWeight);
    }

    /// @inheritdoc IBonusAccumulator
    /// @dev V2.1: forgiving — if `tokenId` is not registered in this
    ///      vault's namespace, emit a no-op event and return instead of
    ///      reverting. Lets vaults safely deregister positions that were
    ///      created against a prior accumulator version.
    function deregisterPosition(uint256 tokenId)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        uint256 weight = positionWeight[msg.sender][tokenId];
        if (weight == 0) {
            emit PositionDeregisterNoop(msg.sender, tokenId);
            return;
        }

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
    /// @dev Kept for IBonusAccumulator ABI compat — returns 0.
    ///      Use `pendingForPosition(vault, tokenId)` instead.
    function pendingForToken(uint256) external pure override returns (uint256) {
        return 0;
    }

    function pendingForPosition(address vault, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        uint256 weight = positionWeight[vault][tokenId];
        if (weight == 0) return 0;
        return _pendingTotal(vault, tokenId, weight);
    }

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
