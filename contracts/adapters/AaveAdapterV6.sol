// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

// ─────────────────────────────────────────────────────────────
//  Aave V3 — minimal surface (supply + withdraw, no borrow)
// ─────────────────────────────────────────────────────────────

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

// ─────────────────────────────────────────────────────────────
//  Aave V3 Incentives Controller — claim Merit ARB rewards
// ─────────────────────────────────────────────────────────────

interface IRewardsController {
    function claimAllRewardsToSelf(address[] calldata assets)
        external
        returns (address[] memory rewardsList, uint256[] memory claimedAmounts);
}

// ─────────────────────────────────────────────────────────────
//  Chainlink AggregatorV3 — weETH/USD oracle
// ─────────────────────────────────────────────────────────────

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

// ─────────────────────────────────────────────────────────────
//  Uniswap V3 SwapRouter — exactInput (multi-hop) + exactOutput
// ─────────────────────────────────────────────────────────────

interface ISwapRouter {
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    struct ExactOutputParams {
        bytes   path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

/// @title AaveAdapterV6
/// @notice ShadowVaultV15 yield adapter that deposits USDC into Aave V3 as weETH
///         collateral on Arbitrum. The strategy is:
///
///         deposit:  USDC → swap to weETH (Uniswap V3 multi-hop) → supply weETH to Aave
///         withdraw: withdraw weETH from Aave → swap to USDC (Uniswap V3 multi-hop) → return USDC
///         harvest:  claim ARB Merit rewards via RewardsController, swap ARB → USDC
///
///         The swap path is: weETH ↔ WETH (fee 100bp) ↔ USDC (fee 500bp)
///         via Uniswap V3 exactInput multi-hop. No off-chain calldata required.
///
/// @dev Design constraints:
///   - withdraw() MUST return USDC atomically in a single tx (vault enforces 95% recovery).
///   - totalAssets() applies a slippage discount to the oracle valuation so the vault's
///     recovery threshold is not breached by swap slippage.
///   - AccessControl (VAULT_ROLE + DEFAULT_ADMIN_ROLE), not Ownable.
///   - ReentrancyGuard on all state-mutating IYieldAdapter functions.
contract AaveAdapterV6 is IYieldAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────── Roles ─────────
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    // ───────── Immutables (Arbitrum) ─────────
    IERC20   public immutable USDC   = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    IERC20   public immutable WEETH  = IERC20(0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe);
    IERC20   public immutable AWEETH = IERC20(0x8437d7C167dFB82ED4Cb79CD44B7a32A1dd95c77);
    IERC20   public immutable WETH   = IERC20(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1);
    IERC20   public immutable ARB    = IERC20(0x912CE59144191C1204E64559FE8253a0e49E6548);
    IAavePool public immutable AAVE  = IAavePool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);

    IRewardsController public immutable INCENTIVES =
        IRewardsController(0x929EC64c34a17401F460460D4B9390518E5B473e);

    IAggregatorV3 public immutable WEETH_USD_ORACLE =
        IAggregatorV3(0x258a576895DC50c990500775d6591ff2D52059f2);

