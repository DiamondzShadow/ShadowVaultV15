// Continuation of Pool D deploy after the uint32 ABI bug.
// Uses the correct addBasketToken signature and persists deployed.json.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOL_D_VAULT    = "0x38002195F17cE193c8E69690f4B6F4757c202078";
const POOL_D_NFT      = "0x26DF3059E40A384e16393CA9C55353249317Ab86";
const PENDLE_ADAPTER  = "0xed05AfD6E4D901fd9689E1E90B97b7cfFe1872b9";

const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const BTC_USD_FEED = "0x6ce185860a4963106506C203335A2910413708e9";
const ZERO_FEED    = "0x0000000000000000000000000000000000000000";

// Correct ABI — uint32 maxStalenessSecs (was uint256 in the broken deploy)
const VAULT_ABI = [
  "function addBasketToken(address token, uint256 weightBps, address priceFeed, uint8 feedDecimals, uint8 tokenDecimals, uint32 maxStalenessSecs) external",
  "function basketLength() view returns (uint256)",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const vault = new ethers.Contract(POOL_D_VAULT, VAULT_ABI, signer);

  console.log("\n── Adding basket tokens with corrected uint32 signature ──");

  let tx;
  console.log("  addBasketToken(WETH, 4000, ETH/USD)");
  tx = await vault.addBasketToken(WETH, 4000, ETH_USD_FEED, 8, 18, 0);
  console.log("  tx:", tx.hash);
  await tx.wait();

  console.log("  addBasketToken(WBTC, 3000, BTC/USD)");
  tx = await vault.addBasketToken(WBTC, 3000, BTC_USD_FEED, 8, 8, 0);
  console.log("  tx:", tx.hash);
  await tx.wait();

  console.log("  addBasketToken(USDC, 3000, $1 fallback)");
  tx = await vault.addBasketToken(USDC, 3000, ZERO_FEED, 0, 6, 0);
  console.log("  tx:", tx.hash);
  await tx.wait();

  console.log("\n── Sanity reads ──");
  console.log("  yieldAdapter: ", await vault.yieldAdapter());
  console.log("  positionNFT:  ", await vault.positionNFT());
  console.log("  bonusAcc:     ", await vault.bonusAccumulator());
  console.log("  basketLength: ", (await vault.basketLength()).toString());

  console.log("\n── Persisting to deployed.json ──");
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  deployed.pools.D = {
    label: "Pendle Fixed Yield",
    vault: POOL_D_VAULT,
    positionNFT: POOL_D_NFT,
    yieldSource: "pendle",
    adapter: PENDLE_ADAPTER,
    version: "v15.4",
    pendleMarket: PENDLE_MARKET,
    pendlePt:     PENDLE_PT,
    pendleYt:     PENDLE_YT,
    pendleSy:     PENDLE_SY,
    pendleMaturity: "2026-06-25T00:00:00Z",
  };
  deployed.adapters = deployed.adapters || {};
  deployed.adapters.pendle = PENDLE_ADAPTER;
  deployed.v15_4AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated.");

  console.log("\n═══ Pool D fully wired ═══");
  console.log("  PendleAdapter: ", PENDLE_ADAPTER);
  console.log("  Pool D vault:  ", POOL_D_VAULT);
  console.log("  Pool D NFT:    ", POOL_D_NFT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
