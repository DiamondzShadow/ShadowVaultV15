#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  generate-abi-bundle.js — emit abi/v15.ts (single-file TS bundle)
//
//  Reads ./artifacts + ./config/deployed.json and writes a typed bundle
//  at ./abi/v15.ts that Lovable (or any frontend) can import with:
//    import { ADDRESSES, VAULT_ABI, NFT_ABI, ... } from "./abi/v15";
//
//  Re-run after any new deploy / wiring change:
//    node scripts/generate-abi-bundle.js
// ═══════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ART = path.join(ROOT, "artifacts", "contracts");
const OUT_DIR = path.join(ROOT, "abi");
const OUT = path.join(OUT_DIR, "v15.ts");
const DEPLOYED = path.join(ROOT, "config", "deployed.json");

function loadAbi(relativePath, contractName) {
  const p = path.join(ART, relativePath, contractName + ".json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j.abi;
}

function ts(label, value) {
  // Pretty-print top-level config (addresses/tokens/tier) for readability,
  // but minify ABIs since they're rarely hand-edited and compression matters
  // when the file is pasted around as a single bundle.
  const isAbi = label.endsWith("_ABI");
  const json = isAbi
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2);
  return `export const ${label} = ${json} as const;\n\n`;
}

// ─────────── Load ───────────
const deployed = JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));

const ABIS = {
  VAULT_ABI:              loadAbi("ShadowVaultV15.sol",            "ShadowVaultV15"),
  NFT_ABI:                loadAbi("ShadowPositionNFTV15.sol",      "ShadowPositionNFTV15"),
  // v15.3.1 canonical — forgiving deregister, vault-namespaced keys
  BONUS_ACCUMULATOR_ABI:  loadAbi("BonusAccumulatorV2_1.sol",      "BonusAccumulatorV2_1"),
  REVENUE_ROUTER_ABI:     loadAbi("RevenueRouter.sol",             "RevenueRouter"),
  SDM_DISCOUNT_ORACLE_ABI:loadAbi("SDMDiscountOracle.sol",         "SDMDiscountOracle"),
  AAVE_ADAPTER_ABI:       loadAbi("adapters/AaveAdapterV5.sol",    "AaveAdapterV5"),
  FLUID_ADAPTER_ABI:      loadAbi("adapters/FluidAdapter.sol",     "FluidAdapter"),
  SILO_ADAPTER_ABI:       loadAbi("adapters/SiloAdapter.sol",      "SiloAdapter"),
  PYTH_FEED_ABI:          loadAbi("adapters/PythFeed.sol",         "PythFeed"),
  YIELD_ADAPTER_ABI:      loadAbi("interfaces/IYieldAdapter.sol",  "IYieldAdapter"),
};

// ─────────── External protocol ABIs (hand-rolled minimal slices) ───────────
// These let the oracle page read live APR / liquidity index from Aave v3,
// Fluid ERC-4626 fToken, Silo v2, and any Chainlink price feed without
// pulling the whole protocol SDK into the frontend.

const CHAINLINK_FEED_ABI = [
  { "type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [], "outputs": [
    { "type": "uint80",  "name": "roundId" },
    { "type": "int256",  "name": "answer" },
    { "type": "uint256", "name": "startedAt" },
    { "type": "uint256", "name": "updatedAt" },
    { "type": "uint80",  "name": "answeredInRound" }
  ]},
  { "type": "function", "name": "decimals", "stateMutability": "view", "inputs": [], "outputs": [{"type":"uint8"}] },
];

// Aave v3 Pool — getReserveData returns the ReserveData struct whose field
// `currentLiquidityRate` is a 27-decimal per-second rate (ray). APR bps
// derivation: currentLiquidityRate / 1e27 * SECONDS_PER_YEAR * 10000.
const AAVE_POOL_ABI = [
  { "type": "function", "name": "getReserveData", "stateMutability": "view",
    "inputs": [{"type":"address","name":"asset"}],
    "outputs": [{
      "type":"tuple","name":"reserveData",
      "components": [
        {"type":"tuple","name":"configuration","components":[{"type":"uint256","name":"data"}]},
        {"type":"uint128","name":"liquidityIndex"},
        {"type":"uint128","name":"currentLiquidityRate"},
        {"type":"uint128","name":"variableBorrowIndex"},
        {"type":"uint128","name":"currentVariableBorrowRate"},
        {"type":"uint128","name":"currentStableBorrowRate"},
        {"type":"uint40","name":"lastUpdateTimestamp"},
        {"type":"uint16","name":"id"},
        {"type":"address","name":"aTokenAddress"},
        {"type":"address","name":"stableDebtTokenAddress"},
        {"type":"address","name":"variableDebtTokenAddress"},
        {"type":"address","name":"interestRateStrategyAddress"},
        {"type":"uint128","name":"accruedToTreasury"},
        {"type":"uint128","name":"unbacked"},
        {"type":"uint128","name":"isolationModeTotalDebt"}
      ]
    }]
  }
];

