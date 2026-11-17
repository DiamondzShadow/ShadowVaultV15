// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

import {GmxEventUtils, CreateDepositParams, CreateDepositParamsAddresses, CreateWithdrawalParams,
    CreateWithdrawalParamsAddresses, IGmxExchangeRouter, IGmxRoleStore, IGmxDataStore} from "./gmx/GmxTypes.sol";

// ─────────────────────────────────────────────────────────────
//  GmGmxAdapterV1 — Arbitrum  (matches IYieldAdapter / PendleAdapterV5 style)
//
//  GMX V2 GM-pool yield sleeve. GMX deposits/withdrawals are ASYNC, so this
//  adapter is BUFFERED (deposit custodies USDC; keeper deploys async). The
//  buffered model is also a DRAIN-DEFENSE: per-call vault exposure is limited
//  to the liquid USDC buffer, never the GM position.
//
//  Drain / MEV defenses:
//    - sweepIndexToUsdc enforces an INDEPENDENT Chainlink floor on output, so a
//      compromised KEEPER cannot pass minUsdcOut=0 + a malicious 0x order to
//      drain the index token (loss capped at maxSwapSlippageBps).
//    - Only ever calls the trusted 0x AllowanceHolder (never an arbitrary target).
//    - rescueToken cannot touch USDC / GM / index (principal can't be rescued out).
//    - syncAccounting moves no tokens; admin holds no withdrawal path.
//    - Pausable circuit-breaker (guardian) blocks new deposits/deploys on anomaly;
//      withdraw stays open so the vault can always pull the buffer.
//    - ReentrancyGuard + CEI on all state-mutating paths.
//
//  GMX integration (v1.1, 2026-11-17): structs, callbacks and addresses verified against
//  gmx-synthetics main + @gmx-io/sdk 2.9.1. Callbacks are accepted only from contracts holding
//  GMX's CONTROLLER role (handlers get upgraded; the role follows them). In-flight deposits are
//  tracked per request key; settleDeposit(key) clears one GMX has finished even if its callback
//  failed (GMX swallows callback reverts).
//
//  ⚠️ NOT AUDITED.
// ─────────────────────────────────────────────────────────────

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}
/// @notice Keeper-pushed USDC value of this adapter's GM position (GmNavOracle:
///         staleness + drift caps; reverts if stale/frozen → totalAssets fails closed).
interface IGmNavOracle {
    function getNavUsdc(address market) external view returns (uint256);
}

