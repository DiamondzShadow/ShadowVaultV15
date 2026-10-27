// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title MockERC4626
/// @notice Test double for a real 4626 yield venue, with switches for the failure modes we actually
///         observed in production rather than only the happy path:
///           - `accrue()`      — yield arrives as exchange-rate appreciation, not rebasing.
///           - `setDepositsOpen(false)` — reproduces Morpho's Polygon USDC vault, which reports
///             `maxDeposit() == 0` as a withdraw-only wind-down.
///           - `setLiquidityCap(n)` — reproduces a venue that is solvent but temporarily illiquid,
///             so `maxWithdraw()` is below the position's value.
contract MockERC4626 is ERC4626 {
    bool public depositsOpen = true;
    uint256 public liquidityCap = type(uint256).max;

    constructor(IERC20 asset_) ERC20("Mock Yield Vault", "mYV") ERC4626(asset_) {}

    /// @notice Simulate yield by minting underlying straight into the vault, lifting share price.
    function accrue(uint256 amount) external {
        // The test funds this contract; ERC4626 values by balance, so a plain transfer is enough.
        // Callers use a mintable mock asset.
        (bool ok, ) = address(asset()).call(
            abi.encodeWithSignature("mint(address,uint256)", address(this), amount)
        );
        require(ok, "accrue: asset must be mintable");
    }

    function setDepositsOpen(bool open) external {
        depositsOpen = open;
    }

    function setLiquidityCap(uint256 cap) external {
        liquidityCap = cap;
    }

    function maxDeposit(address) public view override returns (uint256) {
        return depositsOpen ? type(uint256).max : 0;
    }

    function maxMint(address) public view override returns (uint256) {
        return depositsOpen ? type(uint256).max : 0;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 natural = super.maxWithdraw(owner);
        return natural < liquidityCap ? natural : liquidityCap;
    }
}
