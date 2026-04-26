// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Shadow Pass maps passId → (yieldTokenId, basketTokenId).
interface IShadowPass {
    function wrappedOf(uint256 passId) external view returns (uint128 yieldTokenId, uint128 basketTokenId, uint64 wrappedAt);
    function ownerOf(uint256 passId) external view returns (address);
}

interface IYieldReceipt {
    function positionOf(uint256 tokenId) external view returns (uint64 strategyId, uint64 depositTime, uint128 principalUsd6, uint8 tier);
    function liveAccruedYield(uint256 tokenId) external view returns (uint256);
}

interface IBasketReceipt {
    function liveValue(uint256 tokenId) external view returns (uint256 valueUsd6, bool stale, bool frozen);
}

/// @title ShadowPassValuer
/// @notice IVaultValue-compatible adapter for ShadowPass NFTs. Lets the
///         LZ bridge (HyperPositionLocker) and the Arb NFTValuer treat a
///         ShadowPass as a single unified position with a live USDC value.
///
///         ShadowPass itself is a wrapper of (YieldReceipt + BasketReceipt)
///         — no single `vault()` to call. This valuer composes the two:
///
///           yield leg  = yieldReceipt.principalUsd6 + liveAccruedYield
///           basket leg = basketReceipt.liveValue(basketTokenId)
///           total      = yield leg + basket leg
///
///         Defensive behavior:
///           - If the basket oracle is frozen, basketVal = 0 (loans refuse
///             until the DAO unfreezes — same property the lending pool
///             already relies on for stale oracles).
///           - If the pass doesn't exist, underlying calls revert and we
///             bubble the revert (locker's lockAndBridge will revert cleanly).
///           - If the basket oracle is stale but not frozen, we still return
///             the value but flag it off-chain via the `(stale, frozen)`
///             tuple surfaced in `liveValueDetail`. The lending pool's
///             VAULT_MIRROR path doesn't distinguish — but operators can
///             monitor `liveValueDetail` before liquidating.
contract ShadowPassValuer {
    IShadowPass      public immutable SHADOW_PASS;
    IYieldReceipt    public immutable YIELD_RECEIPT;
    IBasketReceipt   public immutable BASKET_RECEIPT;

    error ZeroAddress();

    constructor(address shadowPass_, address yieldReceipt_, address basketReceipt_) {
        if (shadowPass_ == address(0) || yieldReceipt_ == address(0) || basketReceipt_ == address(0)) {
            revert ZeroAddress();
        }
        SHADOW_PASS    = IShadowPass(shadowPass_);
        YIELD_RECEIPT  = IYieldReceipt(yieldReceipt_);
        BASKET_RECEIPT = IBasketReceipt(basketReceipt_);
    }

    /// @notice IVaultValue.estimatePositionValue — returns the three-tuple
    ///         the LZ locker + Arb NFTValuer both expect.
    function estimatePositionValue(uint256 passId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total)
    {
        (uint128 yId, uint128 bId, ) = SHADOW_PASS.wrappedOf(passId);

        // Yield leg — principal + live accrued.
        (, , uint128 principalUsd6, ) = YIELD_RECEIPT.positionOf(uint256(yId));
        uint256 accrued = YIELD_RECEIPT.liveAccruedYield(uint256(yId));
        yieldVal = uint256(principalUsd6) + accrued;

        // Basket leg — frozen → 0 (lending refuses), stale → still report.
        (uint256 bValue, , bool frozen) = BASKET_RECEIPT.liveValue(uint256(bId));
        basketVal = frozen ? 0 : bValue;

        total = basketVal + yieldVal;
    }

    /// @notice Same as estimatePositionValue but surfaces the (stale, frozen)
    ///         flags from the basket oracle. For keeper / operator monitoring.
    function liveValueDetail(uint256 passId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total, bool stale, bool frozen)
    {
        (uint128 yId, uint128 bId, ) = SHADOW_PASS.wrappedOf(passId);
        (, , uint128 principalUsd6, ) = YIELD_RECEIPT.positionOf(uint256(yId));
        yieldVal = uint256(principalUsd6) + YIELD_RECEIPT.liveAccruedYield(uint256(yId));
        (uint256 bValue, bool s, bool f) = BASKET_RECEIPT.liveValue(uint256(bId));
        stale = s;
        frozen = f;
        basketVal = f ? 0 : bValue;
        total = basketVal + yieldVal;
    }
}
