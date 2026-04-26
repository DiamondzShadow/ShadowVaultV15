// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Test-only ERC721 with auto-incrementing tokenIds. mint() is open
///      so tests can hand out tokens to any address.
contract MockERC721 is ERC721 {
    uint256 public nextId = 1;
    constructor(string memory n, string memory s) ERC721(n, s) {}
    function mint(address to) external returns (uint256 id) {
        id = nextId++;
        _mint(to, id);
    }
}
