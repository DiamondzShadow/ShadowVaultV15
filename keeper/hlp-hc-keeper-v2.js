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
//    triggerWithdraw: WITHDRAW_USD set OR auto-buffer short  → initiateHCWithdraw
//    syncPerpToSpot : inFlightFromHC > 0 && perp has USDC    → syncPerpToSpot
//    sweep          : inFlightFromHC > 0 && spot has USDC    → sweepFromCore
//    settleReturn   : inFlightFromHC > 0 && EVM USDC grew    → confirmReturn
//
//  Auto-buffer mode: when WITHDRAW_USD env is unset, the keeper maintains
//  a small idle reserve on the adapter (default $100, configurable via
//  MIN_IDLE_BUFFER_USD) so user withdraws don't routinely hit the
//  AdapterPartialWithdraw revert. Most retail-sized withdraws fit
//  comfortably under the buffer; if the buffer drains, the keeper
//  initiates a fresh HC→EVM unwind on the next cron tick.
//
//  Environment:
//    HYPEREVM_RPC              HyperEVM RPC (default https://rpc.hyperliquid.xyz/evm)
//    HC_KEEPER_KEY             Keeper signer (KEEPER_ROLE). No custody.
//    HLP_ADAPTER_ADDR          Deployed HLPAdapterHCv2 on HyperEVM.
//    WITHDRAW_USD              Optional: explicit unwind target (6-dec raw).
//                              Overrides auto-buffer when set.
//    MIN_IDLE_BUFFER_USD       Auto-buffer floor in 6-dec (default 100_000_000 = $100).
//    BUFFER_MODE               "auto" (default) | "off" — set "off" to require
//                              explicit WITHDRAW_USD on every unwind.
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
  const { adapter, usdc, adapterAddr } = ctx;

  // Compute the unwind target. Explicit WITHDRAW_USD wins; otherwise auto-
  // buffer mode tops up idle so user withdraws don't routinely revert with
  // AdapterPartialWithdraw. With both unset/off, the keeper no-ops on the
  // unwind side (legacy behaviour).
  let target = ctx.withdrawUsd;
  let mode = "explicit";
  if (target === 0n && ctx.bufferMode === "auto") {
    const idle = await usdc.balanceOf(adapterAddr);
    const inFlight = await adapter.inFlightFromHC();
    const queued = idle + inFlight;
    if (queued < ctx.minIdleBufferUsd) {
      const shortfall = ctx.minIdleBufferUsd - queued;
      const equity = await adapter.reportedHCEquity();
      // Can't unwind more than HLP equity actually holds.
      target = shortfall > equity ? equity : shortfall;
      mode = "auto-buffer";
      if (target === 0n) {
        log("info", "withdraw", "auto-buffer skip — no HC equity to unwind",
          toJsonSafe({ idle, inFlight, target_buffer: ctx.minIdleBufferUsd, equity }));
        return;
      }
      log("info", "withdraw", "auto-buffer top-up planned",
        toJsonSafe({ idle, inFlight, target_buffer: ctx.minIdleBufferUsd, shortfall, planning: target }));
    } else {
      log("info", "withdraw", "auto-buffer satisfied — no action",
        toJsonSafe({ idle, inFlight, target_buffer: ctx.minIdleBufferUsd }));
      return;
    }
  }
  if (target === 0n) return;

  const inFlight = await adapter.inFlightFromHC();
  if (inFlight > 0n) {
    log("info", "withdraw", "skip — withdraw already in flight",
      toJsonSafe({ inFlight, mode }));
    return;
  }
  const unlockMs = await adapter.lockupUnlockAtMs();
  const nowMs = BigInt(Date.now());
  if (unlockMs > 0n && nowMs < unlockMs) {
    log("info", "withdraw", "skip — HLP lockup active",
      toJsonSafe({ unlockMs, nowMs, mode }));
    return;
  }
  const equity = await adapter.reportedHCEquity();
  if (equity < target) {
    log("warn", "withdraw", "requested > reported equity",
      toJsonSafe({ equity, requested: target, mode }));
    return;
  }
  log("info", "withdraw", "initiating HC withdraw",
    toJsonSafe({ amount: target, mode }));
  await (await adapter.initiateHCWithdraw(target)).wait();
}

