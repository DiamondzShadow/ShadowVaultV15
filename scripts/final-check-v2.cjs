const hre = require("hardhat");
const ADAPTER = "0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9";
const a = ["function idleUsdc() view returns (uint256)",
  "function inFlightToHC() view returns (uint256)",
  "function reportedHCEquity() view returns (uint64)",
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function lockupUnlockAtMs() view returns (uint64)"];
(async () => {
  const [s] = await hre.ethers.getSigners();
  const c = new hre.ethers.Contract(ADAPTER, a, s);
  const [idle, inFlight, eq, total, prin, lockMs] = await Promise.all([
    c.idleUsdc(), c.inFlightToHC(), c.reportedHCEquity(),
    c.totalAssets(), c.totalPrincipal(), c.lockupUnlockAtMs(),
  ]);
  const fmt = n => "$" + (Number(n)/1e6).toFixed(6);
  console.log("idleUsdc       :", fmt(idle));
  console.log("inFlightToHC   :", fmt(inFlight));
  console.log("HLP equity     :", fmt(eq));
  console.log("totalAssets    :", fmt(total));
  console.log("totalPrincipal :", fmt(prin));
  console.log("lockup unlock  :", new Date(Number(lockMs)).toISOString(), `(in ${((Number(lockMs)-Date.now())/86400000).toFixed(2)} days)`);
})();
