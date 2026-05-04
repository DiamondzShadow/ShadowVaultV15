// Deploy EcosystemMarketplaceV3 on Arbitrum, reusing the live v2
// DiggerRegistry + RoyaltyRouter. v2 marketplace stays deployed (still
// referenced by Phase 3 lending until v3.1) — v3 lives alongside it.
//
// Writes the new address into config/deployed-marketplace-v3-arb.json.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const ARB_USDC          = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TREASURY_SAFE     = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";

// v2 stack — already deployed (rescue sweep 2026-04-21).
const DIGGER_REGISTRY_V2 = "0x090275f1ddae9e37C28D495AD9f9044723D787c9";
const ROYALTY_ROUTER_V2  = "0xb9c6edfcd6fBd861ba8b92c3eDddbf5babED1be4";

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected Arbitrum (42161), got ${net.chainId}`);

  const balEth = await hre.ethers.provider.getBalance(deployer.address);
  section(`MarketplaceV3 deploy on Arbitrum (${net.chainId})`);
  console.log("Deployer        :", deployer.address);
  console.log("Treasury Safe   :", TREASURY_SAFE);
  console.log("USDC            :", ARB_USDC);
  console.log("DiggerRegistry  :", DIGGER_REGISTRY_V2);
  console.log("RoyaltyRouter   :", ROYALTY_ROUTER_V2);
  console.log("ETH bal         :", hre.ethers.formatEther(balEth));
  if (balEth < hre.ethers.parseEther("0.00005")) {
    throw new Error("deployer ETH < 0.00005 — top up first (Arb deploy is cheap, but not free)");
  }

  step("1. EcosystemMarketplaceV3 (admin=deployer for beta — rotate to Safe before mainnet promotion)");
  const F = await hre.ethers.getContractFactory("EcosystemMarketplaceV3");
  const m = await F.deploy(deployer.address, ARB_USDC, DIGGER_REGISTRY_V2, ROYALTY_ROUTER_V2);
  await m.waitForDeployment();
  const addr = await m.getAddress();
  console.log("  EcosystemMarketplaceV3:", addr);

  step("2. Sanity-check post-deploy state");
  console.log("  protocolFeeBps :", await m.protocolFeeBps());
  console.log("  paused         :", await m.paused());
  console.log("  USDC           :", await m.USDC());
  console.log("  REGISTRY       :", await m.REGISTRY());
  console.log("  ROUTER         :", await m.ROUTER());

  section("Save config");
  const out = {
    chainId: Number(net.chainId),
    network: "arbitrum",
    usdc: ARB_USDC,
    treasury: TREASURY_SAFE,
    deployer: deployer.address,
    contracts: {
      diggerRegistry: DIGGER_REGISTRY_V2,
      royaltyRouter:  ROYALTY_ROUTER_V2,
      marketplaceV3:  addr,
    },
    config: {
      protocolFeeBps: 250,
    },
    deployedAt: new Date().toISOString(),
    notes: "v3 alongside v2. v2 (0xa27A29DC...) stays for Phase 3 lending until v3.1.",
  };
  const p = path.join(__dirname, "..", "config", "deployed-marketplace-v3-arb.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("  wrote", p);

  section("Verify on Arbiscan");
  console.log("Run after deploy:");
  console.log(`  npx hardhat verify --network arbitrum ${addr} ${deployer.address} ${ARB_USDC} ${DIGGER_REGISTRY_V2} ${ROYALTY_ROUTER_V2}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