/// HLP→perp has landed. Move perp→spot so sweepFromCore can pull from spot.
///
/// Both perp (PrecompileLib.withdrawable) and inFlightFromHC are in HC perp's
/// USDC 6-decimal unit, so the comparison is unit-correct.
///
/// Catch-up retry: HLP→perp vaultTransfer is processed by validators across
/// the next 1-2 HC blocks. If we observe perp < inFlight, the previous
/// vaultTransfer is still mid-processing. Poll up to PERP_CATCHUP_TRIES so a
/// single keeper run completes the unwind instead of bailing and forcing the
/// operator to wait for the next cron tick.
const PERP_CATCHUP_TRIES = 6;        // up to 6 reads
const PERP_CATCHUP_INTERVAL_MS = 5_000;  // 5s apart → ~30s total

async function syncPerpToSpotCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;

  let perp = await adapter.reportedPerpUsdc();

  // Wait for the HLP→perp vaultTransfer to fully land if it's still arriving.
  // Without this, a 2-block validator delay would force us to bail mid-unwind
  // and re-fire on the next cron, wasting up to 3 hours of user time.
  let tries = 0;
  while (perp < inFlight && tries < PERP_CATCHUP_TRIES) {
    log("info", "perp-sync", "waiting for HLP→perp catch-up",
      toJsonSafe({ perp, inFlight, attempt: tries + 1, of: PERP_CATCHUP_TRIES }));
    await new Promise((r) => setTimeout(r, PERP_CATCHUP_INTERVAL_MS));
    perp = await adapter.reportedPerpUsdc();
    tries++;
  }

  if (perp === 0n) {
    log("info", "perp-sync", "still empty after catch-up — bail, next cron will retry");
    return;
  }

  // Move the smaller of (perp balance, in-flight). Partial is fine; we loop.
  const amount = perp > inFlight ? inFlight : perp;
  log("info", "perp-sync", "moving perp → spot",
    toJsonSafe({ amount, perp, inFlight }));
  await (await adapter.syncPerpToSpot(amount)).wait();
}

/// perp→spot has landed. Bridge spot→EVM.
///
/// HC spot USDC uses **8 decimals** (HC token registry, token index 0); EVM
/// USDC uses 6. inFlightFromHC + sweepFromCore's arg use 6-dec. We must
/// rescale spot to 6-dec before comparing, otherwise `min(spot, inFlight)`
/// can pick `inFlight` when spot doesn't actually cover it (e.g. spot $3 in
/// 8-dec is 3e8, > 16e6 inFlight, → keeper tries to bridge $16 from a $3
/// balance → validators reject and inFlightFromHC stays stuck).
const HC_SPOT_TO_EVM_USDC = 100n;   // 10^(8-6); converts 8-dec spot → 6-dec

async function sweepCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;

  const spot8 = await adapter.reportedSpotUsdc();         // 8-dec
  const spot6 = spot8 / HC_SPOT_TO_EVM_USDC;              // 6-dec equivalent

  if (spot6 === 0n) {
    log("info", "sweep", "waiting — spot has no USDC (in 6-dec equivalent)",
      toJsonSafe({ spot8 }));
    return;
  }

  // Bridge the smaller of (spot 6-dec equivalent, in-flight 6-dec).
  // sweepFromCore takes the EVM-side amount in 6-dec; the adapter's
  // CoreWriterLib.bridgeToEvm converts to HC 8-dec internally.
  const amount = spot6 > inFlight ? inFlight : spot6;
  log("info", "sweep", "bridging HC → EVM",
    toJsonSafe({ amount, spot8, spot6, inFlight }));
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
  const minIdleBufferUsd = process.env.MIN_IDLE_BUFFER_USD
    ? BigInt(process.env.MIN_IDLE_BUFFER_USD)
    : 100_000_000n; // $100 default (6-dec)
  const bufferMode = (process.env.BUFFER_MODE || "auto").toLowerCase();

  const ctx = {
    adapter, adapterAddr, signer, usdc,
    withdrawUsd, baselineIdle,
    minIdleBufferUsd, bufferMode,
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
