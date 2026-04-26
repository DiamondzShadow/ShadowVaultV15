// ═══════════════════════════════════════════════════════════════════════
//  redeploy-pool-b.js — v15.2: replace Pool B with fresh vault + adapter + NFT
//
//  The old Pool B vault `0x68033...E0a9` has the v15.1 bug where
//  requestWithdraw orphans yield shares on Silo utilization caps. v15.2
//  adds a 95% recovery guard. This script deploys:
//    - new ShadowVaultV15 (with v15.2 code)
//    - new SiloAdapter    (fresh totalPrincipal = 0)
//    - new ShadowPositionNFTV15 (fresh nextTokenId = 1)
//  Wires everything, re-adds Pool B basket tokens, updates
//  config/deployed.json. Leaves the old vault in place so the orphaned
//  $3 smoke-test stake stays recoverable via admin.
//
//  Run:
//    npx hardhat run scripts/redeploy-pool-b.js --network arbitrum
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TREASURY = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const ZEROEX = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
const ONEINCH = "0x1111111254EEB25477B68fb85Ed929f73A960582";

const ARB_TOKENS = {
  WETH:   "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  USDC:   "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  LINK:   "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  GMX:    "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
  PENDLE: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
  XAUT0:  "0x40461291347e1eCbb09499F3371D3f17f10d7159",
};

const CHAINLINK_FEEDS = {
  ETH_USD:    "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  LINK_USD:   "0x86E53CF1B870786351Da77A57575e79CB55812CB",
  GMX_USD:    "0xDB98056FecFff59D032aB628337A4887110df3dB",
  PENDLE_USD: "0x66853E19d73c0F9301fe099c324A1E9726953433",
};

const STALENESS = { DEFAULT: 0, XAU_METALS: 259200 };

function section(t) { console.log("\n" + "═".repeat(64) + "\n  " + t + "\n" + "═".repeat(64)); }

async function deploy(name, args) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const a = await c.getAddress();
  console.log(`  ✓ ${name.padEnd(28)} ${a}`);
  return c;
}

