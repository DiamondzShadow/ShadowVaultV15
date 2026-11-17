// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title GmNavOracle
/// @notice Keeper-pushed USDC NAV for GMX V2 GM positions, keyed by GM market
///         address. Mirrors BasketNavOracle: staleness + per-push drift caps,
///         per-market pause, global pause. `getNavUsdc` reverts on stale/frozen
///         so GmGmxAdapterV1.totalAssets() fails closed rather than reporting a
///         lie a compromised price-keeper could push.
///
/// @dev Drain-defense:
///      - KEEPER_ROLE can only move NAV within `maxDriftBps` per push (a
///        compromised keeper cannot mark the position to an arbitrary value).
///      - PAUSER_ROLE (guardian) freezes a market on anomaly → adapter NAV reads
///        revert → vault treats the sleeve as unpriceable rather than draining.
///      - DEFAULT_ADMIN_ROLE (Safe) tunes caps and roles only; holds no funds.
contract GmNavOracle is AccessControl, Pausable {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct MarketNav {
        bool    registered;
        uint256 lastNavUsd6;        // USDC 6-dec value of the GM position (GM + un-swept index)
        uint64  lastNavAt;
        uint32  maxStalenessSecs;   // e.g. 900
        uint16  maxDriftBps;        // e.g. 1000 = 10%
        bool    paused;
    }

    mapping(address => MarketNav) public navs;   // GM market => NAV

    event MarketRegistered(address indexed market, uint32 maxStalenessSecs, uint16 maxDriftBps);
    event NavPushed(address indexed market, uint256 navUsd6, uint64 at);
    event StalenessUpdated(address indexed market, uint32 maxStalenessSecs);
    event DriftUpdated(address indexed market, uint16 maxDriftBps);
    event MarketPausedSet(address indexed market, bool paused);

    error UnknownMarket(address market);
    error NavStale(address market, uint64 lastAt, uint32 maxStalenessSecs);
    error MarketFrozen(address market);
    error DriftExceeded(address market, uint256 prev, uint256 next, uint16 maxDriftBps);
    error BadConfig();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ───────── Admin ─────────
    function registerMarket(address market, uint32 maxStalenessSecs_, uint16 maxDriftBps_)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (market == address(0) || maxStalenessSecs_ == 0 || maxDriftBps_ == 0 || maxDriftBps_ > 10_000) revert BadConfig();
        navs[market] = MarketNav({
            registered: true, lastNavUsd6: 0, lastNavAt: 0,
            maxStalenessSecs: maxStalenessSecs_, maxDriftBps: maxDriftBps_, paused: false
        });
        emit MarketRegistered(market, maxStalenessSecs_, maxDriftBps_);
    }

    function setStaleness(address market, uint32 s) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (s == 0) revert BadConfig();
        _mustExist(market);
        navs[market].maxStalenessSecs = s;
        emit StalenessUpdated(market, s);
    }

    function setDriftCap(address market, uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > 10_000) revert BadConfig();
        _mustExist(market);
        navs[market].maxDriftBps = bps;
        emit DriftUpdated(market, bps);
    }

    function setMarketPaused(address market, bool p) external onlyRole(PAUSER_ROLE) {
        _mustExist(market);
        navs[market].paused = p;
        emit MarketPausedSet(market, p);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ───────── Keeper ─────────
    /// @notice Push the GM position's USDC value. First push (lastNav==0) bypasses
    ///         the drift check; afterwards moves are capped at maxDriftBps.
    function pushNav(address market, uint256 navUsd6) external onlyRole(KEEPER_ROLE) whenNotPaused {
        MarketNav storage m = navs[market];
        if (!m.registered) revert UnknownMarket(market);
        if (m.lastNavUsd6 != 0) {
            uint256 prev = m.lastNavUsd6;
            uint256 diff = navUsd6 > prev ? navUsd6 - prev : prev - navUsd6;
            if (diff * 10_000 > prev * uint256(m.maxDriftBps)) {
                revert DriftExceeded(market, prev, navUsd6, m.maxDriftBps);
            }
        }
        m.lastNavUsd6 = navUsd6;
        m.lastNavAt = uint64(block.timestamp);
        emit NavPushed(market, navUsd6, uint64(block.timestamp));
    }

    // ───────── Views (IGmNavOracle) ─────────
    /// @notice GM position NAV in USDC 6-dec. Reverts on unknown/frozen/stale.
    function getNavUsdc(address market) external view returns (uint256) {
        MarketNav storage m = navs[market];
        if (!m.registered) revert UnknownMarket(market);
        if (m.paused) revert MarketFrozen(market);
        if (block.timestamp > uint256(m.lastNavAt) + uint256(m.maxStalenessSecs)) {
            revert NavStale(market, m.lastNavAt, m.maxStalenessSecs);
        }
        return m.lastNavUsd6;
    }

    function getNavLenient(address market)
        external view returns (uint256 navUsd6, uint64 at, bool stale, bool frozen)
    {
        MarketNav storage m = navs[market];
        if (!m.registered) revert UnknownMarket(market);
        navUsd6 = m.lastNavUsd6;
        at = m.lastNavAt;
        frozen = m.paused;
        stale = block.timestamp > uint256(m.lastNavAt) + uint256(m.maxStalenessSecs);
    }

    function _mustExist(address market) internal view {
        if (!navs[market].registered) revert UnknownMarket(market);
    }
}
