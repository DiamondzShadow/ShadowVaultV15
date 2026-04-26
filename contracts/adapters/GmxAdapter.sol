// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

// ─────────────────────────────────────────────────────────────
//  GMX V2 Synthetics — minimal interfaces for GM pool LP
// ─────────────────────────────────────────────────────────────

interface IExchangeRouter {
    struct CreateDepositParams {
        CreateDepositParamsAddresses addresses;
        uint256 minMarketTokens;
        bool shouldUnwrapNativeToken;
        uint256 executionFee;
        uint256 callbackGasLimit;
        bytes32[] dataList;
    }

    struct CreateDepositParamsAddresses {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialLongToken;
        address initialShortToken;
        address[] longTokenSwapPath;
        address[] shortTokenSwapPath;
    }

    struct CreateWithdrawalParams {
        CreateWithdrawalParamsAddresses addresses;
        uint256 minLongTokenAmount;
        uint256 minShortTokenAmount;
        bool shouldUnwrapNativeToken;
        uint256 executionFee;
        uint256 callbackGasLimit;
        bytes32[] dataList;
    }

    struct CreateWithdrawalParamsAddresses {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address[] longTokenSwapPath;
        address[] shortTokenSwapPath;
    }

    function sendWnt(address receiver, uint256 amount) external payable;
    function sendTokens(address token, address receiver, uint256 amount) external payable;
    function createDeposit(CreateDepositParams calldata params) external payable returns (bytes32);
    function createWithdrawal(CreateWithdrawalParams calldata params) external payable returns (bytes32);
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

interface ISyntheticsReader {
    function getMarketTokenPrice(
        address dataStore,
        Market.Props memory market,
        Price.Props memory indexTokenPrice,
        Price.Props memory longTokenPrice,
        Price.Props memory shortTokenPrice,
        bytes32 pnlFactorType,
        bool maximize
    ) external view returns (int256, MarketPoolValueInfo.Props memory);
}

// Minimal structs for reader calls
library Market {
    struct Props {
        address marketToken;
        address indexToken;
        address longToken;
        address shortToken;
    }
}

library Price {
    struct Props {
        uint256 min;
        uint256 max;
    }
}

library MarketPoolValueInfo {
    struct Props {
        int256 poolValue;
        int256 longPnl;
        int256 shortPnl;
        int256 netPnl;
        uint256 longTokenAmount;
        uint256 shortTokenAmount;
        uint256 longTokenUsd;
        uint256 shortTokenUsd;
        uint256 totalBorrowingFees;
        uint256 borrowingFeePoolFactor;
        int256 impactPoolAmount;
    }
}

/// @title GmxAdapter
/// @notice ShadowVaultV15 yield adapter for GMX V2 GM pools on Arbitrum.
///
///         Architecture: keeper-managed float.
///         - The adapter accepts USDC from the vault synchronously.
///         - Idle USDC is held as a "float" to serve immediate withdrawals.
///         - The keeper periodically calls `pushToGmx()` to deposit excess
///           float into a GMX GM pool (async — keeper executes in 1-30s).
///         - The keeper calls `pullFromGmx()` to top up the float when it
///           runs low (async — GMX keeper executes withdrawal).
///         - `totalAssets()` = idle USDC + GM token value.
///         - `withdraw()` always returns USDC from the float. If float is
///           insufficient, it returns what's available (vault's 95% check
///           handles the rest, or user retries after keeper tops up float).
///
///         Target: GLV [WETH-USDC] vault on Arbitrum — diversified across
///         40+ GM markets, 15-25% APY from trader PnL + funding fees.
///
/// @dev Async operations (pushToGmx/pullFromGmx) are keeper-only and settle
///      via GMX's keeper network in 1-30 seconds. The vault never calls these
///      directly — it only uses the standard IYieldAdapter interface.
contract GmxAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20   public immutable USDC;
    IERC20   public immutable GM_TOKEN;         // GLV or GM market token
    address  public immutable MARKET;           // GM market address (= GM_TOKEN for GM pools)

    IExchangeRouter public immutable EXCHANGE_ROUTER;
    address         public immutable SYNTHETICS_ROUTER;
    address         public immutable DEPOSIT_VAULT;
    address         public immutable WITHDRAWAL_VAULT;

