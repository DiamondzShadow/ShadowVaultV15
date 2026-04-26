// Set all 4 pools to 40% basket / 60% yield allocation
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const VAULT_ABI = [
  "function setAllocation(uint256,uint256) external",
  "function basketBps() view returns (uint256)",
  "function yieldBps() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));

  const pools = ["A", "B", "C", "D"];

  for (const p of pools) {
    const pool = deployed.pools[p];
    if (!pool || !pool.vault) { console.log(`Pool ${p}: skipped (not found)`); continue; }

    const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
    const before = { basket: await vault.basketBps(), yield: await vault.yieldBps() };
    console.log(`Pool ${p} (${pool.vault}):`);
    console.log(`  before: basket=${before.basket} yield=${before.yield}`);

    if (Number(before.basket) === 4000 && Number(before.yield) === 6000) {
      console.log("  already 40/60, skip\n");
      continue;
    }

    const tx = await vault.setAllocation(4000, 6000);
    console.log("  setAllocation(4000, 6000) tx:", tx.hash);
    await tx.wait();

    const after = { basket: await vault.basketBps(), yield: await vault.yieldBps() };
    console.log("  after: basket=" + after.basket + " yield=" + after.yield + "\n");
  }

  console.log("═══ All pools set to 40% basket / 60% yield ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
