// Deploys the ShadowPass NFT stack on HyperEVM (chain 999):
//   1. BasketNavOracle  — keeper-pushed NAV with staleness + drift cap
//   2. YieldReceipt     — ERC-721 for yield leg (strategy registry + live yield)
//   3. BasketReceipt    — ERC-721 for basket leg (entry-NAV snapshot)
//   4. ShadowPass       — wrapper ERC-721 (wrap/unwrap)
//
// After deploy: grant KEEPER_ROLE on the oracle to the keeper EOA and register
// the first basket ("HyperCore" with 15-min staleness, 10% drift cap).
//
// Writes config/deployed-shadowpass-hc.json.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name}: ${addr}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 999) throw new Error(`Expected chain 999, got ${chainId}`);

  const keeper = process.env.KEEPER_HC;
  if (!keeper) throw new Error("KEEPER_HC not set");

  section(`ShadowPass Deploy — HyperEVM (chainId ${chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Keeper  :", keeper);
  console.log("HYPE bal:", hre.ethers.formatEther(
    await hre.ethers.provider.getBalance(deployer.address)));

  // ═════════ 1. BasketNavOracle ═════════
  section("1. BasketNavOracle");
  const oracle = await deploy("BasketNavOracle", [deployer.address]);

  // Grant KEEPER_ROLE to keeper EOA so it can push NAV.
  const KEEPER_ROLE = await oracle.KEEPER_ROLE();
  await (await oracle.grantRole(KEEPER_ROLE, keeper)).wait();
  console.log("  KEEPER_ROLE → keeper");

  // Grant PAUSER_ROLE to deployer (emergency only).
  const PAUSER_ROLE = await oracle.PAUSER_ROLE();
  await (await oracle.grantRole(PAUSER_ROLE, deployer.address)).wait();
  console.log("  PAUSER_ROLE → deployer");

  // ═════════ 2. YieldReceipt ═════════
  section("2. YieldReceipt");
  const yieldReceipt = await deploy("YieldReceipt", [deployer.address]);

  // ═════════ 3. BasketReceipt ═════════
  section("3. BasketReceipt");
  const basketReceipt = await deploy("BasketReceipt", [
    deployer.address,
    await oracle.getAddress(),
  ]);

  // ═════════ 4. ShadowPass (wrapper) ═════════
  section("4. ShadowPass wrapper");
  const pass = await deploy("ShadowPass", [
    deployer.address,
    await yieldReceipt.getAddress(),
    await basketReceipt.getAddress(),
  ]);

  // ═════════ 5. Register first basket ("HyperCore") ═════════
  section("5. Register baskets in oracle");
  const registerTx = await oracle.registerBasket(
    "HyperCore",  // name
    900,          // 15 min max staleness
    1000          // 10% max drift per push
  );
  const receipt = await registerTx.wait();
  // Find BasketRegistered event — basketId = 0 since this is the first
  const basketId = 0;
  console.log(`  basketId ${basketId} = "HyperCore" (900s staleness, 10% drift)`);

  // ═════════ 6. Save addresses ═════════
  section("6. Save config");
  const out = {
    chainId,
    oracle:        await oracle.getAddress(),
    yieldReceipt:  await yieldReceipt.getAddress(),
    basketReceipt: await basketReceipt.getAddress(),
    shadowPass:    await pass.getAddress(),
    baskets: {
      0: { name: "HyperCore", maxStalenessSecs: 900, maxDriftBps: 1000 },
    },
    roles: {
      admin:  deployer.address,
      keeper,
      pauser: deployer.address,
    },
    deployedAt: new Date().toISOString(),
    notes: "Pool F vault integration pending. Keeper must push NAV before any BasketReceipt is minted.",
  };
  const dir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const outfile = path.join(dir, "deployed-shadowpass-hc.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outfile}`);

  section("DONE");
  console.log("Next:");
  console.log("  1. Keeper pushes first NAV for basket 0 (e.g. $1 per share = 1_000_000)");
  console.log("  2. Build ShadowVaultHyperBasket + BasketAdapterHC for Pool F");
  console.log("  3. Register Pool F vault on yieldReceipt.registerStrategy + basketReceipt.registerVault");
}

main().catch((e) => { console.error(e); process.exit(1); });
