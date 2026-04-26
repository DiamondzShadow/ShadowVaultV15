// Continue Pool A v2 wiring after nonce-too-low crashed mid-deploy.
// Read current state, skip anything already set, add missing pieces.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ADAPTER = "0xcaFA32da87a77598624675fcc68A00c2C3583D31";
const VAULT   = "0x183f97fE454E9df27A884ABBF094a1729D1BCb0f";
const NFT     = "0xB914792b4c2f8fbaE8A490b83102EC9F5A2e3720";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const BTC_USD_FEED = "0x6ce185860a4963106506C203335A2910413708e9";
const ZERO_FEED    = "0x0000000000000000000000000000000000000000";

const VAULT_ABI = [
  "function basketLength() view returns (uint256)",
  "function bonusAccumulator() view returns (address)",
  "function positionNFT() view returns (address)",
  "function trustedSwapTargets(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function grantRole(bytes32,address) external",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const vault = new ethers.Contract(VAULT, VAULT_ABI, signer);
  console.log("signer:", signer.address);

  // Check current state and only do what's missing
  console.log("\ncurrent state:");
  console.log("  basketLength:", (await vault.basketLength()).toString());
  console.log("  bonusAcc:    ", await vault.bonusAccumulator());
  console.log("  nft:         ", await vault.positionNFT());
  const trustHolder = await vault.trustedSwapTargets(ZEROX_V2_ALLOWANCE_HOLDER);
  const trustOneInch = await vault.trustedSwapTargets(ONEINCH_V5_ROUTER);
  console.log("  trust 0xAH:  ", trustHolder);
  console.log("  trust 1inch: ", trustOneInch);

  const keeperRole = ethers.id("KEEPER_ROLE");
  const hasKeeper = await vault.hasRole(keeperRole, signer.address);
  console.log("  deployer has KEEPER:", hasKeeper);

  let tx;
  if (!trustHolder) {
    console.log("\nsetting 0xAllowanceHolder");
    tx = await vault.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
    console.log(" tx:", tx.hash); await tx.wait();
  }
  if (!trustOneInch) {
    console.log("setting 1inch");
    tx = await vault.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
    console.log(" tx:", tx.hash); await tx.wait();
  }
  if (!hasKeeper) {
    console.log("granting KEEPER_ROLE");
    tx = await vault.grantRole(keeperRole, signer.address);
    console.log(" tx:", tx.hash); await tx.wait();
  }

  const bl = Number(await vault.basketLength());
  if (bl < 3) {
    console.log(`\nadding basket tokens from index ${bl}`);
    const cfgs = [
      [WETH, 4500, ETH_USD_FEED, 8, 18, 0],
      [WBTC, 3500, BTC_USD_FEED, 8, 8, 0],
      [USDC, 2000, ZERO_FEED, 0, 6, 0],
    ];
    for (let i = bl; i < 3; i++) {
      tx = await vault.addBasketToken(...cfgs[i]);
      console.log(`  [${i}] ${["WETH","WBTC","USDC"][i]}:`, tx.hash); await tx.wait();
    }
  }

  console.log("\nfinal basketLength:", (await vault.basketLength()).toString());

  // Persist
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  if (deployed.pools.A && deployed.pools.A.yieldSource === "aave") {
    deployed.pools.A_aave_deprecated = { ...deployed.pools.A, note: "v15.2 Blue Chip Aave — superseded by Pool A v2 Pendle 2026-04-11" };
  }
  deployed.pools.A = {
    label: "Blue Chip Pendle",
    vault: VAULT,
    positionNFT: NFT,
    yieldSource: "pendle",
    adapter: ADAPTER,
    version: "v15.4-a2",
    pendleMarket: "0x0934E592cEe932b04B3967162b3CD6c85748C470",
    pendlePt: "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84",
    pendleYt: "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8",
    pendleSy: "0x0a9eD458E6c283D1E84237e3347333Aa08221d09",
    ptDecimals: 6,
    ptScale: "1000000000000000000",
    pendleMaturity: "2026-06-25T00:00:00Z",
    basket: "WETH 45 / WBTC 35 / USDC 20",
  };
  deployed.adapters.pendle_a = ADAPTER;
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\n═══ Pool A v2 Pendle complete ═══");
  console.log("  vault:", VAULT, "adapter:", ADAPTER);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
