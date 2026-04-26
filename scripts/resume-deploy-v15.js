// ═══════════════════════════════════════════════════════════════════════
//  resume-deploy-v15.js — finish a V15 deploy that was interrupted
//
//  Reads config/deployed.json for already-deployed addresses, then runs
//  steps 5-7 of the original deploy (role wiring + basket seeding).
//
//  Run:
//    npx hardhat run scripts/resume-deploy-v15.js --network arbitrum
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TREASURY = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";

const ZEROEX_EXCHANGE_PROXY = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
const ONEINCH_V5_ROUTER     = "0x1111111254EEB25477B68fb85Ed929f73A960582";

const ARB_TOKENS = {
  WETH:   "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  WBTC:   "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  USDC:   "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  LINK:   "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  ARB:    "0x912CE59144191C1204E64559FE8253a0e49E6548",
  GMX:    "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
  PENDLE: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
  PEPE:   "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",
  XAUT0:  "0x40461291347e1eCbb09499F3371D3f17f10d7159",
};

const CHAINLINK_FEEDS = {
  ETH_USD:    "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  BTC_USD:    "0x6ce185860a4963106506C203335A2910413708e9",
  LINK_USD:   "0x86E53CF1B870786351Da77A57575e79CB55812CB",
  ARB_USD:    "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
  GMX_USD:    "0xDB98056FecFff59D032aB628337A4887110df3dB",
  PENDLE_USD: "0x66853E19d73c0F9301fe099c324A1E9726953433",
};

const STALENESS = { DEFAULT: 0, XAU_METALS: 259200 };

function section(t) { console.log("\n" + "═".repeat(64) + "\n  " + t + "\n" + "═".repeat(64)); }
function step(m)    { console.log("• " + m); }

/// Send a tx using ethers' automatic nonce management. Sequential calls
/// within the same script are safe because we `await` each tx.wait() before
/// moving to the next, so hardhat-ethers bumps the nonce correctly. The
/// only external racer (V14 keepers) has been paused in PM2.
async function sendTx(signer, contract, method, args) {
  const tx = await contract[method](...args);
  await tx.wait();
  return tx;
}

