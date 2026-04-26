// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Temporary shim that returns the original depositor as the owner
///         of any position. Used to rescue pre-NFT positions where the real
///         NFT's ownerOf() reverts because no token was ever minted.
///
///         Deploy with the vault address, then call vault.setPositionNFT(shim).
///         After withdrawing, set the NFT back to the real one (or abandon the vault).
contract OwnerShim {
    address public immutable vault;

    constructor(address _vault) {
        vault = _vault;
    }

    /// @dev Returns positions[posId].depositor from the vault.
    ///      The vault's Position struct starts with `address depositor`,
    ///      so we call `positions(posId)` and take the first return value.
    function ownerOf(uint256 posId) external view returns (address) {
        // positions(uint256) returns (address depositor, ...)
        (bool ok, bytes memory data) = vault.staticcall(
            abi.encodeWithSignature("positions(uint256)", posId)
        );
        require(ok && data.length >= 32, "positions call failed");
        return abi.decode(data, (address));
    }

    /// @dev No-op stubs so the vault doesn't revert if it calls these.
    function mint(address, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePositionData(uint256, bytes calldata) external pure {}
}
