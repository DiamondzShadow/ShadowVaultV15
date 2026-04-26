const hre = require("hardhat");

const WRAPPER_LZ = "0x4228b8E98786F26bb43dF217F18Af9E8D537fd68"; // LZ (Hyper↔Arb)
const REGISTRY   = "0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99";
const VALUER     = "0xD90f5aE128118D9477C47478B9c5acbD69190ca1";

async function main() {
  const r = new hre.ethers.Contract(REGISTRY, [
    "function isRegistered(address) view returns (bool)",
    "function collectionLtvBps(address) view returns (uint16)",
    "function collections(address) view returns (tuple(uint256 diggerId, uint16 ltvBps, bool active))",
  ], hre.ethers.provider);

  console.log("DiggerRegistry @", REGISTRY);
  for (const [sig, args] of [
    ["isRegistered", [WRAPPER_LZ]],
    ["collectionLtvBps", [WRAPPER_LZ]],
    ["collections", [WRAPPER_LZ]],
  ]) {
    try {
      const out = await r[sig](...args);
      console.log(`  ${sig}(wrapperLZ):`, out.toString ? out.toString() : out);
    } catch (e) {
      console.log(`  ${sig}: reverted (${(e.shortMessage||e.message).slice(0,60)})`);
    }
  }

  const v = new hre.ethers.Contract(VALUER, [
    "function sources(address) view returns (address)",
    "function mirrorSource(address) view returns (address)",
  ], hre.ethers.provider);
  for (const sig of ["sources", "mirrorSource"]) {
    try {
      const out = await v[sig](WRAPPER_LZ);
      console.log(`NFTValuer.${sig}(wrapperLZ): ${out}`);
    } catch (e) {
      console.log(`NFTValuer.${sig}: ${(e.shortMessage||e.message).slice(0,60)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
