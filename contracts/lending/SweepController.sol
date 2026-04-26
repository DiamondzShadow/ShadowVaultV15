// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AaveV3Sink} from "./AaveV3Sink.sol";
import {HyperRemoteMirror} from "./HyperRemoteMirror.sol";

/// @notice Minimal slice of LendingPool's interface for sweep wiring.
interface ILendingPool {
    function totalAssets() external view returns (uint256);
}

/// @title SweepController
/// @notice Orchestrates idle USDC across two yield sinks:
///           - AaveV3Sink (synchronous, instant in/out)
///           - HyperRemoteMirror (async, 4-day HLP lockup + bridge)
///         Plus a reserve buffer kept in the LendingPool itself (instantly
///         available to borrowers).
///
///         Default target weights (admin-tunable, must sum ≤ 10000):
///           reserve  : 2000 bps  (20%, kept in LendingPool, no yield)
///           aave     : 5000 bps  (50%, sync yield)
///           remote   : 3000 bps  (30%, slow but higher yield)
///
///         The keeper calls `rebalance()` periodically. The LendingPool can
///         call `pull(amount)` to drain from sinks in priority order
///         (Aave first as it's synchronous; remote requires a queued unwind).
contract SweepController is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 public constant POOL_ROLE     = keccak256("POOL_ROLE");

    IERC20    public immutable USDC;
    AaveV3Sink public immutable AAVE;
    HyperRemoteMirror public immutable REMOTE;
    address public lendingPool;

    uint16 public reserveBps = 2_000;
    uint16 public aaveBps    = 5_000;
    uint16 public remoteBps  = 3_000;
    uint16 public constant BPS = 10_000;
    /// @notice Don't move tiny amounts (gas + bridge mins). Below this, skip.
    uint256 public minMoveUSDC = 50_000_000; // 50 USDC

    event TargetsUpdated(uint16 reserveBps, uint16 aaveBps, uint16 remoteBps);
    event Rebalanced(uint256 totalAssets, uint256 reserveTarget, uint256 aaveTarget, uint256 remoteTarget,
                     int256 aaveDelta, int256 remoteDelta);
    event PulledForBorrow(uint256 amount, uint256 fromIdle, uint256 fromAave);
    event LendingPoolUpdated(address newPool);

    error ZeroAddress();
    error BadParam();
    error InsufficientLiquidity(uint256 wanted, uint256 have);

    constructor(
        address admin, address keeper, address _usdc,
        address _aave, address _remote
    ) {
        if (admin == address(0) || keeper == address(0)) revert ZeroAddress();
        if (_usdc == address(0) || _aave == address(0) || _remote == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        AAVE = AaveV3Sink(_aave);
        REMOTE = HyperRemoteMirror(payable(_remote));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    // ════════════════════════════════════════════════════════════
    //  Wire LendingPool (post-deploy)
    // ════════════════════════════════════════════════════════════

    function setLendingPool(address pool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        lendingPool = pool;
        _grantRole(POOL_ROLE, pool);
        emit LendingPoolUpdated(pool);
    }

    function setTargets(uint16 reserve, uint16 aave, uint16 remote) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(reserve) + aave + remote != BPS) revert BadParam();
        reserveBps = reserve;
        aaveBps    = aave;
        remoteBps  = remote;
        emit TargetsUpdated(reserve, aave, remote);
    }

    function setMinMove(uint256 newMin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minMoveUSDC = newMin;
    }

    // ════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════

    function totalAssets() public view returns (uint256) {
        return USDC.balanceOf(address(this)) + AAVE.totalAssets() + REMOTE.totalAssets();
    }

    /// @notice Idle USDC across the lending stack (LendingPool + this controller).
    function liquidUSDC() public view returns (uint256) {
        if (lendingPool == address(0)) return USDC.balanceOf(address(this));
        return USDC.balanceOf(lendingPool) + USDC.balanceOf(address(this));
    }

    // ════════════════════════════════════════════════════════════
    //  Rebalance — keeper only
    // ════════════════════════════════════════════════════════════

    function rebalance() external nonReentrant onlyRole(KEEPER_ROLE) {
        // Keeper transfers idle USDC from this controller into sinks per targets.
        // We do NOT pull from the LendingPool here — the pool transfers excess
        // USDC into this controller via a separate adapter call (`sweepFromPool`).
        // This keeps the rebalance leg pure: no cross-contract pulls.
        uint256 total = totalAssets();
        uint256 idle = USDC.balanceOf(address(this));
        uint256 inAave = AAVE.totalAssets();
        uint256 inRemote = REMOTE.totalAssets();

        uint256 aaveTarget = (total * aaveBps) / BPS;
        uint256 remoteTarget = (total * remoteBps) / BPS;
        // reserve = total - aaveTarget - remoteTarget (implied; held in LendingPool + this idle)

        int256 aaveDelta = int256(aaveTarget) - int256(inAave);
        int256 remoteDelta = int256(remoteTarget) - int256(inRemote);

        // Move into Aave if under target (and idle covers it).
        if (aaveDelta > 0) {
            uint256 want = uint256(aaveDelta);
            uint256 canSend = want > idle ? idle : want;
            if (canSend >= minMoveUSDC) {
                USDC.forceApprove(address(AAVE), canSend);
                AAVE.deposit(canSend);
                idle -= canSend;
            }
        } else if (aaveDelta < 0) {
            uint256 want = uint256(-aaveDelta);
            if (want >= minMoveUSDC) {
                AAVE.withdraw(want); // Aave sends USDC straight to this controller (msg.sender).
                idle = USDC.balanceOf(address(this));
            }
        }

        // Move into Remote (HyperEVM) if under target.
        if (remoteDelta > 0) {
            uint256 want = uint256(remoteDelta);
            uint256 canSend = want > idle ? idle : want;
            if (canSend >= minMoveUSDC) {
                USDC.forceApprove(address(REMOTE), canSend);
                REMOTE.deposit(canSend);
                idle -= canSend;
            }
        } else if (remoteDelta < 0) {
            uint256 want = uint256(-remoteDelta);
            if (want >= minMoveUSDC) {
                REMOTE.requestWithdraw(want);
                // No instant return — keeper does the cross-chain unwind.
            }
        }

        emit Rebalanced(total, total - aaveTarget - remoteTarget, aaveTarget, remoteTarget, aaveDelta, remoteDelta);
    }

    // ════════════════════════════════════════════════════════════
    //  LendingPool drain hook
    // ════════════════════════════════════════════════════════════

    /// @notice LendingPool pulls `amount` USDC. Drains in priority order:
    ///         (1) controller idle, (2) Aave (sync), (3) request remote unwind
    ///         (delivered later via `HyperRemoteMirror.confirmReturn`).
    function pull(uint256 amount) external nonReentrant onlyRole(POOL_ROLE) returns (uint256 deliveredNow) {
        uint256 idle = USDC.balanceOf(address(this));
        deliveredNow = idle > amount ? amount : idle;
        if (deliveredNow > 0) USDC.safeTransfer(msg.sender, deliveredNow);

        uint256 stillNeed = amount - deliveredNow;
        if (stillNeed == 0) return deliveredNow;

        // Pull from Aave next.
        uint256 inAave = AAVE.totalAssets();
        if (inAave > 0) {
            uint256 want = stillNeed > inAave ? inAave : stillNeed;
            uint256 received = AAVE.withdraw(want);
            // AAVE.withdraw transfers to msg.sender = this controller.
            USDC.safeTransfer(msg.sender, received);
            deliveredNow += received;
            stillNeed = stillNeed > received ? stillNeed - received : 0;
        }
        if (stillNeed == 0) return deliveredNow;

        // Queue remote unwind for the rest. LendingPool gets nothing more this tx.
        if (stillNeed >= minMoveUSDC) {
            uint256 inRemote = REMOTE.totalAssets();
            uint256 want = stillNeed > inRemote ? inRemote : stillNeed;
            if (want > 0) REMOTE.requestWithdraw(want);
            // Caller absorbs the gap; pool's own InsufficientLiquidity check
            // will guard borrower-facing operations.
            emit PulledForBorrow(amount, idle, deliveredNow - idle);
            return deliveredNow;
        }

        emit PulledForBorrow(amount, idle, deliveredNow - idle);
    }
}
