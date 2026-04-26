// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShadowPositionNFTV15} from "./ShadowPositionNFTV15.sol";

/// @title HyperSkin
/// @notice ShadowPass user-facing NFT for the HyperEVM Pool E+ product line.
///
///         Extends ShadowPositionNFTV15 with a mid-flight strategy upgrade
///         path. Each token carries a `strategyId` pointing at one of the
///         registered pool strategies (HyperCash, HyperCore, HyperAlpha,
///         HyperShield, HyperLeverage, …). The holder can call
///         `queueUpgrade(tokenId, newStrategyId)` to switch strategies — the
///         vault then unwinds the HLP position (respecting the 4-day lockup),
///         re-deposits into the new pool, and the token's `strategyId` is
///         updated. An age-bucketed fee is charged to the treasury on
///         upgrade; the clock resets on every change.
///
///         Fee schedule (clock = `block.timestamp - lastStrategyChangeAt`):
///           0-3 days   → 3.00 %  (300 bps)
///           3-9 days   → 1.00 %  (100 bps)
///           9-27 days  → 0.33 %  (33  bps)
///           27 + days  → 0.10 %  (10  bps)
///
///         Cross-pool upgrade during HLP lockup is ALLOWED — funds queue for
///         up to 4 days while the HLP position unwinds; metadata shows a
///         "upgrading to {newPool}" state until the unwind completes.
///
///         The queued-upgrade state machine actually lives in the vault
///         (tracks PENDING_UNWIND / PENDING_DEPOSIT / COMPLETED). This
///         contract merely records strategy assignment + emits events.
contract HyperSkin is ShadowPositionNFTV15 {

    // ───────── Strategy registry ─────────
    struct Strategy {
        string  name;      // e.g. "HyperCash"
        address vault;     // ShadowVaultV15 instance managing this strategy
        bool    active;    // can be selected for upgrades
    }
    Strategy[] public strategies;

    /// @notice Current strategy per token.
    mapping(uint256 => uint16) public strategyOf;
    /// @notice Last time the strategy changed (or mint time).
    mapping(uint256 => uint256) public lastStrategyChangeAt;
    /// @notice Running counter of prior strategies for provenance / rarity.
    mapping(uint256 => uint16[]) internal _strategyHistory;

    /// @notice Upgrade fee split (bps of the fee itself): 60% treasury, 40% revenue router.
    uint256 public constant UPGRADE_TREASURY_BPS = 6000;
    uint256 public constant UPGRADE_ROUTER_BPS   = 4000;

    /// @notice Addresses that receive upgrade fees (set by admin post-deploy).
    address public treasury;
    address public revenueRouter;

    // ───────── Events ─────────
    event StrategyRegistered(uint16 indexed id, string name, address vault);
    event StrategyDeactivated(uint16 indexed id);
    event UpgradeQueued(uint256 indexed tokenId, uint16 fromStrategy, uint16 toStrategy, uint256 feeBps);
    event UpgradeExecuted(uint256 indexed tokenId, uint16 indexed strategyId, uint256 whenTs);
    event FeeRoutesSet(address treasury, address revenueRouter);

    // ───────── Errors ─────────
    error UnknownStrategy(uint16 id);
    error StrategyInactive(uint16 id);
    error SameStrategy(uint16 id);
    error NotHolder();
    error FeeRoutesUnset();

    // ───────── Constructor ─────────
    constructor(string memory _poolLabel, address admin)
        ShadowPositionNFTV15(_poolLabel, admin)
    {
        // Index 0 reserved for "HyperCash" (pool E). Admin adds via
        // `registerStrategy(...)` after deploy once the Pool E vault address
        // is known — we can't hand it in here because the NFT is deployed
        // before the vault.
    }

    // ═══════════════════════════════════════════════════════════
    //  Mint override — initialize strategy clock
    // ═══════════════════════════════════════════════════════════

    /// @dev Mints a token under the caller vault's registered strategy.
    ///      We look up the strategy by vault address so every Pool E/F/G/H
    ///      vault that holds VAULT_ROLE maps to the right skin id.
    function mint(address to, bytes calldata posData)
        external
        override
        onlyRole(VAULT_ROLE)
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        positionData[tokenId] = posData;
        uint16 sid = _strategyIdOfVault(msg.sender);
        strategyOf[tokenId] = sid;
        lastStrategyChangeAt[tokenId] = block.timestamp;
        _strategyHistory[tokenId].push(sid);
        _safeMint(to, tokenId);
    }

    // ═══════════════════════════════════════════════════════════
    //  Upgrade flow
    // ═══════════════════════════════════════════════════════════

    /// @notice Current fee (bps) for upgrading a given token right now.
    function upgradeFeeBps(uint256 tokenId) public view returns (uint256) {
        uint256 age = block.timestamp - lastStrategyChangeAt[tokenId];
        if (age < 3 days)  return 300;
        if (age < 9 days)  return 100;
        if (age < 27 days) return 33;
        return 10;
    }

    /// @notice Holder initiates an upgrade to a different strategy. Emits an
    ///         event that the destination vault's keeper picks up; the
    ///         actual unwind/redeposit is mediated by the vault's queued
    ///         upgrade state machine.
    /// @dev    The fee calc snapshot is emitted for off-chain transparency.
    ///         Actual fee collection happens when `executeUpgrade` runs
    ///         (atomic with vault state transition).
    function queueUpgrade(uint256 tokenId, uint16 newStrategyId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotHolder();
        uint16 current = strategyOf[tokenId];
        if (current == newStrategyId) revert SameStrategy(newStrategyId);
        if (newStrategyId >= strategies.length) revert UnknownStrategy(newStrategyId);
        if (!strategies[newStrategyId].active) revert StrategyInactive(newStrategyId);
        uint256 feeBps = upgradeFeeBps(tokenId);
        emit UpgradeQueued(tokenId, current, newStrategyId, feeBps);
        // The vault listens for this event, begins the unwind, then calls
        // `executeUpgrade` via the VAULT_ROLE of the destination strategy.
    }

    /// @notice Called by the destination vault once funds have landed in it.
    ///         Updates on-chain strategy pointer and resets the clock.
    /// @dev    Caller must be a registered, active strategy vault. The fee
    ///         is deducted in the vault's flow before this call — this
    ///         function is pure state transition.
    function executeUpgrade(uint256 tokenId) external onlyRole(VAULT_ROLE) {
        uint16 newId = _strategyIdOfVault(msg.sender);
        uint16 old = strategyOf[tokenId];
        if (old == newId) revert SameStrategy(newId);
        strategyOf[tokenId] = newId;
        lastStrategyChangeAt[tokenId] = block.timestamp;
        _strategyHistory[tokenId].push(newId);
        emit UpgradeExecuted(tokenId, newId, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin — strategy + fee route registration
    // ═══════════════════════════════════════════════════════════

    function registerStrategy(string calldata name, address vault)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint16 id)
    {
        id = uint16(strategies.length);
        strategies.push(Strategy({ name: name, vault: vault, active: true }));
        _grantRole(VAULT_ROLE, vault);
        emit StrategyRegistered(id, name, vault);
    }

    function setStrategyActive(uint16 id, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (id >= strategies.length) revert UnknownStrategy(id);
        strategies[id].active = active;
        if (!active) emit StrategyDeactivated(id);
    }

    function setFeeRoutes(address _treasury, address _revenueRouter)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        treasury = _treasury;
        revenueRouter = _revenueRouter;
        emit FeeRoutesSet(_treasury, _revenueRouter);
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    function strategyHistory(uint256 tokenId) external view returns (uint16[] memory) {
        return _strategyHistory[tokenId];
    }

    function strategyCount() external view returns (uint256) {
        return strategies.length;
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _strategyIdOfVault(address vault) internal view returns (uint16) {
        uint256 n = strategies.length;
        for (uint256 i = 0; i < n; i++) {
            if (strategies[i].vault == vault) return uint16(i);
        }
        revert UnknownStrategy(type(uint16).max);
    }
}
