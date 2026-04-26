// Deploys Pool F (HyperCore basket) on HyperEVM:
//   1. BasketAdapterHC — USDC holder + keeper sweep, basketId = 0 (HyperCore)
//   2. ShadowVaultHyperBasket — vault that mints YieldReceipt + BasketReceipt
//   3. Wire roles:
//        - yieldReceipt.registerStrategy(Pool F vault)
//        - basketReceipt.registerVault(Pool F vault)
//        - basketAdapter.addVault(Pool F vault)
//   4. Set allocation 60/40 basket/yield
//   5. Set caps + whitelist deployer
//
// Yield leg REUSES the existing HLPAdapterHC from Pool E (same HLP strategy,
// just a different vault consuming it). This means Pool E and Pool F share
// HLP deposit caps — acceptable for beta, split into distinct adapters later.

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

  const poolE = require("../config/deployed-pool-e-hc.json");
  const sp    = require("../config/deployed-shadowpass-hc.json");
  const keeper = process.env.KEEPER_HC;
  const treasury = process.env.TREASURY_SAFE_HC;
  if (!keeper || !treasury) throw new Error("KEEPER_HC / TREASURY_SAFE_HC not set");

  const BASKET_ID = 0;  // "HyperCore" registered in oracle

  section(`Pool F Deploy — HyperEVM (chainId ${chainId})`);
  console.log("Deployer      :", deployer.address);
  console.log("Treasury Safe :", treasury);
  console.log("Keeper        :", keeper);
  console.log("USDC          :", poolE.usdc);
  console.log("HLP Adapter   :", poolE.adapter, "(reused as yield leg)");
  console.log("YieldReceipt  :", sp.yieldReceipt);
  console.log("BasketReceipt :", sp.basketReceipt);
  console.log("NAV Oracle    :", sp.oracle);
  console.log("Basket ID     :", BASKET_ID, "(HyperCore)");

  // ═════════ 1. BasketAdapterHC ═════════
  section("1. BasketAdapterHC");
  const basketAdapter = await deploy("BasketAdapterHC", [
    deployer.address,
    keeper,
    poolE.usdc,
    BASKET_ID,
  ]);

  // ═════════ 2. ShadowVaultHyperBasket ═════════
  section("2. ShadowVaultHyperBasket");
  const vault = await deploy("ShadowVaultHyperBasket", [
    deployer.address,
    poolE.usdc,
    poolE.adapter,           // yieldAdapter (reuse Pool E's HLP adapter)
    await basketAdapter.getAddress(),
    sp.yieldReceipt,
    sp.basketReceipt,
    sp.oracle,
    treasury,
  ]);

  // ═════════ 3. Wire roles ═════════
  section("3. Wire roles");
  const vaultAddr = await vault.getAddress();
  const basketAdapterAddr = await basketAdapter.getAddress();

  console.log("  basketAdapter.addVault(vaultF)");
  await (await basketAdapter.addVault(vaultAddr)).wait();

  console.log("  yieldReceipt.registerStrategy('HyperCore', vaultF, hlpAdapter)");
  const YR_ABI = [
    "function registerStrategy(string,address,address,string,string) returns (uint64)",
  ];
  const yr = new hre.ethers.Contract(sp.yieldReceipt, YR_ABI, deployer);
  await (await yr.registerStrategy(
    "HyperCore",
    vaultAddr,
    poolE.adapter,
    "Hyperliquid HLP",
    "~20%"
  )).wait();

  console.log("  basketReceipt.registerVault(vaultF)");
  const BR_ABI = ["function registerVault(address)"];
  const br = new hre.ethers.Contract(sp.basketReceipt, BR_ABI, deployer);
  await (await br.registerVault(vaultAddr)).wait();

  // Grant VAULT_ROLE on HLP adapter too — Pool F writes to it just like Pool E
  console.log("  hlpAdapter.addVault(vaultF) — share yield leg with Pool E");
  const HLP_ABI = ["function addVault(address)"];
  const hlpAdapter = new hre.ethers.Contract(poolE.adapter, HLP_ABI, deployer);
  await (await hlpAdapter.addVault(vaultAddr)).wait();

  // ═════════ 4. Allocation + caps ═════════
  section("4. Configure");
  console.log("  setAllocation(6000, 4000) — 60% basket / 40% yield");
  await (await vault.setAllocation(6000, 4000)).wait();

  console.log("  setWhitelistEnabled(true) + setWhitelist(deployer, true)");
  await (await vault.setWhitelistEnabled(true)).wait();
  await (await vault.setWhitelist(deployer.address, true)).wait();

  // ═════════ 5. Save ═════════
  section("5. Save config");
  const out = {
    chainId,
    basketId: BASKET_ID,
    basketName: "HyperCore",
    vault: vaultAddr,
    basketAdapter: basketAdapterAddr,
    yieldAdapter: poolE.adapter,          // shared with Pool E
    yieldReceipt: sp.yieldReceipt,
    basketReceipt: sp.basketReceipt,
    navOracle: sp.oracle,
    shadowPass: sp.shadowPass,
    usdc: poolE.usdc,
    deployer: deployer.address,
    treasury,
    keeper,
    allocation: { basketBps: 6000, yieldBps: 4000 },
    deployedAt: new Date().toISOString(),
    notes: "Shares Pool E HLP adapter for yield leg. Basket leg idle until basketAdapter.setTrader + keeper trading loop wired.",
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-pool-f-hc.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outfile}`);

  section("Next");
  console.log("1. basketAdapter.setTrader(<hotWallet>) once HC trading wallet exists");
  console.log("2. Seed test: vault.deposit($5, FLEX) — mints YieldReceipt + BasketReceipt");
  console.log("3. Test wrap: pass.wrap(yieldTokenId, basketTokenId) → ShadowPass");
  console.log("4. Upgrade nav-heartbeat.js to real HC price aggregation");
}

main().catch((e) => { console.error(e); process.exit(1); });
