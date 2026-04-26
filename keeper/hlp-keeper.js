// ═══════════════════════════════════════════════════════════════════════
//  HLP Keeper — orchestrates USDC flow between Arbitrum HLPAdapter and
//  Hyperliquid's HLP vault on HyperCore.
//
//  Runs as a pm2 cron entry separate from the main v15-keeper (isolated
//  signer key, isolated failure domain).
//
//  Reads:      @nktkas/hyperliquid InfoClient (REST)  → equity + spot USDC
//  Signs:      @nktkas/hyperliquid ExchangeClient     → vaultTransfer + withdraw3
//
//  Environment:
//    ARB_RPC                  Arbitrum RPC
//    HC_KEEPER_KEY            Isolated signer key for HC actions. Same
//                             address on Arbitrum and HyperCore.
//    HLP_ADAPTER_ADDR         Deployed HLPAdapter address on Arbitrum
//    HLP_VAULT_ID             HLP vault identifier on HyperCore (default:
//                             0xdfc24b077bc1425ad1dea75bcb6f8158e10df303)
//    WITHDRAW_USD             If set, triggers a withdraw cycle for N USDC
//                             (6-decimal raw units).
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");

// ─────────── Constants ───────────
const USDC_ARB        = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BRIDGE2         = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const HLP_VAULT_ID    = (process.env.HLP_VAULT_ID ||
                        "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303").toLowerCase();

const MIN_BRIDGE       = 5_000_000n;  // 5 USDC (6-dec)
const IDLE_TARGET_BPS  = 500n;        // keep 5% of total as float
const BRIDGE_POLL_MS   = 10_000;      // watch for HC credit
const BRIDGE_TIMEOUT_S = 300;         // 5 min
const ARB_POLL_MS      = 15_000;
const ARB_TIMEOUT_S    = 600;         // 10 min — HL withdraws settle in 3-4 min
const HL_WITHDRAW_FEE  = 1_000_000n;  // $1 validator fee

// ─────────── ABIs ───────────
const HLP_ADAPTER_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function idleUsdc() view returns (uint256)",
  "function inFlightToHC() view returns (uint256)",
  "function inFlightFromHC() view returns (uint256)",
  "function reportedHCEquity() view returns (uint256)",
  "function lastHCDepositAt() view returns (uint256)",
  "function lastNavUpdateAt() view returns (uint256)",
  "function lockupUnlockAt() view returns (uint256)",
  "function isNavStale() view returns (bool)",
  "function maxNavDriftBps() view returns (uint256)",
  "function pullForBridge(uint256) external",
  "function confirmHCDeposit(uint256) external",
  "function initiateHCWithdraw(uint256) external",
  "function confirmHCWithdraw(uint256) external",
  "function pushNAV(uint256) external",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