async function tryAddBasket(vault, cfg) {
  try {
    if (cfg.feed !== hre.ethers.ZeroAddress) {
      const feed = await hre.ethers.getContractAt(
        ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
        cfg.feed,
      );
      const [, answer] = await feed.latestRoundData();
      if (answer <= 0n) {
        console.log(`  ⚠ SKIP ${cfg.sym} — feed returned non-positive price`);
        return false;
      }
    }
    await (await vault.addBasketToken(
      cfg.token, cfg.weightBps, cfg.feed, cfg.feedDec, cfg.tokDec, cfg.staleness,
    )).wait();
    console.log(`  • ${cfg.sym.padEnd(6)} @ ${(cfg.weightBps / 100).toFixed(2)}%${cfg.note ? " (" + cfg.note + ")" : ""}`);
    return true;
  } catch (e) {
    console.log(`  ⚠ SKIP ${cfg.sym} — ${e.message.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  section("v15.2 — Pool B redeploy (Arbitrum mainnet)");
  console.log("Signer:", signer.address);
  console.log("Old Pool B vault:", deployed.pools.B.vault);
  console.log("Balance:", hre.ethers.formatEther(await signer.provider.getBalance(signer.address)), "ETH");

  // ───── 1. Fresh contracts ─────
  section("1. Deploy new Pool B stack");
  const newSiloAdapter = await deploy("SiloAdapter", [signer.address]);
  const newNftB = await deploy("ShadowPositionNFTV15", ["DeFi + RWA", signer.address]);
  const newVaultB = await deploy("ShadowVaultV15", [
    signer.address,
    await newSiloAdapter.getAddress(),
    TREASURY,
    SDM_TOKEN,
  ]);

  // ───── 2. Wire roles ─────
  section("2. Wire roles");
  await (await newSiloAdapter.addVault(await newVaultB.getAddress())).wait();
  console.log("• siloAdapter ← VAULT_ROLE(newVaultB)");
  await (await newNftB.addVault(await newVaultB.getAddress())).wait();
  console.log("• nftB ← VAULT_ROLE(newVaultB)");
  await (await newVaultB.setPositionNFT(await newNftB.getAddress())).wait();
  console.log("• newVaultB.positionNFT set");

  const bonusAccAddr = deployed.core.bonusAccumulator;
  await (await newVaultB.setBonusAccumulator(bonusAccAddr)).wait();
  console.log("• newVaultB.bonusAccumulator set");
  await (await newNftB.setBonusAccumulator(bonusAccAddr)).wait();
  console.log("• nftB.bonusAccumulator set");

  const bonusAcc = await hre.ethers.getContractAt("BonusAccumulator", bonusAccAddr, signer);
  await (await bonusAcc.addVault(await newVaultB.getAddress())).wait();
  console.log("• bonusAccumulator ← VAULT_ROLE(newVaultB)");

  const revRouter = await hre.ethers.getContractAt("RevenueRouter", deployed.core.revenueRouter, signer);
  await (await revRouter.addAuthorized(await newVaultB.getAddress())).wait();
  console.log("• revenueRouter ← AUTHORIZED_ROLE(newVaultB)");

  // ───── 3. Trusted swap targets ─────
  section("3. Trusted swap targets");
  await (await newVaultB.setTrustedSwapTarget(ZEROEX, true)).wait();
  console.log("• 0x");
  await (await newVaultB.setTrustedSwapTarget(ONEINCH, true)).wait();
  console.log("• 1inch");

  // ───── 4. Basket tokens ─────
  section("4. Pool B basket tokens");
  const xauFeedAddr = deployed.oracles.xauUsdFeed;
  const basket = [
    { sym: "WETH",   token: ARB_TOKENS.WETH,   weightBps: 2500, feed: CHAINLINK_FEEDS.ETH_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "GMX",    token: ARB_TOKENS.GMX,    weightBps: 2000, feed: CHAINLINK_FEEDS.GMX_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PENDLE", token: ARB_TOKENS.PENDLE, weightBps: 2000, feed: CHAINLINK_FEEDS.PENDLE_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "LINK",   token: ARB_TOKENS.LINK,   weightBps: 1500, feed: CHAINLINK_FEEDS.LINK_USD,   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "XAUt0",  token: ARB_TOKENS.XAUT0,  weightBps: 1000, feed: xauFeedAddr,                feedDec: 8, tokDec: 6,  staleness: STALENESS.XAU_METALS, note: "Pyth 72h" },
    { sym: "USDC",   token: ARB_TOKENS.USDC,   weightBps: 1000, feed: hre.ethers.ZeroAddress,     feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT,   note: "stablecoin" },
  ];
  for (const c of basket) await tryAddBasket(newVaultB, c);

  // ───── 5. Update deployed.json ─────
  section("5. Update config/deployed.json");
  if (!deployed.pools.B_v1) {
    deployed.pools.B_v1 = { ...deployed.pools.B, note: "v15.1 — deprecated, keeps orphaned $3 Silo stake for admin rescue" };
  }
  deployed.pools.B = {
    label: "DeFi + RWA",
    vault: await newVaultB.getAddress(),
    positionNFT: await newNftB.getAddress(),
    yieldSource: "silo",
    adapter: await newSiloAdapter.getAddress(),
    version: "v15.2",
  };
  // Update the adapters.silo pointer to the new adapter too
  deployed.adapters.silo_v1 = deployed.adapters.silo;
  deployed.adapters.silo = await newSiloAdapter.getAddress();

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("  ✓ config/deployed.json updated");

  section("Pool B v15.2 redeploy complete");
  console.log("New vault:  ", await newVaultB.getAddress());
  console.log("New adapter:", await newSiloAdapter.getAddress());
  console.log("New NFT:    ", await newNftB.getAddress());
  console.log("⚠ Old vault + adapter + NFT stay on-chain for orphaned-$3 rescue.");
  console.log("⚠ v15.2 requestWithdraw now reverts with AdapterPartialWithdraw if Silo < 95% recovery.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
