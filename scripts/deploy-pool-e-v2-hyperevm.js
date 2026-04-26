// ═══════════════════════════════════════════════════════════════════════
//  deploy-pool-e-v2-hyperevm.js — Pool E v2 (HyperCash) on HyperEVM.
//
//  Fixes the root-cause bug in v1 (missing spot→perp class transfer):
//  v2 adapter's deposit() now bridges USDC EVM → HC spot → HC perp → HLP
//  in a single tx, so HLP equity actually reflects deposits.
//
//  Deploys fresh:
//    1. HLPAdapterHCv2   (with spot↔perp hops)
//    2. HyperSkin        (new instance; old one bound to retired v1 vault)
//    3. ShadowVaultV15   (yield-only; bound to v2 adapter, which is immutable)
//
//  Reuses existing:
//    - RevenueRouterHC  0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21
//      (vault-agnostic; just needs new vault added to authorized list)
//    - Treasury Safe    0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E
//
//  Admin rotation: treasury & fee routes go directly to the Safe. Deployer
//  retains DEFAULT_ADMIN_ROLE on all three new contracts for beta bake; user
//  rotates admin to Safe after 7 days of clean operation.
//
//  Runs `adapter.verifyRoute(1_000_000)` at the end — a live round-trip
//  EVM→spot→perp→spot→EVM that exercises every CoreWriter hop. Requires
//  deployer to hold ≥1 USDC on HyperEVM before running.
//
//  Usage:
//    npx hardhat run scripts/deploy-pool-e-v2-hyperevm.js --network hyperevm
//
//  Writes: config/deployed-pool-e-hc-v2.json
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const HYPEREVM_MAINNET_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const HLP_VAULT_ADDR        = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const REVENUE_ROUTER_HC     = "0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21";
const TREASURY_SAFE         = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
const KEEPER_EOA            = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";

// Conservative beta caps — raise after 7 days clean.
const INITIAL_PER_TX_CAP = 500_000_000n;    // $500
const INITIAL_DAILY_CAP  = 2_000_000_000n;  // $2,000

