// Register the live Arb V15 Pool A-D NFTs as IN_HOUSE in the new
// DiggerRegistry v2, and configure the NFTValuer v3 in VAULT_POSITION mode.
//
// Pool E HyperSkin v1 on Arb (0x4bAd…9ED0) is SKIPPED — Pool E redeployed
// to v2 on HyperEVM; the Arb-side v1 NFT is retired.

const hre = require("hardhat");
const path = require("node:path");

// Active V15 pools on Arb (from deployed.json).
const POOLS = [
  { label: "Pool A (Morpho Steakhouse)", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a", vault: "0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa", ltv: 5000 },
  { label: "Pool B (DeFi + RWA)",        nft: "0x67940CD1D7000494433B1Be44Dde494994393174", vault: "0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce", ltv: 5000 },
  { label: "Pool C",                     nft: "0x9C86B7C9f4195d3d5150A39983ca0536353109f6", vault: "0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1", ltv: 5000 },
  { label: "Pool D",                     nft: "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", vault: "0x109B722501A713E48465cA0509E8724f6640b9D4", ltv: 5000 },
];

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 42161) throw new Error(`Expected 42161, got ${chainId}`);
  const cfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));

  const registry = await hre.ethers.getContractAt("DiggerRegistry", cfg.diggerRegistry);
  const valuer   = await hre.ethers.getContractAt("NFTValuer",     cfg.contracts.nftValuer);

  console.log(`Registry : ${cfg.diggerRegistry}`);
  console.log(`Valuer   : ${cfg.contracts.nftValuer}`);

  for (const p of POOLS) {
    const existing = await registry.collections(p.nft);
    if (existing.accepted) {
      console.log(`  ${p.label} already registered (class=${existing.class_})`);
    } else {
      console.log(`  • register in-house: ${p.label}`);
      const tx = await registry.registerInHouseCollection(p.nft, p.vault, p.ltv);
      await tx.wait();
    }
    const mode = await valuer.modeOf(p.nft);
    if (Number(mode) === 1) {
      console.log(`    valuer already VAULT_POSITION ✓`);
    } else {
      const tx2 = await valuer.setVaultMode(p.nft, p.vault, 0);
      await tx2.wait();
      console.log(`    valuer setVaultMode ✓`);
    }
  }

  console.log("\n✓ Arb V15 Pool A-D all registered IN_HOUSE + valuer VAULT_POSITION");
}

main().catch(e=>{console.error(e);process.exit(1);});
