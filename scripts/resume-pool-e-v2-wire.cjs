// Resume the Pool E v2 wiring after an interrupted deploy.
// Idempotent: re-grants are a no-op in OZ AccessControl; re-sets are fine.
// Operates on the already-deployed contracts from deploy-pool-e-v2-hyperevm.js.

const hre = require("hardhat");
const fs  = require("node:fs");
const path = require("node:path");

const ADAPTER = "0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9";
const SKIN    = "0x5f90c2f0E9CE11A19d49A2E54d9df7759C7581ae";
const VAULT   = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const USDC    = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const HLP     = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const ROUTER  = "0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21";
const TREASURY = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
const KEEPER  = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";

const VAULT_ROLE = "0x31e0210044b4f6757ce6aa31f9c6e8d4896d24a755014887391a926c5224d959"; // keccak("VAULT_ROLE")

async function tryTx(label, fn) {
  try {
    console.log(`→ ${label}`);
    const tx = await fn();
    if (tx && tx.hash) {
      console.log(`  tx ${tx.hash}`);
      const rc = await tx.wait();
      console.log(`  mined in block ${rc.blockNumber}`);
    } else {
      console.log(`  (noop — already set)`);
    }
  } catch (e) {
    const msg = e.shortMessage || e.message;
    if (msg.includes("already") || msg.includes("cannot revoke") || msg.includes("SameStrategy")) {
      console.log(`  (skip — ${msg.slice(0, 80)})`);
    } else {
      throw e;
    }
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const adapter = await hre.ethers.getContractAt("HLPAdapterHCv2", ADAPTER, deployer);
  const skin    = await hre.ethers.getContractAt("HyperSkin", SKIN, deployer);
  const vault   = await hre.ethers.getContractAt("ShadowVaultV15", VAULT, deployer);
  const router  = new hre.ethers.Contract(
    ROUTER,
    ["function addAuthorized(address) external",
     "function authorized(address) view returns (bool)"],
    deployer,
  );

  console.log("\n--- Current state ---");
  async function safe(fn) {
    try { return await fn(); } catch (e) { return `ERR:${(e.shortMessage || e.message).slice(0,50)}`; }
  }
  const adapterHasVault = await safe(() => adapter.hasRole(VAULT_ROLE, VAULT));
  const vaultNft        = await safe(() => vault.positionNFT());
  const vaultYieldBps   = await safe(() => vault.yieldBps());
  const vaultBasketBps  = await safe(() => vault.basketBps());
  const nextId          = await safe(() => skin._nextTokenId());
  const skinTreasury    = await safe(() => skin.treasury());
  const skinRouter      = await safe(() => skin.revenueRouter());
  const skinYieldSrc    = await safe(() => skin.yieldSource());
  const skinRisk        = await safe(() => skin.riskTier());
  const skinApy         = await safe(() => skin.apyRange());
  const wlEnabled       = await safe(() => vault.whitelistEnabled());
  const deployerWl      = await safe(() => vault.whitelisted(deployer.address));
  const routerAuth      = await safe(() => router.authorized(VAULT));

  console.log("adapter VAULT_ROLE on vault:", adapterHasVault);
  console.log("vault.positionNFT:", vaultNft);
  console.log("vault.basketBps / yieldBps:", vaultBasketBps?.toString(), "/", vaultYieldBps?.toString());
  console.log("skin._nextTokenId:", nextId?.toString());
  console.log("skin.treasury:", skinTreasury);
  console.log("skin.revenueRouter:", skinRouter);
  console.log("skin.yieldSource:", skinYieldSrc);
  console.log("skin.riskTier:", skinRisk);
  console.log("skin.apyRange:", skinApy);
  console.log("vault.whitelistEnabled:", wlEnabled);
  console.log("vault.whitelisted(deployer):", deployerWl);
  console.log("router.authorized(vault):", routerAuth);

  console.log("\n--- Resuming wiring (idempotent) ---");

  if (!adapterHasVault) {
    await tryTx("adapter.addVault(vault)", () => adapter.addVault(VAULT));
  }
  if (vaultNft.toLowerCase() !== SKIN.toLowerCase()) {
    await tryTx("vault.setPositionNFT(skin)", () => vault.setPositionNFT(SKIN));
  }

  // Strategy registration — only if none exists
  let strategyExists = false;
  try {
    const s = await skin.strategies(0);
    if (s && s.vault && s.vault.toLowerCase() === VAULT.toLowerCase()) {
      strategyExists = true;
    }
  } catch {}
  if (!strategyExists) {
    await tryTx("skin.registerStrategy('HyperCash v2', vault)",
      () => skin.registerStrategy("HyperCash v2", VAULT));
  } else {
    console.log("→ skin strategy #0 already points at vault (skip)");
  }

  // skin.setVault
  try {
    const sv = await skin.vault();
    if (sv.toLowerCase() !== VAULT.toLowerCase()) {
      await tryTx("skin.setVault(vault)", () => skin.setVault(VAULT));
    } else {
      console.log("→ skin.vault already set");
    }
  } catch {
    await tryTx("skin.setVault(vault)", () => skin.setVault(VAULT));
  }

  if (typeof vaultYieldBps !== "bigint" || vaultYieldBps !== 10000n) {
    await tryTx("vault.setAllocation(0, 10000)", () => vault.setAllocation(0, 10_000));
  }

  if (!routerAuth) {
    await tryTx("router.addAuthorized(vault)", () => router.addAuthorized(VAULT));
  }

  if (skinTreasury.toLowerCase() !== TREASURY.toLowerCase() || skinRouter.toLowerCase() !== ROUTER.toLowerCase()) {
    await tryTx("skin.setFeeRoutes(treasury, router)",
      () => skin.setFeeRoutes(TREASURY, ROUTER));
  }

  if (skinYieldSrc !== "Hyperliquid HLP") {
    await tryTx(`skin.setYieldSource("Hyperliquid HLP")`, () => skin.setYieldSource("Hyperliquid HLP"));
  }
  if (skinRisk !== "Yield") {
    await tryTx(`skin.setRiskTier("Yield")`, () => skin.setRiskTier("Yield"));
  }
  if (skinApy !== "~20%") {
    await tryTx(`skin.setApyRange("~20%")`, () => skin.setApyRange("~20%"));
  }

  if (!wlEnabled) {
    await tryTx("vault.setWhitelistEnabled(true)", () => vault.setWhitelistEnabled(true));
  }
  if (!deployerWl) {
    await tryTx(`vault.setWhitelist(deployer, true)`, () => vault.setWhitelist(deployer.address, true));
  }

  // Save config
  const out = {
    chainId: 999,
    usdc: USDC,
    hlpVault: HLP,
    revenueRouter: ROUTER,
    adapter: ADAPTER,
    skin: SKIN,
    vault: VAULT,
    deployer: deployer.address,
    treasury: TREASURY,
    keeper: KEEPER,
    caps: { perTx: "500000000", daily: "2000000000" },
    deployedAt: new Date().toISOString(),
    notes: "v2 adapter: spot↔perp class transfer hops added. Supersedes v1 at 0x5c45a7a4… (retired).",
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-pool-e-hc-v2.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("\nwrote", outfile);

  console.log("\n✓ Pool E v2 stack wired.");
}

main().catch((e) => { console.error(e); process.exit(1); });
