const { ethers } = require("hardhat");
const POOL = "0x198FDC12a937a70A75aaEaaB265b61a4FE1286F6";
const ADAPTER = "0xf2FB71e254503B9a667Aa0eD450ef19061B2be7F";
const PT = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

async function main() {
  const [s] = await ethers.getSigners();
  const v = new ethers.Contract(POOL, ["function deposit(uint256,uint8) returns (uint256)", "function nextPosId() view returns (uint256)"], s);
  const u = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"], s);
  const a = new ethers.Contract(ADAPTER, ["function totalAssets() view returns (uint256)"], s);
  const pt = new ethers.Contract(PT, ["function balanceOf(address) view returns (uint256)"], s);

  console.log("USDC:", ethers.formatUnits(await u.balanceOf(s.address), 6));
  if ((await u.allowance(s.address, POOL)) < 5_000_000n) {
    const t = await u.approve(POOL, 5_000_000n); await t.wait();
  }
  const tx = await v.deposit(5_000_000n, 0);
  console.log("deposit:", tx.hash);
  const r = await tx.wait();
  console.log("gas:", r.gasUsed.toString());
  console.log("totalAssets:", (await a.totalAssets()).toString());
  console.log("PT balance:", (await pt.balanceOf(ADAPTER)).toString());
  console.log("nextPosId:", (await v.nextPosId()).toString());
  console.log("\n═══ Pool C v2 Pendle LIVE ═══");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
