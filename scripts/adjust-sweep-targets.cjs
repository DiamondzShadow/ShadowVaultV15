// Sweep targets: reserve 25% / Aave 60% / HyperEVM 15%.
// Reflects the slow HyperEVM inbound (5-7 day withdraw3) — keep allocation small.
const hre = require("hardhat");
const SWEEP = "0xE2239A47a98976984aab7bf4E8fea1Db04E1BdC3";
(async () => {
  const [s] = await hre.ethers.getSigners();
  const c = new hre.ethers.Contract(SWEEP, [
    "function setTargets(uint16,uint16,uint16)",
    "function reserveBps() view returns (uint16)",
    "function aaveBps() view returns (uint16)",
    "function remoteBps() view returns (uint16)",
  ], s);
  console.log("before: reserve =", await c.reserveBps(), "aave =", await c.aaveBps(), "remote =", await c.remoteBps());
  const tx = await c.setTargets(2500, 6000, 1500);
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("after : reserve =", await c.reserveBps(), "aave =", await c.aaveBps(), "remote =", await c.remoteBps());
})();
