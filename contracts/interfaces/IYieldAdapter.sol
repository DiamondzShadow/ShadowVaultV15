// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IYieldAdapter
/// @notice Common interface all V15 yield adapters (Aave / Fluid / Pendle / ...)
///         must implement. The vault does not care which underlying protocol
///         the adapter talks to, only that it can deposit USDC, withdraw
///         USDC, report total assets, and harvest profit.
///
/// Accounting invariants:
///   - `asset()` MUST be native Arbitrum USDC (0xaf88...5831).
///   - `totalAssets()` MUST return the current USDC value of all funds the
///     adapter is managing, including accrued yield.
///   - `deposit(amount)` MUST pull `amount` USDC from `msg.sender` via
///     transferFrom and route it into the underlying protocol.
///   - `withdraw(amount)` MUST return at most `amount` USDC to `msg.sender`
///     and return the actual amount delivered (may be less if the adapter
///     can't liquidate fully, e.g. Pendle market slippage).
///   - `harvest()` MUST return USDC profit realised since the previous
///     harvest (can be 0) and leave the principal intact where possible.
///   - `syncAccounting(uint256)` is an admin escape hatch for when on-chain
///     state diverges from adapter internal bookkeeping (e.g. after a
///     rescue tx). Required because every V14-style adapter eventually drifts.
interface IYieldAdapter {
    /// @notice The underlying USDC address the adapter operates on.
    function asset() external view returns (address);

    /// @notice Current USDC value managed by the adapter, including yield.
    function totalAssets() external view returns (uint256);

    /// @notice Deposit USDC pulled from the caller into the adapter.
    /// @dev Caller MUST be the vault (enforced by VAULT_ROLE).
    /// @param amount USDC amount to deposit (6-decimal).
    function deposit(uint256 amount) external;

    /// @notice Withdraw up to `amount` USDC back to the caller.
    /// @dev Caller MUST be the vault. Returns the actual amount delivered.
    /// @param amount Requested USDC amount (6-decimal).
    /// @return delivered Actual USDC transferred.
    function withdraw(uint256 amount) external returns (uint256 delivered);

    /// @notice Harvest accrued yield into USDC and forward it to the vault.
    /// @dev Caller MUST be the vault. Returns the profit realised (can be 0).
    /// @return profit USDC profit forwarded to the vault.
    function harvest() external returns (uint256 profit);

    /// @notice Admin-only: reset the adapter's internal principal bookkeeping.
    /// @dev Used when on-chain state diverges from accounting (rescue txs,
    ///      pre-production reseeding, etc.). Does NOT move any tokens.
    /// @param newPrincipal The principal amount to record going forward.
    function syncAccounting(uint256 newPrincipal) external;
}
