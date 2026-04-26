// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ICCIPRouter, ICCIPReceiver, CCIPClient} from "./ICCIPRouter.sol";

/// @title ArbPositionWrapper
/// @notice Arb-side mirror of a Polygon position NFT. Minted by CCIP message
///         from `PolygonNFTLocker`, burned to trigger a CCIP message back
///         that releases the locked original.
///
///         Implements `estimatePositionValue(uint256) -> (0, 0, total)`, so it
///         drops into the existing NFTValuer VAULT_POSITION mode with the
///         wrapper itself as the "vault" — no valuer changes needed.
///
///         Value is pushed from Polygon via CCIP `VALUE_UPDATE` messages:
///           - on initial lock (seeded in the LOCK_TO_ARB message)
///           - periodically by a keeper calling `locker.pushValueUpdate`
///
///         Wrapper tokenIds are deterministic: keccak256(polyNft, polyTokenId).
contract ArbPositionWrapper is ERC721, AccessControl, ReentrancyGuard, ICCIPReceiver {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    ICCIPRouter public immutable ROUTER;
    uint64      public immutable POLY_SELECTOR;
    address     public polygonLocker;
    IERC20      public immutable LINK;

    uint256 public burnGasLimit = 400_000;

    struct MirrorInfo {
        address polyNft;
        uint256 polyTokenId;
        uint256 lastValueUSDC;   // pushed by Polygon via CCIP
        uint256 lastValueAt;     // last update timestamp
        uint256 lockedAt;
    }
    mapping(uint256 => MirrorInfo) public info;

    event Minted(uint256 indexed wrapperId, address indexed to, address indexed polyNft, uint256 polyTokenId, uint256 valueUSDC);
    event ValueUpdated(uint256 indexed wrapperId, uint256 newValueUSDC);
    event BurnRequested(uint256 indexed wrapperId, address indexed redeemer, bytes32 ccipMessageId);
    event LockerUpdated(address newLocker);
    event BurnGasLimitUpdated(uint256 newLimit);

    error ZeroAddress();
    error NotRouter();
    error BadSourceChain(uint64 got, uint64 expected);
    error BadSender(address got, address expected);
    error UnknownAction(uint8 action);
    error AlreadyMinted(uint256 wrapperId);
    error NotMinted(uint256 wrapperId);
    error NotOwner();
    error FeeTransferFailed();

    constructor(address admin, address router, uint64 polySelector, address link)
        ERC721("Shadow Position Mirror", "spNFT")
    {
        if (admin == address(0) || router == address(0)) revert ZeroAddress();
        ROUTER = ICCIPRouter(router);
        POLY_SELECTOR = polySelector;
        LINK = IERC20(link);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setPolygonLocker(address locker) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (locker == address(0)) revert ZeroAddress();
        polygonLocker = locker;
        emit LockerUpdated(locker);
    }

    function setBurnGasLimit(uint256 g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        burnGasLimit = g;
        emit BurnGasLimitUpdated(g);
    }

    // ════════════════════════════════════════════════════════════
    //  IVaultValue compat — NFTValuer reads this via VAULT_POSITION mode
    // ════════════════════════════════════════════════════════════

    function estimatePositionValue(uint256 wrapperId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total)
    {
        total = info[wrapperId].lastValueUSDC;
        // basketVal + yieldVal left at 0 — this mirror carries a single scalar.
    }

    // ════════════════════════════════════════════════════════════
    //  CCIP receive: handle mint + value-update
    // ════════════════════════════════════════════════════════════

    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external override nonReentrant {
        if (msg.sender != address(ROUTER)) revert NotRouter();
        if (message.sourceChainSelector != POLY_SELECTOR) revert BadSourceChain(message.sourceChainSelector, POLY_SELECTOR);
        address sender = abi.decode(message.sender, (address));
        if (sender != polygonLocker) revert BadSender(sender, polygonLocker);

        // abi.encode(uint8) pads to 32 bytes; decode directly so we read the
        // actual byte value (not the leading zero padding).
        uint8 action = abi.decode(message.data, (uint8));
        if (action == 1) {
            // LOCK_TO_ARB: (action, recipient, polyNft, polyTokenId, valueUSDC)
            (, address recipient, address polyNft, uint256 polyTokenId, uint256 valueUSDC) =
                abi.decode(message.data, (uint8, address, address, uint256, uint256));
            uint256 wid = uint256(keccak256(abi.encode(polyNft, polyTokenId)));
            if (_ownerOf(wid) != address(0)) revert AlreadyMinted(wid);
            info[wid] = MirrorInfo({
                polyNft: polyNft,
                polyTokenId: polyTokenId,
                lastValueUSDC: valueUSDC,
                lastValueAt: block.timestamp,
                lockedAt: block.timestamp
            });
            _safeMint(recipient, wid);
            emit Minted(wid, recipient, polyNft, polyTokenId, valueUSDC);
        } else if (action == 2) {
            // VALUE_UPDATE: (action, polyNft, polyTokenId, valueUSDC)
            (, address polyNft, uint256 polyTokenId, uint256 valueUSDC) =
                abi.decode(message.data, (uint8, address, uint256, uint256));
            uint256 wid = uint256(keccak256(abi.encode(polyNft, polyTokenId)));
            if (_ownerOf(wid) == address(0)) revert NotMinted(wid);
            info[wid].lastValueUSDC = valueUSDC;
            info[wid].lastValueAt = block.timestamp;
            emit ValueUpdated(wid, valueUSDC);
        } else {
            revert UnknownAction(action);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Burn → redeem
    // ════════════════════════════════════════════════════════════

    /// @notice Burn the wrapper and emit a CCIP message instructing the
    ///         Polygon locker to release the original NFT to `redeemer`.
    ///         Caller must own (or be approved on) the wrapper tokenId.
    ///         Pays CCIP fee in LINK (or native if LINK=0).
    function burnAndRedeem(uint256 wrapperId, address redeemer)
        external payable nonReentrant returns (bytes32 messageId)
    {
        address owner = _ownerOf(wrapperId);
        if (owner == address(0)) revert NotMinted(wrapperId);
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender) && getApproved(wrapperId) != msg.sender) {
            revert NotOwner();
        }
        if (redeemer == address(0)) revert ZeroAddress();
        if (polygonLocker == address(0)) revert ZeroAddress();

        _burn(wrapperId);
        delete info[wrapperId];

        // BURN_REDEEM payload: (action=3, wrapperId, redeemer)
        bytes memory payload = abi.encode(uint8(3), wrapperId, redeemer);
        messageId = _sendCCIP(payload);

        emit BurnRequested(wrapperId, redeemer, messageId);
    }

    function _sendCCIP(bytes memory payload) internal returns (bytes32 messageId) {
        CCIPClient.EVMTokenAmount[] memory empty = new CCIPClient.EVMTokenAmount[](0);
        CCIPClient.EVM2AnyMessage memory m = CCIPClient.EVM2AnyMessage({
            receiver:    abi.encode(polygonLocker),
            data:        payload,
            tokenAmounts: empty,
            feeToken:    address(LINK),
            extraArgs:   CCIPClient._argsV2(burnGasLimit, true)
        });
        uint256 fee = ROUTER.getFee(POLY_SELECTOR, m);

        if (address(LINK) == address(0)) {
            if (msg.value < fee) revert FeeTransferFailed();
            messageId = ROUTER.ccipSend{value: fee}(POLY_SELECTOR, m);
            if (msg.value > fee) {
                (bool ok, ) = payable(msg.sender).call{value: msg.value - fee}("");
                if (!ok) revert FeeTransferFailed();
            }
        } else {
            LINK.safeTransferFrom(msg.sender, address(this), fee);
            LINK.forceApprove(address(ROUTER), fee);
            messageId = ROUTER.ccipSend(POLY_SELECTOR, m);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  ERC-165 + tokenURI
    // ════════════════════════════════════════════════════════════

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        // Minimal on-chain metadata so marketplaces can render something.
        // Off-chain indexers can decorate using the original Polygon NFT's tokenURI.
        MirrorInfo memory m = info[tokenId];
        return string(
            abi.encodePacked(
                "data:application/json;utf8,",
                '{"name":"Shadow Position Mirror #', tokenId.toString(),
                '","description":"Arb mirror of a locked Polygon position NFT. Live value from CCIP value-update messages.",',
                '"attributes":[',
                '{"trait_type":"Polygon NFT","value":"', Strings.toHexString(uint160(m.polyNft), 20), '"},',
                '{"trait_type":"Polygon tokenId","value":"', m.polyTokenId.toString(), '"},',
                '{"trait_type":"Last Value USDC","value":"', m.lastValueUSDC.toString(), '"},',
                '{"trait_type":"Last Update","value":"', m.lastValueAt.toString(), '"}',
                "]}"
            )
        );
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    receive() external payable {}
}
