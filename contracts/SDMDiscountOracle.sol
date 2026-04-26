// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title SDMDiscountOracle (V15)
/// @notice Checks if a user holds enough SDM to receive a protocol fee
///         discount. Rewritten to use OZ v5 AccessControl instead of
///         Ownable2Step per ecosystem rules.
contract SDMDiscountOracle is AccessControl {
    // ───────── State ─────────
    IERC20 public immutable sdm;
    uint256 public sdmThreshold;
    uint256 public discountBps;

    // ───────── Events ─────────
    event ThresholdUpdated(uint256 newThreshold);
    event DiscountBpsUpdated(uint256 newDiscountBps);

    // ───────── Errors ─────────
    error DiscountBpsTooHigh(uint256 requested, uint256 max);

    constructor(address admin, uint256 _threshold) {
        sdm = IERC20(0x602b869eEf1C9F0487F31776bad8Af3C4A173394);
        sdmThreshold = _threshold == 0 ? 10_000e18 : _threshold;
        discountBps = 5000;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Returns the effective fee in bps for `user`, applying the SDM discount if eligible.
    function getFeeBps(address user, uint256 baseFee) external view returns (uint256) {
        if (sdm.balanceOf(user) >= sdmThreshold) {
            return (baseFee * (10_000 - discountBps)) / 10_000;
        }
        return baseFee;
    }

    function hasDiscount(address user) external view returns (bool) {
        return sdm.balanceOf(user) >= sdmThreshold;
    }

    function setThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sdmThreshold = _threshold;
        emit ThresholdUpdated(_threshold);
    }

    function setDiscountBps(uint256 _discountBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_discountBps > 7500) revert DiscountBpsTooHigh(_discountBps, 7500);
        discountBps = _discountBps;
        emit DiscountBpsUpdated(_discountBps);
    }
}
