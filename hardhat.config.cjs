require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" }
  },
  networks: {
    hardhat: {
      chains: {
        42161: { hardforkHistory: { cancun: 0 } },
      },
      ...(process.env.FORK_BLOCK ? {
        forking: {
          url: process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc",
          blockNumber: parseInt(process.env.FORK_BLOCK),
        },
        chainId: 42161,
        hardfork: "cancun",
      } : {}),
    },
    arbitrum: {
      url: process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      chainId: 42161,
    },
    polygon: {
      url: process.env.POLYGON_RPC || "https://polygon-rpc.com",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      chainId: 137,
    },
    hyperevm: {
      url: process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      chainId: 999,
    },
    "hyperevm-testnet": {
      url: process.env.HYPEREVM_TESTNET_RPC || "https://rpc.hyperliquid-testnet.xyz/evm",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      chainId: 998,
    }
  },
  // Etherscan V2 multichain — single key works for Arbiscan, Basescan,
  // Optimism, Polygon, etc. Get one from etherscan.io/myapikey.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: false,
  },
};
