// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BasketAdapterHC
/// @notice Basket leg adapter for Pool F/G/H on HyperEVM. Holds USDC pending
///         conversion to HC spot basket (HYPE/BTC/ETH/XAUt0 etc) by the
///         off-chain keeper. Value reporting is driven by the `BasketNavOracle`
///         which the keeper updates after each trade.
///
/// @dev    MVP design: the adapter is a "dumb holder" for the USDC leg. It
///         does NOT trade on-chain. Flow:
///           1. Vault calls deposit(amount) — pulls USDC, totalPending += amount
///           2. Keeper calls sweepToTrader(amount, to) — USDC leaves to the
///              keeper-controlled EOA that bridges to HC + places basket trades
///           3. Keeper pushes NAV via BasketNavOracle.pushNav(basketId, usd6)
///           4. Vault totalAssets() reads from NavOracle — adapter stays silent
///         On withdrawal (reverse direction):
///           1. Vault calls withdraw(amount, to) — if idle >= amount, send
///              USDC directly; else emit BasketWithdrawPending so keeper sells
///              basket on HC + bridges USDC back
///           2. Keeper calls recordRecovery(amount) to mark how much
///              came back from HC (clears pending counter)
///
/// @dev    SECURITY: the trader EOA is admin-controlled. Compromise of the
///         trader key = compromise of the basket leg. Mitigations:
///           - `sweepToTrader` capped per-call + per-day (mirrors HLP adapter)
///           - Admin can pause sweeps instantly
///           - NavOracle has separate drift cap as second line
contract BasketAdapterHC is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ROLE  = keccak256("VAULT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable USDC;
    uint64 public immutable basketId;   // which basket this adapter backs (NavOracle id)

    // ─ Accounting (USDC 6-dec) ─
    uint256 public totalPrincipal;      // cumulative USDC deposited (net of withdrawals)
    uint256 public inFlightOut;         // USDC currently with trader EOA / HC
    uint256 public pendingWithdraw;     // USDC awaiting keeper-triggered unwind

    // ─ Caps (mirror HLP adapter pattern) ─
    uint256 public maxPerDeposit = 500_000_000;        // $500 default
    uint256 public maxDailyDeposit = 2_000_000_000;    // $2,000 default
    uint256 public dailyWindowStart;
    uint256 public dailyDepositedOut;

    // ─ Sweep caps ─
    uint256 public maxSweep = 10_000_000_000;          // $10,000 per sweep default
    bool    public sweepsPaused;

    address public trader;              // EOA authorized to receive sweeps (on HyperEVM side)

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 totalPrincipal);
    event Withdrawn(address indexed vault, address indexed to, uint256 amount, uint256 idleAfter);
    event BasketWithdrawPending(address indexed vault, address indexed to, uint256 amount);
    event SweptToTrader(address indexed trader, uint256 amount, uint256 inFlightOut);
    event RecoveryRecorded(uint256 amount, uint256 inFlightOut);
    event TraderSet(address indexed trader);
    event DepositLimitsUpdated(uint256 perTx, uint256 daily);
    event SweepCapUpdated(uint256 maxSweep);
    event SweepsPaused(bool paused);

    // ───────── Errors ─────────
    error ZeroAmount();
    error BadConfig();
    error PerTxLimit(uint256 amount, uint256 cap);
    error DailyLimit(uint256 used, uint256 requested, uint256 cap);
    error SweepLimit(uint256 amount, uint256 cap);
    error SweepsArePaused();
    error NoTrader();
    error InsufficientInFlight(uint256 requested, uint256 available);
    error ProtectedToken();

    constructor(address admin, address keeper_, address usdc_, uint64 basketId_) {
        if (admin == address(0) || usdc_ == address(0)) revert BadConfig();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper_);
        _grantRole(PAUSER_ROLE, admin);
        USDC = IERC20(usdc_);
        basketId = basketId_;
    }

    // ═══════════════════════════════════════════════════════════
    //  Vault-facing
    // ═══════════════════════════════════════════════════════════

    /// @notice Pulls USDC from the vault and marks it as basket principal.
    ///         Keeper will later sweep and trade on HC.
    function deposit(uint256 amount) external onlyRole(VAULT_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _enforceCaps(amount);
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    /// @notice If idle USDC covers the ask, transfer immediately. Otherwise
    ///         flag a pending withdraw for the keeper to unwind on HC.
    function withdraw(uint256 amount, address to)
        external
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 sent)
    {
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        uint256 idle = USDC.balanceOf(address(this));
        if (idle >= amount) {
            USDC.safeTransfer(to, amount);
            totalPrincipal = totalPrincipal > amount ? totalPrincipal - amount : 0;
            emit Withdrawn(msg.sender, to, amount, idle - amount);
            return amount;
        }
        // Partial + pending
        if (idle > 0) {
            USDC.safeTransfer(to, idle);
            totalPrincipal = totalPrincipal > idle ? totalPrincipal - idle : 0;
            emit Withdrawn(msg.sender, to, idle, 0);
        }
        uint256 short = amount - idle;
        pendingWithdraw += short;
        emit BasketWithdrawPending(msg.sender, to, short);
        return idle;
    }

    // ═══════════════════════════════════════════════════════════
    //  Keeper-facing
    // ═══════════════════════════════════════════════════════════

    /// @notice Move USDC to the trader EOA so it can bridge to HC + trade.
    function sweepToTrader(uint256 amount) external onlyRole(KEEPER_ROLE) nonReentrant {
        if (sweepsPaused) revert SweepsArePaused();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxSweep) revert SweepLimit(amount, maxSweep);
        if (trader == address(0)) revert NoTrader();
        USDC.safeTransfer(trader, amount);
        inFlightOut += amount;
        emit SweptToTrader(trader, amount, inFlightOut);
    }

    /// @notice Record USDC that came back from HC trading (bridged in via
    ///         any path — usually direct USDC transfer to this contract before
    ///         the keeper calls this).
    function recordRecovery(uint256 amount) external onlyRole(KEEPER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > inFlightOut) revert InsufficientInFlight(amount, inFlightOut);
        inFlightOut -= amount;
        emit RecoveryRecorded(amount, inFlightOut);
    }

    /// @notice Keeper clears pendingWithdraw after the unwind+bridge is done
    ///         and the target vault pulled its USDC.
    function clearPendingWithdraw(uint256 amount) external onlyRole(KEEPER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingWithdraw) revert InsufficientInFlight(amount, pendingWithdraw);
        pendingWithdraw -= amount;
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function setTrader(address _trader) external onlyRole(DEFAULT_ADMIN_ROLE) {
        trader = _trader;
        emit TraderSet(_trader);
    }

    function setDepositLimits(uint256 perTx, uint256 daily) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (perTx == 0 || daily < perTx) revert BadConfig();
        maxPerDeposit = perTx;
        maxDailyDeposit = daily;
        emit DepositLimitsUpdated(perTx, daily);
    }

    function setSweepCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cap == 0) revert BadConfig();
        maxSweep = cap;
        emit SweepCapUpdated(cap);
    }

    function setSweepsPaused(bool p) external onlyRole(PAUSER_ROLE) {
        sweepsPaused = p;
        emit SweepsPaused(p);
    }

    function addVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault_);
    }

    function removeVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault_);
    }

    /// @notice Admin rescue for non-USDC tokens (USDC protected — only moves
    ///         via deposit / withdraw / sweepToTrader).
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(USDC)) revert ProtectedToken();
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    function idleUsdc() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @notice Mirror HLPAdapter's API so Pool F vault can call totalAssets
    ///         uniformly. Value = idle + inFlightOut (adapter side only).
    ///         NAV appreciation is tracked by BasketNavOracle and read directly
    ///         by the vault — this function is intentionally NAV-unaware so a
    ///         compromised keeper cannot lie about basket value through here.
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this)) + inFlightOut;
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _enforceCaps(uint256 amount) internal {
        if (amount > maxPerDeposit) revert PerTxLimit(amount, maxPerDeposit);
        if (block.timestamp >= dailyWindowStart + 1 days) {
            dailyWindowStart = block.timestamp;
            dailyDepositedOut = 0;
        }
        if (dailyDepositedOut + amount > maxDailyDeposit) {
            revert DailyLimit(dailyDepositedOut, amount, maxDailyDeposit);
        }
        dailyDepositedOut += amount;
    }
}
