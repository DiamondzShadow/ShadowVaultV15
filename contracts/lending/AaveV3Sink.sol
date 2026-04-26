// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal slice of the Aave V3 Pool interface — supply/withdraw USDC.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @title AaveV3Sink
/// @notice Synchronous USDC yield sink wrapping Aave V3. Owned by the
///         LendingPool's SweepController — only the controller (or admin)
///         can move funds in or out.
///
///         Sync — `withdraw(amount)` returns USDC in the same tx, so the
///         LendingPool can pull liquidity on demand for borrowers without
///         waiting on bridges or epoch unwinds.
///
///         Yield: aUSDC accrues at the Aave supply APR. `totalAssets()`
///         returns the current aToken balance (which equals the underlying
///         USDC amount + accrued yield).
contract AaveV3Sink is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

    IERC20    public immutable USDC;
    /// @notice Aave V3 aUSDC for the asset on this chain.
    IERC20    public immutable AUSDC;
    IAavePool public immutable AAVE;

    event SinkDeposited(address indexed caller, uint256 amount, uint256 totalAssets);
    event SinkWithdrawn(address indexed caller, uint256 amount, uint256 totalAssets);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 wanted, uint256 have);

    constructor(address admin, address controller, address _usdc, address _ausdc, address _aave) {
        if (admin == address(0) || controller == address(0)) revert ZeroAddress();
        if (_usdc == address(0) || _ausdc == address(0) || _aave == address(0)) revert ZeroAddress();
        USDC  = IERC20(_usdc);
        AUSDC = IERC20(_ausdc);
        AAVE  = IAavePool(_aave);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONTROLLER_ROLE, controller);
    }

    /// @notice Pull `amount` USDC from caller, supply it to Aave on this contract's behalf.
    function deposit(uint256 amount) external nonReentrant onlyRole(CONTROLLER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        // forceApprove handles tokens (like USDT on some chains) that require
        // resetting allowance to 0 before raising; harmless on USDC.
        IERC20(address(USDC)).forceApprove(address(AAVE), amount);
        AAVE.supply(address(USDC), amount, address(this), 0);
        emit SinkDeposited(msg.sender, amount, totalAssets());
    }

    /// @notice Withdraw `amount` USDC from Aave to the caller. May return less
    ///         if Aave's withdrawable cap is hit — caller should check the
    ///         returned amount.
    function withdraw(uint256 amount) external nonReentrant onlyRole(CONTROLLER_ROLE) returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = AUSDC.balanceOf(address(this));
        if (bal == 0) revert InsufficientBalance(amount, 0);
        // type(uint256).max meaning "all" handled below.
        uint256 want = amount > bal ? bal : amount;
        received = AAVE.withdraw(address(USDC), want, msg.sender);
        emit SinkWithdrawn(msg.sender, received, totalAssets());
    }

    /// @notice Live USDC value parked in Aave (= aUSDC balance).
    function totalAssets() public view returns (uint256) {
        return AUSDC.balanceOf(address(this));
    }

    /// @notice Admin escape hatch — pull a non-USDC token sent here by mistake.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(USDC) || token == address(AUSDC)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
