// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev MetaMorpho vaults are fully ERC-4626 compliant. Deposits route through
///      the vault's `supplyQueue` into curated Morpho Blue markets. Withdrawals
///      pull from `withdrawQueue` in order. No timelocks on user operations.
interface IMetaMorpho {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
}

/// @title MorphoAdapter
/// @notice ShadowVaultV15 adapter for MetaMorpho curated USDC vaults on Arbitrum.
///         Identical in structure to FluidAdapter — both wrap an ERC-4626 vault.
///         Interest accrues via exchange-rate appreciation, not rebasing.
///
///         Default target: Gauntlet USDC Prime vault on Morpho Blue Arbitrum.
///         Curator vaults can be swapped by redeploying with a different address.
///
/// @dev MetaMorpho contracts on Arbitrum:
///      - Morpho singleton:      0x6c247b1F6182318877311737BaC0844bAa518F5e
///      - Gauntlet USDC Prime:   (set in constructor)
///      - Steakhouse High Yield: (alternative, $22M TVL)
///
///      MetaMorpho vaults have no withdraw timelocks or epoch mechanics.
///      `deposit` and `redeem` are atomic, single-tx operations.
contract MorphoAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20       public immutable USDC;
    IMetaMorpho  public immutable MORPHO_VAULT;

    // ───────── State ─────────
    uint256 public totalPrincipal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 shares, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error ZeroAddress();
    error AssetMismatch();

    // ───────── Constructor ─────────
    /// @param admin Initial DEFAULT_ADMIN_ROLE holder.
    /// @param morphoVault Address of the MetaMorpho ERC-4626 vault to use.
    constructor(address admin, address morphoVault) {
        if (admin == address(0) || morphoVault == address(0)) revert ZeroAddress();

        MORPHO_VAULT = IMetaMorpho(morphoVault);
        USDC = IERC20(MORPHO_VAULT.asset());

        // Sanity-check: the vault's underlying must be native Arbitrum USDC.
        if (address(USDC) != 0xaf88d065e77c8cC2239327C5EDb3A432268e5831) revert AssetMismatch();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        USDC.forceApprove(morphoVault, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    function totalAssets() external view override returns (uint256) {
        return MORPHO_VAULT.convertToAssets(MORPHO_VAULT.balanceOf(address(this)));
    }

    /// @inheritdoc IYieldAdapter
    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        uint256 shares = MORPHO_VAULT.deposit(amount, address(this));
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, shares, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 shares = MORPHO_VAULT.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = MORPHO_VAULT.convertToAssets(shares);
        uint256 maxOut = MORPHO_VAULT.maxWithdraw(address(this));
        uint256 cap = assetsHeld < maxOut ? assetsHeld : maxOut;
        uint256 toWithdraw = amount > cap ? cap : amount;

        if (toWithdraw == 0) {
            emit Withdrawn(msg.sender, amount, 0, totalPrincipal);
            return 0;
        }

        uint256 sharesToBurn = (toWithdraw * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        delivered = MORPHO_VAULT.redeem(sharesToBurn, address(this), address(this));
        USDC.safeTransfer(msg.sender, delivered);

        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;
        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 shares = MORPHO_VAULT.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = MORPHO_VAULT.convertToAssets(shares);
        if (assetsHeld <= totalPrincipal) return 0;

        uint256 excess = assetsHeld - totalPrincipal;
        uint256 toHarvest = excess / 2;
        if (toHarvest == 0) return 0;

        uint256 sharesToBurn = (toHarvest * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        profit = MORPHO_VAULT.redeem(sharesToBurn, address(this), address(this));
        if (profit > 0) {
            USDC.safeTransfer(msg.sender, profit);
        }

        emit Harvested(msg.sender, profit);
    }

    /// @inheritdoc IYieldAdapter
    function syncAccounting(uint256 newPrincipal) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = totalPrincipal;
        totalPrincipal = newPrincipal;
        emit AccountingSynced(old, newPrincipal);
    }

    // ═══════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════

    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault);
    }

    function removeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault);
    }

    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(
            token != address(USDC) && token != address(MORPHO_VAULT),
            "protected"
        );
        IERC20(token).safeTransfer(to, amount);
    }
}
