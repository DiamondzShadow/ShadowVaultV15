// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {IShadowPositionNFT} from "./interfaces/IShadowPositionNFT.sol";
import {IBonusAccumulator} from "./interfaces/IBonusAccumulator.sol";

/// @dev Chainlink on Arbitrum — USD-denominated price feeds.
interface AggregatorV3 {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/// @dev Arbitrum L2 sequencer uptime feed. MUST be checked before trusting
///      any Chainlink price on Arbitrum. Feed layout: `answer == 0` means
///      sequencer is up; `answer == 1` means it's down (or recently restarted).
interface ISequencerUptimeFeed {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}

// ═════════════════════════════════════════════════════════════════════════
//
//  ShadowVaultV15 — Arbitrum Index Vault
//
//  ONE vault instance = ONE basket (e.g. Pool A: WETH/WBTC/USDC).
//  Deploy three instances for three baskets. Each instance binds to ONE
//  yield adapter (Aave / Fluid / Pendle) via IYieldAdapter.
//
//  Yield sources per deploy:
//    Pool A (Blue Chip)   → AaveAdapterV5   (~4-5% USDC APY)
//    Pool B (DeFi + RWA)  → PendleAdapter   (fixed USDC-PT yield)
//    Pool C (Full Spec.)  → FluidAdapter    (~5-7% USDC APY)
//
//  Deposit flow:
//    user → USDC → vault
//      70% → stays as USDC, keeper converts to basket tokens via 0x
//      30% → yield adapter (deposited immediately)
//    → mint wSDM internal share for basket leg
//    → mint ShadowPositionNFTV15
//    → register position in BonusAccumulator (if wired)
//
//  Rebalance: keeper fetches drift via getBasketDrift(), quotes 0x off-chain,
//  calls executeRebalance() with tokenIn/tokenOut/amountIn/minOut/calldata.
//  The vault checks: sequencer up, oracle minOut bounds, swapTarget in
//  allowlist, balance delta valid, drift actually improved.
//
//  Withdraw: two-step.
//    1. User calls requestWithdraw(posId) → adapter withdraws yield leg,
//       basket USDC share is locked, withdraw timer starts.
//    2. Keeper sells basket tokens via executeWithdrawalSwap() → USDC accrues.
//    3. Keeper (or user after timeout) calls completeWithdraw() → payout.
//
// ═════════════════════════════════════════════════════════════════════════
contract ShadowVaultV15 is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ───────── Chain-scoped immutables ─────────
    /// @notice The underlying unit of account. Must be a 6-decimal USDC on
    ///         whichever chain this vault is deployed to (Arbitrum USDC or
    ///         HyperEVM USDC0). Set in constructor.
    IERC20 public immutable USDC;
    /// @notice L2 sequencer uptime feed (Chainlink). On chains without one
    ///         (HyperEVM), pass address(0) and `_checkSequencer` becomes a
    ///         no-op — only safe when the vault has no oracle-priced basket.
    ISequencerUptimeFeed public immutable SEQ_UPTIME;
    /// @dev Grace period after sequencer restart during which oracle prices are not trusted.
    uint256 public constant SEQ_GRACE_PERIOD = 3600; // 1 hour
    uint256 public constant BPS = 10_000;
    /// @dev Default per-token oracle staleness when a basket token is added
    ///      with `maxStalenessSecs = 0`. Applies to most Chainlink USD feeds.
    uint32 public constant DEFAULT_PRICE_STALENESS = 3600; // 1 hour
    /// @dev Absolute ceiling for per-token staleness. Caps the blast radius of
    ///      misconfiguration — a stale price above a week is definitely wrong.
    uint32 public constant MAX_PRICE_STALENESS = 604800; // 7 days

    // ───────── Config limits ─────────
    uint256 public constant MIN_DEPOSIT = 5_000_000;           // $5
    uint256 public constant MAX_DEPOSIT = 1_000_000_000_000;   // $1M
    uint256 public constant MIN_CLAIM   = 1_000_000;           // $1

    // ───────── Enums ─────────
    enum Tier { FLEX, THIRTY, NINETY, ONEIGHTY, YEAR }
    enum WithdrawStatus { NONE, REQUESTED, COMPLETED }

    // ───────── Structs ─────────
    struct TokenConfig {
        address token;
        uint256 targetWeightBps;
        address priceFeed;     // 0 == stablecoin, 1:1 with USD
        uint8 feedDecimals;
        uint8 tokenDecimals;
        uint32 maxStalenessSecs; // 0 == DEFAULT_PRICE_STALENESS (1h); capped at MAX_PRICE_STALENESS (7d)
    }

