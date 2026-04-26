const hre = require("hardhat");
const path = require("node:path");
async function main() {
  const cfg = require(path.resolve("config/deployed-pool-e-hc-v2.json"));
  const HC_KEEPER = cfg.keeper; // 0x506cB4…
  const adapter = new hre.ethers.Contract(cfg.adapter, [
    "function KEEPER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], hre.ethers.provider);
  const role = await adapter.KEEPER_ROLE();
  console.log("HC keeper wallet:", HC_KEEPER);
  console.log("has KEEPER_ROLE on HLPAdapterHC v2:", await adapter.hasRole(role, HC_KEEPER));
}
main().catch(e => { console.error(e); process.exit(1); });
