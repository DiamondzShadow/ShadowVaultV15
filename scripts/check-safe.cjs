const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const safe = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
  const code = await p.getCode(safe);
  console.log("Code bytes:", (code.length - 2) / 2);
  if (code === "0x") { console.log("NO CONTRACT"); return; }
  const s = new ethers.Contract(safe, [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function VERSION() view returns (string)",
  ], p);
  try { console.log("VERSION:", await s.VERSION()); } catch (e) { console.log("no VERSION"); }
  try { console.log("threshold:", (await s.getThreshold()).toString()); } catch {}
  try { console.log("owners:", await s.getOwners()); } catch {}
})();
