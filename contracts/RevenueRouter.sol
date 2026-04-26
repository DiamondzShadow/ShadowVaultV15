// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal interface for the SDMDODOSeederV2 contract.
interface ISDMDODOSeeder {
    function seed(uint256 usdcAmount) external;
}

/// @title RevenueRouter (V15)
/// @notice Routes protocol-fee USDC to the DODO SDM/USDC LP seeder and the
///         treasury. Rewritten to use OZ v5 AccessControl with an explicit
///         AUTHORIZED_ROLE for vaults/adapters that are allowed to call
///         `routeRevenue`.
contract RevenueRouter is AccessControl {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant AUTHORIZED_ROLE = keccak256("AUTHORIZED_ROLE");

    // ───────── Constants ─────────
    IERC20 public constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);

    // ───────── State ─────────
    address public seeder;
    address public treasury;
    uint256 public seederSplitBps;
    uint256 public totalRouted;

    // ───────── Events ─────────
    event RevenueRouted(uint256 total, uint256 toSeeder, uint256 toTreasury);
    event SeederUpdated(address newSeeder);
    event TreasuryUpdated(address newTreasury);
    event SplitUpdated(uint256 seederBps, uint256 treasuryBps);

    // ───────── Errors ─────────
    error InvalidSplit(uint256 sum);
    error ZeroAddress();

    constructor(address admin, address _seeder, address _treasury) {
        if (_seeder == address(0) || _treasury == address(0) || admin == address(0)) revert ZeroAddress();
        seeder = _seeder;
        treasury = _treasury;
        seederSplitBps = 5000;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Pulls `amount` USDC from the caller, splits it between the seeder and the treasury.
    function routeRevenue(uint256 amount) external onlyRole(AUTHORIZED_ROLE) {
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        uint256 toSeeder = (amount * seederSplitBps) / 10_000;
        uint256 toTreasury = amount - toSeeder;

        if (toSeeder > 0) {
            USDC.forceApprove(seeder, toSeeder);
            ISDMDODOSeeder(seeder).seed(toSeeder);
        }
        if (toTreasury > 0) {
            USDC.safeTransfer(treasury, toTreasury);
        }

        totalRouted += amount;
        emit RevenueRouted(amount, toSeeder, toTreasury);
    }

    // ───────── Admin ─────────

    function setSeeder(address _seeder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_seeder == address(0)) revert ZeroAddress();
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
    //  Rescue (admin) — router flushes on every routeRevenue, so
    //  legitimate balance between calls is 0.
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
