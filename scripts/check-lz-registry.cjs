const hre = require("hardhat");
async function main() {
  const r = new hre.ethers.Contract("0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99",
    ["function collections(address) view returns (uint256 diggerId, address oracle, uint16 maxLtvBps, bool accepted)"],
    hre.ethers.provider);
  const out = await r.collections("0x4228b8E98786F26bb43dF217F18Af9E8D537fd68");
  console.log("LZ wrapper registry entry:");
  console.log("  diggerId :", out[0].toString());
  console.log("  oracle   :", out[1]);
  console.log("  maxLtvBps:", out[2].toString(), `(${Number(out[2])/100}%)`);
  console.log("  accepted :", out[3]);
}
main().catch(e=>{console.error(e);process.exit(1);});
