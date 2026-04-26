// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ───────────────────────────────────────────────────────────────────────────
// Minimal Chainlink CCIP interfaces — copied from
// smartcontractkit/chainlink/contracts/src/v0.8/ccip/libraries/Client.sol
// so this contract can compile without a Chainlink dependency.
// ───────────────────────────────────────────────────────────────────────────

library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64  sourceChainSelector;
        bytes   sender;      // abi.encoded original Solana pubkey (32 bytes) for SVM→EVM
        bytes   data;        // arbitrary payload
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVM2AnyMessage {
        bytes   receiver;
        bytes   data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes   extraArgs;
    }
}

interface IAny2EVMMessageReceiver {
    function ccipReceive(Client.Any2EVMMessage calldata message) external;
}

interface IRouterClient {
    function getFee(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message)
        external view returns (uint256 fee);

    function ccipSend(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message)
        external payable returns (bytes32);
}

/// @title PoolSB_MirrorNFT
/// @notice Chainlink CCIP-driven ERC-721 mirror of Solana-native YieldReceipt
///         NFTs (ShadowVault Pool S-B / JupiterAlpha). Sol mint → CCIP →
///         `ccipReceive` mints a mirror; burn mirror → `bridgeBack` → CCIP →
///         Sol program re-unlocks the original.
///
/// Only the registered Solana sender (the shadow-vault-solana CCIP sender
/// program PDA, abi-encoded as 32 bytes) may mint via ccipReceive.
///
/// Mirror metadata stores the source position snapshot: principalUSDC, tier,
/// startTs, plus last reported NAV (keeper updates via `setNav`).
contract PoolSB_MirrorNFT is ERC721, AccessControl, ReentrancyGuard, IAny2EVMMessageReceiver {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// Chainlink CCIP Router on Arbitrum One.
    address public immutable ROUTER;

    /// Chain selector for Solana mainnet (destination on bridge-back).
    uint64  public constant SOLANA_CHAIN_SELECTOR = 124615329519749607;

    /// 32-byte representation of the Solana CCIP sender PDA authorised to mint.
    /// Set at deploy; admin can update if PDA migrates.
    bytes32 public solanaSenderPda;

    // ── Position snapshot stored alongside the mirror NFT ──
    struct Snapshot {
        uint64  solPositionId;    // matches Position.position_id on Solana
        uint128 principalUsdc;    // 6-decimal
        uint64  startTs;
        uint8   tier;             // 0..4
        uint128 lastNavUsdc;      // keeper-reported, 6-decimal
        uint64  lastNavTs;
    }
    mapping(uint256 => Snapshot) public snapshots;

    /// Burn-back queue: once burned, the keeper picks up BridgedBack events and
    /// settles on Solana. Prevents re-entrancy by marking burnt immediately.
    mapping(uint256 => bool) public burned;

    // ── Events ──
    event MirrorMinted(
        uint256 indexed tokenId,
        address indexed to,
        bytes32 ccipMessageId,
        uint64  solPositionId,
        uint128 principalUsdc,
        uint8   tier
    );
    event BridgedBack(
        uint256 indexed tokenId,
        address indexed from,
        bytes32 ccipMessageId,
        uint64  solPositionId
    );
    event NavUpdated(uint256 indexed tokenId, uint128 newNavUsdc);
    event SolanaSenderUpdated(bytes32 newSender);

    // ── Errors ──
    error RouterOnly();
    error SourceChainMismatch(uint64);
    error SenderNotAuthorised(bytes32);
    error InvalidPayload();
    error NotOwner();
    error AlreadyBurned();

    constructor(
        address router_,
        bytes32 solanaSenderPda_,
        address admin_
    ) ERC721("ShadowVault Pool S-B Mirror", "sSBm") {
        ROUTER = router_;
        solanaSenderPda = solanaSenderPda_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(KEEPER_ROLE, admin_);
    }

    // ═══════════════════════════════════════════════════════════
    //  CCIP receive — Sol → Arb (mint mirror)
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IAny2EVMMessageReceiver
    function ccipReceive(Client.Any2EVMMessage calldata message) external override nonReentrant {
        if (msg.sender != ROUTER) revert RouterOnly();
        if (message.sourceChainSelector != SOLANA_CHAIN_SELECTOR) {
            revert SourceChainMismatch(message.sourceChainSelector);
        }

        // Sol sender is 32 bytes (Solana pubkey). Compare against registered PDA.
        if (message.sender.length != 32) revert InvalidPayload();
        bytes32 srcSender = bytes32(message.sender);
        if (srcSender != solanaSenderPda) revert SenderNotAuthorised(srcSender);

        // Decode mint payload. Sol side abi-encodes:
        //   (address recipient, uint64 solPositionId, uint128 principalUsdc,
        //    uint64 startTs, uint8 tier, uint128 initialNavUsdc)
        (
            address recipient,
            uint64  solPositionId,
            uint128 principalUsdc,
            uint64  startTs,
            uint8   tier,
            uint128 initialNavUsdc
        ) = abi.decode(message.data, (address, uint64, uint128, uint64, uint8, uint128));

        // tokenId = keccak256(solSender, solPositionId)[:256]
        // Deterministic + collision-resistant across Sol pools.
        uint256 tokenId = uint256(keccak256(abi.encodePacked(srcSender, solPositionId)));

        snapshots[tokenId] = Snapshot({
            solPositionId: solPositionId,
            principalUsdc: principalUsdc,
            startTs:       startTs,
            tier:          tier,
            lastNavUsdc:   initialNavUsdc,
            lastNavTs:     uint64(block.timestamp)
        });

        _safeMint(recipient, tokenId);

        emit MirrorMinted(
            tokenId, recipient, message.messageId,
            solPositionId, principalUsdc, tier
        );
    }

    // ═══════════════════════════════════════════════════════════
    //  Burn + CCIP send — Arb → Sol (release original)
    // ═══════════════════════════════════════════════════════════

    /// Burns the mirror NFT and sends a CCIP message back to Solana telling
    /// the shadow-vault-solana CCIP receiver program to re-enable the original
    /// position for `recipient` (a Solana pubkey, supplied as bytes32).
    ///
    /// The caller must be the current owner. Caller pays the CCIP fee in ETH
    /// (native) — LINK fee path can be added later.
    function bridgeBack(uint256 tokenId, bytes32 solRecipient) external payable nonReentrant returns (bytes32 messageId) {
        if (_ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (burned[tokenId]) revert AlreadyBurned();
        burned[tokenId] = true;

        Snapshot memory s = snapshots[tokenId];

        _burn(tokenId);

        bytes memory data = abi.encode(
            solRecipient,
            s.solPositionId,
            tokenId
        );

        Client.EVM2AnyMessage memory ccipMsg = Client.EVM2AnyMessage({
            receiver: abi.encode(solanaSenderPda),
            data:     data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0), // native ETH
            extraArgs: abi.encodeWithSelector(
                // Client.EVMExtraArgsV2 tag — gasLimit=200k, allowOOO=true
                bytes4(0x181dcf10),
                uint256(200_000),
                true
            )
        });

        uint256 fee = IRouterClient(ROUTER).getFee(SOLANA_CHAIN_SELECTOR, ccipMsg);
        require(msg.value >= fee, "insufficient CCIP fee");

        messageId = IRouterClient(ROUTER).ccipSend{value: fee}(SOLANA_CHAIN_SELECTOR, ccipMsg);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "refund failed");
        }

        emit BridgedBack(tokenId, msg.sender, messageId, s.solPositionId);
    }

    // ═══════════════════════════════════════════════════════════
    //  Keeper — NAV updates
    // ═══════════════════════════════════════════════════════════

    /// Keeper pushes the latest NAV (USDC, 6-dec) for a mirror token. Used by
    /// OpenSea / UI to show live value. Keeper reads Sol JLP price via the
    /// `jlp-keeper` Solana module and pushes to Arb via this ix.
    function setNav(uint256 tokenId, uint128 navUsdc) external onlyRole(KEEPER_ROLE) {
        require(_ownerOf(tokenId) != address(0), "non-existent");
        snapshots[tokenId].lastNavUsdc = navUsdc;
        snapshots[tokenId].lastNavTs  = uint64(block.timestamp);
        emit NavUpdated(tokenId, navUsdc);
    }

    function setNavBatch(uint256[] calldata tokenIds, uint128[] calldata navs) external onlyRole(KEEPER_ROLE) {
        require(tokenIds.length == navs.length, "len mismatch");
        for (uint256 i; i < tokenIds.length; ++i) {
            if (_ownerOf(tokenIds[i]) == address(0)) continue;
            snapshots[tokenIds[i]].lastNavUsdc = navs[i];
            snapshots[tokenIds[i]].lastNavTs  = uint64(block.timestamp);
            emit NavUpdated(tokenIds[i], navs[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function setSolanaSender(bytes32 newSender) external onlyRole(DEFAULT_ADMIN_ROLE) {
        solanaSenderPda = newSender;
        emit SolanaSenderUpdated(newSender);
    }

    // ─── ERC-165 ───
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl) returns (bool)
    {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
