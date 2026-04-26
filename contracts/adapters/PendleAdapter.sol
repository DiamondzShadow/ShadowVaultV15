// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

// ─────────────────────────────────────────────────────────────
//  Pendle V4 — minimal inlined types
//
//  All structs and selectors verified against pendle-core-v2-public
//  ( github.com/pendle-finance/pendle-core-v2-public ) at the gUSDC
//  market deploy on Arbitrum 42161.
//
//  Router v4 diamond:  0x888888888889758F76e7103c6CbF23ABbF58F946
//  PY/LP TWAP Oracle:  0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2
// ─────────────────────────────────────────────────────────────

struct SwapData {
    uint8 swapType;
    address extRouter;
    bytes extCalldata;
    bool needScale;
}

struct TokenInput {
    address tokenIn;
    uint256 netTokenIn;
    address tokenMintSy;
    address pendleSwap;
    SwapData swapData;
}

struct TokenOutput {
    address tokenOut;
    uint256 minTokenOut;
    address tokenRedeemSy;
    address pendleSwap;
    SwapData swapData;
}

struct ApproxParams {
    uint256 guessMin;
    uint256 guessMax;
    uint256 guessOffchain;
    uint256 maxIteration;
    uint256 eps;
}

// Pendle V4 routes `FillOrderParams[]` through the limit-order diamond.
// We don't fill limit orders here, so `normalFills` and `flashFills` are
// always empty — but the INNER `Order` struct layout still matters for
// ABI selector computation. The canonical form of `LimitOrderData` depends
// on the full type hash of every nested struct, so using a simplified
// placeholder produces a wrong selector and the router's diamond fallback
// reverts with INVALID_SELECTOR (hit on v15.4 first deploy, 2026-04-11).
//
// Struct definitions copied from pendle-finance/pendle-core-v2-public
// `contracts/limit/LimitOrder.sol` → `IPLimitRouter.sol`.
enum OrderType {
    SY_FOR_PT,
    PT_FOR_SY,
    SY_FOR_YT,
    YT_FOR_SY
}

struct Order {
    uint256 salt;
    uint256 expiry;
    uint256 nonce;
    OrderType orderType;
    address token;
    address YT;
    address maker;
    address receiver;
    uint256 makingAmount;
    uint256 lnImpliedRate;
    uint256 failSafeRate;
    bytes permit;
}

struct FillOrderParams {
    Order order;
    bytes signature;
    uint256 makingAmount;
}

struct LimitOrderData {
    address limitRouter;
    uint256 epsSkipMarket;
    FillOrderParams[] normalFills;
    FillOrderParams[] flashFills;
    bytes optData;
}

interface IPendleRouterV4 {
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);

    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);

    function redeemPyToToken(
        address receiver,
        address YT,
        uint256 netPyIn,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut, uint256 netSyInterm);
}

interface IPendlePYLpOracle {
    function getPtToAssetRate(address market, uint32 duration) external view returns (uint256);
    function getOracleState(address market, uint32 duration)
        external
        view
        returns (bool increaseCardinalityRequired, uint16 cardinalityRequired, bool oldestObservationSatisfied);
}

interface IPMarket {
    function increaseObservationsCardinalityNext(uint16 cardinalityNext) external;
    function expiry() external view returns (uint256);
}

interface IPPrincipalToken {
    function isExpired() external view returns (bool);
}

