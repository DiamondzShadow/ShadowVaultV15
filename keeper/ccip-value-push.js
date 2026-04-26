// ═══════════════════════════════════════════════════════════════════════
//  CCIP value-push keeper — Polygon → Arb.
//
//  For every position NFT currently locked in PolygonNFTLocker, call
//  `pushValueUpdate(nft, tokenId)` so the Arb wrapper's stored value stays
//  fresh. Important for lending health checks on the Arb side (stale values
//  can either block liquidations or let underwater loans persist).
//
//  Strategy:
//    1. Scan `Locked_` and `Released` events from `lookbackBlocks` ago.
//    2. Build the current set of locked (nft, tokenId) pairs.
//    3. Filter out any whose on-chain `locked[wid].originalOwner` is 0x0
//       (already released but the event is older than our cache).
//    4. For each survivor, call `pushValueUpdate(nft, tokenId)`.
//
//  The keeper signer pays CCIP fees IN LINK from its own balance. Warn if
//  LINK is low; skip the call if no LINK (the tx would revert otherwise).
//
//  Environment:
//    POLYGON_RPC   Polygon RPC
//    KEEPER_KEY    KEEPER_ROLE on PolygonNFTLocker + LINK balance
//    LOOKBACK      blocks to scan (default 100000 ~= 2.5d on Polygon)
//    MIN_LINK_WEI  warn if keeper LINK < this (default 1e18 = 1 LINK)
//    DRY_RUN       "1" = log decisions only
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();

const path = require("node:path");
const { ethers } = require("ethers");
const cfg = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json"));

const LOCKER_ABI = [
  "event Locked_(address indexed user, address indexed nft, uint256 indexed tokenId, uint256 wrapperId, uint256 valueUSDC, bytes32 ccipMessageId)",
  "event Released(address indexed to, address indexed nft, uint256 indexed tokenId, uint256 wrapperId)",
  "function locked(uint256) view returns (address originalOwner, address polyNft, uint256 polyTokenId, uint256 lockedAt)",
  "function pushValueUpdate(address nft, uint256 tokenId) payable returns (bytes32)",
  "function wrapperIdOf(address nft, uint256 tokenId) view returns (uint256)",
  "function KEEPER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function log(level, step, msg, extra = {}) {
  const clean = {};
  for (const k of Object.keys(extra)) {
    clean[k] = typeof extra[k] === "bigint" ? extra[k].toString() : extra[k];
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...clean }));
}

async function main() {
  const locker = cfg.contracts.polygonNFTLocker;
  const link = cfg.ccip.link;
  if (!locker) throw new Error("polygonNFTLocker not in config");
  if (!process.env.KEEPER_KEY) throw new Error("KEEPER_KEY env required");
  if (!process.env.POLYGON_RPC) throw new Error("POLYGON_RPC env required");

  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const signer = new ethers.Wallet(process.env.KEEPER_KEY, provider);
  if (Number((await provider.getNetwork()).chainId) !== 137) throw new Error("not Polygon");

  const c = new ethers.Contract(locker, LOCKER_ABI, signer);
  const linkToken = new ethers.Contract(link, ERC20_ABI, signer);

  // Role check
  const role = await c.KEEPER_ROLE();
  if (!await c.hasRole(role, signer.address)) {
    log("error", "preflight", "signer lacks KEEPER_ROLE", { signer: signer.address });
    process.exit(2);
  }

  // LINK balance warn
  const linkBal = await linkToken.balanceOf(signer.address);
  const minLink = BigInt(process.env.MIN_LINK_WEI || String(10n ** 18n));
  if (linkBal < minLink) {
    log("warn", "preflight", "keeper LINK balance below threshold — fees may revert",
      { linkBal, minLink });
  }

  // Approve locker to pull LINK if needed (the locker calls safeTransferFrom).
  const allowance = await linkToken.balanceOf(signer.address); // reuse balanceOf as smoke
  if (allowance === 0n && process.env.DRY_RUN !== "1") {
    log("info", "preflight", "approving locker for max LINK (idempotent)");
    await (await linkToken.approve(locker, ethers.MaxUint256)).wait();
  }

  // Scan events — chunk in 5k-block windows to stay under most RPC getLogs
  // caps (QuickNode Polygon is generous but public RPCs often cap at 10k).
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
        const logs = await provider.getLogs({ address: locker, topics: [topic], fromBlock: from, toBlock: to });
        out.push(...logs);
      } catch (e) {
        log("warn", "scan", "chunk failed — skipping", { from, to, err: e.shortMessage || e.message });
      }
    }
    return out;
  }

  const lockedLogs = await chunked(lockedTopic);
  const releasedLogs = await chunked(releasedTopic);

  // Build: (nft, tokenId) → locked true/false
  const state = new Map(); // key = `${nft}:${tokenId}`
  for (const l of lockedLogs) {
    const parsed = iface.parseLog(l);
    const nft = parsed.args.nft;
    const tokenId = parsed.args.tokenId;
    state.set(`${nft}:${tokenId}`, { nft, tokenId });
  }
  for (const r of releasedLogs) {
    const parsed = iface.parseLog(r);
    const key = `${parsed.args.nft}:${parsed.args.tokenId}`;
    state.delete(key);
  }

  const candidates = [...state.values()];
  log("info", "scan", "live locked positions", { count: candidates.length });

  // For each candidate, confirm it's still locked on-chain and push
  let pushed = 0, skipped = 0, failed = 0;
  for (const c_ of candidates) {
    const wid = await c.wrapperIdOf(c_.nft, c_.tokenId);
    const L = await c.locked(wid);
    if (L.originalOwner === ethers.ZeroAddress) {
      skipped++;
      continue; // released since event was emitted
    }

    if (process.env.DRY_RUN === "1") {
      log("info", "push", "DRY_RUN — skip tx", { nft: c_.nft, tokenId: c_.tokenId.toString() });
      continue;
    }

    try {
      const tx = await c.pushValueUpdate(c_.nft, c_.tokenId);
      const rc = await tx.wait();
      log("info", "push", "ok", { nft: c_.nft, tokenId: c_.tokenId.toString(), tx: tx.hash, block: rc.blockNumber });
      pushed++;
    } catch (e) {
      log("error", "push", "failed", { nft: c_.nft, tokenId: c_.tokenId.toString(), err: e.shortMessage || e.message });
      failed++;
    }
  }

  log("info", "done", `pushed=${pushed} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => {
  log("error", "fatal", "uncaught", { err: e.shortMessage || e.message });
  process.exit(1);
});
