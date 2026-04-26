// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IShadowPositionNFT} from "../interfaces/IShadowPositionNFT.sol";

/// @title YieldReceipt
/// @notice ERC-721 representing the yield leg of a V15 position — independent
///         of any basket exposure. Tradeable standalone. Wrappable (together
///         with a matching BasketReceipt) into a ShadowPass composite.
///
/// @dev    Per-token state stores strategyId + principal + tier + depositTime.
///         The live accrued yield displayed in the tokenURI is pulled at read
///         time from the registered `yieldAdapter` (its `totalAssets` vs
///         `totalPrincipal` ratio applied to this token's principal share).
///         This keeps the NFT value moving in real time without on-chain writes.
contract YieldReceipt is ERC721, AccessControl, IShadowPositionNFT {
    using Strings for uint256;

    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    struct Position {
        uint64  strategyId;    // which yield strategy (vault instance)
        uint64  depositTime;
        uint128 principalUsd6; // USDC 6-dec
        uint8   tier;          // FLEX=0, 30D=1, 90D=2, 180D=3, 365D=4
    }

    struct Strategy {
        string  name;              // "HyperCash", "HyperLeverage", etc.
        address vault;             // the minting vault
        address yieldAdapter;      // adapter exposing totalAssets()/totalPrincipal()
        string  yieldSource;       // "Hyperliquid HLP"
        string  apyRange;          // "~20%"
        bool    active;
    }

    /// @notice Per-token state.
    mapping(uint256 => Position) public positionOf;

    /// @notice Strategy registry keyed by strategyId (also the vault's internal id).
    Strategy[] public strategies;

    uint256 private _nextTokenId;

    // ───────── Events ─────────
    event StrategyRegistered(uint64 indexed id, string name, address vault, address yieldAdapter);
    event StrategyDeactivated(uint64 indexed id);
    event YieldReceiptMinted(uint256 indexed tokenId, address indexed to, uint64 strategyId, uint128 principalUsd6, uint8 tier);

    // ───────── Errors ─────────
    error UnknownStrategy(uint64 id);
    error StrategyInactive(uint64 id);
    error TokenDoesNotExist();
    error NoStrategyForVault(address vault);

    constructor(address admin) ERC721("ShadowVault Yield Receipt", "YIELD") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function registerStrategy(
        string calldata name_,
        address vault_,
        address yieldAdapter_,
        string calldata yieldSource_,
        string calldata apyRange_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint64 id) {
        strategies.push(Strategy({
            name: name_, vault: vault_, yieldAdapter: yieldAdapter_,
            yieldSource: yieldSource_, apyRange: apyRange_, active: true
        }));
        id = uint64(strategies.length - 1);
        _grantRole(VAULT_ROLE, vault_);
        emit StrategyRegistered(id, name_, vault_, yieldAdapter_);
    }

    function deactivateStrategy(uint64 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (id >= strategies.length) revert UnknownStrategy(id);
        strategies[id].active = false;
        emit StrategyDeactivated(id);
    }

    // ═══════════════════════════════════════════════════════════
    //  IShadowPositionNFT — vault-facing mint / update
    // ═══════════════════════════════════════════════════════════

    /// @dev posData: abi.encode(uint128 principalUsd6, uint8 tier)
    function mint(address to, bytes calldata posData)
        external
        override
        onlyRole(VAULT_ROLE)
        returns (uint256 tokenId)
    {
        (uint128 principalUsd6, uint8 tier) = abi.decode(posData, (uint128, uint8));
        uint64 strategyId = _strategyIdOfVault(msg.sender);
        tokenId = ++_nextTokenId;
        positionOf[tokenId] = Position({
            strategyId: strategyId,
            depositTime: uint64(block.timestamp),
            principalUsd6: principalUsd6,
            tier: tier
        });
        _safeMint(to, tokenId);
        emit YieldReceiptMinted(tokenId, to, strategyId, principalUsd6, tier);
    }

    function updatePositionData(uint256 tokenId, bytes calldata posData)
        external
        override
        onlyRole(VAULT_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        (uint128 principalUsd6, uint8 tier) = abi.decode(posData, (uint128, uint8));
        Position storage p = positionOf[tokenId];
        p.principalUsd6 = principalUsd6;
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

    /// @notice Live accrued-yield estimate in USDC-6 for this token.
    ///         = principal * (adapter.totalAssets / adapter.totalPrincipal - 1)
    /// @dev    Returns 0 if adapter is unreadable (keeps tokenURI from reverting).
    function liveAccruedYield(uint256 tokenId) public view returns (uint256) {
        if (_ownerOf(tokenId) == address(0)) return 0;
        Position memory p = positionOf[tokenId];
        Strategy memory s = strategies[p.strategyId];
        if (s.yieldAdapter == address(0)) return 0;
        try IAdapterView(s.yieldAdapter).totalAssets() returns (uint256 ta) {
            try IAdapterView(s.yieldAdapter).totalPrincipal() returns (uint256 tp) {
                if (tp == 0 || ta <= tp) return 0;
                // pro-rata: (ta - tp) * principal / tp
                return ((ta - tp) * uint256(p.principalUsd6)) / tp;
            } catch { return 0; }
        } catch { return 0; }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        Position memory p = positionOf[tokenId];
        Strategy memory s = strategies[p.strategyId];
        uint256 accrued = liveAccruedYield(tokenId);
        string[5] memory tierNames = ["FLEX","30D","90D","180D","365D"];

        string memory attrs = string(abi.encodePacked(
            '[',
            '{"trait_type":"Kind","value":"Yield Receipt"},',
            '{"trait_type":"Strategy","value":"', s.name, '"},',
            '{"trait_type":"Yield Source","value":"', s.yieldSource, '"},',
            '{"trait_type":"APY Range","value":"', s.apyRange, '"},',
            '{"trait_type":"Lock Tier","value":"', tierNames[p.tier], '"},',
            '{"trait_type":"Principal USDC","display_type":"number","value":', _usd(p.principalUsd6), '},',
            '{"trait_type":"Accrued Yield USDC","display_type":"number","value":', _usd(accrued), '}',
            ']'
        ));

        string memory svg = _svg(tokenId, s.name, p.principalUsd6, accrued, tierNames[p.tier]);
        string memory json = string(abi.encodePacked(
            '{"name":"Yield Receipt #', tokenId.toString(),
            '","description":"Yield leg of a ShadowVault V15 position. Tradeable standalone. Wrap with a BasketReceipt to form a ShadowPass.",',
            '"attributes":', attrs, ',',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _strategyIdOfVault(address vault_) internal view returns (uint64) {
        uint256 n = strategies.length;
        for (uint256 i; i < n; ++i) {
            if (strategies[i].vault == vault_ && strategies[i].active) return uint64(i);
        }
        revert NoStrategyForVault(vault_);
    }

    function _usd(uint256 usd6) internal pure returns (string memory) {
        // integer USDC for JSON display (truncates cents)
        return (usd6 / 1e6).toString();
    }

    function _svg(uint256 tokenId, string memory strategy, uint128 principalUsd6, uint256 accruedUsd6, string memory tier)
        internal pure returns (string memory)
    {
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">',
            '<rect width="400" height="560" rx="16" fill="#0f0f14"/>',
            '<rect width="400" height="6" fill="#22c55e"/>',
            '<text x="200" y="50" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="20" font-weight="bold">YIELD RECEIPT</text>',
            '<text x="200" y="80" text-anchor="middle" fill="#888" font-family="monospace" font-size="13">', strategy, ' &#x2022; #', tokenId.toString(), '</text>',
            '<text x="200" y="220" text-anchor="middle" fill="#22c55e" font-family="monospace" font-size="40" font-weight="bold">$', _usd(principalUsd6), '</text>',
            '<text x="200" y="250" text-anchor="middle" fill="#888" font-family="monospace" font-size="12">PRINCIPAL</text>',
            '<text x="200" y="330" text-anchor="middle" fill="#4ade80" font-family="monospace" font-size="28" font-weight="bold">+$', _usd(accruedUsd6), '</text>',
            '<text x="200" y="360" text-anchor="middle" fill="#888" font-family="monospace" font-size="12">ACCRUED</text>',
            '<text x="200" y="460" text-anchor="middle" fill="#c084fc" font-family="monospace" font-size="14">Tier: ', tier, '</text>',
            '<text x="200" y="510" text-anchor="middle" fill="#555" font-family="monospace" font-size="10">ShadowPass \u00b7 Yield Leg</text>',
            '</svg>'
        ));
    }

    // ═══════════════════════════════════════════════════════════
    //  ERC165
    // ═══════════════════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

/// @dev Minimal interface for the live accrued-yield estimate.
interface IAdapterView {
    function totalAssets() external view returns (uint256);
    function totalPrincipal() external view returns (uint256);
}
