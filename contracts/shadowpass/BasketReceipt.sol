// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IShadowPositionNFT} from "../interfaces/IShadowPositionNFT.sol";

interface IBasketNav {
    function getNavLenient(uint64 basketId)
        external
        view
        returns (uint256 navUsd6, uint64 at, bool stale, bool frozen);
    function baskets(uint64 basketId)
        external
        view
        returns (bool registered, uint256 lastNavUsd6, uint64 lastNavAt, uint32 maxStalenessSecs, uint16 maxDriftBps, bool paused, string memory name);
}

/// @title BasketReceipt
/// @notice ERC-721 representing the basket leg (directional exposure to a
///         registered basket of HC spot assets) of a V15 position. Independent
///         of yield. Tradeable standalone. Wrappable (with a matching
///         YieldReceipt) into a ShadowPass composite.
///
/// @dev    Value model:
///         - Per token we store `shares` = USDC-6 value deposited at entry.
///         - At mint time we also snapshot `entryNavUsd6` from the NAV oracle.
///         - Live value = `shares * (currentNav / entryNavUsd6)` where
///           currentNav comes from the BasketNavOracle (keeper-pushed).
///         - If the oracle is stale / frozen, tokenURI still renders using
///           last-known NAV and flags the status.
contract BasketReceipt is ERC721, AccessControl, IShadowPositionNFT {
    using Strings for uint256;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    struct Position {
        uint64  basketId;
        uint64  depositTime;
        uint128 sharesUsd6;       // principal at entry (6-dec USDC)
        uint128 entryNavUsd6;     // oracle NAV at entry
        uint8   tier;
    }

    mapping(uint256 => Position) public positionOf;
    IBasketNav public immutable navOracle;
    uint256 private _nextTokenId;

    // Vault registry so VAULT_ROLE can be granted surgically.
    mapping(address => bool) public isVault;

    // ───────── Events ─────────
    event VaultRegistered(address indexed vault);
    event VaultDeregistered(address indexed vault);
    event BasketReceiptMinted(uint256 indexed tokenId, address indexed to, uint64 basketId, uint128 sharesUsd6, uint128 entryNavUsd6);

    // ───────── Errors ─────────
    error TokenDoesNotExist();
    error NavUnavailable(uint64 basketId);
    error BadBasket();

    constructor(address admin, address navOracle_)
        ERC721("ShadowVault Basket Receipt", "BASK")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        navOracle = IBasketNav(navOracle_);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function registerVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isVault[vault_] = true;
        _grantRole(VAULT_ROLE, vault_);
        emit VaultRegistered(vault_);
    }

    function deregisterVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isVault[vault_] = false;
        _revokeRole(VAULT_ROLE, vault_);
        emit VaultDeregistered(vault_);
    }

    // ═══════════════════════════════════════════════════════════
    //  IShadowPositionNFT — vault-facing mint / update
    // ═══════════════════════════════════════════════════════════

    /// @dev posData: abi.encode(uint64 basketId, uint128 sharesUsd6, uint8 tier)
    function mint(address to, bytes calldata posData)
        external
        override
        onlyRole(VAULT_ROLE)
        returns (uint256 tokenId)
    {
        (uint64 basketId, uint128 sharesUsd6, uint8 tier) = abi.decode(posData, (uint64, uint128, uint8));
        // Snapshot entry NAV — revert if the basket isn't even registered
        (uint256 navUsd6, , , ) = navOracle.getNavLenient(basketId);
        if (navUsd6 == 0) revert NavUnavailable(basketId);

        tokenId = ++_nextTokenId;
        positionOf[tokenId] = Position({
            basketId: basketId,
            depositTime: uint64(block.timestamp),
            sharesUsd6: sharesUsd6,
            entryNavUsd6: uint128(navUsd6),
            tier: tier
        });
        _safeMint(to, tokenId);
        emit BasketReceiptMinted(tokenId, to, basketId, sharesUsd6, uint128(navUsd6));
    }

    function updatePositionData(uint256 tokenId, bytes calldata posData)
        external
        override
        onlyRole(VAULT_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        (uint64 basketId, uint128 sharesUsd6, uint8 tier) = abi.decode(posData, (uint64, uint128, uint8));
        Position storage p = positionOf[tokenId];
        if (basketId != p.basketId) revert BadBasket();
        p.sharesUsd6 = sharesUsd6;
        p.tier = tier;
    }

    function ownerOf(uint256 tokenId)
        public
        view
        override(ERC721, IShadowPositionNFT)
        returns (address)
    {
        return super.ownerOf(tokenId);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    /// @notice Current value in USDC-6 for this token. Uses last-known NAV
    ///         even if stale (flagged via `stale`/`frozen` flags).
    function liveValue(uint256 tokenId)
        public
        view
        returns (uint256 valueUsd6, bool stale, bool frozen)
    {
        if (_ownerOf(tokenId) == address(0)) return (0, false, false);
        Position memory p = positionOf[tokenId];
        (uint256 navNow, , bool s, bool f) = navOracle.getNavLenient(p.basketId);
        stale = s; frozen = f;
        if (p.entryNavUsd6 == 0 || navNow == 0) return (p.sharesUsd6, s, f);
        valueUsd6 = (uint256(p.sharesUsd6) * navNow) / uint256(p.entryNavUsd6);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        Position memory p = positionOf[tokenId];
        (uint256 valueUsd6, bool stale, bool frozen) = liveValue(tokenId);

        ( , , , , , , string memory basketName) = navOracle.baskets(p.basketId);
        string[5] memory tierNames = ["FLEX","30D","90D","180D","365D"];
        string memory statusLabel = frozen ? "FROZEN" : (stale ? "STALE" : "LIVE");

        string memory attrs = string(abi.encodePacked(
            '[',
            '{"trait_type":"Kind","value":"Basket Receipt"},',
            '{"trait_type":"Basket","value":"', basketName, '"},',
            '{"trait_type":"Basket ID","display_type":"number","value":', uint256(p.basketId).toString(), '},',
            '{"trait_type":"Lock Tier","value":"', tierNames[p.tier], '"},',
            '{"trait_type":"Principal USDC","display_type":"number","value":', _usd(p.sharesUsd6), '},',
            '{"trait_type":"Current Value USDC","display_type":"number","value":', _usd(valueUsd6), '},',
            '{"trait_type":"NAV Status","value":"', statusLabel, '"}',
            ']'
        ));

        string memory svg = _svg(tokenId, basketName, p.sharesUsd6, valueUsd6, tierNames[p.tier], statusLabel);
        string memory json = string(abi.encodePacked(
            '{"name":"Basket Receipt #', tokenId.toString(),
            '","description":"Basket leg of a ShadowVault V15 position (keeper-pushed NAV). Tradeable standalone. Wrap with a YieldReceipt to form a ShadowPass.",',
            '"attributes":', attrs, ',',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _usd(uint256 usd6) internal pure returns (string memory) {
        return (usd6 / 1e6).toString();
    }

    function _svg(uint256 tokenId, string memory basket, uint128 principal, uint256 currentVal, string memory tier, string memory status)
        internal pure returns (string memory)
    {
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">',
            '<rect width="400" height="560" rx="16" fill="#0f0f14"/>',
            '<rect width="400" height="6" fill="#3b82f6"/>',
            '<text x="200" y="50" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="20" font-weight="bold">BASKET RECEIPT</text>',
            '<text x="200" y="80" text-anchor="middle" fill="#888" font-family="monospace" font-size="13">', basket, ' &#x2022; #', tokenId.toString(), '</text>',
            '<text x="200" y="220" text-anchor="middle" fill="#3b82f6" font-family="monospace" font-size="40" font-weight="bold">$', _usd(currentVal), '</text>',
            '<text x="200" y="250" text-anchor="middle" fill="#888" font-family="monospace" font-size="12">CURRENT VALUE</text>',
            '<text x="200" y="330" text-anchor="middle" fill="#888" font-family="monospace" font-size="16">principal $', _usd(principal), '</text>',
            '<text x="200" y="400" text-anchor="middle" fill="#c084fc" font-family="monospace" font-size="14">Tier: ', tier, '</text>',
            '<text x="200" y="430" text-anchor="middle" fill="#f59e0b" font-family="monospace" font-size="12">NAV: ', status, '</text>',
            '<text x="200" y="510" text-anchor="middle" fill="#555" font-family="monospace" font-size="10">ShadowPass \u00b7 Basket Leg</text>',
            '</svg>'
        ));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
