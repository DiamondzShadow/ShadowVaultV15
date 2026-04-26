// Push slippage to 30% (max) and retry

const { ethers } = require("hardhat");
const POOL_B = "0x8a715dE0eb3763c749f79352F81E95531d1e2ec1";
const ADAPTER = "0xF2b075db9c534d75985826bb29F4Be96ab590a77";
const PT = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";

async function main() {
  const [signer] = await ethers.getSigners();
  const adapter = new ethers.Contract(ADAPTER, ["function setSlippage(uint256) external", "function slippageBps() view returns (uint256)", "function totalAssets() view returns (uint256)"], signer);
  const vault = new ethers.Contract(POOL_B, ["function deposit(uint256,uint8) returns (uint256)", "function nextPosId() view returns (uint256)"], signer);
  const pt = new ethers.Contract(PT, ["function balanceOf(address) view returns (uint256)"], signer);

  console.log("before slippage:", (await adapter.slippageBps()).toString());
  let tx = await adapter.setSlippage(3000);
  await tx.wait();
  console.log("after slippage:", (await adapter.slippageBps()).toString());

  console.log("\ndeposit $5 FLEX at 30% slippage...");
  try {
    tx = await vault.deposit(5_000_000n, 0);
    console.log("tx:", tx.hash);
    const rcpt = await tx.wait();
    console.log("gas:", rcpt.gasUsed.toString());
    console.log("\nadapter totalAssets:", (await adapter.totalAssets()).toString());
    console.log("adapter PT balance:", (await pt.balanceOf(ADAPTER)).toString());
    console.log("\n═══ PENDLE WORKING ═══");
  } catch (e) {
    console.log("STILL FAILED:", e.message.slice(0, 200));
    console.log("\nPendle PT-gUSDC market gives <70% of oracle-implied PT for $5 trade.");
    console.log("Likely cause: gUSDC SY conversion layer + AMM curvature near small-trade edge.");
    console.log("Options: (a) much bigger deposit ($50+) to dilute fixed costs, (b) rewrite adapter to pass minPtOut=0, (c) try a different Pendle market with deeper liquidity.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
