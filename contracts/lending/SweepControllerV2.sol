// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HyperRemoteMirror} from "./HyperRemoteMirror.sol";

/// @notice Unified interface for synchronous USDC yield sinks (Aave, Compound,
///         Morpho, Fluid — anything that takes USDC and returns USDC on the
///         same tx). Both `AaveV3Sink` and `CompoundV3Sink` match this shape.
interface ISyncYieldSink {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external returns (uint256 received);
    function totalAssets() external view returns (uint256);
}

/// @title SweepControllerV2
/// @notice Generic N-slot allocator across:
///           - reserve  → USDC kept idle in the LendingPool for fast liquidity
///           - 1..N synchronous sinks (Aave, Compound, …) — instant in/out
///           - 1 optional asynchronous remote (HyperRemoteMirror) — 4d unwind
///
///         Unlike v1 which hardcoded Aave + Remote, v2 lets admins add/remove
///         sync sinks at runtime. Target weights must sum to 10_000 bps.
///
///         Keeper-driven: `rebalance()` is permissionless-to-keepers and
///         autonomously moves USDC toward targets. Pool-driven: `pull(amount)`
///         drains sync sinks in registration order until satisfied (remote
///         is left untouched — remote unwinds are async by nature).
contract SweepControllerV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant POOL_ROLE   = keccak256("POOL_ROLE");

    IERC20 public immutable USDC;
    uint16 public constant BPS = 10_000;
    /// @notice Absolute upper bound on number of sync sinks — keeps rebalance
    ///         loop bounded for gas predictability.
    uint256 public constant MAX_SINKS = 8;

    struct SyncSink {
        address sink;       // ISyncYieldSink
        uint16  targetBps;  // allocation target (0 disables without removing)
        bool    active;
        string  label;      // "aave" | "compound" | "morpho" — for ops + events
    }

    SyncSink[] public sinks;
    uint16 public reserveBps = 2_000;   // 20% idle in pool by default

    /// @notice Optional async remote (HyperRemoteMirror on Arb; unset on Polygon).
    HyperRemoteMirror public remote;
    uint16 public remoteBps;

    address public lendingPool;
    uint256 public minMoveUSDC = 50_000_000; // 50 USDC — ignore dust rebalances

    // ───────── Events
    event SinkAdded(uint256 indexed idx, address indexed sink, uint16 targetBps, string label);
    event SinkTargetUpdated(uint256 indexed idx, uint16 oldBps, uint16 newBps);
    event SinkDeactivated(uint256 indexed idx);
    event RemoteUpdated(address remote, uint16 remoteBps);
    event ReserveBpsUpdated(uint16 newBps);
    event LendingPoolUpdated(address newPool);
    event MinMoveUpdated(uint256 newMin);
    event Rebalanced(uint256 totalAssets, uint256 idleBefore, uint256 idleAfter);
    event SinkMoved(uint256 indexed idx, int256 deltaUSDC, uint256 sinkAssetsAfter);
    event PulledForPool(uint256 amount, uint256 fromIdle, uint256 fromSinks);

    // ───────── Errors
    error ZeroAddress();
    error TooManySinks();
    error InvalidIndex();
    error BpsOverflow(uint256 total);
    error InsufficientLiquidity(uint256 wanted, uint256 have);
    error BadParam();

    constructor(address admin, address keeper, address _usdc) {
        if (admin == address(0) || keeper == address(0) || _usdc == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin: wire pool + sinks
    // ════════════════════════════════════════════════════════════

    function setLendingPool(address pool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        lendingPool = pool;
        _grantRole(POOL_ROLE, pool);
        emit LendingPoolUpdated(pool);
    }

    function setRemote(address _remote, uint16 _remoteBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // _remote == 0 disables remote leg (Polygon case). _remoteBps must be 0 in that case.
        if (_remote == address(0) && _remoteBps != 0) revert BadParam();
        remote = HyperRemoteMirror(payable(_remote));
        remoteBps = _remoteBps;
        _requireBpsSumExact();
        emit RemoteUpdated(_remote, _remoteBps);
    }

    function setReserveBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        reserveBps = newBps;
        _requireBpsSumExact();
        emit ReserveBpsUpdated(newBps);
    }

    function setMinMove(uint256 newMin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minMoveUSDC = newMin;
        emit MinMoveUpdated(newMin);
    }

    function addSink(address sink, uint16 targetBps, string calldata label) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (sink == address(0)) revert ZeroAddress();
        if (sinks.length >= MAX_SINKS) revert TooManySinks();
        sinks.push(SyncSink({ sink: sink, targetBps: targetBps, active: true, label: label }));
        _requireBpsSumExact();
        emit SinkAdded(sinks.length - 1, sink, targetBps, label);
    }

    function setSinkTarget(uint256 idx, uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (idx >= sinks.length) revert InvalidIndex();
        uint16 old = sinks[idx].targetBps;
        sinks[idx].targetBps = newBps;
        _requireBpsSumExact();
        emit SinkTargetUpdated(idx, old, newBps);
    }

    /// @notice Deactivate a sink without removing it (preserves history).
    ///         Its targetBps is zeroed; funds currently in it will be pulled
    ///         back to idle on the next `rebalance()`.
    function deactivateSink(uint256 idx) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (idx >= sinks.length) revert InvalidIndex();
        sinks[idx].active = false;
        sinks[idx].targetBps = 0;
        _requireBpsSumExact();
        emit SinkDeactivated(idx);
    }

    /// @dev Ensures allocations can't exceed 100%. Under-allocation is fine —
    ///      residual USDC stays in the controller as extra reserve. This lets
    ///      admin configure incrementally (add sink 1, then sink 2, etc.)
    ///      without needing a single atomic "set all targets" call.
    function _requireBpsSumExact() internal view {
        uint256 total = reserveBps + remoteBps;
        for (uint256 i = 0; i < sinks.length; i++) {
            if (sinks[i].active) total += sinks[i].targetBps;
        }
        if (total > BPS) revert BpsOverflow(total);
    }

    // ════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════

    function sinkCount() external view returns (uint256) { return sinks.length; }

    function totalAssets() public view returns (uint256 total) {
        total = USDC.balanceOf(address(this));
        // Count inactive sinks too — their balances are still our assets,
        // they just haven't been drained to idle yet. Excluding them here
        // would make rebalance underestimate total when a sink was just
        // deactivated, causing it to under-fund the remaining active sinks.
        for (uint256 i = 0; i < sinks.length; i++) {
            total += ISyncYieldSink(sinks[i].sink).totalAssets();
        }
        if (address(remote) != address(0)) total += remote.totalAssets();
    }

    /// @notice Idle USDC across controller + pool (what the pool can satisfy
    ///         a borrow from right now without a sync pull).
    function liquidUSDC() external view returns (uint256) {
        uint256 v = USDC.balanceOf(address(this));
        if (lendingPool != address(0)) v += USDC.balanceOf(lendingPool);
        return v;
    }

    /// @notice Aggregate USDC that can be pulled synchronously (sinks + controller idle).
    function syncLiquidity() public view returns (uint256 total) {
        total = USDC.balanceOf(address(this));
        for (uint256 i = 0; i < sinks.length; i++) {
            if (sinks[i].active) total += ISyncYieldSink(sinks[i].sink).totalAssets();
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Rebalance — keeper
    // ════════════════════════════════════════════════════════════

    /// @notice Move USDC between idle + sinks toward target weights. Remote
    ///         leg is NOT rebalanced here (async — handled by a separate bridge
    ///         keeper that calls `remote.register(...)` / `confirmDeposit`).
    function rebalance() external nonReentrant onlyRole(KEEPER_ROLE) {
        uint256 total = totalAssets();
        if (total == 0) { emit Rebalanced(0, 0, 0); return; }

        uint256 idleBefore = USDC.balanceOf(address(this));

        // PASS 1: drain over-funded sinks back to idle.
        for (uint256 i = 0; i < sinks.length; i++) {
            if (!sinks[i].active) {
                // Inactive sinks → drain everything back.
                uint256 bal = ISyncYieldSink(sinks[i].sink).totalAssets();
                if (bal > 0) {
                    uint256 got = ISyncYieldSink(sinks[i].sink).withdraw(bal);
                    emit SinkMoved(i, -int256(got), ISyncYieldSink(sinks[i].sink).totalAssets());
                }
                continue;
            }
            uint256 target = (total * sinks[i].targetBps) / BPS;
            uint256 current = ISyncYieldSink(sinks[i].sink).totalAssets();
            if (current > target + minMoveUSDC) {
                uint256 pulled = ISyncYieldSink(sinks[i].sink).withdraw(current - target);
                emit SinkMoved(i, -int256(pulled), ISyncYieldSink(sinks[i].sink).totalAssets());
            }
        }

        // PASS 2: top up under-funded sinks from idle.
        for (uint256 i = 0; i < sinks.length; i++) {
            if (!sinks[i].active) continue;
            uint256 target = (total * sinks[i].targetBps) / BPS;
            uint256 current = ISyncYieldSink(sinks[i].sink).totalAssets();
            if (target > current + minMoveUSDC) {
                uint256 want = target - current;
                uint256 avail = USDC.balanceOf(address(this));
                uint256 move = want > avail ? avail : want;
                if (move > 0) {
                    USDC.forceApprove(sinks[i].sink, move);
                    ISyncYieldSink(sinks[i].sink).deposit(move);
                    emit SinkMoved(i, int256(move), ISyncYieldSink(sinks[i].sink).totalAssets());
                }
            }
        }

        emit Rebalanced(total, idleBefore, USDC.balanceOf(address(this)));
    }

    // ════════════════════════════════════════════════════════════
    //  Pool-driven pulls
    // ════════════════════════════════════════════════════════════

    /// @notice LendingPool calls this to pull `amount` USDC synchronously:
    ///         drains controller idle first, then sync sinks in registration
    ///         order. Returns USDC delivered to pool in the SAME tx.
    ///         Remote unwinds are NOT attempted here (async by nature).
    function pull(uint256 amount) external nonReentrant onlyRole(POOL_ROLE) returns (uint256 delivered) {
        if (amount == 0) revert BadParam();
        address pool = lendingPool;
        uint256 need = amount;
        uint256 fromIdle = 0;
        uint256 fromSinks = 0;

        // 1. Controller idle first.
        uint256 idle = USDC.balanceOf(address(this));
        if (idle > 0) {
            uint256 send = idle > need ? need : idle;
            USDC.safeTransfer(pool, send);
            fromIdle = send;
            need -= send;
        }

        // 2. Drain sync sinks in order.
        for (uint256 i = 0; i < sinks.length && need > 0; i++) {
            if (!sinks[i].active) continue;
            uint256 got = ISyncYieldSink(sinks[i].sink).withdraw(need);
            if (got > 0) {
                // withdraw sends to msg.sender (this controller); forward to pool.
                USDC.safeTransfer(pool, got);
                fromSinks += got;
                if (got >= need) { need = 0; break; }
                need -= got;
            }
        }

        delivered = fromIdle + fromSinks;
        emit PulledForPool(delivered, fromIdle, fromSinks);
    }

    /// @notice Admin escape hatch — rescue a non-USDC stray token.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(USDC)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
