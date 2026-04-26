// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DiggerRegistry
/// @notice Central project-onboarding registry for the Diamondz ecosystem
///         marketplace + lending stack. Each "digger" represents a partner
///         project; opening a digger requires staking a USDC bond and
///         registering one or more NFT collections that become eligible
///         for marketplace listing and lending collateral.
///
///         Same registry is consumed by EcosystemMarketplace (lists only
///         registered collections) and the future LendingPool (accepts only
///         registered collections as collateral, applies per-collection LTV
///         cap, routes interest split per digger config).
///
///         The bond is the project's skin in the game: bad behavior (oracle
///         manipulation, listing griefing, bad debt from their NFTs) lets
///         admin slash the bond before suppliers / protocol eat losses.
/// @dev v2 notes:
///   - Adds CollectionClass.{FOREIGN, IN_HOUSE}. IN_HOUSE collections are
///     Diamondz vault-backed (liquidity-backed by known USDC adapter
///     holdings) and skip the digger bond path — admin registers them
///     directly. Foreign collections keep the original flow.
///   - Higher LTV cap for IN_HOUSE (90%) vs FOREIGN (80%) — justified by
///     the adapter-unwind redemption path rather than speculative floor.
///   - rescueToken / rescueNative added; USDC rescue is guarded by the
///     tracked `totalBondedUSDC` so active bonds cannot be drained.
contract DiggerRegistry is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @notice FOREIGN = 3rd-party NFT, digger + bond required.
    ///         IN_HOUSE = Diamondz-protocol-backed NFT (vault positions,
    ///         LZ/CCIP wrappers) — admin-registered, no bond, higher LTV.
    enum CollectionClass { FOREIGN, IN_HOUSE }

    uint16 public constant MAX_LTV_FOREIGN  = 8000; // 80%
    uint16 public constant MAX_LTV_IN_HOUSE = 9000; // 90%

    IERC20 public immutable USDC;

    /// @notice Minimum bond required to open a digger.
    uint256 public minBondUSDC = 1_000 * 1e6; // 1,000 USDC default

    /// @notice Time a bond is locked after `unstake` is queued.
    uint256 public unstakeDelay = 14 days;

    /// @notice Tracked total of USDC currently bonded across all diggers.
    ///         Used by `rescueToken` so admin cannot drain active bonds.
    uint256 public totalBondedUSDC;

    uint256 public nextDiggerId = 1;
    /// @notice Treasury for slash proceeds + protocol fee share defaults.
    address public protocolTreasury;

    struct Digger {
        address owner;          // project multisig / EOA
        uint256 bondAmount;     // USDC currently bonded
        uint256 unstakeAt;      // 0 = no unstake queued; else timestamp >= which unstake() can be called
        uint16  protocolBps;    // protocol cut of marketplace + lending fees (e.g. 1000 = 10%)
        uint16  supplierBps;    // supplier (lending) cut (e.g. 7000 = 70%)
        uint16  diggerBps;      // digger cut (e.g. 2000 = 20%)
        bool    paused;         // soft-pause: existing positions safe, no new listings
        bool    slashed;        // hard-stop: collections rejected everywhere
    }

    struct Collection {
        uint256 diggerId;       // 0 = not registered OR in-house (class_=IN_HOUSE)
        address oracle;         // FOREIGN: price oracle (optional)
                                // IN_HOUSE: vault / valuer source address
        uint16  maxLtvBps;      // lending LTV cap; 0 = lending-disabled
        bool    accepted;
        CollectionClass class_; // FOREIGN (default) or IN_HOUSE
    }

    mapping(uint256 => Digger) public diggers;
    mapping(address => Collection) public collections; // nft contract → info
    mapping(uint256 => address[]) public diggerCollections;

    event DiggerOpened(uint256 indexed diggerId, address indexed owner, uint256 bond);
    event DiggerBondAdded(uint256 indexed diggerId, uint256 added, uint256 newTotal);
    event DiggerUnstakeQueued(uint256 indexed diggerId, uint256 unstakeAt);
    event DiggerUnstaked(uint256 indexed diggerId, uint256 amount);
    event DiggerFeeSplitUpdated(uint256 indexed diggerId, uint16 protocolBps, uint16 supplierBps, uint16 diggerBps);
    event DiggerPaused(uint256 indexed diggerId, bool paused);
    event DiggerSlashed(uint256 indexed diggerId, uint256 amount, address to, string reason);
    event DiggerOwnerTransferred(uint256 indexed diggerId, address oldOwner, address newOwner);

    event CollectionRegistered(uint256 indexed diggerId, address indexed nft, address oracle, uint16 maxLtvBps);
    event InHouseCollectionRegistered(address indexed nft, address indexed valueSource, uint16 maxLtvBps);
    event CollectionClassChanged(address indexed nft, CollectionClass oldClass, CollectionClass newClass);
    event CollectionUpdated(address indexed nft, address oracle, uint16 maxLtvBps);
    event CollectionRemoved(address indexed nft);

    event MinBondUpdated(uint256 newMin);
    event UnstakeDelayUpdated(uint256 newDelay);
    event ProtocolTreasuryUpdated(address newTreasury);

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BondTooLow(uint256 provided, uint256 required);
    error BadFeeSplit();
    error NotDiggerOwner();
    error UnknownDigger();
    error AlreadyRegistered(address nft);
    error UnknownCollection(address nft);
    error UnstakeNotReady(uint256 readyAt);
    error UnstakeNotQueued();
    error InsufficientBond(uint256 amount, uint256 bond);
    error DiggerSlashedErr();
    error DiggerPausedErr();
    error LtvCapExceeded(uint16 provided, uint16 cap);
    error WouldDrainBonds(uint256 requested, uint256 unbonded);
    error NativeRescueFailed();

    constructor(address admin, address _usdc, address _treasury) {
        if (admin == address(0) || _usdc == address(0) || _treasury == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        protocolTreasury = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SLASHER_ROLE, admin);
    }

    // ════════════════════════════════════════════════════════════
    //  Digger lifecycle
    // ════════════════════════════════════════════════════════════

    /// @notice Open a new digger. Caller is set as the digger owner.
    /// @param bond  USDC pulled from caller; must be ≥ `minBondUSDC`.
    /// @param protocolBps Protocol cut of fees; sum of three bps must = 10_000.
    /// @param supplierBps Supplier (lending) cut.
    /// @param diggerBps   Digger cut.
    function openDigger(uint256 bond, uint16 protocolBps, uint16 supplierBps, uint16 diggerBps)
        external
        nonReentrant
        returns (uint256 diggerId)
    {
        if (bond < minBondUSDC) revert BondTooLow(bond, minBondUSDC);
        if (uint256(protocolBps) + supplierBps + diggerBps != 10_000) revert BadFeeSplit();

        diggerId = nextDiggerId++;
        diggers[diggerId] = Digger({
            owner: msg.sender,
            bondAmount: bond,
            unstakeAt: 0,
            protocolBps: protocolBps,
            supplierBps: supplierBps,
            diggerBps: diggerBps,
            paused: false,
            slashed: false
        });
        totalBondedUSDC += bond;
        USDC.safeTransferFrom(msg.sender, address(this), bond);
        emit DiggerOpened(diggerId, msg.sender, bond);
        emit DiggerFeeSplitUpdated(diggerId, protocolBps, supplierBps, diggerBps);
    }

    /// @notice Top up a digger's bond. Anyone can pay in (e.g. project DAO).
    function addBond(uint256 diggerId, uint256 amount) external nonReentrant {
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (d.slashed) revert DiggerSlashedErr();
        if (amount == 0) revert ZeroAmount();
        d.bondAmount += amount;
        totalBondedUSDC += amount;
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        emit DiggerBondAdded(diggerId, amount, d.bondAmount);
    }

    /// @notice Queue a bond withdrawal. After `unstakeDelay` the owner can
    ///         call `unstake` to receive it.
    function queueUnstake(uint256 diggerId) external {
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        if (d.slashed) revert DiggerSlashedErr();
        d.unstakeAt = block.timestamp + unstakeDelay;
        emit DiggerUnstakeQueued(diggerId, d.unstakeAt);
    }

    function unstake(uint256 diggerId, uint256 amount) external nonReentrant {
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        if (d.slashed) revert DiggerSlashedErr();
        if (d.unstakeAt == 0) revert UnstakeNotQueued();
        if (block.timestamp < d.unstakeAt) revert UnstakeNotReady(d.unstakeAt);
        if (amount == 0 || amount > d.bondAmount) revert InsufficientBond(amount, d.bondAmount);

        d.bondAmount -= amount;
        totalBondedUSDC -= amount;
        // If withdrawing fully, clear the unstake queue. If partial, allow
        // immediate further withdrawal up to the rest of the bond.
        if (d.bondAmount == 0) d.unstakeAt = 0;
        USDC.safeTransfer(d.owner, amount);
        emit DiggerUnstaked(diggerId, amount);
    }

    /// @notice Owner updates fee split. Sum must remain 10_000 bps.
    function setFeeSplit(uint256 diggerId, uint16 protocolBps, uint16 supplierBps, uint16 diggerBps) external {
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        if (uint256(protocolBps) + supplierBps + diggerBps != 10_000) revert BadFeeSplit();
        d.protocolBps = protocolBps;
        d.supplierBps = supplierBps;
        d.diggerBps = diggerBps;
        emit DiggerFeeSplitUpdated(diggerId, protocolBps, supplierBps, diggerBps);
    }

    function setDiggerPaused(uint256 diggerId, bool paused) external {
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        d.paused = paused;
        emit DiggerPaused(diggerId, paused);
    }

    function transferDiggerOwner(uint256 diggerId, address newOwner) external {
        if (newOwner == address(0)) revert ZeroAddress();
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        emit DiggerOwnerTransferred(diggerId, d.owner, newOwner);
        d.owner = newOwner;
    }

    /// @notice Slash a digger's bond. Routes proceeds to caller-specified
    ///         address (typically a bad-debt cover or treasury). Sets the
    ///         `slashed` flag if the bond goes to zero, which permanently
    ///         disables all collections under the digger.
    function slash(uint256 diggerId, uint256 amount, address to, string calldata reason)
        external
        nonReentrant
        onlyRole(SLASHER_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (amount == 0 || amount > d.bondAmount) revert InsufficientBond(amount, d.bondAmount);
        d.bondAmount -= amount;
        totalBondedUSDC -= amount;
        if (d.bondAmount == 0) d.slashed = true;
        USDC.safeTransfer(to, amount);
        emit DiggerSlashed(diggerId, amount, to, reason);
    }

    // ════════════════════════════════════════════════════════════
    //  Collection registration
    // ════════════════════════════════════════════════════════════

    /// @notice FOREIGN registration. Digger owner stakes a bond and brings
    ///         a 3rd-party NFT as eligible collateral. Hard LTV cap 80%.
    function registerCollection(uint256 diggerId, address nft, address oracle, uint16 maxLtvBps) external {
        if (nft == address(0)) revert ZeroAddress();
        Digger storage d = diggers[diggerId];
        if (d.owner == address(0)) revert UnknownDigger();
        if (msg.sender != d.owner) revert NotDiggerOwner();
        if (d.slashed) revert DiggerSlashedErr();
        if (collections[nft].accepted) revert AlreadyRegistered(nft);
        if (maxLtvBps > MAX_LTV_FOREIGN) revert LtvCapExceeded(maxLtvBps, MAX_LTV_FOREIGN);

        collections[nft] = Collection({
            diggerId: diggerId,
            oracle: oracle,
            maxLtvBps: maxLtvBps,
            accepted: true,
            class_: CollectionClass.FOREIGN
        });
        diggerCollections[diggerId].push(nft);
        emit CollectionRegistered(diggerId, nft, oracle, maxLtvBps);
    }

    /// @notice IN_HOUSE registration. Admin-only. No digger bond required —
    ///         these collections are Diamondz-protocol NFTs whose backing
    ///         is live USDC in known vault adapters, so bad-debt risk is
    ///         bounded by adapter redemption rather than a digger bond.
    ///         Higher LTV cap (90%) reflects that.
    /// @param valueSource For VAULT_POSITION: the vault implementing
    ///        `estimatePositionValue(tokenId)`. For VAULT_MIRROR (bridged
    ///        wrappers): the wrapper address (it provides the same method).
    function registerInHouseCollection(address nft, address valueSource, uint16 maxLtvBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (nft == address(0) || valueSource == address(0)) revert ZeroAddress();
        if (collections[nft].accepted) revert AlreadyRegistered(nft);
        if (maxLtvBps > MAX_LTV_IN_HOUSE) revert LtvCapExceeded(maxLtvBps, MAX_LTV_IN_HOUSE);

        collections[nft] = Collection({
            diggerId: 0,
            oracle: valueSource,
            maxLtvBps: maxLtvBps,
            accepted: true,
            class_: CollectionClass.IN_HOUSE
        });
        emit InHouseCollectionRegistered(nft, valueSource, maxLtvBps);
    }

    /// @notice Admin migration helper for collections registered under the
    ///         old v1 registry (all went through digger #1 with FOREIGN
    ///         class). Moves them to IN_HOUSE class without re-registration.
    ///         Use this to convert Pool A-D NFTs + bridge wrappers that
    ///         were previously registered through the Diamondz digger.
    function migrateToInHouse(address[] calldata nfts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < nfts.length; i++) {
            Collection storage c = collections[nfts[i]];
            if (!c.accepted) revert UnknownCollection(nfts[i]);
            if (c.class_ == CollectionClass.IN_HOUSE) continue; // idempotent
            emit CollectionClassChanged(nfts[i], c.class_, CollectionClass.IN_HOUSE);
            c.class_ = CollectionClass.IN_HOUSE;
            // Keep diggerId pointer so the fee-split routing still works
            // for in-flight listings; the isListable / isCollateral views
            // ignore slashed/paused for in-house (see below).
        }
    }

    function updateCollection(address nft, address oracle, uint16 maxLtvBps) external {
        Collection storage c = collections[nft];
        if (!c.accepted) revert UnknownCollection(nft);

        uint16 cap;
        if (c.class_ == CollectionClass.IN_HOUSE) {
            // In-house: only admin may update.
            if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotDiggerOwner();
            cap = MAX_LTV_IN_HOUSE;
        } else {
            Digger storage d = diggers[c.diggerId];
            if (msg.sender != d.owner) revert NotDiggerOwner();
            cap = MAX_LTV_FOREIGN;
        }
        if (maxLtvBps > cap) revert LtvCapExceeded(maxLtvBps, cap);

        c.oracle = oracle;
        c.maxLtvBps = maxLtvBps;
        emit CollectionUpdated(nft, oracle, maxLtvBps);
    }

    function removeCollection(address nft) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Collection storage c = collections[nft];
        if (!c.accepted) revert UnknownCollection(nft);
        c.accepted = false;
        emit CollectionRemoved(nft);
    }

    // ════════════════════════════════════════════════════════════
    //  Read API (consumed by Marketplace + LendingPool)
    // ════════════════════════════════════════════════════════════

    /// @notice True if `nft` is currently listable on the marketplace.
    function isListable(address nft) external view returns (bool) {
        Collection memory c = collections[nft];
        if (!c.accepted) return false;
        if (c.class_ == CollectionClass.IN_HOUSE) return true;
        Digger memory d = diggers[c.diggerId];
        return !d.slashed && !d.paused;
    }

    /// @notice True if `nft` is currently usable as lending collateral.
    function isCollateral(address nft) external view returns (bool) {
        Collection memory c = collections[nft];
        if (!c.accepted || c.maxLtvBps == 0) return false;
        if (c.class_ == CollectionClass.IN_HOUSE) return true;
        Digger memory d = diggers[c.diggerId];
        return !d.slashed && !d.paused;
    }

    /// @notice Collection class (FOREIGN or IN_HOUSE).
    function classOf(address nft) external view returns (CollectionClass) {
        return collections[nft].class_;
    }

    /// @notice Fee split for a collection (digger / supplier / protocol bps).
    ///         IN_HOUSE collections route digger's share to the protocol
    ///         treasury since there's no external digger to pay out.
    function feeSplit(address nft) external view returns (uint16 diggerBps, uint16 supplierBps, uint16 protocolBps) {
        Collection memory c = collections[nft];
        if (!c.accepted) return (0, 0, 10_000); // default routes to protocol if unregistered
        if (c.class_ == CollectionClass.IN_HOUSE) {
            // In-house default: 10% protocol, 90% supplier, 0 digger.
            // Admins can always tune later by redeploying with richer config.
            return (0, 9000, 1000);
        }
        Digger memory d = diggers[c.diggerId];
        return (d.diggerBps, d.supplierBps, d.protocolBps);
    }

    /// @notice Owner address that should receive the digger's fee cut.
    ///         IN_HOUSE: routes to the protocol treasury.
    function diggerOwnerOf(address nft) external view returns (address) {
        Collection memory c = collections[nft];
        if (!c.accepted) return address(0);
        if (c.class_ == CollectionClass.IN_HOUSE) return protocolTreasury;
        return diggers[c.diggerId].owner;
    }

    function diggerCollectionCount(uint256 diggerId) external view returns (uint256) {
        return diggerCollections[diggerId].length;
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setMinBond(uint256 newMin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBondUSDC = newMin;
        emit MinBondUpdated(newMin);
    }

    function setUnstakeDelay(uint256 newDelay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newDelay > 90 days) revert BadFeeSplit(); // reuse error; sanity cap
        unstakeDelay = newDelay;
        emit UnstakeDelayUpdated(newDelay);
    }

    function setProtocolTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        protocolTreasury = newTreasury;
        emit ProtocolTreasuryUpdated(newTreasury);
    }

    // ════════════════════════════════════════════════════════════
    //  Rescue (admin) — active bonds protected
    // ════════════════════════════════════════════════════════════

    /// @notice Rescue ERC-20 strays. USDC rescue is guarded by the tracked
    ///         `totalBondedUSDC` so admin cannot drain active bonds; only
    ///         the delta between this contract's USDC balance and the
    ///         active bond total is rescuable.
    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(USDC)) {
            uint256 bal = USDC.balanceOf(address(this));
            uint256 unbonded = bal > totalBondedUSDC ? bal - totalBondedUSDC : 0;
            if (amount > unbonded) revert WouldDrainBonds(amount, unbonded);
        }
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescue stray native (contract doesn't accept value; only via
    ///         receive() if ever called — belt-and-suspenders).
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
