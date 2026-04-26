// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev Minimal Aave V3 pool surface — supply + withdraw only. No borrow.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @title AaveAdapterV5
/// @notice Supply-only Aave V3 adapter for ShadowVaultV15. Deposits native USDC
///         to Aave, receives aUSDC, harvests accrued interest on demand, and
///         returns principal + yield on withdraw.
/// @dev Access control:
///   - DEFAULT_ADMIN_ROLE: Gnosis Safe (post-test) / deployer EOA during testing.
///                         Can add/remove vaults and reset accounting.
///   - VAULT_ROLE: the ShadowVaultV15 contract(s) allowed to deposit/withdraw/harvest.
contract AaveAdapterV5 is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20    public immutable USDC  = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20    public immutable aUSDC = IERC20(0x724dc807b04555b71ed48a6896b6F41593b8C637);
    IAavePool public immutable AAVE  = IAavePool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);

    // ───────── State ─────────
    /// @notice Running sum of principal USDC deposited (not including accrued yield).
    ///         Used as the baseline against which `harvest()` computes profit.
    uint256 public totalPrincipal;

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 amount, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 profit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);

    // ───────── Errors ─────────
    error ZeroAmount();
    error NotVault();

    // ───────── Constructor ─────────
    /// @param admin Initial DEFAULT_ADMIN_ROLE holder (deployer EOA; transferred to Gnosis Safe post-test).
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Pre-approve the Aave pool for unlimited USDC — reduces per-tx gas.
        USDC.forceApprove(address(AAVE), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev aUSDC is rebasing so `balanceOf` already reflects principal + accrued yield.
    function totalAssets() external view override returns (uint256) {
        return aUSDC.balanceOf(address(this));
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
        AAVE.supply(address(USDC), amount, address(this), 0);
        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Clamps the requested amount to the current aUSDC balance so partial
    ///      withdrawals never revert the calling vault's withdraw flow.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 aBal = aUSDC.balanceOf(address(this));
        uint256 toWithdraw = amount > aBal ? aBal : amount;
        if (toWithdraw == 0) {
            emit Withdrawn(msg.sender, amount, 0, totalPrincipal);
            return 0;
        }

        delivered = AAVE.withdraw(address(USDC), toWithdraw, address(this));
        USDC.safeTransfer(msg.sender, delivered);

        // Reduce principal by the withdrawn amount, but never underflow.
        // (In practice `delivered` includes a slice of accrued interest, so
        //  principal decays slightly faster than the vault's accounting — this
        //  is the intended conservative behaviour: principal represents "net
        //  cost basis", not cash out.)
        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;

        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Skims 50% of the accrued yield, leaving a buffer so `totalAssets()`
    ///      never drops below `totalPrincipal` for vault accounting safety.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 aBal = aUSDC.balanceOf(address(this));
        if (aBal <= totalPrincipal) return 0;

        uint256 excess = aBal - totalPrincipal;
        uint256 toHarvest = excess / 2;
        if (toHarvest == 0) return 0;

        profit = AAVE.withdraw(address(USDC), toHarvest, address(this));
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

    /// @notice Grant VAULT_ROLE to a vault contract. Admin only.
    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VAULT_ROLE, vault);
    }

    /// @notice Revoke VAULT_ROLE from a vault contract. Admin only.
    function removeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VAULT_ROLE, vault);
    }

    /// @notice Rescue an unexpected token. Cannot rescue USDC or aUSDC — those
    ///         are protocol collateral and must never leave except via the
    ///         normal withdraw/harvest path.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(USDC) && token != address(aUSDC), "protected");
        IERC20(token).safeTransfer(to, amount);
    }
}
