// Disable whitelist on Pool F v2 (HyperEVM) — the live HyperBasket vault.
// Idempotent: skips if already public. Re-reads after tx to confirm.
const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });

const RPC = process.env.HYPEREVM_RPC;
const PK  = process.env.DEPLOYER_KEY;

const POOL_F_V2 = "0x3F4396417f142fD406215E8437C448Cb28bf7552";

const ABI = [
  "function whitelistEnabled() view returns (bool)",
  "function setWhitelistEnabled(bool) external",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log("signer:", wallet.address);

  const code = await provider.getCode(POOL_F_V2);
  if (code.length <= 2) throw new Error("Pool F v2 has no code");

  const c = new ethers.Contract(POOL_F_V2, ABI, wallet);
  const adminRole = await c.DEFAULT_ADMIN_ROLE();
  const isAdmin = await c.hasRole(adminRole, wallet.address);
  console.log(`deployer is DEFAULT_ADMIN = ${isAdmin}`);
  if (!isAdmin) throw new Error("deployer is not admin on Pool F v2");

  const before = await c.whitelistEnabled();
  console.log(`whitelistEnabled before = ${before}`);
  if (!before) { console.log("already public, nothing to do"); return; }

  const tx = await c.setWhitelistEnabled(false);
  console.log(`tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`mined block ${rc.blockNumber}, gas ${rc.gasUsed.toString()}`);

  const after = await c.whitelistEnabled();
  console.log(`whitelistEnabled after = ${after}`);
  if (after) throw new Error("still true after tx");
  console.log("done — Pool F v2 public");
})().catch(e => { console.error(e); process.exit(1); });