/// @title PendleAdapter
/// @notice ShadowVaultV15 yield adapter for Pendle V4 USDC-PT markets on Arbitrum.
///
///         Deposits USDC by swapping into the configured market's PT token via
///         `swapExactTokenForPt`. `totalAssets()` is priced via the PY/LP TWAP
///         oracle (15-min duration, Pendle's recommendation for lending integrations).
///         Withdrawals before expiry route through `swapExactPtForToken`;
///         post-expiry they route through `redeemPyToToken` for a 1:1 redemption.
///
/// @dev Market parameters (market / PT / YT / SY / maturity) are mutable by
///      admin so we can roll to a new maturity without redeploying. Admin must
///      fully unwind (`ptBalance == 0`) before switching markets.
///
///      Oracle bootstrap: the first time a fresh market is pointed at, admin
///      MUST call `initializeOracle()` to increase the market's observation
///      cardinality. Without this, `getPtToAssetRate` reverts.
contract PendleAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20            public immutable USDC   = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IPendleRouterV4   public immutable ROUTER = IPendleRouterV4(0x888888888889758F76e7103c6CbF23ABbF58F946);
    IPendlePYLpOracle public immutable ORACLE = IPendlePYLpOracle(0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2);

    /// @dev Pendle's recommended TWAP window for lending-style integrations (15 min).
    uint32 public constant TWAP_DURATION = 900;

    // ───────── Mutable market config ─────────
    address public market;
    address public pt;
    address public yt;
    address public sy;
    uint256 public maturity;
    /// @notice Cached PT token decimals. Most Pendle PTs are 18-dec but
    ///         USDC-underlying markets (e.g. PT-gUSDC) use 6-dec PTs.
    ///         Set on every setMarket call from IERC20Metadata(pt).decimals().
    uint8 public ptDecimals;
    /// @notice Scale factor for PT ↔ USDC math: 10^(18 + ptDecimals - 6).
    ///         For 18-dec PT: ptScale (legacy behavior). For 6-dec PT: 1e18.
    ///         Used in place of the hardcoded ptScale so the adapter supports
    ///         PT tokens of any decimals against a 6-dec USDC underlying.
    uint256 public ptScale;

    // ───────── State ─────────
    /// @notice Running sum of USDC cost basis (principal). Used for harvest accounting.
    uint256 public totalPrincipal;

    /// @notice Slippage tolerance applied to oracle-implied minOut (bps of BPS).
    /// @dev Default was 0.50% at v15.4 but small PT-gUSDC trades ($5-10) can
    ///      eat 10-20% slippage because (a) the oracle TWAP diverges from
    ///      spot for small trades, (b) the SY exchangeRate adds a conversion
    ///      layer on top of the PT rate, (c) Pendle's swap fee stacks with
    ///      the AMM curvature near zero-trade. Raised default to 15% and
    ///      max to 30% to actually let tiny trades land (learned 2026-04-11).
    uint256 public slippageBps = 1500; // 15% default
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 3000; // 30% ceiling

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 usdcIn, uint256 ptOut, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event MarketUpdated(address market, address pt, address yt, address sy, uint256 maturity);
    event OracleInitialized(address market, uint16 cardinality);
    event SlippageUpdated(uint256 newBps);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error MarketNotSet();
    error MarketBusy();
    error SlippageTooHigh();
    error OracleNotReady();

    // ───────── Constructor ─────────
    /// @param admin Initial DEFAULT_ADMIN_ROLE holder.
    /// @param _market Pendle market address (e.g. gUSDC 25JUN2026 on Arbitrum).
    /// @param _pt Principal token for the market.
    /// @param _yt Yield token for the market.
    /// @param _sy Standardized Yield token for the market.
    /// @dev Market can be zero-address on deploy; admin calls `setMarket` once the
    ///      target is confirmed via on-chain reads. This lets the deploy script
    ///      stay hands-free on market drift.
    constructor(address admin, address _market, address _pt, address _yt, address _sy) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (_market != address(0)) {
            market = _market;
            pt = _pt;
            yt = _yt;
            sy = _sy;
            maturity = IPMarket(_market).expiry();
            // Query PT decimals and compute the ptScale factor for PT math.
            // USDC is hardcoded as 6-dec; ptScale = 10^(18 + ptDecimals - 6).
            uint8 dec = IERC20Metadata(_pt).decimals();
            ptDecimals = dec;
            ptScale = 10 ** (uint256(dec) + 12);  // 18 + dec - 6 = dec + 12
            emit MarketUpdated(_market, _pt, _yt, _sy, maturity);
        }
        USDC.forceApprove(address(ROUTER), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Value = idle USDC held by the adapter
    ///             + PT balance × TWAP rate (pre-expiry)
    ///             + PT balance × 1e0 (post-expiry, 1:1 redemption)
    ///      PT is 18-decimal, USDC is 6-decimal, rate is 1e18 fixed-point.
    function totalAssets() external view override returns (uint256) {
        uint256 idle = USDC.balanceOf(address(this));
        if (pt == address(0)) return idle;

        uint256 ptBal = IERC20(pt).balanceOf(address(this));
        if (ptBal == 0) return idle;

        if (block.timestamp >= maturity) {
            // Post-expiry: 1 PT ≈ 1 unit of accounting asset. Scale 18→6.
            return idle + (ptBal / 1e12);
        }

        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        // ptBal [1e18] * rate [1e18] / 1e18 [cancel] / 1e12 [18→6] = usdc [1e6]
        uint256 ptValue = (ptBal * rate) / ptScale;
        return idle + ptValue;
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Swaps the full input USDC amount into PT. Slippage is enforced via
    ///      `minPtOut` derived from the PY/LP TWAP oracle with `slippageBps`
    ///      tolerance. Approx params use the on-chain fallback (eps = 1e14 =
    ///      0.01%) — higher gas than off-chain hinting but self-contained.
    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (market == address(0)) revert MarketNotSet();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        // Derive minPtOut from oracle: amountUsdc / rate * (1 - slippage)
        // rate is 1e18-scaled PT-per-asset, so invert: ptOut = usdcIn * ptScale / rate
        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        if (rate == 0) revert OracleNotReady();
        uint256 expectedPt = (amount * ptScale) / rate;
        uint256 minPtOut = (expectedPt * (BPS - slippageBps)) / BPS;

        TokenInput memory input = TokenInput({
            tokenIn: address(USDC),
            netTokenIn: amount,
            tokenMintSy: address(USDC),
            pendleSwap: address(0),
            swapData: SwapData({swapType: 0, extRouter: address(0), extCalldata: "", needScale: false})
        });

        ApproxParams memory approx = ApproxParams({
            guessMin: 0,
            guessMax: type(uint256).max,
            guessOffchain: 0,
            maxIteration: 256,
            eps: 1e14
        });

        LimitOrderData memory emptyLimit;

        (uint256 ptOut, , ) = ROUTER.swapExactTokenForPt(
            address(this),
            market,
            minPtOut,
            approx,
            input,
            emptyLimit
        );

        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, ptOut, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Converts the requested USDC amount to PT via oracle, redeems
    ///      the corresponding PT back to USDC. Pre-expiry uses the AMM;
    ///      post-expiry uses the 1:1 PY redemption path.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();
        if (market == address(0)) revert MarketNotSet();

        // First, use any idle USDC held by the adapter.
        uint256 idle = USDC.balanceOf(address(this));
        uint256 fromIdle = amount > idle ? idle : amount;

        uint256 remaining = amount - fromIdle;
        uint256 fromPt = 0;

        if (remaining > 0) {
            uint256 ptBal = IERC20(pt).balanceOf(address(this));
            if (ptBal > 0) {
                // Convert remaining USDC target → PT input via oracle.
                uint256 rate;
                if (block.timestamp >= maturity) {
                    // Post-expiry: 1 PT = 1 asset (scale 18→6).
                    rate = 1e18;
                } else {
                    rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
                    if (rate == 0) revert OracleNotReady();
                }

                // ptIn [1e18] = remaining [1e6] * ptScale / rate [1e18]
                uint256 ptIn = (remaining * ptScale) / rate;
                if (ptIn > ptBal) ptIn = ptBal;

                if (ptIn > 0) {
                    // Approve router to pull PT.
                    IERC20(pt).forceApprove(address(ROUTER), ptIn);

                    uint256 minOut = (remaining * (BPS - slippageBps)) / BPS;

                    TokenOutput memory output = TokenOutput({
                        tokenOut: address(USDC),
                        minTokenOut: minOut,
                        tokenRedeemSy: address(USDC),
                        pendleSwap: address(0),
                        swapData: SwapData({swapType: 0, extRouter: address(0), extCalldata: "", needScale: false})
                    });

                    uint256 usdcBefore = USDC.balanceOf(address(this));

                    if (block.timestamp >= maturity || IPPrincipalToken(pt).isExpired()) {
                        ROUTER.redeemPyToToken(address(this), yt, ptIn, output);
                    } else {
                        LimitOrderData memory emptyLimit;
                        ROUTER.swapExactPtForToken(address(this), market, ptIn, output, emptyLimit);
                    }

                    fromPt = USDC.balanceOf(address(this)) - usdcBefore;
                }
            }
        }

        delivered = fromIdle + fromPt;
        if (delivered > 0) {
            USDC.safeTransfer(msg.sender, delivered);
        }

        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev For Pendle, "harvest" only yields something meaningful after expiry
    ///      when the PT can be redeemed above its entry price. Pre-expiry,
    ///      profit is unrealized (locked in PT), so we return 0 and let the
    ///      vault's `totalAssets()` reflect the paper gain via the oracle.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        // Sweep any stray USDC that accumulated (e.g. from partial withdraws).
        uint256 idle = USDC.balanceOf(address(this));
        if (idle > 0 && idle + _ptValue() > totalPrincipal) {
            uint256 excess = idle + _ptValue() - totalPrincipal;
            uint256 toSweep = excess < idle ? excess : idle;
            profit = toSweep / 2; // same 50% buffer pattern as other adapters
            if (profit > 0) {
                USDC.safeTransfer(msg.sender, profit);
            }
        }
        emit Harvested(msg.sender, profit);
    }

    /// @inheritdoc IYieldAdapter
    function syncAccounting(uint256 newPrincipal) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    /// @notice Point the adapter at a new Pendle market. Requires a clean
    ///         PT balance — admin must fully unwind before rolling.
    function setMarket(address _market, address _pt, address _yt, address _sy)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (pt != address(0) && IERC20(pt).balanceOf(address(this)) > 0) revert MarketBusy();
        market = _market;
        pt = _pt;
        yt = _yt;
        sy = _sy;
        maturity = IPMarket(_market).expiry();
        uint8 dec = IERC20Metadata(_pt).decimals();
        ptDecimals = dec;
        ptScale = 10 ** (uint256(dec) + 12);
        emit MarketUpdated(_market, _pt, _yt, _sy, maturity);
    }

    /// @notice Bootstrap the PY/LP oracle for the configured market.
    ///         Increases observation cardinality and waits for the TWAP window.
    ///         Must be called once per fresh market before deposit() will work.
    function initializeOracle() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (market == address(0)) revert MarketNotSet();
        (, uint16 cardinality, ) = ORACLE.getOracleState(market, TWAP_DURATION);
        if (cardinality > 0) {
            IPMarket(market).increaseObservationsCardinalityNext(cardinality);
        }
        emit OracleInitialized(market, cardinality);
    }

    function setSlippage(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        slippageBps = bps;
        emit SlippageUpdated(bps);
    }

    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault);
    }

    function removeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault);
    }

    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(USDC) && token != pt && token != yt && token != sy, "protected");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _ptValue() internal view returns (uint256) {
        if (pt == address(0)) return 0;
        uint256 ptBal = IERC20(pt).balanceOf(address(this));
        if (ptBal == 0) return 0;
        if (block.timestamp >= maturity) return ptBal / 1e12;
        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        return (ptBal * rate) / ptScale;
    }
}
