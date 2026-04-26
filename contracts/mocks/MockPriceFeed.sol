// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockPriceFeed
/// @notice Test-only Chainlink AggregatorV3 stand-in. Returns a configurable
///         price with `updatedAt = block.timestamp` so fork tests that
///         advance time via evm_increaseTime don't trigger the vault's
///         1-hour staleness guard. The admin can push new prices to
///         simulate market movement.
contract MockPriceFeed {
    int256 public price;
    uint8 public immutable override_decimals;

    constructor(int256 initialPrice, uint8 feedDecimals) {
        price = initialPrice;
        override_decimals = feedDecimals;
    }

    function setPrice(int256 newPrice) external {
        price = newPrice;
    }

    function decimals() external view returns (uint8) {
        return override_decimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, price, block.timestamp, block.timestamp, 1);
    }
}
