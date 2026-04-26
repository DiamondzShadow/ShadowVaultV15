// Deploy ShadowPositionNFTV15 v2 with yield source + risk tier + APY traits.
// Wire to all 4 pools. Set metadata per pool.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

const VAULT_ABI = ["function setPositionNFT(address) external"];
const NFT_ABI = [
  "function addVault(address) external",
  "function setVault(address) external",
  "function setBonusAccumulator(address) external",
  "function setYieldSource(string) external",
  "function setRiskTier(string) external",
  "function setApyRange(string) external",
];

const POOLS = {
  A: {
    label: "Blue Chip Morpho",
    yieldSource: "Morpho Steakhouse",
    riskTier: "Conservative",
    apyRange: "2-3%",
  },
  B: {
    label: "DeFi RWA GMX",
    yieldSource: "GMX V2 GM Pool",
    riskTier: "Aggressive",
    apyRange: "15-25%",
  },
  C: {
    label: "Full Spectrum Aave",
    yieldSource: "Aave V3 USDC",
    riskTier: "Conservative",
    apyRange: "1-2%",
  },
  D: {
    label: "Hard Assets",
    yieldSource: "Fluid fUSDC",
    riskTier: "Moderate",
    apyRange: "3-5%",
  },
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  for (const [poolId, cfg] of Object.entries(POOLS)) {
    const pool = deployed.pools[poolId];
    if (!pool || !pool.vault) continue;

    console.log(`\n═══ Pool ${poolId} (${cfg.label}) ═══`);

    // Deploy
    const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
    const nft = await NFT.deploy(cfg.label, signer.address);
    await nft.waitForDeployment();
    const nftAddr = await nft.getAddress();
    console.log("  NFT:", nftAddr);

    const n = new ethers.Contract(nftAddr, NFT_ABI, signer);
    const v = new ethers.Contract(pool.vault, VAULT_ABI, signer);

    // Wire
    let tx;
    tx = await n.addVault(pool.vault); await tx.wait();
    tx = await n.setVault(pool.vault); await tx.wait();
    tx = await n.setBonusAccumulator(BONUS_V2_1); await tx.wait();
    tx = await n.setYieldSource(cfg.yieldSource); await tx.wait();
    tx = await n.setRiskTier(cfg.riskTier); await tx.wait();
    tx = await n.setApyRange(cfg.apyRange); await tx.wait();
    tx = await v.setPositionNFT(nftAddr); await tx.wait();
    console.log("  wired + metadata set");

    pool.positionNFT = nftAddr;
    pool.nftVersion = "v15.7-rich-traits";
  }

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\n═══ All NFTs deployed with rich traits ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
