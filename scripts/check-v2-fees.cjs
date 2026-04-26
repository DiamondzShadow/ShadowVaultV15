const hre = require("hardhat");
const VAULT = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
(async () => {
  const [s] = await hre.ethers.getSigners();
  const v = new hre.ethers.Contract(VAULT, [
    "function earlyExitFeeBps() view returns (uint256)",
    "function onTimeFeeBps() view returns (uint256)",
    "function protocolYieldFeeBps() view returns (uint256)",
    "function withdrawTimeout() view returns (uint256)",
    "function whitelistEnabled() view returns (bool)",
    "function basketBps() view returns (uint256)",
    "function yieldBps() view returns (uint256)",
    "function treasury() view returns (address)",
  ], s);
  const out = {};
  for (const fn of ["earlyExitFeeBps","onTimeFeeBps","protocolYieldFeeBps","withdrawTimeout","whitelistEnabled","basketBps","yieldBps","treasury"]) {
    try { out[fn] = (await v[fn]()).toString(); } catch (e) { out[fn] = `ERR:${e.message.slice(0,40)}`; }
  }
  console.log(JSON.stringify(out, null, 2));
})();