// ERC-4626 slice for Fluid fUSDC — totalAssets / convertToAssets / convertToShares
const ERC4626_ABI = [
  { "type": "function", "name": "totalAssets",       "stateMutability": "view", "inputs": [], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "totalSupply",       "stateMutability": "view", "inputs": [], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "convertToAssets",   "stateMutability": "view", "inputs": [{"type":"uint256","name":"shares"}], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "convertToShares",   "stateMutability": "view", "inputs": [{"type":"uint256","name":"assets"}], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "asset",             "stateMutability": "view", "inputs": [], "outputs": [{"type":"address"}] },
  { "type": "function", "name": "balanceOf",         "stateMutability": "view", "inputs": [{"type":"address"}], "outputs": [{"type":"uint256"}] },
];

// Arbitrum L2 sequencer uptime feed (Chainlink) — used as the global
// "halt all deposits when sequencer is down" gate on the Oracle page.
const ARBITRUM_SEQUENCER_UPTIME_FEED = "0xFdB631F5EE196F0ed6FAa767959853A9F217697D";

// Aave v3 Pool on Arbitrum
const AAVE_V3_POOL_ARBITRUM = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// Keeper schedule + thresholds (must stay in sync with keeper/keeper.js).
// Asymmetric thresholds: sell winners at 3% overweight, buy losers at 2%
// underweight. Creates a DCA-into-dips bias. Not an alpha source by itself
// (see feedback_real_yield_strategy.md) but a small volatility-capture
// improvement in range-bound markets.
const KEEPER = {
  cronSchedule: "0 */3 * * *",   // every 3 hours at :00 UTC
  intervalMs:   3 * 60 * 60 * 1000,
  driftSellBps:  300,            // 3% overweight → SELL trigger (take profits less often)
  driftBuyBps:   200,            // 2% underweight → BUY trigger (DCA dips more often)
  driftRebalanceBps: 300,        // legacy alias = max(sell, buy) for UI compat
  maxRebalanceSizeBps: 2000,     // max 20% of basket value per rebalance tx
  rebalanceSlippageBps: 50,      // 0.5% oracle-derived minOut tolerance
  protocolYieldFeeBps: 300,      // 3% fee on harvested yield
  basketBps: 7000,               // 70% deposit → basket
  yieldBps: 3000,                // 30% deposit → yield adapter
};

// Arbitrum token registry — canonical native deployments
const TOKENS = {
  USDC:   { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6,  symbol: "USDC"   },
  WETH:   { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, symbol: "WETH"   },
  WBTC:   { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8,  symbol: "WBTC"   },
  LINK:   { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, symbol: "LINK"   },
  ARB:    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, symbol: "ARB"    },
  GMX:    { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, symbol: "GMX"    },
  PENDLE: { address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18, symbol: "PENDLE" },
  PEPE:   { address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", decimals: 18, symbol: "PEPE"   },
  XAUT0:  { address: "0x40461291347e1eCbb09499F3371D3f17f10d7159", decimals: 6,  symbol: "XAUt0"  },
  SDM:    { address: "0x602b869eEf1C9F0487F31776bad8Af3C4A173394", decimals: 18, symbol: "SDM"    },
};

// Tier enum — matches ShadowVaultV15's on-chain enum ordering
const TIER = {
  FLEX:    { id: 0, label: "FLEX",  lockSeconds: 0,              multiplierBps: 10_000 },
  THIRTY:  { id: 1, label: "30D",   lockSeconds: 30 * 24 * 3600, multiplierBps: 12_000 },
  NINETY:  { id: 2, label: "90D",   lockSeconds: 90 * 24 * 3600, multiplierBps: 15_000 },
  ONEIGHTY:{ id: 3, label: "180D",  lockSeconds: 180 * 24 * 3600,multiplierBps: 20_000 },
  YEAR:    { id: 4, label: "365D",  lockSeconds: 365 * 24 * 3600,multiplierBps: 30_000 },
};

// Minimal ERC20 ABI (for basket tokens + USDC approval flow)
const ERC20_ABI = [
  { "type": "function", "name": "balanceOf", "stateMutability": "view", "inputs": [{"type":"address"}], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "decimals",  "stateMutability": "view", "inputs": [], "outputs": [{"type":"uint8"}] },
  { "type": "function", "name": "symbol",    "stateMutability": "view", "inputs": [], "outputs": [{"type":"string"}] },
  { "type": "function", "name": "approve",   "stateMutability": "nonpayable", "inputs": [{"type":"address"},{"type":"uint256"}], "outputs": [{"type":"bool"}] },
  { "type": "function", "name": "allowance", "stateMutability": "view", "inputs": [{"type":"address"},{"type":"address"}], "outputs": [{"type":"uint256"}] },
  { "type": "function", "name": "transfer",  "stateMutability": "nonpayable", "inputs": [{"type":"address"},{"type":"uint256"}], "outputs": [{"type":"bool"}] },
];

