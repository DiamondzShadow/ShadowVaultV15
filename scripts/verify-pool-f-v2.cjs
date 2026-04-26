const hre = require("hardhat");
const path = require("node:path");

async function main() {
  const sp = require(path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json"));
  const pf = require(path.resolve(__dirname, "..", "config", "deployed-pool-f-hc.json"));
  const lz = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json"));

  const locker = new hre.ethers.Contract(lz.contracts.hyperPositionLocker, [
    "function vaultOf(address) view returns (address)",
  ], hre.ethers.provider);

  const pass = new hre.ethers.Contract(sp.shadowPass, [
    "function yieldReceipt() view returns (address)",
    "function basketReceipt() view returns (address)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  ], hre.ethers.provider);

  const vault = new hre.ethers.Contract(pf.vault, [
    "function USDC() view returns (address)",
    "function yieldReceipt() view returns (address)",
    "function basketReceipt() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function whitelistEnabled() view returns (bool)",
  ], hre.ethers.provider);

  console.log("═══ Stage 2 post-deploy verification ═══\n");
  console.log("ShadowPass v2       :", sp.shadowPass);
  console.log("  yieldReceipt      :", await pass.yieldReceipt(), "(expected", sp.yieldReceipt, ")");
  console.log("  basketReceipt     :", await pass.basketReceipt(), "(expected", sp.basketReceipt, ")");

  console.log("\nShadowVaultHyperBasket v2:", pf.vault);
  console.log("  USDC              :", await vault.USDC());
  console.log("  yieldReceipt      :", await vault.yieldReceipt());
  console.log("  basketReceipt     :", await vault.basketReceipt());
  console.log("  totalAssets       :", (await vault.totalAssets()).toString());
  console.log("  whitelistEnabled  :", await vault.whitelistEnabled());

  console.log("\nLZ locker wiring:");
  const v = await locker.vaultOf(sp.shadowPass);
  console.log(`  vaultOf(ShadowPass v2): ${v}`);
  console.log(`  match ShadowPassValuer v2: ${v.toLowerCase() === sp.shadowPassValuer.toLowerCase()}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
