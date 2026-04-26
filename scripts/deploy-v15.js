// ═══════════════════════════════════════════════════════════════════════
//  deploy-v15.js — ShadowVaultV15 Arbitrum deployment
//
//  Deploys the full V15 stack: 3 baskets × 3 yield sources.
//    Pool A (Blue Chip)   → AaveAdapterV5
//    Pool B (DeFi + RWA)  → PendleAdapter
//    Pool C (Full Spec.)  → FluidAdapter
//
//  Roles are granted to the DEPLOYER EOA only. The Gnosis Safe transfer
//  is a SEPARATE post-test script (transfer-admin-to-safe.js) that MUST
//  NOT run until every on-mainnet test passes and the user explicitly
//  gives the go-ahead.
//
//  Run:
//    DEPLOYER_KEY=0x... ARB_RPC=... npx hardhat run scripts/deploy-v15.js --network arbitrum
//
//  Output:
//    config/deployed.json — canonical source of truth for UI + keeper wiring
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Arbitrum constants ───────────
const TREASURY = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const DEPLOYER_EOA = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
const SDM_TOKEN = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";

// Existing V14 DODO seeder — reuse for the new RevenueRouter.
// If you don't have one, deploy a stub or set this to the treasury.
const EXISTING_SEEDER = TREASURY; // placeholder; replace if a real SDMDODOSeeder is deployed

// Swap aggregators to allowlist on each vault
const ZEROEX_EXCHANGE_PROXY = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
const ONEINCH_V5_ROUTER     = "0x1111111254EEB25477B68fb85Ed929f73A960582";
// Chainlink Arbitrum L2 sequencer uptime feed (official)
const ARB_SEQ_UPTIME        = "0xFdB631F5EE196F0ed6FAa767959853A9F217697D";

// Arbitrum token addresses — all verified native/canonical deployments
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

// Pyth Network on Arbitrum
const PYTH_ARBITRUM = "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C";
const PYTH_PRICE_IDS = {
  PEPE_USD: "0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4",
  XAU_USD:  "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
};

// Per-token oracle staleness overrides. 0 = default (3600s / 1h).
// XAU/USD on Pyth only publishes during NY metals market hours → use 72h to
// survive weekends + the daily 17:00–18:00 ET pause without the vault reverting.
const STALENESS = {
  DEFAULT: 0,          // 3600s
  XAU_METALS: 259200,  // 72 hours
};

// Arbitrum Chainlink USD feeds — verified live 2026-04-10
// All feeds have heartbeats < 24h and the vault's 1h staleness guard is safe.
// NOTE: XAU/USD (0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c) has a 24h
// heartbeat — too loose for the 1h on-chain guard, so XAUt0 is excluded
// until a per-token staleness config is added in v15.1.
// NOTE: PEPE has no Chainlink feed on Arbitrum at all — excluded.
const CHAINLINK_FEEDS = {
  ETH_USD:    "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  BTC_USD:    "0x6ce185860a4963106506C203335A2910413708e9",
  LINK_USD:   "0x86E53CF1B870786351Da77A57575e79CB55812CB",
  ARB_USD:    "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
  GMX_USD:    "0xDB98056FecFff59D032aB628337A4887110df3dB",
  PENDLE_USD: "0x66853E19d73c0F9301fe099c324A1E9726953433",
};

// Pool A — Blue Chip (WETH / WBTC / USDC)
const POOL_A_WEIGHTS = { WETH: 4500, WBTC: 3500, USDC: 2000 };

// Pool B — DeFi + RWA (WETH / GMX / PENDLE / LINK / XAUt0 / USDC)
// XAUt0 is the RWA slot, priced via Pyth with 72h staleness (metals hours).
const POOL_B_WEIGHTS = { WETH: 2500, GMX: 2000, PENDLE: 2000, LINK: 1500, XAUT0: 1000, USDC: 1000 };

// Pool C — Full Spectrum (WETH / WBTC / GMX / ARB / PENDLE / LINK / PEPE / USDC)
// PEPE gets 5% via Pyth Network oracle wrapper.
const POOL_C_WEIGHTS = { WETH: 2500, WBTC: 1500, GMX: 1500, ARB: 1500, PENDLE: 1000, LINK: 1000, PEPE: 500, USDC: 500 };

