// ═══════════════════════════════════════════════════════════════════════
//  Lending → Pool E v2 bridge keeper (Arb → HyperEVM outbound automation).
//
//  Watches HyperRemoteMirror.RemoteDeposited events on Arbitrum. For each
//  unprocessed event, runs the multi-step Arb→HyperEVM motion:
//
//    Step 0  (Arb)        : keeper EOA holds USDC bridged into it from the
//                           SweepController. We saw the RemoteDeposited
//                           event; record entry in state file.
//    Step 1  (Arb→HC)     : approve + CoreDepositWallet.depositFor
//                           (USDC → keeper's HC spot). 15-min validator
//                           confirmation; we poll spotClearinghouseState.
//    Step 2  (HC spot)    : USDC has landed on keeper HC spot.
//    Step 3  (HC→EVM)     : ERC20 transfer from keeper to USDC system
//                           address on HyperEVM (instant; uses HC HYPE
//                           for sendAsset gas).
//    Step 4  (HyperEVM)   : USDC has landed in keeper's HyperEVM wallet.
//    Step 5  (deposit)    : approve Pool E v2 vault + vault.deposit(amount, FLEX).
//                           Vault mints a ShadowPass NFT to the keeper.
//    Step 6  (attest)     : back on Arb, mirror.confirmDeposit(amount).
//    Step 7  (done)       : entry archived.
//
//  Inbound (Pool E → Arb) is left to the operator for v1 — the
//  HyperEVM→Arb leg requires a withdraw3 action that takes 5-7 days for L1
//  finalization, which makes per-cycle automation low value. Operator
//  triggers manually using `scripts/bridge-hc-to-evm.cjs` + HL UI.
//
//  State persisted to `keeper/lending-bridge-state.json`. Each entry:
//    { id, txHash, amount, step, lastUpdate, ... }
//
//  Environment:
//    ARB_RPC                Arbitrum RPC
//    HYPEREVM_RPC           HyperEVM RPC
//    HC_KEEPER_KEY          Keeper signer (whitelisted on Pool E v2)
//    HYPER_REMOTE_MIRROR_ADDR
//    POOL_E_V2_VAULT_ADDR   = 0x481D57E356cF99E44C25675C57C178D9Ef46BD57
//    DRY_RUN                "1" = log decisions but don't send txs
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();

const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");
const hl = require("@nktkas/hyperliquid");

const ARB_RPC_DEFAULT = "https://arb1.arbitrum.io/rpc";
const HL_EVM_RPC_DEFAULT = "https://rpc.hyperliquid.xyz/evm";
const STATE_FILE = path.resolve(__dirname, "lending-bridge-state.json");

const ARB_USDC      = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const HYPER_USDC    = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const POOL_E_V2     = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const CORE_DEPOSIT  = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";
const SPOT_DEX      = 0xFFFFFFFF;
const USDC_SYSTEM_ADDR = "0x2000000000000000000000000000000000000000"; // HyperEVM USDC system
const TIER_FLEX = 0;

const MIRROR_ABI = [
  "function confirmDeposit(uint256) external",
  "event RemoteDeposited(address indexed caller, uint256 amount, uint256 pendingOutbound)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const VAULT_ABI = [
  "function deposit(uint256,uint8) external",
];

const CORE_DEPOSIT_ABI = [
  "function depositFor(address,uint256,uint32)",
];

function log(level, step, msg, data = {}) {
  const safe = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    safe[k] = (typeof v === "bigint") ? v.toString() : v;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, step, msg, ...safe }));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { entries: [], lastBlockScanned: 0 };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function readHcUsdc(info, addr) {
  const r = await info.spotClearinghouseState({ user: addr }).catch(() => ({ balances: [] }));
  const u = (r.balances || []).find(b => b.coin === "USDC");
  if (!u) return 0n;
  const [whole, frac = ""] = String(u.total).split(".");
  const fracPad = (frac + "000000").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPad);
}

