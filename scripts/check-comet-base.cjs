const hre = require("hardhat");
const candidates = [
  { addr: "0xF25212E676D1F7F89Cd72fFEe66158f541246445", note: "Poly cUSDCv3-bridged (USDC.e)" },
  { addr: "0xaeB318360f27748Acb200CE616E389A6C9409a07", note: "Poly cUSDTv3" },
  // Try some other possible Polygon market addresses:
  { addr: "0x45939657d1CA34A8FA39A924B71D28Fe8431e581", note: "candidate 0x4593" },
  { addr: "0xD303b9b3F4c9aE04fC6094Ab3A6E1B4B6C68b7b3", note: "candidate 0xD303" },
];
async function main() {
  for (const { addr, note } of candidates) {
    const c = new hre.ethers.Contract(addr, ["function baseToken() view returns (address)"], hre.ethers.provider);
    try {
      const base = await c.baseToken();
      console.log(`${note} ${addr}  baseToken=${base}`);
    } catch (e) { console.log(`${note} ${addr} reverted: ${e.shortMessage || e.message.slice(0,80)}`); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
