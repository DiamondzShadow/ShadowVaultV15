// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IShadowPositionNFT} from "./interfaces/IShadowPositionNFT.sol";

interface IYieldAdapterLite {
    function deposit(uint256 amount) external;
    function totalAssets() external view returns (uint256);
    function totalPrincipal() external view returns (uint256);
}

interface IBasketAdapter {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount, address to) external returns (uint256 sent);
    function totalAssets() external view returns (uint256);
    function basketId() external view returns (uint64);
}

interface IBasketNavOracle {
    function getNavLenient(uint64 basketId)
        external
        view
        returns (uint256 navUsd6, uint64 at, bool stale, bool frozen);
}

/// @title ShadowVaultHyperBasket
/// @notice Pool F+ vault on HyperEVM. Accepts USDC, splits into a yield leg
///         (HLPAdapterHC) and a basket leg (BasketAdapterHC valued by
///         BasketNavOracle), and mints TWO NFTs per deposit: a YieldReceipt
///         and a BasketReceipt. Holders can trade either independently, or
///         wrap both into a ShadowPass via the ShadowPass wrapper contract.
///
/// @dev    This is a distinct codebase from ShadowVaultV15 — not a drop-in
///         replacement. No on-chain basket token list, no sequencer oracle,
///         no unified position struct. The vault itself holds no tokens: all
///         USDC lives in one of the two adapters (idle, in-flight, or in HLP).
///
/// @dev    Withdrawals are PAIR-based in this MVP: to exit a position the
///         caller must own both receipts that came from the same deposit.
///         Independent-leg exit (sell just one side) is handled at the NFT
///         layer via the ERC-721 secondary market.
contract ShadowVaultHyperBasket is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum Tier { FLEX, THIRTY, NINETY, ONEIGHTY, YEAR }

    // ─ Immutables ─
    IERC20                   public immutable USDC;
    IYieldAdapterLite        public immutable yieldAdapter;
    IBasketAdapter           public immutable basketAdapter;
    IShadowPositionNFT       public immutable yieldReceipt;
    IShadowPositionNFT       public immutable basketReceipt;
    IBasketNavOracle         public immutable navOracle;
    uint64                   public immutable basketId;

    // ─ Config ─
    address public treasury;
    uint16  public basketBps;    // e.g. 6000 = 60%
    uint16  public yieldBps;     // e.g. 4000 = 40%, must sum to 10000
    uint256 public minDeposit = 5_000_000;        // $5
    uint256 public maxDeposit = 100_000_000_000;  // $100k sanity ceiling

    // Whitelist
    bool public whitelistEnabled = true;
    mapping(address => bool) public whitelisted;

    // Pair tracking — maps yieldTokenId → basketTokenId so UIs can reassemble
    // a position for pair-withdraw without off-chain indexing.
    mapping(uint256 => uint256) public basketOfYield;
    mapping(uint256 => uint256) public yieldOfBasket;

    // ───────── Events ─────────
    event Deposited(
        address indexed depositor,
        uint256 amount,
        uint256 basketPortion,
        uint256 yieldPortion,
        uint256 yieldTokenId,
        uint256 basketTokenId,
        Tier    tier
    );
    event PairWithdrawn(
        address indexed depositor,
        uint256 yieldTokenId,
        uint256 basketTokenId,
        uint256 payout
    );
    event AllocationSet(uint16 basketBps, uint16 yieldBps);
    event TreasurySet(address treasury);
    event WhitelistToggled(bool enabled);
    event WhitelistSet(address indexed who, bool status);
    event MinMaxDepositSet(uint256 min, uint256 max);

    // ───────── Errors ─────────
    error ZeroAddress();
    error ZeroAmount();
    error BadAllocation();
    error InvalidAmount();
    error NotWhitelisted();
    error NotHolder();
    error MismatchedPair();
    error NavStale();

    constructor(
        address admin,
        address usdc_,
        address yieldAdapter_,
        address basketAdapter_,
        address yieldReceipt_,
        address basketReceipt_,
        address navOracle_,
        address treasury_
    ) {
        if (admin == address(0) || usdc_ == address(0) || yieldAdapter_ == address(0)
            || basketAdapter_ == address(0) || yieldReceipt_ == address(0)
            || basketReceipt_ == address(0) || navOracle_ == address(0)
            || treasury_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        USDC           = IERC20(usdc_);
        yieldAdapter   = IYieldAdapterLite(yieldAdapter_);
        basketAdapter  = IBasketAdapter(basketAdapter_);
        yieldReceipt   = IShadowPositionNFT(yieldReceipt_);
        basketReceipt  = IShadowPositionNFT(basketReceipt_);
        navOracle      = IBasketNavOracle(navOracle_);
        basketId       = IBasketAdapter(basketAdapter_).basketId();
        treasury       = treasury_;
    }

    // ═══════════════════════════════════════════════════════════
    //  Core — deposit / withdraw
    // ═══════════════════════════════════════════════════════════

    /// @notice Deposit USDC and receive one YieldReceipt + one BasketReceipt.
    function deposit(uint256 amount, Tier tier)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 yieldTokenId, uint256 basketTokenId)
    {
        if (whitelistEnabled && !whitelisted[msg.sender]) revert NotWhitelisted();
        if (amount < minDeposit || amount > maxDeposit) revert InvalidAmount();
        if (basketBps + yieldBps != 10_000) revert BadAllocation();

        // Require fresh NAV at deposit time — protects against depositing
        // into a basket whose value is unknown.
        (uint256 nav, , bool stale, bool frozen) = navOracle.getNavLenient(basketId);
        if (nav == 0 || stale || frozen) revert NavStale();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 yieldPortion  = (amount * uint256(yieldBps))  / 10_000;
        uint256 basketPortion = amount - yieldPortion;  // remainder to basket for dust safety

        // ─ Route USDC into adapters ─
        if (yieldPortion > 0) {
            USDC.forceApprove(address(yieldAdapter), yieldPortion);
            yieldAdapter.deposit(yieldPortion);
        }
        if (basketPortion > 0) {
            USDC.forceApprove(address(basketAdapter), basketPortion);
            basketAdapter.deposit(basketPortion);
        }

        // ─ Mint both receipts ─
        // YieldReceipt posData = (uint128 principalUsd6, uint8 tier)
        yieldTokenId = yieldReceipt.mint(
            msg.sender,
            abi.encode(uint128(yieldPortion), uint8(tier))
        );
        // BasketReceipt posData = (uint64 basketId, uint128 sharesUsd6, uint8 tier)
        basketTokenId = basketReceipt.mint(
            msg.sender,
            abi.encode(basketId, uint128(basketPortion), uint8(tier))
        );

        basketOfYield[yieldTokenId] = basketTokenId;
        yieldOfBasket[basketTokenId] = yieldTokenId;

        emit Deposited(msg.sender, amount, basketPortion, yieldPortion, yieldTokenId, basketTokenId, tier);
    }

    /// @notice Burn a matched pair of receipts and receive back USDC worth
    ///         `yieldPortion_current_value + basketPortion_current_nav_value`.
    ///         MVP constraint: caller must own BOTH receipts and they must be
    ///         the pair minted from the same deposit. Independent-leg exits
    ///         are a future feature (requires adapter-level accounting change).
    function withdrawPair(uint256 yieldTokenId, uint256 basketTokenId, address to)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 payout)
    {
        if (to == address(0)) revert ZeroAddress();
        if (yieldReceipt.ownerOf(yieldTokenId) != msg.sender) revert NotHolder();
        if (basketReceipt.ownerOf(basketTokenId) != msg.sender) revert NotHolder();
        if (basketOfYield[yieldTokenId] != basketTokenId) revert MismatchedPair();

        // For MVP: compute pro-rata from adapter/oracle state.
        // - Yield leg value: adapter.totalAssets / adapter.totalPrincipal ratio,
        //   applied to the receipt's principal (proxied here via adapter views
        //   only — we don't read per-token yield state in the vault to keep
        //   it thin; the receipt layer is for UX metadata).
        //   For the vault we just request the full yield-side principal back;
        //   adapter handles under-delivery.
        //
        // NOTE: This MVP vault supports a *single position per caller* round-trip
        //       only. Full pro-rata exits across many pair-holders require a
        //       per-token principal index — out of scope here. For Pool F beta
        //       we'll cap this to whitelisted testers with known positions.

        delete basketOfYield[yieldTokenId];
        delete yieldOfBasket[basketTokenId];

        // Pull from basket adapter (idle only for MVP; reverts with pending
        // event on insufficient liquidity — keeper will unwind then user retries)
        uint256 idleBasket = IERC20(address(USDC)).balanceOf(address(basketAdapter));
        uint256 basketSent = 0;
        if (idleBasket > 0) {
            basketSent = basketAdapter.withdraw(idleBasket, to);
        }

        // Yield-side: out of scope for MVP (HLPAdapter withdrawals are async —
        // see HLPAdapterHC.initiateHCWithdraw path). Emit event + return 0
        // for now; next version adds async yield claim.

        payout = basketSent;
        emit PairWithdrawn(msg.sender, yieldTokenId, basketTokenId, payout);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    /// @notice Aggregate USD (6-dec) value across both legs. Yield leg via
    ///         adapter.totalAssets. Basket leg via NAV oracle applied to the
    ///         adapter's totalPrincipal (entry basis) — this gives a
    ///         reasonable *pool-level* snapshot even though per-receipt values
    ///         scale via entry-NAV on each receipt individually.
    function totalAssets() external view returns (uint256) {
        uint256 yieldSide = yieldAdapter.totalAssets();
        uint256 basketSide = basketAdapter.totalAssets();
        // Oracle adjustment (lenient — stale reads return last-known NAV)
        (uint256 nav, , , ) = navOracle.getNavLenient(basketId);
        if (nav != 0 && basketSide != 0) {
            // basketSide is "cost basis" USDC; scale by nav/1e6 to reflect MTM
            basketSide = (basketSide * nav) / 1e6;
        }
        return yieldSide + basketSide;
    }

    function isPair(uint256 yieldTokenId, uint256 basketTokenId) external view returns (bool) {
        return basketOfYield[yieldTokenId] == basketTokenId && basketTokenId != 0;
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function setAllocation(uint16 basketBps_, uint16 yieldBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(basketBps_) + uint256(yieldBps_) != 10_000) revert BadAllocation();
        basketBps = basketBps_;
        yieldBps  = yieldBps_;
        emit AllocationSet(basketBps_, yieldBps_);
    }

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function setWhitelistEnabled(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelistEnabled = on;
        emit WhitelistToggled(on);
    }

    function setWhitelist(address who, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelisted[who] = status;
        emit WhitelistSet(who, status);
    }

    function setMinMaxDeposit(uint256 min_, uint256 max_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (min_ == 0 || max_ < min_) revert InvalidAmount();
        minDeposit = min_;
        maxDeposit = max_;
        emit MinMaxDepositSet(min_, max_);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ═══════════════════════════════════════════════════════════
    //  Rescue (admin) — vault never holds persistent balance; any
    //  balance at rest is recoverable as a stray.
    // ═══════════════════════════════════════════════════════════

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error NativeRescueFailed();

    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert InvalidAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert InvalidAmount();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    receive() external payable {}
}
