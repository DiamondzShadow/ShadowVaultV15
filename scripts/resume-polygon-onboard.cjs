// Resume the Polygon stack onboarding after the initial deploy failed on
// USDC bond funding. Uses a 0.1 USDC temporary bond floor (admin-settable)
// so the digger can open with the deployer's current balance (~0.2 USDC),
// then restores the 1000 USDC floor afterwards.
//
// Idempotent: will detect existing digger and skip openDigger if #1 exists.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg = require("../config/deployed-polygon-stack.json");

const USDC           = cfg.usdc;
const REGISTRY       = cfg.contracts.diggerRegistry;
const VALUER         = cfg.contracts.nftValuer;

const POOLS = [
  { label: "A (Blue Chip)",       vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c" },
  { label: "B (Polygon DeFi)",    vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8" },
  { label: "C (Full Spectrum)",   vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7" },
  { label: "D (Hard Money)",      vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309" },
];

const BOND_LOW    = 100_000n;            // 0.1 USDC — onboarding floor
const BOND_RESTORE = 1_000_000000n;      // 1000 USDC — restored later
const FEE_SPLIT   = { protocolBps: 1000, supplierBps: 7000, diggerBps: 2000 };
const MAX_LTV_BPS = 5000;
const VALUER_CLAMP = 0n;

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 137) throw new Error(`Expected 137, got ${net.chainId}`);

  section("Resume Polygon onboarding");
  console.log("Deployer :", deployer.address);

  const registry = await hre.ethers.getContractAt("DiggerRegistry", REGISTRY);
  const valuer   = await hre.ethers.getContractAt("NFTValuer", VALUER);
  const usdc     = new hre.ethers.Contract(USDC, [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ], deployer);

  const balUSDC = await usdc.balanceOf(deployer.address);
  console.log("USDC bal :", (Number(balUSDC) / 1e6).toFixed(6));
  if (balUSDC < BOND_LOW) throw new Error(`need ≥${Number(BOND_LOW) / 1e6} USDC`);

  // ═════════ 1. Check if digger #1 already exists
  const nextId = await registry.nextDiggerId();
  let diggerId = 1n;
  if (nextId > 1n) {
    const existing = await registry.diggers(1);
    if (existing.owner.toLowerCase() === deployer.address.toLowerCase()) {
      console.log("digger #1 already open, owner matches — skipping openDigger");
    } else {
      throw new Error(`digger #1 exists with different owner ${existing.owner}`);
    }
  } else {
    section(`1. Set minBond to ${Number(BOND_LOW) / 1e6} USDC (temporary)`);
    await (await registry.setMinBond(BOND_LOW)).wait();

    section("2. Approve registry for bond");
    const allow = await usdc.allowance(deployer.address, REGISTRY);
    if (allow < BOND_LOW) {
      await (await usdc.approve(REGISTRY, BOND_LOW)).wait();
    }

    section(`3. openDigger(bond=${Number(BOND_LOW) / 1e6} USDC)`);
    await (await registry.openDigger(BOND_LOW, FEE_SPLIT.protocolBps, FEE_SPLIT.supplierBps, FEE_SPLIT.diggerBps)).wait();
    console.log("  digger #1 opened");
  }

  // ═════════ 4. Register collections
  section("4. Register Pool A/B/C/D NFTs");
  for (const p of POOLS) {
    const c = await registry.collections(p.nft);
    if (c.accepted) {
      console.log(`  ${p.label}: already registered ✓`);
      continue;
    }
    step(`registerCollection(${p.label})`);
    await (await registry.registerCollection(diggerId, p.nft, hre.ethers.ZeroAddress, MAX_LTV_BPS)).wait();
  }

  // ═════════ 5. Configure valuer
  section("5. NFTValuer.setVaultMode for each pool");
  for (const p of POOLS) {
    const [mode] = await valuer.configOf(p.nft);
    if (Number(mode) === 1) {
      console.log(`  ${p.label}: already VAULT_POSITION ✓`);
      continue;
    }
    step(`valuer.setVaultMode(${p.label})`);
    await (await valuer.setVaultMode(p.nft, p.vault, VALUER_CLAMP)).wait();
    const [newMode, src] = await valuer.configOf(p.nft);
    const modeStr = ["NONE","VAULT_POSITION","FLOOR_ORACLE","STATIC_USDC"][Number(newMode)];
    console.log(`  ${p.label}: mode=${modeStr} src=${src}`);
  }

  // ═════════ 6. Restore minBond (optional — keep low if deployer will add more collections later)
  // Skip restore; restoring to 1000 USDC with only 0.2 USDC balance left on deployer
  // would strand admin action. Keep at BOND_LOW for now; user can restore manually
  // after topping up.
  console.log("\n(minBond left at 0.1 USDC — restore to 1000 USDC after funding deployer)");

  // ═════════ 7. Update config JSON
  section("6. Update deployed-polygon-stack.json");
  cfg.digger1 = {
    id: 1,
    owner: deployer.address,
    bondUSDC: BOND_LOW.toString(),
    feeSplit: FEE_SPLIT,
    collections: POOLS.map(p => ({
      label: p.label, nft: p.nft, vault: p.vault, maxLtvBps: MAX_LTV_BPS, valuerMode: "VAULT_POSITION",
    })),
  };
  cfg.onboardingStatus = "complete — digger #1 open with 0.1 USDC bond, 4 collections registered, valuer configured. minBond NOT restored to 1000 USDC (deployer low balance).";
  cfg.deployedAt = new Date().toISOString();
  const outfile = path.join(__dirname, "..", "config", "deployed-polygon-stack.json");
  fs.writeFileSync(outfile, JSON.stringify(cfg, null, 2));
  console.log("wrote", outfile);

  section("DONE");
  console.log("Stack:", JSON.stringify(cfg.contracts, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
