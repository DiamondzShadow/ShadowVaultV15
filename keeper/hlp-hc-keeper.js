// ═══════════════════════════════════════════════════════════════════════
//  HLP HyperCore Keeper (nudger) — chain 999 (HyperEVM).
//
//  Custody model: NONE. The HLPAdapterHC contract signs all HyperCore
//  actions via CoreWriter directly. This keeper only calls the adapter's
//  state-transition methods (confirmDeposit / initiateHCWithdraw /
//  sweepFromCore / confirmReturn) once it observes that HC state has
//  caught up with the adapter's in-flight counters.
//
//  Triggers:
//    - `inFlightToHC > 0`  AND  precompile equity grew by ≥ inFlightToHC
//        → call confirmDeposit(inFlightToHC)
//    - `inFlightFromHC > 0`, withdraw action emitted, HC spot balance of
//        adapter shows the unwound USDC
//        → call sweepFromCore(hcSpotBal)
//    - `inFlightFromHC > 0` and adapter EVM USDC balance grew by >= hcSpotBal
//        → call confirmReturn(delta)
//    - WITHDRAW_USD env var set
//        → call initiateHCWithdraw(WITHDRAW_USD) once lockup has elapsed
//
//  Environment:
//    HYPEREVM_RPC              HyperEVM RPC (default https://rpc.hyperliquid.xyz/evm)
//    HC_KEEPER_KEY             Keeper signer key (KEEPER_ROLE on adapter). HOLDS HYPE, NOT USDC.
//    HLP_ADAPTER_ADDR          Deployed HLPAdapterHC on HyperEVM
//    WITHDRAW_USD              Optional: trigger a withdraw of N (6-dec raw) USDC
//    HL_API                    HyperCore REST (default https://api.hyperliquid.xyz)
//                              Used to verify HC spot balance of adapter before sweep.
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");

// ─────────── Constants ───────────
const HL_EVM_RPC_DEFAULT = "https://rpc.hyperliquid.xyz/evm";
const POLL_MS            = 15_000;
const ADAPTER_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function idleUsdc() view returns (uint256)",
  "function inFlightToHC() view returns (uint256)",
  "function inFlightFromHC() view returns (uint256)",
  "function reportedHCEquity() view returns (uint64)",
  "function lockupUnlockAtMs() view returns (uint64)",
  "function lastHCDepositAt() view returns (uint256)",
  "function confirmDeposit(uint256) external",
  "function initiateHCWithdraw(uint64) external",
  "function sweepFromCore(uint64) external",
  "function confirmReturn(uint256) external",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

// ─────────── Logging ───────────
function log(level, step, msg, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level, step, msg, ...data,
  }));
}

// ─────────── HC spot USDC via REST ───────────
async function readHCSpotUsdc(info, user) {
  const state = await info.spotClearinghouseState({ user });
  const balances = state && state.balances ? state.balances : [];
  for (const b of balances) {
    if (b.coin === "USDC") {
      const [whole, frac = ""] = String(b.total).split(".");
      const fracPadded = (frac + "000000").slice(0, 6);
      return BigInt(whole) * 1_000_000n + BigInt(fracPadded || "0");
    }
  }
  return 0n;
}

// ─────────── Cycles ───────────

/// If a deposit is in flight and the precompile equity reflects it, ack.
async function settleInboundCycle(ctx) {
  const { adapter } = ctx;
  const inFlight = await adapter.inFlightToHC();
  if (inFlight === 0n) return;
  const equity = await adapter.reportedHCEquity();
  if (equity >= inFlight) {
    log("info", "inbound", "confirming deposit",
      { amount: inFlight.toString(), equity: equity.toString() });
    await (await adapter.confirmDeposit(inFlight)).wait();
  } else {
    log("info", "inbound", "waiting for HC to reflect",
      { inFlight: inFlight.toString(), equity: equity.toString() });
  }
}

/// If `WITHDRAW_USD` requested and lockup elapsed, queue a vault unwind.
async function triggerWithdrawCycle(ctx) {
  const { adapter } = ctx;
  if (ctx.withdrawUsd === 0n) return;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight > 0n) {
    log("info", "withdraw", "skip — withdraw already in flight",
      { inFlight: inFlight.toString() });
    return;
  }
  const unlockMs = await adapter.lockupUnlockAtMs();
  const nowMs = BigInt(Date.now());
  if (unlockMs > 0n && nowMs < unlockMs) {
    log("info", "withdraw", "skip — HLP lockup active",
      { unlockMs: unlockMs.toString(), nowMs: nowMs.toString() });
    return;
  }
  const equity = await adapter.reportedHCEquity();
  if (equity < ctx.withdrawUsd) {
    log("warn", "withdraw", "requested > reported equity",
      { equity: equity.toString(), requested: ctx.withdrawUsd.toString() });
    return;
  }
  log("info", "withdraw", "initiating HC withdraw",
    { amount: ctx.withdrawUsd.toString() });
  await (await adapter.initiateHCWithdraw(ctx.withdrawUsd)).wait();
}

/// If a withdraw is in flight and HC spot reflects the unwind, bridge it back.
async function sweepCycle(ctx) {
  const { adapter, info } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;
  const adapterAddr = await adapter.getAddress();
  const hcSpot = await readHCSpotUsdc(info, adapterAddr).catch(() => 0n);
  if (hcSpot === 0n) {
    log("info", "sweep", "waiting — HC spot empty");
    return;
  }
  // Bridge back whatever is there (up to in-flight amount).
  const amount = hcSpot > inFlight ? inFlight : hcSpot;
  log("info", "sweep", "bridging HC → EVM",
    { amount: amount.toString(), hcSpot: hcSpot.toString() });
  await (await adapter.sweepFromCore(amount)).wait();
}

/// If adapter's EVM USDC balance grew by >= in-flight, ack the return.
async function settleReturnCycle(ctx) {
  const { adapter, usdc, baselineIdle } = ctx;
  const inFlight = await adapter.inFlightFromHC();
  if (inFlight === 0n) return;
  const adapterAddr = await adapter.getAddress();
  const idle = await usdc.balanceOf(adapterAddr);
  const delta = idle - baselineIdle;
  if (delta >= inFlight) {
    log("info", "return", "confirming return",
      { amount: inFlight.toString(), delta: delta.toString() });
    await (await adapter.confirmReturn(inFlight)).wait();
    ctx.baselineIdle = idle;
  } else if (delta > 0n) {
    log("info", "return", "partial return, deferring",
      { delta: delta.toString(), inFlight: inFlight.toString() });
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

  // Read the initial idle balance so we can detect growth from HC returns.
  const baselineIdle = await usdc.balanceOf(adapterAddr);

  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });

  const withdrawUsd = process.env.WITHDRAW_USD ? BigInt(process.env.WITHDRAW_USD) : 0n;

  const ctx = {
    adapter, adapterAddr, signer, usdc,
    info, withdrawUsd, baselineIdle,
  };

  log("info", "keeper", "starting",
    { keeper: await signer.getAddress(), adapter: adapterAddr, rpc });

  // One pass per invocation. The pm2 cron re-runs every 3 hours (or set
  // POLL_MS-based loop below by running with a wrapper).
  const cycles = [
    settleInboundCycle,
    triggerWithdrawCycle,
    sweepCycle,
    settleReturnCycle,
  ];
  for (const fn of cycles) {
    try { await fn(ctx); }
    catch (e) { log("warn", fn.name, "failed", { error: e.message }); }
  }

  log("info", "keeper", "done");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
