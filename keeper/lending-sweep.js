// ═══════════════════════════════════════════════════════════════════════
//  Lending sweep keeper — chain 42161 (Arbitrum).
//
//  Job 1 (auto):  call SweepController.rebalance() periodically. Moves
//                 idle USDC into Aave V3 (sync leg) per target weight.
//                 Aave deposits/withdrawals settle in the same tx.
//
//  Job 2 (semi-auto):  watch RemoteDeposited / RemoteWithdrawRequested
//                 events from HyperRemoteMirror. The Hyper leg is async
//                 (Bridge2 + 4-day HLP lockup), so this v1 only LOGS the
//                 work the operator needs to do off-chain. A future v1.1
//                 wires direct CCIP / native bridge automation.
//
//  Environment:
//    ARB_RPC                Arbitrum RPC
//    HC_KEEPER_KEY          Keeper signer (KEEPER_ROLE on SweepController)
//    SWEEP_CONTROLLER_ADDR  SweepController address
//    HYPER_REMOTE_MIRROR_ADDR  HyperRemoteMirror address (for event scan)
//    DRY_RUN                "1" = log decisions but don't send txs
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();

const { ethers } = require("ethers");

const ARB_RPC_DEFAULT = "https://arb1.arbitrum.io/rpc";

const SWEEP_ABI = [
  "function rebalance() external",
  "function totalAssets() view returns (uint256)",
  "function reserveBps() view returns (uint16)",
  "function aaveBps() view returns (uint16)",
  "function remoteBps() view returns (uint16)",
  "function minMoveUSDC() view returns (uint256)",
];

const MIRROR_ABI = [
  "function mirrored() view returns (uint256)",
  "function pendingOutbound() view returns (uint256)",
  "function pendingInbound() view returns (uint256)",
  "event RemoteDeposited(address indexed caller, uint256 amount, uint256 pendingOutbound)",
  "event RemoteWithdrawRequested(address indexed caller, uint256 amount, uint256 pendingInbound)",
];

function log(level, step, msg, data = {}) {
  const safe = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    safe[k] = (typeof v === "bigint") ? v.toString() : v;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...safe }));
}

async function rebalanceCycle(ctx) {
  const { sweep, dryRun } = ctx;
  const [total, reserveBps, aaveBps, remoteBps, minMove] = await Promise.all([
    sweep.totalAssets(),
    sweep.reserveBps(),
    sweep.aaveBps(),
    sweep.remoteBps(),
    sweep.minMoveUSDC(),
  ]);

  log("info", "rebalance", "snapshot",
    { totalAssets: total, reserveBps: Number(reserveBps), aaveBps: Number(aaveBps),
      remoteBps: Number(remoteBps), minMove });

  if (total === 0n) {
    log("info", "rebalance", "skip — empty controller");
    return;
  }
  if (dryRun) return;

  try {
    const tx = await sweep.rebalance();
    log("info", "rebalance", "tx", { hash: tx.hash });
    const rc = await tx.wait();
    log("info", "rebalance", "mined", { block: rc.blockNumber, gas: rc.gasUsed.toString() });
  } catch (e) {
    log("warn", "rebalance", "tx reverted", { error: e.message });
  }
}

/// Scan recent RemoteDeposited events. For each pending entry, log what the
/// operator needs to do next: bridge USDC Arb→HC + deposit to Pool E v2 +
/// HyperRemoteMirror.confirmDeposit.
async function watchRemoteEvents(ctx) {
  const { mirror, provider, fromBlock } = ctx;
  const [pendingOut, pendingIn] = await Promise.all([
    mirror.pendingOutbound(),
    mirror.pendingInbound(),
  ]);

  log("info", "remote", "state",
    { pendingOutbound: pendingOut, pendingInbound: pendingIn });

  if (pendingOut > 0n) {
    log("warn", "operator", "MANUAL — bridge USDC Arb→HyperEVM, deposit Pool E v2, call mirror.confirmDeposit",
      { pendingOutbound: pendingOut });
  }
  if (pendingIn > 0n) {
    log("warn", "operator", "MANUAL — Pool E v2.requestWithdraw → wait 4-day HLP lockup → bridge HC→Arb → mirror.confirmReturn(amount, controller)",
      { pendingInbound: pendingIn });
  }

  // Surface the most recent events to ease operator triage.
  try {
    const dEvents = await mirror.queryFilter(mirror.filters.RemoteDeposited(), fromBlock, "latest");
    const wEvents = await mirror.queryFilter(mirror.filters.RemoteWithdrawRequested(), fromBlock, "latest");
    if (dEvents.length > 0) {
      const last = dEvents[dEvents.length - 1];
      log("info", "remote", "last RemoteDeposited",
        { block: last.blockNumber, amount: last.args.amount, tx: last.transactionHash });
    }
    if (wEvents.length > 0) {
      const last = wEvents[wEvents.length - 1];
      log("info", "remote", "last RemoteWithdrawRequested",
        { block: last.blockNumber, amount: last.args.amount, tx: last.transactionHash });
    }
  } catch (e) {
    log("warn", "remote", "event scan failed", { error: e.message });
  }
}

async function main() {
  const rpc = process.env.ARB_RPC || ARB_RPC_DEFAULT;
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(process.env.HC_KEEPER_KEY, provider);

  const sweepAddr = process.env.SWEEP_CONTROLLER_ADDR;
  const mirrorAddr = process.env.HYPER_REMOTE_MIRROR_ADDR;
  if (!sweepAddr || !mirrorAddr) {
    throw new Error("SWEEP_CONTROLLER_ADDR + HYPER_REMOTE_MIRROR_ADDR required");
  }

  const sweep  = new ethers.Contract(sweepAddr, SWEEP_ABI, signer);
  const mirror = new ethers.Contract(mirrorAddr, MIRROR_ABI, signer);

  const dryRun = process.env.DRY_RUN === "1";
  const head = await provider.getBlockNumber();
  // QuickNode caps eth_getLogs to 10k blocks. ~10k Arb blocks ≈ 40 min — fine
  // for an event-tail surface that runs every cron tick.
  const fromBlock = Math.max(0, head - 9_000);

  log("info", "start", "running",
    { keeper: await signer.getAddress(), sweep: sweepAddr, mirror: mirrorAddr, dryRun, fromBlock });

  const ctx = { sweep, mirror, provider, dryRun, fromBlock };
  await rebalanceCycle(ctx);
  await watchRemoteEvents(ctx);

  log("info", "done", "cycle complete");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
