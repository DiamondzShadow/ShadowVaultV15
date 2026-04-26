// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev Silo V2 interface — ERC-4626 compliant plus the collateral-type
///      variants we need. CollateralType.Collateral is the interest-earning
///      side; Protected earns nothing.
///
///      Source: silo-contracts-v2/silo-core/contracts/interfaces/ISilo.sol
interface ISilo {
    enum CollateralType { Protected, Collateral }

    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxWithdraw(address owner, CollateralType collateralType) external view returns (uint256);
    function accrueInterest() external returns (uint256);

    function deposit(uint256 assets, address receiver, CollateralType collateralType)
        external returns (uint256 shares);

    function withdraw(uint256 assets, address receiver, address owner, CollateralType collateralType)
        external returns (uint256 shares);

    function redeem(uint256 shares, address receiver, address owner, CollateralType collateralType)
        external returns (uint256 assets);
}

/// @title SiloAdapter
/// @notice ShadowVaultV15 adapter for Silo V2 isolated-pair USDC markets
///         on Arbitrum. Default target is the wstUSR/USDC silo (USDC side),
///         which is the largest USDC V2 silo on Arbitrum with ~$356M TVL
///         as of April 2026.
///
/// @dev Silo V2 silos are ERC-4626 vaults but with a 3-arg deposit that takes
///      a `CollateralType` enum. We always pass `Collateral` (interest-earning).
///      Full exits MUST use `redeem(shares)` not `withdraw(assets)` — interest
///      accrual between sim and execution makes `withdraw(totalAssets())` revert
///      by 1 wei. This is documented in docs.silo.finance.
///
/// @dev Silo is an isolated-pair protocol — USDC suppliers in the wstUSR/USDC
///      market are exposed to bad debt if wstUSR cascades. If that's a concern,
///      admin can point `setSilo` at a different USDC-side silo. Market must
///      be fully unwound before switching.
contract SiloAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20 public immutable USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    /// @notice Default silo — wstUSR/USDC V2 (USDC side). Overridable via `setSilo`.
    address public constant DEFAULT_SILO = 0xa9a4BD976DbcFC2b89f554467ac85e2C758e2618;

    // ───────── State ─────────
    /// @notice The Silo V2 silo this adapter is currently pointed at.
    ISilo public silo;
    /// @notice Running sum of principal USDC deposited.
    uint256 public totalPrincipal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 shares, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event SiloUpdated(address indexed oldSilo, address indexed newSilo);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error AssetMismatch();
    error SiloBusy();

    // ───────── Constructor ─────────
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        silo = ISilo(DEFAULT_SILO);
        if (silo.asset() != address(USDC)) revert AssetMismatch();
        USDC.forceApprove(DEFAULT_SILO, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev ERC-4626 share→assets conversion. Always fresh for view functions;
    ///      interest accrues lazily on deposit/withdraw so totalAssets() may
    ///      be a few wei below the true value until the next interaction.
    function totalAssets() external view override returns (uint256) {
        uint256 shares = silo.balanceOf(address(this));
        if (shares == 0) return 0;
        return silo.convertToAssets(shares);
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
        uint256 shares = silo.deposit(amount, address(this), ISilo.CollateralType.Collateral);
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, shares, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Clamps to Silo's `maxWithdraw` (utilization cap) AND to our current
    ///      share value. Uses `withdraw(assets)` for partial exits. For full
    ///      exits (amount > held), falls through to `redeem(shares)` to dodge
    ///      the 1-wei interest-accrual revert documented in Silo V2.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 shares = silo.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = silo.convertToAssets(shares);
        uint256 maxOut = silo.maxWithdraw(address(this), ISilo.CollateralType.Collateral);
        uint256 cap = assetsHeld < maxOut ? assetsHeld : maxOut;
        uint256 toWithdraw = amount > cap ? cap : amount;

        if (toWithdraw == 0) {
            emit Withdrawn(msg.sender, amount, 0, totalPrincipal);
            return 0;
        }

        // If the caller wants ≥ everything we hold (within our cap), burn all
        // shares via `redeem` to avoid the ERC-4626 rounding footgun.
        if (toWithdraw >= assetsHeld) {
            delivered = silo.redeem(shares, address(this), address(this), ISilo.CollateralType.Collateral);
        } else {
            silo.withdraw(toWithdraw, address(this), address(this), ISilo.CollateralType.Collateral);
            delivered = toWithdraw;
        }

        USDC.safeTransfer(msg.sender, delivered);
        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;

        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Skims 50% of accrued interest, leaving a buffer so
    ///      `totalAssets()` stays ≥ `totalPrincipal`.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        // Nudge Silo to accrue interest so totalAssets is fresh.
        silo.accrueInterest();

        uint256 shares = silo.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = silo.convertToAssets(shares);
        if (assetsHeld <= totalPrincipal) return 0;

        uint256 excess = assetsHeld - totalPrincipal;
        uint256 toHarvest = excess / 2;
        if (toHarvest == 0) return 0;

        // Check utilization — if we can't pull this much, skip rather than revert.
        uint256 maxOut = silo.maxWithdraw(address(this), ISilo.CollateralType.Collateral);
        if (toHarvest > maxOut) toHarvest = maxOut;
        if (toHarvest == 0) return 0;

        silo.withdraw(toHarvest, address(this), address(this), ISilo.CollateralType.Collateral);
        profit = toHarvest;
        USDC.safeTransfer(msg.sender, profit);

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

    /// @notice Point adapter at a different Silo V2 USDC-side silo. Market
    ///         must be fully unwound (zero share balance) before switching.
    function setSilo(address newSilo) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (silo.balanceOf(address(this)) > 0) revert SiloBusy();
        if (ISilo(newSilo).asset() != address(USDC)) revert AssetMismatch();

        address oldSilo = address(silo);
        // Zero old approval, set new.
        USDC.forceApprove(oldSilo, 0);
        silo = ISilo(newSilo);
        USDC.forceApprove(newSilo, type(uint256).max);

        emit SiloUpdated(oldSilo, newSilo);
    }

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
        require(token != address(USDC) && token != address(silo), "protected");
        IERC20(token).safeTransfer(to, amount);
    }
}
