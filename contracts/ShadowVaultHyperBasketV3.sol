// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IShadowPositionNFT} from "./interfaces/IShadowPositionNFT.sol";

/// @dev Expanded yield-adapter interface — v2's IYieldAdapterLite was
///      missing `withdraw`, which is exactly why withdrawPair's yield leg
///      could never settle. v3 calls withdraw mirroring ShadowVaultV15's
///      pattern (with 95% recovery enforcement).
interface IYieldAdapter {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external returns (uint256 delivered);
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

/// @title ShadowVaultHyperBasketV3
/// @notice Pool F v3 on HyperEVM. Same architecture as v2 (split USDC into
///         yield + basket legs, mint two receipts) but the withdrawPair
///         function now settles BOTH legs in a single tx. The yield leg
///         uses pro-rata accounting against yieldAdapter.totalAssets and
///         enforces the same 95% adapter-recovery rule that V15 uses, so
///         operators get the same operational guarantees on Pool F as on
///         Pool E.
///
/// @dev    v2 → v3 changes:
///         - IYieldAdapterLite renamed → IYieldAdapter with withdraw()
///         - yieldPrincipalOf[yieldTokenId] tracks per-receipt principal
///         - totalYieldPrincipal tracks the running sum for pro-rata math
///         - withdrawPair settles both legs and reverts on adapter under-
///           delivery via AdapterPartialWithdraw (no more silent yield-zero)
///         - Vault must hold VAULT_ROLE on the yieldAdapter — same role
///           Pool E v2 vault holds; granted by the adapter admin during
///           deploy/wire-up
contract ShadowVaultHyperBasketV3 is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum Tier { FLEX, THIRTY, NINETY, ONEIGHTY, YEAR }

    // ─ Immutables ─
    IERC20                   public immutable USDC;
    IYieldAdapter            public immutable yieldAdapter;
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
    bool public whitelistEnabled = false;
    mapping(address => bool) public whitelisted;

    // Pair tracking — maps yieldTokenId ↔ basketTokenId so UIs can reassemble
    // a position for pair-withdraw without off-chain indexing.
    mapping(uint256 => uint256) public basketOfYield;
    mapping(uint256 => uint256) public yieldOfBasket;

    // v3: per-receipt yield principal so pro-rata math works at exit.
    // Keyed on yieldTokenId; cleared on withdrawPair.
    mapping(uint256 => uint128) public yieldPrincipalOf;
    /// Running sum of all live yield-leg principal (USDC 6-dec). Drives
    /// `share = yieldAdapter.totalAssets * principal / totalYieldPrincipal`
    /// at withdraw time.
    uint256 public totalYieldPrincipal;

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
        uint256 basketPayout,
        uint256 yieldPayout,
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
    error AdapterPartialWithdraw(uint256 requested, uint256 delivered);

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
        yieldAdapter   = IYieldAdapter(yieldAdapter_);
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

        (uint256 nav, , bool stale, bool frozen) = navOracle.getNavLenient(basketId);
        if (nav == 0 || stale || frozen) revert NavStale();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 yieldPortion  = (amount * uint256(yieldBps))  / 10_000;
        uint256 basketPortion = amount - yieldPortion;

        if (yieldPortion > 0) {
            USDC.forceApprove(address(yieldAdapter), yieldPortion);
            yieldAdapter.deposit(yieldPortion);
        }
        if (basketPortion > 0) {
            USDC.forceApprove(address(basketAdapter), basketPortion);
            basketAdapter.deposit(basketPortion);
        }

        yieldTokenId = yieldReceipt.mint(
            msg.sender,
            abi.encode(uint128(yieldPortion), uint8(tier))
        );
        basketTokenId = basketReceipt.mint(
            msg.sender,
            abi.encode(basketId, uint128(basketPortion), uint8(tier))
        );

        basketOfYield[yieldTokenId] = basketTokenId;
        yieldOfBasket[basketTokenId] = yieldTokenId;

        // v3: record yield principal for pro-rata at exit.
        if (yieldPortion > 0) {
            yieldPrincipalOf[yieldTokenId] = uint128(yieldPortion);
            totalYieldPrincipal += yieldPortion;
        }

