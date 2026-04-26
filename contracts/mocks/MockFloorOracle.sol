// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only floor oracle — returns admin-set USDC per NFT collection.
contract MockFloorOracle {
    mapping(address => uint256) public floors;

    function setFloor(address nft, uint256 usdc) external { floors[nft] = usdc; }

    function floorUSDC(address nft) external view returns (uint256) {
        return floors[nft];
    }
}
