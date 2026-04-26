// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal aToken-like mock — 1:1 with USDC, no yield. Tests use
///         direct mints to simulate yield growth.
interface IMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @dev Test-only Aave V3 Pool stand-in. Receives USDC, mints aUSDC 1:1.
contract MockAavePool {
    using SafeERC20 for IERC20;

    address public usdc;
    address public ausdc;

    constructor(address _usdc, address _ausdc) {
        usdc = _usdc;
        ausdc = _ausdc;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 /*ref*/) external {
        require(asset == usdc, "asset");
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        IMintBurn(ausdc).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == usdc, "asset");
        IMintBurn(ausdc).burn(msg.sender, amount);
        IERC20(usdc).safeTransfer(to, amount);
        return amount;
    }
}
