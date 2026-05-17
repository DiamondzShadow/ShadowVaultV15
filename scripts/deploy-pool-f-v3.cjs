// Deploy ShadowVaultHyperBasketV3 — Pool F v3 vault with yield-leg wired
// in withdrawPair. Same constructor + dependencies as v2; existing
// YieldReceipt / BasketReceipt / BasketNavOracle / HLPAdapterHCv2 /
// BasketAdapterHC / ShadowPass are unchanged.
//
// Post-deploy wiring (all admin txs from deployer EOA):
//   1. Pool F v3 .setAllocation(basketBps=6000, yieldBps=4000)
//   2. HLPAdapterHCv2.grantRole(VAULT_ROLE, v3)
//   3. BasketAdapterHC.grantRole(VAULT_ROLE, v3)
//   4. YieldReceipt.grantRole(VAULT_ROLE, v3)
//   5. BasketReceipt.grantRole(VAULT_ROLE, v3)
//
// Notes:
//   - v2 vault (0x3F43…7552) is NOT revoked from any role yet. It stays
//     callable so that the deployer's 1 active YieldReceipt+BasketReceipt
//     pair can still call withdrawPair on v2 (basket leg only, like
//     before). To recover the yield leg of that test pair, we'd need an
//     admin "seed" function in v3 — out of scope for this turn.
//   - v3 default whitelistEnabled = false; no extra call needed.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const VAULT_ROLE = "0x31e0210044b4f6757ce6aa31f9c6e8d4896d24a755014887391a926c5224d959";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`Expected chainId 999 (HyperEVM), got ${chainId}`);

  console.log("Deployer:", deployer.address);
  const balBefore = await hre.ethers.provider.getBalance(deployer.address);
  console.log("HYPE bal:", hre.ethers.formatEther(balBefore));

  // ───── load existing config ──────────────────────────────────────────
  const pfCfgPath = path.resolve(__dirname, "..", "config", "deployed-pool-f-hc.json");
  const peCfgPath = path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json");
  const spCfgPath = path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json");

  const pf = JSON.parse(fs.readFileSync(pfCfgPath, "utf8"));
  const pe = JSON.parse(fs.readFileSync(peCfgPath, "utf8"));
  const sp = JSON.parse(fs.readFileSync(spCfgPath, "utf8"));

  const USDC          = pf.usdc;
  const HLP_ADAPTER   = pe.adapter;           // shared HLPAdapterHCv2
  const BASKET_ADAPT  = pf.basketAdapter;
  const YIELD_RECEIPT = sp.yieldReceipt;
  const BASKET_RECEIPT= sp.basketReceipt;
  const NAV_ORACLE    = sp.oracle;
  const TREASURY      = pf.treasury;
  const PREV_VAULT_V2 = pf.vault;

  console.log("\nInputs:");
  console.log("  USDC             :", USDC);
  console.log("  HLPAdapterHCv2   :", HLP_ADAPTER);
  console.log("  BasketAdapterHC  :", BASKET_ADAPT);
  console.log("  YieldReceipt     :", YIELD_RECEIPT);
  console.log("  BasketReceipt    :", BASKET_RECEIPT);
  console.log("  BasketNavOracle  :", NAV_ORACLE);
  console.log("  Treasury         :", TREASURY);
  console.log("  Pool F v2 (old)  :", PREV_VAULT_V2);

  // ───── 1. Deploy v3 ──────────────────────────────────────────────────
  console.log("\n1. Deploy ShadowVaultHyperBasketV3");
  const SV = await hre.ethers.getContractFactory("ShadowVaultHyperBasketV3");
  const vaultV3 = await SV.deploy(
    deployer.address,
    USDC,
    HLP_ADAPTER,
    BASKET_ADAPT,
    YIELD_RECEIPT,
    BASKET_RECEIPT,
    NAV_ORACLE,
    TREASURY,
  );
  await vaultV3.waitForDeployment();
  const v3Addr = await vaultV3.getAddress();
  console.log("   ShadowVaultHyperBasketV3:", v3Addr);

  // ───── 2. Configure allocation 6000/4000 (matching v2) ────────────────
  console.log("\n2. setAllocation(6000, 4000)");
  await (await vaultV3.setAllocation(6000, 4000)).wait();

  // ───── 3. Grant VAULT_ROLE on dependencies ────────────────────────────
  const adapter   = await hre.ethers.getContractAt("contracts/adapters/HLPAdapterHCv2.sol:HLPAdapterHCv2", HLP_ADAPTER, deployer).catch(() => null);
  const basketAd  = await hre.ethers.getContractAt(["function grantRole(bytes32,address) external"], BASKET_ADAPT, deployer);
  const yieldRx   = await hre.ethers.getContractAt(["function grantRole(bytes32,address) external"], YIELD_RECEIPT, deployer);
  const basketRx  = await hre.ethers.getContractAt(["function grantRole(bytes32,address) external"], BASKET_RECEIPT, deployer);

  // HLPAdapterHCv2 — use generic grantRole interface to avoid artifact path lookups.
  const hlpAdapter = await hre.ethers.getContractAt(["function grantRole(bytes32,address) external"], HLP_ADAPTER, deployer);

  console.log("\n3. Grant VAULT_ROLE on HLPAdapterHCv2 → v3");
  await (await hlpAdapter.grantRole(VAULT_ROLE, v3Addr)).wait();

  console.log("4. Grant VAULT_ROLE on BasketAdapterHC → v3");
  await (await basketAd.grantRole(VAULT_ROLE, v3Addr)).wait();

  console.log("5. Grant VAULT_ROLE on YieldReceipt → v3");
  await (await yieldRx.grantRole(VAULT_ROLE, v3Addr)).wait();

  console.log("6. Grant VAULT_ROLE on BasketReceipt → v3");
  await (await basketRx.grantRole(VAULT_ROLE, v3Addr)).wait();

  // ───── 4. Save deployment artifact ────────────────────────────────────
  const outPath = path.resolve(__dirname, "..", "config", "deployed-pool-f-hc-v3.json");
  const out = {
    chainId: 999,
    vault: v3Addr,
    vault_v2_legacy: PREV_VAULT_V2,
    basketAdapter: BASKET_ADAPT,
    yieldAdapter: HLP_ADAPTER,
    yieldReceipt: YIELD_RECEIPT,
    basketReceipt: BASKET_RECEIPT,
    navOracle: NAV_ORACLE,
    usdc: USDC,
    deployer: deployer.address,
    treasury: TREASURY,
    allocation: { basketBps: 6000, yieldBps: 4000 },
    deployedAt: new Date().toISOString(),
    notes:
      "Pool F v3: withdrawPair now settles BOTH yield + basket legs. " +
      "v2 vault remains callable for legacy basket-only withdrawPair on " +
      "any pre-existing receipts that haven't been seeded into v3.",
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\nDeployment artifact written:", outPath);

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  console.log("HYPE spent:", hre.ethers.formatEther(balBefore - balAfter));
}

main().catch((e) => { console.error(e); process.exit(1); });
