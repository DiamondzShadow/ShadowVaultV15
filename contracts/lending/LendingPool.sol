// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {DiggerRegistry} from "../marketplace/DiggerRegistry.sol";
import {INFTValuer} from "../interfaces/INFTValuer.sol";

/// @notice Read live position value from the vault that issued the NFT.
/// @dev    Retained as the legacy direct-call path when `valuer` is unset.
interface IVaultValue {
    function estimatePositionValue(uint256 posId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total);
}

/// @notice Position NFT exposes the vault that issued it. ShadowPositionNFTV15
///         exposes `vault()`. We never trust an arbitrary NFT; the value path
///         only fires for collections registered via DiggerRegistry.
interface IPositionNFTVault {
    function vault() external view returns (IVaultValue);
}

/// @notice Liquidation-time interface to the issuing vault — request the
///         unwind, then later complete it after the vault's withdraw timeout.
interface IVaultUnwind {
    function requestWithdraw(uint256 posId) external;
    function completeWithdraw(uint256 posId) external;
}

/// @notice Yield-claim interface for FLEX-tier positions. The vault sends
///         claimed USDC to the position owner — i.e., this contract while
///         the NFT is escrowed. We then split between loan repayment and
///         the borrower per their `yieldRepayBps` setting.
interface IVaultClaimYield {
    function claimYield(uint256 posId) external;
}

/// @notice Sweep controller interface — LendingPool calls `pull(amount)` to
///         drain idle USDC from sinks (Aave first, then queues remote
///         unwind for the rest). Returns USDC delivered SYNCHRONOUSLY.
interface ISweepController {
    function pull(uint256 amount) external returns (uint256 deliveredNow);
}

/// @notice EcosystemMarketplace slice — used for MARKETPLACE_AUCTION liquidation.
///         LendingPool escrows the seized NFT into the marketplace via
///         `liquidationList`, then reads the listing state at completion to
///         decide whether to apply the sale payout or unwind the liquidation.
interface IEcosystemMarketplace {
    function liquidationList(address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt)
        external returns (uint256 listingId);
    function listings(uint256 listingId)
        external view
        returns (address seller, address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt, bool active);
    function protocolFeeBps() external view returns (uint16);
}