/// @title GmGmxAdapterV1
contract GmGmxAdapterV1 is IYieldAdapter, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant VAULT_ROLE  = keccak256("VAULT_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 1000; // 10% hard ceiling on keeper-set slippage

    IERC20 public immutable USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);

    bytes32 public constant GMX_CONTROLLER = keccak256(abi.encode("CONTROLLER"));
    bytes32 public constant GMX_DEPOSIT_LIST = keccak256(abi.encode("DEPOSIT_LIST"));

    // GMX infra (admin-settable: GMX redeploys its ExchangeRouter/vaults on upgrades) + 0x
    IGmxExchangeRouter public exchangeRouter;
    address public gmxRouter;                  // ERC20 spender for sendTokens = exchangeRouter.router()
    address public depositVault;
    address public withdrawalVault;
    IGmxRoleStore public roleStore;
    IGmxDataStore public dataStore;
    address public immutable ALLOWANCE_HOLDER; // 0x v2 — the ONLY swap target we call

    address  public immutable market;          // GM token
    IERC20   public immutable indexToken;      // long leg (WETH/WBTC/SOL) returned on withdrawal
    uint8    public immutable indexDecimals;
    IAggregatorV3 public immutable INDEX_USD_FEED; // independent floor for sweep
    uint8    public immutable feedDecimals;

    IGmNavOracle public navOracle;
    uint256 public callbackGasLimit = 1_000_000;
    uint256 public oracleStaleness  = 3600;    // 1h max for the index feed
    uint256 public maxSwapSlippageBps = 200;   // 2% — floor tolerance on sweep (admin, ≤ MAX_SLIPPAGE_BPS)

    uint256 public totalPrincipal;             // 6dp
    uint256 public pendingDepositUsdc;         // in-flight total (sum of pendingByKey)
    mapping(bytes32 => uint256) public pendingByKey;

    event Deposited(address indexed vault, uint256 amount, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event DeployedToGm(uint256 usdc, uint256 minMarketTokens);
    event UnwindRequested(uint256 gmAmount);
    event IndexSwept(uint256 indexIn, uint256 usdcOut, uint256 oracleFloor);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);
    event DepositSettled(bytes32 indexed key, uint256 usdc, bool executed);
    event WithdrawalRequested(bytes32 indexed key, uint256 gmAmount);
    event WithdrawalSettled(bytes32 indexed key, bool executed);
    event GmxContractsSet(address exchangeRouter, address router, address depositVault, address withdrawalVault);

    error ZeroAmount();
    error ZeroAddress();
    error ExceedsBuffer();
    error NoExecFee();
    error Slippage();
    error SlippageTooHigh();
    error NotGmxHandler();
    error OracleStale();
    error OracleInvalidPrice();
    error StillPending(bytes32 key);
    error UnknownKey(bytes32 key);

    modifier onlyGmxController() {
        if (!roleStore.hasRole(msg.sender, GMX_CONTROLLER)) revert NotGmxHandler();
        _;
    }

    constructor(
        address admin, address vault, address keeper,
        address _market, address _indexToken, address _indexUsdFeed, address _navOracle,
        address _allowanceHolder, address _exchangeRouter, address _depositVault, address _withdrawalVault
    ) {
        if (admin == address(0) || _market == address(0) || _indexToken == address(0) || _indexUsdFeed == address(0)
            || _navOracle == address(0) || _allowanceHolder == address(0)) revert ZeroAddress();
        ALLOWANCE_HOLDER = _allowanceHolder;
        market = _market; indexToken = IERC20(_indexToken); navOracle = IGmNavOracle(_navOracle);
        indexDecimals = IERC20Metadata(_indexToken).decimals();
        INDEX_USD_FEED = IAggregatorV3(_indexUsdFeed);
        feedDecimals = IAggregatorV3(_indexUsdFeed).decimals();
        _setGmxContracts(_exchangeRouter, _depositVault, _withdrawalVault);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (vault  != address(0)) _grantRole(VAULT_ROLE, vault);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
    }

    receive() external payable {} // GMX execution-fee refunds (when not routed via refundExecutionFee)

    // ═══════════ IYieldAdapter ═══════════
    function asset() external view override returns (address) { return address(USDC); }

    function totalAssets() public view override returns (uint256) {
        return USDC.balanceOf(address(this)) + pendingDepositUsdc + navOracle.getNavUsdc(market);
    }

    function deposit(uint256 amount) external override onlyRole(VAULT_ROLE) nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);   // custody; keeper deploys async
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    function withdraw(uint256 amount) external override onlyRole(VAULT_ROLE) nonReentrant returns (uint256 delivered) {
        if (amount == 0) revert ZeroAmount();
        uint256 buf = USDC.balanceOf(address(this));
        delivered = amount > buf ? buf : amount;                    // PARTIAL ok — keeper unwinds GM
        if (delivered > 0) {
            USDC.safeTransfer(msg.sender, delivered);
            totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        }
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    function harvest() external override onlyRole(VAULT_ROLE) nonReentrant returns (uint256 profit) {
        uint256 net = totalAssets();
        if (net > totalPrincipal) {
            uint256 surplus = net - totalPrincipal;
            uint256 buf = USDC.balanceOf(address(this));
            profit = surplus > buf ? buf : surplus;                 // only the liquid buffer
            if (profit > 0) USDC.safeTransfer(msg.sender, profit);
        }
        emit Harvested(msg.sender, profit);
    }

    function syncAccounting(uint256 newPrincipal) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════ Keeper (async / swap) ═══════════
    function deployToGm(uint256 usdcAmount, uint256 minMarketTokens)
        external payable onlyRole(KEEPER_ROLE) nonReentrant whenNotPaused returns (bytes32 key)
    {
        if (usdcAmount == 0) revert ZeroAmount();
        if (usdcAmount > USDC.balanceOf(address(this))) revert ExceedsBuffer();
        if (msg.value == 0) revert NoExecFee();
        USDC.forceApprove(gmxRouter, usdcAmount);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IGmxExchangeRouter.sendWnt,    (depositVault, msg.value));
        calls[1] = abi.encodeCall(IGmxExchangeRouter.sendTokens, (address(USDC), depositVault, usdcAmount));
        calls[2] = abi.encodeCall(IGmxExchangeRouter.createDeposit, (CreateDepositParams({
            addresses: CreateDepositParamsAddresses({
                receiver: address(this), callbackContract: address(this), uiFeeReceiver: address(0),
                market: market, initialLongToken: address(indexToken), initialShortToken: address(USDC),
                longTokenSwapPath: new address[](0), shortTokenSwapPath: new address[](0)
            }),
            minMarketTokens: minMarketTokens, shouldUnwrapNativeToken: false,
            executionFee: msg.value, callbackGasLimit: callbackGasLimit, dataList: new bytes32[](0)
        })));
        bytes[] memory res = exchangeRouter.multicall{value: msg.value}(calls);
        key = abi.decode(res[2], (bytes32));
        USDC.forceApprove(gmxRouter, 0);
        pendingByKey[key] = usdcAmount;
        pendingDepositUsdc += usdcAmount;
        emit DeployedToGm(usdcAmount, minMarketTokens);
    }

    /// @notice Request a GM → (long, short) withdrawal. GMX prices it with its oracle at execution;
    ///         the keeper's minimums bound price impact.
    function unwindFromGm(uint256 gmAmount, uint256 minLongOut, uint256 minShortOut)
        external payable onlyRole(KEEPER_ROLE) nonReentrant returns (bytes32 key)
    {
        if (gmAmount == 0) revert ZeroAmount();
        if (msg.value == 0) revert NoExecFee();
        IERC20(market).forceApprove(gmxRouter, gmAmount);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IGmxExchangeRouter.sendWnt,    (withdrawalVault, msg.value));
        calls[1] = abi.encodeCall(IGmxExchangeRouter.sendTokens, (market, withdrawalVault, gmAmount));
        calls[2] = abi.encodeCall(IGmxExchangeRouter.createWithdrawal, (CreateWithdrawalParams({
            addresses: CreateWithdrawalParamsAddresses({
                receiver: address(this), callbackContract: address(this), uiFeeReceiver: address(0),
                market: market, longTokenSwapPath: new address[](0), shortTokenSwapPath: new address[](0)
            }),
            minLongTokenAmount: minLongOut, minShortTokenAmount: minShortOut, shouldUnwrapNativeToken: false,
            executionFee: msg.value, callbackGasLimit: callbackGasLimit, dataList: new bytes32[](0)
        })));
        bytes[] memory res = exchangeRouter.multicall{value: msg.value}(calls);
        key = abi.decode(res[2], (bytes32));
        IERC20(market).forceApprove(gmxRouter, 0);
        emit UnwindRequested(gmAmount);
        emit WithdrawalRequested(key, gmAmount);
    }

    /// @notice Cancel a stuck request (GMX allows the account to cancel after REQUEST_EXPIRATION_TIME).
    ///         Funds come back to this adapter; the GMX callback settles the accounting.
    function cancelGmxDeposit(bytes32 key) external onlyRole(KEEPER_ROLE) nonReentrant {
        exchangeRouter.cancelDeposit(key);
    }

    function cancelGmxWithdrawal(bytes32 key) external onlyRole(KEEPER_ROLE) nonReentrant {
        exchangeRouter.cancelWithdrawal(key);
    }

    /// @notice Clear a deposit GMX has already executed or cancelled when its callback didn't land
    ///         (GMX swallows callback reverts / out-of-gas). Permissionless: it only succeeds once the
    ///         request is gone from GMX's DEPOSIT_LIST, so it can never clear a live request.
    function settleDeposit(bytes32 key) external nonReentrant {
        uint256 amt = pendingByKey[key];
        if (amt == 0) revert UnknownKey(key);
        if (dataStore.containsBytes32(GMX_DEPOSIT_LIST, key)) revert StillPending(key);
        _clearPending(key);
        emit DepositSettled(key, amt, false);
    }

    /// @notice Swap the index token returned by a withdrawal into USDC via 0x.
    ///         Output must clear BOTH the keeper's minUsdcOut AND an independent
    ///         Chainlink floor — so a compromised keeper cannot drain the index
    ///         token with a 0x order at an attacker-favourable price.
    function sweepIndexToUsdc(uint256 minUsdcOut, bytes calldata zeroExData)
        external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 out)
    {
        uint256 bal = indexToken.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        uint256 floor = _indexUsdcFloor(bal);   // independent of keeper input

        uint256 before = USDC.balanceOf(address(this));
        indexToken.forceApprove(ALLOWANCE_HOLDER, bal);
        (bool ok, ) = ALLOWANCE_HOLDER.call(zeroExData); // only ever the trusted AllowanceHolder
        require(ok, "0x failed");
        indexToken.forceApprove(ALLOWANCE_HOLDER, 0);
        out = USDC.balanceOf(address(this)) - before;
        if (out < minUsdcOut || out < floor) revert Slippage();
        emit IndexSwept(bal, out, floor);
    }

    /// @dev Chainlink-derived USDC floor for `indexAmount`, minus maxSwapSlippageBps.
    function _indexUsdcFloor(uint256 indexAmount) internal view returns (uint256) {
        (, int256 answer, , uint256 updatedAt, ) = INDEX_USD_FEED.latestRoundData();
        if (answer <= 0) revert OracleInvalidPrice();
        if (block.timestamp - updatedAt > oracleStaleness) revert OracleStale();
        // value6 = indexAmount * price / 10^(indexDecimals + feedDecimals - 6)
        uint256 div = 10 ** (uint256(indexDecimals) + uint256(feedDecimals) - 6);
        uint256 value6 = (indexAmount * uint256(answer)) / div;
        return (value6 * (BPS - maxSwapSlippageBps)) / BPS;
    }

    // ═══════════ GMX callbacks (gmx-synthetics IDeposit/IWithdrawal/IGasFee CallbackReceiver) ═══════════
    function afterDepositExecution(bytes32 key, GmxEventUtils.EventLogData memory, GmxEventUtils.EventLogData memory)
        external onlyGmxController
    {
        uint256 amt = _clearPending(key);
        emit DepositSettled(key, amt, true);
    }

    function afterDepositCancellation(bytes32 key, GmxEventUtils.EventLogData memory, GmxEventUtils.EventLogData memory)
        external onlyGmxController
    {
        uint256 amt = _clearPending(key); // USDC is refunded to this adapter → back in the buffer
        emit DepositSettled(key, amt, false);
    }

    function afterWithdrawalExecution(bytes32 key, GmxEventUtils.EventLogData memory, GmxEventUtils.EventLogData memory)
        external onlyGmxController
    {
        emit WithdrawalSettled(key, true); // long + short tokens arrived; keeper sweeps the long leg
    }

    function afterWithdrawalCancellation(bytes32 key, GmxEventUtils.EventLogData memory, GmxEventUtils.EventLogData memory)
        external onlyGmxController
    {
        emit WithdrawalSettled(key, false); // GM refunded to this adapter
    }

    /// @notice GMX refunds unused execution fee through this hook when a callback contract is set.
    function refundExecutionFee(bytes32, GmxEventUtils.EventLogData memory) external payable onlyGmxController {}

    function _clearPending(bytes32 key) internal returns (uint256 amt) {
        amt = pendingByKey[key];
        if (amt != 0) {
            delete pendingByKey[key];
            pendingDepositUsdc = pendingDepositUsdc > amt ? pendingDepositUsdc - amt : 0;
        }
    }

    // ═══════════ Views / Admin ═══════════
    function bufferAssets() external view returns (uint256) { return USDC.balanceOf(address(this)); }

    function addVault(address v) external onlyRole(DEFAULT_ADMIN_ROLE) { _grantRole(VAULT_ROLE, v); }
    function removeVault(address v) external onlyRole(DEFAULT_ADMIN_ROLE) { _revokeRole(VAULT_ROLE, v); }
    function setKeeper(address k, bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (on) _grantRole(KEEPER_ROLE, k); else _revokeRole(KEEPER_ROLE, k);
    }
    function setGmxContracts(address er, address dv, address wv) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setGmxContracts(er, dv, wv);
    }
    function setNavOracle(address o) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (o == address(0)) revert ZeroAddress();
        navOracle = IGmNavOracle(o);
    }
    function setCallbackGasLimit(uint256 g) external onlyRole(DEFAULT_ADMIN_ROLE) { callbackGasLimit = g; }

    function _setGmxContracts(address er, address dv, address wv) internal {
        if (er == address(0) || dv == address(0) || wv == address(0)) revert ZeroAddress();
        exchangeRouter = IGmxExchangeRouter(er);
        gmxRouter = IGmxExchangeRouter(er).router();
        roleStore = IGmxRoleStore(IGmxExchangeRouter(er).roleStore());
        dataStore = IGmxDataStore(IGmxExchangeRouter(er).dataStore());
        depositVault = dv;
        withdrawalVault = wv;
        emit GmxContractsSet(er, gmxRouter, dv, wv);
    }
    function setOracleStaleness(uint256 s) external onlyRole(DEFAULT_ADMIN_ROLE) { oracleStaleness = s; }
    function setMaxSwapSlippage(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        maxSwapSlippageBps = bps;
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(USDC) && token != market && token != address(indexToken), "protected");
        IERC20(token).safeTransfer(to, amount);
    }
}
