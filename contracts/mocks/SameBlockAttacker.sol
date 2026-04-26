// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ILendingPool {
    function borrow(address nft, uint256 tokenId, uint256 amount) external returns (uint256);
    function repay(uint256 loanId, uint256 amount) external returns (uint256, uint256);
}

/// @dev Test-only attacker. Tries to borrow and repay in a single tx.
///      Should revert with SameBlockBorrowRepay when repay is attempted.
contract SameBlockAttacker is IERC721Receiver {
    function attack(address pool, address nft, uint256 tokenId, uint256 amount, address usdc) external returns (uint256) {
        IERC721(nft).setApprovalForAll(pool, true);
        uint256 loanId = ILendingPool(pool).borrow(nft, tokenId, amount);
        IERC20(usdc).approve(pool, type(uint256).max);
        ILendingPool(pool).repay(loanId, amount);
        return loanId;
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
