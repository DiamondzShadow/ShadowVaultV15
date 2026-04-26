// Sanity pass before any live bridge test:
// - quoteLock for the Pool E v2 seed NFT (does the whole quote path
//   work end-to-end — endpoint + enforcedOptions + DVN lookup + pricing)?
// - quoteValueUpdate likewise.
// - Keeper HYPE vs quote fee (will the keeper actually afford to push)?
// - locked[] sanity: 0 open positions.

const hre = require("hardhat");

const LOCKER     = "0xFC8f588bF9CCa0D1832F2735236Fc3eecdbc7381";
const SKIN_V2    = "0x5f90c2f0E9CE11A19d49A2E54d9df7759C7581ae"; // Pool E v2 HyperSkin
const SHADOWPASS = "0x397BaB25a41Aaa5cF76F19DE8794D5476B576CCC";
const KEEPER     = "0xCD20FE6E10838d8AEc242E0438A65c3d704D3E3d";
const DEPLOYER   = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

async function main() {
  const locker = new hre.ethers.Contract(LOCKER, [
    "function quoteLock(address,uint256,bytes) view returns (tuple(uint256 nativeFee,uint256 lzTokenFee))",
    "function quoteValueUpdate(address,uint256,bytes) view returns (tuple(uint256 nativeFee,uint256 lzTokenFee))",
    "function locked(uint256) view returns (address,address,uint256,uint256)",
    "function wrapperIdOf(address,uint256) pure returns (uint256)",
  ], hre.ethers.provider);

  console.log("═══ Live dry-run: quoteLock for Pool E NFT #1 ═══");
  try {
    const q = await locker.quoteLock(SKIN_V2, 1, "0x");
    console.log(`  quoteLock(Pool E v2, tokenId=1)`);
    console.log(`    nativeFee  : ${q.nativeFee} wei = ${hre.ethers.formatEther(q.nativeFee)} HYPE`);
    console.log(`    lzTokenFee : ${q.lzTokenFee} (should be 0)`);
    console.log(`    with 20% buffer: ${hre.ethers.formatEther((q.nativeFee * 120n) / 100n)} HYPE`);
  } catch (e) {
    console.log(`  ✗ quoteLock reverted: ${e.shortMessage || e.message}`);
  }

  console.log("\n═══ Live dry-run: quoteLock for ShadowPass #1 ═══");
  try {
    const q = await locker.quoteLock(SHADOWPASS, 1, "0x");
    console.log(`  quoteLock(ShadowPass, tokenId=1)`);
    console.log(`    nativeFee  : ${hre.ethers.formatEther(q.nativeFee)} HYPE`);
    console.log(`    lzTokenFee : ${q.lzTokenFee}`);
  } catch (e) {
    console.log(`  ✗ quoteLock reverted: ${(e.shortMessage || e.message).slice(0,120)}`);
    console.log(`    (expected if no ShadowPass has been minted yet — this is fine)`);
  }

  console.log("\n═══ quoteValueUpdate (what keeper would pay hourly) ═══");
  try {
    const q = await locker.quoteValueUpdate(SKIN_V2, 1, "0x");
    console.log(`  quoteValueUpdate(Pool E v2, 1)`);
    console.log(`    nativeFee  : ${hre.ethers.formatEther(q.nativeFee)} HYPE`);
    const keeperBal = await hre.ethers.provider.getBalance(KEEPER);
    const fee12 = (q.nativeFee * 120n) / 100n;
    console.log(`    keeper bal : ${hre.ethers.formatEther(keeperBal)} HYPE`);
    console.log(`    keeper can afford (× 1.2 buf): ${keeperBal >= fee12 ? "YES ✓" : "NO ✗"}`);
    console.log(`    pushes-affordable ≈ ${keeperBal / fee12}`);
  } catch (e) {
    console.log(`  ✗ quoteValueUpdate reverted: ${e.shortMessage || e.message}`);
  }

  console.log("\n═══ Open positions ═══");
  // Just probe Pool E #1 wrapperId — should be empty since nothing is locked yet
  const wid = await locker.wrapperIdOf(SKIN_V2, 1);
  const L = await locker.locked(wid);
  console.log(`  locked[wrapperIdOf(Pool E v2 #1)]: owner=${L[0]} (0x0 = not locked ✓)`);

  const depBal = await hre.ethers.provider.getBalance(DEPLOYER);
  console.log(`\n═══ Deployer HYPE: ${hre.ethers.formatEther(depBal)} (for approve + lock tx) ═══`);
}

main().catch(e=>{console.error(e);process.exit(1);});
