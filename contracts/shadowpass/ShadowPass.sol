// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IReceiptForURI {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title ShadowPass
/// @notice ERC-721 wrapper that escrows one YieldReceipt + one BasketReceipt
///         and issues a composite ShadowPass representing their combined
///         exposure. `wrap` takes ownership of both children and mints a pass.
///         `unwrap` burns the pass and returns both children to the caller.
///
/// @dev    Design notes:
///         - The two children can be from any vault / pool; we don't enforce
///           pairing beyond "both tokens exist and the caller owns both".
///           Pools that require pairing can enforce it at mint time by emitting
///           matching metadata on the two receipts.
///         - ShadowPass tokenIds are independent of the children's tokenIds.
///         - tokenURI composes both children's metadata inline for display
///           (OpenSea-style). The composite name / image is generated here.
contract ShadowPass is ERC721, AccessControl, IERC721Receiver, ReentrancyGuard {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    IERC721 public immutable yieldReceipt;
    IERC721 public immutable basketReceipt;

    struct Wrapped {
        uint128 yieldTokenId;
        uint128 basketTokenId;
        uint64  wrappedAt;
    }
    mapping(uint256 => Wrapped) public wrappedOf;
    /// @notice Reverse index: which pass currently escrows this yield tokenId?
    ///         0 = not escrowed. Used by rescueNft to protect active wraps.
    mapping(uint256 => uint256) public yieldEscrowedBy;
    /// @notice Reverse index for basket receipts. 0 = not escrowed.
    mapping(uint256 => uint256) public basketEscrowedBy;
    uint256 private _nextTokenId;

    // ───────── Events ─────────
    event PassWrapped(uint256 indexed passId, address indexed to, uint256 yieldTokenId, uint256 basketTokenId);
    event PassUnwrapped(uint256 indexed passId, address indexed to, uint256 yieldTokenId, uint256 basketTokenId);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event NativeRescued(address indexed to, uint256 amount);

    // ───────── Errors ─────────
    error NotOwnerOfChild();
    error NotHolder();
    error UnknownPass(uint256 passId);
    error OnlyReceiptTransfer();
    error NftIsActiveEscrow(address nft, uint256 tokenId, uint256 passId);
    error ZeroAddress();
    error NativeRescueFailed();

    constructor(address admin, address yieldReceipt_, address basketReceipt_)
        ERC721("ShadowPass", "PASS")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        yieldReceipt  = IERC721(yieldReceipt_);
        basketReceipt = IERC721(basketReceipt_);
    }

    // ═══════════════════════════════════════════════════════════
    //  Wrap / Unwrap
    // ═══════════════════════════════════════════════════════════

    /// @notice Combine a YieldReceipt + BasketReceipt you own into a single
    ///         ShadowPass. Caller must have approved this contract to pull
    ///         both receipts (or called `setApprovalForAll`).
    function wrap(uint256 yieldTokenId, uint256 basketTokenId)
        external
        nonReentrant
        returns (uint256 passId)
    {
        if (yieldReceipt.ownerOf(yieldTokenId) != msg.sender) revert NotOwnerOfChild();
        if (basketReceipt.ownerOf(basketTokenId) != msg.sender) revert NotOwnerOfChild();

        // Pull the children into this contract.
        yieldReceipt.safeTransferFrom(msg.sender, address(this), yieldTokenId);
        basketReceipt.safeTransferFrom(msg.sender, address(this), basketTokenId);

        passId = ++_nextTokenId;
        wrappedOf[passId] = Wrapped({
            yieldTokenId:  uint128(yieldTokenId),
            basketTokenId: uint128(basketTokenId),
            wrappedAt:     uint64(block.timestamp)
        });
        yieldEscrowedBy[yieldTokenId]   = passId;
        basketEscrowedBy[basketTokenId] = passId;
        _safeMint(msg.sender, passId);
        emit PassWrapped(passId, msg.sender, yieldTokenId, basketTokenId);
    }

    /// @notice Burn a ShadowPass and return both children to the caller.
    function unwrap(uint256 passId) external nonReentrant {
        if (_ownerOf(passId) != msg.sender) revert NotHolder();
        Wrapped memory w = wrappedOf[passId];
        if (w.wrappedAt == 0) revert UnknownPass(passId);

        delete wrappedOf[passId];
        delete yieldEscrowedBy[uint256(w.yieldTokenId)];
        delete basketEscrowedBy[uint256(w.basketTokenId)];
        _burn(passId);

        yieldReceipt.safeTransferFrom(address(this), msg.sender, uint256(w.yieldTokenId));
        basketReceipt.safeTransferFrom(address(this), msg.sender, uint256(w.basketTokenId));
        emit PassUnwrapped(passId, msg.sender, uint256(w.yieldTokenId), uint256(w.basketTokenId));
    }

    /// @notice Only accept inbound receipt transfers (via safeTransferFrom in wrap).
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(yieldReceipt) && msg.sender != address(basketReceipt)) {
            revert OnlyReceiptTransfer();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // ═══════════════════════════════════════════════════════════
    //  Metadata
    // ═══════════════════════════════════════════════════════════

    function tokenURI(uint256 passId) public view override returns (string memory) {
        if (_ownerOf(passId) == address(0)) revert UnknownPass(passId);
        Wrapped memory w = wrappedOf[passId];

        // We inline the child tokenURIs as "children" refs so OpenSea / UI can
        // render the composition. For the composite image, we draw our own SVG.
        string memory svg = _svg(passId, uint256(w.yieldTokenId), uint256(w.basketTokenId));
        string memory attrs = string(abi.encodePacked(
            '[',
            '{"trait_type":"Kind","value":"ShadowPass"},',
            '{"trait_type":"Yield Receipt","display_type":"number","value":', uint256(w.yieldTokenId).toString(), '},',
            '{"trait_type":"Basket Receipt","display_type":"number","value":', uint256(w.basketTokenId).toString(), '},',
            '{"display_type":"date","trait_type":"Wrapped At","value":', uint256(w.wrappedAt).toString(), '}',
            ']'
        ));
        string memory json = string(abi.encodePacked(
            '{"name":"ShadowPass #', passId.toString(),
            '","description":"Combined ShadowVault position. Escrows one YieldReceipt and one BasketReceipt. Unwrap to return both.",',
            '"attributes":', attrs, ',',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _svg(uint256 passId, uint256 yieldTokenId, uint256 basketTokenId) internal pure returns (string memory) {
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>',
            '<rect width="400" height="560" rx="16" fill="#0f0f14"/>',
            '<rect width="400" height="6" fill="url(#g)"/>',
            '<text x="200" y="50" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="22" font-weight="bold">SHADOWPASS</text>',
            '<text x="200" y="80" text-anchor="middle" fill="#888" font-family="monospace" font-size="13">#', passId.toString(), ' &#x2022; yield + basket combined</text>',
            '<rect x="50" y="120" width="150" height="350" rx="12" fill="#22c55e20" stroke="#22c55e" stroke-width="1"/>',
            '<text x="125" y="150" text-anchor="middle" fill="#22c55e" font-family="monospace" font-size="11" font-weight="bold">YIELD LEG</text>',
            '<text x="125" y="300" text-anchor="middle" fill="#22c55e" font-family="monospace" font-size="32" font-weight="bold">#', yieldTokenId.toString(), '</text>',
            '<rect x="210" y="120" width="150" height="350" rx="12" fill="#3b82f620" stroke="#3b82f6" stroke-width="1"/>',
            '<text x="285" y="150" text-anchor="middle" fill="#3b82f6" font-family="monospace" font-size="11" font-weight="bold">BASKET LEG</text>',
            '<text x="285" y="300" text-anchor="middle" fill="#3b82f6" font-family="monospace" font-size="32" font-weight="bold">#', basketTokenId.toString(), '</text>',
            '<text x="200" y="510" text-anchor="middle" fill="#555" font-family="monospace" font-size="10">unwrap() to redeem both legs</text>',
            '</svg>'
        ));
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    /// @notice Returns both child tokenURIs for a given pass (uses last-known
    ///         receipt state, no state mutation).
    function childURIs(uint256 passId) external view returns (string memory yieldURI, string memory basketURI) {
        Wrapped memory w = wrappedOf[passId];
        if (w.wrappedAt == 0) revert UnknownPass(passId);
        yieldURI  = IReceiptForURI(address(yieldReceipt)).tokenURI(uint256(w.yieldTokenId));
        basketURI = IReceiptForURI(address(basketReceipt)).tokenURI(uint256(w.basketTokenId));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ═══════════════════════════════════════════════════════════
    //  Rescue (admin) — stray assets only; active escrows protected
    // ═══════════════════════════════════════════════════════════

    /// @notice Rescue any stray ERC-20 sent here (contract holds no ERC-20s
    ///         legitimately).
    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue a stray ERC-721. REVERTS if `nft` is yieldReceipt /
    ///         basketReceipt and `tokenId` is currently escrowed by an
    ///         active wrap — those belong to the pass holder.
    function rescueNft(address nft, uint256 tokenId, address to)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (nft == address(yieldReceipt)) {
            uint256 p = yieldEscrowedBy[tokenId];
            if (p != 0) revert NftIsActiveEscrow(nft, tokenId, p);
        } else if (nft == address(basketReceipt)) {
            uint256 p = basketEscrowedBy[tokenId];
            if (p != 0) revert NftIsActiveEscrow(nft, tokenId, p);
        }
        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        emit NftRescued(nft, tokenId, to);
    }

    /// @notice Rescue stray native (contract doesn't accept value by default).
    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    receive() external payable {}
}
