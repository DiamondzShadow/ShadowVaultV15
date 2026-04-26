// ═══════════════════════════════════════════════════════════════════════
//  deploy-pool-e-hyperevm.js — ShadowVault Pool E (HyperCash) on HyperEVM
//
//  Deploys the Hyperliquid-native Pool E stack:
//    1. RevenueRouterHC  (SDM seeder = address(0) at launch; 100% → treasury)
//    2. HLPAdapterHC     (CoreWriter-based, no custody)
//    3. HyperSkin        (dynamic ShadowPass NFT)
//    4. ShadowVaultV15   (yield-only: basketBps=0, yieldBps=10000, seqUptime=0)
//
//  Then wires roles, registers the vault as strategy #0 ("HyperCash"), and
//  leaves the deployer with admin roles (user rotates to Gnosis Safe after
//  smoke-testing).
//
//  Usage:
//    DEPLOYER_KEY=0x... HYPEREVM_RPC=https://rpc.hyperliquid.xyz/evm \
//    TREASURY_SAFE_HC=0x... KEEPER_HC=0x... \
//    npx hardhat run scripts/deploy-pool-e-hyperevm.js --network hyperevm
//
//  Emits deployed addresses to `config/deployed-pool-e-hc.json`.
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const fs  = require("node:fs");
const path = require("node:path");

const HYPEREVM_MAINNET_USDC       = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const HYPEREVM_TESTNET_USDC       = "0x2B3370eE501B4a559b57D449569354196457D8Ab";
const HLP_VAULT_ADDR              = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

// Conservative initial caps — raise after 7 days of clean operation.
const INITIAL_PER_TX_CAP          = 500_000_000n;    // $500
const INITIAL_DAILY_CAP           = 2_000_000_000n;  // $2,000

function section(title) {
  console.log("\n" + "━".repeat(72) + "\n" + title + "\n" + "━".repeat(72));
}
function step(msg) { console.log(`\n→ ${msg}`); }

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name}: ${addr}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  const usdc =
    chainId === 999  ? HYPEREVM_MAINNET_USDC :
    chainId === 998  ? HYPEREVM_TESTNET_USDC :
    null;
  if (!usdc) throw new Error(`Unsupported chain ${chainId} — expected 998 or 999`);

  const treasury = process.env.TREASURY_SAFE_HC;
  const keeper   = process.env.KEEPER_HC;
  if (!treasury) throw new Error("TREASURY_SAFE_HC not set");
  if (!keeper)   throw new Error("KEEPER_HC not set");

  section(`Pool E Deploy — HyperEVM (chainId ${chainId})`);
  console.log("Deployer :", deployer.address);
  console.log("Treasury :", treasury);
  console.log("Keeper   :", keeper);
  console.log("USDC     :", usdc);
  console.log("HLP vault:", HLP_VAULT_ADDR);
  console.log("HYPE bal :", hre.ethers.formatEther(
    await hre.ethers.provider.getBalance(deployer.address)));

  // ═════════ 1. RevenueRouterHC ═════════
  step("1. RevenueRouterHC");
  const router = await deploy("RevenueRouterHC", [
    deployer.address, usdc, hre.ethers.ZeroAddress, treasury,
  ]);

  // ═════════ 2. HLPAdapterHC ═════════
  step("2. HLPAdapterHC");
  const adapter = await deploy("HLPAdapterHC", [
    deployer.address, keeper, usdc, HLP_VAULT_ADDR,
  ]);
  await (await adapter.setDepositLimits(INITIAL_PER_TX_CAP, INITIAL_DAILY_CAP)).wait();
  console.log(`  caps: ${INITIAL_PER_TX_CAP} / ${INITIAL_DAILY_CAP}`);

  // ═════════ 3. HyperSkin ═════════
  step("3. HyperSkin NFT");
  const skin = await deploy("HyperSkin", [
    "HyperCash", deployer.address,
  ]);

  // ═════════ 4. ShadowVaultV15 (Pool E) ═════════
  step("4. ShadowVaultV15 (Pool E — HyperCash)");
  const vault = await deploy("ShadowVaultV15", [
    deployer.address,
    await adapter.getAddress(),
    treasury,
    hre.ethers.ZeroAddress,   // sdmToken — not on HyperEVM at launch
    usdc,
    hre.ethers.ZeroAddress,   // SEQ_UPTIME — no sequencer on HyperEVM
  ]);

  // ═════════ 5. Wire roles ═════════
  section("5. Wire roles");
  step("adapter → grant VAULT_ROLE to vault");
  await (await adapter.addVault(await vault.getAddress())).wait();

  step("skin → register strategy #0 (HyperCash) + grant VAULT_ROLE to vault");
  await (await skin.registerStrategy("HyperCash", await vault.getAddress())).wait();

  step("vault → set positionNFT to skin");
  await (await vault.setPositionNFT(await skin.getAddress())).wait();

  step("vault → set allocation to 100% yield (basket=0, yield=10000)");
  await (await vault.setAllocation(0, 10_000)).wait();

  step("router → authorize vault");
  await (await router.addAuthorized(await vault.getAddress())).wait();

  step("skin → set fee routes (treasury + router)");
  await (await skin.setFeeRoutes(treasury, await router.getAddress())).wait();

  // ═════════ 6. Whitelist deployer ═════════
  section("6. Whitelist deployer");
  // Optional helper if the vault exposes setWhitelist — try/catch so this
  // deploy script remains compatible with vaults that don't.
  try {
    await (await vault.setWhitelistEnabled(true)).wait();
    await (await vault.setWhitelist(deployer.address, true)).wait();
    console.log("  whitelist ON, deployer whitelisted");
  } catch (e) {
    console.log("  skip whitelist wiring —", e.shortMessage || e.message);
  }

  // ═════════ 7. Persist ═════════
  section("7. Save addresses");
  const out = {
    chainId,
    usdc,
    hlpVault: HLP_VAULT_ADDR,
    revenueRouter: await router.getAddress(),
    adapter:  await adapter.getAddress(),
    skin:     await skin.getAddress(),
    vault:    await vault.getAddress(),
    deployer: deployer.address,
    treasury,
    keeper,
    caps: {
      perTx: INITIAL_PER_TX_CAP.toString(),
      daily: INITIAL_DAILY_CAP.toString(),
    },
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const outfile = path.join(dir, "deployed-pool-e-hc.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outfile}`);

  // ═════════ 8. Next steps ═════════
  section("Next steps");
  console.log("1. Run admin round-trip test: adapter.verifyRoute(1_000_000)");
  console.log("   (requires deployer to hold 1 USDC on HyperEVM)");
  console.log("2. Fund keeper EOA with ~0.5 HYPE for nudge gas");
  console.log("3. Seed 5 USDC to vault.deposit(5_000_000, 0) as smoke test");
  console.log("4. Boot keeper: pm2 start keeper/hlp-hc-keeper.js --name hlp-hc-keeper --cron '0 */3 * * *'");
  console.log("5. After 7 days clean, raise caps via adapter.setDepositLimits(10_000e6, 50_000e6)");
  console.log("6. Transfer admin to Gnosis Safe, renounce deployer");
}

main().catch((e) => { console.error(e); process.exit(1); });
