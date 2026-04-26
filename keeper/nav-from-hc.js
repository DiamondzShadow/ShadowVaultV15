// NAV computation keeper — reads the trader's HC spot holdings, multiplies
// each balance by the live HL spot mark price, and pushes the consolidated
// USD NAV to BasketNavOracle.
//
// This replaces nav-heartbeat.js's echo behavior with REAL price-aware NAV.
// Until the trader actually holds basket tokens (HYPE/BTC/ETH spot positions
// on HC), the trader will only have USDC there → NAV = USDC balance / shares.
// Once basket trading lands, this script automatically picks up the new
// holdings without a code change.
//
// Run via pm2 cron every 10 min (replaces nav-heartbeat). One-shot per call.

"use strict";

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const ORACLE_ABI = [
  "function pushNav(uint64 basketId, uint256 navUsd6)",
  "function baskets(uint64) view returns (bool registered, uint256 lastNavUsd6, uint64 lastNavAt, uint32 maxStalenessSecs, uint16 maxDriftBps, bool paused, string name)",
  "function nextBasketId() view returns (uint64)",
];

function log(level, msg, fields = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level, step: "nav-from-hc", msg, ...fields,
  }));
}

async function fetchSpotMarkPrices(info) {
  // spotMetaAndAssetCtxs returns prices for all spot pairs paired with USDC.
  // We map them to coin symbol → USD-equivalent mark price.
  const data = await info.spotMetaAndAssetCtxs();
  const meta = data[0];   // SpotMeta
  const ctxs = data[1];   // SpotAssetCtx[] — markPx is string
  const priceByCoin = { USDC: 1.0 };
  for (const universe of meta.universe) {
    // universe entry: { name, tokens: [baseTokenIdx, quoteTokenIdx], index }
    const baseTokIdx = universe.tokens?.[0];
    const quoteTokIdx = universe.tokens?.[1];
    const baseTok  = meta.tokens[baseTokIdx];
    const quoteTok = meta.tokens[quoteTokIdx];
    if (!baseTok || !quoteTok || quoteTok.name !== "USDC") continue;
    const ctx = ctxs[universe.index];
    if (!ctx?.markPx) continue;
    priceByCoin[baseTok.name] = parseFloat(ctx.markPx);
  }
  return priceByCoin;
}

async function fetchSpotHoldings(info, address) {
  const state = await info.spotClearinghouseState({ user: address });
  const out = {};
  for (const b of state.balances ?? []) {
    out[b.coin] = parseFloat(b.total);
  }
  return out;
}

/// Compute USD NAV (returned as 6-dec USDC integer) from holdings + prices.
/// If trader has only USDC and no basket tokens yet, NAV ≈ USDC balance.
function computeNavUsd6(holdings, prices) {
  let usd = 0;
  for (const [coin, qty] of Object.entries(holdings)) {
    const px = prices[coin];
    if (px == null) continue; // skip unknown tokens
    usd += qty * px;
  }
  // Round to 6-dec
  return BigInt(Math.round(usd * 1e6));
}

async function main() {
  const rpc = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
  const oracleAddr = process.env.NAV_ORACLE_ADDR;
  const trader = process.env.TRADER_HC_ADDR;
  if (!oracleAddr) throw new Error("NAV_ORACLE_ADDR not set");
  if (!trader) throw new Error("TRADER_HC_ADDR not set");

  const provider = new ethers.JsonRpcProvider(rpc);
  const keeper = new ethers.Wallet(process.env.HC_KEEPER_KEY, provider);
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, keeper);

  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });

  log("info", "start", { keeper: keeper.address, oracle: oracleAddr, trader });

  // Load prices + trader holdings
  const [prices, holdings] = await Promise.all([
    fetchSpotMarkPrices(info),
    fetchSpotHoldings(info, trader),
  ]);
  log("info", "trader holdings", holdings);

  const navTotal = computeNavUsd6(holdings, prices);
  log("info", "computed nav", { totalUsd6: navTotal.toString(), prices });

  // Push for every basket — for now we have one (basket 0 = HyperCore) and
  // its NAV is the trader's wallet value. When we add Pool G/H baskets we
  // can either give each its own trader EOA, or namespace holdings via
  // sub-accounts and split the NAV per basket here.
  const nextId = Number(await oracle.nextBasketId());
  for (let i = 0; i < nextId; i++) {
    const b = await oracle.baskets(i);
    if (!b.registered || b.paused) continue;

    // Drift-cap protection: reject if computed NAV would exceed the
    // configured maxDriftBps vs the last push. Fall back to last NAV in
    // that case (echo) and warn — operator should investigate.
    const last = b.lastNavUsd6;
    let toPush = navTotal;
    if (last !== 0n && navTotal !== 0n) {
      const diff = navTotal > last ? navTotal - last : last - navTotal;
      const driftBps = (diff * 10_000n) / last;
      if (driftBps > BigInt(b.maxDriftBps)) {
        log("warn", "drift cap would trip — echoing last", {
          basketId: i, last: last.toString(), computed: navTotal.toString(),
          driftBps: driftBps.toString(), capBps: b.maxDriftBps.toString(),
        });
        toPush = last;
      }
    }
    // Skip if first push and we computed 0 (trader has nothing yet)
    if (toPush === 0n && last === 0n) {
      log("info", "no holdings yet — skip push (oracle still has 0)", { basketId: i });
      continue;
    }
    if (toPush === 0n) toPush = last; // never push 0 if we ever had a value

    const tx = await oracle.pushNav(i, toPush);
    await tx.wait();
    log("info", "pushed", { basketId: i, navUsd6: toPush.toString(), txHash: tx.hash });
  }

  log("info", "done");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
