// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title BasketNavOracle
/// @notice Keeper-pushed NAV store for basket pools on chains without reliable
///         on-chain oracles for all basket constituents (primary use case:
///         HyperEVM Pool F/G/H where HYPE/PURR/UNIBTC don't have Chainlink or
///         Pyth yet but HyperCore HL spot prices are pushed off-chain).
///
/// @dev    Security model:
///         - `KEEPER_ROLE` can call `pushNav` to update a basket's USD value
///         - `PAUSER_ROLE` can pause any basket (freezes reads)
///         - `DEFAULT_ADMIN_ROLE` can configure staleness / drift caps and
///           grant/revoke the above roles
///         - `getNav` reverts if NAV is stale past `maxStalenessSecs` or the
///           basket is paused — consumers (BasketReceipt, vault pricing) must
///           treat this as a hard failure
///         - `maxDriftBps` caps the jump between two consecutive pushes as a
///           sanity guard against keeper compromise or fat-finger pushes
///
/// @dev    NAV is expressed in **USDC 6-dec** so downstream math is uniform
///         with the rest of the V15 stack.
contract BasketNavOracle is AccessControl, Pausable {

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Basket {
        bool     registered;
        uint256  lastNavUsd6;        // USDC 6-dec
        uint64   lastNavAt;          // unix seconds
        uint32   maxStalenessSecs;   // e.g. 900 (15 min)
        uint16   maxDriftBps;        // e.g. 1000 = 10%
        bool     paused;             // per-basket pause
        string   name;               // e.g. "HyperCore"
    }

    mapping(uint64 => Basket) public baskets;
    uint64 public nextBasketId;

    // ───────── Events ─────────
    event BasketRegistered(uint64 indexed basketId, string name, uint32 maxStalenessSecs, uint16 maxDriftBps);
    event NavPushed(uint64 indexed basketId, uint256 navUsd6, uint64 at);
    event StalenessUpdated(uint64 indexed basketId, uint32 maxStalenessSecs);
    event DriftUpdated(uint64 indexed basketId, uint16 maxDriftBps);
    event BasketPaused(uint64 indexed basketId, bool paused);

    // ───────── Errors ─────────
    error UnknownBasket(uint64 basketId);
    error NavStale(uint64 basketId, uint64 lastAt, uint32 maxStalenessSecs);
    error BasketFrozen(uint64 basketId);
    error DriftExceeded(uint64 basketId, uint256 prev, uint256 next, uint16 maxDriftBps);
    error ZeroValue();
    error BadConfig();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function registerBasket(string calldata name_, uint32 maxStalenessSecs_, uint16 maxDriftBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint64 basketId)
    {
        if (maxStalenessSecs_ == 0 || maxDriftBps_ == 0 || maxDriftBps_ > 10_000) revert BadConfig();
        basketId = nextBasketId++;
        baskets[basketId] = Basket({
            registered: true,
            lastNavUsd6: 0,
            lastNavAt:   0,
            maxStalenessSecs: maxStalenessSecs_,
            maxDriftBps: maxDriftBps_,
            paused: false,
            name: name_
        });
        emit BasketRegistered(basketId, name_, maxStalenessSecs_, maxDriftBps_);
    }

    function setStaleness(uint64 basketId, uint32 maxStalenessSecs_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (maxStalenessSecs_ == 0) revert BadConfig();
        _mustExist(basketId);
        baskets[basketId].maxStalenessSecs = maxStalenessSecs_;
        emit StalenessUpdated(basketId, maxStalenessSecs_);
    }

    function setDriftCap(uint64 basketId, uint16 maxDriftBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (maxDriftBps_ == 0 || maxDriftBps_ > 10_000) revert BadConfig();
        _mustExist(basketId);
        baskets[basketId].maxDriftBps = maxDriftBps_;
        emit DriftUpdated(basketId, maxDriftBps_);
    }

    function setBasketPaused(uint64 basketId, bool paused_)
        external
        onlyRole(PAUSER_ROLE)
    {
        _mustExist(basketId);
        baskets[basketId].paused = paused_;
        emit BasketPaused(basketId, paused_);
    }

    // ═══════════════════════════════════════════════════════════
    //  Keeper
    // ═══════════════════════════════════════════════════════════

    /// @notice Push a new NAV value. Must respect `maxDriftBps` vs the previous
    ///         push (only enforced once a prior NAV exists).
    function pushNav(uint64 basketId, uint256 navUsd6)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
    {
        if (navUsd6 == 0) revert ZeroValue();
        Basket storage b = baskets[basketId];
        if (!b.registered) revert UnknownBasket(basketId);

        if (b.lastNavUsd6 != 0) {
            // Drift check — reject if |next - prev| / prev > maxDriftBps
            uint256 prev = b.lastNavUsd6;
            uint256 diff = navUsd6 > prev ? navUsd6 - prev : prev - navUsd6;
            // diff * 10000 > prev * maxDriftBps
            if (diff * 10_000 > prev * uint256(b.maxDriftBps)) {
                revert DriftExceeded(basketId, prev, navUsd6, b.maxDriftBps);
            }
        }

        b.lastNavUsd6 = navUsd6;
        b.lastNavAt   = uint64(block.timestamp);
        emit NavPushed(basketId, navUsd6, uint64(block.timestamp));
    }

    // ═══════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════

    /// @notice Current NAV in USDC (6-dec). Reverts if stale or frozen.
    function getNav(uint64 basketId) external view returns (uint256 navUsd6, uint64 at) {
        Basket storage b = baskets[basketId];
        if (!b.registered) revert UnknownBasket(basketId);
        if (b.paused) revert BasketFrozen(basketId);
        if (block.timestamp > uint256(b.lastNavAt) + uint256(b.maxStalenessSecs)) {
            revert NavStale(basketId, b.lastNavAt, b.maxStalenessSecs);
        }
        return (b.lastNavUsd6, b.lastNavAt);
    }

    /// @notice Same as getNav but never reverts — use for UI / diagnostics
    ///         where showing a stale value is preferable to blank.
    function getNavLenient(uint64 basketId)
        external
        view
        returns (uint256 navUsd6, uint64 at, bool stale, bool frozen)
    {
        Basket storage b = baskets[basketId];
        if (!b.registered) revert UnknownBasket(basketId);
        navUsd6 = b.lastNavUsd6;
        at = b.lastNavAt;
        frozen = b.paused;
        stale = block.timestamp > uint256(b.lastNavAt) + uint256(b.maxStalenessSecs);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ═══════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════

    function _mustExist(uint64 basketId) internal view {
        if (!baskets[basketId].registered) revert UnknownBasket(basketId);
    }
}