// ─────────── Helpers ───────────
function section(title) {
  console.log("\n" + "═".repeat(64));
  console.log("  " + title);
  console.log("═".repeat(64));
}

function step(msg) {
  console.log("• " + msg);
}

async function deploy(name, args = [], opts = {}) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args, opts);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ✓ ${name.padEnd(28)} ${addr}`);
  return c;
}

/// Wrap an addBasketToken call so a single failure (stale feed, bad address,
/// RPC hiccup) is logged and skipped rather than aborting the whole deploy.
/// Returns true on success, false on failure.
async function tryAddBasket(vault, poolLabel, cfg) {
  try {
    // Pre-flight: if the token uses a non-zero price feed, sanity-check that
    // it responds with a positive price. Catches dead Pyth feeds and misrouted
    // Chainlink addresses before the tx hits the chain.
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

    await (await vault.addBasketToken(
      cfg.token, cfg.weightBps, cfg.feed, cfg.feedDec, cfg.tokDec, cfg.staleness,
    )).wait();
    console.log(`  • ${cfg.sym.padEnd(6)} @ ${(cfg.weightBps / 100).toFixed(2)}%${cfg.note ? " (" + cfg.note + ")" : ""}`);
    return true;
  } catch (e) {
    console.log(`  ⚠ SKIP ${poolLabel}/${cfg.sym} — addBasketToken reverted: ${e.message.slice(0, 80)}`);
    return false;
  }
}

// ─────────── Main ───────────
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  section(`ShadowVaultV15 Deploy — ${network} (chainId ${chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  if (network === "arbitrum" && chainId !== 42161n) {
    throw new Error(`Expected chainId 42161, got ${chainId}`);
  }
  if (deployer.address.toLowerCase() !== DEPLOYER_EOA.toLowerCase()) {
    console.warn(`⚠ Deployer EOA mismatch. Expected ${DEPLOYER_EOA}, got ${deployer.address}. Continue? (CTRL+C to abort)`);
  }

  // ═════════ 1. Core infra ═════════
  section("1. Core infrastructure");
  const sdmOracle = await deploy("SDMDiscountOracle", [deployer.address, hre.ethers.parseUnits("10000", 18)]);
  const revenueRouter = await deploy("RevenueRouter", [deployer.address, EXISTING_SEEDER, TREASURY]);
  const bonusAcc = await deploy("BonusAccumulator", [deployer.address]);

  // ═════════ 2. Yield adapters ═════════
  section("2. Yield adapters");
  const aaveAdapter = await deploy("AaveAdapterV5", [deployer.address]);
  const fluidAdapter = await deploy("FluidAdapter", [deployer.address]);
  const siloAdapter = await deploy("SiloAdapter", [deployer.address]);
  // PendleAdapter is kept in the repo for future use but not deployed here —
  // USDC-PT markets on Arbitrum are too thin as of April 2026. Pool B uses Silo.

  // ═════════ 2b. Pyth price-feed wrappers ═════════
  section("2b. Pyth price feed wrappers");
  const pepeFeed = await deploy("PythFeed", [PYTH_ARBITRUM, PYTH_PRICE_IDS.PEPE_USD]);
  const xauFeed  = await deploy("PythFeed", [PYTH_ARBITRUM, PYTH_PRICE_IDS.XAU_USD]);

  // ═════════ 3. Position NFTs (one per pool) ═════════
  section("3. Position NFTs");
  const nftA = await deploy("ShadowPositionNFTV15", ["Blue Chip",    deployer.address]);
  const nftB = await deploy("ShadowPositionNFTV15", ["DeFi + RWA",   deployer.address]);
  const nftC = await deploy("ShadowPositionNFTV15", ["Full Spectrum",deployer.address]);

  // ═════════ 4. Vaults (one per basket) ═════════
  section("4. Vaults");
  const vaultA = await deploy("ShadowVaultV15", [
    deployer.address,
    await aaveAdapter.getAddress(),
    TREASURY,
    SDM_TOKEN,
    ARB_TOKENS.USDC,
    ARB_SEQ_UPTIME,
  ]);
  const vaultB = await deploy("ShadowVaultV15", [
    deployer.address,
    await siloAdapter.getAddress(),
    TREASURY,
    SDM_TOKEN,
    ARB_TOKENS.USDC,
    ARB_SEQ_UPTIME,
  ]);
  const vaultC = await deploy("ShadowVaultV15", [
    deployer.address,
    await fluidAdapter.getAddress(),
    TREASURY,
    SDM_TOKEN,
    ARB_TOKENS.USDC,
    ARB_SEQ_UPTIME,
  ]);

  // ═════════ 5. Wire roles ═════════
  section("5. Wire roles + addresses");

  // Adapters → grant VAULT_ROLE to their paired vault
  step("Granting VAULT_ROLE on adapters");
  await (await aaveAdapter.addVault(await vaultA.getAddress())).wait();
  await (await siloAdapter.addVault(await vaultB.getAddress())).wait();
  await (await fluidAdapter.addVault(await vaultC.getAddress())).wait();

  // NFTs → grant VAULT_ROLE to their paired vault
  step("Granting VAULT_ROLE on NFTs");
  await (await nftA.addVault(await vaultA.getAddress())).wait();
  await (await nftB.addVault(await vaultB.getAddress())).wait();
  await (await nftC.addVault(await vaultC.getAddress())).wait();

  // Vaults → set NFT address
  step("Setting positionNFT on vaults");
  await (await vaultA.setPositionNFT(await nftA.getAddress())).wait();
  await (await vaultB.setPositionNFT(await nftB.getAddress())).wait();
  await (await vaultC.setPositionNFT(await nftC.getAddress())).wait();

  // Vaults + NFTs → bonusAccumulator
  step("Wiring bonusAccumulator");
  const bonusAddr = await bonusAcc.getAddress();
  await (await vaultA.setBonusAccumulator(bonusAddr)).wait();
  await (await vaultB.setBonusAccumulator(bonusAddr)).wait();
  await (await vaultC.setBonusAccumulator(bonusAddr)).wait();
  await (await nftA.setBonusAccumulator(bonusAddr)).wait();
  await (await nftB.setBonusAccumulator(bonusAddr)).wait();
  await (await nftC.setBonusAccumulator(bonusAddr)).wait();

  // BonusAccumulator → grant VAULT_ROLE to each vault
  step("Granting VAULT_ROLE on BonusAccumulator");
  await (await bonusAcc.addVault(await vaultA.getAddress())).wait();
  await (await bonusAcc.addVault(await vaultB.getAddress())).wait();
  await (await bonusAcc.addVault(await vaultC.getAddress())).wait();

  // RevenueRouter → grant AUTHORIZED_ROLE to each vault
  step("Granting AUTHORIZED_ROLE on RevenueRouter");
  await (await revenueRouter.addAuthorized(await vaultA.getAddress())).wait();
  await (await revenueRouter.addAuthorized(await vaultB.getAddress())).wait();
  await (await revenueRouter.addAuthorized(await vaultC.getAddress())).wait();

  // Vaults → trusted swap targets (0x + 1inch)
  step("Setting trusted swap targets (0x + 1inch)");
  for (const v of [vaultA, vaultB, vaultC]) {
    await (await v.setTrustedSwapTarget(ZEROEX_EXCHANGE_PROXY, true)).wait();
    await (await v.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true)).wait();
  }

  // ═════════ 6. Seed basket configs (graceful, per-token try/catch) ═════════
  // Each addBasketToken is wrapped so a single failure (stale feed, bad address,
  // network hiccup) is logged and skipped rather than aborting the whole deploy.
  // If XAUt0's Pyth feed is stale at deploy time it gets dropped from Pool B
  // silently — admin can add it later via addBasketToken.

  const pepeFeedAddr = await pepeFeed.getAddress();
  const xauFeedAddr = await xauFeed.getAddress();

  section("6a. Pool A basket tokens (Blue Chip)");
  const poolABasket = [
    { sym: "WETH", token: ARB_TOKENS.WETH, weightBps: POOL_A_WEIGHTS.WETH, feed: CHAINLINK_FEEDS.ETH_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "WBTC", token: ARB_TOKENS.WBTC, weightBps: POOL_A_WEIGHTS.WBTC, feed: CHAINLINK_FEEDS.BTC_USD, feedDec: 8, tokDec: 8,  staleness: STALENESS.DEFAULT },
    { sym: "USDC", token: ARB_TOKENS.USDC, weightBps: POOL_A_WEIGHTS.USDC, feed: hre.ethers.ZeroAddress,  feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT, note: "stablecoin" },
  ];
  for (const c of poolABasket) await tryAddBasket(vaultA, "A", c);

  section("6b. Pool B basket tokens (DeFi + RWA — Silo yield)");
  const poolBBasket = [
    { sym: "WETH",   token: ARB_TOKENS.WETH,   weightBps: POOL_B_WEIGHTS.WETH,   feed: CHAINLINK_FEEDS.ETH_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "GMX",    token: ARB_TOKENS.GMX,    weightBps: POOL_B_WEIGHTS.GMX,    feed: CHAINLINK_FEEDS.GMX_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PENDLE", token: ARB_TOKENS.PENDLE, weightBps: POOL_B_WEIGHTS.PENDLE, feed: CHAINLINK_FEEDS.PENDLE_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "LINK",   token: ARB_TOKENS.LINK,   weightBps: POOL_B_WEIGHTS.LINK,   feed: CHAINLINK_FEEDS.LINK_USD,   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "XAUt0",  token: ARB_TOKENS.XAUT0,  weightBps: POOL_B_WEIGHTS.XAUT0,  feed: xauFeedAddr,                feedDec: 8, tokDec: 6,  staleness: STALENESS.XAU_METALS, note: "Pyth XAU/USD, 72h staleness" },
    { sym: "USDC",   token: ARB_TOKENS.USDC,   weightBps: POOL_B_WEIGHTS.USDC,   feed: hre.ethers.ZeroAddress,     feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT, note: "stablecoin" },
  ];
  for (const c of poolBBasket) await tryAddBasket(vaultB, "B", c);

  section("6c. Pool C basket tokens (Full Spectrum — Fluid yield)");
  const poolCBasket = [
    { sym: "WETH",   token: ARB_TOKENS.WETH,   weightBps: POOL_C_WEIGHTS.WETH,   feed: CHAINLINK_FEEDS.ETH_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "WBTC",   token: ARB_TOKENS.WBTC,   weightBps: POOL_C_WEIGHTS.WBTC,   feed: CHAINLINK_FEEDS.BTC_USD,    feedDec: 8, tokDec: 8,  staleness: STALENESS.DEFAULT },
    { sym: "GMX",    token: ARB_TOKENS.GMX,    weightBps: POOL_C_WEIGHTS.GMX,    feed: CHAINLINK_FEEDS.GMX_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "ARB",    token: ARB_TOKENS.ARB,    weightBps: POOL_C_WEIGHTS.ARB,    feed: CHAINLINK_FEEDS.ARB_USD,    feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PENDLE", token: ARB_TOKENS.PENDLE, weightBps: POOL_C_WEIGHTS.PENDLE, feed: CHAINLINK_FEEDS.PENDLE_USD, feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "LINK",   token: ARB_TOKENS.LINK,   weightBps: POOL_C_WEIGHTS.LINK,   feed: CHAINLINK_FEEDS.LINK_USD,   feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT },
    { sym: "PEPE",   token: ARB_TOKENS.PEPE,   weightBps: POOL_C_WEIGHTS.PEPE,   feed: pepeFeedAddr,               feedDec: 8, tokDec: 18, staleness: STALENESS.DEFAULT, note: "Pyth PEPE/USD" },
    { sym: "USDC",   token: ARB_TOKENS.USDC,   weightBps: POOL_C_WEIGHTS.USDC,   feed: hre.ethers.ZeroAddress,     feedDec: 0, tokDec: 6,  staleness: STALENESS.DEFAULT, note: "stablecoin" },
  ];
  for (const c of poolCBasket) await tryAddBasket(vaultC, "C", c);

  // ═════════ 7. Dump deployed addresses ═════════
  section("7. Writing config/deployed.json");
  const deployed = {
    version: "v15.0.0",
    network,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    admin: deployer.address, // NOT Gnosis Safe yet — transferred post-test
    treasury: TREASURY,
    sdmToken: SDM_TOKEN,
    core: {
      sdmDiscountOracle: await sdmOracle.getAddress(),
      revenueRouter:     await revenueRouter.getAddress(),
      bonusAccumulator:  await bonusAcc.getAddress(),
    },
    adapters: {
      aaveV5: await aaveAdapter.getAddress(),
      fluid:  await fluidAdapter.getAddress(),
      silo:   await siloAdapter.getAddress(),
    },
    oracles: {
      pythArbitrum: PYTH_ARBITRUM,
      pepeUsdFeed: await pepeFeed.getAddress(),
      xauUsdFeed:  await xauFeed.getAddress(),
    },
    pools: {
      A: {
        label: "Blue Chip",
        vault: await vaultA.getAddress(),
        positionNFT: await nftA.getAddress(),
        yieldSource: "aave",
        adapter: await aaveAdapter.getAddress(),
        basket: [
          { token: ARB_TOKENS.WETH, symbol: "WETH", weightBps: POOL_A_WEIGHTS.WETH, feed: CHAINLINK_FEEDS.ETH_USD },
          { token: ARB_TOKENS.WBTC, symbol: "WBTC", weightBps: POOL_A_WEIGHTS.WBTC, feed: CHAINLINK_FEEDS.BTC_USD },
          { token: ARB_TOKENS.USDC, symbol: "USDC", weightBps: POOL_A_WEIGHTS.USDC, feed: hre.ethers.ZeroAddress },
        ],
      },
      B: {
        label: "DeFi + RWA",
        vault: await vaultB.getAddress(),
        positionNFT: await nftB.getAddress(),
        yieldSource: "silo",
        adapter: await siloAdapter.getAddress(),
        basket: [
          { token: ARB_TOKENS.WETH,   symbol: "WETH",   weightBps: POOL_B_WEIGHTS.WETH,   feed: CHAINLINK_FEEDS.ETH_USD,        oracleType: "chainlink" },
          { token: ARB_TOKENS.GMX,    symbol: "GMX",    weightBps: POOL_B_WEIGHTS.GMX,    feed: CHAINLINK_FEEDS.GMX_USD,        oracleType: "chainlink" },
          { token: ARB_TOKENS.PENDLE, symbol: "PENDLE", weightBps: POOL_B_WEIGHTS.PENDLE, feed: CHAINLINK_FEEDS.PENDLE_USD,     oracleType: "chainlink" },
          { token: ARB_TOKENS.LINK,   symbol: "LINK",   weightBps: POOL_B_WEIGHTS.LINK,   feed: CHAINLINK_FEEDS.LINK_USD,       oracleType: "chainlink" },
          { token: ARB_TOKENS.XAUT0,  symbol: "XAUt0",  weightBps: POOL_B_WEIGHTS.XAUT0,  feed: await xauFeed.getAddress(),     oracleType: "pyth", staleness: STALENESS.XAU_METALS },
          { token: ARB_TOKENS.USDC,   symbol: "USDC",   weightBps: POOL_B_WEIGHTS.USDC,   feed: hre.ethers.ZeroAddress,         oracleType: "none" },
        ],
      },
      C: {
        label: "Full Spectrum",
        vault: await vaultC.getAddress(),
        positionNFT: await nftC.getAddress(),
        yieldSource: "fluid",
        adapter: await fluidAdapter.getAddress(),
        basket: [
          { token: ARB_TOKENS.WETH,   symbol: "WETH",   weightBps: POOL_C_WEIGHTS.WETH,   feed: CHAINLINK_FEEDS.ETH_USD,      oracleType: "chainlink" },
          { token: ARB_TOKENS.WBTC,   symbol: "WBTC",   weightBps: POOL_C_WEIGHTS.WBTC,   feed: CHAINLINK_FEEDS.BTC_USD,      oracleType: "chainlink" },
          { token: ARB_TOKENS.GMX,    symbol: "GMX",    weightBps: POOL_C_WEIGHTS.GMX,    feed: CHAINLINK_FEEDS.GMX_USD,      oracleType: "chainlink" },
          { token: ARB_TOKENS.ARB,    symbol: "ARB",    weightBps: POOL_C_WEIGHTS.ARB,    feed: CHAINLINK_FEEDS.ARB_USD,      oracleType: "chainlink" },
          { token: ARB_TOKENS.PENDLE, symbol: "PENDLE", weightBps: POOL_C_WEIGHTS.PENDLE, feed: CHAINLINK_FEEDS.PENDLE_USD,   oracleType: "chainlink" },
          { token: ARB_TOKENS.LINK,   symbol: "LINK",   weightBps: POOL_C_WEIGHTS.LINK,   feed: CHAINLINK_FEEDS.LINK_USD,     oracleType: "chainlink" },
          { token: ARB_TOKENS.PEPE,   symbol: "PEPE",   weightBps: POOL_C_WEIGHTS.PEPE,   feed: null /* set below */,         oracleType: "pyth" },
          { token: ARB_TOKENS.USDC,   symbol: "USDC",   weightBps: POOL_C_WEIGHTS.USDC,   feed: hre.ethers.ZeroAddress,       oracleType: "none" },
        ],
      },
    },
    swapTargets: {
      zeroEx: ZEROEX_EXCHANGE_PROXY,
      oneInchV5: ONEINCH_V5_ROUTER,
    },
    postDeployTodo: [
      "Verify each contract on Arbiscan via hardhat-verify",
      "Fund BonusAccumulator notifiers (BridgeFeeDAO etc.) via grantRole(NOTIFIER_ROLE)",
      "Run a $100 smoke deposit + withdraw on each pool to validate end-to-end",
      "Start the keeper via pm2 start ecosystem.keeper.config.cjs",
      "Transfer DEFAULT_ADMIN_ROLE to Gnosis Safe ONLY after all mainnet tests pass",
    ],
  };

  const cfgDir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "deployed.json"), JSON.stringify(deployed, null, 2));
  console.log("  ✓ config/deployed.json written");

  // ═════════ 8. Print verify commands ═════════
  section("8. Arbiscan verification commands");
  const pairs = [
    ["SDMDiscountOracle", await sdmOracle.getAddress(),   [deployer.address, hre.ethers.parseUnits("10000", 18).toString()]],
    ["RevenueRouter",     await revenueRouter.getAddress(),[deployer.address, EXISTING_SEEDER, TREASURY]],
    ["BonusAccumulator",  await bonusAcc.getAddress(),    [deployer.address]],
    ["AaveAdapterV5",     await aaveAdapter.getAddress(), [deployer.address]],
    ["FluidAdapter",      await fluidAdapter.getAddress(),[deployer.address]],
    ["SiloAdapter",       await siloAdapter.getAddress(), [deployer.address]],
    ["ShadowPositionNFTV15 (A)", await nftA.getAddress(), ['"Blue Chip"', deployer.address]],
    ["ShadowPositionNFTV15 (B)", await nftB.getAddress(), ['"DeFi + RWA"', deployer.address]],
    ["ShadowPositionNFTV15 (C)", await nftC.getAddress(), ['"Full Spectrum"', deployer.address]],
    ["ShadowVaultV15 (A)", await vaultA.getAddress(),     [deployer.address, await aaveAdapter.getAddress(), TREASURY, SDM_TOKEN]],
    ["ShadowVaultV15 (B)", await vaultB.getAddress(),     [deployer.address, await siloAdapter.getAddress(), TREASURY, SDM_TOKEN]],
    ["ShadowVaultV15 (C)", await vaultC.getAddress(),     [deployer.address, await fluidAdapter.getAddress(), TREASURY, SDM_TOKEN]],
  ];
  for (const [name, addr, args] of pairs) {
    console.log(`npx hardhat verify --network arbitrum ${addr} ${args.join(" ")}`);
  }

  section("Deploy complete");
  console.log("⚠ DEFAULT_ADMIN_ROLE is held by the deployer EOA only.");
  console.log("⚠ Do NOT transfer to Gnosis Safe until all on-mainnet tests pass.");
  console.log("⚠ Any basket tokens that failed pre-flight were skipped gracefully — check logs above.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
