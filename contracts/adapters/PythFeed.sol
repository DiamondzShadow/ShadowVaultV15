// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Pyth Network Solidity interface — minimum surface we need.
///      Source: github.com/pyth-network/pyth-sdk-solidity
library PythStructs {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
}

interface IPyth {
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory);
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory);
}

/// @title PythFeed
/// @notice Thin wrapper that exposes a Pyth Network price feed as a
///         Chainlink AggregatorV3-compatible view so ShadowVaultV15 can
///         consume Pyth-only tokens (PEPE, etc.) without any vault code
///         change.
///
/// @dev Key design choices:
///
///   - **Read-only wrapper.** This contract does NOT push Pyth updates.
///     Pushing is done externally — the keeper calls `updatePriceFeeds`
///     directly on the Pyth contract each cycle, paying the ETH fee.
///     The wrapper just reads whatever Pyth stores as the "last known"
///     price via `getPriceUnsafe` (which never reverts).
///
///   - **Normalised to 8 decimals** to match Chainlink's USD-feed
///     convention. Pyth's `expo` tells us the native scale; we shift
///     to `1e8 = $1` so the vault's existing feed-decimals parameter
///     (passed as 8 in addBasketToken) works unchanged.
///
///   - **`updatedAt = publishTime`** from Pyth. If nobody has pushed
///     recently, publishTime is stale and the vault's own staleness
///     guard will revert. This is intentional — we don't want to
///     silently serve stale prices to a vault computing basket value.
///
///   - For metals feeds (e.g. XAU/USD), Pythnet only publishes during
///     NY market hours, so even fresh pushes won't advance publishTime
///     on weekends. Those tokens need a per-token staleness override
///     on the vault side (v15.1) before they can be used safely.
contract PythFeed {
    IPyth public immutable pyth;
    bytes32 public immutable priceId;

    error PriceUnavailable();
    error ExpoOutOfRange();

    constructor(address _pyth, bytes32 _priceId) {
        pyth = IPyth(_pyth);
        priceId = _priceId;
    }

    /// @notice Chainlink-compatible — normalised to 1e8 USD regardless
    ///         of Pyth's native exponent.
    function decimals() external pure returns (uint8) {
        return 8;
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
        PythStructs.Price memory p = pyth.getPriceUnsafe(priceId);
        if (p.price <= 0 || p.publishTime == 0) revert PriceUnavailable();

        // realPrice = p.price * 10^p.expo
        // We want:   answer  = realPrice * 10^8
        //          =>       = p.price * 10^(p.expo + 8)
        int256 base = int256(p.price);
        int256 shift = int256(p.expo) + 8;

        if (shift >= 0) {
            if (shift > 18) revert ExpoOutOfRange();
            answer = base * int256(10 ** uint256(shift));
        } else {
            int256 negShift = -shift;
            if (negShift > 18) revert ExpoOutOfRange();
            answer = base / int256(10 ** uint256(negShift));
        }

        startedAt = p.publishTime;
        updatedAt = p.publishTime;
        roundId = 1;
        answeredInRound = 1;
    }
}
