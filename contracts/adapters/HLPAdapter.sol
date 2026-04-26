// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @title HLPAdapter
/// @notice ShadowVaultV15 yield adapter for Hyperliquid's HLP protocol vault.
///
///         HLP lives on HyperCore (Hyperliquid L1) and is NOT callable from
///         Arbitrum smart contracts. The bridge to HyperCore credits the USDC
///         `msg.sender` on the L1 side, so a contract cannot sign the required
///         HyperCore EIP-712 actions. An off-chain keeper EOA custodies USDC
///         for the brief bridge window and performs the HyperCore vault
///         transfer signing.
///
///         Flow (deposit):
///           1. Vault calls `deposit(amount)` → adapter holds USDC as `idle`.
///           2. Keeper calls `pullForBridge(amount)` → USDC moves to keeper EOA,
///              `inFlightToHC += amount`. Caps enforced (per-tx + daily).
///           3. Keeper transfers USDC to Hyperliquid Bridge2 on Arbitrum.
///           4. ~1 minute later, USDC lands on HyperCore at keeper's L1 address.
///           5. Keeper signs `vaultTransfer(HLP, true, amount)` on HyperCore.
///           6. Keeper calls `confirmHCDeposit(amount)` → `inFlightToHC -= amount`.
///           7. Keeper calls `pushNAV(equity)` periodically with the live
///              HyperCore vault equity (read from precompile 0x802).
///
///         Flow (withdraw):
///           1. Keeper calls `initiateHCWithdraw(amount)` — pre-accounting.
///           2. Keeper signs `vaultTransfer(HLP, false, amount)` — HLP 4-day
///              lockup clock must have elapsed from last deposit.
///           3. Keeper signs L1 withdraw → USDC lands on Arbitrum at the
///              keeper's mirror address in ~3-4 min. Validators deduct $1.
///           4. Keeper transfers USDC back to adapter and calls
///              `confirmHCWithdraw(amount)`.
///
///         Accounting:
///           totalAssets() = idle + inFlightToHC + reportedHCEquity + inFlightFromHC
///           reportedHCEquity is keeper-pushed via `pushNAV`. A staleness
///           window and per-update max-drift cap guard against rogue updates.
///
///         Safety:
///           - Per-tx bridge-out cap (`maxPerBridgeOut`).
///           - Rolling 24h cumulative cap (`maxDailyBridgeOut`).
///           - Min bridge transfer 5 USDC enforced on-chain — Bridge2 forfeits
///             any deposit below this threshold.
///           - NAV updates rate-limited: max `maxNavDriftBps` delta per update.
///           - `syncAccounting` admin escape hatch for true state divergence.
///
/// @dev IYieldAdapter calls (deposit/withdraw/harvest) are synchronous from
///      the vault's perspective; async settlement happens in the keeper funcs.
contract HLPAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ───────── Immutables ─────────
    IERC20  public immutable USDC;
    /// @notice Keeper EOA that custodies USDC during bridge transit. Must
    ///         equal the signer of HyperCore EIP-712 actions.
    address public immutable HC_KEEPER;
    /// @notice Hyperliquid Bridge2 on Arbitrum (info only — adapter never
    ///         calls this; the keeper EOA does).
    address public constant HL_BRIDGE2 = 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7;

    // ───────── Constants ─────────
    uint256 public constant BPS = 10_000;
    /// @notice Bridge2 minimum deposit. Anything below is permanently
    ///         forfeited by Hyperliquid validators.
    uint256 public constant MIN_BRIDGE = 5_000_000; // 5 USDC (6-decimal)
    /// @notice Hard ceiling on any single NAV update's delta (±%).
    uint256 public constant MAX_NAV_DRIFT_BPS_CAP = 2000; // 20%

    // ───────── Config (admin-mutable) ─────────
    uint256 public maxPerBridgeOut    = 10_000_000_000;  // 10k USDC
    uint256 public maxDailyBridgeOut  = 50_000_000_000;  // 50k USDC
    uint256 public navStalenessSecs   = 3600;            // 1h
    uint256 public maxNavDriftBps     = 500;             // 5% per update
    uint256 public hlpLockupSecs      = 4 days;

    // ───────── State — accounting ─────────
    uint256 public totalPrincipal;
    /// @notice USDC pulled out by keeper, not yet confirmed on HyperCore.
    uint256 public inFlightToHC;
    /// @notice USDC queued for return from HyperCore (HLP withdraw in-flight).
    uint256 public inFlightFromHC;
    /// @notice Keeper-pushed HyperCore vault equity, in 6-decimal USDC.
    uint256 public reportedHCEquity;
    uint256 public lastNavUpdateAt;
    /// @notice Timestamp of the most recent HLP deposit (resets the lockup).
    uint256 public lastHCDepositAt;

    // ───────── State — rate limits ─────────
    uint256 public dailyBridgedOut;
    uint256 public dailyWindowStart;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);
    event PulledForBridge(address indexed keeper, uint256 amount, uint256 inFlight);
    event ConfirmedHCDeposit(uint256 amount, uint256 remainingInFlight, uint256 newLockupUntil);
    event InitiatedHCWithdraw(uint256 amount, uint256 inFlightFromHC);
    event ConfirmedHCWithdraw(uint256 amount, uint256 remainingInFlight);
    event NAVUpdated(uint256 oldEquity, uint256 newEquity, uint256 timestamp);
    event BridgeLimitsUpdated(uint256 perTx, uint256 daily);
    event NavGuardUpdated(uint256 stalenessSecs, uint256 maxDriftBps);
    event LockupUpdated(uint256 newSeconds);

    // ───────── Errors ─────────
    error ZeroAddress();
    error ZeroAmount();
    error BelowBridgeMinimum(uint256 amount, uint256 minimum);
    error PerTxLimit(uint256 amount, uint256 limit);
    error DailyLimit(uint256 used, uint256 amount, uint256 limit);
    error NothingInFlight();
    error ExceedsInFlight(uint256 amount, uint256 inFlight);
    error NavDriftTooLarge(uint256 oldEq, uint256 newEq, uint256 maxBps);
    error NavGuardOutOfRange();
    error ProtectedToken();
    error BadReturn(uint256 expected, uint256 actual);

    // ───────── Constructor ─────────
    /// @param admin DEFAULT_ADMIN_ROLE holder (Gnosis Safe in production).
    /// @param hcKeeper Keeper EOA — same address on Arbitrum and HyperCore.
    constructor(address admin, address hcKeeper) {
        if (admin == address(0) || hcKeeper == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, hcKeeper);
        USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
        HC_KEEPER = hcKeeper;
        dailyWindowStart = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter — synchronous surface used by ShadowVaultV15
    // ═══════════════════════════════════════════════════════════

    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @notice Full USDC value managed by the adapter.
    /// @dev    Conservative: sums idle, in-flight legs, and keeper-reported
    ///         HyperCore equity. If the NAV snapshot is stale, the stale
    ///         value is still returned — consumers should read
    ///         `lastNavUpdateAt` and decide whether to act.
    function totalAssets() external view override returns (uint256) {
        uint256 idle = USDC.balanceOf(address(this));
        return idle + inFlightToHC + reportedHCEquity + inFlightFromHC;
    }

    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    /// @dev Returns USDC from the idle float only. Under-delivery is
    ///      permitted (vault enforces the 95% recovery rule). If users need
    ///      more, the keeper must pull from HyperCore (subject to 4-day
    ///      lockup).
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 idle = USDC.balanceOf(address(this));
        delivered = amount > idle ? idle : amount;
        if (delivered > 0) USDC.safeTransfer(msg.sender, delivered);
        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @dev Harvest skims from the idle float only — never reaches into the
    ///      HyperCore leg. The keeper-reported `reportedHCEquity` growth is
    ///      realised lazily on withdrawal.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 total = this.totalAssets();
        if (total <= totalPrincipal) return 0;
        uint256 excess = total - totalPrincipal;
        uint256 idle = USDC.balanceOf(address(this));
        uint256 toHarvest = excess / 2;            // skim 50% of paper profit
        if (toHarvest > idle) toHarvest = idle;    // bounded by real cash
        if (toHarvest == 0) return 0;
        USDC.safeTransfer(msg.sender, toHarvest);
        profit = toHarvest;
        emit Harvested(msg.sender, profit);
    }

    function syncAccounting(uint256 newPrincipal)
        external
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════════════════════════════════════════════════════
    //  Keeper — bridge custody + HyperCore accounting
    // ═══════════════════════════════════════════════════════════

    /// @notice Keeper pulls USDC from the adapter to bridge to HyperCore.
    ///         Must be > 5 USDC (Bridge2 minimum; below is forfeited).
    ///         Subject to per-tx and rolling-daily caps.
    function pullForBridge(uint256 amount)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
    {
        if (amount < MIN_BRIDGE) revert BelowBridgeMinimum(amount, MIN_BRIDGE);
        if (amount > maxPerBridgeOut) revert PerTxLimit(amount, maxPerBridgeOut);

        // Rolling 24h window
        if (block.timestamp >= dailyWindowStart + 1 days) {
            dailyWindowStart = block.timestamp;
            dailyBridgedOut = 0;
        }
        if (dailyBridgedOut + amount > maxDailyBridgeOut) {
            revert DailyLimit(dailyBridgedOut, amount, maxDailyBridgeOut);
        }

        dailyBridgedOut += amount;
        inFlightToHC += amount;
        USDC.safeTransfer(HC_KEEPER, amount);
        emit PulledForBridge(HC_KEEPER, amount, inFlightToHC);
    }

    /// @notice Keeper confirms bridge completion + HyperCore deposit landed
    ///         in HLP. Resets the 4-day lockup clock.
    function confirmHCDeposit(uint256 amount)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > inFlightToHC) revert ExceedsInFlight(amount, inFlightToHC);
        inFlightToHC -= amount;
        lastHCDepositAt = block.timestamp;
        emit ConfirmedHCDeposit(amount, inFlightToHC, block.timestamp + hlpLockupSecs);
    }

    /// @notice Keeper signals an HLP withdraw has been initiated. Moves
    ///         `amount` from reported-equity to in-flight-from-HC.
    function initiateHCWithdraw(uint256 amount)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > reportedHCEquity) revert ExceedsInFlight(amount, reportedHCEquity);
        reportedHCEquity -= amount;
        inFlightFromHC += amount;
        emit InitiatedHCWithdraw(amount, inFlightFromHC);
    }

    /// @notice Keeper confirms USDC has bridged back to Arbitrum and been
    ///         transferred to the adapter. Clears in-flight-from-HC.
    ///         `expected` is the amount recorded in-flight; the keeper
    ///         must have transferred ≥ `expected - BRIDGE_FEE` USDC to the
    ///         adapter before this call.
    function confirmHCWithdraw(uint256 expected)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (expected == 0) revert ZeroAmount();
        if (expected > inFlightFromHC) revert ExceedsInFlight(expected, inFlightFromHC);
        inFlightFromHC -= expected;
        emit ConfirmedHCWithdraw(expected, inFlightFromHC);
    }

    /// @notice Keeper pushes the current HyperCore vault equity reading.
    ///         Rate-limited: each update may move equity by at most
    ///         `maxNavDriftBps` vs the previous snapshot.
    ///
    ///         Initial call (when `reportedHCEquity == 0`) bypasses the
    ///         drift check so the first bridge-in can be recognised.
    function pushNAV(uint256 newEquity)
        external
        onlyRole(KEEPER_ROLE)
    {
        uint256 old = reportedHCEquity;
        if (old > 0) {
            uint256 delta = newEquity > old ? newEquity - old : old - newEquity;
            uint256 maxDelta = (old * maxNavDriftBps) / BPS;
            if (delta > maxDelta) revert NavDriftTooLarge(old, newEquity, maxNavDriftBps);
        }
        reportedHCEquity = newEquity;
        lastNavUpdateAt = block.timestamp;
        emit NAVUpdated(old, newEquity, block.timestamp);
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

    function setBridgeLimits(uint256 perTx, uint256 daily)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (perTx == 0 || daily < perTx) revert NavGuardOutOfRange();
        maxPerBridgeOut = perTx;
        maxDailyBridgeOut = daily;
        emit BridgeLimitsUpdated(perTx, daily);
    }

    function setNavGuards(uint256 stalenessSecs, uint256 maxDriftBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (maxDriftBps > MAX_NAV_DRIFT_BPS_CAP || stalenessSecs == 0) {
            revert NavGuardOutOfRange();
        }
        navStalenessSecs = stalenessSecs;
        maxNavDriftBps = maxDriftBps;
        emit NavGuardUpdated(stalenessSecs, maxDriftBps);
    }

    function setLockup(uint256 newSecs)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        hlpLockupSecs = newSecs;
        emit LockupUpdated(newSecs);
    }

    /// @notice Admin rescue for non-core tokens (stuck airdrops, etc).
    ///         USDC is protected — use `syncAccounting` + normal flows.
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

    /// @notice Earliest timestamp at which an HLP withdraw can be initiated
    ///         without violating the lockup. Zero if no deposit yet.
    function lockupUnlockAt() external view returns (uint256) {
        if (lastHCDepositAt == 0) return 0;
        return lastHCDepositAt + hlpLockupSecs;
    }

    /// @notice True if the NAV snapshot has exceeded `navStalenessSecs`.
    function isNavStale() external view returns (bool) {
        if (lastNavUpdateAt == 0) return true;
        return block.timestamp > lastNavUpdateAt + navStalenessSecs;
    }
}
