// ═══════════════════════════════════════════════════════════════════════
//  LZ value-push keeper — HyperEVM → Arb.
//
//  For every position NFT currently locked in HyperPositionLocker on
//  HyperEVM, call `pushValueUpdate(nft, tokenId, extraOptions)` which
//  reads current vault.estimatePositionValue and ships a LZ v2 message
//  to the Arb wrapper. Arb wrapper's stored value gets refreshed; the
//  Arb NFTValuer (VAULT_MIRROR mode) reads that value at lending
//  health-check time.
//
//  Mirror of ccip-value-push.js for the LZ lane.
//
//  Fees:
//    - Locker uses native HYPE for LZ fees (not LINK).
//    - Keeper EOA MUST hold HYPE on HyperEVM. We `quoteValueUpdate`
//      first + add a 20% buffer to msg.value.
//
//  Environment:
//    HYPEREVM_RPC   HyperEVM RPC
//    KEEPER_KEY     KEEPER_ROLE on HyperPositionLocker + HYPE balance
//    LOCKER_ADDR    Override default locker address
//    LOOKBACK       blocks to scan (default 100000)
//    LOG_CHUNK      getLogs block chunk (default 5000)
//    MIN_HYPE_WEI   warn if keeper HYPE < this (default 0.05 HYPE = 5e16)
//    DRY_RUN        "1" = log, skip tx
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();

const path = require("node:path");
const { ethers } = require("ethers");
const cfg = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json"));

const LOCKER = process.env.LOCKER_ADDR || cfg.contracts.hyperPositionLocker;

const LOCKER_ABI = [
  "event Locked_(address indexed user, address indexed nft, uint256 indexed tokenId, uint256 wrapperId, uint256 valueUSDC, bytes32 messageId)",
  "event Released(address indexed to, address indexed nft, uint256 indexed tokenId, uint256 wrapperId)",
  "function locked(uint256) view returns (address originalOwner, address hyperNft, uint256 hyperTokenId, uint256 lockedAt)",
  "function pushValueUpdate(address nft, uint256 tokenId, bytes extraOptions) payable returns (bytes32)",
  "function quoteValueUpdate(address nft, uint256 tokenId, bytes extraOptions) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function wrapperIdOf(address nft, uint256 tokenId) view returns (uint256)",
  "function KEEPER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];

function log(level, step, msg, extra = {}) {
  const clean = {};
  for (const k of Object.keys(extra)) {
    clean[k] = typeof extra[k] === "bigint" ? extra[k].toString() : extra[k];
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...clean }));
}

async function main() {
  if (!process.env.HYPEREVM_RPC) throw new Error("HYPEREVM_RPC env required");
  if (!process.env.KEEPER_KEY) throw new Error("KEEPER_KEY env required");
  if (!LOCKER) throw new Error("locker address not resolved");

  const provider = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const signer = new ethers.Wallet(process.env.KEEPER_KEY, provider);
  if (Number((await provider.getNetwork()).chainId) !== 999) throw new Error("not HyperEVM");

  const locker = new ethers.Contract(LOCKER, LOCKER_ABI, signer);

  // Role check
  const role = await locker.KEEPER_ROLE();
  if (!await locker.hasRole(role, signer.address)) {
    log("error", "preflight", "signer lacks KEEPER_ROLE on locker", { signer: signer.address, locker: LOCKER });
    process.exit(2);
  }

  // HYPE balance warn
  const hypeBal = await provider.getBalance(signer.address);
  const minHype = BigInt(process.env.MIN_HYPE_WEI || String(5n * 10n ** 16n)); // 0.05 HYPE
  if (hypeBal < minHype) {
    log("warn", "preflight", "keeper HYPE balance below threshold — LZ fees may revert", {
      hypeBal, minHype, signer: signer.address,
    });
  }

  // Scan events in chunks (HyperEVM RPCs cap getLogs at 5k-10k blocks)
  const head = await provider.getBlockNumber();
  const lookback = Number(process.env.LOOKBACK || 100000);
  const chunkSize = Number(process.env.LOG_CHUNK || 5000);
  const fromStart = Math.max(0, head - lookback);
  log("info", "scan", "event scan range", { from: fromStart, to: head, chunkSize });

  const iface = new ethers.Interface(LOCKER_ABI);
  const lockedTopic = iface.getEvent("Locked_").topicHash;
  const releasedTopic = iface.getEvent("Released").topicHash;

  async function chunked(topic) {
    const out = [];
    for (let from = fromStart; from <= head; from += chunkSize) {
      const to = Math.min(head, from + chunkSize - 1);
      try {
        out.push(...await provider.getLogs({ address: LOCKER, topics: [topic], fromBlock: from, toBlock: to }));
      } catch (e) {
        log("warn", "scan", "chunk failed — skipping", { from, to, err: e.shortMessage || e.message });
      }
    }
    return out;
  }

  const lockedLogs = await chunked(lockedTopic);
  const releasedLogs = await chunked(releasedTopic);

  const state = new Map();
  for (const l of lockedLogs) {
    const p = iface.parseLog(l);
    state.set(`${p.args.nft}:${p.args.tokenId}`, { nft: p.args.nft, tokenId: p.args.tokenId });
  }
  for (const r of releasedLogs) {
    const p = iface.parseLog(r);
    state.delete(`${p.args.nft}:${p.args.tokenId}`);
  }

  const candidates = [...state.values()];
  log("info", "scan", "live locked positions", { count: candidates.length });

  let pushed = 0, skipped = 0, failed = 0;
  for (const c of candidates) {
    const wid = await locker.wrapperIdOf(c.nft, c.tokenId);
    const L = await locker.locked(wid);
    if (L.originalOwner === ethers.ZeroAddress) {
      skipped++;
      continue;
    }

    if (process.env.DRY_RUN === "1") {
      log("info", "push", "DRY_RUN — skip tx", { nft: c.nft, tokenId: c.tokenId.toString() });
      continue;
    }

    try {
      // Quote the fee first so we can fund msg.value
      const fee = await locker.quoteValueUpdate(c.nft, c.tokenId, "0x");
      // Add 20% buffer to accommodate any on-the-fly DVN/executor fee changes
      const buffered = (fee.nativeFee * 120n) / 100n;
      const tx = await locker.pushValueUpdate(c.nft, c.tokenId, "0x", { value: buffered });
      const rc = await tx.wait();
      log("info", "push", "ok", { nft: c.nft, tokenId: c.tokenId.toString(), fee: fee.nativeFee, tx: tx.hash, block: rc.blockNumber });
      pushed++;
    } catch (e) {
      log("error", "push", "failed", { nft: c.nft, tokenId: c.tokenId.toString(), err: e.shortMessage || e.message });
      failed++;
    }
  }

  log("info", "done", `pushed=${pushed} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => {
  log("error", "fatal", "uncaught", { err: e.shortMessage || e.message });
  process.exit(1);
});
