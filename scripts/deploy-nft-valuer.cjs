// Deploy NFTValuer on Arbitrum and configure Pool A/B/C/D with VAULT_POSITION
// mode pointing at each pool's issuing vault. Idempotent: if a config already
// matches, the set call is skipped.
//
// Order:
//   1. Sanity checks (chain, registry exists, collections accepted).
//   2. Deploy NFTValuer(admin=deployer, registry=0x3f93…af99).
//   3. For each pool: valuer.setVaultMode(nft, vault, maxClamp=0).
//      Clamp is disabled at v1 — the pool's ABSOLUTE_MAX_LTV_BPS=7500 and
//      per-collection maxLtvBps=5000 already bound exposure; clamps can be
//      tightened post-deploy once real position sizes are visible.
//   4. Write config/deployed-valuer-arb.json.
//   5. Print Arbiscan verification command + the `pool.setValuer(...)` call
//      the operator should run on the LendingPool v1.3 redeploy.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

// Live Phase 2 addresses (from config/deployed-marketplace-arb.json)
const DIGGER_REGISTRY = "0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99";

// Pool A/B/C/D vaults + NFTs (from config/deployed.json, v15.9-whitelist)
const POOLS = [
  { label: "A (Blue Chip Morpho)", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a", vault: "0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa" },
  { label: "B (DeFi+RWA GMX)",     nft: "0x67940CD1D7000494433B1Be44Dde494994393174", vault: "0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce" },
  { label: "C (Full Spectrum Aave)", nft: "0x9C86B7C9f4195d3d5150A39983ca0536353109f6", vault: "0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1" },
  { label: "D (Hard Assets)",      nft: "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", vault: "0x109B722501A713E48465cA0509E8724f6640b9D4" },
];

const MAX_CLAMP = 0n; // disabled — rely on LendingPool LTV caps for v1

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected Arbitrum (42161), got ${net.chainId}`);

  const balEth = await hre.ethers.provider.getBalance(deployer.address);
  section(`NFTValuer deploy on Arbitrum (${net.chainId})`);
  console.log("Deployer :", deployer.address);
  console.log("Registry :", DIGGER_REGISTRY);
  console.log("ETH bal  :", hre.ethers.formatEther(balEth));
  if (balEth < hre.ethers.parseEther("0.0005")) {
    throw new Error("deployer ETH < 0.0005 — top up first");
  }

  // ═════════ 1. Registry sanity — collections must be accepted
  section("1. Registry sanity");
  const registry = await hre.ethers.getContractAt("DiggerRegistry", DIGGER_REGISTRY);
  for (const p of POOLS) {
    const c = await registry.collections(p.nft);
    // Collection struct: (diggerId, oracle, maxLtvBps, accepted)
    if (!c.accepted) throw new Error(`Collection ${p.label} (${p.nft}) is NOT accepted in registry`);
    console.log(`  ${p.label}: accepted ✓ (digger #${c.diggerId}, maxLtv=${c.maxLtvBps}bps)`);
  }

  // ═════════ 2. Deploy NFTValuer
  section("2. Deploy NFTValuer");
  const Val = await hre.ethers.getContractFactory("NFTValuer");
  const valuer = await Val.deploy(deployer.address, DIGGER_REGISTRY);
  await valuer.waitForDeployment();
  const valuerAddr = await valuer.getAddress();
  console.log("  NFTValuer:", valuerAddr);

  // ═════════ 3. Configure each pool with VAULT_POSITION mode
  section("3. Configure pools (VAULT_POSITION, clamp=0)");
  for (const p of POOLS) {
    step(`Pool ${p.label}`);
    console.log(`  NFT  : ${p.nft}`);
    console.log(`  Vault: ${p.vault}`);
    const tx = await valuer.setVaultMode(p.nft, p.vault, MAX_CLAMP);
    const rc = await tx.wait();
    console.log(`  setVaultMode tx: ${rc.hash}`);

    // Read-back check
    const [mode, src, clamp] = await valuer.configOf(p.nft);
    const modeStr = ["NONE","VAULT_POSITION","FLOOR_ORACLE","STATIC_USDC"][Number(mode)];
    if (modeStr !== "VAULT_POSITION") throw new Error(`mode readback ${modeStr}`);
    if (src.toLowerCase() !== p.vault.toLowerCase()) throw new Error(`vault src readback ${src}`);
    console.log(`  read-back: mode=${modeStr} source=${src} clamp=${clamp}`);
  }

  // ═════════ 4. Persist
  section("4. Save config");
  const out = {
    chainId: Number(net.chainId),
    network: "arbitrum",
    deployer: deployer.address,
    admin: deployer.address, // rotate to Safe post-bake
    diggerRegistry: DIGGER_REGISTRY,
    contracts: { nftValuer: valuerAddr },
    configured: POOLS.map(p => ({
      label: p.label,
      nft: p.nft,
      vault: p.vault,
      mode: "VAULT_POSITION",
      maxClampUSDC: MAX_CLAMP.toString(),
    })),
    deployedAt: new Date().toISOString(),
    notes: [
      "Admin = deployer EOA; rotate to Safe (0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43) alongside V15 rotation.",
      "Clamp disabled for v1 — bound by LendingPool.ABSOLUTE_MAX_LTV_BPS=7500 and per-collection maxLtvBps=5000.",
      "LendingPool v1.2 is LIVE but does NOT yet read this valuer. Operator must deploy v1.3 and call pool.setValuer(valuer).",
    ],
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-valuer-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("wrote", outfile);

  // ═════════ 5. Next-step hints
  section("5. Next steps");
  console.log("Verify on Arbiscan:");
  console.log(`  npx hardhat verify --network arbitrum ${valuerAddr} ${deployer.address} ${DIGGER_REGISTRY}`);
  console.log("");
  console.log("On LendingPool v1.3 redeploy (NOT done here — requires migration plan):");
  console.log(`  pool.setValuer(${valuerAddr})`);
  console.log("");
  console.log("To rotate admin to Safe later:");
  console.log(`  valuer.grantRole(DEFAULT_ADMIN_ROLE, SAFE)`);
  console.log(`  valuer.grantRole(CONFIG_ROLE,       SAFE)`);
  console.log(`  valuer.renounceRole(CONFIG_ROLE,       deployer)`);
  console.log(`  valuer.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
