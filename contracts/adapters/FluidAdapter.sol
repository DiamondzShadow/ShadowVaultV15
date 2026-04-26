// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev Fluid fToken is an ERC-4626-compliant vault that wraps the shared
///      Fluid Liquidity Layer. Deposits USDC, mints fUSDC shares whose
///      exchange rate appreciates as interest accrues. Not rebasing — share
///      balance stays constant, `convertToAssets` reflects yield.
interface IFluidFToken {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
}

/// @title FluidAdapter
/// @notice ShadowVaultV15 adapter for Fluid Lending fUSDC on Arbitrum.
///         Supply-side only — deposits USDC to fUSDC (ERC-4626), redeems on
///         withdraw. Interest accrues via the exchange-rate model, not via
///         rebasing, so `totalAssets()` is always fresh.
/// @dev fUSDC Arbitrum: 0x1A996cb54bb95462040408C06122D45D6Cdb6096 — verified
///      via Instadapp/fluid-contracts-public deployments.md and on-chain
///      `asset()` == native USDC. See Fluid docs for risk profile.
contract FluidAdapter is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20       public immutable USDC  = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IFluidFToken public immutable FUSDC = IFluidFToken(0x1A996cb54bb95462040408C06122D45D6Cdb6096);

    // ───────── State ─────────
    /// @notice Running sum of principal USDC deposited.
    uint256 public totalPrincipal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 shares, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error AssetMismatch();

    // ───────── Constructor ─────────
    constructor(address admin) {
        // Sanity-check on deploy: the fToken's underlying must be native USDC.
        if (FUSDC.asset() != address(USDC)) revert AssetMismatch();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        USDC.forceApprove(address(FUSDC), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Reads the live fUSDC exchange rate — always fresh, no staleness.
    function totalAssets() external view override returns (uint256) {
        return FUSDC.convertToAssets(FUSDC.balanceOf(address(this)));
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
        uint256 shares = FUSDC.deposit(amount, address(this));
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, shares, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Converts the requested USDC amount to shares, clamps to our
    ///      share balance + Fluid's maxWithdraw (utilization cap), then
    ///      redeems. This avoids the "withdraw rounds up" footgun where
    ///      asking for exactly your total would revert by 1 wei.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 shares = FUSDC.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = FUSDC.convertToAssets(shares);
        uint256 maxOut = FUSDC.maxWithdraw(address(this));
        uint256 cap = assetsHeld < maxOut ? assetsHeld : maxOut;
        uint256 toWithdraw = amount > cap ? cap : amount;

        if (toWithdraw == 0) {
            emit Withdrawn(msg.sender, amount, 0, totalPrincipal);
            return 0;
        }

        // Translate assets → shares, then redeem exactly that many shares.
        // Ceiling division prevents off-by-one under-withdraw.
        uint256 sharesToBurn = (toWithdraw * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        delivered = FUSDC.redeem(sharesToBurn, address(this), address(this));
        USDC.safeTransfer(msg.sender, delivered);

        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;

        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Harvests 50% of accrued yield, leaving a buffer to keep
    ///      `totalAssets()` ≥ `totalPrincipal`.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 shares = FUSDC.balanceOf(address(this));
        if (shares == 0) return 0;

        uint256 assetsHeld = FUSDC.convertToAssets(shares);
        if (assetsHeld <= totalPrincipal) return 0;

        uint256 excess = assetsHeld - totalPrincipal;
        uint256 toHarvest = excess / 2;
        if (toHarvest == 0) return 0;

        // Convert target USDC to shares (ceiling) and redeem.
        uint256 sharesToBurn = (toHarvest * shares + assetsHeld - 1) / assetsHeld;
        if (sharesToBurn > shares) sharesToBurn = shares;

        profit = FUSDC.redeem(sharesToBurn, address(this), address(this));
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
        require(token != address(USDC) && token != address(FUSDC), "protected");
        IERC20(token).safeTransfer(to, amount);
    }
}
