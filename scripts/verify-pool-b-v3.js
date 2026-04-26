const { ethers } = require("hardhat");
const POOL_B = "0x8a715dE0eb3763c749f79352F81E95531d1e2ec1";
const ADAPTER = "0xF2b075db9c534d75985826bb29F4Be96ab590a77";
const PT = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

async function main() {
  const [signer] = await ethers.getSigners();
  const vault = new ethers.Contract(POOL_B, ["function deposit(uint256,uint8) returns (uint256)", "function nextPosId() view returns (uint256)"], signer);
  const usdc = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"], signer);
  const adapter = new ethers.Contract(ADAPTER, ["function totalAssets() view returns (uint256)", "function slippageBps() view returns (uint256)"], signer);
  const pt = new ethers.Contract(PT, ["function balanceOf(address) view returns (uint256)"], signer);

  console.log("signer:", signer.address);
  console.log("USDC bal:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));
  console.log("adapter slippageBps:", (await adapter.slippageBps()).toString());

  const allow = await usdc.allowance(signer.address, POOL_B);
  if (allow < 5_000_000n) {
    const tx = await usdc.approve(POOL_B, 5_000_000n);
    console.log("approve:", tx.hash); await tx.wait();
  }

  console.log("\ndeposit $5 FLEX...");
  const tx = await vault.deposit(5_000_000n, 0);
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("gas:", rcpt.gasUsed.toString());

  console.log("\nadapter totalAssets:", (await adapter.totalAssets()).toString());
  console.log("adapter PT balance:", (await pt.balanceOf(ADAPTER)).toString());
  console.log("Pool B v3 nextPosId:", (await vault.nextPosId()).toString());
  console.log("\n═══ PENDLE END-TO-END WORKING ═══");
}
main().catch((e) => { console.error(e); process.exit(1); });