async function step1_bridgeArbToHc(ctx, e) {
  const { arbSigner, dryRun } = ctx;
  log("info", "step1", "approve + depositFor (Arb → keeper HC spot)",
    { id: e.id, amount: e.amount });
  if (dryRun) { e.step = 2; return; }

  const usdc = new ethers.Contract(ARB_USDC, ERC20_ABI, arbSigner);
  const cdw  = new ethers.Contract(CORE_DEPOSIT, CORE_DEPOSIT_ABI, arbSigner);
  const amt  = BigInt(e.amount);

  const ax = await usdc.approve(CORE_DEPOSIT, amt);
  log("info", "step1", "approve tx", { hash: ax.hash });
  await ax.wait();

  const tx = await cdw.depositFor(arbSigner.address, amt, SPOT_DEX);
  log("info", "step1", "depositFor tx", { hash: tx.hash });
  await tx.wait();
  e.step = 2;
  e.lastUpdate = new Date().toISOString();
}

async function step2_waitForHcCredit(ctx, e) {
  const { hlInfo, arbSigner } = ctx;
  const have = await readHcUsdc(hlInfo, arbSigner.address);
  const need = BigInt(e.amount);
  // Allow for activation fee (1 USDC) and other small frictions.
  if (have >= need - 1_000_000n) {
    log("info", "step2", "HC credit confirmed", { have: have, need: need });
    e.step = 3;
    e.lastUpdate = new Date().toISOString();
  } else {
    log("info", "step2", "waiting on HC credit",
      { id: e.id, have: have, need: need });
  }
}

async function step3_bridgeHcToHyperEvm(ctx, e) {
  const { hlExchange, dryRun } = ctx;
  // We use the HL exchange API's spotSend to USDC system address on HyperEVM.
  // This is the "USDC class spot → HyperEVM ERC20" hop. Costs ~1 USDC fee.
  log("info", "step3", "spotSend HC → HyperEVM USDC system",
    { id: e.id, amount: e.amount });
  if (dryRun) { e.step = 4; return; }

  const sendAmt = (Number(BigInt(e.amount) - 1_000_000n) / 1e6).toString(); // subtract 1 USDC fee guess
  try {
    const res = await hlExchange.spotSend({
      destination: USDC_SYSTEM_ADDR,
      token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", // USDC token id on HL
      amount: sendAmt,
    });
    log("info", "step3", "spotSend response", { res: JSON.stringify(res) });
    e.step = 4;
    e.lastUpdate = new Date().toISOString();
  } catch (err) {
    log("warn", "step3", "spotSend failed", { id: e.id, error: err.message });
  }
}

async function step4_waitForHyperEvmCredit(ctx, e) {
  const { hyperSigner } = ctx;
  const usdc = new ethers.Contract(HYPER_USDC, ERC20_ABI, hyperSigner);
  const have = await usdc.balanceOf(hyperSigner.address);
  const need = BigInt(e.amount) - 2_000_000n; // ~2 USDC accumulated frictions
  if (have >= need) {
    log("info", "step4", "HyperEVM credit confirmed", { id: e.id, have });
    e.step = 5;
    e.lastUpdate = new Date().toISOString();
  } else {
    log("info", "step4", "waiting on HyperEVM credit", { id: e.id, have, need });
  }
}

async function step5_depositPoolE(ctx, e) {
  const { hyperSigner, dryRun } = ctx;
  const usdc  = new ethers.Contract(HYPER_USDC, ERC20_ABI, hyperSigner);
  const vault = new ethers.Contract(POOL_E_V2, VAULT_ABI, hyperSigner);
  const balance = await usdc.balanceOf(hyperSigner.address);
  // Cap deposit to actual on-hand to avoid revert if friction trimmed it.
  const dep = balance < BigInt(e.amount) ? balance : BigInt(e.amount);
  log("info", "step5", "Pool E v2 deposit",
    { id: e.id, want: e.amount, depositing: dep });
  if (dryRun) { e.step = 6; return; }

  if (dep < 5_000_000n) {
    log("warn", "step5", "skip — below 5 USDC min", { id: e.id, dep });
    return;
  }

  const ax = await usdc.approve(POOL_E_V2, dep);
  log("info", "step5", "approve tx", { hash: ax.hash });
  await ax.wait();

  const tx = await vault.deposit(dep, TIER_FLEX);
  log("info", "step5", "deposit tx", { hash: tx.hash });
  await tx.wait();
  e.depositedAmount = dep.toString();
  e.step = 6;
  e.lastUpdate = new Date().toISOString();
}

