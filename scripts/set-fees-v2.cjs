// One-shot fee bump for the new Pool E v2 vault.
// Target (per project_fee_update_2026_04_19): early=1200, onTime=300, yield=300.
// Dry-run by default; EXECUTE=1 to send.

const hre = require("hardhat");
const VAULT = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const TARGET = { early: 1200, onTime: 300, yield: 300 };
const EXECUTE = process.env.EXECUTE === "1";

const ABI = [
  "function earlyExitFeeBps() view returns (uint256)",
  "function onTimeFeeBps() view returns (uint256)",
  "function protocolYieldFeeBps() view returns (uint256)",
  "function setFees(uint256,uint256,uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
];
const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";

(async () => {
  const [s] = await hre.ethers.getSigners();
  const v = new hre.ethers.Contract(VAULT, ABI, s);
  const [e, o, y, isAdmin] = await Promise.all([
    v.earlyExitFeeBps(), v.onTimeFeeBps(), v.protocolYieldFeeBps(),
    v.hasRole(ADMIN, s.address),
  ]);
  console.log(`Pool E v2 (${VAULT})`);
  console.log(`  current: early=${e} onTime=${o} yield=${y}`);
  console.log(`  target : early=${TARGET.early} onTime=${TARGET.onTime} yield=${TARGET.yield}`);
  console.log(`  admin? ${isAdmin}`);
  console.log(`  mode  : ${EXECUTE ? "EXECUTE" : "DRY-RUN"}`);
  if (Number(e) === TARGET.early && Number(o) === TARGET.onTime && Number(y) === TARGET.yield) {
    console.log("  already at target — nothing to do");
    return;
  }
  if (!EXECUTE) return;
  if (!isAdmin) throw new Error("signer is not DEFAULT_ADMIN_ROLE");
  const tx = await v.setFees(TARGET.early, TARGET.onTime, TARGET.yield);
  console.log("  tx:", tx.hash);
  await tx.wait();
  console.log("  mined.");
  const [e2, o2, y2] = await Promise.all([
    v.earlyExitFeeBps(), v.onTimeFeeBps(), v.protocolYieldFeeBps(),
  ]);
  console.log(`  post: early=${e2} onTime=${o2} yield=${y2}`);
})().catch(err => { console.error(err); process.exit(1); });