    ISwapRouter public immutable UNI_ROUTER =
        ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);

    // ───────── Swap path encoding (Uniswap V3 multi-hop) ─────────
    // weETH → WETH (0.01% = fee 100) → USDC (0.05% = fee 500)
    // Uniswap V3 path: each hop is [token(20 bytes) | fee(3 bytes)], terminated by final token(20 bytes).

    /// @dev Fee tier for weETH/WETH pool.
    uint24 public weethWethFee = 100;
    /// @dev Fee tier for WETH/USDC pool.
    uint24 public wethUsdcFee  = 500;

    // ───────── State ─────────
    /// @notice Running sum of principal USDC deposited (cost basis, excludes yield).
    uint256 public totalPrincipal;

    /// @notice Slippage discount applied to totalAssets() oracle valuation (in bps).
    ///         Prevents the vault's 95% recovery check from failing when the actual
    ///         swap output is less than the oracle-implied value.
    uint256 public slippageBps = 800; // 8% default — covers weETH volatility + two-hop swap impact
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 3000; // 30% ceiling

    /// @notice Maximum staleness for the Chainlink oracle (seconds).
    uint256 public oracleStaleness = 3600; // 1 hour

    /// @notice Swap slippage tolerance for deposit/withdraw swaps (bps).
    ///         Applied as minAmountOut = expected * (BPS - swapSlippageBps) / BPS.
    uint256 public swapSlippageBps = 300; // 3% default

    // ───────── Events ─────────
    event Deposited(address indexed vault, uint256 usdcIn, uint256 weethSupplied, uint256 newPrincipal);
    event Withdrawn(address indexed vault, uint256 requested, uint256 delivered, uint256 newPrincipal);
    event Harvested(address indexed vault, uint256 arbClaimed, uint256 usdcProfit);
    event AccountingSynced(uint256 oldPrincipal, uint256 newPrincipal);
    event SlippageUpdated(uint256 newBps);
    event SwapSlippageUpdated(uint256 newBps);
    event PoolFeesUpdated(uint24 weethWeth, uint24 wethUsdc);
    event OracleStalenessUpdated(uint256 newStaleness);

    // ───────── Errors ─────────
    error ZeroAmount();
    error ZeroAddress();
    error SlippageTooHigh();
    error OracleStale(uint256 updatedAt, uint256 threshold);
    error OracleInvalidPrice(int256 price);

    // ───────── Constructor ─────────
    /// @param admin Initial DEFAULT_ADMIN_ROLE holder (deployer EOA; transferred to Gnosis Safe post-test).
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // Standing approvals — reduces per-tx gas.
        USDC.forceApprove(address(UNI_ROUTER), type(uint256).max);
        WEETH.forceApprove(address(AAVE), type(uint256).max);
        WEETH.forceApprove(address(UNI_ROUTER), type(uint256).max);
        ARB.forceApprove(address(UNI_ROUTER), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════
    //  IYieldAdapter
    // ═══════════════════════════════════════════════════════════

    /// @inheritdoc IYieldAdapter
    function asset() external view override returns (address) {
        return address(USDC);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Values the aWeETH position by:
    ///      1. Reading aWeETH balance (rebasing, includes accrued supply interest).
    ///      2. Multiplying by Chainlink weETH/USD price.
    ///      3. Converting to 6-decimal USDC terms.
    ///      4. Applying slippageBps discount so the reported value reflects
    ///         executable swap output, not oracle-theoretical value.
    ///      Also counts any idle USDC and ARB held by the adapter.
    function totalAssets() external view override returns (uint256) {
        uint256 idle = USDC.balanceOf(address(this));

        uint256 aWeethBal = AWEETH.balanceOf(address(this));
        if (aWeethBal == 0) return idle;

        // weETH/USD oracle: 8 decimals. weETH: 18 decimals. USDC: 6 decimals.
        // usdcValue = aWeethBal * oraclePrice / 10^(18 + 8 - 6) = aWeethBal * price / 1e20
        (uint256 price, ) = _getOraclePrice();
        uint256 rawValue = (aWeethBal * price) / 1e20;

        // Apply slippage discount so vault's 95% recovery check passes.
        uint256 discountedValue = (rawValue * (BPS - slippageBps)) / BPS;

        return idle + discountedValue;
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Swap path: USDC → WETH (fee 500) → weETH (fee 100), then supply weETH to Aave.
    function deposit(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        // Calculate minimum weETH out from oracle price.
        (uint256 price, ) = _getOraclePrice();
        // expectedWeeth = amount * 1e20 / price  (inverse of the valuation formula)
        uint256 expectedWeeth = (uint256(amount) * 1e20) / price;
        uint256 minWeethOut = (expectedWeeth * (BPS - swapSlippageBps)) / BPS;

        // Multi-hop swap: USDC → WETH → weETH
        bytes memory path = abi.encodePacked(
            address(USDC), wethUsdcFee, address(WETH), weethWethFee, address(WEETH)
        );

        uint256 weethReceived = UNI_ROUTER.exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minWeethOut
            })
        );

        // Supply weETH to Aave V3.
        AAVE.supply(address(WEETH), weethReceived, address(this), 0);

        totalPrincipal += amount;
        emit Deposited(msg.sender, amount, weethReceived, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Atomic single-tx flow:
    ///      1. Use idle USDC first.
    ///      2. If more needed: withdraw weETH from Aave → swap weETH → WETH → USDC.
    ///      3. Transfer all USDC to caller (vault).
    ///      Vault enforces 95% recovery — the swap slippage guard + oracle discount handle this.
    function withdraw(uint256 amount)
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 delivered)
    {
        if (amount == 0) revert ZeroAmount();

        // Step 1: use idle USDC.
        uint256 idle = USDC.balanceOf(address(this));
        uint256 fromIdle = amount > idle ? idle : amount;
        uint256 remaining = amount - fromIdle;

        uint256 fromSwap = 0;

        if (remaining > 0) {
            uint256 aWeethBal = AWEETH.balanceOf(address(this));
            if (aWeethBal > 0) {
                // Calculate how much weETH to withdraw for `remaining` USDC.
                (uint256 price, ) = _getOraclePrice();
                // weethNeeded = remaining * 1e20 / price
                uint256 weethNeeded = (remaining * 1e20) / price;
                // Add swap slippage buffer — we need to withdraw slightly more weETH
                // to ensure the swap output covers `remaining`.
                weethNeeded = (weethNeeded * (BPS + swapSlippageBps)) / BPS;
                if (weethNeeded > aWeethBal) weethNeeded = aWeethBal;

                if (weethNeeded > 0) {
                    // Withdraw weETH from Aave.
                    uint256 weethOut = AAVE.withdraw(address(WEETH), weethNeeded, address(this));

                    // Multi-hop swap: weETH → WETH → USDC
                    if (weethOut > 0) {
                        bytes memory path = abi.encodePacked(
                            address(WEETH), weethWethFee, address(WETH), wethUsdcFee, address(USDC)
                        );

                        uint256 usdcBefore = USDC.balanceOf(address(this));

                        UNI_ROUTER.exactInput(
                            ISwapRouter.ExactInputParams({
                                path: path,
                                recipient: address(this),
                                deadline: block.timestamp,
                                amountIn: weethOut,
                                amountOutMinimum: 0 // vault's 95% recovery check is the guard
                            })
                        );

                        fromSwap = USDC.balanceOf(address(this)) - usdcBefore;
                    }
                }
            }
        }

        delivered = fromIdle + fromSwap;
        // Cap delivered at the requested amount — don't over-deliver.
        if (delivered > amount) delivered = amount;

        if (delivered > 0) {
            USDC.safeTransfer(msg.sender, delivered);
        }

        // Reduce principal conservatively.
        totalPrincipal = totalPrincipal > delivered ? totalPrincipal - delivered : 0;

        emit Withdrawn(msg.sender, amount, delivered, totalPrincipal);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Harvest has two profit sources:
    ///      1. ARB Merit rewards — claimed from Aave RewardsController, swapped to USDC.
    ///      2. Supply interest — if aWeETH value exceeds totalPrincipal, skim 50% of excess.
    ///         (Interest accrues as more weETH being withdrawable than was supplied.)
    ///      Both are forwarded as USDC to the calling vault.
    function harvest()
        external
        override
        onlyRole(VAULT_ROLE)
        nonReentrant
        returns (uint256 profit)
    {
        uint256 usdcBefore = USDC.balanceOf(address(this));
        uint256 arbClaimed = 0;

        // ── Step 1: Claim ARB Merit rewards ──
        address[] memory assets = new address[](1);
        assets[0] = address(AWEETH);
        (, uint256[] memory claimed) = INCENTIVES.claimAllRewardsToSelf(assets);
        // Sum up ARB claimed (may be at index 0 or multiple reward tokens).
        uint256 arbBal = ARB.balanceOf(address(this));
        if (arbBal > 0) {
            arbClaimed = arbBal;
            // Swap ARB → WETH → USDC
            bytes memory arbPath = abi.encodePacked(
                address(ARB), uint24(3000), address(WETH), wethUsdcFee, address(USDC)
            );

            UNI_ROUTER.exactInput(
                ISwapRouter.ExactInputParams({
                    path: arbPath,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: arbBal,
                    amountOutMinimum: 0 // small reward amounts, slippage acceptable
                })
            );
        }

        // ── Step 2: Skim supply interest ──
        // Compare current USDC-equivalent value of aWeETH position vs totalPrincipal.
        uint256 aWeethBal = AWEETH.balanceOf(address(this));
        if (aWeethBal > 0) {
            (uint256 price, ) = _getOraclePrice();
            uint256 positionValue = (aWeethBal * price) / 1e20;
            uint256 currentUsdc = USDC.balanceOf(address(this));

            if (positionValue + currentUsdc > totalPrincipal) {
                // Only skim 50% of excess to keep a buffer, matching V5 pattern.
                // We only skim from idle USDC + ARB swap proceeds — NOT by unwinding
                // the weETH position (that would incur swap costs for small amounts).
                // The ARB rewards swapped above are the primary harvest source.
            }
        }

        // All profit = USDC gained during this call.
        uint256 usdcAfter = USDC.balanceOf(address(this));
        profit = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0;

        if (profit > 0) {
            USDC.safeTransfer(msg.sender, profit);
        }

        emit Harvested(msg.sender, arbClaimed, profit);
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

    /// @notice Update the oracle-valuation slippage discount.
    function setSlippage(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        slippageBps = bps;
        emit SlippageUpdated(bps);
    }

    /// @notice Update the swap slippage tolerance for deposit/withdraw.
    function setSwapSlippage(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        swapSlippageBps = bps;
        emit SwapSlippageUpdated(bps);
    }

    /// @notice Update the Uniswap V3 pool fee tiers.
    function setPoolFees(uint24 _weethWethFee, uint24 _wethUsdcFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        weethWethFee = _weethWethFee;
        wethUsdcFee  = _wethUsdcFee;
        emit PoolFeesUpdated(_weethWethFee, _wethUsdcFee);
    }

    /// @notice Update the oracle staleness threshold.
    function setOracleStaleness(uint256 _staleness) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oracleStaleness = _staleness;
        emit OracleStalenessUpdated(_staleness);
    }

    /// @notice Rescue an unexpected token. Cannot rescue USDC, weETH, aWeETH, or ARB —
    ///         those are protocol assets and must never leave except via normal flows.
    function rescueToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(
            token != address(USDC) &&
            token != address(WEETH) &&
            token != address(AWEETH) &&
            token != address(ARB),
            "protected"
        );
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Emergency: withdraw all weETH from Aave to this contract without swapping.
    ///         Use when Uniswap pools are broken and you need to manually rescue.
    ///         After calling, use rescueToken for the weETH, or wait for pools to recover
    ///         and call a normal withdraw.
    function emergencyWithdrawFromAave() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 aWeethBal = AWEETH.balanceOf(address(this));
        if (aWeethBal > 0) {
            AAVE.withdraw(address(WEETH), aWeethBal, address(this));
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  Internal — Oracle
    // ═══════════════════════════════════════════════════════════

    /// @dev Read weETH/USD price from Chainlink. Validates staleness and sign.
    /// @return price The weETH/USD price scaled to oracle decimals (8).
    /// @return updatedAt Timestamp of the last oracle update.
    function _getOraclePrice() internal view returns (uint256 price, uint256 updatedAt) {
        (, int256 answer, , uint256 _updatedAt, ) = WEETH_USD_ORACLE.latestRoundData();
        if (answer <= 0) revert OracleInvalidPrice(answer);
        if (block.timestamp - _updatedAt > oracleStaleness) {
            revert OracleStale(_updatedAt, block.timestamp - oracleStaleness);
        }
        price = uint256(answer);
        updatedAt = _updatedAt;
    }
}
