// Register Diamondz as digger #1 on the freshly-deployed marketplace stack,
// then add the V15 Arbitrum pool NFT collections so they become listable.
//
// Strategy for the bond on a fresh deploy where the deployer only has a
// modest USDC balance:
//   1. Temporarily lower minBondUSDC to 10 USDC (admin op)
//   2. openDigger with a 10 USDC bond
//   3. Restore minBondUSDC to 1000 USDC (or whatever DEFAULT_MIN_BOND is)
//   4. Register the active Pool A/B/C/D NFT contracts under digger #1

const hre = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg     = require("../config/deployed-marketplace-arb.json");
const v15     = require("../config/deployed.json");

const REGISTRY = cfg.contracts.diggerRegistry;
const USDC     = cfg.usdc;
const ACTIVE_POOLS = ["A", "B", "C", "D"]; // skip _deprecated / _broken / _pre_whitelist

const TEMP_MIN_BOND   = 10n  * 10n ** 6n; // 10 USDC
const REAL_MIN_BOND   = 1000n * 10n ** 6n; // 1000 USDC default
const BOND_AMOUNT     = 10n  * 10n ** 6n;
const PROTOCOL_BPS    = 1000; // 10%
const SUPPLIER_BPS    = 7000; // 70% (eventually to LendingPool)
const DIGGER_BPS      = 2000; // 20%
const MAX_LTV_BPS     = 5000; // 50%

const REGISTRY_ABI = [
  "function minBondUSDC() view returns (uint256)",
  "function nextDiggerId() view returns (uint256)",
  "function diggers(uint256) view returns (address,uint256,uint256,uint16,uint16,uint16,bool,bool)",
  "function collections(address) view returns (uint256,address,uint16,bool)",
  "function setMinBond(uint256)",
  "function openDigger(uint256,uint16,uint16,uint16) returns (uint256)",
  "function registerCollection(uint256,address,address,uint16)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Registry:", REGISTRY);

  const reg  = new hre.ethers.Contract(REGISTRY, REGISTRY_ABI, deployer);
  const usdc = new hre.ethers.Contract(USDC, ERC20_ABI, deployer);

  const balUsdc = await usdc.balanceOf(deployer.address);
  console.log("Deployer USDC:", hre.ethers.formatUnits(balUsdc, 6));
  if (balUsdc < BOND_AMOUNT) {
    throw new Error(`deployer USDC < ${hre.ethers.formatUnits(BOND_AMOUNT, 6)} — top up first`);
  }

  const curMin = await reg.minBondUSDC();
  console.log("Current minBondUSDC:", hre.ethers.formatUnits(curMin, 6));

  // Step 1
  if (curMin > TEMP_MIN_BOND) {
    console.log(`→ setMinBond(${hre.ethers.formatUnits(TEMP_MIN_BOND, 6)}) (temporary)`);
    await (await reg.setMinBond(TEMP_MIN_BOND)).wait();
    console.log("  done");
  }

  // Step 2: approve + openDigger
  const cur = await usdc.allowance ? await usdc.balanceOf(deployer.address) : 0;
  console.log(`→ approve registry for ${hre.ethers.formatUnits(BOND_AMOUNT, 6)} USDC`);
  await (await usdc.approve(REGISTRY, BOND_AMOUNT)).wait();

  // Check if a digger already exists with deployer as owner; skip openDigger if so.
  const nextId = await reg.nextDiggerId();
  let diggerId = 0n;
  for (let i = 1n; i < nextId; i++) {
    const d = await reg.diggers(i);
    if (d[0].toLowerCase() === deployer.address.toLowerCase()) { diggerId = i; break; }
  }
  if (diggerId === 0n) {
    console.log(`→ openDigger(bond=${hre.ethers.formatUnits(BOND_AMOUNT, 6)}, ${PROTOCOL_BPS}/${SUPPLIER_BPS}/${DIGGER_BPS})`);
    const tx = await reg.openDigger(BOND_AMOUNT, PROTOCOL_BPS, SUPPLIER_BPS, DIGGER_BPS);
    const rc = await tx.wait();
    diggerId = await reg.nextDiggerId() - 1n;
    console.log(`  digger #${diggerId} opened (tx ${tx.hash})`);
  } else {
    console.log(`  digger #${diggerId} already opened by deployer — skip`);
  }

  // Step 3: restore minBond
  if (curMin > TEMP_MIN_BOND) {
    console.log(`→ setMinBond(${hre.ethers.formatUnits(REAL_MIN_BOND, 6)}) (restore)`);
    await (await reg.setMinBond(REAL_MIN_BOND)).wait();
    console.log("  done");
  }

  // Step 4: register active Pool NFTs
  for (const k of ACTIVE_POOLS) {
    const pool = v15.pools[k];
    if (!pool || !pool.positionNFT) { console.log(`Pool ${k}: no NFT — skip`); continue; }
    const nft = pool.positionNFT;
    const c = await reg.collections(nft);
    if (c[3]) { console.log(`Pool ${k} (${nft}): already accepted — skip`); continue; }
    console.log(`→ registerCollection(diggerId=${diggerId}, nft=${nft}, oracle=0x0, ltv=${MAX_LTV_BPS})`);
    const tx = await reg.registerCollection(diggerId, nft, hre.ethers.ZeroAddress, MAX_LTV_BPS);
    await tx.wait();
    console.log(`  registered (tx ${tx.hash})`);
  }

  console.log("\n✓ Diamondz digger registered + V15 Pool A/B/C/D NFTs listable on the marketplace.");
}

main().catch(e => { console.error(e); process.exit(1); });
