// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {DiggerRegistry} from "./DiggerRegistry.sol";
import {RoyaltyRouter} from "./RoyaltyRouter.sol";

/// @title EcosystemMarketplaceV3 — non-custodial, sponsored-fill
/// @notice Non-escrow fixed-price marketplace for NFTs registered through
///         `DiggerRegistry`. Orders live on chain; NFTs stay in the seller's
///         wallet until a fill matches. Anyone can `fillFor(orderId, beneficiary)`
///         — the filler pays USDC and the NFT is delivered to `beneficiary`.
///         This makes "Safe pays for buyer" a single tx, no Safe-app handoff.
///
///         Differences vs v1/v2 (`EcosystemMarketplace`):
///           - NO NFT custody at any point. `list` does not transfer the NFT
///             into this contract — it just records the order. (Wallet
///             scanners stop warning about NFT-eating contracts.)
///           - Sponsored fill via `fillFor(orderId, beneficiary)`.
///           - Cancel is a single state flip — no NFT to refund because
///             there never was one in custody.
///           - Liquidator role / `liquidationList` not in v3 — Phase 3
///             lending continues to use v2 until v3.1.
///
///         Fee math, registry gating, and RoyaltyRouter integration are
///         identical to v1/v2: same `protocolFeeBps`, same digger split.
contract EcosystemMarketplaceV3 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    IERC20         public immutable USDC;
    DiggerRegistry public immutable REGISTRY;
    RoyaltyRouter  public immutable ROUTER;

    /// @notice Total fee bps charged on every fill. Default 250 bps = 2.5%.
    ///         Hard cap 1000 bps. Routed via RoyaltyRouter per digger split.
    uint16 public protocolFeeBps = 250;
    uint16 public constant MAX_FEE_BPS = 1_000;

    bool    public paused;
    uint256 public nextOrderId = 1;

    struct Order {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 priceUSDC;
        uint64  expiresAt;   // 0 = no expiry
        bool    active;
    }

    mapping(uint256 => Order) public orders;
    /// @notice (nft, tokenId) → active orderId. 0 means no active order.
    mapping(address => mapping(uint256 => uint256)) public activeOrderOf;

    event Listed(
        uint256 indexed orderId, address indexed seller, address indexed nft,
        uint256 tokenId, uint256 priceUSDC, uint64 expiresAt
    );
    event LiquidationListed(
        uint256 indexed orderId, address indexed liquidator, address indexed nft,
        uint256 tokenId, uint256 priceUSDC, uint64 expiresAt
    );
    event Cancelled(uint256 indexed orderId);
    event Filled(
        uint256 indexed orderId, address indexed payer, address indexed beneficiary,
        address seller, uint256 priceUSDC, uint256 feeUSDC
    );
    event PriceUpdated(uint256 indexed orderId, uint256 newPriceUSDC);
    event ProtocolFeeUpdated(uint16 newFeeBps);
    event PausedUpdated(bool paused);

    error ZeroAddress();
    error ZeroPrice();
    error PausedErr();
    error NotListable(address nft);
    error NotSeller();
    error NotOwner();
    error OrderNotActive();
    error Expired();
    error AlreadyListed();
    error FeeTooHigh(uint16 bps);

    constructor(address admin_, address usdc_, address registry_, address router_) {
        if (admin_ == address(0) || usdc_ == address(0) || registry_ == address(0) || router_ == address(0)) {
            revert ZeroAddress();
        }
        USDC     = IERC20(usdc_);
        REGISTRY = DiggerRegistry(payable(registry_));
        ROUTER   = RoyaltyRouter(router_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    // ════════════════════════════════════════════════════════════
    //  Seller surface
    // ════════════════════════════════════════════════════════════

    /// @notice Create a listing for a token the caller currently owns.
    ///         The NFT is NOT escrowed — it stays in the seller's wallet.
    ///         For a `fill` to succeed later, the seller must approve this
    ///         marketplace to move the token (`approve(this, tokenId)` or
    ///         `setApprovalForAll(this, true)`). Approval is enforced at
    ///         fill time by the underlying ERC721, not here.
    function list(address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt)
        external
        returns (uint256 orderId)
    {
        if (paused) revert PausedErr();
        if (priceUSDC == 0) revert ZeroPrice();
        if (!REGISTRY.isListable(nft)) revert NotListable(nft);
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (activeOrderOf[nft][tokenId] != 0) revert AlreadyListed();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            priceUSDC: priceUSDC,
            expiresAt: expiresAt,
            active: true
        });
        activeOrderOf[nft][tokenId] = orderId;
        emit Listed(orderId, msg.sender, nft, tokenId, priceUSDC, expiresAt);
    }

    function setPrice(uint256 orderId, uint256 newPrice) external {
        Order storage o = orders[orderId];
        if (!o.active) revert OrderNotActive();
        if (msg.sender != o.seller) revert NotSeller();
        if (newPrice == 0) revert ZeroPrice();
        o.priceUSDC = newPrice;
        emit PriceUpdated(orderId, newPrice);
    }

    /// @notice Liquidator-only listing path. Mirrors `list` but bypasses the
    ///         `paused` gate so a LendingPool can always dispose of seized
    ///         collateral, even while the marketplace is paused for ordinary
    ///         trading. Caller (typically the LendingPool) must own the NFT
    ///         and approve this marketplace before fill — same non-custodial
    ///         pattern as the standard list path. Requires LIQUIDATOR_ROLE.
    function liquidationList(address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt)
        external
        onlyRole(LIQUIDATOR_ROLE)
        returns (uint256 orderId)
    {
        if (priceUSDC == 0) revert ZeroPrice();
        if (!REGISTRY.isListable(nft)) revert NotListable(nft);
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (activeOrderOf[nft][tokenId] != 0) revert AlreadyListed();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            priceUSDC: priceUSDC,
            expiresAt: expiresAt,
            active: true
        });
        activeOrderOf[nft][tokenId] = orderId;
        emit Listed(orderId, msg.sender, nft, tokenId, priceUSDC, expiresAt);
        emit LiquidationListed(orderId, msg.sender, nft, tokenId, priceUSDC, expiresAt);
    }

    function cancel(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (!o.active) revert OrderNotActive();
        if (msg.sender != o.seller) revert NotSeller();
        o.active = false;
        activeOrderOf[o.nft][o.tokenId] = 0;
        emit Cancelled(orderId);
    }

    // ════════════════════════════════════════════════════════════
    //  Buyer / sponsor surface
    // ════════════════════════════════════════════════════════════

    /// @notice Fill an order on behalf of `beneficiary`. The filler
    ///         (`msg.sender`) pays the price in USDC; the NFT is delivered
    ///         to `beneficiary` (which can be any address).
    ///         Sponsored case: a treasury Safe with USDC submits this on
    ///         behalf of a buyer who paid the treasury — set
    ///         `beneficiary = buyerWallet`.
    function fillFor(uint256 orderId, address beneficiary) external nonReentrant {
        _fillFor(orderId, beneficiary);
    }

    /// @notice Fill an order for the caller. Equivalent to
    ///         `fillFor(orderId, msg.sender)`.
    function fill(uint256 orderId) external nonReentrant {
        _fillFor(orderId, msg.sender);
    }

    function _fillFor(uint256 orderId, address beneficiary) internal {
        if (paused) revert PausedErr();
        if (beneficiary == address(0)) revert ZeroAddress();

        Order storage o = orders[orderId];
        if (!o.active) revert OrderNotActive();
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) revert Expired();
        if (!REGISTRY.isListable(o.nft)) revert NotListable(o.nft);

        uint256 price    = o.priceUSDC;
        uint256 fee      = (price * protocolFeeBps) / 10_000;
        uint256 toSeller = price - fee;

        address seller  = o.seller;
        address nft     = o.nft;
        uint256 tokenId = o.tokenId;

        // Effects.
        o.active = false;
        activeOrderOf[nft][tokenId] = 0;

        // Pull USDC from filler. SafeERC20 reverts on failure — no funds
        // change hands and no NFT moves.
        USDC.safeTransferFrom(msg.sender, address(this), price);

        // Route fee via RoyaltyRouter (approve then call).
        if (fee > 0) {
            USDC.safeIncreaseAllowance(address(ROUTER), fee);
            ROUTER.routeRevenue(nft, fee);
        }

        // Pay seller their share.
        if (toSeller > 0) USDC.safeTransfer(seller, toSeller);

        // Pull NFT directly from seller's wallet to beneficiary. Reverts if
        // approval lapsed or the seller no longer owns the token — in
        // which case the entire fill atomically reverts (USDC stays put).
        IERC721(nft).safeTransferFrom(seller, beneficiary, tokenId);

        emit Filled(orderId, msg.sender, beneficiary, seller, price, fee);
    }

    // ════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    /// @notice Best-effort fillability check. Returns false if the order
    ///         is inactive, expired, the collection became unlistable, the
    ///         seller no longer owns the NFT, or marketplace approval has
    ///         lapsed. Frontends should use this to filter stale listings
    ///         out of the browse view without simulating a full fill.
    function isFillable(uint256 orderId) external view returns (bool) {
        Order memory o = orders[orderId];
        if (!o.active) return false;
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) return false;
        if (paused) return false;
        if (!REGISTRY.isListable(o.nft)) return false;

        IERC721 t = IERC721(o.nft);
        try t.ownerOf(o.tokenId) returns (address owner_) {
            if (owner_ != o.seller) return false;
        } catch {
            return false;
        }
        if (
            t.getApproved(o.tokenId) != address(this) &&
            !t.isApprovedForAll(o.seller, address(this))
        ) {
            return false;
        }
        return true;
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setProtocolFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        protocolFeeBps = bps;
        emit ProtocolFeeUpdated(bps);
    }

    function setPaused(bool p) external onlyRole(PAUSER_ROLE) {
        paused = p;
        emit PausedUpdated(p);
    }
}
