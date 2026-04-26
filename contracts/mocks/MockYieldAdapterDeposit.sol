// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Mock yield adapter that actually accepts USDC deposits — for
///         end-to-end Pool F vault tests.
contract MockYieldAdapterDeposit {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public totalAssets;
    uint256 public totalPrincipal;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        totalAssets += amount;
    }

    function setBalances(uint256 _totalAssets, uint256 _totalPrincipal) external {
        totalAssets = _totalAssets;
        totalPrincipal = _totalPrincipal;
    }
}
