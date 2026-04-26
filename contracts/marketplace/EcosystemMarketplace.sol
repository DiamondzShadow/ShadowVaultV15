// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {DiggerRegistry} from "./DiggerRegistry.sol";
import {RoyaltyRouter} from "./RoyaltyRouter.sol";

/// @title EcosystemMarketplace
/// @notice Escrow-style fixed-price marketplace for NFTs registered through
///         `DiggerRegistry`. Sellers list (NFT escrows here), buyers pay USDC,
///         royalty/fee USDC routes through `RoyaltyRouter` per the digger's
///         fee split. Listing-only diggers (maxLtvBps=0) can still trade here.
///
///         What's NOT in v1:
///           - best offer / English auctions (v1.1)
///           - bundle listings (v1.1)
///           - on-chain royalties for the seller (we use protocol/digger/supplier
///             split via RoyaltyRouter; original creator royalties are the
///             digger's responsibility — they take their cut and pay creator
///             out-of-band, or list the creator wallet as the digger owner)
///
///         What IS in v1:
///           - cancel any time before sale
///           - per-listing expiry
///           - admin pause + admin liquidation hook (reserved for LendingPool)
contract EcosystemMarketplace is AccessControl, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    IERC20 public immutable USDC;
    DiggerRegistry public immutable REGISTRY;
    RoyaltyRouter public immutable ROUTER;

    /// @notice Total fee bps charged on every sale (split by RoyaltyRouter
    ///         per digger config). Default 250 bps = 2.5%. Capped at 1000 bps.
    uint16 public protocolFeeBps = 250;
    uint16 public constant MAX_FEE_BPS = 1_000;

    bool public paused;
    uint256 public nextListingId = 1;

    struct Listing {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 priceUSDC;
        uint64  expiresAt;     // 0 = no expiry
        bool    active;
    }

    mapping(uint256 => Listing) public listings;
    /// @notice (nft, tokenId) → active listing id. 0 means no active listing.
    mapping(address => mapping(uint256 => uint256)) public activeListingOf;

    event Listed(
        uint256 indexed listingId, address indexed seller, address indexed nft,
        uint256 tokenId, uint256 priceUSDC, uint64 expiresAt
    );
    event Cancelled(uint256 indexed listingId);
    event Sold(
        uint256 indexed listingId, address indexed buyer, address indexed seller,
        uint256 priceUSDC, uint256 feeUSDC
    );
    event Liquidated(uint256 indexed listingId, address indexed to, uint256 priceUSDC);
    event ProtocolFeeUpdated(uint16 newFeeBps);
    event PausedUpdated(bool paused);
    event PriceUpdated(uint256 indexed listingId, uint256 newPriceUSDC);

    error ZeroAddress();
    error ZeroPrice();
    error PausedErr();
    error NotListable(address nft);
    error NotSeller();
    error ListingNotActive();
    error AlreadyListed();
    error Expired();
    error FeeTooHigh(uint16 fee, uint16 max);
    error NotERC721Owner();

    constructor(address admin, address _usdc, address _registry, address _router) {
        if (admin == address(0) || _usdc == address(0) || _registry == address(0) || _router == address(0))
            revert ZeroAddress();
        USDC = IERC20(_usdc);
        REGISTRY = DiggerRegistry(payable(_registry));
        ROUTER = RoyaltyRouter(_router);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ════════════════════════════════════════════════════════════
    //  Seller surface
    // ════════════════════════════════════════════════════════════

    /// @notice List an NFT for sale at a fixed USDC price. Caller must own
    ///         the NFT and have approved this contract for the token (or
    ///         setApprovalForAll). The NFT escrows here on listing.
    function list(address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (paused) revert PausedErr();
        if (priceUSDC == 0) revert ZeroPrice();
        if (!REGISTRY.isListable(nft)) revert NotListable(nft);
        if (activeListingOf[nft][tokenId] != 0) revert AlreadyListed();
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotERC721Owner();

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            priceUSDC: priceUSDC,
            expiresAt: expiresAt,
            active: true
        });
        activeListingOf[nft][tokenId] = listingId;

        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        emit Listed(listingId, msg.sender, nft, tokenId, priceUSDC, expiresAt);
    }

    /// @notice Cancel a listing and return the NFT.
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (msg.sender != l.seller) revert NotSeller();
        _settleCancellation(listingId, l);
    }

    /// @notice Update price on an existing listing.
    function setPrice(uint256 listingId, uint256 newPrice) external {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (msg.sender != l.seller) revert NotSeller();
        if (newPrice == 0) revert ZeroPrice();
        l.priceUSDC = newPrice;
        emit PriceUpdated(listingId, newPrice);
    }

    // ════════════════════════════════════════════════════════════
    //  Buyer surface
    // ════════════════════════════════════════════════════════════

    /// @notice Buy a listing. Caller must approve `priceUSDC` USDC to this
    ///         contract beforehand. Splits fee through RoyaltyRouter.
    function buy(uint256 listingId) external nonReentrant {
        if (paused) revert PausedErr();
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        if (l.expiresAt != 0 && block.timestamp > l.expiresAt) revert Expired();
        // Re-check listability — digger may have been paused/slashed since listing.
        if (!REGISTRY.isListable(l.nft)) revert NotListable(l.nft);

        uint256 fee = (l.priceUSDC * protocolFeeBps) / 10_000;
        uint256 toSeller = l.priceUSDC - fee;

        address seller = l.seller;
        address nft = l.nft;
        uint256 tokenId = l.tokenId;

        // Effects
        l.active = false;
        activeListingOf[nft][tokenId] = 0;

        // Pull USDC.
        USDC.safeTransferFrom(msg.sender, address(this), l.priceUSDC);

        // Route fee via RoyaltyRouter (approve then call).
        if (fee > 0) {
            USDC.safeIncreaseAllowance(address(ROUTER), fee);
            ROUTER.routeRevenue(nft, fee);
        }

        // Pay seller.
        if (toSeller > 0) USDC.safeTransfer(seller, toSeller);

        // Deliver NFT.
        IERC721(nft).safeTransferFrom(address(this), msg.sender, tokenId);

        emit Sold(listingId, msg.sender, seller, l.priceUSDC, fee);
    }

    // ════════════════════════════════════════════════════════════
    //  Lending integration hooks (active in Phase 3)
    // ════════════════════════════════════════════════════════════

    /// @notice Liquidator (LendingPool) sends a recovered NFT here at a fixed
    ///         price. NFT must already be transferred in via safeTransferFrom
    ///         BEFORE this call (the caller is the temporary owner). The
    ///         listing is created on behalf of the protocol; sale proceeds
    ///         flow back to the LendingPool to repay the seized loan.
    /// @dev Bypasses the digger.paused gate (we still need to recover loaned
    ///      USDC even if a project pauses listings). Does NOT bypass slashed —
    ///      if the digger is slashed the listing would never resolve.
    function liquidationList(address nft, uint256 tokenId, uint256 priceUSDC, uint64 expiresAt)
        external
        nonReentrant
        onlyRole(LIQUIDATOR_ROLE)
        returns (uint256 listingId)
    {
        if (priceUSDC == 0) revert ZeroPrice();
        DiggerRegistry.Collection memory c = _collection(nft);
        if (!c.accepted) revert NotListable(nft);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,        // typically the LendingPool address
            nft: nft,
            tokenId: tokenId,
            priceUSDC: priceUSDC,
            expiresAt: expiresAt,
            active: true
        });
        activeListingOf[nft][tokenId] = listingId;

        // NFT must already be in this contract's custody (transferred before call).
        if (IERC721(nft).ownerOf(tokenId) != address(this)) revert NotERC721Owner();

        emit Listed(listingId, msg.sender, nft, tokenId, priceUSDC, expiresAt);
    }

    function _collection(address nft) internal view returns (DiggerRegistry.Collection memory) {
        (uint256 diggerId, address oracle, uint16 maxLtvBps, bool accepted, DiggerRegistry.CollectionClass class_) =
            REGISTRY.collections(nft);
        return DiggerRegistry.Collection({
            diggerId: diggerId, oracle: oracle, maxLtvBps: maxLtvBps, accepted: accepted, class_: class_
        });
    }

    // ════════════════════════════════════════════════════════════
    //  Internal
    // ════════════════════════════════════════════════════════════

    function _settleCancellation(uint256 listingId, Listing storage l) internal {
        address seller = l.seller;
        address nft = l.nft;
        uint256 tokenId = l.tokenId;
        l.active = false;
        activeListingOf[nft][tokenId] = 0;
        IERC721(nft).safeTransferFrom(address(this), seller, tokenId);
        emit Cancelled(listingId);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setProtocolFee(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        protocolFeeBps = newFeeBps;
        emit ProtocolFeeUpdated(newFeeBps);
    }

    function setPaused(bool p) external onlyRole(PAUSER_ROLE) {
        paused = p;
        emit PausedUpdated(p);
    }

    /// @notice Admin escape hatch — return an escrowed NFT to its original
    ///         seller. Used if a digger gets slashed mid-listing and the
    ///         seller needs their NFT back without buying.
    function emergencyReturn(uint256 listingId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive();
        _settleCancellation(listingId, l);
    }

    // ════════════════════════════════════════════════════════════
    //  IERC721Receiver
    // ════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
