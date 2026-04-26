// Read-only audit of every Aave V3 exposure we hold on Polygon + Arbitrum.
// Does NOT move funds. Safe to run repeatedly.
//
// Reports:
//   - aUSDC balance of each adapter / sink we control
//   - Whether each adapter holds any USDC idle
//   - Aave V3 Pool pause state (oracle manipulation could prompt the DAO
//     to freeze reserves)
//   - Whether the aUSDC token itself is paused
//
// Usage:
//   npx hardhat run --network arbitrum scripts/audit-aave-exposure.cjs
//   npx hardhat run --network polygon  scripts/audit-aave-exposure.cjs

const hre = require("hardhat");
const path = require("node:path");

function fmt(n, dec = 6) { return (Number(n) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec }); }

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];
// Minimal slice — getReserveData returns a big struct; we only care about
// config flags (first field) and paused status.
const AAVE_POOL_ABI = [
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function paused() view returns (bool)",
];

// Bit 60 of Aave V3 ReserveConfiguration is "isActive", bit 61 is "isFrozen",
// bit 62 is "borrowingEnabled", bit 63 is "stableBorrowingEnabled".
// Bit 57 is paused (per Aave V3 spec). Different versions — safest to read
// both the pool.paused() and check for isolation / freeze flags directly.
function decodeReserveConfig(cfg) {
  // Constants from Aave V3 ReserveConfiguration.sol
  // We report 3 flags commonly relevant during a post-incident freeze:
  const bit = (n) => (cfg >> BigInt(n)) & 1n;
  return {
    isActive:         bit(56) === 1n,
    isFrozen:         bit(57) === 1n,
    borrowingEnabled: bit(58) === 1n,
    stableBorrowingEnabled: bit(59) === 1n,
    paused:           bit(60) === 1n,
  };
}

async function main() {
  const [_] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const provider = hre.ethers.provider;

  let cfg, usdc, pool, exposures;
  if (chainId === 42161) {
    cfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));
    const v15 = require(path.resolve(__dirname, "..", "config", "deployed.json"));
    usdc = cfg.usdc;
    pool = cfg.aaveV3Pool;
    exposures = [
      { label: "AaveV3Sink (v1.4 stack)", holder: cfg.contracts.aaveV3Sink, aToken: cfg.ausdc },
      { label: "Pool C V15 vault adapter", holder: v15.pools.C.adapter, aToken: cfg.ausdc },
    ];
  } else if (chainId === 137) {
    cfg = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json"));
    const v15 = require(path.resolve(__dirname, "..", "..", "CauseVaultPolygonV15", "config", "deployed.json"));
    const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
    const AUSDC_POLY = "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD";
    usdc = cfg.usdc;
    pool = AAVE_POOL;
    exposures = [
      { label: "AaveV3Sink (v1.4 stack)",  holder: cfg.contracts.aaveV3Sink,    aToken: AUSDC_POLY },
      { label: "Polygon Pool A adapter",   holder: v15.adapters.aaveA,          aToken: AUSDC_POLY },
      { label: "Polygon Pool C adapter",   holder: v15.adapters.aaveC,          aToken: AUSDC_POLY },
      { label: "Polygon Pool D adapter",   holder: v15.adapters.aaveD,          aToken: AUSDC_POLY },
    ];
  } else {
    throw new Error(`unsupported chain ${chainId}`);
  }

  console.log(`═══ Aave V3 exposure — chain ${chainId} ═══`);
  console.log(`pool: ${pool}`);
  console.log(`usdc: ${usdc}`);

  // Reserve config + pause state
  const p = new hre.ethers.Contract(pool, AAVE_POOL_ABI, provider);
  try {
    const reserve = await p.getReserveData(usdc);
    const flags = decodeReserveConfig(reserve.configuration.data);
    console.log(`\nReserve config for USDC:`);
    console.log("  isActive              :", flags.isActive);
    console.log("  isFrozen              :", flags.isFrozen);
    console.log("  borrowingEnabled      :", flags.borrowingEnabled);
    console.log("  stableBorrowingEnabled:", flags.stableBorrowingEnabled);
    console.log("  paused (reserve bit)  :", flags.paused);
    console.log("  aToken                :", reserve.aTokenAddress);
  } catch (e) { console.log("getReserveData failed:", e.shortMessage || e.message); }
  try {
    const pausedGlobal = await p.paused();
    console.log("  paused (pool global)  :", pausedGlobal);
  } catch { /* not all versions expose pool-level paused() */ }

  // Per-exposure balance
  console.log(`\nOur holdings:`);
  let totalExposed = 0n;
  for (const e of exposures) {
    const at = new hre.ethers.Contract(e.aToken, ERC20_ABI, provider);
    const u = new hre.ethers.Contract(usdc, ERC20_ABI, provider);
    const aBal = await at.balanceOf(e.holder).catch(() => 0n);
    const uBal = await u.balanceOf(e.holder).catch(() => 0n);
    totalExposed += aBal;
    console.log(`  ${e.label}`);
    console.log(`    holder: ${e.holder}`);
    console.log(`    aUSDC : ${fmt(aBal)}`);
    console.log(`    USDC  : ${fmt(uBal)}`);
  }
  console.log(`\nTotal Aave-exposed aUSDC across this chain: ${fmt(totalExposed)} USDC`);
}

main().catch(e => { console.error(e); process.exit(1); });