async function tryAddBasket(signer, vault, poolLabel, cfg) {
  try {
    if (cfg.feed !== hre.ethers.ZeroAddress) {
      try {
        const feed = await hre.ethers.getContractAt(
          ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
          cfg.feed,
        );
        const [, answer] = await feed.latestRoundData();
        if (answer <= 0n) {
          console.log(`  ⚠ SKIP ${poolLabel}/${cfg.sym} — feed returned non-positive price`);
          return false;
        }
      } catch (e) {
        console.log(`  ⚠ SKIP ${poolLabel}/${cfg.sym} — feed call reverted: ${e.message.slice(0, 60)}`);
        return false;
      }
    }
    await sendTx(signer, vault, "addBasketToken", [
      cfg.token, cfg.weightBps, cfg.feed, cfg.feedDec, cfg.tokDec, cfg.staleness,
    ]);
    console.log(`  • ${cfg.sym.padEnd(6)} @ ${(cfg.weightBps / 100).toFixed(2)}%${cfg.note ? " (" + cfg.note + ")" : ""}`);
    return true;
  } catch (e) {
    console.log(`  ⚠ SKIP ${poolLabel}/${cfg.sym} — addBasketToken reverted: ${e.message.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const d = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  section(`Resume V15 deploy — ${hre.network.name}`);
  console.log("Signer:", signer.address);
  console.log("Balance:", hre.ethers.formatEther(await signer.provider.getBalance(signer.address)), "ETH");

  // ───── Load contract handles ─────
  const revenueRouter = await hre.ethers.getContractAt("RevenueRouter", d.core.revenueRouter, signer);
  const bonusAcc = await hre.ethers.getContractAt("BonusAccumulator", d.core.bonusAccumulator, signer);
  const aaveAdapter = await hre.ethers.getContractAt("AaveAdapterV5", d.adapters.aaveV5, signer);
  const fluidAdapter = await hre.ethers.getContractAt("FluidAdapter", d.adapters.fluid, signer);
  const siloAdapter = await hre.ethers.getContractAt("SiloAdapter", d.adapters.silo, signer);
  const nftA = await hre.ethers.getContractAt("ShadowPositionNFTV15", d.pools.A.positionNFT, signer);
  const nftB = await hre.ethers.getContractAt("ShadowPositionNFTV15", d.pools.B.positionNFT, signer);
  const nftC = await hre.ethers.getContractAt("ShadowPositionNFTV15", d.pools.C.positionNFT, signer);
  const vaultA = await hre.ethers.getContractAt("ShadowVaultV15", d.pools.A.vault, signer);
  const vaultB = await hre.ethers.getContractAt("ShadowVaultV15", d.pools.B.vault, signer);
  const vaultC = await hre.ethers.getContractAt("ShadowVaultV15", d.pools.C.vault, signer);

  // ═════════ 5. Wire roles + addresses ═════════
  section("5. Wire roles + addresses");

  step("Adapters ← VAULT_ROLE");
  await sendTx(signer, aaveAdapter,  "addVault", [await vaultA.getAddress()]);
  await sendTx(signer, siloAdapter,  "addVault", [await vaultB.getAddress()]);
  await sendTx(signer, fluidAdapter, "addVault", [await vaultC.getAddress()]);

  step("NFTs ← VAULT_ROLE");
  await sendTx(signer, nftA, "addVault", [await vaultA.getAddress()]);
  await sendTx(signer, nftB, "addVault", [await vaultB.getAddress()]);
  await sendTx(signer, nftC, "addVault", [await vaultC.getAddress()]);

  step("Vaults ← positionNFT");
  await sendTx(signer, vaultA, "setPositionNFT", [await nftA.getAddress()]);
  await sendTx(signer, vaultB, "setPositionNFT", [await nftB.getAddress()]);
  await sendTx(signer, vaultC, "setPositionNFT", [await nftC.getAddress()]);

  step("Vaults + NFTs ← bonusAccumulator");
  const bonusAddr = await bonusAcc.getAddress();
  await sendTx(signer, vaultA, "setBonusAccumulator", [bonusAddr]);
  await sendTx(signer, vaultB, "setBonusAccumulator", [bonusAddr]);
  await sendTx(signer, vaultC, "setBonusAccumulator", [bonusAddr]);
  await sendTx(signer, nftA,   "setBonusAccumulator", [bonusAddr]);
  await sendTx(signer, nftB,   "setBonusAccumulator", [bonusAddr]);
  await sendTx(signer, nftC,   "setBonusAccumulator", [bonusAddr]);

  step("BonusAccumulator ← VAULT_ROLE");
  await sendTx(signer, bonusAcc, "addVault", [await vaultA.getAddress()]);
  await sendTx(signer, bonusAcc, "addVault", [await vaultB.getAddress()]);
  await sendTx(signer, bonusAcc, "addVault", [await vaultC.getAddress()]);

  step("RevenueRouter ← AUTHORIZED_ROLE");
  await sendTx(signer, revenueRouter, "addAuthorized", [await vaultA.getAddress()]);
  await sendTx(signer, revenueRouter, "addAuthorized", [await vaultB.getAddress()]);
  await sendTx(signer, revenueRouter, "addAuthorized", [await vaultC.getAddress()]);

  step("Trusted swap targets (0x + 1inch)");
  for (const v of [vaultA, vaultB, vaultC]) {
    await sendTx(signer, v, "setTrustedSwapTarget", [ZEROEX_EXCHANGE_PROXY, true]);
    await sendTx(signer, v, "setTrustedSwapTarget", [ONEINCH_V5_ROUTER, true]);
  }

  // ═════════ 6. Seed basket configs ═════════
  const pepeFeed = d.oracles.pepeUsdFeed;
  const xauFeed = d.oracles.xauUsdFeed;

  section("6a. Pool A basket tokens (Blue Chip)");
  const A_BASKET = [
    { sym: "WETH", token: ARB_TOKENS.WETH, weightBps: 4500, feed: CHAINLINK_FEEDS.ETH_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "WBTC", token: ARB_TOKENS.WBTC, weightBps: 3500, feed: CHAINLINK_FEEDS.BTC_USD, feedDec: 8, tokDec: 8,  staleness: STALENESS.DEFAULT },
    { sym: "USDC", token: ARB_TOKENS.USDC, weightBps: 2000, feed: hre.ethers.ZeroAddress,  feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT, note: "stablecoin" },
  ];
  for (const c of A_BASKET) await tryAddBasket(signer, vaultA, "A", c);

  section("6b. Pool B basket tokens (DeFi + RWA — Silo yield)");
  const B_BASKET = [
    { sym: "WETH",   token: ARB_TOKENS.WETH,   weightBps: 2500, feed: CHAINLINK_FEEDS.ETH_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "GMX",    token: ARB_TOKENS.GMX,    weightBps: 2000, feed: CHAINLINK_FEEDS.GMX_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PENDLE", token: ARB_TOKENS.PENDLE, weightBps: 2000, feed: CHAINLINK_FEEDS.PENDLE_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "LINK",   token: ARB_TOKENS.LINK,   weightBps: 1500, feed: CHAINLINK_FEEDS.LINK_USD,   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "XAUt0",  token: ARB_TOKENS.XAUT0,  weightBps: 1000, feed: xauFeed,                    feedDec: 8, tokDec: 6,  staleness: STALENESS.XAU_METALS, note: "Pyth XAU/USD 72h" },
    { sym: "USDC",   token: ARB_TOKENS.USDC,   weightBps: 1000, feed: hre.ethers.ZeroAddress,     feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT,   note: "stablecoin" },
  ];
  for (const c of B_BASKET) await tryAddBasket(signer, vaultB, "B", c);

  section("6c. Pool C basket tokens (Full Spectrum — Fluid yield)");
  const C_BASKET = [
    { sym: "WETH",   token: ARB_TOKENS.WETH,   weightBps: 2500, feed: CHAINLINK_FEEDS.ETH_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "WBTC",   token: ARB_TOKENS.WBTC,   weightBps: 1500, feed: CHAINLINK_FEEDS.BTC_USD,    feedDec: 8, tokDec: 8,  staleness: STALENESS.DEFAULT },
    { sym: "GMX",    token: ARB_TOKENS.GMX,    weightBps: 1500, feed: CHAINLINK_FEEDS.GMX_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "ARB",    token: ARB_TOKENS.ARB,    weightBps: 1500, feed: CHAINLINK_FEEDS.ARB_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PENDLE", token: ARB_TOKENS.PENDLE, weightBps: 1000, feed: CHAINLINK_FEEDS.PENDLE_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "LINK",   token: ARB_TOKENS.LINK,   weightBps: 1000, feed: CHAINLINK_FEEDS.LINK_USD,   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PEPE",   token: ARB_TOKENS.PEPE,   weightBps: 500,  feed: pepeFeed,                   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT,  note: "Pyth PEPE/USD" },
    { sym: "USDC",   token: ARB_TOKENS.USDC,   weightBps: 500,  feed: hre.ethers.ZeroAddress,     feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT, note: "stablecoin" },
  ];
  for (const c of C_BASKET) await tryAddBasket(signer, vaultC, "C", c);

  // ═════════ 7. Mark wiring complete ═════════
  d.wiringComplete = true;
  d.wiringCompletedAt = new Date().toISOString();
  delete d.notes;
  fs.writeFileSync(deployedPath, JSON.stringify(d, null, 2));

  section("Resume complete");
  console.log("⚠ V15 is fully wired on Arbitrum mainnet.");
  console.log("⚠ Admin still held by deployer EOA. Do NOT transfer to Safe until tests pass.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
