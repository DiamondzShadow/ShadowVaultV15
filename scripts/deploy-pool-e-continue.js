// Continuation of Pool E deploy — resumes after big-blocks were enabled.
// Reuses already-deployed RevenueRouterHC + HLPAdapterHC; deploys HyperSkin +
// ShadowVaultV15, then wires all roles.

const hre = require("hardhat");
const fs  = require("node:fs");
const path = require("node:path");

const HYPEREVM_MAINNET_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const HLP_VAULT_ADDR        = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

// Already-live from the first (partial) run:
const ROUTER_ADDR  = "0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21";
const ADAPTER_ADDR = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

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

  const treasury = process.env.TREASURY_SAFE_HC;
  const keeper   = process.env.KEEPER_HC;
  if (!treasury || !keeper) throw new Error("TREASURY_SAFE_HC / KEEPER_HC not set");

  section(`Pool E Continue — HyperEVM (chain 999, big blocks)`);
  console.log("Deployer :", deployer.address);
  console.log("Treasury :", treasury);
  console.log("Keeper   :", keeper);
  console.log("Router   :", ROUTER_ADDR);
  console.log("Adapter  :", ADAPTER_ADDR);
  console.log("HYPE bal :", hre.ethers.formatEther(
    await hre.ethers.provider.getBalance(deployer.address)));

  const router  = await hre.ethers.getContractAt("RevenueRouterHC", ROUTER_ADDR);
  const adapter = await hre.ethers.getContractAt("HLPAdapterHC", ADAPTER_ADDR);

  step("3. HyperSkin NFT");
  const skin = await deploy("HyperSkin", ["HyperCash", deployer.address]);

  step("4. ShadowVaultV15 (Pool E)");
  const vault = await deploy("ShadowVaultV15", [
    deployer.address,
    ADAPTER_ADDR,
    treasury,
    hre.ethers.ZeroAddress,
    HYPEREVM_MAINNET_USDC,
    hre.ethers.ZeroAddress,
  ]);

  section("5. Wire roles");
  step("adapter.addVault(vault)");
  await (await adapter.addVault(await vault.getAddress())).wait();

  step("skin.registerStrategy(HyperCash, vault)");
  await (await skin.registerStrategy("HyperCash", await vault.getAddress())).wait();

  step("vault.setPositionNFT(skin)");
  await (await vault.setPositionNFT(await skin.getAddress())).wait();

  step("vault.setAllocation(0, 10000) — 100% yield");
  await (await vault.setAllocation(0, 10_000)).wait();

  step("router.addAuthorized(vault)");
  await (await router.addAuthorized(await vault.getAddress())).wait();

  step("skin.setFeeRoutes(treasury, router)");
  await (await skin.setFeeRoutes(treasury, await router.getAddress())).wait();

  section("6. Whitelist deployer");
  try {
    await (await vault.setWhitelistEnabled(true)).wait();
    await (await vault.setWhitelist(deployer.address, true)).wait();
    console.log("  whitelist ON, deployer whitelisted");
  } catch (e) {
    console.log("  skip —", e.shortMessage || e.message);
  }

  section("7. Save addresses");
  const out = {
    chainId,
    usdc: HYPEREVM_MAINNET_USDC,
    hlpVault: HLP_VAULT_ADDR,
    revenueRouter: ROUTER_ADDR,
    adapter:       ADAPTER_ADDR,
    skin:          await skin.getAddress(),
    vault:         await vault.getAddress(),
    deployer:      deployer.address,
    treasury,
    keeper,
    caps: { perTx: "500000000", daily: "2000000000" },
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const outfile = path.join(dir, "deployed-pool-e-hc.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outfile}`);

  section("DONE");
  console.log("Next: adapter.verifyRoute(1_000_000) round-trip smoke test, then seed deposit.");
}

main().catch((e) => { console.error(e); process.exit(1); });
