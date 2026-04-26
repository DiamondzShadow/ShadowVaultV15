// Continue Pool B v5 deploy — adapter/vault/NFT/wiring done, WETH+GMX added.
// Need to add: PENDLE, LINK, XAUt0, USDC then sanity check + persist.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const VAULT_ADDR   = "0x46faaE6Ba6c30De214BDb12dd8eD404eDa664232";
const ADAPTER_ADDR = "0xF6C6033f077BD23660344b67468B51303d06d573";
const NFT_ADDR     = "0xDC4aA9336dDf2c3Fb258BD8cFBFf2e065522148F";
const MORPHO_GAUNTLET = "0x7c574174DA4b2be3f705c6244B4BfA0815a8B3Ed";

const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const XAU_USD_FEED    = "0x587b3499d3234a93CCC411e945295e3735BBb6a4";
const ZERO_FEED       = "0x0000000000000000000000000000000000000000";

const VAULT_ABI = [
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
  "function basketLength() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  // Get correct PENDLE feed checksum
  const PENDLE_USD_FEED = ethers.getAddress("0x66853e19d73c0f9301fe229c5886c62db2d1e144");

  const v = new ethers.Contract(VAULT_ADDR, VAULT_ABI, signer);
  let tx;

  const currentLen = await v.basketLength();
  console.log("current basketLength:", currentLen.toString());

  if (Number(currentLen) < 3) {
    console.log("\n  addBasketToken(PENDLE, 2000)");
    tx = await v.addBasketToken(PENDLE, 2000, PENDLE_USD_FEED, 8, 18, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }

  if (Number(currentLen) < 4) {
    console.log("  addBasketToken(LINK, 1500)");
    tx = await v.addBasketToken(LINK, 1500, LINK_USD_FEED, 8, 18, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }

  if (Number(currentLen) < 5) {
    console.log("  addBasketToken(XAUt0, 1000, 3-day staleness)");
    tx = await v.addBasketToken(XAUT0, 1000, XAU_USD_FEED, 8, 6, 259200);
    console.log("  tx:", tx.hash); await tx.wait();
  }

  if (Number(currentLen) < 6) {
    console.log("  addBasketToken(USDC, 1000)");
    tx = await v.addBasketToken(USDC, 1000, ZERO_FEED, 0, 6, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }

  // Sanity
  console.log("\nSanity reads:");
  console.log("  yieldAdapter:", await v.yieldAdapter());
  console.log("  positionNFT: ", await v.positionNFT());
  console.log("  bonusAcc:    ", await v.bonusAccumulator());
  console.log("  basketLength:", (await v.basketLength()).toString());

  // Persist
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  deployed.pools.B_pendle_v4_deprecated = deployed.pools.B;
  deployed.pools.B = {
    label: "DeFi + RWA Morpho (Gauntlet)",
    vault: VAULT_ADDR,
    positionNFT: NFT_ADDR,
    yieldSource: "morpho-gauntlet",
    adapter: ADAPTER_ADDR,
    morphoVault: MORPHO_GAUNTLET,
    version: "v15.5",
    basket: "WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10",
  };
  deployed.adapters.morpho_gauntlet = ADAPTER_ADDR;

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");
  console.log("\n═══ Pool B v5 (DeFi+RWA Morpho Gauntlet) COMPLETE ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