// Flatten deployed.json into a cleaner structure for the frontend.
const ADDRESSES = {
  chainId: deployed.chainId,
  network: deployed.network,
  admin:    deployed.admin,
  treasury: deployed.treasury,
  sdmToken: deployed.sdmToken,
  core: deployed.core,
  adapters: deployed.adapters,
  oracles: deployed.oracles,
  swapTargets: deployed.swapTargets,
  pools: {
    A: deployed.pools.A,
    B: deployed.pools.B,
    C: deployed.pools.C,
    D: deployed.pools.D,  // v15.4 Hard Assets
  },
  // Deprecated pools kept for audit / legacy withdraws — not displayed in UI for new deposits
  deprecated: {
    ...(deployed.pools.A_aave_deprecated      && { A_aave:  deployed.pools.A_aave_deprecated }),
    ...(deployed.pools.B_silo_deprecated      && { B_silo:  deployed.pools.B_silo_deprecated }),
    ...(deployed.pools.C_fluid_deprecated     && { C_fluid: deployed.pools.C_fluid_deprecated }),
    ...(deployed.pools.B_v1                   && { B_v1:    deployed.pools.B_v1 }),
    ...(deployed.pools.D_broken_pendle        && { D_broken_pendle: deployed.pools.D_broken_pendle }),
    ...(deployed.pools.B_pendle_v2_broken     && { B_pendle_v2_broken: deployed.pools.B_pendle_v2_broken }),
    ...(deployed.pools.B_pendle_v3_wrong_decimals && { B_pendle_v3_wrong_decimals: deployed.pools.B_pendle_v3_wrong_decimals }),
  },
};

// ─────────── Emit ───────────
let out = "";
out += "// ═══════════════════════════════════════════════════════════════════════\n";
out += "//  ShadowVaultV15 — frontend bundle (auto-generated, do not edit)\n";
out += "//\n";
out += "//  Generator:  scripts/generate-abi-bundle.js\n";
out += `//  Generated:  ${new Date().toISOString()}\n`;
out += `//  Network:    ${deployed.network} (chainId ${deployed.chainId})\n`;
out += "//\n";
out += "//  Import:     import { ADDRESSES, VAULT_ABI, TIER, TOKENS } from './v15';\n";
out += "//\n";
out += "//  Re-run after any new deploy/wiring change:\n";
out += "//    node scripts/generate-abi-bundle.js\n";
out += "// ═══════════════════════════════════════════════════════════════════════\n\n";

out += "export const CHAIN_ID = " + deployed.chainId + ";\n\n";

out += ts("ADDRESSES", ADDRESSES);
out += ts("TOKENS", TOKENS);
out += ts("TIER", TIER);
out += ts("KEEPER", KEEPER);
out += `export const ARBITRUM_SEQUENCER_UPTIME_FEED = "${ARBITRUM_SEQUENCER_UPTIME_FEED}";\n\n`;
out += `export const AAVE_V3_POOL_ARBITRUM = "${AAVE_V3_POOL_ARBITRUM}";\n\n`;
out += ts("ERC20_ABI", ERC20_ABI);
out += ts("CHAINLINK_FEED_ABI", CHAINLINK_FEED_ABI);
out += ts("AAVE_POOL_ABI", AAVE_POOL_ABI);
out += ts("ERC4626_ABI", ERC4626_ABI);

for (const [name, abi] of Object.entries(ABIS)) {
  out += ts(name, abi);
}

// Minimal helper types
out += `
// ─────────── TypeScript helper types ───────────
export type PoolId = "A" | "B" | "C";
export type TierKey = keyof typeof TIER;

export interface PoolConfig {
  label: string;
  vault: \`0x\${string}\`;
  positionNFT: \`0x\${string}\`;
  yieldSource: "aave" | "silo" | "fluid";
  adapter: \`0x\${string}\`;
  version?: string;
}

export interface PositionSnapshot {
  depositor: \`0x\${string}\`;
  tier: number;
  depositAmount: bigint;
  wsdmAmount: bigint;
  yieldShare: bigint;
  yieldClaimed: bigint;
  depositTime: bigint;
  unlockTime: bigint;
  multiplierBps: bigint;
  loanOutstanding: bigint;
  withdrawStatus: 0 | 1 | 2; // NONE | REQUESTED | COMPLETED
}
`;

// ─────────── Write ───────────
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`✓ Wrote ${OUT}`);
console.log(`  ${out.length} bytes, ${Object.keys(ABIS).length} ABIs, ${Object.keys(TOKENS).length} tokens, 3 pools`);
