// Continue Pool C v3 — WETH/WBTC/GMX/ARB added. Need PENDLE/LINK/PEPE/USDC + persist.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const VAULT_ADDR   = "0x8E8be91B612d435bc481C738d9a94Eb1cEd162E6";
const ADAPTER_ADDR = "0xe9231FD442C849B293B1652aE739D165179710d6";
const NFT_ADDR     = "0x558408208c24A71bE8066fA7DF2D30288ffFaBeA";

const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const PEPE   = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const LINK_USD_FEED = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const PEPE_USD_FEED = "0x02DEd5a7EDDA750E3Eb240b54437a54d57b74dBE";
const ZERO_FEED     = "0x0000000000000000000000000000000000000000";

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

  const PENDLE_USD_FEED = ethers.getAddress("0x66853e19d73c0f9301fe229c5886c62db2d1e144");
  const v = new ethers.Contract(VAULT_ADDR, VAULT_ABI, signer);
  let tx;

  const currentLen = Number(await v.basketLength());
  console.log("current basketLength:", currentLen);

  if (currentLen < 5) {
    console.log("  addBasketToken(PENDLE, 1000)");
    tx = await v.addBasketToken(PENDLE, 1000, PENDLE_USD_FEED, 8, 18, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }
  if (currentLen < 6) {
    console.log("  addBasketToken(LINK, 1000)");
    tx = await v.addBasketToken(LINK, 1000, LINK_USD_FEED, 8, 18, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }
  if (currentLen < 7) {
    console.log("  addBasketToken(PEPE, 500)");
    tx = await v.addBasketToken(PEPE, 500, PEPE_USD_FEED, 8, 18, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }
  if (currentLen < 8) {
    console.log("  addBasketToken(USDC, 500)");
    tx = await v.addBasketToken(USDC, 500, ZERO_FEED, 0, 6, 0);
    console.log("  tx:", tx.hash); await tx.wait();
  }

  console.log("\nSanity:");
  console.log("  yieldAdapter:", await v.yieldAdapter());
  console.log("  positionNFT: ", await v.positionNFT());
  console.log("  bonusAcc:    ", await v.bonusAccumulator());
  console.log("  basketLength:", (await v.basketLength()).toString());

  // Persist
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  deployed.pools.C_pendle_deprecated = deployed.pools.C;
  deployed.pools.C = {
    label: "Full Spectrum Aave",
    vault: VAULT_ADDR,
    positionNFT: NFT_ADDR,
    yieldSource: "aave-v3-usdc",
    adapter: ADAPTER_ADDR,
    version: "v15.5",
    basket: "WETH 25 / WBTC 15 / GMX 15 / ARB 15 / PENDLE 10 / LINK 10 / PEPE 5 / USDC 5",
  };
  deployed.adapters.aave_v5_pool_c = ADAPTER_ADDR;

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");
  console.log("\n═══ Pool C v3 (Full Spectrum Aave) COMPLETE ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