        emit Deposited(msg.sender, amount, basketPortion, yieldPortion, yieldTokenId, basketTokenId, tier);
    }

    /// @notice Burn a matched pair of receipts and receive USDC. v3 settles
    ///         BOTH legs — basket leg pulls from basketAdapter.idle, yield
    ///         leg pulls pro-rata from yieldAdapter (HLPAdapter).
    /// @dev    Yield-leg uses 95%-recovery rule: reverts with
    ///         AdapterPartialWithdraw if HLPAdapter idle is short. Caller
    ///         can retry once keeper completes the HLP unwind. Receipts
    ///         remain unburned (matching v2 behaviour); the pair mapping
    ///         is cleared so withdrawPair can't be called twice on the
    ///         same pair.
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

        // ── Basket leg (same as v2) ──────────────────────────────────────
        uint256 idleBasket = IERC20(address(USDC)).balanceOf(address(basketAdapter));
        uint256 basketSent = 0;
        if (idleBasket > 0) {
            basketSent = basketAdapter.withdraw(idleBasket, to);
        }

        // ── Yield leg (NEW in v3) ────────────────────────────────────────
        uint128 principal = yieldPrincipalOf[yieldTokenId];
        uint256 yieldSent = 0;
        if (principal > 0 && totalYieldPrincipal > 0) {
            uint256 yieldTotal = yieldAdapter.totalAssets();
            uint256 share = (yieldTotal * uint256(principal)) / totalYieldPrincipal;
            if (share > 0) {
                yieldSent = yieldAdapter.withdraw(share);
                // 95% recovery rule — same as V15. If HLPAdapter idle is
                // short, revert with named error so the UI can show a
                // useful toast. Position state is unchanged; user retries
                // once the keeper unwinds.
                if (yieldSent * 100 < share * 95) {
                    revert AdapterPartialWithdraw(share, yieldSent);
                }
                if (yieldSent > 0) {
                    USDC.safeTransfer(to, yieldSent);
                }
            }
            totalYieldPrincipal -= principal;
        }

        // Mappings cleared AFTER both legs to keep state consistent on
        // partial reverts.
        delete basketOfYield[yieldTokenId];
        delete yieldOfBasket[basketTokenId];
        delete yieldPrincipalOf[yieldTokenId];

        payout = basketSent + yieldSent;
        emit PairWithdrawn(msg.sender, yieldTokenId, basketTokenId, basketSent, yieldSent, payout);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    function totalAssets() external view returns (uint256) {
        return yieldAdapter.totalAssets() + basketAdapter.totalAssets();
    }

    /// @notice Preview what withdrawPair would return for a given pair,
    ///         without sending the tx. Returns (basketPreview, yieldPreview,
    ///         total). yieldPreview is gross share before the 95% check —
    ///         the actual call reverts if delivered < 95% × share.
    function previewWithdrawPair(uint256 yieldTokenId)
        external
        view
        returns (uint256 basketPreview, uint256 yieldPreview, uint256 total)
    {
        basketPreview = IERC20(address(USDC)).balanceOf(address(basketAdapter));
        uint128 principal = yieldPrincipalOf[yieldTokenId];
        if (principal > 0 && totalYieldPrincipal > 0) {
            uint256 yieldTotal = yieldAdapter.totalAssets();
            yieldPreview = (yieldTotal * uint256(principal)) / totalYieldPrincipal;
        }
        total = basketPreview + yieldPreview;
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function setAllocation(uint16 basketBps_, uint16 yieldBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (basketBps_ + yieldBps_ != 10_000) revert BadAllocation();
        basketBps = basketBps_;
        yieldBps  = yieldBps_;
        emit AllocationSet(basketBps_, yieldBps_);
    }

    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function setWhitelistEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelistEnabled = enabled;
        emit WhitelistToggled(enabled);
    }

    function setWhitelist(address who, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        whitelisted[who] = status;
        emit WhitelistSet(who, status);
    }

    function setMinMaxDeposit(uint256 min_, uint256 max_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minDeposit = min_;
        maxDeposit = max_;
        emit MinMaxDepositSet(min_, max_);
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause();   }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ═══════════════════════════════════════════════════════════
    //  Migration
    // ═══════════════════════════════════════════════════════════

    error AlreadySeeded(uint256 yieldTokenId);

    event PairSeeded(uint256 indexed yieldTokenId, uint256 indexed basketTokenId, uint128 principalUsd6);

    /// @notice One-shot migration helper for receipt pairs minted by Pool F
    ///         v2 (which never tracked yieldPrincipalOf, since v2 couldn't
    ///         settle the yield leg). Lets admin populate v3's mappings for
    ///         a known pair so the holder can call withdrawPair on v3 and
    ///         recover both legs. Admin reads the principal from the
    ///         YieldReceipt's positionOf(tokenId).principalUsd6.
    /// @dev    Trust model: DEFAULT_ADMIN_ROLE only. Idempotent — reverts
    ///         on a re-seed so a typo can't double-count totalYieldPrincipal.
    ///         No on-chain check that the principal value matches the
    ///         receipt's positionOf — admin's responsibility to read it
    ///         right. Trade-off accepted because Pool F v2 had ≤1 live
    ///         pair at v3.1 deploy time.
    function seedExistingPair(
        uint256 yieldTokenId,
        uint256 basketTokenId,
        uint128 principalUsd6
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (basketOfYield[yieldTokenId] != 0) revert AlreadySeeded(yieldTokenId);

        basketOfYield[yieldTokenId] = basketTokenId;
        yieldOfBasket[basketTokenId] = yieldTokenId;
        if (principalUsd6 > 0) {
            yieldPrincipalOf[yieldTokenId] = principalUsd6;
            totalYieldPrincipal += uint256(principalUsd6);
        }
        emit PairSeeded(yieldTokenId, basketTokenId, principalUsd6);
    }
}
