// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only Compound V3 Comet mock. Tracks per-account USDC balance
///      internally (no wrapped token). `accrueInterest(account, delta)`
///      lets tests simulate yield growth.
contract MockComet {
    address public immutable base;
    mapping(address => uint256) private _balance;

    constructor(address _base) { base = _base; }

    function baseToken() external view returns (address) { return base; }

    function balanceOf(address account) external view returns (uint256) {
        return _balance[account];
    }

    function supply(address asset, uint256 amount) external {
        require(asset == base, "wrong asset");
        // Pull USDC from caller
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        _balance[msg.sender] += amount;
    }

    function withdraw(address asset, uint256 amount) external {
        require(asset == base, "wrong asset");
        require(_balance[msg.sender] >= amount, "insufficient");
        _balance[msg.sender] -= amount;
        IERC20(asset).transfer(msg.sender, amount);
    }

    /// @notice Test helper — credit an account with synthetic yield.
    function accrueInterest(address account, uint256 delta) external {
        _balance[account] += delta;
    }
}
