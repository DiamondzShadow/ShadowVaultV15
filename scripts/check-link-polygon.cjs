const hre = require("hardhat");
async function main() {
  const candidates = [
    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", // Arb LINK from research
  ];
  for (const a of candidates) {
    try {
      const code = await hre.ethers.provider.getCode(a);
      const len = code.length;
      console.log(a, "code.length:", len);
      if (len > 2) {
        const c = new hre.ethers.Contract(a, ["function symbol() view returns (string)","function balanceOf(address) view returns (uint256)"], hre.ethers.provider);
        try {
          const sym = await c.symbol();
          console.log("  symbol:", sym);
        } catch (e) { console.log("  symbol() fail:", e.shortMessage || e.message); }
      }
    } catch (e) { console.log(a, "err:", e.shortMessage || e.message); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
