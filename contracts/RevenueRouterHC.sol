// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal seeder interface (kept identical to the Arb RevenueRouter
///      so future migration is a one-line address change).
interface ISDMDODOSeeder {
    function seed(uint256 usdcAmount) external;
}

/// @title RevenueRouterHC (V15 — HyperEVM)
/// @notice HyperEVM sibling of `RevenueRouter.sol`. Same pull-based interface
///         (`routeRevenue`), same split logic, but:
///           - USDC is passed in via constructor (HyperEVM USDC0, not Arb USDC).
///           - The seeder may be address(0) at launch. When unset, the full
///             amount goes to the treasury (so launch doesn't block on a
///             native SDM/USDC pool existing on HyperEVM).
///           - When a seeder is wired later, `setSeeder` flips the split in.
contract RevenueRouterHC is AccessControl {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant AUTHORIZED_ROLE = keccak256("AUTHORIZED_ROLE");

    // ───────── Immutables ─────────
    IERC20 public immutable USDC;

    // ───────── State ─────────
    address public seeder;          // may be address(0) until SDM launches on HL
    address public treasury;
    uint256 public seederSplitBps;  // applied only when `seeder != address(0)`
    uint256 public totalRouted;

    // ───────── Events ─────────
    event RevenueRouted(uint256 total, uint256 toSeeder, uint256 toTreasury);
    event SeederUpdated(address newSeeder);
    event TreasuryUpdated(address newTreasury);
    event SplitUpdated(uint256 seederBps, uint256 treasuryBps);

    // ───────── Errors ─────────
    error InvalidSplit(uint256 sum);
    error ZeroAddress();

    constructor(address admin, address _usdc, address _seeder, address _treasury) {
        if (admin == address(0) || _usdc == address(0) || _treasury == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        seeder = _seeder;   // allowed to be address(0) at launch
        treasury = _treasury;
        seederSplitBps = 5000;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Pulls `amount` USDC from caller, routes it.
    ///         If no seeder is configured yet, everything goes to treasury.
    function routeRevenue(uint256 amount) external onlyRole(AUTHORIZED_ROLE) {
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 toSeeder;
        uint256 toTreasury;
        if (seeder == address(0)) {
            toTreasury = amount;
        } else {
            toSeeder = (amount * seederSplitBps) / 10_000;
            toTreasury = amount - toSeeder;
            if (toSeeder > 0) {
                USDC.forceApprove(seeder, toSeeder);
                ISDMDODOSeeder(seeder).seed(toSeeder);
            }
        }
        if (toTreasury > 0) {
            USDC.safeTransfer(treasury, toTreasury);
        }

        totalRouted += amount;
        emit RevenueRouted(amount, toSeeder, toTreasury);
    }

    // ───────── Admin ─────────

    /// @notice Setting seeder to the zero address disables the split (route
    ///         everything to treasury). Useful if the SDM pool is paused.
    function setSeeder(address _seeder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        seeder = _seeder;
        emit SeederUpdated(_seeder);
    }

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setSplit(uint256 seederBps, uint256 treasuryBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seederBps + treasuryBps != 10_000) revert InvalidSplit(seederBps + treasuryBps);
        seederSplitBps = seederBps;
        emit SplitUpdated(seederBps, treasuryBps);
    }

    function addAuthorized(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(AUTHORIZED_ROLE, account);
    }

    function removeAuthorized(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(AUTHORIZED_ROLE, account);
    }

    // ══════════════════════════════════════════════════════════
    //  Rescue (admin)
    // ══════════════════════════════════════════════════════════

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error NativeRescueFailed();

    function rescueToken(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeRescueFailed();
        emit NativeRescued(to, amount);
    }

    receive() external payable {}
}
