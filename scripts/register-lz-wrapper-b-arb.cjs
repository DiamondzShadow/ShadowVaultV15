// Register the LIVE bridge wrapper (Wrapper B = 0x72bD38e7...) — the one
// Locker A actually peers to. Earlier I registered the wrong wrapper
// (0x4228b8E9...) because memory described that as canonical, but the
// deployment configs + bridge UI use Wrapper B.

const hre = require("hardhat");

const WRAPPER_B   = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const DIGGER_REG  = "0x090275f1ddae9e37C28D495AD9f9044723D787c9";
const NFT_VALUER  = "0x83b946C721a0B5f5871DC91F884b364D1410f131";
const LTV_BPS     = 5000;

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
  console.log("Signer:", await signer.getAddress());

  const reg = new hre.ethers.Contract(DIGGER_REG, REGISTRY_ABI, signer);
  const val = new hre.ethers.Contract(NFT_VALUER, VALUER_ABI, signer);

  // Step 1
  const c = await reg.collections(WRAPPER_B);
  if (c.accepted) {
    console.log(`✓ already registered (class=${c.class_}, ltv=${c.maxLtvBps}bps)`);
  } else {
    console.log(`→ registerInHouseCollection(${WRAPPER_B}, ${WRAPPER_B}, ${LTV_BPS})`);
    const tx = await reg.registerInHouseCollection(WRAPPER_B, WRAPPER_B, LTV_BPS);
    console.log("  tx:", tx.hash);
    await tx.wait();
  }

  // Step 2
  const mode = Number(await val.modeOf(WRAPPER_B));
  if (mode === 4) {
    console.log("✓ Valuer mode already VAULT_MIRROR");
  } else {
    console.log(`→ valuer.setMirrorMode(${WRAPPER_B}, ${WRAPPER_B}, 0) [was ${mode}]`);
    const tx2 = await val.setMirrorMode(WRAPPER_B, WRAPPER_B, 0);
    console.log("  tx:", tx2.hash);
    await tx2.wait();
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
