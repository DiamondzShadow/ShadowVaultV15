// NAV heartbeat keeper — periodically re-pushes the last-known NAV for every
// registered basket so `getNav()` never trips the staleness revert.
//
// Until the Pool F basket adapter + HC-side trading wallet exist, this script
// just refreshes the timestamp without changing the value (0% drift, always
// accepted). When real basket trading is wired up, replace `computeNav()` with
// a function that reads the trading wallet's HC spot holdings + current HL spot
// prices and returns the USD NAV.
//
// Run via pm2 cron every 10 min. One-shot per invocation (matches the pattern
// of hlp-hc-keeper.js).

"use strict";

const { ethers } = require("ethers");
require("dotenv").config();

const ORACLE_ABI = [
  "function pushNav(uint64 basketId, uint256 navUsd6)",
  "function baskets(uint64) view returns (bool registered, uint256 lastNavUsd6, uint64 lastNavAt, uint32 maxStalenessSecs, uint16 maxDriftBps, bool paused, string name)",
  "function nextBasketId() view returns (uint64)",
];

function log(level, msg, fields = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level, step: "nav-heartbeat", msg, ...fields,
  }));
}

// TODO: replace with real price-aware NAV computation once basket trading lands.
// For now, echo the last-known NAV (keeps freshness without changing value).
function computeNavUsd6(lastNav) {
  return lastNav === 0n ? 1_000_000n : lastNav;
}

async function main() {
  const rpc = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
  const oracleAddr = process.env.NAV_ORACLE_ADDR;
  if (!oracleAddr) throw new Error("NAV_ORACLE_ADDR not set");

  const provider = new ethers.JsonRpcProvider(rpc);
  const keeper = new ethers.Wallet(process.env.HC_KEEPER_KEY, provider);
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, keeper);

  const nextId = Number(await oracle.nextBasketId());
  log("info", "start", { keeper: keeper.address, oracle: oracleAddr, basketCount: nextId });

  for (let i = 0; i < nextId; i++) {
    try {
      const b = await oracle.baskets(i);
      if (!b.registered) continue;
      if (b.paused) { log("warn", "basket paused — skipping", { basketId: i, name: b.name }); continue; }

      const nav = computeNavUsd6(b.lastNavUsd6);
      const tx = await oracle.pushNav(i, nav);
      await tx.wait();
      log("info", "pushed", { basketId: i, name: b.name, navUsd6: nav.toString(), txHash: tx.hash });
    } catch (e) {
      log("error", "push failed", { basketId: i, error: e.shortMessage || e.message });
    }
  }

  log("info", "done");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
