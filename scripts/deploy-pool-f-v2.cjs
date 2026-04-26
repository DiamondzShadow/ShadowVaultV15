// Stage 2 redeploy: ShadowPass v2 + ShadowVaultHyperBasket v2 + ShadowPassValuer v2
// All with rescue functions. Keeps old YieldReceipt / BasketReceipt / BasketNavOracle
// / HLPAdapterHCv2 / BasketAdapterHC (they have rescue already or hold nothing).
//
// Rewires after deploy:
//   - YieldReceipt.registerStrategy for new vault (if not already pointing at new)
//   - BasketReceipt.registerVault(new vault)
//   - HLPAdapterHCv2.grantRole(VAULT_ROLE, new vault)
//   - BasketAdapterHC.grantRole(VAULT_ROLE, new vault)
//   - HyperPositionLocker.setVaultFor(ShadowPass v2, ShadowPassValuer v2)
//
// Runs on HyperEVM only.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`Expected 999, got ${chainId}`);

  console.log("Deployer:", deployer.address);
  const balBefore = await hre.ethers.provider.getBalance(deployer.address);
  console.log("HYPE bal:", hre.ethers.formatEther(balBefore));

  // ───── read existing config ──────────────────────────────────────
  const spCfgPath = path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json");
  const pfCfgPath = path.resolve(__dirname, "..", "config", "deployed-pool-f-hc.json");
  const peCfgPath = path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json");
  const lzCfgPath = path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json");

  const sp = JSON.parse(fs.readFileSync(spCfgPath, "utf8"));
  const pf = JSON.parse(fs.readFileSync(pfCfgPath, "utf8"));
  const pe = JSON.parse(fs.readFileSync(peCfgPath, "utf8"));
  const lz = JSON.parse(fs.readFileSync(lzCfgPath, "utf8"));

  const USDC          = pf.usdc;
  const HLP_ADAPTER   = pe.adapter;        // HLPAdapterHCv2 — shared
  const BASKET_ADAPT  = pf.basketAdapter;  // BasketAdapterHC
  const YIELD_RECEIPT = sp.yieldReceipt;
  const BASKET_RECEIPT= sp.basketReceipt;
  const NAV_ORACLE    = sp.oracle;
  const TREASURY_SAFE = pf.treasury || pe.treasury;
  const LOCKER        = lz.contracts.hyperPositionLocker;

  console.log("\nInputs:");
  console.log("  USDC             :", USDC);
  console.log("  HLPAdapterHCv2   :", HLP_ADAPTER);
  console.log("  BasketAdapterHC  :", BASKET_ADAPT);
  console.log("  YieldReceipt     :", YIELD_RECEIPT);
  console.log("  BasketReceipt    :", BASKET_RECEIPT);
  console.log("  BasketNavOracle  :", NAV_ORACLE);
  console.log("  Treasury (Safe)  :", TREASURY_SAFE);
  console.log("  LZ Locker        :", LOCKER);

  // ───── 1. Deploy ShadowPass v2 ────────────────────────────────────
  console.log("\n1. Deploy ShadowPass v2 (with rescue)");
  const SP = await hre.ethers.getContractFactory("ShadowPass");
  const passV2 = await SP.deploy(deployer.address, YIELD_RECEIPT, BASKET_RECEIPT);
  await passV2.waitForDeployment();
  const passAddr = await passV2.getAddress();
  console.log("   ShadowPass v2:", passAddr);

  // ───── 2. Deploy ShadowVaultHyperBasket v2 ───────────────────────
  console.log("\n2. Deploy ShadowVaultHyperBasket v2 (with rescue)");
  const SV = await hre.ethers.getContractFactory("ShadowVaultHyperBasket");
  const vaultV2 = await SV.deploy(
    deployer.address,
    USDC,
    HLP_ADAPTER,
    BASKET_ADAPT,
    YIELD_RECEIPT,
    BASKET_RECEIPT,
    NAV_ORACLE,
    TREASURY_SAFE,
  );
  await vaultV2.waitForDeployment();
  const vaultAddr = await vaultV2.getAddress();
  console.log("   ShadowVaultHyperBasket v2:", vaultAddr);

  // ───── 3. Deploy ShadowPassValuer v2 ─────────────────────────────
  console.log("\n3. Deploy ShadowPassValuer v2");
  const SPV = await hre.ethers.getContractFactory("ShadowPassValuer");
  const valuerV2 = await SPV.deploy(passAddr, YIELD_RECEIPT, BASKET_RECEIPT);
  await valuerV2.waitForDeployment();
  const valuerAddr = await valuerV2.getAddress();
  console.log("   ShadowPassValuer v2:", valuerAddr);

  // ───── 4. Rewire: YieldReceipt strategy ───────────────────────────
  // YieldReceipt uses strategy registry; we register a new strategy for the
  // new vault (doesn't revoke old). ShadowVault's deposit() path picks its
  // own strategyId; the receipt just needs a strategy row that points at
  // the new vault so its mint path authorizes.
  //
  // Simpler: grant VAULT_ROLE directly since the receipt has that.
  console.log("\n4. YieldReceipt: registerStrategy for vault v2");
  const yr = await hre.ethers.getContractAt("YieldReceipt", YIELD_RECEIPT);
  const sig = yr.interface.getFunction("registerStrategy");
  if (sig) {
    // Strategy id = next — just append. The new vault gets VAULT_ROLE by side effect.
    const tx = await yr.registerStrategy(
      "HyperCore-v2",
      vaultAddr,
      HLP_ADAPTER,
      "Hyperliquid HLP",
      "~20%",
    );
    await tx.wait();
    console.log("   tx:", tx.hash);
  }

  // ───── 5. BasketReceipt: registerVault ────────────────────────────
  console.log("\n5. BasketReceipt.registerVault(vault v2)");
  const br = await hre.ethers.getContractAt("BasketReceipt", BASKET_RECEIPT);
  const tx5 = await br.registerVault(vaultAddr);
  await tx5.wait();
  console.log("   tx:", tx5.hash);

  // ───── 6. HLPAdapterHCv2: grant VAULT_ROLE ───────────────────────
  console.log("\n6. HLPAdapterHCv2.grantRole(VAULT_ROLE, vault v2)");
  const hlp = await hre.ethers.getContractAt("HLPAdapterHCv2", HLP_ADAPTER);
  const VAULT_ROLE = await hlp.VAULT_ROLE();
  if (await hlp.hasRole(VAULT_ROLE, vaultAddr)) {
    console.log("   already has role ✓");
  } else {
    const tx6 = await hlp.grantRole(VAULT_ROLE, vaultAddr);
    await tx6.wait();
    console.log("   tx:", tx6.hash);
  }

  // ───── 7. BasketAdapterHC: grant VAULT_ROLE ──────────────────────
  console.log("\n7. BasketAdapterHC.grantRole(VAULT_ROLE, vault v2)");
  const bat = await hre.ethers.getContractAt("BasketAdapterHC", BASKET_ADAPT);
  const BAT_VAULT_ROLE = await bat.VAULT_ROLE();
  if (await bat.hasRole(BAT_VAULT_ROLE, vaultAddr)) {
    console.log("   already has role ✓");
  } else {
    const tx7 = await bat.grantRole(BAT_VAULT_ROLE, vaultAddr);
    await tx7.wait();
    console.log("   tx:", tx7.hash);
  }

  // ───── 8. Locker: setVaultFor(pass v2, valuer v2) ─────────────────
  console.log("\n8. HyperPositionLocker.setVaultFor(ShadowPass v2, ShadowPassValuer v2)");
  const locker = await hre.ethers.getContractAt("HyperPositionLocker", LOCKER);
  const tx8 = await locker.setVaultFor(passAddr, valuerAddr);
  await tx8.wait();
  console.log("   tx:", tx8.hash);

  // ───── persist ────────────────────────────────────────────────────
  sp.shadowPass        = passAddr;
  sp.shadowPassValuer  = valuerAddr;
  sp.shadowPass_v1_unused   = sp.shadowPass_v1_unused || "0x397BaB25a41Aaa5cF76F19DE8794D5476B576CCC";
  sp.valuer_v1_unused       = sp.valuer_v1_unused       || "0x27980Da17BAC6884631412b30B5eD1C49915C702";
  sp.valuerDeployedAt  = new Date().toISOString();
  sp.redeployedAt      = new Date().toISOString();
  fs.writeFileSync(spCfgPath, JSON.stringify(sp, null, 2));

  pf.vault_v1_unused        = pf.vault_v1_unused        || pf.vault;
  pf.vault                  = vaultAddr;
  pf.redeployedAt           = new Date().toISOString();
  pf.notes = "v2: with rescue. Old vault at vault_v1_unused is a zombie (0 TVL before redeploy).";
  fs.writeFileSync(pfCfgPath, JSON.stringify(pf, null, 2));

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\nHYPE spent: ${hre.ethers.formatEther(balBefore - balAfter)}`);
  console.log("\n═══ Stage 2 summary ═══");
  console.log("ShadowPass v2        :", passAddr);
  console.log("HyperBasket vault v2 :", vaultAddr);
  console.log("ShadowPassValuer v2  :", valuerAddr);
}

main().catch(e=>{console.error(e);process.exit(1);});
