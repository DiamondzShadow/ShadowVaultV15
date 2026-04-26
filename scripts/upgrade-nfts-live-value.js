// Deploy new ShadowPositionNFTV15 with live portfolio value for each pool.
// Wire: setPositionNFT on vault, addVault on NFT, setVault on NFT.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function positionNFT() view returns (address)",
];
const NFT_ABI = [
  "function addVault(address) external",
  "function setVault(address) external",
  "function setBonusAccumulator(address) external",
  "function vault() view returns (address)",
  "function poolLabel() view returns (string)",
];

const POOLS = {
  A: { label: "Blue Chip Morpho" },
  B: { label: "DeFi RWA GMX" },
  C: { label: "Full Spectrum Aave" },
  D: { label: "Hard Assets" },
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  for (const [poolId, cfg] of Object.entries(POOLS)) {
    const pool = deployed.pools[poolId];
    if (!pool || !pool.vault) { console.log(`Pool ${poolId}: not found, skip`); continue; }

    console.log(`\n═══ Pool ${poolId} (${cfg.label}) ═══`);
    console.log("  vault:", pool.vault);

    // Deploy new NFT
    const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
    const nft = await NFT.deploy(cfg.label, signer.address);
    await nft.waitForDeployment();
    const nftAddr = await nft.getAddress();
    console.log("  new NFT:", nftAddr, "tx:", nft.deploymentTransaction().hash);

    const nftC = new ethers.Contract(nftAddr, NFT_ABI, signer);
    let tx;

    // Grant VAULT_ROLE to the vault
    tx = await nftC.addVault(pool.vault);
    console.log("  addVault tx:", tx.hash); await tx.wait();

    // Set vault reference for live valuation
    tx = await nftC.setVault(pool.vault);
    console.log("  setVault tx:", tx.hash); await tx.wait();

    // Set bonus accumulator
    tx = await nftC.setBonusAccumulator(BONUS_V2_1);
    console.log("  setBonusAccumulator tx:", tx.hash); await tx.wait();

    // Wire vault to new NFT
    const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
    tx = await vault.setPositionNFT(nftAddr);
    console.log("  vault.setPositionNFT tx:", tx.hash); await tx.wait();

    // Verify
    const newNft = await vault.positionNFT();
    console.log("  verified positionNFT:", newNft);

    // Update deployed.json
    pool.positionNFT = nftAddr;
    pool.nftVersion = "v15.6-live-value";
  }

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\n\ndeployed.json updated with new NFT addresses.");
  console.log("═══ All pools upgraded to live-value NFTs ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
