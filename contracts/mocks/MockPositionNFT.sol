// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Test-only ERC721 that exposes a `vault()` getter — required by the
///      LendingPool's `valueOf` path.
contract MockPositionNFT is ERC721 {
    address public vault;
    uint256 public nextId = 1;

    constructor(string memory n, string memory s, address _vault) ERC721(n, s) {
        vault = _vault;
    }

    function setVault(address v) external { vault = v; }
    function mint(address to) external returns (uint256 id) {
        id = nextId++;
        _mint(to, id);
    }
}
