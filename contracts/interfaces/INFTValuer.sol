// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title INFTValuer
/// @notice Per-tokenId valuation and liquidation-strategy oracle for NFT
///         collateral in the Diamondz lending + marketplace stack. Decouples
///         LendingPool from any single valuation source (live vault position,
///         collection floor oracle, static admin-set price).
interface INFTValuer {
    enum Mode {
        NONE,            // unconfigured → valueOf returns 0
        VAULT_POSITION,  // live per-tokenId value from an IVaultValue source, VAULT_UNWIND liq
        FLOOR_ORACLE,    // collection floor from an IFloorOracle source, MARKETPLACE_AUCTION liq
        STATIC_USDC,     // fixed admin value, MARKETPLACE_AUCTION liq
        VAULT_MIRROR     // per-tokenId value from IVaultValue source (like VAULT_POSITION),
                         //   but MARKETPLACE_AUCTION liq — for CCIP-bridged / wrapped NFTs
                         //   that expose a value-per-tokenId getter without being unwindable.
    }

    enum Strategy {
        VAULT_UNWIND,       // LendingPool calls vault.requestWithdraw/completeWithdraw
        MARKETPLACE_AUCTION // LendingPool hands NFT to EcosystemMarketplace.liquidationList
    }

    /// @notice Live USDC value (6-dec) of a given tokenId. Returns 0 for
    ///         unconfigured collections — LendingPool treats that as "refuse
    ///         to lend". Named `liveValue` (not `valueOf`) to avoid colliding
    ///         with JS Object.prototype.valueOf during ethers calls.
    function liveValue(address nft, uint256 tokenId) external view returns (uint256 usdc);

    /// @notice Liquidation strategy LendingPool should use for this collection.
    ///         Reverts for unconfigured collections (callers must gate on
    ///         `modeOf(nft) != NONE` first).
    function strategy(address nft) external view returns (Strategy);

    /// @notice Configured mode for a collection.
    function modeOf(address nft) external view returns (Mode);

    /// @notice For VAULT_POSITION mode: the vault address that issues the NFT.
    ///         Used by LendingPool liquidation to call requestWithdraw /
    ///         completeWithdraw. Reverts if mode != VAULT_POSITION.
    function vaultFor(address nft) external view returns (address);
}

/// @notice Vault-side interface the valuer calls for VAULT_POSITION mode.
///         Matches ShadowVaultV15.estimatePositionValue.
interface IVaultValue {
    function estimatePositionValue(uint256 posId)
        external
        view
        returns (uint256 basketVal, uint256 yieldVal, uint256 total);
}

/// @notice Collection-floor oracle interface for FLOOR_ORACLE mode. Returns a
///         USDC-denominated (6-dec) floor price per collection. Implementations
///         can wrap Chainlink NFT floor feeds, Reservoir API bridges, or a
///         keeper-pushed value with staleness guards.
interface IFloorOracle {
    function floorUSDC(address nft) external view returns (uint256);
}