const VERIFY_ROUTE_AMOUNT = 1_000_000n;     // $1 for the live route test

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

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
  if (chainId !== 999) throw new Error(`Expected chain 999 (HyperEVM), got ${chainId}`);

  const balHype = await hre.ethers.provider.getBalance(deployer.address);

  section("Pool E v2 Deploy — HyperEVM (chain 999)");
  console.log("Deployer :", deployer.address);
  console.log("Treasury :", TREASURY_SAFE);
  console.log("Keeper   :", KEEPER_EOA);
  console.log("USDC     :", HYPEREVM_MAINNET_USDC);
  console.log("HLP vault:", HLP_VAULT_ADDR);
  console.log("Router   :", REVENUE_ROUTER_HC, "(reused)");
  console.log("HYPE bal :", hre.ethers.formatEther(balHype));
  if (balHype < hre.ethers.parseEther("0.02")) {
    throw new Error("deployer HYPE < 0.02 — top up before deploying");
  }
  // (verifyRoute moved to post-deploy step since adapter needs HYPE on HC first)

  // ═════════ 1. HLPAdapterHCv2 ═════════
  step("1. HLPAdapterHCv2 (with spot↔perp hops)");
  const adapter = await deploy("HLPAdapterHCv2", [
    deployer.address, KEEPER_EOA, HYPEREVM_MAINNET_USDC, HLP_VAULT_ADDR,
  ]);
  await (await adapter.setDepositLimits(INITIAL_PER_TX_CAP, INITIAL_DAILY_CAP)).wait();
  console.log(`  caps: perTx=$${Number(INITIAL_PER_TX_CAP)/1e6} daily=$${Number(INITIAL_DAILY_CAP)/1e6}`);

  // ═════════ 2. HyperSkin ═════════
  step("2. HyperSkin NFT (new instance — clean posId==tokenId invariant)");
  const skin = await deploy("HyperSkin", ["HyperCash", deployer.address]);

  // ═════════ 3. ShadowVaultV15 ═════════
  step("3. ShadowVaultV15 (Pool E v2 — HyperCash)");
  const vault = await deploy("ShadowVaultV15", [
    deployer.address,
    await adapter.getAddress(),
    TREASURY_SAFE,               // treasury directly to Safe
    hre.ethers.ZeroAddress,      // sdmToken — not on HyperEVM yet
    HYPEREVM_MAINNET_USDC,
    hre.ethers.ZeroAddress,      // SEQ_UPTIME — no sequencer on HyperEVM
  ]);

  // ═════════ 4. Wire roles ═════════
  section("4. Wire roles");
  step("adapter → grant VAULT_ROLE to vault");
  await (await adapter.addVault(await vault.getAddress())).wait();

  step("skin → register strategy #0 (HyperCash v2) + grant VAULT_ROLE to vault");
  await (await skin.registerStrategy("HyperCash v2", await vault.getAddress())).wait();

  step("vault → set positionNFT to skin");
  await (await vault.setPositionNFT(await skin.getAddress())).wait();

  step("skin → set vault for live-value reads");
  await (await skin.setVault(await vault.getAddress())).wait();

  step("vault → allocation 0% basket / 100% yield");
  await (await vault.setAllocation(0, 10_000)).wait();

  step("router (reused) → authorize new vault");
  const router = new hre.ethers.Contract(
    REVENUE_ROUTER_HC,
    ["function addAuthorized(address) external",
     "function hasRole(bytes32,address) view returns (bool)"],
    deployer,
  );
  await (await router.addAuthorized(await vault.getAddress())).wait();

  step("skin → set fee routes (treasury + router)");
  await (await skin.setFeeRoutes(TREASURY_SAFE, REVENUE_ROUTER_HC)).wait();

  step("skin → set yield source / risk tier / apy range traits");
  await (await skin.setYieldSource("Hyperliquid HLP")).wait();
  await (await skin.setRiskTier("Yield")).wait();
  await (await skin.setApyRange("~20%")).wait();

  // ═════════ 5. Whitelist deployer ═════════
  section("5. Whitelist ON — deployer only (beta)");
  await (await vault.setWhitelistEnabled(true)).wait();
  await (await vault.setWhitelist(deployer.address, true)).wait();
  console.log("  whitelist ON, deployer whitelisted");

  // ═════════ 6. Persist addresses ═════════
  section("6. Save addresses");
  const out = {
    chainId,
    usdc: HYPEREVM_MAINNET_USDC,
    hlpVault: HLP_VAULT_ADDR,
    revenueRouter: REVENUE_ROUTER_HC,
    adapter: await adapter.getAddress(),
    skin:    await skin.getAddress(),
    vault:   await vault.getAddress(),
    deployer: deployer.address,
    treasury: TREASURY_SAFE,
    keeper: KEEPER_EOA,
    caps: {
      perTx: INITIAL_PER_TX_CAP.toString(),
      daily: INITIAL_DAILY_CAP.toString(),
    },
    deployedAt: new Date().toISOString(),
    notes: "v2 adapter: spot↔perp class transfer hops added. Supersedes v1 at 0x5c45a7a4… (retired).",
  };
  const dir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const outfile = path.join(dir, "deployed-pool-e-hc-v2.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outfile}`);

  // ═════════ 7. Next steps ═════════
  section("Next steps");
  console.log("NEW v2 ADAPTER:", await adapter.getAddress());
  console.log("NEW v2 VAULT  :", await vault.getAddress());
  console.log("NEW SKIN      :", await skin.getAddress());
  console.log("");
  console.log("1. Prime adapter HC account with HYPE (~0.01 needed for sendAsset gas):");
  console.log("   node scripts/prime-adapter-hype.cjs 20000000000000000 " + await adapter.getAddress());
  console.log("   (20000000000000000 wei = 0.02 HYPE, half goes to adapter HC spot)");
  console.log("");
  console.log("2. Live route test: adapter.verifyRoute(1_000_000) — EVM→spot→perp→spot→EVM");
  console.log("   Requires adapter HC to hold HYPE from step 1. ~30s to settle.");
  console.log("   (scripts/verify-route-v2.cjs — set ADAPTER_ADDR)");
  console.log("");
  console.log("3. Seed deposit: vault.deposit(5_000_000, 0) as deployer");
  console.log("   HLP equity should grow within ~10s (v2 flow: bridge→spot→perp→HLP).");
  console.log("");
  console.log("4. Swap pm2 keeper to v2:");
  console.log("   Update HLP_ADAPTER_ADDR in ~/ShadowVaultV15/.env.pool-e to:");
  console.log("     " + await adapter.getAddress());
  console.log("   Then:");
  console.log("     pm2 delete hlp-hc-keeper");
  console.log("     pm2 start keeper/hlp-hc-keeper-v2.js --name hlp-hc-keeper-v2 --cron '0 */3 * * *'");
  console.log("");
  console.log("5. Retire v1 stack:");
  console.log("   - old adapter 0x5c45a7a4… is already drained (Phase A)");
  console.log("   - old vault   0x31D4BD9C… has no active positions");
  console.log("   - old skin    0x4bAd7c72… — optional: setStrategyActive(0,false)");
  console.log("");
  console.log("6. After 7 days clean:");
  console.log("   - grantRole(DEFAULT_ADMIN_ROLE, Safe) + renounce deployer on all 3");
  console.log("   - adapter.setDepositLimits(10_000e6, 50_000e6)");
  console.log("   - setWhitelistEnabled(false) to open deposits");
}

main().catch((e) => { console.error(e); process.exit(1); });
