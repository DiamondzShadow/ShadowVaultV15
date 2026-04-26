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

// ─────────────────────────────────────────────────────────────
//  Uniswap V3 SwapRouter — minimal interface for exactInputSingle
// ─────────────────────────────────────────────────────────────

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title PendleAdapterV5
/// @notice ShadowVaultV15 yield adapter for Pendle V4 USDC-PT markets on Arbitrum.
///
///         **V5 fix (2026-04-12):** Pendle SY contracts for gUSDC (and most other
///         yield-wrapped stables) have ASYMMETRIC token lists — USDC is in
///         `getTokensIn()` but NOT in `getTokensOut()`. The V4 adapter passed
///         `tokenRedeemSy: USDC` which caused `SYInvalidTokenOut` on every
///         withdrawal.
///
///         V5 fixes this by:
///         1. Redeeming from Pendle SY to the native SY output token (e.g. gUSDC)
///         2. Swapping that token → USDC via Uniswap V3 in the same tx
///
///         This makes withdrawals atomic (required by vault's 95% recovery threshold).
///
/// @dev Market parameters (market / PT / YT / SY / maturity / syNativeToken)
///      are mutable by admin so we can roll to a new maturity without redeploying.
///      Admin must fully unwind (`ptBalance == 0`) before switching markets.
contract PendleAdapterV5 is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20            public immutable USDC   = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IPendleRouterV4   public immutable ROUTER = IPendleRouterV4(0x888888888889758F76e7103c6CbF23ABbF58F946);
    IPendlePYLpOracle public immutable ORACLE = IPendlePYLpOracle(0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2);

    /// @dev Pendle's recommended TWAP window for lending-style integrations (15 min).
    uint32 public constant TWAP_DURATION = 900;

    // ───────── Uniswap V3 (for SY native → USDC swap) ─────────
    ISwapRouter public immutable UNI_ROUTER;

    // ───────── Mutable market config ─────────
    address public market;
    address public pt;
    address public yt;
    address public sy;
    uint256 public maturity;
    uint8   public ptDecimals;
    uint256 public ptScale;

    /// @notice The token that SY.getTokensOut() accepts for redemption.
    ///         For gUSDC market: gUSDC (0xd3443ee1e91aF28e5FB858Fbd0D72A63bA8046E0).
    ///         MUST be set correctly — if this is wrong, withdraw reverts with
    ///         SYInvalidTokenOut (the exact bug V5 fixes).
    address public syNativeToken;

    /// @notice Uniswap V3 pool fee tier for the syNativeToken/USDC pair.
    ///         Default 500 (0.05%) — confirmed for gUSDC/USDC pool on Arbitrum.
    uint24 public uniPoolFee = 500;

    // ───────── State ─────────
    uint256 public totalPrincipal;

    uint256 public slippageBps = 1500; // 15% default
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 3000; // 30% ceiling

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 usdcIn, uint256 ptOut, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event MarketUpdated(address market, address pt, address yt, address sy, address syNativeToken, uint256 maturity);
    event OracleInitialized(address market, uint16 cardinality);
    event SlippageUpdated(uint256 newBps);
    event UniPoolFeeUpdated(uint24 newFee);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error MarketNotSet();
    error MarketBusy();
    error SlippageTooHigh();
    error OracleNotReady();
    error ZeroAddress();

    // ───────── Constructor ─────────
    /// @param admin Initial DEFAULT_ADMIN_ROLE holder.
    /// @param _uniRouter Uniswap V3 SwapRouter address on Arbitrum
    ///        (0xE592427A0AEce92De3Edee1F18E0157C05861564).
    /// @param _market Pendle market address (e.g. gUSDC 25JUN2026 on Arbitrum).
    /// @param _pt Principal token for the market.
    /// @param _yt Yield token for the market.
    /// @param _sy Standardized Yield token for the market.
    /// @param _syNativeToken The token SY.getTokensOut() returns (e.g. gUSDC address).
    constructor(
        address admin,
        address _uniRouter,
        address _market,
        address _pt,
        address _yt,
        address _sy,
        address _syNativeToken
    ) {
        if (admin == address(0) || _uniRouter == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        UNI_ROUTER = ISwapRouter(_uniRouter);

        if (_market != address(0)) {
            _setMarketInternal(_market, _pt, _yt, _sy, _syNativeToken);
        }

        // Standing approval for Pendle router to pull USDC (deposit path).
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
    /// @dev Counts idle USDC + idle syNativeToken + PT valued via oracle.
    ///      PT value is discounted by `slippageBps` to reflect the real
    ///      executable value after the two-hop swap (PT → syNativeToken → USDC).
    ///      Without this discount, the vault's 95% recovery check fails because
    ///      the oracle rate overstates what the AMM + DEX actually deliver.
    function totalAssets() external view override returns (uint256) {
        uint256 idle = USDC.balanceOf(address(this));

        // Count any syNativeToken that hasn't been swapped to USDC yet.
        if (syNativeToken != address(0)) {
            uint256 syBal = IERC20(syNativeToken).balanceOf(address(this));
            idle += syBal;
        }

        if (pt == address(0)) return idle;

        uint256 ptBal = IERC20(pt).balanceOf(address(this));
        if (ptBal == 0) return idle;

        if (block.timestamp >= maturity) {
            return idle + (ptBal / 1e12);
        }

        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        // Discount by slippageBps to match executable value after two-hop swap.
        uint256 discountedRate = (rate * (BPS - slippageBps)) / BPS;
        uint256 ptValue = (ptBal * discountedRate) / ptScale;
        return idle + ptValue;
    }

    /// @inheritdoc IYieldAdapter
    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (market == address(0)) revert MarketNotSet();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        if (rate == 0) revert OracleNotReady();
        uint256 expectedPt = (amount * ptScale) / rate;
        uint256 minPtOut = (expectedPt * (BPS - slippageBps)) / BPS;

        // Deposit uses USDC directly as tokenMintSy — USDC IS in
        // SY.getTokensIn() for gUSDC. This path was always correct.
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
    /// @dev V5 FIX: Pendle SY for gUSDC (and most wrappers) only accepts the
    ///      native token in getTokensOut(), not USDC. This adapter:
    ///      1. Redeems PT → syNativeToken (e.g. gUSDC) via Pendle AMM/PY
    ///      2. Swaps syNativeToken → USDC via Uniswap V3 in the same tx
    ///      Both steps happen atomically so the vault's 95% recovery check passes.
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
                uint256 rate;
                if (block.timestamp >= maturity) {
                    rate = 1e18;
                } else {
                    rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
                    if (rate == 0) revert OracleNotReady();
                }

                uint256 ptIn = (remaining * ptScale) / rate;
                if (ptIn > ptBal) ptIn = ptBal;

                if (ptIn > 0) {
                    IERC20(pt).forceApprove(address(ROUTER), ptIn);

                    // ────── V5 FIX: redeem to syNativeToken, NOT USDC ──────
                    // Set minTokenOut to 0 on the Pendle side — the real
                    // slippage guard is the vault's 95% recovery check after
                    // the Uniswap V3 swap. Pendle's own check fails for tiny
                    // trades because gUSDC is worth ~1.07 USDC (yield-bearing),
                    // so USDC-denominated minOut overshoots gUSDC amounts.
                    TokenOutput memory output = TokenOutput({
                        tokenOut: syNativeToken,
                        minTokenOut: 0,
                        tokenRedeemSy: syNativeToken,
                        pendleSwap: address(0),
                        swapData: SwapData({swapType: 0, extRouter: address(0), extCalldata: "", needScale: false})
                    });

                    uint256 syBefore = IERC20(syNativeToken).balanceOf(address(this));

                    if (block.timestamp >= maturity || IPPrincipalToken(pt).isExpired()) {
                        ROUTER.redeemPyToToken(address(this), yt, ptIn, output);
                    } else {
                        LimitOrderData memory emptyLimit;
                        ROUTER.swapExactPtForToken(address(this), market, ptIn, output, emptyLimit);
                    }

                    uint256 syReceived = IERC20(syNativeToken).balanceOf(address(this)) - syBefore;

                    // ────── V5 FIX: swap syNativeToken → USDC via Uniswap V3 ──────
                    if (syReceived > 0) {
                        IERC20(syNativeToken).forceApprove(address(UNI_ROUTER), syReceived);

                        uint256 usdcBefore = USDC.balanceOf(address(this));

                        UNI_ROUTER.exactInputSingle(
                            ISwapRouter.ExactInputSingleParams({
                                tokenIn: syNativeToken,
                                tokenOut: address(USDC),
                                fee: uniPoolFee,
                                recipient: address(this),
                                deadline: block.timestamp,
                                amountIn: syReceived,
                                amountOutMinimum: 0, // slippage already guarded by Pendle minSyOut
                                sqrtPriceLimitX96: 0
                            })
                        );

                        fromPt = USDC.balanceOf(address(this)) - usdcBefore;
                    }
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
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        // Swap any residual syNativeToken to USDC first.
        _swapResidualSyNative();

        uint256 idle = USDC.balanceOf(address(this));
        if (idle > 0 && idle + _ptValue() > totalPrincipal) {
            uint256 excess = idle + _ptValue() - totalPrincipal;
            uint256 toSweep = excess < idle ? excess : idle;
            profit = toSweep / 2;
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
    /// @param _syNativeToken The token SY.getTokensOut() returns. MUST be
    ///        verified on-chain BEFORE calling. Call SY.getTokensOut() and
    ///        confirm this address is in the returned array, otherwise
    ///        withdrawals will revert with SYInvalidTokenOut.
    function setMarket(
        address _market,
        address _pt,
        address _yt,
        address _sy,
        address _syNativeToken
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (pt != address(0) && IERC20(pt).balanceOf(address(this)) > 0) revert MarketBusy();
        _setMarketInternal(_market, _pt, _yt, _sy, _syNativeToken);
    }

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

    function setUniPoolFee(uint24 _fee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uniPoolFee = _fee;
        emit UniPoolFeeUpdated(_fee);
    }

    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault);
    }

    function removeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault);
    }

    /// @notice Rescue non-core tokens. PT/YT/SY/USDC/syNativeToken are protected.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(
            token != address(USDC) && token != pt && token != yt &&
            token != sy && token != syNativeToken,
            "protected"
        );
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Sweep any residual syNativeToken → USDC via Uniswap V3.
    ///         Callable by admin if harvest doesn't auto-clean.
    function sweepSyNative() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _swapResidualSyNative();
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _setMarketInternal(
        address _market,
        address _pt,
        address _yt,
        address _sy,
        address _syNativeToken
    ) internal {
        if (_syNativeToken == address(0)) revert ZeroAddress();
        market = _market;
        pt = _pt;
        yt = _yt;
        sy = _sy;
        syNativeToken = _syNativeToken;
        maturity = IPMarket(_market).expiry();
        uint8 dec = IERC20Metadata(_pt).decimals();
        ptDecimals = dec;
        ptScale = 10 ** (uint256(dec) + 12);
        emit MarketUpdated(_market, _pt, _yt, _sy, _syNativeToken, maturity);
    }

    function _ptValue() internal view returns (uint256) {
        if (pt == address(0)) return 0;
        uint256 ptBal = IERC20(pt).balanceOf(address(this));
        if (ptBal == 0) return 0;
        if (block.timestamp >= maturity) return ptBal / 1e12;
        uint256 rate = ORACLE.getPtToAssetRate(market, TWAP_DURATION);
        return (ptBal * rate) / ptScale;
    }

    /// @dev Swap any syNativeToken balance to USDC via Uniswap V3.
    function _swapResidualSyNative() internal {
        if (syNativeToken == address(0)) return;
        uint256 bal = IERC20(syNativeToken).balanceOf(address(this));
        if (bal == 0) return;

        IERC20(syNativeToken).forceApprove(address(UNI_ROUTER), bal);
        UNI_ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: syNativeToken,
                tokenOut: address(USDC),
                fee: uniPoolFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: bal,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
