const hre = require("hardhat");
const MIRROR = "0x1E84DAFfFA4DCC4D74a4951403b9fbC6A832752C";
const VAULT  = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
(async () => {
  const [s] = await hre.ethers.getSigners();
  const m = new hre.ethers.Contract(MIRROR, [
    "function balanceOf(address) view returns (uint256)",
    "function lastUpdate(address) view returns (uint64)",
    "function globalLastSync() view returns (uint64)",
  ], s);
  const v = new hre.ethers.Contract(VAULT, [
    "function sdmToken() view returns (address)",
    "function sdmDiscountBps() view returns (uint256)",
    "function sdmThreshold() view returns (uint256)",
  ], s);
  const [bal, lu, gls, sdmT, disc, thr] = await Promise.all([
    m.balanceOf(DEPLOYER), m.lastUpdate(DEPLOYER), m.globalLastSync(),
    v.sdmToken(), v.sdmDiscountBps(), v.sdmThreshold(),
  ]);
  console.log("--- Mirror state ---");
  console.log("deployer SDM mirrored:", hre.ethers.formatUnits(bal, 18), "SDM");
  console.log("lastUpdate:", new Date(Number(lu)*1000).toISOString());
  console.log("globalLastSync:", new Date(Number(gls)*1000).toISOString());
  console.log("--- Vault SDM config ---");
  console.log("sdmToken:", sdmT);
  console.log("discountBps:", disc.toString(), "(50% off if eligible)");
  console.log("threshold:", hre.ethers.formatUnits(thr, 18), "SDM");
  console.log("--- Eligibility ---");
  console.log("deployer eligible?", bal >= thr ? "YES" : "NO", `(${hre.ethers.formatUnits(bal,18)} vs ${hre.ethers.formatUnits(thr,18)})`);
})();
