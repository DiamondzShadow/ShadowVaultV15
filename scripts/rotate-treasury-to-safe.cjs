const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const SAFE = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
const cfg = require("../config/deployed-pool-e-hc.json");

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  console.log("Signer   :", w.address);
  console.log("Safe     :", SAFE);
  console.log("Vault    :", cfg.vault);
  console.log("Router   :", cfg.revenueRouter);
  console.log("Skin     :", cfg.skin);

  const vault = new ethers.Contract(cfg.vault, [
    "function setTreasury(address)",
    "function treasury() view returns (address)"
  ], w);
  const router = new ethers.Contract(cfg.revenueRouter, [
    "function setTreasury(address)",
    "function treasury() view returns (address)"
  ], w);
  const skin = new ethers.Contract(cfg.skin, [
    "function setFeeRoutes(address,address)",
    "function treasury() view returns (address)",
    "function revenueRouter() view returns (address)"
  ], w);

  console.log("\nBefore:");
  console.log("  vault.treasury :", await vault.treasury());
  console.log("  router.treasury:", await router.treasury());
  console.log("  skin.treasury  :", await skin.treasury());

  console.log("\n[1/3] vault.setTreasury(Safe)");
  const t1 = await vault.setTreasury(SAFE);
  await t1.wait();
  console.log("  tx:", t1.hash);

  console.log("\n[2/3] router.setTreasury(Safe)");
  const t2 = await router.setTreasury(SAFE);
  await t2.wait();
  console.log("  tx:", t2.hash);

  console.log("\n[3/3] skin.setFeeRoutes(Safe, router)");
  const t3 = await skin.setFeeRoutes(SAFE, cfg.revenueRouter);
  await t3.wait();
  console.log("  tx:", t3.hash);

  console.log("\nAfter:");
  console.log("  vault.treasury :", await vault.treasury());
  console.log("  router.treasury:", await router.treasury());
  console.log("  skin.treasury  :", await skin.treasury());

  cfg.treasury = SAFE;
  cfg.treasuryRotatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-pool-e-hc.json"),
    JSON.stringify(cfg, null, 2));
  console.log("\n✓ treasury rotated to Safe — config updated");
})().catch(e => { console.error(e); process.exit(1); });
