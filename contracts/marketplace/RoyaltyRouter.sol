// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DiggerRegistry} from "./DiggerRegistry.sol";

/// @title RoyaltyRouter
/// @notice Receives USDC fees from EcosystemMarketplace (and later
///         LendingPool interest) and splits them per `DiggerRegistry.feeSplit`:
///           - digger cut → pull-claimable by digger owner
///           - supplier cut → pushed to `lendingPool` if set, else treasury
///           - protocol cut → pushed to treasury
///
///         Pull pattern for diggers keeps the marketplace tx cheap and lets
///         project teams batch claims. Supplier cut gets re-routed into the
///         LendingPool once the lending stack ships — same address space, no
///         marketplace redeploy needed.
contract RoyaltyRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    DiggerRegistry public immutable REGISTRY;

    address public treasury;
    /// @notice Optional sink for the supplier cut. address(0) → treasury.
    address public lendingPool;

    mapping(address => uint256) public pendingForDigger; // digger owner → claimable USDC

    event RevenueRouted(
        address indexed nft, uint256 amount,
        uint256 toDigger, uint256 toSupplier, uint256 toProtocol,
        address diggerOwner
    );
    event DiggerClaimed(address indexed owner, uint256 amount);
    event TreasuryUpdated(address newTreasury);
    event LendingPoolUpdated(address newPool);

    error ZeroAddress();
    error ZeroAmount();
    error NothingToClaim();

    constructor(address admin, address _usdc, address _registry, address _treasury) {
        if (admin == address(0) || _usdc == address(0) || _registry == address(0) || _treasury == address(0))
            revert ZeroAddress();
        USDC = IERC20(_usdc);
        REGISTRY = DiggerRegistry(payable(_registry));
        treasury = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Caller transfers `amount` USDC and the router splits it.
    ///         Caller must approve USDC to this router beforehand.
    /// @dev Marketplace calls this on every buy. Lending will call this on
    ///      interest payments / liquidation surplus.
    function routeRevenue(address nft, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        (uint16 dBps, uint16 sBps, /* pBps */) = REGISTRY.feeSplit(nft);

        uint256 toDigger = (amount * dBps) / 10_000;
        uint256 toSupplier = (amount * sBps) / 10_000;
        uint256 toProtocol = amount - toDigger - toSupplier;

        // Pull funds in.
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        // Digger cut: queue for owner to claim.
        address dOwner = REGISTRY.diggerOwnerOf(nft);
        if (toDigger > 0 && dOwner != address(0)) {
            pendingForDigger[dOwner] += toDigger;
        } else {
            // No registered digger → fold into protocol cut.
            toProtocol += toDigger;
            toDigger = 0;
        }

        // Supplier cut: push to lendingPool if wired, else treasury.
        if (toSupplier > 0) {
            address sink = lendingPool == address(0) ? treasury : lendingPool;
            USDC.safeTransfer(sink, toSupplier);
        }

        // Protocol cut: always to treasury.
        if (toProtocol > 0) USDC.safeTransfer(treasury, toProtocol);

        emit RevenueRouted(nft, amount, toDigger, toSupplier, toProtocol, dOwner);
    }

    /// @notice Digger owners claim their accumulated cut.
    function claimDigger() external nonReentrant {
        uint256 amt = pendingForDigger[msg.sender];
        if (amt == 0) revert NothingToClaim();
        pendingForDigger[msg.sender] = 0;
        USDC.safeTransfer(msg.sender, amt);
        emit DiggerClaimed(msg.sender, amt);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setLendingPool(address newPool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Allow address(0) to revert to treasury.
        lendingPool = newPool;
        emit LendingPoolUpdated(newPool);
    }
}
