// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {OApp, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {OAppOptionsType3} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";

interface IHyperVault {
    function estimatePositionValue(uint256 posId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total);
}

/// @title HyperPositionLocker
/// @notice HyperEVM-side of the Hyper↔Arb NFT bridge. Mirrors our CCIP
///         PolygonNFTLocker shape but uses LayerZero v2 as the transport.
///         Action codes (first uint8 of payload):
///           0x01  LOCK_TO_ARB       (Hyper→Arb)  mints wrapper
///           0x02  VALUE_UPDATE      (Hyper→Arb)  refreshes stored value
///           0x03  BURN_REDEEM       (Arb→Hyper)  releases original NFT
///
///         Hard-learned constraints from the KelpDAO post-mortem + Zellic
///         OApp audit (23 SEP 2025):
///           - We only override `_lzReceive`, NEVER `lzReceive`.
///           - DVN set is pinned via `endpoint.setConfig` at deploy —
///             2 required (LZ Labs + Nethermind) + 2 optional 1-of-2
///             (Horizen + BitGo). 1-of-1 DVN is THE attack surface that
///             killed Kelp's $292M bridge.
///           - `setPeer` + `setEnforcedOptions` must be set before first
///             send or messages stall / griefing is possible.
///           - Owner / delegate = per-chain Gnosis Safe.
contract HyperPositionLocker is OApp, OAppOptionsType3, AccessControl, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint8 public constant ACT_LOCK_TO_ARB  = 1;
    uint8 public constant ACT_VALUE_UPDATE = 2;
    uint8 public constant ACT_BURN_REDEEM  = 3;

    uint32 public immutable ARB_EID;

    struct Locked {
        address originalOwner;   // who locked it
        address hyperNft;        // NFT on HyperEVM
        uint256 hyperTokenId;
        uint256 lockedAt;
    }
    /// @notice wrapperId (keccak256(nft, tokenId)) → locked info
    mapping(uint256 => Locked) public locked;
    /// @notice nft → vault getter (admin-settable). For value reads.
    mapping(address => address) public vaultOf;
    /// @notice Gas to allocate for the destination _lzReceive. Applied via
    ///         `setEnforcedOptions` separately; kept as state for visibility.
    uint128 public dstGasLimit = 400_000;

    event Locked_(address indexed user, address indexed nft, uint256 indexed tokenId, uint256 wrapperId, uint256 valueUSDC, bytes32 messageId);
    event ValuePushed(address indexed nft, uint256 indexed tokenId, uint256 valueUSDC, bytes32 messageId);
    event Released(address indexed to, address indexed nft, uint256 indexed tokenId, uint256 wrapperId);
    event VaultBoundForNft(address indexed nft, address vault);
    event DstGasLimitUpdated(uint128 newLimit);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event NativeRescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotLocked(uint256 wrapperId);
    error BadSourceChain(uint32 got, uint32 expected);
    error UnknownAction(uint8 action);
    error VaultNotSet(address nft);
    error NftIsTrackedEscrow(address nft, uint256 tokenId);
    error NativeRescueFailed();

    /// @param admin  AccessControl admin (per-chain Safe in prod)
    /// @param keeper KEEPER_ROLE holder for pushValueUpdate
    /// @param endpoint LayerZero v2 Endpoint (HyperEVM: 0x3A73033C…)
    /// @param arbEid EID of the destination (30110 for Arbitrum One)
    constructor(address admin, address keeper, address endpoint, uint32 arbEid)
        OApp(endpoint, admin)
        Ownable(admin)
    {
        if (admin == address(0) || endpoint == address(0)) revert ZeroAddress();
        ARB_EID = arbEid;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setVaultFor(address nft, address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        vaultOf[nft] = vault;
        emit VaultBoundForNft(nft, vault);
    }

    function setDstGasLimit(uint128 g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dstGasLimit = g;
        emit DstGasLimitUpdated(g);
    }

    // ════════════════════════════════════════════════════════════
    //  Read helpers
    // ════════════════════════════════════════════════════════════

    function wrapperIdOf(address nft, uint256 tokenId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(nft, tokenId)));
    }

    function _currentValue(address nft, uint256 tokenId) internal view returns (uint256 total) {
        address v = vaultOf[nft];
        if (v == address(0)) revert VaultNotSet(nft);
        (, , total) = IHyperVault(v).estimatePositionValue(tokenId);
    }

    function quoteLock(address nft, uint256 tokenId, bytes calldata extraOptions)
        external view returns (MessagingFee memory fee)
    {
        bytes memory payload = abi.encode(ACT_LOCK_TO_ARB, address(0), nft, tokenId, 0);
        bytes memory options = combineOptions(ARB_EID, uint16(ACT_LOCK_TO_ARB), extraOptions);
        return _quote(ARB_EID, payload, options, false);
    }

    function quoteValueUpdate(address nft, uint256 tokenId, bytes calldata extraOptions)
        external view returns (MessagingFee memory fee)
    {
        bytes memory payload = abi.encode(ACT_VALUE_UPDATE, nft, tokenId, uint256(0));
        bytes memory options = combineOptions(ARB_EID, uint16(ACT_VALUE_UPDATE), extraOptions);
        return _quote(ARB_EID, payload, options, false);
    }

    // ════════════════════════════════════════════════════════════
    //  User: lock & bridge
    // ════════════════════════════════════════════════════════════

    /// @notice Escrow the NFT + send a LayerZero message to the Arb wrapper to
    ///         mint a 1:1 mirror. Caller pays LZ fee in native HYPE via msg.value.
    function lockAndBridge(address nft, uint256 tokenId, bytes calldata extraOptions)
        external payable nonReentrant returns (bytes32 messageId)
    {
        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);

        uint256 valueUSDC = _currentValue(nft, tokenId);
        uint256 wid = wrapperIdOf(nft, tokenId);
        locked[wid] = Locked({
            originalOwner: msg.sender,
            hyperNft: nft,
            hyperTokenId: tokenId,
            lockedAt: block.timestamp
        });

        bytes memory payload = abi.encode(ACT_LOCK_TO_ARB, msg.sender, nft, tokenId, valueUSDC);
        bytes memory options = combineOptions(ARB_EID, uint16(ACT_LOCK_TO_ARB), extraOptions);
        MessagingReceipt memory r = _lzSend(
            ARB_EID, payload, options,
            MessagingFee({nativeFee: msg.value, lzTokenFee: 0}),
            payable(msg.sender)
        );
        messageId = r.guid;

        emit Locked_(msg.sender, nft, tokenId, wid, valueUSDC, messageId);
    }

    // ════════════════════════════════════════════════════════════
    //  Keeper: push value refresh
    // ════════════════════════════════════════════════════════════

    function pushValueUpdate(address nft, uint256 tokenId, bytes calldata extraOptions)
        external payable onlyRole(KEEPER_ROLE) returns (bytes32 messageId)
    {
        uint256 wid = wrapperIdOf(nft, tokenId);
        if (locked[wid].originalOwner == address(0)) revert NotLocked(wid);
        uint256 valueUSDC = _currentValue(nft, tokenId);

        bytes memory payload = abi.encode(ACT_VALUE_UPDATE, nft, tokenId, valueUSDC);
        bytes memory options = combineOptions(ARB_EID, uint16(ACT_VALUE_UPDATE), extraOptions);
        MessagingReceipt memory r = _lzSend(
            ARB_EID, payload, options,
            MessagingFee({nativeFee: msg.value, lzTokenFee: 0}),
            payable(msg.sender)
        );
        messageId = r.guid;

        emit ValuePushed(nft, tokenId, valueUSDC, messageId);
    }

    // ════════════════════════════════════════════════════════════
    //  LZ inbound: handle burn-redeem from Arb
    //  Only override `_lzReceive`, NEVER `lzReceive` (Zellic mandate).
    // ════════════════════════════════════════════════════════════

    function _lzReceive(
        Origin calldata _origin,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        if (_origin.srcEid != ARB_EID) revert BadSourceChain(_origin.srcEid, ARB_EID);
        // OApp base's lzReceive already verifies msg.sender == endpoint and
        // peer == _origin.sender. We only handle our payload dispatch here.

        uint8 action = abi.decode(_message, (uint8));
        if (action != ACT_BURN_REDEEM) revert UnknownAction(action);

        (, uint256 wid, address redeemer) = abi.decode(_message, (uint8, uint256, address));
        Locked memory L = locked[wid];
        if (L.originalOwner == address(0)) revert NotLocked(wid);

        delete locked[wid];
        IERC721(L.hyperNft).safeTransferFrom(address(this), redeemer, L.hyperTokenId);
        emit Released(redeemer, L.hyperNft, L.hyperTokenId, wid);
    }

    // ════════════════════════════════════════════════════════════
    //  Receivers
    // ════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ════════════════════════════════════════════════════════════
    //  Rescue (admin) — stray assets only; tracked escrows protected
    // ════════════════════════════════════════════════════════════

    /// @notice Rescue any ERC-20 accidentally sent to the locker.
    ///         Locker has no legitimate ERC-20 balance — all values here
    ///         are strays.
    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue a stray ERC-721. REVERTS if the NFT is currently
    ///         tracked as a locked bridge escrow — those NFTs belong to
    ///         the user who locked them and are released only via the
    ///         BURN_REDEEM LZ path.
    function rescueNft(address nft, uint256 tokenId, address to)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        uint256 wid = wrapperIdOf(nft, tokenId);
        if (locked[wid].originalOwner != address(0)) revert NftIsTrackedEscrow(nft, tokenId);
        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        emit NftRescued(nft, tokenId, to);
    }

    /// @notice Rescue stray native HYPE. Locker holds native balance
    ///         only transiently for LZ fee refunds; anything left after
    ///         a lock/pushValueUpdate settles is rescuable.
    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    // Accept native for fee top-up + refunds
    receive() external payable {}
}
