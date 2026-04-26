// Batch setFees across V15 vaults.
//
// Usage:
//   DRY (default, reads current + shows target, no tx):
//     npx hardhat run scripts/set-fees.cjs --network arbitrum
//     npx hardhat run scripts/set-fees.cjs --network hyperliquid
//
//   EXECUTE:
//     EXECUTE=1 npx hardhat run scripts/set-fees.cjs --network arbitrum
//     EXECUTE=1 npx hardhat run scripts/set-fees.cjs --network hyperliquid
//
// Target fees: early=12% (1200 bps), onTime=3% (300 bps), yield=3% (300 bps).
// Override with env: EARLY_BPS, ONTIME_BPS, YIELD_BPS.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TARGET_EARLY  = Number(process.env.EARLY_BPS  ?? 1200);
const TARGET_ONTIME = Number(process.env.ONTIME_BPS ?? 300);
const TARGET_YIELD  = Number(process.env.YIELD_BPS  ?? 300);
const EXECUTE       = process.env.EXECUTE === "1";

const ABI = [
  "function earlyExitFeeBps() view returns (uint256)",
  "function onTimeFeeBps() view returns (uint256)",
  "function protocolYieldFeeBps() view returns (uint256)",
  "function setFees(uint256,uint256,uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

function vaultsForNetwork(network) {
  if (network === "arbitrum") {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json")));
    return ["A","B","C","D"].map(k => ({ pool: k, addr: cfg.pools[k].vault }));
  }
  if (network === "hyperevm" || network === "hyperliquid") {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed-pool-e-hc.json")));
    // Pool E uses ShadowVaultV15. Pool F (HyperBasket) has no fee fields — skipped.
    const vault = cfg.vault || cfg.pools?.E?.vault || cfg.shadowVaultV15;
    if (!vault) throw new Error("Pool E vault not found in deployed-pool-e-hc.json");
    return [{ pool: "E", addr: vault }];
  }
  throw new Error(`unsupported network: ${network}`);
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  console.log(`\n=== setFees on ${net} ===`);
  console.log(`signer: ${signer.address}`);
  console.log(`target: early=${TARGET_EARLY} onTime=${TARGET_ONTIME} yield=${TARGET_YIELD}`);
  console.log(`mode:   ${EXECUTE ? "EXECUTE" : "DRY-RUN"}\n`);

  const vaults = vaultsForNetwork(net);
  const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000"; // DEFAULT_ADMIN_ROLE

  for (const { pool, addr } of vaults) {
    const v = new hre.ethers.Contract(addr, ABI, signer);
    const [early, onTime, yld, isAdmin] = await Promise.all([
      v.earlyExitFeeBps(),
      v.onTimeFeeBps(),
      v.protocolYieldFeeBps(),
      v.hasRole(ADMIN, signer.address),
    ]);
    console.log(`Pool ${pool} (${addr})`);
    console.log(`  current: early=${early} onTime=${onTime} yield=${yld}`);
    console.log(`  target:  early=${TARGET_EARLY} onTime=${TARGET_ONTIME} yield=${TARGET_YIELD}`);
    console.log(`  admin?   ${isAdmin}`);

    if (!EXECUTE) { console.log(`  [dry-run, skipping tx]\n`); continue; }
    if (!isAdmin) { console.log(`  [NOT ADMIN — skipping]\n`); continue; }
    if (
      Number(early) === TARGET_EARLY &&
      Number(onTime) === TARGET_ONTIME &&
      Number(yld) === TARGET_YIELD
    ) { console.log(`  [already at target — skipping]\n`); continue; }

    const tx = await v.setFees(TARGET_EARLY, TARGET_ONTIME, TARGET_YIELD);
    console.log(`  sent: ${tx.hash}`);
    const rc = await tx.wait();
    console.log(`  mined in block ${rc.blockNumber}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
