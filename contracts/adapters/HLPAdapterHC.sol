// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

import {CoreWriterLib} from "../../lib/hyper-evm-lib/src/CoreWriterLib.sol";
import {PrecompileLib} from "../../lib/hyper-evm-lib/src/PrecompileLib.sol";
import {HLConstants} from "../../lib/hyper-evm-lib/src/common/HLConstants.sol";

/// @title HLPAdapterHC
/// @notice ShadowVaultV15 yield adapter for Hyperliquid HLP — HyperEVM native.
///
///         Uses CoreWriter (0x3333...) + precompiles directly. No off-chain
///         custody, no EOA bridge: the adapter itself signs HyperCore actions
///         through CoreWriter and reads live vault equity from precompile
///         0x802. Only the keeper role "nudges" the state machine (confirm
///         deposits, initiate withdraws, sweep funds back) — it never takes
///         custody of user USDC.
///
///         Flow (deposit):
///           1. Vault calls `deposit(amount)`.
///           2. Adapter pulls USDC, bridges EVM→HyperCore spot via the
///              CoreDepositWallet, then emits `vaultTransfer(HLP, true, amt)`
///              through CoreWriter. `inFlightToHC += amount` until settled.
///           3. Keeper observes precompile reflecting the deposit and calls
///              `confirmDeposit(amount)`.
///
///         Flow (withdraw):
///           1. Keeper calls `initiateHCWithdraw(usd6)` — CoreWriterLib checks
///              HLP lockup via `userVaultEquity.lockedUntilTimestamp`.
///           2. Keeper calls `sweepFromCore(usd6)` — HC spot → EVM via
///              `sendAsset` to the USDC system address.
///           3. Keeper calls `confirmReturn(amount)` once EVM balance reflects.
///           4. Vault's next `withdraw(amount)` delivers from idle.
///
///         Accounting:
///           totalAssets() = idle + inFlightToHC + precompile_equity + inFlightFromHC
///
///         Safety:
///           - Per-tx + rolling-24h caps on `deposit` (not just on bridge).
///           - USDC cannot be rescued.
///           - `syncAccounting` admin escape hatch for state drift.
///           - Deploy-time `verifyRoute()` admin helper does a 1-USDC
///             round-trip to prove the USDC↔HC path works before the vault
///             is wired in.
contract HLPAdapterHC is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE  = keccak256("VAULT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ───────── Immutables ─────────
    IERC20 public immutable USDC;
    /// @notice HyperCore HLP vault address. Default (mainnet) is
    ///         0xdfc24b077bc1425ad1dea75bcb6f8158e10df303.
    address public immutable HLP_VAULT;

    // ───────── Constants ─────────
    uint256 public constant BPS = 10_000;
    /// @notice Minimum single-deposit amount. HLP USD accounting uses uint64
    ///         6-dec, so we require at least 0.000001 USDC — but practically
    ///         limit deposits to a sensible floor.
    uint256 public constant MIN_DEPOSIT = 1_000_000; // 1 USDC

    // ───────── Config (admin-mutable) ─────────
    uint256 public maxPerDeposit   = 10_000_000_000;  // 10k USDC
    uint256 public maxDailyDeposit = 50_000_000_000;  // 50k USDC
    uint256 public hlpLockupSecs   = 4 days;          // informational; real lockup is enforced by CoreWriterLib via precompile

    // ───────── State — accounting ─────────
    uint256 public totalPrincipal;
    /// @notice USDC bridged to HC + queued for HLP deposit; not yet reflected in precompile equity.
    uint256 public inFlightToHC;
    /// @notice USDC queued for return from HC; not yet on EVM.
    uint256 public inFlightFromHC;
    /// @notice Timestamp of the most recent HLP deposit (informational only;
    ///         lockup is enforced on-chain by precompile.lockedUntilTimestamp).
    uint256 public lastHCDepositAt;

    // ───────── Rate limits ─────────
    uint256 public dailyDepositedOut;
    uint256 public dailyWindowStart;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 newPrincipal, uint256 inFlight);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);
    event DepositConfirmed(uint256 amount, uint256 inFlightToHC);
    event WithdrawInitiated(uint256 usd6, uint256 inFlightFromHC);
    event CoreSwept(uint256 usd6, uint256 inFlightFromHC);
    event ReturnConfirmed(uint256 amount, uint256 inFlightFromHC);
    event DepositLimitsUpdated(uint256 perTx, uint256 daily);
    event LockupUpdated(uint256 newSeconds);
    event RouteVerified(uint256 amount);

    // ───────── Errors ─────────
    error ZeroAddress();
    error ZeroAmount();
    error BelowMinDeposit(uint256 amount, uint256 minimum);
    error PerTxLimit(uint256 amount, uint256 limit);
    error DailyLimit(uint256 used, uint256 amount, uint256 limit);
    error ExceedsInFlight(uint256 amount, uint256 inFlight);
    error AmountTooLarge(uint256 amount);
    error ProtectedToken();
    error BadConfig();

    // ───────── Constructor ─────────
    /// @param admin DEFAULT_ADMIN_ROLE holder (Gnosis Safe in production).
    /// @param keeper KEEPER_ROLE holder (nudger EOA — no custody).
    /// @param _usdc USDC on HyperEVM (mainnet: 0xb88339…630f, testnet: 0x2B3370…D8Ab).
    /// @param _hlpVault HLP vault address on HyperCore.
    constructor(address admin, address keeper, address _usdc, address _hlpVault) {
        if (admin == address(0) || keeper == address(0)) revert ZeroAddress();
        if (_usdc == address(0) || _hlpVault == address(0)) revert ZeroAddress();
        // Sanity check: USDC must match the hyper-evm-lib chain constant, or
        // CoreWriterLib.bridgeToCore would approve the wrong token.
        if (_usdc != HLConstants.usdc()) revert BadConfig();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);

        USDC = IERC20(_usdc);
        HLP_VAULT = _hlpVault;
        dailyWindowStart = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter — synchronous surface used by ShadowVaultV15
    // ═══════════════════════════════════════════════════════════

    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @notice Full USDC value managed by the adapter.
    /// @dev Live read from precompile 0x802 + in-flight legs + idle float.
    function totalAssets() external view override returns (uint256) {
        uint64 equity = PrecompileLib.userVaultEquity(address(this), HLP_VAULT).equity;
        uint256 idle = USDC.balanceOf(address(this));
        return idle + inFlightToHC + uint256(equity) + inFlightFromHC;
    }

    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount < MIN_DEPOSIT) revert BelowMinDeposit(amount, MIN_DEPOSIT);
        if (amount > type(uint64).max) revert AmountTooLarge(amount);
        _enforceCaps(amount);

        USDC.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        inFlightToHC   += amount;
        lastHCDepositAt = block.timestamp;

        // EVM → HyperCore spot (uses CoreDepositWallet for USDC).
        CoreWriterLib.bridgeToCore(address(USDC), amount);
        // HyperCore spot → HLP vault (CoreWriter action, delayed a few seconds).
        CoreWriterLib.vaultTransfer(HLP_VAULT, true, uint64(amount));

        emit Deposited(msg.sender, amount, totalPrincipal, inFlightToHC);
    }

    /// @dev Returns USDC from the idle float only. Under-delivery is
    ///      permitted — vault enforces the 95% recovery rule. Users needing
    ///      more must wait for the keeper to unwind HLP (4-day lockup).
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

    /// @dev Harvest skims from the idle float only. HLP equity growth is
    ///      realised lazily when the keeper unwinds back to idle.
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
        uint256 toHarvest = excess / 2;         // skim 50% of paper profit
        if (toHarvest > idle) toHarvest = idle; // bounded by real cash
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
    //  Keeper — state-machine nudger (no custody)
    // ═══════════════════════════════════════════════════════════

    /// @notice Keeper acknowledges that `amount` USDC now shows up in the HLP
    ///         precompile and therefore is no longer in-flight.
    /// @dev Must be called AFTER the keeper verifies
    ///      `PrecompileLib.userVaultEquity(adapter, HLP).equity >= pre + amount`.
    function confirmDeposit(uint256 amount)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > inFlightToHC) revert ExceedsInFlight(amount, inFlightToHC);
        inFlightToHC -= amount;
        emit DepositConfirmed(amount, inFlightToHC);
    }

    /// @notice Keeper queues a HLP vault withdrawal. CoreWriterLib enforces
    ///         the 4-day lockup via `userVaultEquity.lockedUntilTimestamp`.
    function initiateHCWithdraw(uint64 usd6)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (usd6 == 0) revert ZeroAmount();
        inFlightFromHC += usd6;
        CoreWriterLib.vaultTransfer(HLP_VAULT, false, usd6);
        emit WithdrawInitiated(usd6, inFlightFromHC);
    }

    /// @notice Keeper bridges HC spot USDC back to the adapter on EVM.
    ///         Called after `initiateHCWithdraw` once HC spot balance shows
    ///         the funds (i.e. vaultTransfer delay has elapsed).
    /// @dev Requires the adapter to hold enough HYPE on HC to pay sendAsset
    ///      gas (see hyper-evm-lib bridgeToEvm note). Keeper or admin must
    ///      fund a small HYPE float on HC periodically.
    function sweepFromCore(uint64 usd6)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (usd6 == 0) revert ZeroAmount();
        CoreWriterLib.bridgeToEvm(address(USDC), uint256(usd6));
        emit CoreSwept(usd6, inFlightFromHC);
    }

    /// @notice Keeper clears in-flight-from-HC once USDC arrives on EVM.
    function confirmReturn(uint256 amount)
        external
        onlyRole(KEEPER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > inFlightFromHC) revert ExceedsInFlight(amount, inFlightFromHC);
        inFlightFromHC -= amount;
        emit ReturnConfirmed(amount, inFlightFromHC);
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

    function setDepositLimits(uint256 perTx, uint256 daily)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (perTx == 0 || daily < perTx) revert BadConfig();
        maxPerDeposit = perTx;
        maxDailyDeposit = daily;
        emit DepositLimitsUpdated(perTx, daily);
    }

    function setLockup(uint256 newSecs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        hlpLockupSecs = newSecs;
        emit LockupUpdated(newSecs);
    }

    /// @notice Admin-only deploy-time route test. Bridges `amount` USDC to HC
    ///         and straight back, proving the USDC↔HC wiring. Run ONCE before
    ///         the vault is granted VAULT_ROLE. Protects against wrong USDC
    ///         index or stale CoreDepositWallet.
    function verifyRoute(uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (amount < MIN_DEPOSIT) revert BelowMinDeposit(amount, MIN_DEPOSIT);
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        CoreWriterLib.bridgeToCore(address(USDC), amount);
        // Skip HLP deposit; immediately bridge back to prove the loop.
        CoreWriterLib.bridgeToEvm(address(USDC), amount);
        emit RouteVerified(amount);
    }

    /// @notice Admin rescue for non-core tokens. USDC is protected.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(USDC)) revert ProtectedToken();
        IERC20(token).safeTransfer(to, amount);
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

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    function idleUsdc() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    function reportedHCEquity() external view returns (uint64) {
        return PrecompileLib.userVaultEquity(address(this), HLP_VAULT).equity;
    }

    /// @notice Unix ms timestamp the adapter's HLP position becomes withdrawable.
    /// @dev Read live from precompile. Zero if no position.
    function lockupUnlockAtMs() external view returns (uint64) {
        return PrecompileLib.userVaultEquity(address(this), HLP_VAULT).lockedUntilTimestamp;
    }
}
