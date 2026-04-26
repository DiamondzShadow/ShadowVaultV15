const { ethers } = require("hardhat");
const POOL_B = "0x6dc34609EA286f326ECf5dc087068dA964dDcCb3";
const ADAPTER = "0x1008AB5B2B560981DF48b7b4b44ef4075A1957cF";
const PT = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

async function main() {
  const [signer] = await ethers.getSigners();
  const vault = new ethers.Contract(POOL_B, ["function deposit(uint256,uint8) returns (uint256)", "function nextPosId() view returns (uint256)"], signer);
  const usdc = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"], signer);
  const adapter = new ethers.Contract(ADAPTER, ["function totalAssets() view returns (uint256)", "function slippageBps() view returns (uint256)", "function ptScale() view returns (uint256)", "function ptDecimals() view returns (uint8)"], signer);
  const pt = new ethers.Contract(PT, ["function balanceOf(address) view returns (uint256)"], signer);

  console.log("signer:", signer.address);
  console.log("USDC bal:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));
  console.log("adapter slippageBps:", (await adapter.slippageBps()).toString());
  console.log("adapter ptDecimals:", (await adapter.ptDecimals()).toString());
  console.log("adapter ptScale:", (await adapter.ptScale()).toString());

  const allow = await usdc.allowance(signer.address, POOL_B);
  if (allow < 5_000_000n) {
    const tx = await usdc.approve(POOL_B, 5_000_000n);
    console.log("approve:", tx.hash); await tx.wait();
  }

  console.log("\ndeposit $5 FLEX into Pool B v4 (decimal-aware adapter)...");
  const tx = await vault.deposit(5_000_000n, 0);
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("gas:", rcpt.gasUsed.toString());

  console.log("\nadapter totalAssets:", (await adapter.totalAssets()).toString());
  console.log("adapter PT balance:", (await pt.balanceOf(ADAPTER)).toString());
  console.log("Pool B v4 nextPosId:", (await vault.nextPosId()).toString());
  console.log("\n═══ PENDLE END-TO-END ACTUALLY WORKING ═══");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
