// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal slice of a Compound V3 (Comet) market. Comet markets are
///         single-base-asset — for us, the base asset is USDC and the Comet
///         contract tracks per-account USDC balances (principal + accrued
///         interest) via `balanceOf`.
interface IComet {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function baseToken() external view returns (address);
}

/// @title CompoundV3Sink
/// @notice Synchronous USDC yield sink wrapping a Compound V3 (Comet) market.
///         Mirrors `AaveV3Sink` in every respect — same CONTROLLER_ROLE
///         pattern, same `deposit` / `withdraw` / `totalAssets` surface —
///         so SweepController v2 or an admin keeper can treat it as a
///         drop-in alternative to the Aave sink.
///
///         Yield: cUSDCv3's `balanceOf(this)` returns USDC + accrued interest
///         denominated in USDC directly (Compound V3 does NOT use an
///         aToken / cToken wrapper — balance growth happens in-place).
///
///         Sync — `withdraw(amount)` returns USDC in the same tx. Comet
///         enforces a supply cap; if the market is over-subscribed, withdraw
///         can still pull up to this sink's position. Deposits revert if the
///         market is paused.
contract CompoundV3Sink is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

    IERC20 public immutable USDC;
    IComet public immutable COMET;

    event SinkDeposited(address indexed caller, uint256 amount, uint256 totalAssets);
    event SinkWithdrawn(address indexed caller, uint256 amount, uint256 totalAssets);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 wanted, uint256 have);
    error BaseTokenMismatch(address expected, address got);

    constructor(address admin, address controller, address _usdc, address _comet) {
        if (admin == address(0) || controller == address(0)) revert ZeroAddress();
        if (_usdc == address(0) || _comet == address(0)) revert ZeroAddress();

        // Fail-fast: the Comet market MUST be denominated in the USDC we
        // expect. Catches the footgun of pointing at a wrong Comet market
        // (e.g. cWETHv3 or a different chain's cUSDCv3) at config time.
        address base = IComet(_comet).baseToken();
        if (base != _usdc) revert BaseTokenMismatch(_usdc, base);

        USDC  = IERC20(_usdc);
        COMET = IComet(_comet);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONTROLLER_ROLE, controller);
    }

    /// @notice Pull `amount` USDC from caller, supply it to Comet on this
    ///         contract's behalf. Supply grows `balanceOf(this)` inside Comet
    ///         without any wrapped-token transfer.
    function deposit(uint256 amount) external nonReentrant onlyRole(CONTROLLER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        IERC20(address(USDC)).forceApprove(address(COMET), amount);
        COMET.supply(address(USDC), amount);
        emit SinkDeposited(msg.sender, amount, totalAssets());
    }

    /// @notice Withdraw `amount` USDC from Comet to the caller. If `amount`
    ///         exceeds this sink's Comet balance, only the available balance
    ///         is pulled — mirrors AaveV3Sink's cap behavior.
    ///         Returns the actual USDC delivered (measured via balance delta
    ///         to tolerate future Comet fee changes transparently).
    function withdraw(uint256 amount) external nonReentrant onlyRole(CONTROLLER_ROLE) returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = COMET.balanceOf(address(this));
        if (bal == 0) revert InsufficientBalance(amount, 0);
        uint256 want = amount > bal ? bal : amount;

        uint256 before = USDC.balanceOf(address(this));
        COMET.withdraw(address(USDC), want);
        received = USDC.balanceOf(address(this)) - before;

        if (received > 0) USDC.safeTransfer(msg.sender, received);
        emit SinkWithdrawn(msg.sender, received, totalAssets());
    }

    /// @notice Live USDC value parked in Comet (principal + accrued interest).
    function totalAssets() public view returns (uint256) {
        return COMET.balanceOf(address(this));
    }

    /// @notice Admin escape hatch — pull a non-USDC token sent here by
    ///         mistake. USDC is blocked because it's managed state.
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(USDC)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
