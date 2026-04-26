// ═══════════════════════════════════════════════════════════════════════
//  SweepControllerV2 rebalance keeper — chain-agnostic.
//
//  Set CHAIN_ID to 42161 (Arbitrum) or 137 (Polygon) and the keeper reads
//  the matching config from ./config/deployed-{lending-arb,polygon-stack}.json.
//  Calls SweepControllerV2.rebalance() on each run — PM2 cron_restart
//  handles scheduling (no long-running loop).
//
//  Environment:
//    CHAIN_ID      42161 | 137
//    ARB_RPC       Arbitrum RPC (used when CHAIN_ID=42161)
//    POLYGON_RPC   Polygon RPC (used when CHAIN_ID=137)
//    KEEPER_KEY    Keeper signer — must have KEEPER_ROLE on SweepControllerV2
//                  and enough native gas (ETH on Arb, POL on Polygon)
//    DRY_RUN       "1" = log decisions but don't send the rebalance tx
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();

const path = require("node:path");
const { ethers } = require("ethers");

const SWEEP_ABI = [
  "function rebalance() external",
  "function totalAssets() view returns (uint256)",
  "function reserveBps() view returns (uint16)",
  "function remoteBps() view returns (uint16)",
  "function minMoveUSDC() view returns (uint256)",
  "function sinkCount() view returns (uint256)",
  "function sinks(uint256) view returns (address sink, uint16 targetBps, bool active, string label)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function KEEPER_ROLE() view returns (bytes32)",
];

function log(level, step, msg, extra = {}) {
  const clean = {};
  for (const k of Object.keys(extra)) {
    clean[k] = typeof extra[k] === "bigint" ? extra[k].toString() : extra[k];
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...clean }));
}

function loadConfig(chainId) {
  if (chainId === 42161) {
    const cfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));
    return {
      rpc: process.env.ARB_RPC,
      sweep: cfg.contracts.sweepController,
      pool:  cfg.contracts.lendingPool,
      network: "arbitrum",
    };
  }
  if (chainId === 137) {
    const cfg = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json"));
    return {
      rpc: process.env.POLYGON_RPC,
      sweep: cfg.contracts.sweepController,
      pool:  cfg.contracts.lendingPool,
      network: "polygon",
    };
  }
  throw new Error(`unsupported CHAIN_ID ${chainId}`);
}

async function main() {
  const chainId = Number(process.env.CHAIN_ID);
  if (!chainId) throw new Error("CHAIN_ID env required");
  if (!process.env.KEEPER_KEY) throw new Error("KEEPER_KEY env required");
  const cfg = loadConfig(chainId);
  if (!cfg.rpc) throw new Error(`RPC for chain ${chainId} not set`);

  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const signer = new ethers.Wallet(process.env.KEEPER_KEY, provider);

  const onChainId = Number((await provider.getNetwork()).chainId);
  if (onChainId !== chainId) {
    throw new Error(`RPC chain ${onChainId} != CHAIN_ID env ${chainId}`);
  }

  const sweep = new ethers.Contract(cfg.sweep, SWEEP_ABI, signer);

  // Role check: keeper must have KEEPER_ROLE on the sweep controller.
  const keeperRole = await sweep.KEEPER_ROLE();
  const hasRole = await sweep.hasRole(keeperRole, signer.address);
  if (!hasRole) {
    log("error", "preflight", "signer lacks KEEPER_ROLE on SweepControllerV2", {
      signer: signer.address, sweep: cfg.sweep,
    });
    process.exit(2);
  }

  // Snapshot current allocation.
  const [total, reserveBps, remoteBps, minMove, sinkCount] = await Promise.all([
    sweep.totalAssets(),
    sweep.reserveBps(),
    sweep.remoteBps(),
    sweep.minMoveUSDC(),
    sweep.sinkCount(),
  ]);

  const sinks = [];
  for (let i = 0n; i < sinkCount; i++) {
    const s = await sweep.sinks(i);
    sinks.push({
      idx: Number(i),
      sink: s.sink,
      label: s.label,
      targetBps: Number(s.targetBps),
      active: s.active,
    });
  }

  log("info", "snapshot", `${cfg.network} sweep`, {
    sweep: cfg.sweep,
    total, reserveBps: Number(reserveBps), remoteBps: Number(remoteBps),
    minMove, sinkCount: Number(sinkCount), sinks,
  });

  if (total === 0n) {
    log("info", "rebalance", "skip — controller has 0 total assets");
    return;
  }

  if (process.env.DRY_RUN === "1") {
    log("info", "rebalance", "DRY_RUN=1 — not sending tx");
    return;
  }

  try {
    const tx = await sweep.rebalance();
    log("info", "rebalance", "tx", { hash: tx.hash });
    const rc = await tx.wait();
    log("info", "rebalance", "mined", { block: rc.blockNumber, gas: rc.gasUsed.toString() });
  } catch (e) {
    log("error", "rebalance", "tx failed", { err: e.shortMessage || e.message });
    process.exit(1);
  }
}

main().catch((e) => {
  log("error", "fatal", "uncaught", { err: e.shortMessage || e.message, stack: (e.stack || "").slice(0, 400) });
  process.exit(1);
});
