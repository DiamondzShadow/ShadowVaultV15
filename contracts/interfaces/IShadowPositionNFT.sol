// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IShadowPositionNFT
/// @notice Minimal interface the V15 vault needs from the Position NFT.
///         Kept separate so the vault can be unit-tested with a mock NFT.
interface IShadowPositionNFT {
    /// @notice Mint a new position NFT. Vault-only.
    /// @param to Recipient (the depositor).
    /// @param posData ABI-encoded position snapshot for SVG rendering.
    /// @return tokenId The newly minted token id.
    function mint(address to, bytes calldata posData) external returns (uint256 tokenId);

    /// @notice Owner of a given token id.
    function ownerOf(uint256 tokenId) external view returns (address);

    /// @notice Update the on-chain position snapshot used by the SVG (e.g. after compound).
    function updatePositionData(uint256 tokenId, bytes calldata posData) external;
}
