// Deploy the full marketplace + lending + valuer stack on Polygon PoS.
// Mirrors the Arb Phase 2 + Phase 3 + Valuer deploys, adapted for Polygon's
// USDC + Safe + Aave addresses.
//
// Order:
//   1. DiggerRegistry      (admin=deployer, usdc=Polygon USDC, treasury=Polygon Safe)
//   2. RoyaltyRouter       (admin, usdc, registry, treasury)
//   3. EcosystemMarketplace(admin, usdc, registry, router)
//   4. NFTValuer           (admin, registry)
//   5. LendingPool         (admin, usdc, registry)
//   6. pool.setValuer(valuer)
//   7. Open Diamondz digger #1 with minBond-temporary-low + register all
//      4 Polygon Pool NFTs at 50% LTV (same defaults as Arb)
//   8. For each registered NFT: valuer.setVaultMode(nft, vault, 0)
//   9. Restore minBond to 1000 USDC
//
// Writes config/deployed-polygon-stack.json. Safe to rerun — each deploy step
// is non-idempotent by design (we want fresh addresses; there's no pre-existing
// Polygon marketplace to preserve).

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

// Polygon constants
const POLYGON_USDC    = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC native
const POLYGON_SAFE    = "0xdF46A5083C01C82b2e70fF97E9cf27fC80000851";