    struct Position {
        address depositor;
        Tier tier;
        uint256 depositAmount;   // USDC deposited (6-dec)
        uint256 wsdmAmount;      // basket share amount (internal)
        uint256 yieldShare;      // boosted yield-adapter allocation
        uint256 yieldClaimed;    // cumulative yield claimed for FLEX tier
        uint256 depositTime;
        uint256 unlockTime;
        uint256 multiplierBps;
        uint256 loanOutstanding; // lending stub for future use
        WithdrawStatus withdrawStatus;
    }

    struct PendingWithdraw {
        address user;
        uint256 usdcGathered;  // USDC gathered from keeper basket sells
        uint256 yieldUSDC;     // yield-adapter payout already withdrawn
        uint256 basketUSDC;    // pro-rata idle USDC at request time
        uint256 feeBps;        // fee applied at completion
        uint256 requestTime;
    }

    // ───────── Basket & yield config ─────────
    TokenConfig[] public basketTokens;
    IYieldAdapter public immutable yieldAdapter;

    // ───────── Integrations ─────────
    IShadowPositionNFT public positionNFT;
    IBonusAccumulator public bonusAccumulator; // may be address(0)
    address public sdmToken;
    address public treasury;

    // ───────── Allocation ─────────
    uint256 public basketBps = 7000;
    uint256 public yieldBps = 3000;

    // ───────── Fees ─────────
    uint256 public earlyExitFeeBps = 900;
    uint256 public onTimeFeeBps = 120;
    uint256 public protocolYieldFeeBps = 300;
    uint256 public sdmDiscountBps = 5000;
    uint256 public sdmThreshold = 10_000e18;

    // ───────── Rebalance guardrails ─────────
    uint256 public rebalanceSlippageBps = 50; // 0.50% oracle-derived minOut tolerance
    uint256 public maxRebalanceSizeBps = 2000; // max 20% of basket value per rebalance tx
    uint256 public withdrawTimeout = 30 minutes;
    /// @notice Swap targets the keeper is allowed to route through (0x, 1inch, etc.)
    mapping(address => bool) public trustedSwapTargets;

    // ───────── Whitelist ─────────
    bool public whitelistEnabled;
    mapping(address => bool) public whitelisted;

    // ───────── State ─────────
    uint256 public wsdmTotalSupply;
    uint256 public yieldTotalShares;
    uint256 public totalDeposited;
    uint256 public totalFeesCollected;
    uint256 public totalYieldHarvested;