/// @title LendingPool
/// @notice USDC borrow + supply pool collateralized by Diamondz position NFTs.
///         Supplier accounting uses the ERC4626 virtual-shares pattern (10^6
///         offset) to defeat first-depositor / donation attacks.
///
///         Key safety properties (intentional + tested):
///         - position NFT value is read from `vault.estimatePositionValue` —
///           on-chain accounting, NOT a market oracle. Cannot be sandwiched.
///         - per-collection LTV (`maxLtvBps`) and liquidation threshold are
///           read from DiggerRegistry; project teams (diggers) tune by
///           collection volatility.
///         - time locks: same-block borrow↔repay forbidden (`lastBorrowBlock`),
///           supplier hold (≥6h), borrower min loan duration (≥1h before
///           liquidation eligibility).
///         - all state-changing functions are nonReentrant + Pausable.
///         - all value reads are cached at the start of the function — no
///           re-reads mid-call (kills read-only reentrancy).
///         - totalAssets only counts realized cash + sweeped balances +
///           outstanding principal (never accrued-but-unpaid interest), so
///           supplier shares can't get inflated by phantom interest.
///
///         What's NOT in this commit (next):
///         - `liquidate()` / `completeLiquidation()` — separate file/commit.
///         - sweep into Aave / HyperEVM Pool E — separate `SweepController`.
///           Until wired, all USDC sits idle (suppliers earn interest only
///           from active borrowers).
contract LendingPool is AccessControl, ReentrancyGuard, Pausable, IERC721Receiver {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ───────── Roles ─────────
    bytes32 public constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 public constant SWEEPER_ROLE  = keccak256("SWEEPER_ROLE"); // future SweepController

    // ───────── Immutables ─────────
    IERC20 public immutable USDC;
    DiggerRegistry public immutable REGISTRY;

    // ───────── Constants ─────────
    /// @notice Virtual-shares decimals offset (anti-donation). Suppliers
    ///         deposit USDC (6-dec) so this matches USDC's decimals; the
    ///         math becomes `shares = assets × (totalSupply + 10^6) / (totalAssets + 1)`.
    uint256 public constant VIRTUAL_SHARES_OFFSET = 1_000_000;
    uint256 public constant BPS = 10_000;

    /// @notice Default annualized borrow APR if a digger sets none. 8% v1.
    uint256 public constant DEFAULT_BORROW_APR_BPS = 800;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice Cap on maxLtvBps for FOREIGN collections (defense-in-depth on
    ///         top of the registry's 80% cap). 75% = historical v1.4 cap.
    uint16 public constant ABSOLUTE_MAX_LTV_BPS = 7500; // 75% (FOREIGN)

    /// @notice Higher cap for IN_HOUSE collections (Diamondz vault-backed).
    ///         Backing is live USDC in known adapters, not speculative floor,
    ///         so 90% cap is justified (same as registry cap for in-house).
    uint16 public constant ABSOLUTE_MAX_LTV_IN_HOUSE_BPS = 9000; // 90%

    // ───────── Time locks ─────────
    /// @notice Borrowers can't have their loan liquidated within the first
    ///         `minLoanDuration` after origination (gives them a window to
    ///         react to value moves at borrow time).
    uint256 public minLoanDuration = 1 hours;
    /// @notice Suppliers can't withdraw within `minSupplyHold` of supplying
    ///         (anti-MEV on supplier share price).
    uint256 public minSupplyHold = 6 hours;

    // ───────── Interest model ─────────
    /// @notice Annualized borrow APR in bps (default; per-collection
    ///         override available via `borrowAprOverride`).
    uint256 public borrowAprBps = DEFAULT_BORROW_APR_BPS;

    /// @notice Per-collection borrow APR override (bps). 0 = use default.
    mapping(address => uint256) public borrowAprOverride;
    /// @notice Bps of paid interest that goes to the protocol reserve fund
    ///         (the rest accrues to suppliers via share-price growth).
    uint16  public protocolReserveBps = 3_000; // 30%

    /// @notice Reserve fund — accrued protocol cut of interest. Withdrawable
    ///         by admin. Acts as the first cushion against bad debt.
    uint256 public protocolReserve;

    /// @notice Liquidation cushion above maxLtv. Effective liquidation
    ///         threshold = maxLtvBps + this. 1000 = 10% buffer.
    uint16 public liquidationBufferBps = 1_000;
    /// @notice Bps of seized USDC paid as bonus to the caller of
    ///         `completeLiquidation`. 500 = 5%. Comes out of the surplus
    ///         (collateral value above the loan), never out of supplier funds.
    uint16 public liquidationBonusBps = 500;

    // ───────── Supplier accounting ─────────
    /// @notice Internal accounting only — these are NOT ERC20 transferable.
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;
    /// @notice Last block.timestamp at which `who` supplied — gates withdraw.
    mapping(address => uint256) public lastSupplyAt;

    // ───────── Borrower accounting ─────────
    enum LoanStatus { NONE, ACTIVE, LIQUIDATING, CLOSED }

    struct Loan {
        address  borrower;
        address  nft;
        uint256  tokenId;
        uint256  principal;          // current outstanding USDC
        uint256  lastAccrualTime;    // for interest accrual
        uint256  startTime;          // for minLoanDuration
        uint256  accruedFeesUnpaid;  // interest owed but not yet paid
        uint16   yieldRepayBps;      // 0..10000; share of harvested yield routed to loan
        LoanStatus status;
        /// @notice Snapshot of the vault that issued the NFT, captured at
        ///         borrow time. Used by `triggerLiquidation`, `completeLiquidation`,
        ///         and `harvestAndApply` so that admin reconfigurations of
        ///         the valuer (or swaps of the NFT's `vault()` pointer) cannot
        ///         brick liquidation of an active loan. Zero-address for
        ///         MARKETPLACE_AUCTION loans.
        address  unwindTarget;
        /// @notice MARKETPLACE_AUCTION only — listing id on EcosystemMarketplace
        ///         at trigger-liquidation time. 0 for VAULT_UNWIND loans.
        uint256  auctionListingId;
        /// @notice MARKETPLACE_AUCTION only — listing start price in USDC.
        uint256  auctionPriceUSDC;
        /// @notice Snapshot of the liquidation strategy at borrow time.
        ///         VAULT_UNWIND=0, MARKETPLACE_AUCTION=1. Matches valuer
        ///         Strategy enum. Cached so admin valuer reconfig post-borrow
        ///         can't switch a loan's liquidation path.
        uint8    liqStrategy;
    }

    uint256 public nextLoanId = 1;
    mapping(uint256 => Loan) public loans;
    /// @notice (nft, tokenId) → active loan id. 0 = none.
    mapping(address => mapping(uint256 => uint256)) public activeLoanOf;
    /// @notice block.number of last borrow per borrower — same-block repay forbidden.
    mapping(address => uint256) public lastBorrowBlock;

    /// @notice Sum of outstanding principal across all loans. Counted in
    ///         totalAssets so supplier shares reflect "money out the door".
    uint256 public totalBorrowed;

    /// @notice Optional sink for idle USDC (set by admin once SweepController
    ///         is deployed). Until set, idle USDC stays liquid in the pool.
    address public sweepSink;

    /// @notice Optional per-tokenId valuation dispatcher. When set, `valueOf`
    ///         and the liquidation unwind target both route through the
    ///         valuer, so the pool can accept multiple collateral TYPES
    ///         (vault-backed positions, floor-priced collections, static).
    ///         When 0x0, the pool falls back to the legacy direct
    ///         `IPositionNFTVault(nft).vault()` path — preserved as a
    ///         rollback switch and for backward test compatibility.
    INFTValuer public valuer;

    /// @notice EcosystemMarketplace used for MARKETPLACE_AUCTION liquidation.
    ///         Optional — can be unset (v1.3 behavior). If set, LendingPool
    ///         MUST also have `LIQUIDATOR_ROLE` on the marketplace.
    IEcosystemMarketplace public marketplace;

    /// @notice Default markdown applied to liveValue at auction-list time
    ///         (bps of liveValue). 9000 = 90% → 10% below live value. Gives
    ///         buyers an incentive to take on the seized NFT.
    uint16 public auctionStartMarkdownBps = 9_000;

    /// @notice Default expiry on liquidation listings. If the listing doesn't
    ///         sell by then, keeper can re-list at a lower price.
    uint64  public auctionExpirySec = 7 days;

    // ───────── Events ─────────
    event Supplied(address indexed user, uint256 assets, uint256 shares, uint256 totalShares, uint256 totalAssets);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares, uint256 totalShares, uint256 totalAssets);
    event Borrowed(uint256 indexed loanId, address indexed borrower, address indexed nft, uint256 tokenId, uint256 principal, uint256 collateralValue);
    event Repaid(uint256 indexed loanId, address indexed borrower, uint256 principalPaid, uint256 interestPaid, uint256 remaining);
    event LoanClosed(uint256 indexed loanId, address indexed borrower);
    event YieldRepayBpsSet(uint256 indexed loanId, uint16 oldBps, uint16 newBps);
    event YieldHarvested(uint256 indexed loanId, uint256 yieldUSDC, uint256 toLoan, uint256 toBorrower);
    event LiquidationTriggered(uint256 indexed loanId, address indexed caller, uint256 healthBps, uint256 thresholdBps);
    event LiquidationCompleted(uint256 indexed loanId, address indexed caller, uint256 vaultPayout, uint256 debtRepaid, uint256 bonus, uint256 reserveCut, uint256 surplusToBorrower, int256 badDebt);
    event ParamsUpdated(string what, uint256 value);
    event SweepSinkUpdated(address newSink);
    event ProtocolReserveWithdrawn(address to, uint256 amount);
    event ValuerUpdated(address newValuer);
    event MarketplaceUpdated(address newMarketplace);
    event AuctionParamsUpdated(uint16 startMarkdownBps, uint64 expirySec);
    event MarketplaceLiquidationTriggered(uint256 indexed loanId, uint256 listingId, uint256 priceUSDC);
    event MarketplaceLiquidationUnwound(uint256 indexed loanId); // listing cancelled / emergency-returned
    event MarketplaceLiquidationSettled(uint256 indexed loanId, uint256 payoutUSDC, uint256 debtRepaid, int256 badDebt);

    // ───────── Errors ─────────
    error ZeroAddress();
    error ZeroAmount();
    error NotERC721Owner();
    error CollectionNotAccepted(address nft);
    error CollectionNotCollateral(address nft);
    error AlreadyCollateralized(address nft, uint256 tokenId);
    error UnknownLoan();
    error NotBorrower();
    error LoanNotActive();
    error SameBlockBorrowRepay();
    error SupplyHoldActive(uint256 unlocksAt);
    error LtvExceeded(uint256 wantedBps, uint256 maxBps);
    error InsufficientLiquidity(uint256 wanted, uint256 have);
    error BadParam();
    error InvalidLtvForCollection(uint16 registry, uint16 absoluteCap);
    error NotZero();
    error LoanTooYoung(uint256 unlocksAt);
    error LoanHealthy(uint256 healthBps, uint256 thresholdBps);
    error NotLiquidating();
    error VaultPayoutInsufficient(uint256 received, uint256 expectedAtLeast);
    error UnsupportedLiquidationStrategy(address nft);
    error MarketplaceNotSet();
    error AuctionStillActive(uint256 listingId);
    error NotAuctionLiquidation(uint256 loanId);

    // ───────── Constructor ─────────
    constructor(address admin, address _usdc, address _registry) {
        if (admin == address(0) || _usdc == address(0) || _registry == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        REGISTRY = DiggerRegistry(payable(_registry));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ════════════════════════════════════════════════════════════
    //  Supplier surface (anti-donation via virtual shares)
    // ════════════════════════════════════════════════════════════

    /// @notice Convert a USDC amount → supplier shares using current pool state.
    /// @dev    Uses OZ ERC4626 virtual-offset pattern: rounding-down + (offset+1)
    ///         denominator means a 0-share grift requires the attacker to
    ///         donate 10^6× the victim's deposit.
    function previewSupply(uint256 assets) public view returns (uint256) {
        return assets.mulDiv(totalShares + VIRTUAL_SHARES_OFFSET, totalAssets() + 1, Math.Rounding.Floor);
    }

    /// @notice Convert supplier shares → claimable USDC (current snapshot).
    function previewWithdraw(uint256 shares) public view returns (uint256) {
        return shares.mulDiv(totalAssets() + 1, totalShares + VIRTUAL_SHARES_OFFSET, Math.Rounding.Floor);
    }

    /// @notice Total USDC the pool considers itself worth — idle + sweeped + outstanding loan principal.
    /// @dev    Does NOT include accrued-but-unpaid interest. Phantom interest
    ///         in totalAssets would let suppliers extract value before
    ///         realization and could be drained by repayment-front-running.
    function totalAssets() public view returns (uint256) {
        // sweeped balance lookup happens via the sweepSink contract; for v1
        // (sink unset) it's just IERC20.balanceOf (idle) + totalBorrowed.
        return USDC.balanceOf(address(this)) + totalBorrowed;
    }

    function supply(uint256 assets) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        // CHECKS
        shares = previewSupply(assets);
        if (shares == 0) revert ZeroAmount(); // post-virtual-offset round-down floor
        // EFFECTS
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        lastSupplyAt[msg.sender] = block.timestamp;
        // INTERACTIONS
        USDC.safeTransferFrom(msg.sender, address(this), assets);
        emit Supplied(msg.sender, assets, shares, totalShares, totalAssets());
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shares > sharesOf[msg.sender]) revert ZeroAmount();
        // Time-lock
        uint256 unlocksAt = lastSupplyAt[msg.sender] + minSupplyHold;
        if (block.timestamp < unlocksAt) revert SupplyHoldActive(unlocksAt);

        assets = previewWithdraw(shares);
        if (assets == 0) revert ZeroAmount();

        uint256 idle = USDC.balanceOf(address(this));
        // Auto-pull from sweep on supplier withdraw too — same pattern.
        if (assets > idle && sweepSink != address(0)) {
            uint256 stillNeed = assets - idle;
            ISweepController(sweepSink).pull(stillNeed);
            idle = USDC.balanceOf(address(this));
        }
        if (assets > idle) revert InsufficientLiquidity(assets, idle);

        // EFFECTS
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        // INTERACTIONS
        USDC.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares, totalShares, totalAssets());
    }

    // ════════════════════════════════════════════════════════════
    //  Borrower surface
    // ════════════════════════════════════════════════════════════

    /// @notice Live USD value of a position NFT — uses the NFTValuer
    ///         dispatcher when configured (supports vault-backed, floor-oracle,
    ///         and static-priced collections), otherwise falls back to the
    ///         legacy direct vault call. Value reads are on-chain accounting,
    ///         NOT a market oracle — cannot be sandwiched.
    function valueOf(address nft, uint256 tokenId) public view returns (uint256) {
        // Defensive: only fire for accepted collections to avoid arbitrary
        // contract calls that could revert / consume gas.
        (, , , bool accepted, ) = REGISTRY.collections(nft);
        if (!accepted) return 0;
        if (address(valuer) != address(0)) {
            return valuer.liveValue(nft, tokenId);
        }
        IVaultValue v = IPositionNFTVault(nft).vault();
        (, , uint256 total) = v.estimatePositionValue(tokenId);
        return total;
    }

    /// @notice Resolve the unwind target for a position NFT at borrow time.
    ///         Called ONCE when a loan is opened; the result is snapshotted
    ///         into `Loan.unwindTarget` and never re-resolved. Post-borrow
    ///         admin reconfigurations of the valuer (mode change, clear,
    ///         swap) cannot alter an active loan's liquidation path.
    function _resolveUnwindTarget(address nft) internal view returns (address) {
        if (address(valuer) != address(0)) {
            return valuer.vaultFor(nft);
        }
        return address(IPositionNFTVault(nft).vault());
    }

    /// @notice Effective max LTV for a collection (capped at ABSOLUTE_MAX_LTV_BPS).
    function maxLtvFor(address nft) public view returns (uint16) {
        (, , uint16 maxLtv, bool accepted, DiggerRegistry.CollectionClass cls) = REGISTRY.collections(nft);
        if (!accepted) return 0;
        uint16 cap = cls == DiggerRegistry.CollectionClass.IN_HOUSE
            ? ABSOLUTE_MAX_LTV_IN_HOUSE_BPS
            : ABSOLUTE_MAX_LTV_BPS;
        return maxLtv > cap ? cap : maxLtv;
    }

    /// @notice Liquidation threshold = maxLtv + buffer. Loan/value above this
    ///         → liquidation eligible (after `minLoanDuration` elapsed).
    function liquidationThresholdFor(address nft) public view returns (uint16) {
        uint16 maxLtv = maxLtvFor(nft);
        uint16 t = maxLtv + liquidationBufferBps;
        return t > BPS ? uint16(BPS) : t;
    }

    /// @notice Borrow USDC against a position NFT. Caller must own the NFT
    ///         and have approved this contract for it.
    function borrow(address nft, uint256 tokenId, uint256 borrowAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        if (borrowAmount == 0) revert ZeroAmount();

        // Cache reads
        bool listable = REGISTRY.isCollateral(nft);
        if (!listable) revert CollectionNotCollateral(nft);
        if (activeLoanOf[nft][tokenId] != 0) revert AlreadyCollateralized(nft, tokenId);
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotERC721Owner();

        // v1.4: borrow against any strategy the valuer supports.
        //   - VAULT_UNWIND        → liquidation via vault.requestWithdraw
        //   - MARKETPLACE_AUCTION → liquidation via marketplace.liquidationList
        //   Marketplace-backed strategy requires the marketplace wire; reject
        //   at borrow time if missing so liquidation can't brick later.
        INFTValuer.Strategy strat = INFTValuer.Strategy.VAULT_UNWIND; // default if no valuer
        if (address(valuer) != address(0)) {
            strat = valuer.strategy(nft);
            if (strat == INFTValuer.Strategy.MARKETPLACE_AUCTION && address(marketplace) == address(0)) {
                revert MarketplaceNotSet();
            }
        }

        uint256 value = valueOf(nft, tokenId);
        if (value == 0) revert ZeroAmount();
        uint16 ltvCap = maxLtvFor(nft);
        uint256 ltvBps = (borrowAmount * BPS) / value;
        if (ltvBps > ltvCap) revert LtvExceeded(ltvBps, ltvCap);

        uint256 idle = USDC.balanceOf(address(this));
        // Auto-pull from sweep if idle is short — pulls Aave first (sync),
        // then queues remote unwind (async — won't help this tx).
        if (borrowAmount > idle && sweepSink != address(0)) {
            uint256 stillNeed = borrowAmount - idle;
            ISweepController(sweepSink).pull(stillNeed);
            idle = USDC.balanceOf(address(this));
        }
        if (borrowAmount > idle) revert InsufficientLiquidity(borrowAmount, idle);

        // Snapshot the unwind target NOW so that admin reconfigurations of
        // the valuer post-borrow cannot brick liquidation of this loan.
        // For MARKETPLACE_AUCTION strategy there is no vault to unwind —
        // unwindTarget stays 0 and liquidation goes through the marketplace.
        address unwindTarget = address(0);
        if (strat == INFTValuer.Strategy.VAULT_UNWIND) {
            unwindTarget = _resolveUnwindTarget(nft);
        }

        // EFFECTS
        loanId = nextLoanId++;
        loans[loanId] = Loan({
            borrower: msg.sender,
            nft: nft,
            tokenId: tokenId,
            principal: borrowAmount,
            lastAccrualTime: block.timestamp,
            startTime: block.timestamp,
            accruedFeesUnpaid: 0,
            yieldRepayBps: 0,    // borrower opts in via setYieldRepayBps
            status: LoanStatus.ACTIVE,
            unwindTarget: unwindTarget,
            auctionListingId: 0,
            auctionPriceUSDC: 0,
            liqStrategy: uint8(strat)
        });
        activeLoanOf[nft][tokenId] = loanId;
        totalBorrowed += borrowAmount;
        lastBorrowBlock[msg.sender] = block.number;

        // INTERACTIONS — escrow the NFT, then send USDC.
        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        USDC.safeTransfer(msg.sender, borrowAmount);

        emit Borrowed(loanId, msg.sender, nft, tokenId, borrowAmount, value);
    }

    /// @notice Repay (full or partial). Updates accrued interest first.
    ///         Closes the loan when principal + interest reaches zero, returns NFT.
    function repay(uint256 loanId, uint256 amount) external nonReentrant returns (uint256 paidPrincipal, uint256 paidInterest) {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.ACTIVE) revert LoanNotActive();
        if (msg.sender != l.borrower) revert NotBorrower();
        if (lastBorrowBlock[msg.sender] == block.number) revert SameBlockBorrowRepay();
        if (amount == 0) revert ZeroAmount();

        _accrueInterest(l);

        // Pay interest first (cleaner accounting), then principal.
        uint256 toInterest = amount > l.accruedFeesUnpaid ? l.accruedFeesUnpaid : amount;
        uint256 toPrincipal = amount - toInterest;
        if (toPrincipal > l.principal) toPrincipal = l.principal;

        uint256 totalPay = toInterest + toPrincipal;
        if (totalPay == 0) revert ZeroAmount();

        // EFFECTS
        l.accruedFeesUnpaid -= toInterest;
        l.principal -= toPrincipal;
        totalBorrowed -= toPrincipal;

        // Split interest: protocol reserve cut, rest stays in pool boosting share price.
        uint256 toReserve = (toInterest * protocolReserveBps) / BPS;
        protocolReserve += toReserve;
        // (the remainder stays in the pool naturally as USDC sits in our balance)

        // INTERACTIONS
        USDC.safeTransferFrom(msg.sender, address(this), totalPay);
        emit Repaid(loanId, msg.sender, toPrincipal, toInterest, l.principal + l.accruedFeesUnpaid);

        // Loan fully closed?
        if (l.principal == 0 && l.accruedFeesUnpaid == 0) {
            _closeLoan(loanId, l);
        }

        return (toPrincipal, toInterest);
    }

    /// @notice Public view of a loan's current debt (principal + accrued interest).
    function debtOf(uint256 loanId) public view returns (uint256) {
        Loan storage l = loans[loanId];
        if (l.status == LoanStatus.NONE || l.status == LoanStatus.CLOSED) return 0;
        return l.principal + l.accruedFeesUnpaid + _pendingInterest(l);
    }

    /// @notice Health factor = (loan + accrued + pending) / collateralValue, in bps.
    function loanHealthBps(uint256 loanId) external view returns (uint256) {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.ACTIVE) return 0;
        uint256 v = valueOf(l.nft, l.tokenId);
        if (v == 0) return type(uint256).max;
        return (debtOf(loanId) * BPS) / v;
    }

    /// @notice Effective APR for a collection (override if set, else default).
    function aprFor(address nft) public view returns (uint256) {
        uint256 o = borrowAprOverride[nft];
        return o == 0 ? borrowAprBps : o;
    }

    function _accrueInterest(Loan storage l) internal {
        uint256 dt = block.timestamp - l.lastAccrualTime;
        if (dt == 0 || l.principal == 0) {
            l.lastAccrualTime = block.timestamp;
            return;
        }
        uint256 apr = aprFor(l.nft);
        uint256 owed = (l.principal * apr * dt) / (SECONDS_PER_YEAR * BPS);
        if (owed > 0) l.accruedFeesUnpaid += owed;
        l.lastAccrualTime = block.timestamp;
    }

    function _pendingInterest(Loan storage l) internal view returns (uint256) {
        uint256 dt = block.timestamp - l.lastAccrualTime;
        if (dt == 0 || l.principal == 0) return 0;
        uint256 apr = aprFor(l.nft);
        return (l.principal * apr * dt) / (SECONDS_PER_YEAR * BPS);
    }

    function _closeLoan(uint256 loanId, Loan storage l) internal {
        l.status = LoanStatus.CLOSED;
        activeLoanOf[l.nft][l.tokenId] = 0;
        // Return NFT to borrower.
        IERC721(l.nft).safeTransferFrom(address(this), l.borrower, l.tokenId);
        emit LoanClosed(loanId, l.borrower);
    }

    // ════════════════════════════════════════════════════════════
    //  Yield-to-loan auto-repay
    // ════════════════════════════════════════════════════════════

    /// @notice Borrower configures what fraction of harvested yield should
    ///         apply to loan repayment. 0 = none (default — borrower keeps
    ///         all yield, pays loan manually). 10000 = 100% (yield fully
    ///         services the loan; borrower gets nothing until paid off).
    /// @dev Only valid for FLEX-tier positions (the underlying vault gates
    ///      `claimYield` on tier). Non-FLEX positions can still call this,
    ///      but `harvestAndApply` will revert at vault layer.
    function setYieldRepayBps(uint256 loanId, uint16 newBps) external {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.ACTIVE) revert LoanNotActive();
        if (msg.sender != l.borrower) revert NotBorrower();
        if (newBps > BPS) revert BadParam();
        uint16 old = l.yieldRepayBps;
        l.yieldRepayBps = newBps;
        emit YieldRepayBpsSet(loanId, old, newBps);
    }

    /// @notice Anyone can call this to harvest accrued yield from the
    ///         escrowed position. Calls `vault.claimYield(tokenId)` (FLEX
    ///         only — vault reverts on other tiers). Splits the received
    ///         USDC per `yieldRepayBps`:
    ///           - portion-to-loan: paid against accrued interest first,
    ///             then principal, with the protocol reserve cut applied
    ///             on the interest piece.
    ///           - portion-to-borrower: sent directly to the borrower.
    ///         Open to anyone so a keeper can run it on a schedule, but no
    ///         caller incentive — keepers run because *they* benefit
    ///         elsewhere (e.g., they're suppliers).
    function harvestAndApply(uint256 loanId) external nonReentrant returns (uint256 yieldReceived, uint256 toLoan, uint256 toBorrower) {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.ACTIVE) revert LoanNotActive();

        _accrueInterest(l);

        uint256 balBefore = USDC.balanceOf(address(this));
        IVaultClaimYield(l.unwindTarget).claimYield(l.tokenId);
        yieldReceived = USDC.balanceOf(address(this)) - balBefore;
        if (yieldReceived == 0) return (0, 0, 0);

        toLoan = (yieldReceived * l.yieldRepayBps) / BPS;
        toBorrower = yieldReceived - toLoan;

        if (toLoan > 0) {
            // Apply to interest first, then principal — same accounting as repay().
            uint256 toInterest = toLoan > l.accruedFeesUnpaid ? l.accruedFeesUnpaid : toLoan;
            uint256 toPrincipal = toLoan - toInterest;
            if (toPrincipal > l.principal) toPrincipal = l.principal;
            l.accruedFeesUnpaid -= toInterest;
            l.principal -= toPrincipal;
            totalBorrowed -= toPrincipal;

            // Reserve cut on the interest portion (same split as cash repay).
            uint256 toReserve = (toInterest * protocolReserveBps) / BPS;
            protocolReserve += toReserve;

            emit Repaid(loanId, l.borrower, toPrincipal, toInterest, l.principal + l.accruedFeesUnpaid);

            // If the over-pay zeroed the loan, dust may remain — refund to borrower.
            uint256 actualToLoan = toInterest + toPrincipal;
            if (actualToLoan < toLoan) {
                toBorrower += (toLoan - actualToLoan);
                toLoan = actualToLoan;
            }
        }

        if (toBorrower > 0) {
            USDC.safeTransfer(l.borrower, toBorrower);
        }

        emit YieldHarvested(loanId, yieldReceived, toLoan, toBorrower);

        if (l.principal == 0 && l.accruedFeesUnpaid == 0) {
            _closeLoan(loanId, l);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Liquidation (two-step: trigger → vault settle → complete)
    // ════════════════════════════════════════════════════════════

    /// @notice Anyone can trigger liquidation when:
    ///         1. minLoanDuration has elapsed since loan origination, AND
    ///         2. loan health (debt/value) exceeds liquidationThreshold for
    ///            the collateral's collection.
    ///
    ///         Action: marks loan LIQUIDATING and calls vault.requestWithdraw
    ///         on the escrowed NFT. The vault's withdraw timeout (~30 min on
    ///         V15 vaults) must elapse before `completeLiquidation` can pay
    ///         out the surplus + bonus.
    function triggerLiquidation(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.ACTIVE) revert LoanNotActive();

        uint256 unlocksAt = l.startTime + minLoanDuration;
        if (block.timestamp < unlocksAt) revert LoanTooYoung(unlocksAt);

        // Cache reads
        _accrueInterest(l);
        uint256 v = valueOf(l.nft, l.tokenId);
        if (v == 0) {
            // Valuer may have been reconfigured / cleared mid-loan. Fall
            // back to reading the snapshotted unwind target directly so
            // liquidation of an active loan cannot be bricked by admin
            // action on the valuer after origination.
            (, , v) = IVaultValue(l.unwindTarget).estimatePositionValue(l.tokenId);
        }
        if (v == 0) revert ZeroAmount();
        uint256 debt = l.principal + l.accruedFeesUnpaid;
        uint256 healthBps = (debt * BPS) / v;
        uint256 thresholdBps = liquidationThresholdFor(l.nft);
        if (healthBps <= thresholdBps) revert LoanHealthy(healthBps, thresholdBps);

        // EFFECTS
        l.status = LoanStatus.LIQUIDATING;

        // INTERACTION — branch on the strategy snapshotted at borrow time.
        if (l.liqStrategy == uint8(INFTValuer.Strategy.VAULT_UNWIND)) {
            // Vault unwind path (V15 Pool NFTs). Request unwind; the vault
            // will release USDC on completeLiquidation after its delay.
            IVaultUnwind(l.unwindTarget).requestWithdraw(l.tokenId);
            emit LiquidationTriggered(loanId, msg.sender, healthBps, thresholdBps);
        } else {
            // MARKETPLACE_AUCTION path (wrappers, floor-priced NFTs).
            // Escrow NFT into the marketplace + open a liquidation listing.
            if (address(marketplace) == address(0)) revert MarketplaceNotSet();
            uint256 priceUSDC = (v * auctionStartMarkdownBps) / BPS;
            IERC721(l.nft).safeTransferFrom(address(this), address(marketplace), l.tokenId);
            uint256 listingId = marketplace.liquidationList(
                l.nft, l.tokenId, priceUSDC, uint64(block.timestamp) + auctionExpirySec
            );
            l.auctionListingId = listingId;
            l.auctionPriceUSDC = priceUSDC;
            emit LiquidationTriggered(loanId, msg.sender, healthBps, thresholdBps);
            emit MarketplaceLiquidationTriggered(loanId, listingId, priceUSDC);
        }
    }

    /// @notice Anyone can call once the issuing vault has settled the
    ///         requested withdraw. Pulls the resulting USDC payout from the
    ///         vault and:
    ///           1. Repays the loan principal + accrued interest (split per
    ///              `protocolReserveBps`).
    ///           2. Pays a 5% liquidation bonus to `msg.sender` from the surplus.
    ///           3. Returns any remaining surplus to the borrower.
    ///
    ///         If the payout is below the loan debt (bad debt), the protocol
    ///         reserve absorbs the gap; if reserve insufficient, supplier
    ///         shares lose value. The shortfall is recorded in the event.
    function completeLiquidation(uint256 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.LIQUIDATING) revert NotLiquidating();
        // Vault-unwind-only flow. MARKETPLACE_AUCTION loans settle via
        // `completeMarketplaceLiquidation`.
        if (l.liqStrategy != uint8(INFTValuer.Strategy.VAULT_UNWIND)) {
            revert NotAuctionLiquidation(loanId);
        }

        // _accrueInterest one more time so the debt-at-completion reflects
        // the full elapsed time (vault's withdraw delay).
        _accrueInterest(l);

        uint256 debt = l.principal + l.accruedFeesUnpaid;

        // Snapshot pool USDC before pulling from vault so we can measure
        // exactly what the vault delivered (no race / reentrancy concerns
        // since we hold nonReentrant and the vault is trusted).
        uint256 balBefore = USDC.balanceOf(address(this));

        // INTERACTION — pull the unwind. Vault transfers USDC to msg.sender
        // of the original requestWithdraw — which was THIS contract.
        IVaultUnwind(l.unwindTarget).completeWithdraw(l.tokenId);

        uint256 payout = USDC.balanceOf(address(this)) - balBefore;

        // EFFECTS — split the payout
        uint256 toReserve;
        uint256 toCallerBonus;
        uint256 toBorrowerSurplus;
        int256 badDebt;
        uint256 effectiveDebtRepaid;

        if (payout >= debt) {
            // Healthy unwind. Pay debt + interest split + bonus from surplus.
            effectiveDebtRepaid = debt;
            uint256 surplus = payout - debt;

            // Interest portion split: protocol cut to reserve.
            toReserve = (l.accruedFeesUnpaid * protocolReserveBps) / BPS;
            protocolReserve += toReserve;
            // (rest stays in pool naturally — supplier share value grows)

            // Liquidator bonus comes from the surplus.
            toCallerBonus = (surplus * liquidationBonusBps) / BPS;
            // Cap bonus to surplus (can't pay more than we have left over).
            if (toCallerBonus > surplus) toCallerBonus = surplus;
            toBorrowerSurplus = surplus - toCallerBonus;
            badDebt = 0;
        } else {
            // Bad debt scenario. Pool absorbs from protocol reserve first;
            // any remaining gap silently reduces totalAssets (supplier loss).
            uint256 shortfall = debt - payout;
            uint256 reserveAvail = protocolReserve;
            if (shortfall <= reserveAvail) {
                protocolReserve -= shortfall;
                effectiveDebtRepaid = debt; // fully covered (reserve absorbed gap)
                badDebt = -int256(shortfall);
            } else {
                // Reserve depleted; suppliers share remaining loss.
                protocolReserve = 0;
                effectiveDebtRepaid = payout + reserveAvail; // what was actually recouped
                badDebt = -int256(shortfall);
            }
            // No bonus on bad-debt liquidations (incentive to act EARLY).
            toCallerBonus = 0;
            toBorrowerSurplus = 0;
        }

        // EFFECTS — clear loan state
        totalBorrowed -= l.principal;
        l.principal = 0;
        l.accruedFeesUnpaid = 0;
        l.status = LoanStatus.CLOSED;
        activeLoanOf[l.nft][l.tokenId] = 0;

        // INTERACTIONS
        if (toCallerBonus > 0) USDC.safeTransfer(msg.sender, toCallerBonus);
        if (toBorrowerSurplus > 0) USDC.safeTransfer(l.borrower, toBorrowerSurplus);

        emit LiquidationCompleted(
            loanId, msg.sender, payout, effectiveDebtRepaid,
            toCallerBonus, toReserve, toBorrowerSurplus, badDebt
        );
    }

    /// @notice Settle a MARKETPLACE_AUCTION liquidation after the listing on
    ///         EcosystemMarketplace has either SOLD or been CANCELLED/RETURNED.
    ///         Permissionless — reads marketplace state for truth.
    ///
    ///         Three cases decided by reading the listing + NFT ownership:
    ///           1. listing.active  == true          → revert (still up for sale)
    ///           2. listing.active  == false AND     → sale happened; apply
    ///              NFT not in pool custody             (price × (1 - fee)) to debt
    ///                                                 via the same waterfall
    ///                                                 as completeLiquidation
    ///           3. listing.active  == false AND     → sale cancelled / emergency
    ///              NFT returned to pool custody        returned; unwind: put loan
    ///                                                 back to ACTIVE, clear
    ///                                                 auction fields, NFT stays
    ///                                                 in pool as collateral.
    function completeMarketplaceLiquidation(uint256 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        if (l.status != LoanStatus.LIQUIDATING) revert NotLiquidating();
        if (l.liqStrategy != uint8(INFTValuer.Strategy.MARKETPLACE_AUCTION)) {
            revert NotAuctionLiquidation(loanId);
        }
        if (address(marketplace) == address(0)) revert MarketplaceNotSet();

        // Read marketplace listing state.
        (, , , uint256 listingPrice, , bool active) = marketplace.listings(l.auctionListingId);
        if (active) revert AuctionStillActive(l.auctionListingId);

        // Did the NFT come back to us? (admin emergencyReturn or similar)
        if (IERC721(l.nft).ownerOf(l.tokenId) == address(this)) {
            // Unwind: restore loan to ACTIVE and clear auction fields.
            l.status = LoanStatus.ACTIVE;
            l.auctionListingId = 0;
            l.auctionPriceUSDC = 0;
            emit MarketplaceLiquidationUnwound(loanId);
            return;
        }

        // Sale happened. Accrue final interest, compute debt + payout applied.
        _accrueInterest(l);
        uint256 debt = l.principal + l.accruedFeesUnpaid;

        // Gross sale price minus marketplace protocol fee. The supplier-cut of
        // that fee flows back here via RoyaltyRouter separately (not counted
        // in `payout` — it just bumps supplier share value naturally).
        uint16 feeBps = marketplace.protocolFeeBps();
        uint256 payout = listingPrice - (listingPrice * uint256(feeBps)) / BPS;

        uint256 toReserve;
        uint256 toCallerBonus;
        uint256 toBorrowerSurplus;
        int256 badDebt;
        uint256 effectiveDebtRepaid;

        if (payout >= debt) {
            effectiveDebtRepaid = debt;
            uint256 surplus = payout - debt;
            toReserve = (l.accruedFeesUnpaid * protocolReserveBps) / BPS;
            protocolReserve += toReserve;
            toCallerBonus = (surplus * liquidationBonusBps) / BPS;
            if (toCallerBonus > surplus) toCallerBonus = surplus;
            toBorrowerSurplus = surplus - toCallerBonus;
            badDebt = 0;
        } else {
            uint256 shortfall = debt - payout;
            uint256 reserveAvail = protocolReserve;
            if (shortfall <= reserveAvail) {
                protocolReserve -= shortfall;
                effectiveDebtRepaid = debt;
                badDebt = -int256(shortfall);
            } else {
                protocolReserve = 0;
                effectiveDebtRepaid = payout + reserveAvail;
                badDebt = -int256(shortfall);
            }
            toCallerBonus = 0;
            toBorrowerSurplus = 0;
        }

        // EFFECTS
        totalBorrowed -= l.principal;
        l.principal = 0;
        l.accruedFeesUnpaid = 0;
        l.status = LoanStatus.CLOSED;
        activeLoanOf[l.nft][l.tokenId] = 0;

        // INTERACTIONS
        if (toCallerBonus > 0)    USDC.safeTransfer(msg.sender, toCallerBonus);
        if (toBorrowerSurplus > 0) USDC.safeTransfer(l.borrower, toBorrowerSurplus);

        emit MarketplaceLiquidationSettled(loanId, payout, effectiveDebtRepaid, badDebt);
        emit LiquidationCompleted(loanId, msg.sender, payout, effectiveDebtRepaid, toCallerBonus, toReserve, toBorrowerSurplus, badDebt);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setBorrowApr(uint256 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > 5_000) revert BadParam(); // sanity cap 50% APR
        borrowAprBps = newBps;
        emit ParamsUpdated("borrowAprBps", newBps);
    }

    function setBorrowAprOverride(address nft, uint256 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > 5_000) revert BadParam(); // sanity cap 50% APR
        borrowAprOverride[nft] = newBps;
        emit ParamsUpdated(string(abi.encodePacked("aprOverride:", _toAsciiHex(nft))), newBps);
    }

    function _toAsciiHex(address a) internal pure returns (bytes memory s) {
        s = new bytes(42);
        s[0] = "0"; s[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(uint160(a) >> (8 * (19 - i)));
            uint8 hi = b >> 4;
            uint8 lo = b & 0x0f;
            s[2 + 2*i]     = bytes1(hi < 10 ? hi + 0x30 : hi + 0x57);
            s[2 + 2*i + 1] = bytes1(lo < 10 ? lo + 0x30 : lo + 0x57);
        }
    }

    function setProtocolReserveBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > 5_000) revert BadParam(); // ≤ 50% reserve cut
        protocolReserveBps = newBps;
        emit ParamsUpdated("protocolReserveBps", newBps);
    }

    function setLiquidationBuffer(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps == 0 || newBps > 3_000) revert BadParam(); // 0 < buffer ≤ 30%
        liquidationBufferBps = newBps;
        emit ParamsUpdated("liquidationBufferBps", newBps);
    }

    function setLiquidationBonus(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps == 0 || newBps > 2_000) revert BadParam(); // 0 < bonus ≤ 20%
        liquidationBonusBps = newBps;
        emit ParamsUpdated("liquidationBonusBps", newBps);
    }

    function setMinLoanDuration(uint256 newSec) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSec > 7 days) revert BadParam();
        minLoanDuration = newSec;
        emit ParamsUpdated("minLoanDuration", newSec);
    }

    function setMinSupplyHold(uint256 newSec) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSec > 30 days) revert BadParam();
        minSupplyHold = newSec;
        emit ParamsUpdated("minSupplyHold", newSec);
    }

    function setSweepSink(address newSink) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sweepSink = newSink; // address(0) allowed → unset
        emit SweepSinkUpdated(newSink);
    }

    /// @notice Wire the per-tokenId valuation dispatcher. Pass address(0) to
    ///         revert to the legacy direct vault-call path. Existing loans
    ///         are unaffected (valuation only affects borrow-time LTV gating
    ///         and liquidation health checks; debt/principal are stored).
    function setValuer(address newValuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        valuer = INFTValuer(newValuer); // address(0) allowed → rollback to legacy
        emit ValuerUpdated(newValuer);
    }

    /// @notice Wire the EcosystemMarketplace used for MARKETPLACE_AUCTION
    ///         liquidation. After setting this, admin MUST also grant the
    ///         pool LIQUIDATOR_ROLE on the marketplace (off-chain tx). Without
    ///         it, `liquidationList` reverts and no MARKETPLACE_AUCTION loan
    ///         can be triggered — borrow-time gate catches this.
    function setMarketplace(address mp) external onlyRole(DEFAULT_ADMIN_ROLE) {
        marketplace = IEcosystemMarketplace(mp);
        emit MarketplaceUpdated(mp);
    }

    function setAuctionParams(uint16 markdownBps, uint64 expirySec) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Sanity: markdown must be between 50% and 100% of live value.
        if (markdownBps < 5_000 || markdownBps > 10_000) revert BadParam();
        if (expirySec < 1 hours || expirySec > 30 days) revert BadParam();
        auctionStartMarkdownBps = markdownBps;
        auctionExpirySec = expirySec;
        emit AuctionParamsUpdated(markdownBps, expirySec);
    }

    function withdrawProtocolReserve(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > protocolReserve) revert BadParam();
        protocolReserve -= amount;
        USDC.safeTransfer(to, amount);
        emit ProtocolReserveWithdrawn(to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ════════════════════════════════════════════════════════════
    //  IERC721Receiver
    // ════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ════════════════════════════════════════════════════════════
    //  Rescue (admin) — USDC is off-limits (supplier funds);
    //  active-loan collateral NFTs are off-limits.
    // ════════════════════════════════════════════════════════════

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event NativeRescued(address indexed to, uint256 amount);

    error CannotRescueUSDC();
    error NftIsActiveCollateral(address nft, uint256 tokenId, uint256 loanId);
    error ZeroRescueAddress();
    error NativeRescueFailed();

    /// @notice Rescue stray ERC-20s. REVERTS for USDC — that balance backs
    ///         supplier shares, and there is no safe way to distinguish
    ///         stray USDC from supplier-backed USDC once it lands in the
    ///         pool. Use suppliers' own withdraw() paths for USDC.
    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroRescueAddress();
        if (token == address(USDC)) revert CannotRescueUSDC();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue stray ERC-721s. REVERTS if the NFT is currently
    ///         collateral on an active loan — those belong to the borrower
    ///         and are released only via repay or liquidation.
    function rescueNft(address nft, uint256 tokenId, address to)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroRescueAddress();
        uint256 activeId = activeLoanOf[nft][tokenId];
        if (activeId != 0) revert NftIsActiveCollateral(nft, tokenId, activeId);
        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        emit NftRescued(nft, tokenId, to);
    }

    /// @notice Rescue stray native. Pool doesn't accept value by design, so
    ///         this path is belt-and-suspenders.
    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroRescueAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    receive() external payable {}
}
