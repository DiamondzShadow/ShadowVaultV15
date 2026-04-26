// Keeper pushes the first NAV for each registered basket. Uses $1 per share
// as a par-value seed so downstream BasketReceipt mints snapshot entryNav=$1
// and liveValue scales cleanly from there.

const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const sp = require("../config/deployed-shadowpass-hc.json");

const ORACLE_ABI = [
  "function pushNav(uint64 basketId, uint256 navUsd6)",
  "function getNav(uint64 basketId) view returns (uint256, uint64)",
  "function getNavLenient(uint64 basketId) view returns (uint256, uint64, bool, bool)",
  "function baskets(uint64) view returns (bool, uint256, uint64, uint32, uint16, bool, string)",
];

async function main() {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const keeper = new ethers.Wallet(process.env.HC_KEEPER_KEY, p);
  console.log("keeper:", keeper.address);
  console.log("oracle:", sp.oracle);

  const oracle = new ethers.Contract(sp.oracle, ORACLE_ABI, keeper);

  for (const basketIdStr of Object.keys(sp.baskets)) {
    const basketId = Number(basketIdStr);
    const [reg, lastNav, lastAt, maxStale, maxDrift, paused, name] = await oracle.baskets(basketId);
    if (!reg) { console.log(`  basket ${basketId} not registered, skipping`); continue; }
    console.log(`  basket ${basketId} "${name}" — lastNav=${lastNav} lastAt=${lastAt}`);

    if (lastNav === 0n) {
      console.log(`  → pushing seed NAV 1_000_000 ($1.000000)`);
      const tx = await oracle.pushNav(basketId, 1_000_000n);
      await tx.wait();
      console.log(`  ✓ tx ${tx.hash}`);
    } else {
      console.log(`  already has NAV, skipping seed push`);
    }

    const [nav, at, stale, frozen] = await oracle.getNavLenient(basketId);
    console.log(`  state: nav=${nav} at=${at} stale=${stale} frozen=${frozen}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
