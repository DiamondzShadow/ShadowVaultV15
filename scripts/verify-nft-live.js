// Deposit $5 into Pool A, then read the NFT tokenURI on-chain to verify live traits.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const VAULT_ABI = [
  "function deposit(uint256,uint8) external",
  "function estimatePositionValue(uint256) view returns (uint256,uint256,uint256)",
];
const NFT_ABI = [
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
  "function poolLabel() view returns (string)",
  "function yieldSource() view returns (string)",
  "function riskTier() view returns (string)",
  "function apyRange() view returns (string)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));
  const pool = deployed.pools.A;

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
  const nft = new ethers.Contract(pool.positionNFT, NFT_ABI, signer);

  // Check NFT metadata fields
  console.log("═══ NFT Contract State ═══");
  console.log("  poolLabel:  ", await nft.poolLabel());
  console.log("  yieldSource:", await nft.yieldSource());
  console.log("  riskTier:   ", await nft.riskTier());
  console.log("  apyRange:   ", await nft.apyRange());

  // Deposit $5
  console.log("\n═══ Deposit $5 FLEX into Pool A ═══");
  const deposit = ethers.parseUnits("5", 6);
  const allowance = await usdc.allowance(signer.address, pool.vault);
  if (allowance < deposit) {
    const tx = await usdc.approve(pool.vault, ethers.MaxUint256);
    await tx.wait();
  }
  const depTx = await vault.deposit(deposit, 0, { gasLimit: 1_500_000 });
  const rcpt = await depTx.wait();
  console.log("  deposit tx:", rcpt.hash, "gas:", rcpt.gasUsed.toString());

  // Read live position value
  const [basketVal, yieldVal, total] = await vault.estimatePositionValue(3);
  console.log("\n═══ Live Position Value (posId=1) ═══");
  console.log("  basketVal:", ethers.formatUnits(basketVal, 6), "USDC");
  console.log("  yieldVal: ", ethers.formatUnits(yieldVal, 6), "USDC");
  console.log("  total:    ", ethers.formatUnits(total, 6), "USDC");

  // Read NFT tokenURI
  console.log("\n═══ NFT tokenURI (posId=1) ═══");
  const owner = await nft.ownerOf(3);
  console.log("  owner:", owner);

  const uri = await nft.tokenURI(3);
  // Decode base64 JSON
  const jsonBase64 = uri.replace("data:application/json;base64,", "");
  const jsonStr = Buffer.from(jsonBase64, "base64").toString("utf8");
  const metadata = JSON.parse(jsonStr);

  console.log("\n  name:", metadata.name);
  console.log("  description:", metadata.description.slice(0, 80) + "...");
  console.log("\n  attributes:");
  for (const attr of metadata.attributes) {
    console.log(`    ${attr.trait_type}: ${attr.value}`);
  }

  // Decode SVG to check it renders
  const svgBase64 = metadata.image.replace("data:image/svg+xml;base64,", "");
  const svg = Buffer.from(svgBase64, "base64").toString("utf8");
  console.log("\n  SVG length:", svg.length, "bytes");
  console.log("  Contains LIVE PORTFOLIO VALUE:", svg.includes("LIVE PORTFOLIO VALUE"));
  console.log("  Contains yield source:", svg.includes("Morpho Steakhouse"));
  console.log("  Contains PnL:", svg.includes("PnL"));
}

main().catch((e) => { console.error(e); process.exit(1); });
