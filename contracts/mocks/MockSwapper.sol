// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSwapper
/// @notice Test-only swap target that stands in for 0x / 1inch during fork tests.
///         The vault sends `tokenIn` + calldata; this contract decodes the
///         calldata to know how much `tokenOut` to deliver, and transfers
///         `tokenOut` from a pre-funded reserve.
///
/// Usage in tests:
///   1. Deploy MockSwapper
///   2. Fund it with all basket tokens + USDC (simulate "market liquidity")
///   3. vault.setTrustedSwapTarget(mockSwapper, true)
///   4. Keeper calls vault.executeBuyBasket / executeRebalance / executeWithdrawalSwap
///      with tokenIn, tokenOut, amountIn, and calldata = abi.encode(this.swap.selector, ...)
contract MockSwapper {
    using SafeERC20 for IERC20;

    /// @notice Execute a fake swap: pull `amountIn` of `tokenIn`, push `amountOut` of `tokenOut`.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
