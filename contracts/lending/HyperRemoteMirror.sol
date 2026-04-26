// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title HyperRemoteMirror
/// @notice Async USDC yield sink for funds parked on HyperEVM (Pool E HLP).
///         Same trust model as the SDM mirror: a keeper EOA (or set of) is
///         responsible for the cross-chain motion (Bridge2 / sendAsset /
///         vaultTransfer) and attests the resulting balance back to this
///         contract.
///
///         Flow:
///         - SweepController calls `deposit(amount)` → USDC sent to keeper
///           EOA on Arb. `pendingOutbound` increments. Keeper bridges to
///           HyperEVM and runs `confirmDeposit(amount)` once the funds land
///           in Pool E v2 vault. `pendingOutbound` decrements, `mirrored`
///           grows.
///         - SweepController calls `requestWithdraw(amount)` → emits an
///           event for the keeper to start the unwind. `pendingInbound`
///           increments. Keeper unwinds Pool E (4-day HLP lockup), bridges
///           USDC back to Arb, calls `confirmReturn(amount)` with USDC
///           attached. `pendingInbound` decrements, `mirrored` decrements,
///           USDC delivered to controller.
///
///         `totalAssets()` returns mirrored + pendingOutbound + pendingInbound
///         — i.e., everything in the off-chain pipeline counts as supplier
///         assets immediately. Sweep efficiency at the cost of a slightly
///         soft accounting boundary while in transit.
contract HyperRemoteMirror is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");
    bytes32 public constant KEEPER_ROLE     = keccak256("KEEPER_ROLE");

    IERC20  public immutable USDC;
    address public keeperPayoutWallet; // EOA the controller's deposit USDC routes to

    /// @notice USDC believed to be parked on HyperEVM Pool E (per keeper attestation).
    uint256 public mirrored;
    /// @notice USDC sent to keeper (Arb→HC in flight).
    uint256 public pendingOutbound;
    /// @notice USDC requested from HyperEVM (HC→Arb in flight).
    uint256 public pendingInbound;

    event RemoteDeposited(address indexed caller, uint256 amount, uint256 pendingOutbound);
    event RemoteDepositConfirmed(address indexed keeper, uint256 amount, uint256 mirrored);
    event RemoteWithdrawRequested(address indexed caller, uint256 amount, uint256 pendingInbound);
    event RemoteReturnConfirmed(address indexed keeper, uint256 amount, uint256 mirrored, uint256 deliveredTo);
    event KeeperPayoutWalletUpdated(address newWallet);

    error ZeroAddress();
    error ZeroAmount();
    error ExceedsPending(uint256 amount, uint256 pending);
    error ExceedsMirrored(uint256 amount, uint256 mirrored);

    constructor(address admin, address controller, address keeper, address _usdc, address _keeperPayout) {
        if (admin == address(0) || controller == address(0) || keeper == address(0)) revert ZeroAddress();
        if (_usdc == address(0) || _keeperPayout == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
        keeperPayoutWallet = _keeperPayout;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONTROLLER_ROLE, controller);
        _grantRole(KEEPER_ROLE, keeper);
    }

    // ════════════════════════════════════════════════════════════
    //  Controller surface — invoked by SweepController
    // ════════════════════════════════════════════════════════════

    /// @notice Sweep `amount` USDC out to the keeper for Arb→HyperEVM bridge.
    function deposit(uint256 amount) external nonReentrant onlyRole(CONTROLLER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, keeperPayoutWallet, amount);
        pendingOutbound += amount;
        emit RemoteDeposited(msg.sender, amount, pendingOutbound);
    }

    /// @notice Queue an unwind of `amount` USDC from Pool E. Keeper acts on
    ///         the emitted event (4-day HLP lockup + bridge time).
    function requestWithdraw(uint256 amount) external onlyRole(CONTROLLER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > mirrored) revert ExceedsMirrored(amount, mirrored);
        pendingInbound += amount;
        emit RemoteWithdrawRequested(msg.sender, amount, pendingInbound);
    }

    /// @notice Live USDC value attributed to this sink (mirrored + in-flight).
    function totalAssets() external view returns (uint256) {
        return mirrored + pendingOutbound + pendingInbound;
    }

    // ════════════════════════════════════════════════════════════
    //  Keeper surface — attestations
    // ════════════════════════════════════════════════════════════

    /// @notice Keeper acknowledges the bridged-out USDC has landed in Pool E v2.
    function confirmDeposit(uint256 amount) external onlyRole(KEEPER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingOutbound) revert ExceedsPending(amount, pendingOutbound);
        pendingOutbound -= amount;
        mirrored += amount;
        emit RemoteDepositConfirmed(msg.sender, amount, mirrored);
    }

    /// @notice Keeper returns USDC from HyperEVM back to the controller.
    ///         Caller must transfer USDC into this contract before calling
    ///         (or via SafeERC20 approval + transferFrom flow). The contract
    ///         then forwards to `deliverTo` (typically the SweepController).
    function confirmReturn(uint256 amount, address deliverTo)
        external nonReentrant onlyRole(KEEPER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingInbound) revert ExceedsPending(amount, pendingInbound);
        if (amount > mirrored) revert ExceedsMirrored(amount, mirrored);
        if (deliverTo == address(0)) revert ZeroAddress();

        pendingInbound -= amount;
        mirrored -= amount;

        // Pull USDC the keeper transferred in, forward to the controller.
        USDC.safeTransferFrom(msg.sender, deliverTo, amount);
        emit RemoteReturnConfirmed(msg.sender, amount, mirrored, uint256(uint160(deliverTo)));
    }

    // ════════════════════════════════════════════════════════════
    //  Admin
    // ════════════════════════════════════════════════════════════

    function setKeeperPayoutWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        keeperPayoutWallet = newWallet;
        emit KeeperPayoutWalletUpdated(newWallet);
    }

    function addKeeper(address k) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(KEEPER_ROLE, k);
    }

    function removeKeeper(address k) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(KEEPER_ROLE, k);
    }

    /// @notice Admin reset for state drift (after manual cross-chain reconcile).
    function syncAccounting(uint256 newMirrored, uint256 newPendingOutbound, uint256 newPendingInbound)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        mirrored = newMirrored;
        pendingOutbound = newPendingOutbound;
        pendingInbound = newPendingInbound;
    }

    // ══════════════════════════════════════════════════════════
    //  Rescue (admin) — this contract is a flow-through conduit;
    //  USDC never rests here. Any balance is a stray.
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
