// ═════════════════════════════════════════════════════════════════════════════
//  Register HyperPositionWrapper (LayerZero HyperEVM → Arb mirror) in the
//  marketplace DiggerRegistry + NFTValuer so bridged Pool E + ShadowPass
//  positions show up on dex.diamondz.one and can be listed.
//
//  Idempotent: skips registration if collection.accepted == true and
//  valuer.modeOf == VAULT_MIRROR(4).
//
//  Usage:
//    DEPLOYER_KEY=0x... ARB_RPC=... \
//      npx hardhat run scripts/register-lz-wrapper-arb.cjs --network arbitrum
// ═════════════════════════════════════════════════════════════════════════════

const hre = require("hardhat");

const WRAPPER       = "0x4228b8E98786F26bb43dF217F18Af9E8D537fd68";
const DIGGER_REG    = "0x090275f1ddae9e37C28D495AD9f9044723D787c9";
const NFT_VALUER    = "0x83b946C721a0B5f5871DC91F884b364D1410f131";
const LTV_BPS       = 5000;   // 50% — same as the CCIP wrapper
const NO_VALUE_CLAMP = 0n;    // 0 = uncapped (rely on source's estimatePositionValue)

const REGISTRY_ABI = [
  "function collections(address) view returns (uint256 diggerId, address oracle, uint16 maxLtvBps, bool accepted, uint8 class_)",
  "function registerInHouseCollection(address nft, address valueSource, uint16 maxLtvBps)",
];

const VALUER_ABI = [
  "function modeOf(address) view returns (uint8)",
  "function setMirrorMode(address nft, address source, uint256 maxValueClampUSDC)",
];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 42161) throw new Error(`Expected 42161, got ${chainId}`);

  console.log(`Signer:     ${await signer.getAddress()}`);
  console.log(`Wrapper:    ${WRAPPER}`);
  console.log(`Registry:   ${DIGGER_REG}`);
  console.log(`Valuer:     ${NFT_VALUER}`);

  const registry = new hre.ethers.Contract(DIGGER_REG, REGISTRY_ABI, signer);
  const valuer   = new hre.ethers.Contract(NFT_VALUER, VALUER_ABI, signer);

  // Step 1 — DiggerRegistry IN_HOUSE registration.
  const existing = await registry.collections(WRAPPER);
  if (existing.accepted) {
    console.log(`✓ Already registered (class=${existing.class_}, ltv=${existing.maxLtvBps}bps)`);
  } else {
    console.log(`→ registerInHouseCollection(${WRAPPER}, ${WRAPPER}, ${LTV_BPS})`);
    const tx = await registry.registerInHouseCollection(WRAPPER, WRAPPER, LTV_BPS);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    const after = await registry.collections(WRAPPER);
    if (!after.accepted) throw new Error("registration not reflected on chain");
    console.log(`✓ Registered (class=${after.class_})`);
  }

  // Step 2 — NFTValuer VAULT_MIRROR mode (so valueOfUSDC returns live numbers).
  const mode = Number(await valuer.modeOf(WRAPPER));
  // 0=NONE, 1=VAULT_POSITION, 2=FLOOR_ORACLE, 3=STATIC_USDC, 4=VAULT_MIRROR
  if (mode === 4) {
    console.log(`✓ Valuer mode already VAULT_MIRROR`);
  } else {
    console.log(`→ valuer.setMirrorMode(${WRAPPER}, ${WRAPPER}, 0)  [mode was ${mode}]`);
    const tx2 = await valuer.setMirrorMode(WRAPPER, WRAPPER, NO_VALUE_CLAMP);
    console.log(`    tx: ${tx2.hash}`);
    await tx2.wait();
    const newMode = Number(await valuer.modeOf(WRAPPER));
    if (newMode !== 4) throw new Error(`valuer mode is ${newMode}, expected 4`);
    console.log(`✓ Valuer mode = VAULT_MIRROR`);
  }

  console.log("\nDone. dex.diamondz.one will show + list bridged positions.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
