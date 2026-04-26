// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICCIPRouter, ICCIPReceiver, CCIPClient} from "./ICCIPRouter.sol";

/// @notice Polygon V15 vault interface for live position value.
interface IPolyVault {
    function estimatePositionValue(uint256 posId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total);
}

/// @title PolygonNFTLocker
/// @notice Polygon-side of the Poly→Arb lock-and-mint NFT bridge.
///
///         Flow:
///           1. `lockAndBridge(nft, tokenId)` — user transfers NFT in, we read
///              its current live value from the issuing vault and send a CCIP
///              message to the Arb wrapper. Wrapper mints a 1:1 mirror NFT
///              to the user on Arb.
///           2. `pushValueUpdate(nft, tokenId)` — keeper-callable. Re-reads
///              current value and sends a CCIP update so Arb's stored value
///              stays fresh (important for lending health checks).
///           3. `ccipReceive(...)` — receives "redeem" messages from Arb when
///              a user burns their wrapper. Releases the original NFT to the
///              redeemer.
///
///         Design choices:
///           - Action codes in the 1-byte prefix of CCIP data:
///               0x01 LOCK_TO_ARB    (Polygon → Arb)  mints wrapper
///               0x02 VALUE_UPDATE   (Polygon → Arb)  refreshes stored value
///               0x03 BURN_REDEEM    (Arb → Polygon)  releases original NFT
///           - Wrapper tokenId on Arb = keccak256(polyNft, polyTokenId) truncated
///             to uint256. Deterministic. Same original → same wrapper id.
contract PolygonNFTLocker is AccessControl, ReentrancyGuard, ICCIPReceiver, IERC721Receiver {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    ICCIPRouter public immutable ROUTER;
    uint64      public immutable ARB_SELECTOR;     // destination chain selector
    address     public arbWrapper;                  // receiver contract on Arb (allowlisted)
    IERC20      public immutable LINK;              // fee token (address(0) = native POL)

    uint256 public defaultGasLimit = 400_000;       // CCIP gas limit for destination

    struct Locked {
        address originalOwner;   // who locked it (= redeem-to on burn)
        address polyNft;         // NFT contract on Polygon
        uint256 polyTokenId;     // token id on Polygon
        uint256 lockedAt;        // unix ts
    }
    /// @notice wrapperId (keccak256(nft, tokenId)) → locked info
    mapping(uint256 => Locked) public locked;
    /// @notice nft → vault getter cache (admin-settable). Used to fetch live value.
    mapping(address => address) public vaultOf;

    // ───────── Events
    event Locked_(address indexed user, address indexed nft, uint256 indexed tokenId, uint256 wrapperId, uint256 valueUSDC, bytes32 ccipMessageId);
    event ValuePushed(address indexed nft, uint256 indexed tokenId, uint256 valueUSDC, bytes32 ccipMessageId);
    event Released(address indexed to, address indexed nft, uint256 indexed tokenId, uint256 wrapperId);
    event ArbWrapperUpdated(address newWrapper);
    event VaultBoundForNft(address indexed nft, address vault);
    event GasLimitUpdated(uint256 newLimit);

    // ───────── Errors
    error ZeroAddress();
    error NotLocked(uint256 wrapperId);
    error NotRouter();
    error BadSourceChain(uint64 got, uint64 expected);
    error BadSender(address got, address expected);
    error UnknownAction(uint8 action);
    error VaultNotSet(address nft);
    error FeeTransferFailed();

    constructor(address admin, address keeper, address router, uint64 arbSelector, address link) {
        if (admin == address(0) || router == address(0)) revert ZeroAddress();
        ROUTER = ICCIPRouter(router);
        ARB_SELECTOR = arbSelector;
        LINK = IERC20(link); // may be address(0) → pay with native
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setArbWrapper(address w) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (w == address(0)) revert ZeroAddress();
        arbWrapper = w;
        emit ArbWrapperUpdated(w);
    }

    function setVaultFor(address nft, address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        vaultOf[nft] = vault;
        emit VaultBoundForNft(nft, vault);
    }

    function setGasLimit(uint256 g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        defaultGasLimit = g;
        emit GasLimitUpdated(g);
    }

    /// @notice Admin escape hatch — pull a non-NFT token sent here by mistake.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }

    // ════════════════════════════════════════════════════════════
    //  Value read helper
    // ════════════════════════════════════════════════════════════

    function _currentValue(address nft, uint256 tokenId) internal view returns (uint256 total) {
        address vault = vaultOf[nft];
        if (vault == address(0)) revert VaultNotSet(nft);
        (, , total) = IPolyVault(vault).estimatePositionValue(tokenId);
    }

    function wrapperIdOf(address nft, uint256 tokenId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(nft, tokenId)));
    }

    // ════════════════════════════════════════════════════════════
    //  User: lock & bridge
    // ════════════════════════════════════════════════════════════

    /// @notice Escrow the NFT, send a CCIP message to Arb's wrapper to mint
    ///         a 1:1 mirror. Caller covers the CCIP fee:
    ///           - if LINK==0 → native POL via msg.value
    ///           - if LINK!=0 → LINK must be approved to this contract
    function lockAndBridge(address nft, uint256 tokenId) external payable nonReentrant returns (bytes32 messageId) {
        if (arbWrapper == address(0)) revert ZeroAddress();

        // Transfer NFT into escrow (caller must have approved).
        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);

        uint256 valueUSDC = _currentValue(nft, tokenId);
        uint256 wid = wrapperIdOf(nft, tokenId);
        locked[wid] = Locked({
            originalOwner: msg.sender,
            polyNft: nft,
            polyTokenId: tokenId,
            lockedAt: block.timestamp
        });

        // action=0x01 LOCK_TO_ARB: (action, recipient, polyNft, polyTokenId, valueUSDC)
        bytes memory payload = abi.encode(uint8(1), msg.sender, nft, tokenId, valueUSDC);
        messageId = _sendCCIP(payload);

        emit Locked_(msg.sender, nft, tokenId, wid, valueUSDC, messageId);
    }

    // ════════════════════════════════════════════════════════════
    //  Keeper: push value updates
    // ════════════════════════════════════════════════════════════

    /// @notice Re-read value from the vault, push to Arb. Keeper-gated so it
    ///         can't be spammed (each push costs CCIP fee). Only valid for
    ///         currently-locked positions.
    function pushValueUpdate(address nft, uint256 tokenId)
        external payable onlyRole(KEEPER_ROLE) returns (bytes32 messageId)
    {
        uint256 wid = wrapperIdOf(nft, tokenId);
        if (locked[wid].originalOwner == address(0)) revert NotLocked(wid);

        uint256 valueUSDC = _currentValue(nft, tokenId);
        // action=0x02 VALUE_UPDATE: (action, polyNft, polyTokenId, valueUSDC)
        bytes memory payload = abi.encode(uint8(2), nft, tokenId, valueUSDC);
        messageId = _sendCCIP(payload);

        emit ValuePushed(nft, tokenId, valueUSDC, messageId);
    }

    // ════════════════════════════════════════════════════════════
    //  CCIP receive: handle burn/redeem from Arb
    // ════════════════════════════════════════════════════════════

    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external override nonReentrant {
        if (msg.sender != address(ROUTER)) revert NotRouter();
        if (message.sourceChainSelector != ARB_SELECTOR) revert BadSourceChain(message.sourceChainSelector, ARB_SELECTOR);
        address sender = abi.decode(message.sender, (address));
        if (sender != arbWrapper) revert BadSender(sender, arbWrapper);

        uint8 action = abi.decode(message.data, (uint8));
        if (action != 3) revert UnknownAction(action);

        // BURN_REDEEM payload: (action, wrapperId, redeemer)
        (, uint256 wid, address redeemer) = abi.decode(message.data, (uint8, uint256, address));
        Locked memory L = locked[wid];
        if (L.originalOwner == address(0)) revert NotLocked(wid);

        delete locked[wid];
        IERC721(L.polyNft).safeTransferFrom(address(this), redeemer, L.polyTokenId);
        emit Released(redeemer, L.polyNft, L.polyTokenId, wid);
    }

    // ════════════════════════════════════════════════════════════
    //  Internal: send CCIP
    // ════════════════════════════════════════════════════════════

    function _sendCCIP(bytes memory payload) internal returns (bytes32 messageId) {
        CCIPClient.EVMTokenAmount[] memory empty = new CCIPClient.EVMTokenAmount[](0);
        CCIPClient.EVM2AnyMessage memory msg_ = CCIPClient.EVM2AnyMessage({
            receiver:    abi.encode(arbWrapper),
            data:        payload,
            tokenAmounts: empty,
            feeToken:    address(LINK),
            extraArgs:   CCIPClient._argsV2(defaultGasLimit, true)
        });

        uint256 fee = ROUTER.getFee(ARB_SELECTOR, msg_);

        if (address(LINK) == address(0)) {
            // Native POL fee
            if (msg.value < fee) revert FeeTransferFailed();
            messageId = ROUTER.ccipSend{value: fee}(ARB_SELECTOR, msg_);
            if (msg.value > fee) {
                (bool ok, ) = payable(msg.sender).call{value: msg.value - fee}("");
                if (!ok) revert FeeTransferFailed();
            }
        } else {
            // LINK fee — pull from caller and approve router
            LINK.safeTransferFrom(msg.sender, address(this), fee);
            LINK.forceApprove(address(ROUTER), fee);
            messageId = ROUTER.ccipSend(ARB_SELECTOR, msg_);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  IERC721Receiver
    // ════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // Accept native tokens (for CCIP fee refunds and funding)
    receive() external payable {}
}