    uint256 public nextPosId = 1;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => PendingWithdraw) public pendingWithdraws;
    mapping(address => uint256) public lastDepositTime;

    // ───────── Events ─────────
    event Deposited(uint256 indexed posId, address indexed user, Tier tier, uint256 amount, uint256 wsdm);
    event WithdrawRequested(uint256 indexed posId, address indexed user, uint256 yieldUSDC, uint256 basketUSDC);
    event WithdrawCompleted(uint256 indexed posId, address indexed user, uint256 payout, uint256 fee);
    event KeeperSwapExecuted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event RebalanceSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event YieldClaimed(uint256 indexed posId, address indexed user, uint256 amount);
    event YieldCompounded(uint256 indexed posId, uint256 amount, uint256 wsdmMinted);
    event YieldHarvested(uint256 profit, uint256 protocolFee);
    event BasketTokenAdded(address token, uint256 weightBps, address priceFeed);
    event BasketTokenWeightUpdated(uint256 index, uint256 newWeightBps);
    event SwapTargetSet(address target, bool trusted);
    event BonusAccumulatorSet(address indexed accumulator);
    event PositionNFTSet(address indexed nft);
    event WhitelistEnabledSet(bool enabled);
    event WhitelistSet(address indexed account, bool status);

    // ───────── Errors ─────────
    error ZeroAddress();
    error ZeroAmount();
    error InvalidAmount();
    error InvalidTier();
    error NotPositionOwner();
    error AlreadyWithdrawn();
    error NotRequested();
    error AlreadyRequested();
    error CooldownActive();
    error LoanOutstanding();
    error SwapFailed();
    error WeightsMismatch();
    error BelowMinClaim();
    error WithdrawNotReady();
    error UntrustedSwapTarget();
    error SequencerDown();
    error SequencerGracePeriod();
    error NoSequencerFeed();
    error StalePrice();
    error SlippageExceeded();
    error RebalanceTooBig();
    error NotBasketToken();
    error AdapterAssetMismatch();
    error StalenessTooHigh();
    /// @notice The yield adapter delivered less than 95% of the requested
    ///         withdraw (e.g. Silo was 100% utilized). User should retry
    ///         later once utilization drops. Protects against orphaned
    ///         yield shares in the vault's accounting.
    error AdapterPartialWithdraw(uint256 requested, uint256 delivered);
    error NotWhitelisted();

    // ═════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═════════════════════════════════════════════════════════════════════

    /// @param admin Initial DEFAULT_ADMIN_ROLE holder (deployer EOA; transfers
    ///              to Gnosis Safe post-test via grantRole + renounceRole).
    /// @param _yieldAdapter The single IYieldAdapter instance this vault binds to.
    /// @param _treasury Treasury address (fee recipient).
    /// @param _sdmToken SDM token for fee discount check (or address(0) to disable).
    /// @param _usdc  USDC-equivalent unit of account for this deployment (6-dec).
    /// @param _seqUptime Chainlink sequencer-uptime feed (L2s). Pass address(0)
    ///                   on chains without one (e.g. HyperEVM); only safe when
    ///                   the basket is empty or uses non-oracle pricing.
    constructor(
        address admin,
        address _yieldAdapter,
        address _treasury,
        address _sdmToken,
        address _usdc,
        address _seqUptime
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (_yieldAdapter == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();

        USDC = IERC20(_usdc);
        SEQ_UPTIME = ISequencerUptimeFeed(_seqUptime); // may be address(0)

        yieldAdapter = IYieldAdapter(_yieldAdapter);
        if (yieldAdapter.asset() != _usdc) revert AdapterAssetMismatch();

        treasury = _treasury;
        sdmToken = _sdmToken;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin); // deployer doubles as initial keeper until set
        _grantRole(PAUSER_ROLE, admin);

        // Pre-approve the adapter for unlimited USDC.
        USDC.forceApprove(_yieldAdapter, type(uint256).max);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Basket config
    // ═════════════════════════════════════════════════════════════════════

    /// @param _maxStalenessSecs Per-token price-feed staleness. 0 = fall back to
    ///        DEFAULT_PRICE_STALENESS (1h). Use higher values for slow-updating
    ///        oracles (e.g. 259200 = 3 days for Pyth XAU/USD which only publishes
    ///        during metals market hours). Capped at MAX_PRICE_STALENESS (7 days).
    function addBasketToken(
        address _token,
        uint256 _weightBps,
        address _priceFeed,
        uint8 _feedDecimals,
        uint8 _tokenDecimals,
        uint32 _maxStalenessSecs
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        if (_maxStalenessSecs > MAX_PRICE_STALENESS) revert StalenessTooHigh();
        // On chains without a sequencer feed, oracle-priced basket tokens
        // are unsafe (we can't detect an L2 sequencer outage). Allow only
        // stablecoins (priceFeed==0 ⇒ 1:1 USD path in _tokenValueUSDC).
        if (address(SEQ_UPTIME) == address(0) && _priceFeed != address(0)) {
            revert NoSequencerFeed();
        }
        basketTokens.push(TokenConfig({
            token: _token,
            targetWeightBps: _weightBps,
            priceFeed: _priceFeed,
            feedDecimals: _feedDecimals,
            tokenDecimals: _tokenDecimals,
            maxStalenessSecs: _maxStalenessSecs
        }));
        emit BasketTokenAdded(_token, _weightBps, _priceFeed);
    }

    /// @notice Update the staleness window for an existing basket token. Use
    ///         this if a feed's heartbeat changes or you want to tighten an
    ///         overly-permissive staleness that was set at add time.
    function setTokenStaleness(uint256 index, uint32 newStaleness)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newStaleness > MAX_PRICE_STALENESS) revert StalenessTooHigh();
        basketTokens[index].maxStalenessSecs = newStaleness;
    }

    function updateBasketWeight(uint256 index, uint256 newWeightBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        basketTokens[index].targetWeightBps = newWeightBps;
        emit BasketTokenWeightUpdated(index, newWeightBps);
    }

    function basketLength() external view returns (uint256) {
        return basketTokens.length;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  DEPOSIT
    // ═════════════════════════════════════════════════════════════════════

    function deposit(uint256 amount, Tier tier)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 posId)
    {
        if (whitelistEnabled && !whitelisted[msg.sender]) revert NotWhitelisted();
        if (amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) revert InvalidAmount();

        lastDepositTime[msg.sender] = block.timestamp;
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 basketAmount = (amount * basketBps) / BPS;
        uint256 yieldAmount = amount - basketAmount;

        // Yield leg: deposit immediately into adapter.
        if (yieldAmount > 0) {
            yieldAdapter.deposit(yieldAmount);
        }

        // Multiplier & lock
        uint256 multiplier = _getMultiplier(tier);
        uint256 lockDuration = _getLockDuration(tier);
        uint256 boostedYield = (yieldAmount * multiplier) / BPS;

        // Mint wSDM share proportional to contributed basket value.
        uint256 wsdm;
        uint256 basketValue = _totalBasketValueUSDC();
        if (wsdmTotalSupply == 0 || basketValue == 0) {
            wsdm = basketAmount; // 1:1 on first deposit (6-dec scale)
        } else {
            wsdm = (basketAmount * wsdmTotalSupply) / basketValue;
        }
        wsdmTotalSupply += wsdm;

        posId = nextPosId++;
        positions[posId] = Position({
            depositor: msg.sender,
            tier: tier,
            depositAmount: amount,
            wsdmAmount: wsdm,
            yieldShare: boostedYield,
            yieldClaimed: 0,
            depositTime: block.timestamp,
            unlockTime: block.timestamp + lockDuration,
            multiplierBps: multiplier,
            loanOutstanding: 0,
            withdrawStatus: WithdrawStatus.NONE
        });

        yieldTotalShares += boostedYield;
        totalDeposited += amount;

        // Mint position NFT.
        bytes memory posData = abi.encode(
            msg.sender, uint8(tier), amount, wsdm, boostedYield,
            block.timestamp, block.timestamp + lockDuration, multiplier
        );
        if (address(positionNFT) != address(0)) {
            positionNFT.mint(msg.sender, posData);
        }

        // Hook into bonus accumulator if wired.
        if (address(bonusAccumulator) != address(0)) {
            uint256 weight = (amount * multiplier) / BPS;
            bonusAccumulator.registerPosition(posId, msg.sender, weight);
        }

        emit Deposited(posId, msg.sender, tier, amount, wsdm);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Keeper: basket buy (post-deposit) and rebalance
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Keeper spends idle vault USDC to buy a basket token via an
    ///         allowlisted swap target (0x / 1inch / Paraswap). Slippage is
    ///         bounded by `minOut` which the keeper derives off-chain from
    ///         a Chainlink oracle quote.
    function executeBuyBasket(
        address tokenOut,
        uint256 usdcAmount,
        uint256 minOut,
        address swapTarget,
        bytes calldata swapCalldata
    ) external onlyRole(KEEPER_ROLE) nonReentrant whenNotPaused {
        if (usdcAmount == 0) revert ZeroAmount();
        if (!trustedSwapTargets[swapTarget]) revert UntrustedSwapTarget();
        _requireBasketToken(tokenOut);
        _checkSequencer();

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 inBefore = USDC.balanceOf(address(this));

        USDC.forceApprove(swapTarget, usdcAmount);
        (bool ok, bytes memory ret) = swapTarget.call(swapCalldata);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        USDC.forceApprove(swapTarget, 0);

        uint256 spent = inBefore - USDC.balanceOf(address(this));
        uint256 bought = IERC20(tokenOut).balanceOf(address(this)) - outBefore;

        if (spent > usdcAmount) revert RebalanceTooBig();
        if (bought < minOut) revert SlippageExceeded();

        emit KeeperSwapExecuted(address(USDC), tokenOut, spent, bought);
    }

    /// @notice Keeper-driven rebalance: sell overweight token for underweight.
    ///         All guardrails enforced on-chain — keeper supplies calldata,
    ///         vault validates slippage and direction.
    function executeRebalance(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address swapTarget,
        bytes calldata swapCalldata
    ) external onlyRole(KEEPER_ROLE) nonReentrant whenNotPaused {
        if (amountIn == 0) revert ZeroAmount();
        if (!trustedSwapTargets[swapTarget]) revert UntrustedSwapTarget();
        _requireBasketToken(tokenIn);
        _requireBasketToken(tokenOut);
        _checkSequencer();

        // Enforce max rebalance size relative to total basket value.
        uint256 basketValueUSDC = _totalBasketValueUSDC();
        uint256 inValueUSDC = _tokenValueUSDC(tokenIn, amountIn);
        uint256 maxSize = (basketValueUSDC * maxRebalanceSizeBps) / BPS;
        if (inValueUSDC > maxSize) revert RebalanceTooBig();

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 inBefore  = IERC20(tokenIn).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(swapTarget, amountIn);
        (bool ok, bytes memory ret) = swapTarget.call(swapCalldata);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        IERC20(tokenIn).forceApprove(swapTarget, 0);

        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        uint256 bought = IERC20(tokenOut).balanceOf(address(this)) - outBefore;

        if (spent > amountIn) revert RebalanceTooBig();
        if (bought < minOut) revert SlippageExceeded();

        emit RebalanceSwap(tokenIn, tokenOut, spent, bought);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  WITHDRAW — two-step with keeper
    // ═════════════════════════════════════════════════════════════════════

    function requestWithdraw(uint256 posId) external nonReentrant whenNotPaused {
        Position storage pos = positions[posId];
        if (_positionOwner(posId) != msg.sender) revert NotPositionOwner();
        if (pos.withdrawStatus != WithdrawStatus.NONE) revert AlreadyRequested();
        if (pos.loanOutstanding != 0) revert LoanOutstanding();
        if (lastDepositTime[msg.sender] == block.timestamp) revert CooldownActive();

        bool early = (pos.tier != Tier.FLEX) && (block.timestamp < pos.unlockTime);
        uint256 baseFee = early ? earlyExitFeeBps : onTimeFeeBps;
        uint256 feeBps = _applySDMDiscount(msg.sender, baseFee);

        // Yield leg — withdraw proportional share from adapter.
        // v15.2: refuse to proceed if the adapter can't deliver ≥95% of the
        // requested amount (Silo 100% utilization case). Leaves the position
        // in NONE state so the user can retry later without losing their share.
        uint256 yieldUSDC;
        if (pos.yieldShare > 0 && yieldTotalShares > 0) {
            uint256 yieldTotal = yieldAdapter.totalAssets();
            uint256 share = (yieldTotal * pos.yieldShare) / yieldTotalShares;
            if (share > 0) {
                yieldUSDC = yieldAdapter.withdraw(share);
                // 95% recovery threshold. If the adapter under-delivers, revert
                // so the caller can retry once the underlying has liquidity.
                if (yieldUSDC * 100 < share * 95) {
                    revert AdapterPartialWithdraw(share, yieldUSDC);
                }
                yieldTotalShares -= pos.yieldShare;
            }
        }

        // Basket USDC share — pro-rata slice of idle USDC at request time.
        uint256 basketUSDCShare;
        if (wsdmTotalSupply > 0) {
            uint256 vaultUSDC = USDC.balanceOf(address(this));
            uint256 basketUSDCOnly = vaultUSDC > yieldUSDC ? vaultUSDC - yieldUSDC : 0;
            basketUSDCShare = (basketUSDCOnly * pos.wsdmAmount) / wsdmTotalSupply;
        }

        pos.withdrawStatus = WithdrawStatus.REQUESTED;
        pendingWithdraws[posId] = PendingWithdraw({
            user: msg.sender,
            usdcGathered: 0,
            yieldUSDC: yieldUSDC,
            basketUSDC: basketUSDCShare,
            feeBps: feeBps,
            requestTime: block.timestamp
        });

        // Deregister from bonus accumulator — auto-claims any pending bonuses to owner.
        if (address(bonusAccumulator) != address(0)) {
            bonusAccumulator.deregisterPosition(posId);
        }

        emit WithdrawRequested(posId, msg.sender, yieldUSDC, basketUSDCShare);
    }

    /// @notice Keeper sells a basket token for a pending withdrawal. Must
    ///         supply a `minOut` derived off-chain from a Chainlink oracle quote.
    function executeWithdrawalSwap(
        uint256 posId,
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        address swapTarget,
        bytes calldata swapCalldata
    ) external onlyRole(KEEPER_ROLE) nonReentrant {
        PendingWithdraw storage pw = pendingWithdraws[posId];
        if (pw.user == address(0)) revert NotRequested();
        if (!trustedSwapTargets[swapTarget]) revert UntrustedSwapTarget();
        _requireBasketToken(tokenIn);
        _checkSequencer();

        uint256 usdcBefore = USDC.balanceOf(address(this));
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(swapTarget, amountIn);
        (bool ok, bytes memory ret) = swapTarget.call(swapCalldata);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        IERC20(tokenIn).forceApprove(swapTarget, 0);

        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        uint256 usdcReceived = USDC.balanceOf(address(this)) - usdcBefore;

        if (spent > amountIn) revert RebalanceTooBig();
        if (usdcReceived < minOut) revert SlippageExceeded();

        pw.usdcGathered += usdcReceived;
        emit KeeperSwapExecuted(tokenIn, address(USDC), spent, usdcReceived);
    }

    /// @notice Complete the withdrawal once the basket leg is sold. Keeper can
    ///         call at any time; the user can call after `withdrawTimeout`.
    function completeWithdraw(uint256 posId) external nonReentrant {
        Position storage pos = positions[posId];
        PendingWithdraw storage pw = pendingWithdraws[posId];
        if (pos.withdrawStatus != WithdrawStatus.REQUESTED) revert NotRequested();

        bool isKeeper = hasRole(KEEPER_ROLE, msg.sender);
        bool isUser = (msg.sender == pw.user);
        bool timedOut = (block.timestamp >= pw.requestTime + withdrawTimeout);
        if (!isKeeper && !(isUser && timedOut)) revert WithdrawNotReady();

        // Burn basket share.
        wsdmTotalSupply -= pos.wsdmAmount;
        pos.withdrawStatus = WithdrawStatus.COMPLETED;

        uint256 total = pw.usdcGathered + pw.yieldUSDC + pw.basketUSDC;
        uint256 fee = (total * pw.feeBps) / BPS;
        uint256 payout = total - fee;

        if (fee > 0) {
            totalFeesCollected += fee;
            USDC.safeTransfer(treasury, fee);
        }
        if (payout > 0) {
            USDC.safeTransfer(pw.user, payout);
        }

        emit WithdrawCompleted(posId, pw.user, payout, fee);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  YIELD — FLEX claim / compound / keeper harvest
    // ═════════════════════════════════════════════════════════════════════

    function claimYield(uint256 posId) external nonReentrant {
        Position storage pos = positions[posId];
        if (_positionOwner(posId) != msg.sender) revert NotPositionOwner();
        if (pos.tier != Tier.FLEX) revert InvalidTier();
        if (pos.withdrawStatus != WithdrawStatus.NONE) revert AlreadyWithdrawn();

        uint256 available = _availableYield(pos);
        if (available < MIN_CLAIM) revert BelowMinClaim();

        uint256 received = yieldAdapter.withdraw(available);
        uint256 protocolFee = (received * protocolYieldFeeBps) / BPS;
        uint256 userAmount = received - protocolFee;

        if (protocolFee > 0) {
            USDC.safeTransfer(treasury, protocolFee);
            totalFeesCollected += protocolFee;
        }
        USDC.safeTransfer(msg.sender, userAmount);
        pos.yieldClaimed += received;

        emit YieldClaimed(posId, msg.sender, userAmount);
    }

    function compoundYield(uint256 posId) external nonReentrant {
        Position storage pos = positions[posId];
        if (_positionOwner(posId) != msg.sender) revert NotPositionOwner();
        if (pos.tier != Tier.FLEX) revert InvalidTier();
        if (pos.withdrawStatus != WithdrawStatus.NONE) revert AlreadyWithdrawn();

        uint256 available = _availableYield(pos);
        if (available < MIN_CLAIM) revert BelowMinClaim();

        uint256 received = yieldAdapter.withdraw(available);
        uint256 protocolFee = (received * protocolYieldFeeBps) / BPS;
        uint256 compoundAmount = received - protocolFee;

        if (protocolFee > 0) {
            USDC.safeTransfer(treasury, protocolFee);
            totalFeesCollected += protocolFee;
        }

        // Mint additional wSDM for the compounded USDC (stays in vault for keeper to buy basket).
        uint256 basketValue = _totalBasketValueUSDC();
        uint256 newWsdm;
        if (wsdmTotalSupply == 0 || basketValue == 0) {
            newWsdm = compoundAmount;
        } else {
            newWsdm = (compoundAmount * wsdmTotalSupply) / basketValue;
        }
        wsdmTotalSupply += newWsdm;
        pos.wsdmAmount += newWsdm;
        pos.yieldClaimed += received;

        emit YieldCompounded(posId, compoundAmount, newWsdm);
    }

    /// @notice Keeper harvests adapter yield. Adapter returns USDC profit
    ///         directly to this vault, which routes protocol fee and
    ///         redeposits the rest.
    function harvestYield() external onlyRole(KEEPER_ROLE) nonReentrant {
        uint256 balBefore = USDC.balanceOf(address(this));
        uint256 profit = yieldAdapter.harvest();
        // Sanity-check: adapter should have pushed exactly `profit` USDC.
        if (profit == 0 || USDC.balanceOf(address(this)) - balBefore < profit) return;

        uint256 protocolFee = (profit * protocolYieldFeeBps) / BPS;
        uint256 reinvest = profit - protocolFee;

        if (protocolFee > 0) {
            USDC.safeTransfer(treasury, protocolFee);
            totalFeesCollected += protocolFee;
        }
        if (reinvest > 0) {
            yieldAdapter.deposit(reinvest);
        }

        totalYieldHarvested += profit;
        emit YieldHarvested(profit, protocolFee);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  VIEWS
    // ═════════════════════════════════════════════════════════════════════

    function getTokenValueUSDC(uint256 index) public view returns (uint256) {
        TokenConfig storage tc = basketTokens[index];
        uint256 bal = IERC20(tc.token).balanceOf(address(this));
        if (bal == 0) return 0;
        return _tokenValueUSDC(tc.token, bal);
    }

    function getBasketDrift() external view returns (
        address[] memory tokens,
        uint256[] memory currentBps,
        uint256[] memory targetBps,
        int256[] memory driftBps
    ) {
        uint256 n = basketTokens.length;
        tokens = new address[](n);
        currentBps = new uint256[](n);
        targetBps = new uint256[](n);
        driftBps = new int256[](n);

        // Always populate the target/address fields so callers can still see
        // the basket layout even when the vault is empty.
        for (uint256 i; i < n; i++) {
            tokens[i] = basketTokens[i].token;
            targetBps[i] = basketTokens[i].targetWeightBps;
        }

        uint256 totalValue = _totalBasketValueUSDC();
        if (totalValue == 0) return (tokens, currentBps, targetBps, driftBps);

        for (uint256 i; i < n; i++) {
            uint256 val = getTokenValueUSDC(i);
            currentBps[i] = (val * BPS) / totalValue;
            driftBps[i] = int256(currentBps[i]) - int256(targetBps[i]);
        }
    }

    function estimatePositionValue(uint256 posId)
        external
        view
        returns (uint256 basketVal, uint256 yieldVal, uint256 total)
    {
        Position storage pos = positions[posId];
        if (pos.withdrawStatus == WithdrawStatus.COMPLETED) return (0, 0, 0);

        uint256 bv = _totalBasketValueUSDC();
        if (wsdmTotalSupply > 0) {
            basketVal = (bv * pos.wsdmAmount) / wsdmTotalSupply;
        }
        if (yieldTotalShares > 0) {
            uint256 yt = yieldAdapter.totalAssets();
            yieldVal = (yt * pos.yieldShare) / yieldTotalShares;
        }
        total = basketVal + yieldVal;
    }

    function totalBasketValue() external view returns (uint256) {
        return _totalBasketValueUSDC();
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Admin
    // ═════════════════════════════════════════════════════════════════════

    function setPositionNFT(address nft) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (nft == address(0)) revert ZeroAddress();
        positionNFT = IShadowPositionNFT(nft);
        emit PositionNFTSet(nft);
    }

    function setBonusAccumulator(address accumulator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bonusAccumulator = IBonusAccumulator(accumulator); // address(0) allowed = disabled
        emit BonusAccumulatorSet(accumulator);
    }

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setSDMToken(address _sdm) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sdmToken = _sdm;
    }

    function setSDMDiscount(uint256 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sdmDiscountBps = _bps;
    }

    function setSDMThreshold(uint256 _t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sdmThreshold = _t;
    }

    function setAllocation(uint256 _basketBps, uint256 _yieldBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_basketBps + _yieldBps != BPS) revert WeightsMismatch();
        basketBps = _basketBps;
        yieldBps = _yieldBps;
    }

    function setFees(uint256 _early, uint256 _onTime, uint256 _yieldFee)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        earlyExitFeeBps = _early;
        onTimeFeeBps = _onTime;
        protocolYieldFeeBps = _yieldFee;
    }

    function setWithdrawTimeout(uint256 _t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        withdrawTimeout = _t;
    }

    function setRebalanceSlippage(uint256 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        rebalanceSlippageBps = _bps;
    }

    function setMaxRebalanceSize(uint256 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxRebalanceSizeBps = _bps;
    }

    function setTrustedSwapTarget(address target, bool trusted)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        trustedSwapTargets[target] = trusted;
        emit SwapTargetSet(target, trusted);
    }

    // ───────── Whitelist ─────────

    function setWhitelistEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelistEnabled = enabled;
        emit WhitelistEnabledSet(enabled);
    }

    function setWhitelist(address account, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelisted[account] = status;
        emit WhitelistSet(account, status);
    }

    function setWhitelistBatch(address[] calldata accounts, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i; i < accounts.length; i++) {
            whitelisted[accounts[i]] = status;
            emit WhitelistSet(accounts[i], status);
        }
    }

    // ───────── Pause ─────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Admin-only force withdrawal for positions created before the NFT
    ///         was wired. Uses `positions[posId].depositor` directly instead of
    ///         `positionNFT.ownerOf()`, which reverts for unminted tokenIds.
    ///         Performs the full request+complete flow in one tx, paying out to
    ///         the original depositor. Only works on NONE-status positions.
    function adminForceWithdraw(uint256 posId)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        Position storage pos = positions[posId];
        address depositor = pos.depositor;
        if (depositor == address(0)) revert ZeroAddress();
        if (pos.withdrawStatus != WithdrawStatus.NONE) revert AlreadyRequested();

        // Yield leg
        uint256 yieldUSDC;
        if (pos.yieldShare > 0 && yieldTotalShares > 0) {
            uint256 yieldTotal = yieldAdapter.totalAssets();
            uint256 share = (yieldTotal * pos.yieldShare) / yieldTotalShares;
            if (share > 0) {
                yieldUSDC = yieldAdapter.withdraw(share);
                yieldTotalShares -= pos.yieldShare;
            }
        }

        // Basket USDC share
        uint256 basketUSDCShare;
        if (wsdmTotalSupply > 0) {
            uint256 vaultUSDC = USDC.balanceOf(address(this));
            uint256 basketUSDCOnly = vaultUSDC > yieldUSDC ? vaultUSDC - yieldUSDC : 0;
            basketUSDCShare = (basketUSDCOnly * pos.wsdmAmount) / wsdmTotalSupply;
        }

        // Burn basket share
        wsdmTotalSupply -= pos.wsdmAmount;
        pos.withdrawStatus = WithdrawStatus.COMPLETED;

        // Fee (on-time since admin is forcing)
        uint256 total = yieldUSDC + basketUSDCShare;
        uint256 fee = (total * onTimeFeeBps) / BPS;
        uint256 payout = total - fee;

        if (fee > 0) {
            totalFeesCollected += fee;
            USDC.safeTransfer(treasury, fee);
        }
        if (payout > 0) {
            USDC.safeTransfer(depositor, payout);
        }

        // Deregister from bonus accumulator if wired
        if (address(bonusAccumulator) != address(0)) {
            try bonusAccumulator.deregisterPosition(posId) {} catch {}
        }

        emit WithdrawCompleted(posId, depositor, payout, fee);
    }

    /// @notice Rescue stuck token. Cannot rescue USDC (handled via normal flow)
    ///         or any basket token (would break pro-rata math).
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(USDC)) revert NotBasketToken();
        for (uint256 i; i < basketTokens.length; i++) {
            if (basketTokens[i].token == token) revert NotBasketToken();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Internal
    // ═════════════════════════════════════════════════════════════════════

    function _totalBasketValueUSDC() internal view returns (uint256 total) {
        bool usdcInBasket;
        for (uint256 i; i < basketTokens.length; i++) {
            if (basketTokens[i].token == address(USDC)) {
                usdcInBasket = true;
            }
            total += getTokenValueUSDC(i);
        }
        // Only add idle USDC if it's NOT already tracked as a basket token.
        // Otherwise the token loop above already counts the vault's USDC.
        if (!usdcInBasket) {
            total += USDC.balanceOf(address(this));
        }
    }

    /// @dev Compute USDC value of an arbitrary amount of a basket token.
    function _tokenValueUSDC(address token, uint256 amount) internal view returns (uint256) {
        TokenConfig memory tc = _getBasketToken(token);
        if (amount == 0) return 0;

        if (tc.priceFeed == address(0)) {
            // Stablecoin: 1:1 with USD.
            return (amount * 1e6) / (10 ** tc.tokenDecimals);
        }

        (, int256 price, , uint256 updatedAt, ) = AggregatorV3(tc.priceFeed).latestRoundData();
        if (price <= 0) return 0;

        // Per-token staleness with a global default when unset.
        uint256 allowedStaleness = tc.maxStalenessSecs == 0
            ? DEFAULT_PRICE_STALENESS
            : tc.maxStalenessSecs;
        if (block.timestamp - updatedAt > allowedStaleness) revert StalePrice();

        // amount [tokDec] * price [feedDec] → usdc [6-dec]
        // = amount * price / 10^(tokDec + feedDec - 6)
        uint256 divisor = 10 ** (uint256(tc.tokenDecimals) + uint256(tc.feedDecimals) - 6);
        return (amount * uint256(price)) / divisor;
    }

    function _getBasketToken(address token) internal view returns (TokenConfig memory) {
        for (uint256 i; i < basketTokens.length; i++) {
            if (basketTokens[i].token == token) return basketTokens[i];
        }
        revert NotBasketToken();
    }

    function _requireBasketToken(address token) internal view {
        for (uint256 i; i < basketTokens.length; i++) {
            if (basketTokens[i].token == token) return;
        }
        revert NotBasketToken();
    }

    function _availableYield(Position storage pos) internal view returns (uint256) {
        if (yieldTotalShares == 0) return 0;
        uint256 yieldTotal = yieldAdapter.totalAssets();
        uint256 grossShare = (yieldTotal * pos.yieldShare) / yieldTotalShares;
        uint256 original = (pos.depositAmount * yieldBps) / BPS;
        uint256 base = original + pos.yieldClaimed;
        return grossShare > base ? grossShare - base : 0;
    }

    function _getMultiplier(Tier t) internal pure returns (uint256) {
        if (t == Tier.FLEX) return 10_000;
        if (t == Tier.THIRTY) return 12_000;
        if (t == Tier.NINETY) return 15_000;
        if (t == Tier.ONEIGHTY) return 20_000;
        return 30_000; // YEAR
    }

    function _getLockDuration(Tier t) internal pure returns (uint256) {
        if (t == Tier.FLEX) return 0;
        if (t == Tier.THIRTY) return 30 days;
        if (t == Tier.NINETY) return 90 days;
        if (t == Tier.ONEIGHTY) return 180 days;
        return 365 days;
    }

    function _applySDMDiscount(address user, uint256 baseFee) internal view returns (uint256) {
        if (sdmToken == address(0)) return baseFee;
        if (IERC20(sdmToken).balanceOf(user) >= sdmThreshold) {
            return (baseFee * (BPS - sdmDiscountBps)) / BPS;
        }
        return baseFee;
    }

    function _positionOwner(uint256 posId) internal view returns (address) {
        if (address(positionNFT) == address(0)) {
            return positions[posId].depositor;
        }
        return positionNFT.ownerOf(posId);
    }

    /// @dev Check the L2 sequencer uptime feed. Reverts if the sequencer is
    ///      down or we're within the grace period after a restart. No-op on
    ///      chains without a sequencer feed (HyperEVM) — addBasketToken
    ///      rejects oracle-backed tokens in that case.
    function _checkSequencer() internal view {
        if (address(SEQ_UPTIME) == address(0)) return;
        (, int256 answer, uint256 startedAt, , ) = SEQ_UPTIME.latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (block.timestamp - startedAt < SEQ_GRACE_PERIOD) revert SequencerGracePeriod();
    }
}
