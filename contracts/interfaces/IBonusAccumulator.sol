// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBonusAccumulator
/// @notice Hook the V15 vault uses to register and deregister NFT
///         positions in the bonus-stream accumulator. The accumulator
///         tracks deposit*tier weights so revenue streams (bridge fees,
///         SDM rewards, validator fees) can be distributed proportionally
///         across active positions.
///
/// Zero-address tolerated: the vault treats a zero `bonusAccumulator`
/// as "feature disabled" and skips all calls. This lets us deploy the
/// vault before the accumulator's revenue sources are wired up.
interface IBonusAccumulator {
    /// @notice Called on deposit. Records the position's weighted share.
    /// @param tokenId Position NFT id.
    /// @param owner NFT owner (depositor).
    /// @param weight Effective share weight (depositAmount × tierMultiplier / BPS).
    function registerPosition(uint256 tokenId, address owner, uint256 weight) external;

    /// @notice Called on withdraw. Removes the position's weighted share
    ///         and auto-claims any pending bonuses to the owner.
    /// @param tokenId Position NFT id.
    function deregisterPosition(uint256 tokenId) external;

    /// @notice View accrued pending bonus for a position across all streams (USDC, 6-dec).
    function pendingForToken(uint256 tokenId) external view returns (uint256);
}
