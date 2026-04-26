// ═══════════════════════════════════════════════════════════════════════
//  HLP HyperCore Keeper v2 (nudger) — chain 999 (HyperEVM).
//
//  Speaks to HLPAdapterHCv2. The v2 adapter inserts the spot↔perp class
//  transfer hops that v1 missed, so the withdraw path is now five steps
//  instead of three.
//
//  Custody model: NONE. The adapter signs all HyperCore actions via
//  CoreWriter. This keeper only calls the adapter's state-machine entry
//  points once on-chain precompile reads show HC state has caught up.
//
//  Cycle (idempotent; safe to re-run):
//    settleInbound  : inFlightToHC > 0 && equity grew        → confirmDeposit
//    triggerWithdraw: WITHDRAW_USD set and lockup elapsed    → initiateHCWithdraw
//    syncPerpToSpot : inFlightFromHC > 0 && perp has USDC    → syncPerpToSpot
//    sweep          : inFlightFromHC > 0 && spot has USDC    → sweepFromCore
//    settleReturn   : inFlightFromHC > 0 && EVM USDC grew    → confirmReturn
//
//  Environment:
//    HYPEREVM_RPC              HyperEVM RPC (default https://rpc.hyperliquid.xyz/evm)
//    HC_KEEPER_KEY             Keeper signer (KEEPER_ROLE). No custody.
//    HLP_ADAPTER_ADDR          Deployed HLPAdapterHCv2 on HyperEVM.
//    WITHDRAW_USD              Optional: trigger a withdraw of N (6-dec raw).
// ═══════════════════════════════════════════════════════════════════════

"use strict";
// Load Pool E env first (HC_KEEPER_KEY, HLP_ADAPTER_ADDR, HYPEREVM_RPC live here),
// then fall back to ambient .env for shared keys.
require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();

const { ethers } = require("ethers");

const HL_EVM_RPC_DEFAULT = "https://rpc.hyperliquid.xyz/evm";

const ADAPTER_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function idleUsdc() view returns (uint256)",
  "function inFlightToHC() view returns (uint256)",
  "function inFlightFromHC() view returns (uint256)",
  "function reportedHCEquity() view returns (uint64)",
  "function reportedPerpUsdc() view returns (uint64)",
  "function reportedSpotUsdc() view returns (uint64)",
  "function lockupUnlockAtMs() view returns (uint64)",
  "function lastHCDepositAt() view returns (uint256)",
  "function confirmDeposit(uint256) external",
  "function initiateHCWithdraw(uint64) external",
  "function syncPerpToSpot(uint64) external",
  "function sweepFromCore(uint64) external",
  "function confirmReturn(uint256) external",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function log(level, step, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...data }));
}

// Convert any BigInt values in a plain object to strings so JSON.stringify doesn't blow up.
function toJsonSafe(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = (typeof v === "bigint") ? v.toString() : v;
  }
  return out;
}

// ─────────── Cycles ───────────

async function settleInboundCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightToHC();
  if (inFlight === 0n) return;
  const equity = await adapter.reportedHCEquity();
  if (equity >= inFlight) {
    log("info", "inbound", "confirming deposit",
      toJsonSafe({ amount: inFlight, equity }));
    await (await adapter.confirmDeposit(inFlight)).wait();
  } else {
    log("info", "inbound", "waiting for HLP to reflect",
      toJsonSafe({ inFlight, equity }));
  }
}

async function triggerWithdrawCycle(ctx) {
  const { adapter } = ctx;
  if (ctx.withdrawUsd === 0n) return;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight > 0n) {
    log("info", "withdraw", "skip — withdraw already in flight",
      toJsonSafe({ inFlight }));
    return;
  }
  const unlockMs = await adapter.lockupUnlockAtMs();
  const nowMs = BigInt(Date.now());
  if (unlockMs > 0n && nowMs < unlockMs) {
    log("info", "withdraw", "skip — HLP lockup active",
      toJsonSafe({ unlockMs, nowMs }));
    return;
  }
  const equity = await adapter.reportedHCEquity();
  if (equity < ctx.withdrawUsd) {
    log("warn", "withdraw", "requested > reported equity",
      toJsonSafe({ equity, requested: ctx.withdrawUsd }));
    return;
  }
  log("info", "withdraw", "initiating HC withdraw",
    toJsonSafe({ amount: ctx.withdrawUsd }));
  await (await adapter.initiateHCWithdraw(ctx.withdrawUsd)).wait();
}

/// HLP→perp has landed. Move perp→spot so sweepFromCore can pull from spot.
async function syncPerpToSpotCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;
  const perp = await adapter.reportedPerpUsdc();
  if (perp === 0n) {
    log("info", "perp-sync", "waiting — perp empty (vaultTransfer not landed yet)");
    return;
  }
  // Move the smaller of (perp balance, in-flight). Partial is fine; we loop.
  const amount = perp > inFlight ? inFlight : perp;
  log("info", "perp-sync", "moving perp → spot",
    toJsonSafe({ amount, perp, inFlight }));
  await (await adapter.syncPerpToSpot(amount)).wait();
}

/// perp→spot has landed. Bridge spot→EVM.
async function sweepCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;
  const spot = await adapter.reportedSpotUsdc();
  if (spot === 0n) {
    log("info", "sweep", "waiting — spot empty (syncPerpToSpot not landed yet)");
    return;
  }
  const amount = spot > inFlight ? inFlight : spot;
  log("info", "sweep", "bridging HC → EVM",
    toJsonSafe({ amount, spot, inFlight }));
  await (await adapter.sweepFromCore(amount)).wait();
}

async function settleReturnCycle(ctx) {
  const { adapter, usdc, adapterAddr } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;
  const idle = await usdc.balanceOf(adapterAddr);
  const delta = idle - ctx.baselineIdle;
  if (delta >= inFlight) {
    log("info", "return", "confirming return",
      toJsonSafe({ amount: inFlight, delta }));
    await (await adapter.confirmReturn(inFlight)).wait();
    ctx.baselineIdle = idle;
  } else if (delta > 0n) {
    // Partial: confirm what landed, keep remainder in flight.
    log("info", "return", "confirming partial return",
      toJsonSafe({ confirming: delta, inFlight }));
    await (await adapter.confirmReturn(delta)).wait();
    ctx.baselineIdle = idle;
  } else {
    log("info", "return", "waiting — EVM balance not grown yet");
  }
}

// ─────────── Entrypoint ───────────

async function main() {
  const rpc = process.env.HYPEREVM_RPC || HL_EVM_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(process.env.HC_KEEPER_KEY, provider);
  const adapterAddr = process.env.HLP_ADAPTER_ADDR;
  if (!adapterAddr) throw new Error("HLP_ADAPTER_ADDR not set");

  const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, signer);
  const usdcAddr = await adapter.asset();
  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, provider);

  const baselineIdle = await usdc.balanceOf(adapterAddr);
  const withdrawUsd = process.env.WITHDRAW_USD ? BigInt(process.env.WITHDRAW_USD) : 0n;

  const ctx = {
    adapter, adapterAddr, signer, usdc,
    withdrawUsd, baselineIdle,
  };

  log("info", "keeper", "starting",
    { keeper: await signer.getAddress(), adapter: adapterAddr, rpc });

  const cycles = [
    settleInboundCycle,
    triggerWithdrawCycle,
    syncPerpToSpotCycle,
    sweepCycle,
    settleReturnCycle,
  ];
  for (const fn of cycles) {
    try {
      await fn(ctx);
    } catch (e) {
      log("warn", fn.name, "failed", { error: e.message });
    }
  }

  log("info", "keeper", "done");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