// Polygon V15 pools (from CauseVaultPolygonV15/config/deployed.json)
const POOLS = [
  { label: "A (Blue Chip)",       vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c" },
  { label: "B (Polygon DeFi)",    vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8" },
  { label: "C (Full Spectrum)",   vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7" },
  { label: "D (Hard Money)",      vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309" },
];

// Same economics as Arb
const MIN_BOND_LOW  = 10_000000n;        // 10 USDC (onboarding discount)
const MIN_BOND_HIGH = 1_000_000000n;     // 1000 USDC (restored post-onboarding)
const DIGGER_FEE_SPLIT = { protocolBps: 1000, supplierBps: 7000, diggerBps: 2000 };
const MAX_LTV_BPS = 5000;                // 50% per Polygon collection
const VALUER_CLAMP = 0n;                 // disabled — bounded by pool LTV caps

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const a = await c.getAddress();
  console.log(`  ${name}: ${a}`);
  return { c, a };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 137) throw new Error(`Expected Polygon (137), got ${net.chainId}`);

  section(`Polygon stack deploy (${net.chainId})`);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer :", deployer.address);
  console.log("Treasury :", POLYGON_SAFE);
  console.log("USDC     :", POLYGON_USDC);
  console.log("POL bal  :", hre.ethers.formatEther(bal));
  if (bal < hre.ethers.parseEther("1")) throw new Error("POL < 1 — top up");

  // ═════════ 1. DiggerRegistry
  section("1. DiggerRegistry");
  const { c: registry, a: registryAddr } = await deploy("DiggerRegistry", [deployer.address, POLYGON_USDC, POLYGON_SAFE]);

  // ═════════ 2. RoyaltyRouter
  section("2. RoyaltyRouter");
  const { c: router, a: routerAddr } = await deploy("RoyaltyRouter", [deployer.address, POLYGON_USDC, registryAddr, POLYGON_SAFE]);

  // ═════════ 3. EcosystemMarketplace
  section("3. EcosystemMarketplace");
  const { c: marketplace, a: marketplaceAddr } = await deploy("EcosystemMarketplace", [deployer.address, POLYGON_USDC, registryAddr, routerAddr]);

  // ═════════ 4. NFTValuer
  section("4. NFTValuer");
  const { c: valuer, a: valuerAddr } = await deploy("NFTValuer", [deployer.address, registryAddr]);

  // ═════════ 5. LendingPool
  section("5. LendingPool");
  const { c: pool, a: poolAddr } = await deploy("LendingPool", [deployer.address, POLYGON_USDC, registryAddr]);

  // ═════════ 6. pool.setValuer
  section("6. Wire pool → valuer");
  step("pool.setValuer(NFTValuer)");
  await (await pool.setValuer(valuerAddr)).wait();
  console.log("  readback:", await pool.valuer());

  // ═════════ 7. Register digger + collections
  section("7. Onboard Diamondz digger #1 + register Pool A-D");

  // USDC allowance for bond
  const usdc = new hre.ethers.Contract(POLYGON_USDC, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], deployer);
  const deployerUSDC = await usdc.balanceOf(deployer.address);
  console.log(`  deployer USDC balance: ${Number(deployerUSDC) / 1e6}`);
  if (deployerUSDC < MIN_BOND_LOW) {
    throw new Error(`deployer USDC < ${Number(MIN_BOND_LOW) / 1e6} needed for bond`);
  }

  step(`registry.setMinBond(${Number(MIN_BOND_LOW) / 1e6} USDC) — onboarding discount`);
  await (await registry.setMinBond(MIN_BOND_LOW)).wait();

  step("approve registry for bond");
  await (await usdc.approve(registryAddr, MIN_BOND_LOW)).wait();

  step(`openDigger(bond=${Number(MIN_BOND_LOW) / 1e6} USDC, split ${DIGGER_FEE_SPLIT.protocolBps}/${DIGGER_FEE_SPLIT.supplierBps}/${DIGGER_FEE_SPLIT.diggerBps})`);
  const openTx = await registry.openDigger(MIN_BOND_LOW, DIGGER_FEE_SPLIT.protocolBps, DIGGER_FEE_SPLIT.supplierBps, DIGGER_FEE_SPLIT.diggerBps);
  await openTx.wait();
  const diggerId = 1n;

  for (const p of POOLS) {
    step(`registerCollection(${p.label}, maxLtv=${MAX_LTV_BPS}bps)`);
    await (await registry.registerCollection(diggerId, p.nft, hre.ethers.ZeroAddress, MAX_LTV_BPS)).wait();
  }

  step(`registry.setMinBond(${Number(MIN_BOND_HIGH) / 1e6} USDC) — restore prod floor`);
  await (await registry.setMinBond(MIN_BOND_HIGH)).wait();

  // ═════════ 8. Configure valuer for each pool
  section("8. Configure NFTValuer (VAULT_POSITION, clamp=0)");
  for (const p of POOLS) {
    step(`valuer.setVaultMode(${p.label})`);
    await (await valuer.setVaultMode(p.nft, p.vault, VALUER_CLAMP)).wait();
    const [mode, src, clamp] = await valuer.configOf(p.nft);
    const modeStr = ["NONE","VAULT_POSITION","FLOOR_ORACLE","STATIC_USDC"][Number(mode)];
    console.log(`  ${p.label}: mode=${modeStr} source=${src} clamp=${clamp}`);
    if (modeStr !== "VAULT_POSITION") throw new Error("mode readback mismatch");
  }

  // ═════════ 9. Persist
  section("9. Save config");
  const out = {
    chainId: Number(net.chainId),
    network: "polygon",
    deployer: deployer.address,
    admin: deployer.address,
    treasury: POLYGON_SAFE,
    safe: POLYGON_SAFE,
    usdc: POLYGON_USDC,
    contracts: {
      diggerRegistry: registryAddr,
      royaltyRouter:  routerAddr,
      marketplace:    marketplaceAddr,
      nftValuer:      valuerAddr,
      lendingPool:    poolAddr,
    },
    digger1: {
      id: 1,
      owner: deployer.address,
      bondUSDC: MIN_BOND_LOW.toString(),
      feeSplit: DIGGER_FEE_SPLIT,
      collections: POOLS.map(p => ({
        label: p.label,
        nft: p.nft,
        vault: p.vault,
        maxLtvBps: MAX_LTV_BPS,
        valuerMode: "VAULT_POSITION",
      })),
    },
    config: {
      protocolFeeBps: 250,
      minBondUSDC: MIN_BOND_HIGH.toString(),
      unstakeDelay: 14 * 24 * 60 * 60,
    },
    notes: [
      "Admin = deployer EOA; rotate to Polygon Safe post-bake.",
      "Bond temporarily lowered to 10 USDC for digger #1 onboarding, restored to 1000 USDC after.",
      "LendingPool on Polygon does NOT have sweep wired — SweepController can be added later if needed.",
      "Arb <-> Polygon NFT bridge via CCIP is NOT wired here. See deploy-ccip-bridge scripts (pending).",
    ],
    deployedAt: new Date().toISOString(),
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-polygon-stack.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("wrote", outfile);

  // ═════════ 10. Verify hints
  section("10. Verify on Polygonscan");
  console.log(`npx hardhat verify --network polygon ${registryAddr} ${deployer.address} ${POLYGON_USDC} ${POLYGON_SAFE}`);
  console.log(`npx hardhat verify --network polygon ${routerAddr} ${deployer.address} ${POLYGON_USDC} ${registryAddr} ${POLYGON_SAFE}`);
  console.log(`npx hardhat verify --network polygon ${marketplaceAddr} ${deployer.address} ${POLYGON_USDC} ${registryAddr} ${routerAddr}`);
  console.log(`npx hardhat verify --network polygon ${valuerAddr} ${deployer.address} ${registryAddr}`);
  console.log(`npx hardhat verify --network polygon ${poolAddr} ${deployer.address} ${POLYGON_USDC} ${registryAddr}`);
  console.log("\n✓ Polygon stack live");
}

main().catch(e => { console.error(e); process.exit(1); });
