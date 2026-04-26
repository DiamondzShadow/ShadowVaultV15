// Disable whitelist on Pool E v2 + Pool F (HyperEVM chain 999) so deposits are
// open to the public. Idempotent: skips if already false. Re-reads after each
// tx to verify on-chain state.
const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });

const RPC = process.env.HYPEREVM_RPC;
const PK  = process.env.DEPLOYER_KEY;

const POOLS = [
  { name: "Pool E v2", addr: "0x481D57E356cF99E44C25675C57C178D9Ef46BD57" },
  { name: "Pool F",    addr: "0xe442CFF139B6339f7468240b4119E7b2B7841772" },
];

const ABI = [
  "function whitelistEnabled() view returns (bool)",
  "function setWhitelistEnabled(bool) external",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log("signer:", wallet.address);

  for (const { name, addr } of POOLS) {
    const c = new ethers.Contract(addr, ABI, wallet);
    const before = await c.whitelistEnabled();
    if (!before) { console.log(`${name} ${addr} — already public, skip`); continue; }
    console.log(`${name} ${addr} — sending setWhitelistEnabled(false)…`);
    const tx = await c.setWhitelistEnabled(false);
    console.log(`  tx ${tx.hash}`);
    const rc = await tx.wait();
    console.log(`  mined block ${rc.blockNumber}, gas ${rc.gasUsed.toString()}`);
    const after = await c.whitelistEnabled();
    console.log(`  whitelistEnabled now = ${after}`);
    if (after) throw new Error(`${name}: whitelistEnabled still true after tx`);
  }
  console.log("done — both pools public");
})().catch(e => { console.error(e); process.exit(1); });
