// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {OApp, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {OAppOptionsType3} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";

/// @title HyperPositionWrapper
/// @notice Arb-side mirror of a HyperEVM position NFT, minted by LayerZero
///         message from HyperPositionLocker. Burned to trigger a CCIP message
///         back that releases the locked original.
///
///         Implements `estimatePositionValue(uint256) -> (0, 0, total)` so it
///         drops into NFTValuer's VAULT_MIRROR mode with no additional code —
///         exactly the same shape as our CCIP ArbPositionWrapper.
///
///         Security model (per Zellic OApp audit + KelpDAO lesson):
///           - Only `_lzReceive` overridden (lzReceive stays audited)
///           - DVN config pinned via `endpoint.setConfig` post-deploy:
///               requiredDVNs = [LZ Labs, Nethermind] (2/2)
///               optionalDVNs = [Horizen, BitGo]     (1/2)
///           - `setPeer(srcEid, bytes32(remote))` before first receive
///           - Owner / delegate = per-chain Safe
contract HyperPositionWrapper is ERC721, OApp, OAppOptionsType3, AccessControl, ReentrancyGuard {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    uint8 public constant ACT_LOCK_TO_ARB  = 1;
    uint8 public constant ACT_VALUE_UPDATE = 2;
    uint8 public constant ACT_BURN_REDEEM  = 3;

    uint32 public immutable HYPER_EID;
    uint128 public srcGasLimit = 400_000;

    struct MirrorInfo {
        address hyperNft;
        uint256 hyperTokenId;
        uint256 lastValueUSDC;
        uint256 lastValueAt;
        uint256 lockedAt;
    }
    mapping(uint256 => MirrorInfo) public info;

    event Minted(uint256 indexed wrapperId, address indexed to, address indexed hyperNft, uint256 hyperTokenId, uint256 valueUSDC);
    event ValueUpdated(uint256 indexed wrapperId, uint256 newValueUSDC);
    event BurnRequested(uint256 indexed wrapperId, address indexed redeemer, bytes32 messageId);
    event SrcGasLimitUpdated(uint128 newLimit);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event NativeRescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadSourceChain(uint32 got, uint32 expected);
    error UnknownAction(uint8 action);
    error AlreadyMinted(uint256 wrapperId);
    error NotMinted(uint256 wrapperId);
    error NotOwner();
    error CannotRescueSelf();
    error NativeRescueFailed();

    constructor(address admin, address endpoint, uint32 hyperEid)
        ERC721("Shadow Hyper Position Mirror", "shNFT")
        OApp(endpoint, admin)
        Ownable(admin)
    {
        if (admin == address(0) || endpoint == address(0)) revert ZeroAddress();
        HYPER_EID = hyperEid;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setSrcGasLimit(uint128 g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        srcGasLimit = g;
        emit SrcGasLimitUpdated(g);
    }

    // ════════════════════════════════════════════════════════════
    //  IVaultValue compat — NFTValuer reads via VAULT_MIRROR mode
    // ════════════════════════════════════════════════════════════

    function estimatePositionValue(uint256 wrapperId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total)
    {
        total = info[wrapperId].lastValueUSDC;
    }

    // ════════════════════════════════════════════════════════════
    //  Burn → redeem
    // ════════════════════════════════════════════════════════════

    function quoteBurn(uint256 wrapperId, address redeemer, bytes calldata extraOptions)
        external view returns (MessagingFee memory fee)
    {
        bytes memory payload = abi.encode(ACT_BURN_REDEEM, wrapperId, redeemer);
        bytes memory options = combineOptions(HYPER_EID, uint16(ACT_BURN_REDEEM), extraOptions);
        return _quote(HYPER_EID, payload, options, false);
    }

    /// @notice Burn the wrapper and send a LayerZero message to HyperEVM
    ///         locker to release the original NFT to `redeemer`. Caller pays
    ///         LZ fee in native ETH via msg.value.
    function burnAndRedeem(uint256 wrapperId, address redeemer, bytes calldata extraOptions)
        external payable nonReentrant returns (bytes32 messageId)
    {
        address owner_ = _ownerOf(wrapperId);
        if (owner_ == address(0)) revert NotMinted(wrapperId);
        if (
            msg.sender != owner_ &&
            !isApprovedForAll(owner_, msg.sender) &&
            getApproved(wrapperId) != msg.sender
        ) revert NotOwner();
        if (redeemer == address(0)) revert ZeroAddress();

        _burn(wrapperId);
        delete info[wrapperId];

        bytes memory payload = abi.encode(ACT_BURN_REDEEM, wrapperId, redeemer);
        bytes memory options = combineOptions(HYPER_EID, uint16(ACT_BURN_REDEEM), extraOptions);
        MessagingReceipt memory r = _lzSend(
            HYPER_EID, payload, options,
            MessagingFee({nativeFee: msg.value, lzTokenFee: 0}),
            payable(msg.sender)
        );
        messageId = r.guid;

        emit BurnRequested(wrapperId, redeemer, messageId);
    }

    // ════════════════════════════════════════════════════════════
    //  LZ inbound: mint + value-update from HyperEVM locker
    //  Only `_lzReceive` overridden (Zellic mandate).
    // ════════════════════════════════════════════════════════════

    function _lzReceive(
        Origin calldata _origin,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        if (_origin.srcEid != HYPER_EID) revert BadSourceChain(_origin.srcEid, HYPER_EID);

        uint8 action = abi.decode(_message, (uint8));
        if (action == ACT_LOCK_TO_ARB) {
            (, address recipient, address hyperNft, uint256 hyperTokenId, uint256 valueUSDC) =
                abi.decode(_message, (uint8, address, address, uint256, uint256));
            uint256 wid = uint256(keccak256(abi.encode(hyperNft, hyperTokenId)));
            if (_ownerOf(wid) != address(0)) revert AlreadyMinted(wid);
            info[wid] = MirrorInfo({
                hyperNft: hyperNft,
                hyperTokenId: hyperTokenId,
                lastValueUSDC: valueUSDC,
                lastValueAt: block.timestamp,
                lockedAt: block.timestamp
            });
            _safeMint(recipient, wid);
            emit Minted(wid, recipient, hyperNft, hyperTokenId, valueUSDC);
        } else if (action == ACT_VALUE_UPDATE) {
            (, address hyperNft, uint256 hyperTokenId, uint256 valueUSDC) =
                abi.decode(_message, (uint8, address, uint256, uint256));
            uint256 wid = uint256(keccak256(abi.encode(hyperNft, hyperTokenId)));
            if (_ownerOf(wid) == address(0)) revert NotMinted(wid);
            info[wid].lastValueUSDC = valueUSDC;
            info[wid].lastValueAt = block.timestamp;
            emit ValueUpdated(wid, valueUSDC);
        } else {
            revert UnknownAction(action);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  tokenURI + ERC-165
    // ════════════════════════════════════════════════════════════

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        MirrorInfo memory m = info[tokenId];
        return string(
            abi.encodePacked(
                "data:application/json;utf8,",
                '{"name":"Shadow Hyper Position Mirror #', tokenId.toString(),
                '","description":"Arb mirror of a locked HyperEVM position NFT (LayerZero v2).",',
                '"attributes":[',
                '{"trait_type":"Hyper NFT","value":"', Strings.toHexString(uint160(m.hyperNft), 20), '"},',
                '{"trait_type":"Hyper tokenId","value":"', m.hyperTokenId.toString(), '"},',
                '{"trait_type":"Last Value USDC","value":"', m.lastValueUSDC.toString(), '"},',
                '{"trait_type":"Last Update","value":"', m.lastValueAt.toString(), '"}',
                "]}"
            )
        );
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(id);
    }

    // ════════════════════════════════════════════════════════════
    //  Rescue (admin) — stray assets only
    // ════════════════════════════════════════════════════════════

    /// @notice Rescue any ERC-20 accidentally sent to the wrapper.
    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue a stray external ERC-721. REVERTS on attempts to
    ///         rescue this contract's own minted mirrors — those are
    ///         destroyed only via burnAndRedeem().
    function rescueNft(address nft, uint256 tokenId, address to)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (nft == address(this)) revert CannotRescueSelf();
        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        emit NftRescued(nft, tokenId, to);
    }

    /// @notice Rescue stray native ETH. Wrapper holds native only
    ///         transiently for LZ fee refunds.
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
