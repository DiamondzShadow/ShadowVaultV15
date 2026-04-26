// ═══════════════════════════════════════════════════════════════════════
//  SDMArbitrumMirror sync keeper.
//
//  Reads SDM (0x602b869eEf1C9F0487F31776bad8Af3C4A173394) balanceOf for a
//  watched address set on Arbitrum, then pushes any changed values to the
//  SDMArbitrumMirror contract on HyperEVM. Runs idempotently — only addresses
//  whose balance changed since the last on-chain mirror are pushed.
//
//  Watched address set comes from `config/sdm-watched.json` (an array of
//  hex addresses). Operator is responsible for keeping that file current.
//  A future enhancement is to pull holders from a Dune dashboard or the
//  SDM contract's Transfer event log.
//
//  Environment:
//    ARB_RPC                 Arbitrum RPC (default Alchemy / public)
//    HYPEREVM_RPC            HyperEVM RPC
//    HC_KEEPER_KEY           Keeper signer (KEEPER_ROLE on the mirror)
//    SDM_MIRROR_ADDR         Deployed SDMArbitrumMirror on HyperEVM
//    SDM_TOKEN_ARB           SDM ERC20 on Arbitrum (default 0x602b…3394)
//    SDM_BATCH_SIZE          Max addresses per setBatch tx (default 100, mirror cap 200)
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();

const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");

const ARB_RPC_DEFAULT      = "https://arb1.arbitrum.io/rpc";
const HL_EVM_RPC_DEFAULT   = "https://rpc.hyperliquid.xyz/evm";
const SDM_TOKEN_ARB_DEFAULT = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const MIRROR_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function setBalance(address,uint256) external",
  "function setBatch(address[],uint256[]) external",
  "function lastUpdate(address) view returns (uint64)",
  "function globalLastSync() view returns (uint64)",
];

function log(level, step, msg, data = {}) {
  const safe = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    safe[k] = (typeof v === "bigint") ? v.toString() : v;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...safe }));
}

function loadWatched() {
  const file = path.resolve(__dirname, "..", "config", "sdm-watched.json");
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error("sdm-watched.json must be a JSON array of addresses");
  return raw.map(a => ethers.getAddress(a));
}

async function main() {
  const arbRpc = process.env.ARB_RPC || ARB_RPC_DEFAULT;
  const hcRpc  = process.env.HYPEREVM_RPC || HL_EVM_RPC_DEFAULT;
  const sdmTok = process.env.SDM_TOKEN_ARB || SDM_TOKEN_ARB_DEFAULT;
  const mirrorAddr = process.env.SDM_MIRROR_ADDR;
  const batchSize = Number(process.env.SDM_BATCH_SIZE || 100);
  if (!mirrorAddr) throw new Error("SDM_MIRROR_ADDR not set");

  const arbProvider = new ethers.JsonRpcProvider(arbRpc);
  const hcProvider  = new ethers.JsonRpcProvider(hcRpc);
  const signer = new ethers.Wallet(process.env.HC_KEEPER_KEY, hcProvider);

  const sdm = new ethers.Contract(sdmTok, ERC20_ABI, arbProvider);
  const mirror = new ethers.Contract(mirrorAddr, MIRROR_ABI, signer);

  const watched = loadWatched();
  log("info", "start", "running",
    { arbRpc, hcRpc, sdm: sdmTok, mirror: mirrorAddr, watched: watched.length });

  if (watched.length === 0) {
    log("warn", "start", "no watched addresses — exit");
    return;
  }

  // Read balances on both sides in parallel.
  const [arbBals, mirBals] = await Promise.all([
    Promise.all(watched.map(a => sdm.balanceOf(a))),
    Promise.all(watched.map(a => mirror.balanceOf(a))),
  ]);

  const changed = { users: [], amounts: [] };
  for (let i = 0; i < watched.length; i++) {
    if (arbBals[i] !== mirBals[i]) {
      changed.users.push(watched[i]);
      changed.amounts.push(arbBals[i]);
    }
  }

  if (changed.users.length === 0) {
    log("info", "diff", "no changes — exit");
    return;
  }

  log("info", "diff", "pushing changes",
    { count: changed.users.length, sample: changed.users.slice(0, 3) });

  // Chunk into MAX_BATCH-respecting batches.
  for (let i = 0; i < changed.users.length; i += batchSize) {
    const u = changed.users.slice(i, i + batchSize);
    const a = changed.amounts.slice(i, i + batchSize);
    log("info", "push", "submitting batch", { offset: i, count: u.length });
    const tx = await mirror.setBatch(u, a);
    log("info", "push", "tx", { hash: tx.hash });
    const rc = await tx.wait();
    log("info", "push", "mined", { block: rc.blockNumber, gas: rc.gasUsed.toString() });
  }

  log("info", "done", "complete");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
