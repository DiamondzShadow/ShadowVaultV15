// Deploy the Phase 2 marketplace stack on Arbitrum.
//
// Order:
//   1. DiggerRegistry      (admin=deployer, usdc=Arb USDC native, treasury=Safe)
//   2. RoyaltyRouter       (admin, usdc, registry, treasury)
//   3. EcosystemMarketplace(admin, usdc, registry, router)
//
// Diggers are NOT auto-registered — projects (including Diamondz) open their
// own digger via DiggerRegistry.openDigger() with a USDC bond. Run
// scripts/register-diamondz-digger.cjs once the deployer/treasury has bond
// USDC ready.
//
// Writes config to config/deployed-marketplace-arb.json.

const hre = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const ARB_USDC      = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // native USDC
const TREASURY_SAFE = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const a = await c.getAddress();
  console.log(`  ${name}: ${a}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected Arbitrum (42161), got ${net.chainId}`);

  const balEth = await hre.ethers.provider.getBalance(deployer.address);
  section(`Marketplace deploy on Arbitrum (${net.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Treasury:", TREASURY_SAFE);
  console.log("USDC    :", ARB_USDC);
  console.log("ETH bal :", hre.ethers.formatEther(balEth));
  if (balEth < hre.ethers.parseEther("0.001")) {
    throw new Error("deployer ETH < 0.001 — top up first");
  }

  step("1. DiggerRegistry");
  const registry = await deploy("DiggerRegistry", [deployer.address, ARB_USDC, TREASURY_SAFE]);

  step("2. RoyaltyRouter");
  const router = await deploy("RoyaltyRouter", [
    deployer.address, ARB_USDC, await registry.getAddress(), TREASURY_SAFE,
  ]);

  step("3. EcosystemMarketplace");
  const marketplace = await deploy("EcosystemMarketplace", [
    deployer.address, ARB_USDC, await registry.getAddress(), await router.getAddress(),
  ]);

  // ═════════ Persist
  section("Save config");
  const out = {
    chainId: Number(net.chainId),
    network: "arbitrum",
    usdc: ARB_USDC,
    treasury: TREASURY_SAFE,
    deployer: deployer.address,
    contracts: {
      diggerRegistry: await registry.getAddress(),
      royaltyRouter:  await router.getAddress(),
      marketplace:    await marketplace.getAddress(),
    },
    config: {
      protocolFeeBps: 250,
      minBondUSDC: "1000000000",
      unstakeDelay: 14 * 24 * 60 * 60,
    },
    deployedAt: new Date().toISOString(),
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-marketplace-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("wrote", outfile);

  section("Next steps");
  console.log("1. (Optional) reduce minBond temporarily so Diamondz can open digger #1 with available USDC:");
  console.log(`     registry.setMinBond(10_000000)  # 10 USDC`);
  console.log("2. Run scripts/register-diamondz-digger.cjs to bond + register V15 NFT collections.");
  console.log("3. (Optional) restore minBond afterwards:");
  console.log(`     registry.setMinBond(1000_000000) # 1000 USDC`);
  console.log("4. Push UI bundle: src/abi/marketplace.ts (addresses below)");
  console.log(JSON.stringify(out.contracts, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
