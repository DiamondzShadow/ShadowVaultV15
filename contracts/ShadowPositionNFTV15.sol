// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721Enumerable, ERC721} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IShadowPositionNFT} from "./interfaces/IShadowPositionNFT.sol";
import {IBonusAccumulator} from "./interfaces/IBonusAccumulator.sol";

/// @dev Minimal interface to read live position value from the vault.
interface IVaultValue {
    function estimatePositionValue(uint256 posId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total);
}

/// @title ShadowPositionNFTV15
/// @notice Dynamic on-chain SVG receipt for ShadowVaultV15 positions.
///         Shows pool label, tier, deposit size, boost multiplier, and a
///         live read of the 3 bonus streams (Bridge / SDM / Validator) via
///         the configured BonusAccumulator. Traits update automatically as
///         accruals happen — no re-minting required.
///
/// Roles:
///   DEFAULT_ADMIN_ROLE — deployer EOA → Gnosis Safe post-test
///   VAULT_ROLE        — granted to the ShadowVaultV15 contract(s) allowed to mint/update
contract ShadowPositionNFTV15 is ERC721Enumerable, AccessControl, IShadowPositionNFT {
    using Strings for uint256;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── State ─────────
    uint256 public _nextTokenId = 1;

    /// @notice Short label for the pool this NFT belongs to (e.g. "Blue Chip").
    string public poolLabel;

    /// @notice Yield protocol name (e.g. "Morpho Steakhouse", "GMX V2", "Aave V3").
    string public yieldSource;

    /// @notice Risk tier label (e.g. "Conservative", "Moderate", "Aggressive").
    string public riskTier;

    /// @notice Estimated APY range string (e.g. "2-3%", "15-25%").
    string public apyRange;

    /// @notice BonusAccumulator read for dynamic trait display. Optional.
    IBonusAccumulator public bonusAccumulator;

    /// @notice Vault reference for live position valuation. Optional.
    IVaultValue public vault;

    /// @notice ABI-encoded position snapshot per tokenId.
    ///         layout: (address depositor, uint8 tier, uint256 depositAmount,
    ///                  uint256 wsdmAmount, uint256 yieldShare,
    ///                  uint256 depositTime, uint256 unlockTime, uint256 multiplierBps)
    mapping(uint256 => bytes) public positionData;

    // ───────── Events ─────────
    event BonusAccumulatorSet(address indexed accumulator);
    event PoolLabelSet(string label);

    // ───────── Errors ─────────
    error TokenDoesNotExist();
    error OnlyVault();

    constructor(
        string memory _poolLabel,
        address admin
    ) ERC721("Shadow Vault V15 Position", "svPOS15") {
        poolLabel = _poolLabel;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════
    //  IShadowPositionNFT
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IShadowPositionNFT
    function mint(address to, bytes calldata posData)
        external
        virtual
        override
        onlyRole(VAULT_ROLE)
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        positionData[tokenId] = posData;
        _safeMint(to, tokenId);
    }

    /// @inheritdoc IShadowPositionNFT
    function updatePositionData(uint256 tokenId, bytes calldata posData)
        external
        virtual
        override
        onlyRole(VAULT_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        positionData[tokenId] = posData;
    }

    /// @inheritdoc IShadowPositionNFT
    function ownerOf(uint256 tokenId)
        public
        view
        override(ERC721, IERC721, IShadowPositionNFT)
        returns (address)
    {
        return super.ownerOf(tokenId);
    }

    // ═══════════════════════════════════════════════════════════
    //  Dynamic on-chain SVG tokenURI
    // ═══════════════════════════════════════════════════════════

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();

        (
            , // depositor
            uint8 tier,
            uint256 depositAmount,
            uint256 wsdmAmount,
            uint256 yieldShare,
            , // depositTime
            , // unlockTime
            uint256 multiplierBps
        ) = abi.decode(
            positionData[tokenId],
            (address, uint8, uint256, uint256, uint256, uint256, uint256, uint256)
        );

        // Pull live bonus accrual (USDC, 6-dec). Falls back to 0 if accumulator not wired.
        uint256 bonus = address(bonusAccumulator) != address(0)
            ? bonusAccumulator.pendingForToken(tokenId)
            : 0;

        // Pull live position value from the vault (USDC, 6-dec).
        uint256 liveBasketVal;
        uint256 liveYieldVal;
        uint256 liveTotal;
        if (address(vault) != address(0)) {
            try vault.estimatePositionValue(tokenId) returns (uint256 b, uint256 y, uint256 t) {
                liveBasketVal = b;
                liveYieldVal = y;
                liveTotal = t;
            } catch {}
        }

        string memory svg = _buildSvg(
            tokenId, tier, depositAmount, wsdmAmount, yieldShare, multiplierBps, bonus,
            liveBasketVal, liveYieldVal, liveTotal
        );

        string memory json = string(
            abi.encodePacked(
                '{"name":"Shadow Vault V15 Position #',
                tokenId.toString(),
                '","description":"On-chain receipt for a Shadow Vault V15 position. Dynamic traits update in real-time: live portfolio value, bonus accrual, yield share.",',
                '"attributes":', _buildAttributes(tier, depositAmount, multiplierBps, bonus, liveTotal), ',',
                '"image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(svg)),
                '"}'
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ═══════════════════════════════════════════════════════════
    //  SVG builder
    // ═══════════════════════════════════════════════════════════

    function _buildSvg(
        uint256 tokenId,
        uint8 tier,
        uint256 depositAmount,
        uint256 wsdmAmount,
        uint256 yieldShare,
        uint256 multiplierBps,
        uint256 bonus,
        uint256 liveBasketVal,
        uint256 liveYieldVal,
        uint256 liveTotal
    ) internal view returns (string memory) {
        string memory color = _tierColor(tier);

        string memory part1 = string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">'
                '<rect width="400" height="560" rx="16" fill="#0f0f14"/>'
                '<rect width="400" height="6" fill="', color, '"/>'
                '<text x="200" y="50" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="20" font-weight="bold">Shadow Vault V15</text>'
                '<text x="200" y="78" text-anchor="middle" fill="#888888" font-family="monospace" font-size="13">',
                poolLabel, ' &#x2022; ', yieldSource, ' &#x2022; #', tokenId.toString(),
                '</text>'
                '<line x1="40" y1="100" x2="360" y2="100" stroke="#2a2a35" stroke-width="1"/>'
            )
        );

        string memory part2 = string(
            abi.encodePacked(
                '<text x="40" y="135" fill="#aaaaaa" font-family="monospace" font-size="13">Tier</text>'
                '<text x="360" y="135" text-anchor="end" fill="', color, '" font-family="monospace" font-size="13">',
                _tierName(tier),
                '</text>'
                '<text x="40" y="170" fill="#aaaaaa" font-family="monospace" font-size="13">Deposit</text>'
                '<text x="360" y="170" text-anchor="end" fill="#ffffff" font-family="monospace" font-size="13">$',
                _toDecimalString(depositAmount, 6, 2),
                ' USDC</text>'
                '<text x="40" y="205" fill="#aaaaaa" font-family="monospace" font-size="13">Boost</text>'
                '<text x="360" y="205" text-anchor="end" fill="#ffffff" font-family="monospace" font-size="13">',
                _toDecimalString(multiplierBps, 4, 2),
                'x</text>'
            )
        );

        string memory part3 = string(
            abi.encodePacked(
                '<line x1="40" y1="230" x2="360" y2="230" stroke="#2a2a35" stroke-width="1"/>'
                '<text x="40" y="262" fill="#aaaaaa" font-family="monospace" font-size="13">Basket Share</text>'
                '<text x="360" y="262" text-anchor="end" fill="#ffffff" font-family="monospace" font-size="13">',
                _toDecimalString(wsdmAmount, 6, 2),
                ' wSDM</text>'
                '<text x="40" y="292" fill="#aaaaaa" font-family="monospace" font-size="13">Yield Share</text>'
                '<text x="360" y="292" text-anchor="end" fill="#ffffff" font-family="monospace" font-size="13">$',
                _toDecimalString(yieldShare, 6, 2),
                '</text>'
                '<line x1="40" y1="320" x2="360" y2="320" stroke="#2a2a35" stroke-width="1"/>'
            )
        );

        // Live value section — dynamic portfolio valuation
        string memory pnlColor = liveTotal >= depositAmount ? "#22c55e" : "#ef4444";
        string memory pnlSign = liveTotal >= depositAmount ? "+" : "-";
        uint256 pnlAbs = liveTotal >= depositAmount
            ? liveTotal - depositAmount
            : depositAmount - liveTotal;

        string memory part4 = string(
            abi.encodePacked(
                '<text x="40" y="352" fill="#aaaaaa" font-family="monospace" font-size="13">Bonus Streams</text>'
                '<text x="360" y="352" text-anchor="end" fill="#22c55e" font-family="monospace" font-size="13">$',
                _toDecimalString(bonus, 6, 2),
                '</text>'
                '<rect x="40" y="372" width="320" height="108" rx="8" fill="#1a1a24"/>'
                '<text x="200" y="396" text-anchor="middle" fill="#aaaaaa" font-family="monospace" font-size="11">LIVE PORTFOLIO VALUE</text>'
                '<text x="200" y="420" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="20" font-weight="bold">$',
                _toDecimalString(liveTotal, 6, 2),
                '</text>'
            )
        );

        string memory part5 = string(
            abi.encodePacked(
                '<text x="56" y="444" fill="#aaaaaa" font-family="monospace" font-size="10">Basket</text>'
                '<text x="200" y="444" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="10">$',
                _toDecimalString(liveBasketVal, 6, 2),
                '</text>'
                '<text x="280" y="444" fill="#aaaaaa" font-family="monospace" font-size="10">Yield</text>'
                '<text x="344" y="444" text-anchor="end" fill="#ffffff" font-family="monospace" font-size="10">$',
                _toDecimalString(liveYieldVal, 6, 2),
                '</text>'
                '<text x="200" y="468" text-anchor="middle" fill="', pnlColor, '" font-family="monospace" font-size="12">',
                pnlSign, '$', _toDecimalString(pnlAbs, 6, 2), ' PnL',
                '</text>'
                '<rect x="40" y="500" width="320" height="40" rx="8" fill="#1a1a24"/>'
                '<text x="200" y="526" text-anchor="middle" fill="', color, '" font-family="monospace" font-size="12">SHADOW VAULT V15 &#x2022; ON-CHAIN RECEIPT</text>'
                '</svg>'
            )
        );

        return string(abi.encodePacked(part1, part2, part3, part4, part5));
    }

    function _buildAttributes(
        uint8 tier,
        uint256 depositAmount,
        uint256 multiplierBps,
        uint256 bonus,
        uint256 liveTotal
    ) internal view returns (string memory) {
        string memory part1 = string(abi.encodePacked(
            '[',
            '{"trait_type":"Pool","value":"', poolLabel, '"},',
            '{"trait_type":"Yield Source","value":"', yieldSource, '"},',
            '{"trait_type":"Risk Tier","value":"', riskTier, '"},',
            '{"trait_type":"APY Range","value":"', apyRange, '"},',
            '{"trait_type":"Lock Tier","value":"', _tierName(tier), '"},'
        ));
        string memory part2 = string(abi.encodePacked(
            '{"trait_type":"Deposit USDC","display_type":"number","value":', (depositAmount / 1e6).toString(), '},',
            '{"trait_type":"Current Value USDC","display_type":"number","value":', (liveTotal / 1e6).toString(), '},',
            '{"trait_type":"Boost","value":"', _toDecimalString(multiplierBps, 4, 2), 'x"},',
            '{"trait_type":"Bonus Accrued USDC","display_type":"number","value":', (bonus / 1e6).toString(), '}',
            ']'
        ));
        return string(abi.encodePacked(part1, part2));
    }

    // ═══════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════

    function _tierName(uint8 tier) internal pure returns (string memory) {
        if (tier == 0) return "FLEX";
        if (tier == 1) return "30D";
        if (tier == 2) return "90D";
        if (tier == 3) return "180D";
        if (tier == 4) return "365D";
        return "UNKNOWN";
    }

    function _tierColor(uint8 tier) internal pure returns (string memory) {
        if (tier == 0) return "#22c55e"; // green
        if (tier == 1) return "#3b82f6"; // blue
        if (tier == 2) return "#a855f7"; // purple
        if (tier == 3) return "#eab308"; // gold
        if (tier == 4) return "#ef4444"; // red
        return "#888888";
    }

    function _toDecimalString(uint256 value, uint8 decimals, uint8 displayDecimals)
        internal
        pure
        returns (string memory)
    {
        uint256 divisor = 10 ** uint256(decimals);
        uint256 wholePart = value / divisor;
        uint256 fracPart = value % divisor;

        if (decimals > displayDecimals) {
            fracPart /= 10 ** uint256(decimals - displayDecimals);
        } else if (decimals < displayDecimals) {
            fracPart *= 10 ** uint256(displayDecimals - decimals);
        }

        string memory fracStr = fracPart.toString();
        bytes memory fracBytes = bytes(fracStr);
        bytes memory padded = new bytes(displayDecimals);
        uint256 padLen = displayDecimals - fracBytes.length;
        for (uint256 i = 0; i < padLen; i++) {
            padded[i] = "0";
        }
        for (uint256 i = 0; i < fracBytes.length; i++) {
            padded[padLen + i] = fracBytes[i];
        }

        return string(abi.encodePacked(wholePart.toString(), ".", string(padded)));
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function setBonusAccumulator(address accumulator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bonusAccumulator = IBonusAccumulator(accumulator);
        emit BonusAccumulatorSet(accumulator);
    }

    function setVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        vault = IVaultValue(_vault);
    }

    function setYieldSource(string calldata _yieldSource) external onlyRole(DEFAULT_ADMIN_ROLE) {
        yieldSource = _yieldSource;
    }

    function setRiskTier(string calldata _riskTier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        riskTier = _riskTier;
    }

    function setApyRange(string calldata _apyRange) external onlyRole(DEFAULT_ADMIN_ROLE) {
        apyRange = _apyRange;
    }

    /// @notice Sync the NFT token counter with the vault's position counter.
    ///         Call once after deploying a new NFT on an existing vault.
    function syncNextTokenId(uint256 nextId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _nextTokenId = nextId;
    }

    function setPoolLabel(string calldata label) external onlyRole(DEFAULT_ADMIN_ROLE) {
        poolLabel = label;
        emit PoolLabelSet(label);
    }

    /// @notice Grant VAULT_ROLE to a vault contract.
    function addVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, _vault);
    }

    function removeVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, _vault);
    }

    // ═══════════════════════════════════════════════════════════
    //  Required overrides
    // ═══════════════════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
