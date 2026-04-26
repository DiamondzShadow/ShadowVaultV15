const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const REGISTRY = "0x0b51d1A9098cf8a72C325003F44C194D41d7A85B";
const CIRCLE_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const reg = new ethers.Contract(REGISTRY, ["function getTokenIndex(address) view returns (uint32)"], p);
  const idx = await reg.getTokenIndex(CIRCLE_USDC);
  console.log(`Circle USDC (${CIRCLE_USDC}) → HC token index: ${idx}`);

  // Also read tokenInfo from spot precompile 0x80b for "USDC" style tokens.
  // Attempt token 0 tokenInfo at precompile 0x80b
  try {
    const data = ethers.toBeHex(0, 32);  // uint64 index = 0, padded
    const res = await p.call({ to: "0x000000000000000000000000000000000000080B", data });
    console.log("Precompile 0x80b (token 0):", res);
  } catch (e) { console.log("precompile call failed:", e.shortMessage || e.message); }
})().catch(e => { console.error(e); process.exit(1); });
