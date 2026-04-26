// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal mock exposing `totalAssets` / `totalPrincipal` so we can
///         unit-test YieldReceipt.liveAccruedYield without a real adapter.
contract MockYieldAdapter {
    uint256 public totalAssets;
    uint256 public totalPrincipal;

    function setBalances(uint256 _totalAssets, uint256 _totalPrincipal) external {
        totalAssets = _totalAssets;
        totalPrincipal = _totalPrincipal;
    }
}
