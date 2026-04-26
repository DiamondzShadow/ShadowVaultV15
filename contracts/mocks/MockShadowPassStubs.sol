// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal stubs matching the interfaces ShadowPassValuer consumes.

contract MockShadowPass {
    struct W { uint128 y; uint128 b; uint64 ts; }
    mapping(uint256 => W) public _w;
    function setWrapped(uint256 passId, uint128 y, uint128 b) external {
        _w[passId] = W({ y: y, b: b, ts: uint64(block.timestamp) });
    }
    function wrappedOf(uint256 passId) external view returns (uint128, uint128, uint64) {
        W memory w = _w[passId]; return (w.y, w.b, w.ts);
    }
    function ownerOf(uint256 /*passId*/) external view returns (address) {
        return msg.sender; // unused by valuer
    }
}

contract MockYieldReceipt {
    struct Pos { uint64 strategyId; uint64 depositTime; uint128 principalUsd6; uint8 tier; }
    mapping(uint256 => Pos) private _pos;
    mapping(uint256 => uint256) private _accrued;

    function setPosition(uint256 tokenId, uint128 principalUsd6, uint8 tier) external {
        _pos[tokenId] = Pos({ strategyId: 0, depositTime: uint64(block.timestamp), principalUsd6: principalUsd6, tier: tier });
    }
    function setAccrued(uint256 tokenId, uint256 amt) external { _accrued[tokenId] = amt; }

    function positionOf(uint256 tokenId)
        external view returns (uint64 strategyId, uint64 depositTime, uint128 principalUsd6, uint8 tier)
    {
        Pos memory p = _pos[tokenId];
        return (p.strategyId, p.depositTime, p.principalUsd6, p.tier);
    }
    function liveAccruedYield(uint256 tokenId) external view returns (uint256) {
        return _accrued[tokenId];
    }
}

contract MockBasketReceipt {
    struct V { uint256 value; bool stale; bool frozen; }
    mapping(uint256 => V) private _v;
    function setValue(uint256 tokenId, uint256 value, bool stale, bool frozen) external {
        _v[tokenId] = V({ value: value, stale: stale, frozen: frozen });
    }
    function liveValue(uint256 tokenId) external view returns (uint256, bool, bool) {
        V memory x = _v[tokenId];
        return (x.value, x.stale, x.frozen);
    }
}
