// ═══════════════════════════════════════════════════════════════════════
//  Lending liquidation bot — chain 42161 (Arbitrum).
//
//  Walks every active loan in the LendingPool, triggers liquidation when
//  health crosses the per-collection threshold, completes liquidations
//  whose vault unwind has settled (≥ 30 min after trigger).
//
//  Both triggerLiquidation() and completeLiquidation() are permissionless,
//  so this script doesn't need any on-chain role — just ETH for gas.
//  Each cycle is idempotent: if a loan is already LIQUIDATING the trigger
//  branch is a no-op; if not enough time has passed for completion the
//  call reverts and we skip to the next loanId.
//
//  Environment:
//    ARB_RPC                Arbitrum RPC (default https://arb1.arbitrum.io/rpc)
//    HC_KEEPER_KEY          Signer (any EOA with ETH)
//    LENDING_POOL_ADDR      LendingPool address
//    SETTLE_DELAY_SEC       Min seconds between trigger and complete attempt (default 1800 = 30min)
//    DRY_RUN                "1" = log decisions but don't send txs
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();

const { ethers } = require("ethers");

const ARB_RPC_DEFAULT = "https://arb1.arbitrum.io/rpc";
const SETTLE_DELAY_DEFAULT = 1800; // matches V15 ShadowVaultV15.withdrawTimeout

const POOL_ABI = [
  "function nextLoanId() view returns (uint256)",
  "function loans(uint256) view returns (address borrower, address nft, uint256 tokenId, uint256 principal, uint256 lastAccrualTime, uint256 startTime, uint256 accruedFeesUnpaid, uint16 yieldRepayBps, uint8 status)",
  "function loanHealthBps(uint256) view returns (uint256)",
  "function liquidationThresholdFor(address) view returns (uint16)",
  "function minLoanDuration() view returns (uint256)",
  "function triggerLiquidation(uint256) external",
  "function completeLiquidation(uint256) external",
  "event LiquidationTriggered(uint256 indexed loanId, address indexed caller, uint256 healthBps, uint256 thresholdBps)",
];

const STATUS = { NONE: 0, ACTIVE: 1, LIQUIDATING: 2, CLOSED: 3 };

function log(level, step, msg, data = {}) {
  const safe = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    safe[k] = (typeof v === "bigint") ? v.toString() : v;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...safe }));
}

/// Find when a loan moved from ACTIVE→LIQUIDATING by scanning recent
/// LiquidationTriggered events. Returns unix seconds, or null if not found
/// in the recent window (safe — we just retry next cycle).
async function findTriggerTimestamp(pool, provider, loanId, fromBlock) {
  try {
    const filter = pool.filters.LiquidationTriggered(loanId);
    const events = await pool.queryFilter(filter, fromBlock, "latest");
    if (events.length === 0) return null;
    // Use the latest matching event.
    const ev = events[events.length - 1];
    const block = await provider.getBlock(ev.blockNumber);
    return block.timestamp;
  } catch (e) {
    log("warn", "trigger-ts", "queryFilter failed", { loanId: String(loanId), error: e.message });
    return null;
  }
}

async function processLoan(ctx, loanId) {
  const { pool, provider, dryRun, settleDelay, fromBlock } = ctx;
  const l = await pool.loans(loanId);
  const status = Number(l.status);

  if (status === STATUS.NONE || status === STATUS.CLOSED) return;

  const nft = l.nft;
  const principal = l.principal;
  const startTime = Number(l.startTime);

  if (status === STATUS.ACTIVE) {
    // Check minLoanDuration window first to skip obvious no-ops.
    const minDur = Number(await pool.minLoanDuration());
    const now = Math.floor(Date.now() / 1000);
    if (now < startTime + minDur) {
      log("info", "scan", "skip — within minLoanDuration", { loanId: String(loanId) });
      return;
    }

    let health, threshold;
    try {
      [health, threshold] = await Promise.all([
        pool.loanHealthBps(loanId),
        pool.liquidationThresholdFor(nft),
      ]);
    } catch (e) {
      log("warn", "health", "read failed; skip", { loanId: String(loanId), error: e.message });
      return;
    }

    if (health <= threshold) {
      log("info", "scan", "healthy",
        { loanId: String(loanId), health: String(health), threshold: String(threshold) });
      return;
    }

    log("warn", "trigger", "loan unhealthy → triggerLiquidation",
      { loanId: String(loanId), health: String(health), threshold: String(threshold), principal: principal.toString() });
    if (dryRun) return;

    try {
      const tx = await pool.triggerLiquidation(loanId);
      log("info", "trigger", "tx", { loanId: String(loanId), hash: tx.hash });
      const rc = await tx.wait();
      log("info", "trigger", "mined", { loanId: String(loanId), block: rc.blockNumber });
    } catch (e) {
      log("error", "trigger", "tx reverted", { loanId: String(loanId), error: e.message });
    }
    return;
  }

  if (status === STATUS.LIQUIDATING) {
    // Look up when trigger fired; only try complete after settle delay.
    const triggerTs = await findTriggerTimestamp(pool, provider, loanId, fromBlock);
    const now = Math.floor(Date.now() / 1000);
    const ready = triggerTs !== null
      ? now >= triggerTs + settleDelay
      : true; // if we can't find the event, fall back to attempting and letting the vault revert

    if (!ready) {
      log("info", "complete", "skip — vault not yet settled",
        { loanId: String(loanId), triggerTs, now, eta: triggerTs + settleDelay });
      return;
    }

    log("info", "complete", "attempting completeLiquidation", { loanId: String(loanId) });
    if (dryRun) return;

    try {
      const tx = await pool.completeLiquidation(loanId);
      log("info", "complete", "tx", { loanId: String(loanId), hash: tx.hash });
      const rc = await tx.wait();
      log("info", "complete", "mined", { loanId: String(loanId), block: rc.blockNumber });
    } catch (e) {
      // Most likely cause: vault.completeWithdraw rejecting because the
      // 30-min vault timeout hasn't actually elapsed (RPC clock drift)
      // OR the vault hasn't been told to release yet. Will retry next cycle.
      log("warn", "complete", "tx reverted (will retry)", { loanId: String(loanId), error: e.message });
    }
  }
}

async function main() {
  const rpc = process.env.ARB_RPC || ARB_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(process.env.HC_KEEPER_KEY, provider);
  const poolAddr = process.env.LENDING_POOL_ADDR;
  if (!poolAddr) throw new Error("LENDING_POOL_ADDR not set");
  const pool = new ethers.Contract(poolAddr, POOL_ABI, signer);

  const settleDelay = Number(process.env.SETTLE_DELAY_SEC || SETTLE_DELAY_DEFAULT);
  const dryRun = process.env.DRY_RUN === "1";

  // Bound the LiquidationTriggered scan window to last ~7 days (avoids
  // huge log scans). Arb has ~250M blocks per year; 7 days ≈ 4.8M.
  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(0, head - 5_000_000);

  const next = await pool.nextLoanId();
  const total = Number(next - 1n);
  log("info", "start", "scanning",
    { keeper: await signer.getAddress(), pool: poolAddr, totalLoans: total, dryRun, fromBlock });

  if (total === 0) {
    log("info", "start", "no loans yet — exit");
    return;
  }

  const ctx = { pool, provider, dryRun, settleDelay, fromBlock };
  for (let i = 1n; i <= BigInt(total); i++) {
    try {
      await processLoan(ctx, i);
    } catch (e) {
      log("error", "loan", "uncaught error", { loanId: String(i), error: e.message });
    }
  }

  log("info", "done", "cycle complete");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
