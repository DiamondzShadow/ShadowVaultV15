const hre = require("hardhat");
const REG = "0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99";
(async () => {
  const [s] = await hre.ethers.getSigners();
  const r = new hre.ethers.Contract(REG, ["function setMinBond(uint256)", "function minBondUSDC() view returns (uint256)"], s);
  console.log("before:", hre.ethers.formatUnits(await r.minBondUSDC(), 6));
  const tx = await r.setMinBond(1000n * 10n ** 6n);
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("after :", hre.ethers.formatUnits(await r.minBondUSDC(), 6));
})();
