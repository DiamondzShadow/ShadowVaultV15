// ═════════════════════════════════════════════════════════════════════════════
//  Register Pool D v15.10 NFT as IN_HOUSE in the DiggerRegistry and
//  configure NFTValuer VAULT_POSITION mode for it.
//
//  Keeps the old v15.9 NFT registered too — legacy holders (deployer test
//  positions) can still list/withdraw. New NFT is what users mint going
//  forward.
//
//  Usage:
//    DEPLOYER_KEY=0x... ARB_RPC=... \
//      npx hardhat run scripts/register-pool-d-v15_10.cjs --network arbitrum
// ═════════════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const path = require("node:path");
const fs = require("node:fs");

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 42161) throw new Error(`Expected 42161, got ${chainId}`);

  const cfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));

  const POOL_D_NFT   = deployed.pools.D.positionNFT;
  const POOL_D_VAULT = deployed.pools.D.vault;
  const LTV          = 5000; // 50% — same as v15.9 Pool D

  if (deployed.pools.D.version !== "v15.10") {
    throw new Error(`Expected Pool D v15.10; got ${deployed.pools.D.version}`);
  }

  console.log(`Registry: ${cfg.diggerRegistry}`);
  console.log(`Valuer:   ${cfg.contracts.nftValuer}`);
  console.log(`Pool D v15.10 vault: ${POOL_D_VAULT}`);
  console.log(`Pool D v15.10 NFT:   ${POOL_D_NFT}`);

  const registry = await hre.ethers.getContractAt("DiggerRegistry", cfg.diggerRegistry);
  const valuer   = await hre.ethers.getContractAt("NFTValuer",     cfg.contracts.nftValuer);

  // Register the new NFT in-house.
  const existing = await registry.collections(POOL_D_NFT);
  if (existing.accepted) {
    console.log(`  already registered (class=${existing.class_})`);
  } else {
    console.log(`  registerInHouseCollection(${POOL_D_NFT}, vault=${POOL_D_VAULT}, ltv=${LTV})`);
    const tx = await registry.registerInHouseCollection(POOL_D_NFT, POOL_D_VAULT, LTV);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
  }

  // Set valuer mode to VAULT_POSITION.
  const mode = await valuer.modeOf(POOL_D_NFT);
  if (Number(mode) === 1) {
    console.log(`  valuer already VAULT_POSITION ✓`);
  } else {
    console.log(`  valuer.setVaultMode(${POOL_D_NFT}, ${POOL_D_VAULT}, 0)`);
    const tx2 = await valuer.setVaultMode(POOL_D_NFT, POOL_D_VAULT, 0);
    console.log(`    tx: ${tx2.hash}`);
    await tx2.wait();
  }

  // Sanity reads
  const c = await registry.collections(POOL_D_NFT);
  console.log(`\nFinal state:`);
  console.log(`  collections[nft].accepted:  ${c.accepted}`);
  console.log(`  collections[nft].class_:    ${c.class_}`);
  console.log(`  collections[nft].maxLtvBps: ${c.maxLtvBps}`);
  console.log(`  valuer.modeOf(nft):         ${await valuer.modeOf(POOL_D_NFT)} (expect 1 = VAULT_POSITION)`);

  console.log(`\n✓ Pool D v15.10 registered for marketplace + lending.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
