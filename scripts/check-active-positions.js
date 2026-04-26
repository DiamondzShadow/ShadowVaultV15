// Check all active positions + NFTs across all pools
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const VAULT_ABI = [
  "function nextPosId() view returns (uint256)",
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function estimatePositionValue(uint256) view returns (uint256,uint256,uint256)",
];
const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function _nextTokenId() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));

  for (const [poolId, pool] of Object.entries(deployed.pools)) {
    if (!pool.vault || poolId.includes("deprecated") || poolId.includes("broken")) continue;

    const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
    const nextPos = Number(await vault.nextPosId());
    if (nextPos <= 1) continue;

    console.log(`\n═══ Pool ${poolId} (${pool.label || poolId}) ═══`);
    console.log(`  vault: ${pool.vault}`);
    console.log(`  NFT:   ${pool.positionNFT}`);

    let nft;
    try {
      nft = new ethers.Contract(pool.positionNFT, NFT_ABI, signer);
      const nextToken = await nft._nextTokenId();
      console.log(`  nextPosId: ${nextPos}, nextTokenId: ${nextToken}`);
    } catch(e) {}

    for (let posId = 1; posId < nextPos; posId++) {
      const pos = await vault.positions(posId);
      const status = ["NONE", "REQUESTED", "COMPLETED"][Number(pos.withdrawStatus)] || "?";
      if (status === "COMPLETED") {
        console.log(`  pos ${posId}: COMPLETED (withdrawn)`);
        continue;
      }

      const [bv, yv, total] = await vault.estimatePositionValue(posId);
      let nftOwner = "no NFT";
      try { nftOwner = await nft.ownerOf(posId); } catch(e) {}

      console.log(`  pos ${posId}: ACTIVE | deposit=$${ethers.formatUnits(pos.depositAmount, 6)} | value=$${ethers.formatUnits(total, 6)} | tier=${pos.tier} | nftOwner=${nftOwner}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