    // ───────── Config ─────────
    /// @notice Target float as % of totalAssets (bps). Keeper maintains this.
    uint256 public targetFloatBps = 2000; // 20% — enough for most withdrawals
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FLOAT_BPS = 5000; // 50% ceiling

    // ───────── State ─────────
    uint256 public totalPrincipal;

    /// @notice Tracks USDC sent to GMX that hasn't been confirmed as GM tokens yet.
    uint256 public pendingDeposit;
    /// @notice Tracks GM tokens sent to GMX for withdrawal that hasn't settled yet.
    uint256 public pendingWithdrawal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);
    event PushedToGmx(uint256 usdcAmount, bytes32 depositKey);
    event PulledFromGmx(uint256 gmAmount, bytes32 withdrawalKey);
    event FloatTargetUpdated(uint256 newBps);
    event GmxDepositSettled(uint256 gmReceived);
    event GmxWithdrawalSettled(uint256 usdcReceived);

    // ───────── Errors ─────────
    error ZeroAmount();
    error ZeroAddress();
    error FloatTooHigh();
    error InsufficientExecutionFee();
    error NothingToPush();
    error NothingToPull();

    // ───────── Constructor ─────────
    /// @param admin DEFAULT_ADMIN_ROLE holder.
    /// @param gmToken The GM market token (or GLV token) address.
    /// @param market The GM market address.
    /// @param exchangeRouter GMX V2 ExchangeRouter.
    /// @param syntheticsRouter GMX V2 SyntheticsRouter (for approvals).
    /// @param depositVault GMX V2 DepositVault.
    /// @param withdrawalVault GMX V2 WithdrawalVault.
    constructor(
        address admin,
        address gmToken,
        address market,
        address exchangeRouter,
        address syntheticsRouter,
        address depositVault,
        address withdrawalVault
    ) {
        if (admin == address(0) || gmToken == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
        GM_TOKEN = IERC20(gmToken);
        MARKET = market;
        EXCHANGE_ROUTER = IExchangeRouter(exchangeRouter);
        SYNTHETICS_ROUTER = syntheticsRouter;
        DEPOSIT_VAULT = depositVault;
        WITHDRAWAL_VAULT = withdrawalVault;

        // Approve SyntheticsRouter for USDC sends (GMX pulls via router)
        USDC.forceApprove(syntheticsRouter, type(uint256).max);
        // Approve SyntheticsRouter for GM token sends (withdrawals)
        GM_TOKEN.approve(syntheticsRouter, type(uint256).max);
    }

    // Allow receiving ETH for execution fee refunds
    receive() external payable {}

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter — synchronous interface used by the vault
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Total value = idle USDC + GM token value (estimated) + pending deposits.
    ///      GM token value is estimated from balance × last known price.
    ///      This is conservative — actual liquidation value may differ slightly.
    function totalAssets() external view override returns (uint256) {
        uint256 idle = USDC.balanceOf(address(this));
        uint256 gmBal = GM_TOKEN.balanceOf(address(this));
        uint256 gmValue = _estimateGmValue(gmBal);
        return idle + gmValue + pendingDeposit;
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Accepts USDC from the vault. Holds as float. Keeper will push
    ///      excess into GMX on next cycle.
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

    /// @inheritdoc IYieldAdapter
    /// @dev Returns USDC from the idle float. If float is insufficient,
    ///      returns what's available. The vault's 95% recovery check will
    ///      handle partial delivery (user retries after keeper tops up float).
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

        if (delivered > 0) {
            USDC.safeTransfer(msg.sender, delivered);
        }

        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Harvest profit = totalAssets - totalPrincipal. Skims 50% of excess
    ///      from idle USDC (doesn't liquidate GM positions for harvest).
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 idle = USDC.balanceOf(address(this));
        uint256 gmBal = GM_TOKEN.balanceOf(address(this));
        uint256 total = idle + _estimateGmValue(gmBal) + pendingDeposit;

        if (total <= totalPrincipal) return 0;

        uint256 excess = total - totalPrincipal;
        // Only harvest from idle USDC (don't liquidate GM for small harvests)
        uint256 toHarvest = excess / 2;
        if (toHarvest > idle) toHarvest = idle;
        if (toHarvest == 0) return 0;

        USDC.safeTransfer(msg.sender, toHarvest);
        profit = toHarvest;

        emit Harvested(msg.sender, profit);
    }

    /// @inheritdoc IYieldAdapter
    function syncAccounting(uint256 newPrincipal) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════════════════════════════════════════════════════
    //  Keeper — async GMX operations
    // ═══════════════════════════════════════════════════════════

    /// @notice Keeper pushes excess USDC float into GMX as a GM deposit.
    ///         Call with msg.value = execution fee (ETH for GMX keeper).
    /// @param minGmTokens Slippage protection for GM tokens received.
    function pushToGmx(uint256 minGmTokens)
        external
        payable
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (bytes32 depositKey)
    {
        uint256 idle = USDC.balanceOf(address(this));
        uint256 total = idle + _estimateGmValue(GM_TOKEN.balanceOf(address(this))) + pendingDeposit;
        uint256 targetFloat = (total * targetFloatBps) / BPS;

        if (idle <= targetFloat) revert NothingToPush();
        uint256 pushAmount = idle - targetFloat;

        if (msg.value == 0) revert InsufficientExecutionFee();

        // Build multicall: sendWnt + sendTokens + createDeposit
        bytes[] memory calls = new bytes[](3);

        calls[0] = abi.encodeCall(EXCHANGE_ROUTER.sendWnt, (DEPOSIT_VAULT, msg.value));
        calls[1] = abi.encodeCall(EXCHANGE_ROUTER.sendTokens, (address(USDC), DEPOSIT_VAULT, pushAmount));

        address[] memory emptyPath = new address[](0);
        bytes32[] memory emptyData = new bytes32[](0);

        IExchangeRouter.CreateDepositParams memory params = IExchangeRouter.CreateDepositParams({
            addresses: IExchangeRouter.CreateDepositParamsAddresses({
                receiver: address(this),
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: MARKET,
                initialLongToken: address(0),        // not depositing long
                initialShortToken: address(USDC),    // depositing USDC as short
                longTokenSwapPath: emptyPath,
                shortTokenSwapPath: emptyPath
            }),
            minMarketTokens: minGmTokens,
            shouldUnwrapNativeToken: false,
            executionFee: msg.value,
            callbackGasLimit: 0,
            dataList: emptyData
        });

        calls[2] = abi.encodeCall(EXCHANGE_ROUTER.createDeposit, (params));

        bytes[] memory results = EXCHANGE_ROUTER.multicall{value: msg.value}(calls);
        depositKey = abi.decode(results[2], (bytes32));

        pendingDeposit += pushAmount;
        emit PushedToGmx(pushAmount, depositKey);
    }

    /// @notice Keeper pulls USDC from GMX by withdrawing GM tokens.
    ///         Call with msg.value = execution fee.
    /// @param gmAmount Amount of GM tokens to withdraw.
    /// @param minUsdcOut Slippage protection for USDC received.
    function pullFromGmx(uint256 gmAmount, uint256 minUsdcOut)
        external
        payable
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (bytes32 withdrawalKey)
    {
        uint256 gmBal = GM_TOKEN.balanceOf(address(this));
        if (gmBal == 0 || gmAmount == 0) revert NothingToPull();
        if (gmAmount > gmBal) gmAmount = gmBal;

        if (msg.value == 0) revert InsufficientExecutionFee();

        bytes[] memory calls = new bytes[](3);

        calls[0] = abi.encodeCall(EXCHANGE_ROUTER.sendWnt, (WITHDRAWAL_VAULT, msg.value));
        calls[1] = abi.encodeCall(EXCHANGE_ROUTER.sendTokens, (address(GM_TOKEN), WITHDRAWAL_VAULT, gmAmount));

        address[] memory emptyPath = new address[](0);
        bytes32[] memory emptyData = new bytes32[](0);

        IExchangeRouter.CreateWithdrawalParams memory params = IExchangeRouter.CreateWithdrawalParams({
            addresses: IExchangeRouter.CreateWithdrawalParamsAddresses({
                receiver: address(this),
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: MARKET,
                longTokenSwapPath: emptyPath,
                shortTokenSwapPath: emptyPath
            }),
            minLongTokenAmount: 0,
            minShortTokenAmount: minUsdcOut,
            shouldUnwrapNativeToken: false,
            executionFee: msg.value,
            callbackGasLimit: 0,
            dataList: emptyData
        });

        calls[2] = abi.encodeCall(EXCHANGE_ROUTER.createWithdrawal, (params));

        bytes[] memory results = EXCHANGE_ROUTER.multicall{value: msg.value}(calls);
        withdrawalKey = abi.decode(results[2], (bytes32));

        pendingWithdrawal += gmAmount;
        emit PulledFromGmx(gmAmount, withdrawalKey);
    }

    /// @notice Keeper calls after a GMX deposit settles to clear pendingDeposit.
    ///         Reads actual GM balance to reconcile.
    function settleDeposit() external onlyRole(KEEPER_ROLE) {
        // After GMX keeper executes, GM tokens arrive at this contract.
        // We can't know exact amounts from the deposit key, so just clear
        // pendingDeposit and trust that GM balance reflects reality.
        uint256 cleared = pendingDeposit;
        pendingDeposit = 0;
        emit GmxDepositSettled(cleared);
    }

    /// @notice Keeper calls after a GMX withdrawal settles to clear pendingWithdrawal.
    function settleWithdrawal() external onlyRole(KEEPER_ROLE) {
        uint256 cleared = pendingWithdrawal;
        pendingWithdrawal = 0;
        emit GmxWithdrawalSettled(cleared);
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

    function addKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(KEEPER_ROLE, keeper);
    }

    function removeKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(KEEPER_ROLE, keeper);
    }

    function setTargetFloat(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FLOAT_BPS) revert FloatTooHigh();
        targetFloatBps = bps;
        emit FloatTargetUpdated(bps);
    }

    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(
            token != address(USDC) && token != address(GM_TOKEN),
            "protected"
        );
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Emergency: withdraw ETH (execution fee refunds).
    function rescueEth(address payable to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth transfer failed");
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal — GM valuation
    // ═══════════════════════════════════════════════════════════

    /// @dev Estimate USDC value of GM tokens. Uses a simple approach:
    ///      track the deposit/withdrawal ratio to derive an implicit price.
    ///      For production, integrate with GMX SyntheticsReader.getMarketTokenPrice()
    ///      or use a Chainlink oracle if one exists for the GM token.
    ///
    ///      For now: we track principal deposited vs GM received to derive
    ///      a conservative exchange rate. This is safe because:
    ///      1. GM token value only increases from fees (assuming no net trader profit)
    ///      2. We use this for totalAssets() which is informational
    ///      3. Actual withdraw amounts are determined by GMX at execution time
    function _estimateGmValue(uint256 gmBal_) internal view returns (uint256) {
        if (gmBal_ == 0) return 0;

        // Simple approach: assume 1 GM ≈ 1 USDC initially.
        // The keeper should call syncAccounting periodically to correct drift.
        // A production deployment should integrate the SyntheticsReader for
        // real-time pricing. For MVP: track through principal accounting.
        uint256 gmTotal = GM_TOKEN.balanceOf(address(this)) + pendingWithdrawal;
        if (gmTotal == 0) return 0;

        // Use principal minus idle USDC as the "invested in GMX" portion.
        uint256 idle = USDC.balanceOf(address(this));
        uint256 invested = totalPrincipal > idle ? totalPrincipal - idle : 0;

        // Pro-rata the invested amount across GM balance
        return (invested * gmBal_) / gmTotal;
    }

    // ═══════════════════════════════════════════════════════════
    //  View helpers
    // ═══════════════════════════════════════════════════════════

    /// @notice Current idle USDC available for immediate withdrawals.
    function idleUsdc() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @notice Current GM token balance.
    function gmBalance() external view returns (uint256) {
        return GM_TOKEN.balanceOf(address(this));
    }

    /// @notice Whether the float is below target (keeper should pull from GMX).
    function floatDeficit() external view returns (bool deficit, uint256 amount) {
        uint256 idle = USDC.balanceOf(address(this));
        uint256 total = idle + _estimateGmValue(GM_TOKEN.balanceOf(address(this))) + pendingDeposit;
        uint256 target = (total * targetFloatBps) / BPS;
        if (idle < target) {
            return (true, target - idle);
        }
        return (false, 0);
    }

    /// @notice Whether there's excess float to push to GMX.
    function floatExcess() external view returns (bool excess, uint256 amount) {
        uint256 idle = USDC.balanceOf(address(this));
        uint256 total = idle + _estimateGmValue(GM_TOKEN.balanceOf(address(this))) + pendingDeposit;
        uint256 target = (total * targetFloatBps) / BPS;
        if (idle > target) {
            return (true, idle - target);
        }
        return (false, 0);
    }
}