// ─────────── Logging ───────────
function log(level, step, msg, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level, step, msg, ...data,
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────── Unit conversion ───────────
// HL REST API returns equity + spot balances as decimal strings in USD
// (e.g. "1234.56"). The adapter tracks 6-decimal USDC raw units.
function usdStringToRaw(s) {
  if (s === null || s === undefined) return 0n;
  const str = String(s);
  const [whole, frac = ""] = str.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const neg = whole.startsWith("-");
  const wholeAbs = neg ? whole.slice(1) : whole;
  const raw = BigInt(wholeAbs) * 1_000_000n + BigInt(fracPadded || "0");
  return neg ? -raw : raw;
}

// withdraw3 + vaultTransfer in the SDK want a `usd` number
// (float, 2 decimals). Convert 6-decimal raw to the wire format.
function rawToUsdNumber(raw) {
  return Number(raw) / 1_000_000;
}

// ─────────── Hyperliquid reads ───────────

/// @brief Read equity the keeper holds in the HLP vault (in 6-dec raw USDC).
async function readHCEquity(info, user) {
  const res = await info.userVaultEquities({ user });
  if (!Array.isArray(res)) return 0n;
  for (const v of res) {
    if (String(v.vaultAddress || "").toLowerCase() === HLP_VAULT_ID) {
      return usdStringToRaw(v.equity);
    }
  }
  return 0n;
}

/// @brief Read the keeper's HyperCore spot USDC balance (in 6-dec raw USDC).
async function readHCSpotUsdc(info, user) {
  const state = await info.spotClearinghouseState({ user });
  const balances = state && state.balances ? state.balances : [];
  for (const b of balances) {
    if (b.coin === "USDC") return usdStringToRaw(b.total);
  }
  return 0n;
}

/// @brief Poll until HC spot USDC balance covers `needed`, or timeout.
async function waitForHCCredit(info, user, needed, timeoutS) {
  const deadline = Math.floor(Date.now() / 1000) + timeoutS;
  while (Math.floor(Date.now() / 1000) < deadline) {
    const bal = await readHCSpotUsdc(info, user).catch(() => 0n);
    if (bal >= needed) return bal;
    await sleep(BRIDGE_POLL_MS);
  }
  return 0n;
}

/// @brief Poll Arbitrum until keeper USDC balance grows by >= `expected` or timeout.
async function waitForArbReturn(usdc, who, baseline, expectedMin, timeoutS) {
  const deadline = Math.floor(Date.now() / 1000) + timeoutS;
  while (Math.floor(Date.now() / 1000) < deadline) {
    const bal = await usdc.balanceOf(who).catch(() => baseline);
    if (bal >= baseline + expectedMin) return bal;
    await sleep(ARB_POLL_MS);
  }
  return 0n;
}

// ─────────── Hyperliquid signing ───────────

/// @brief vaultTransfer: move USDC between HC spot and an HL vault.
async function hcVaultTransfer(exchange, { isDeposit, usd }) {
  const res = await exchange.vaultTransfer({
    vaultAddress: HLP_VAULT_ID,
    isDeposit: !!isDeposit,
    usd: Math.round(usd * 1_000_000), // SDK takes integer USDC 6-dec units
  });
  log("info", "hl", "vaultTransfer", { isDeposit, usd, res });
  return res;
}

/// @brief withdraw3: send HC spot USDC back to Arbitrum at the signer's address.
async function hcWithdrawToArbitrum(exchange, { destination, amountUsd }) {
  const res = await exchange.withdraw3({
    destination,
    amount: String(amountUsd.toFixed(6)), // SDK wants decimal string
  });
  log("info", "hl", "withdraw3", { destination, amountUsd, res });
  return res;
}

// ─────────── Orchestration ───────────

/// Push excess idle USDC from the adapter into HLP.
async function runDepositCycle(ctx) {
  const { adapter, signer, info, exchange, hcKeeperAddr } = ctx;

  const idle       = await adapter.idleUsdc();
  const totalAssets = await adapter.totalAssets();
  const inFlight   = await adapter.inFlightToHC();

  if (idle < MIN_BRIDGE) {
    log("info", "deposit", "skip — idle below bridge min",
      { idle: idle.toString() });
    return;
  }
  if (inFlight > 0n) {
    log("info", "deposit", "skip — prior deposit still in flight",
      { inFlightToHC: inFlight.toString() });
    return;
  }

  const targetIdle = (totalAssets * IDLE_TARGET_BPS) / 10_000n;
  if (idle <= targetIdle) {
    log("info", "deposit", "skip — idle at/below float target",
      { idle: idle.toString(), target: targetIdle.toString() });
    return;
  }
  const toPush = idle - targetIdle;
  if (toPush < MIN_BRIDGE) {
    log("info", "deposit", "skip — push size below bridge min",
      { toPush: toPush.toString() });
    return;
  }

  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, signer);
  const preHCBal = await readHCSpotUsdc(info, hcKeeperAddr).catch(() => 0n);

  // 1. Pull USDC from adapter to keeper EOA.
  log("info", "deposit", "pullForBridge", { amount: toPush.toString() });
  await (await adapter.pullForBridge(toPush)).wait();

  // 2. Transfer USDC to Bridge2.
  log("info", "deposit", "sending USDC → Bridge2");
  const bridgeTx = await usdc.transfer(BRIDGE2, toPush);
  const bridgeRcpt = await bridgeTx.wait();
  log("info", "deposit", "bridge submitted", { tx: bridgeRcpt.hash });

  // 3. Poll HC spot until credited.
  const credited = await waitForHCCredit(
    info, hcKeeperAddr, preHCBal + toPush, BRIDGE_TIMEOUT_S,
  );
  if (credited === 0n) {
    log("warn", "deposit",
      "bridge credit not observed within timeout — inFlightToHC left set, " +
      "next cycle will skip on inFlight>0 guard; operator should " +
      "investigate and call confirmHCDeposit manually once visible");
    return;
  }
  log("info", "deposit", "HC credited", { hcBalance: credited.toString() });

  // 4. Sign HC vaultTransfer → HLP.
  await hcVaultTransfer(exchange, { isDeposit: true, usd: rawToUsdNumber(toPush) });

  // 5. On-chain confirmation.
  log("info", "deposit", "confirmHCDeposit");
  await (await adapter.confirmHCDeposit(toPush)).wait();

  // 6. NAV refresh.
  await pushNAVSnapshot(ctx);
}