async function step6_attestArb(ctx, e) {
  const { mirror, dryRun } = ctx;
  const amt = BigInt(e.depositedAmount || e.amount);
  log("info", "step6", "mirror.confirmDeposit on Arb", { id: e.id, amount: amt });
  if (dryRun) { e.step = 7; return; }

  try {
    const tx = await mirror.confirmDeposit(amt);
    log("info", "step6", "tx", { hash: tx.hash });
    await tx.wait();
    e.step = 7;
    e.lastUpdate = new Date().toISOString();
  } catch (err) {
    log("warn", "step6", "tx reverted (will retry)", { id: e.id, error: err.message });
  }
}

const ADVANCERS = {
  1: step1_bridgeArbToHc,
  2: step2_waitForHcCredit,
  3: step3_bridgeHcToHyperEvm,
  4: step4_waitForHyperEvmCredit,
  5: step5_depositPoolE,
  6: step6_attestArb,
};

async function main() {
  const arbRpc   = process.env.ARB_RPC || ARB_RPC_DEFAULT;
  const hyperRpc = process.env.HYPEREVM_RPC || HL_EVM_RPC_DEFAULT;
  const arbProv  = new ethers.JsonRpcProvider(arbRpc);
  const hyperProv = new ethers.JsonRpcProvider(hyperRpc);
  const arbSigner   = new ethers.Wallet(process.env.HC_KEEPER_KEY, arbProv);
  const hyperSigner = new ethers.Wallet(process.env.HC_KEEPER_KEY, hyperProv);

  const mirrorAddr = process.env.HYPER_REMOTE_MIRROR_ADDR;
  if (!mirrorAddr) throw new Error("HYPER_REMOTE_MIRROR_ADDR not set");
  const mirror = new ethers.Contract(mirrorAddr, MIRROR_ABI, arbSigner);

  const transport = new hl.HttpTransport();
  const hlInfo     = new hl.InfoClient({ transport });
  const hlExchange = new hl.ExchangeClient({ wallet: arbSigner, transport });

  const dryRun = process.env.DRY_RUN === "1";
  const state = loadState();

  log("info", "start", "running",
    { keeper: arbSigner.address, mirror: mirrorAddr,
      pendingEntries: state.entries.length, dryRun });

  // Scan for new RemoteDeposited events since last cycle.
  const head = await arbProv.getBlockNumber();
  const fromBlock = state.lastBlockScanned > 0
    ? state.lastBlockScanned + 1
    : Math.max(0, head - 9000);
  try {
    const filter = mirror.filters.RemoteDeposited();
    const events = await mirror.queryFilter(filter, fromBlock, head);
    for (const ev of events) {
      const txHash = ev.transactionHash;
      if (state.entries.some(e => e.txHash === txHash)) continue;
      state.entries.push({
        id: state.entries.length + 1,
        txHash,
        amount: ev.args.amount.toString(),
        block: ev.blockNumber,
        step: 1,
        lastUpdate: new Date().toISOString(),
      });
      log("info", "scan", "new RemoteDeposited", { txHash, amount: ev.args.amount });
    }
    state.lastBlockScanned = head;
  } catch (err) {
    log("warn", "scan", "event scan failed", { error: err.message });
  }

  // Advance every active entry one step.
  const ctx = { arbSigner, hyperSigner, hlInfo, hlExchange, mirror, dryRun };
  for (const e of state.entries) {
    if (e.step >= 7) continue;
    try {
      const fn = ADVANCERS[e.step];
      if (fn) await fn(ctx, e);
    } catch (err) {
      log("error", "advance", "uncaught", { id: e.id, step: e.step, error: err.message });
    }
    saveState(state);
  }

  saveState(state);
  log("info", "done", "cycle complete");
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main };
