// Phase-after-launch wiring:
//   A) Set NFT metadata (yield source / risk tier / APY range)
//   B) Rotate DEFAULT_ADMIN_ROLE on all Pool E contracts from deployer → Safe
//      (grant Safe, then renounce deployer — Safe owner is still deployer EOA
//      as sole signer, so deployer keeps effective control through the Safe.)
//   C) Verify end state.

const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();
const cfg = require("/home/di0zchain/ShadowVaultV15/config/deployed-pool-e-hc.json");

const SAFE = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  console.log("Signer:", w.address);
  console.log("Safe  :", SAFE);

  const skin = new ethers.Contract(cfg.skin, [
    "function setYieldSource(string)",
    "function setRiskTier(string)",
    "function setApyRange(string)",
    "function grantRole(bytes32,address)",
    "function renounceRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function yieldSource() view returns (string)",
    "function riskTier() view returns (string)",
    "function apyRange() view returns (string)",
  ], w);
  const vault = new ethers.Contract(cfg.vault, [
    "function grantRole(bytes32,address)",
    "function renounceRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], w);
  const adapter = new ethers.Contract(cfg.adapter, [
    "function grantRole(bytes32,address)",
    "function renounceRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], w);
  const router = new ethers.Contract(cfg.revenueRouter, [
    "function grantRole(bytes32,address)",
    "function renounceRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], w);

  console.log("\n━━━ A. NFT metadata ━━━");
  console.log("[1/3] setYieldSource('Hyperliquid HLP')");
  await (await skin.setYieldSource("Hyperliquid HLP")).wait();
  console.log("[2/3] setRiskTier('Yield')");
  await (await skin.setRiskTier("Yield")).wait();
  console.log("[3/3] setApyRange('~20%')");
  await (await skin.setApyRange("~20%")).wait();
  console.log("  yieldSource:", await skin.yieldSource());
  console.log("  riskTier   :", await skin.riskTier());
  console.log("  apyRange   :", await skin.apyRange());

  console.log("\n━━━ B. Admin role rotation → Safe ━━━");
  const contracts = [
    ["vault",   vault],
    ["adapter", adapter],
    ["router",  router],
    ["skin",    skin],
  ];
  for (const [name, c] of contracts) {
    const safeHas = await c.hasRole(DEFAULT_ADMIN_ROLE, SAFE);
    if (!safeHas) {
      console.log(`[grant] ${name}.DEFAULT_ADMIN_ROLE → Safe`);
      await (await c.grantRole(DEFAULT_ADMIN_ROLE, SAFE)).wait();
    } else {
      console.log(`[skip ] ${name} already has Safe as admin`);
    }
  }
  console.log("\n  NOT renouncing deployer admin yet — wait 7 days for beta bake.");
  console.log("  (Safe + deployer both hold admin role — dual control.)");

  console.log("\n━━━ C. Verify ━━━");
  for (const [name, c] of contracts) {
    const safe = await c.hasRole(DEFAULT_ADMIN_ROLE, SAFE);
    const dep  = await c.hasRole(DEFAULT_ADMIN_ROLE, w.address);
    console.log(`  ${name.padEnd(8)}: safe=${safe}  deployer=${dep}`);
  }

  console.log("\n✓ Pool E fully wired. Admin = {Safe, deployer}. NFT metadata populated.");
})().catch(e => { console.error(e); process.exit(1); });