/// Top up the adapter's idle float from HLP. Gated by 4-day lockup.
async function runWithdrawCycle(ctx, requestedAmount) {
  const { adapter, signer, exchange, hcKeeperAddr, adapterAddr } = ctx;

  const unlockAt = await adapter.lockupUnlockAt();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (unlockAt === 0n) {
    log("info", "withdraw", "skip — no HC position yet");
    return;
  }
  if (now < unlockAt) {
    log("info", "withdraw", "skip — HLP lockup active",
      { unlockAt: unlockAt.toString(), now: now.toString() });
    return;
  }

  const equity = await adapter.reportedHCEquity();
  if (equity < requestedAmount) {
    log("warn", "withdraw", "requested > reported equity",
      { equity: equity.toString(), requested: requestedAmount.toString() });
    return;
  }

  // 1. Pre-accounting on adapter.
  log("info", "withdraw", "initiateHCWithdraw",
    { amount: requestedAmount.toString() });
  await (await adapter.initiateHCWithdraw(requestedAmount)).wait();

  // 2. HC vaultTransfer OUT of HLP (into HC spot).
  await hcVaultTransfer(exchange,
    { isDeposit: false, usd: rawToUsdNumber(requestedAmount) });

  // 3. HC withdraw3 → USDC lands on Arbitrum at keeper EOA in ~4 min.
  //    Validators deduct $1, so we expect (requestedAmount - 1e6).
  const usdc = new ethers.Contract(USDC_ARB, ERC20_ABI, signer);
  const preArbBal = await usdc.balanceOf(hcKeeperAddr);
  await hcWithdrawToArbitrum(exchange, {
    destination: hcKeeperAddr,
    amountUsd: rawToUsdNumber(requestedAmount),
  });

  // 4. Wait for USDC arrival on Arb.
  const expectedMin = requestedAmount > HL_WITHDRAW_FEE
    ? requestedAmount - HL_WITHDRAW_FEE
    : 0n;
  const arrived = await waitForArbReturn(
    usdc, hcKeeperAddr, preArbBal, expectedMin, ARB_TIMEOUT_S,
  );
  if (arrived === 0n) {
    log("warn", "withdraw",
      "Arb settlement not observed within timeout — inFlightFromHC left set, " +
      "operator should check keeper EOA balance and call confirmHCWithdraw " +
      "manually once the USDC arrives");
    return;
  }

  const delta = arrived - preArbBal;
  log("info", "withdraw", "Arb settled", { delta: delta.toString() });

  // 5. Transfer to adapter + confirm.
  log("info", "withdraw", "returning USDC to adapter");
  await (await usdc.transfer(adapterAddr, delta)).wait();
  await (await adapter.confirmHCWithdraw(requestedAmount)).wait();

  await pushNAVSnapshot(ctx);
}

/// Refresh on-chain NAV from HC equity. Clamps to adapter's maxNavDriftBps.
async function pushNAVSnapshot(ctx) {
  const { adapter, info, hcKeeperAddr } = ctx;
  const equity = await readHCEquity(info, hcKeeperAddr);
  log("info", "nav", "read HC equity", { equity: equity.toString() });

  const reported = await adapter.reportedHCEquity();
  if (reported === 0n) {
    if (equity === 0n) return;
    await (await adapter.pushNAV(equity)).wait();
    log("info", "nav", "initial NAV set", { equity: equity.toString() });
    return;
  }

  const maxBps = await adapter.maxNavDriftBps();
  const maxDelta = (reported * maxBps) / 10_000n;
  let target = equity;
  if (equity > reported + maxDelta) target = reported + maxDelta;
  else if (reported > equity + maxDelta) target = reported - maxDelta;

  await (await adapter.pushNAV(target)).wait();
  log("info", "nav", "NAV updated", {
    old: reported.toString(), new: target.toString(),
    trueEquity: equity.toString(),
  });
}

// ─────────── Entrypoint ───────────
async function main() {
  const arbProvider = new ethers.JsonRpcProvider(process.env.ARB_RPC);
  const signer = new ethers.Wallet(process.env.HC_KEEPER_KEY, arbProvider);
  const hcKeeperAddr = await signer.getAddress();
  const adapterAddr = process.env.HLP_ADAPTER_ADDR;
  if (!adapterAddr) throw new Error("HLP_ADAPTER_ADDR not set");
  const adapter = new ethers.Contract(adapterAddr, HLP_ADAPTER_ABI, signer);

  const transport = new hl.HttpTransport();
  const info = new hl.InfoClient({ transport });
  const exchange = new hl.ExchangeClient({
    transport,
    wallet: signer, // SDK accepts ethers.Wallet for EIP-712 signing
  });

  const ctx = { adapter, adapterAddr, signer, hcKeeperAddr, info, exchange };

  log("info", "keeper", "starting",
    { hcKeeper: hcKeeperAddr, adapter: adapterAddr });

  try { await pushNAVSnapshot(ctx); }
  catch (e) { log("warn", "nav", "push failed", { error: e.message }); }

  try { await runDepositCycle(ctx); }
  catch (e) { log("warn", "deposit", "cycle failed", { error: e.message }); }

  const w = process.env.WITHDRAW_USD ? BigInt(process.env.WITHDRAW_USD) : 0n;
  if (w > 0n) {
    try { await runWithdrawCycle(ctx, w); }
    catch (e) { log("warn", "withdraw", "cycle failed", { error: e.message }); }
  }

  log("info", "keeper", "done");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  main, runDepositCycle, runWithdrawCycle, pushNAVSnapshot,
  readHCEquity, readHCSpotUsdc, usdStringToRaw, rawToUsdNumber,
};
