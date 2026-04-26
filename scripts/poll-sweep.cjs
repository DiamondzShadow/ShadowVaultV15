const hre = require("hardhat");
const ADAPTER = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const ABI = ["function idleUsdc() view returns (uint256)", "function totalAssets() view returns (uint256)"];

async function main() {
  const [s] = await hre.ethers.getSigners();
  const a = new hre.ethers.Contract(ADAPTER, ABI, s);
  for (let i = 0; i < 18; i++) {
    const idle = await a.idleUsdc();
    const total = await a.totalAssets();
    const ts = new Date().toISOString();
    console.log(`${ts}  idle=$${(Number(idle)/1e6).toFixed(6)}  total=$${(Number(total)/1e6).toFixed(6)}`);
    if (idle >= 6_500_000n) { console.log("\nBridge landed."); return; }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log("\nTimeout after 3min — bridge still pending");
}

main().catch(e => { console.error(e); process.exit(1); });
