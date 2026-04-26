// ═════════════════════════════════════════════════════════════════════════════
//  Verify Pool D v15.10 end-to-end with a $5 FLEX deposit.
//  Reads the new Pool D vault address from config/deployed.json (written by
//  redeploy-pool-d-v15_10.js).
//
//  Usage:
//    DEPLOYER_KEY=0x... ARB_RPC=... \
//      npx hardhat run scripts/verify-pool-d-v15_10.js --network arbitrum
// ═════════════════════════════════════════════════════════════════════════════

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const FLUID_ADAPTER = "0x763460Df40F5bA8f55854e5AcD167F4D33D66865";
const USDC          = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT        = 5_000_000n; // $5 USDC
const TIER_FLEX     = 0;

const VAULT_ABI = [
  "function deposit(uint256 amount, uint8 tier) external returns (uint256 posId)",
  "function nextPosId() view returns (uint256)",
  "function positionNFT() view returns (address)",
  "event Deposited(uint256 indexed posId, address indexed user, uint8 tier, uint256 amount, uint256 wsdm)",
];
const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];
const NFT_ABI = [
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8")
  );
  const POOL_D_VAULT = deployed.pools.D.vault;
  const POOL_D_NFT   = deployed.pools.D.positionNFT;

  if (deployed.pools.D.version !== "v15.10") {
    throw new Error(`Expected Pool D to be v15.10; got ${deployed.pools.D.version}`);
  }

  console.log("signer:          ", signer.address);
  console.log("Pool D vault:    ", POOL_D_VAULT, "(v15.10)");
  console.log("Pool D NFT:      ", POOL_D_NFT);
  console.log("Fluid adapter:   ", FLUID_ADAPTER, "(reused)");

  const vault   = new ethers.Contract(POOL_D_VAULT, VAULT_ABI, signer);
  const usdc    = new ethers.Contract(USDC, ERC20_ABI, signer);
  const adapter = new ethers.Contract(FLUID_ADAPTER, ADAPTER_ABI, signer);
  const nft     = new ethers.Contract(POOL_D_NFT, NFT_ABI, signer);

  console.log("\nUSDC balance:      ", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));

  const preId = await vault.nextPosId();
  const preSupply = await nft.totalSupply();
  const preAssets = await adapter.totalAssets();
  console.log("\nBEFORE:");
  console.log("  vault.nextPosId:    ", preId.toString());
  console.log("  nft.totalSupply:    ", preSupply.toString());
  console.log("  adapter.totalAssets:", preAssets.toString());

  if (preSupply.toString() !== "0") {
    console.warn(`  ⚠  Fresh NFT should have totalSupply 0, got ${preSupply}`);
  }

  const allow = await usdc.allowance(signer.address, POOL_D_VAULT);
  if (allow < AMOUNT) {
    console.log("\napproving USDC...");
    const tx = await usdc.approve(POOL_D_VAULT, AMOUNT);
    console.log("  approve tx:", tx.hash);
    await tx.wait();
  }

  console.log("\ndepositing $5 FLEX into Pool D v15.10...");
  const tx = await vault.deposit(AMOUNT, TIER_FLEX);
  console.log("  deposit tx:", tx.hash);
  const receipt = await tx.wait();

  const postId = await vault.nextPosId();
  const postSupply = await nft.totalSupply();
  const postAssets = await adapter.totalAssets();
  console.log("\nAFTER:");
  console.log("  vault.nextPosId:    ", postId.toString());
  console.log("  nft.totalSupply:    ", postSupply.toString());
  console.log("  adapter.totalAssets:", postAssets.toString());

  const mintedTokenId = postId - 1n;
  const owner = await nft.ownerOf(mintedTokenId);
  console.log(`  nft.ownerOf(${mintedTokenId}): ${owner}`);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`NFT owner mismatch: expected ${signer.address}, got ${owner}`);
  }

  console.log("\n✓ Pool D v15.10 deposit path clean. ERC721 collision fixed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
