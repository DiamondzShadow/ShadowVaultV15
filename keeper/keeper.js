#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  keeper/keeper.js — ShadowVaultV15 operations keeper
//
//  Runs once per invocation. Designed to be cron-scheduled every 3h.
//  Responsibilities per invocation:
//
//    1. For each pool in config/deployed.json:
//       a. harvestYield() — claim Aave/Fluid/Silo interest, fee to treasury
//       b. Check basket drift via getBasketDrift() view
//       c. If any token is over-weight by > DRIFT_REBALANCE_BPS, fetch a
//          0x swap quote and call executeRebalance()
//       d. If vault holds idle USDC after deposits, route it to the
//          most-underweight basket token via executeBuyBasket()
//       e. For each position with withdrawStatus == REQUESTED:
//          - sell this position's pro-rata share of every non-USDC basket
//            token via executeWithdrawalSwap (one 0x call per token)
//          - once no basket tokens remain to sell, call completeWithdraw
//
//    2. Emit structured log lines so a log-forwarder or PM2 can pick them up.
//
//  Env vars:
//    ARB_RPC            Arbitrum RPC URL (required)
//    KEEPER_KEY         Keeper EOA private key (required, KEEPER_ROLE on each vault)
//    ZEROEX_API_KEY     0x API key for authenticated quotes (recommended)
//    DEPLOYED_PATH      path to config/deployed.json (default: ../config/deployed.json)
//    DRY_RUN            "1" = log what would run, don't send txs
//
//  Run:
//    node keeper/keeper.js
//
//  PM2:
//    pm2 start ecosystem.keeper.config.cjs
// ═══════════════════════════════════════════════════════════════════════

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Load .env from the project root so PM2 cron_restart + manual runs both
// pick up DEPLOYER_KEY / ARB_RPC / ZERO_X_KEY without extra wiring.
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch (_) {}

// ─────────── Config ───────────
const ARB_RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc";
// Prefer KEEPER_KEY if set (dedicated operational key), else fall back to
// DEPLOYER_KEY so the first live run works against the current .env.
const KEEPER_KEY = process.env.KEEPER_KEY || process.env.DEPLOYER_KEY;
// Matches both ZEROEX_API_KEY (keeper README name) and ZERO_X_KEY (user's .env name).
const ZEROEX_API_KEY = process.env.ZEROEX_API_KEY || process.env.ZERO_X_KEY || "";
const DEPLOYED_PATH = process.env.DEPLOYED_PATH
  || path.join(__dirname, "..", "config", "deployed.json");
const DRY_RUN = process.env.DRY_RUN === "1";

const ZEROEX_V2_API = "https://api.0x.org/swap/permit2/quote";
const PYTH_HERMES_API = "https://hermes.pyth.network/v2/updates/price/latest";

// Pyth contract on Arbitrum + price IDs the keeper should push every tick.
// Add to this list when new Pyth-backed tokens are added to any basket.
const PYTH_ARBITRUM = "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C";
const PYTH_PRICE_IDS = [
  "0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4", // PEPE/USD
];

/// Drift bps — asymmetric thresholds. See feedback_real_yield_strategy.md:
/// pure threshold rebalancing doesn't generate alpha, but asymmetric
/// thresholds create a DCA bias (buy dips more aggressively than sell peaks)
/// which is a mild volatility-capture improvement in range-bound markets.
///
/// SELL when a token's overweight drift exceeds DRIFT_SELL_BPS.
/// BUY when a token's underweight drift (absolute) exceeds DRIFT_BUY_BPS.
const DRIFT_SELL_BPS = 300; // 3% — take profits on winners less frequently
const DRIFT_BUY_BPS  = 200; // 2% — DCA into losers more frequently
/// Back-compat alias used in old log lines; treat as the max of the two.
const DRIFT_REBALANCE_BPS = DRIFT_SELL_BPS;

/// Slippage tolerance applied to 0x-reported buyAmount for on-chain minOut.
const SLIPPAGE_BPS = 50; // 0.5%

/// Minimum idle USDC before executeBuyBasket bothers routing ($1).
/// Low floor so bootstrap-phase pools with a few dollars can still
/// route USDC into the basket.
const MIN_IDLE_USDC = 1_000_000n;

/// Per-tick rebalance target in USDC units. Repeated ticks converge drift.
/// Clamped per-call to basketValue * maxRebalanceSizeBps * 0.9 so small
/// baskets don't trip RebalanceTooBig() on-chain.
const REBAL_USD = 500_000_000n; // $500 cap

// ─────────── ABIs ───────────
const VAULT_ABI = [
  "function harvestYield() external",
  "function executeBuyBasket(address tokenOut, uint256 usdcAmount, uint256 minOut, address swapTarget, bytes swapCalldata) external",
  "function executeRebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address swapTarget, bytes swapCalldata) external",
  "function executeWithdrawalSwap(uint256 posId, address tokenIn, uint256 amountIn, uint256 minOut, address swapTarget, bytes swapCalldata) external",
  "function completeWithdraw(uint256 posId) external",
  "function getBasketDrift() external view returns (address[] tokens, uint256[] currentBps, uint256[] targetBps, int256[] driftBps)",
  "function basketTokens(uint256) external view returns (address token, uint256 targetWeightBps, address priceFeed, uint8 feedDecimals, uint8 tokenDecimals)",
  "function basketLength() external view returns (uint256)",
  "function trustedSwapTargets(address) external view returns (bool)",
  "function nextPosId() external view returns (uint256)",
  "function positions(uint256) external view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function pendingWithdraws(uint256) external view returns (address user, uint256 usdcGathered, uint256 yieldUSDC, uint256 basketUSDC, uint256 feeBps, uint256 requestTime)",
  "function wsdmTotalSupply() external view returns (uint256)",
  "function totalBasketValue() external view returns (uint256)",
  "function maxRebalanceSizeBps() external view returns (uint16)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const FEED_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

const PYTH_ABI = [
  "function updatePriceFeeds(bytes[] updateData) external payable",
  "function getUpdateFee(bytes[] updateData) external view returns (uint256)",
];

const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// ─────────── GMX Adapter ABI (for push/pull/settle) ───────────
const GMX_ADAPTER_ABI = [
  "function floatExcess() view returns (bool excess, uint256 amount)",
  "function floatDeficit() view returns (bool deficit, uint256 amount)",
  "function pushToGmx(uint256 minGmTokens) payable returns (bytes32)",
  "function pullFromGmx(uint256 gmAmount, uint256 minUsdcOut) payable returns (bytes32)",
  "function settleDeposit() external",
  "function settleWithdrawal() external",
  "function idleUsdc() view returns (uint256)",
  "function gmBalance() view returns (uint256)",
  "function pendingDeposit() view returns (uint256)",
  "function pendingWithdrawal() view returns (uint256)",
];

/// GMX keeper execution fee — enough ETH to cover the GMX keeper gas.
/// Excess is refunded. 0.001 ETH ≈ $2 at current prices, plenty for Arbitrum.
const GMX_EXECUTION_FEE = ethers.parseEther("0.001");

// ─────────── Logging ───────────
function log(level, pool, msg, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    pool,
    msg,
    ...data,
  }));
}

// ─────────── Pyth push ───────────
/// Fetch the latest Pyth update VAAs from Hermes for a list of price IDs.
/// Returns an array of 0x-prefixed hex strings ready for updatePriceFeeds().
async function fetchHermesUpdates(priceIds) {
  if (priceIds.length === 0) return [];
  const params = new URLSearchParams();
  for (const id of priceIds) params.append("ids[]", id);
  params.append("encoding", "hex");

  const res = await fetch(`${PYTH_HERMES_API}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const raw = body?.binary?.data || [];
  return raw.map((h) => (h.startsWith("0x") ? h : "0x" + h));
}

/// Push all required Pyth updates on-chain. Pays the fee from the keeper EOA.
async function pushPythUpdates(signer, poolId) {
  if (PYTH_PRICE_IDS.length === 0) return;
  let updateData;
  try {
    updateData = await fetchHermesUpdates(PYTH_PRICE_IDS);
  } catch (e) {
    log("warn", poolId, "hermes fetch failed", { error: e.message.slice(0, 120) });
    return;
  }
  if (updateData.length === 0) {
    log("warn", poolId, "hermes returned no updates");
    return;
  }

  const pyth = new ethers.Contract(PYTH_ARBITRUM, PYTH_ABI, signer);
  let fee;
  try {
    fee = await pyth.getUpdateFee(updateData);
  } catch (e) {
    log("warn", poolId, "pyth getUpdateFee failed", { error: e.message.slice(0, 120) });
    return;
  }

  if (DRY_RUN) {
    log("info", poolId, "DRY: would push Pyth updates", { fee: fee.toString(), count: updateData.length });
    return;
  }
  try {
    const tx = await pyth.updatePriceFeeds(updateData, { value: fee });
    const rcpt = await tx.wait();
    log("info", poolId, "pyth updated", { tx: rcpt.hash, fee: fee.toString() });
  } catch (e) {
    log("warn", poolId, "pyth updatePriceFeeds failed", { error: e.message.slice(0, 120) });
  }
}

// ─────────── 0x API ───────────
async function fetch0xQuote({ chainId, sellToken, buyToken, sellAmount, taker }) {
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
    taker,
  });
  const headers = { "0x-version": "v2" };
  if (ZEROEX_API_KEY) headers["0x-api-key"] = ZEROEX_API_KEY;

  const res = await fetch(`${ZEROEX_V2_API}?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new Error(`0x API ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

// ─────────── Basket token helpers ───────────
/// Load the full basket-token config array from a vault contract.
async function loadBasket(vault) {
  const len = Number(await vault.basketLength());
  const out = [];
  for (let i = 0; i < len; i++) {
    const t = await vault.basketTokens(i);
    out.push({
      index: i,
      token: t.token,
      targetWeightBps: Number(t.targetWeightBps),
      priceFeed: t.priceFeed,
      feedDecimals: Number(t.feedDecimals),
      tokenDecimals: Number(t.tokenDecimals),
    });
  }
  return out;
}

/// Convert a USDC amount (6-dec) to a token-native amount using the token's
/// Chainlink feed. Returns 0 if the token has no feed (stablecoin).
async function usdcToTokenAmount(provider, tokenConfig, usdcAmount) {
  // Stablecoin (no feed): 1:1 with 6-dec USDC.
  if (tokenConfig.priceFeed === ethers.ZeroAddress) {
    // usdcAmount [1e6] → tokenAmount [tokDec]
    const scale = 10n ** BigInt(tokenConfig.tokenDecimals - 6);
    return BigInt(usdcAmount) * scale;
  }
  const feed = new ethers.Contract(tokenConfig.priceFeed, FEED_ABI, provider);
  const [, answer] = await feed.latestRoundData();
  const price = BigInt(answer); // 1e feedDec
  if (price <= 0n) return 0n; // oracle returned zero or negative — skip
  const feedDec = BigInt(tokenConfig.feedDecimals);
  const tokDec = BigInt(tokenConfig.tokenDecimals);
  // tokenAmount = usdcAmount * 10^(tokDec + feedDec - 6) / price
  const num = BigInt(usdcAmount) * (10n ** (tokDec + feedDec - 6n));
  return num / price;
}

// ─────────── Main entry ───────────
async function main() {
  if (!KEEPER_KEY) {
    console.error("KEEPER_KEY env var not set");
    process.exit(1);
  }

  const deployed = JSON.parse(fs.readFileSync(DEPLOYED_PATH, "utf8"));
  const chainId = deployed.chainId;

  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const signer = new ethers.Wallet(KEEPER_KEY, provider);
  log("info", "keeper", "starting", {
    keeper: signer.address,
    chainId,
    dryRun: DRY_RUN,
    pools: Object.keys(deployed.pools),
  });

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, provider);

  // Push Pyth updates once per tick before any pool touches the oracle.
  await pushPythUpdates(signer, "keeper");

  for (const [poolId, pool] of Object.entries(deployed.pools)) {
    if (!pool.vault) continue;
    if (pool.deprecated) {
      log("info", poolId, "skipping deprecated pool");
      continue;
    }
    try {
      await runPool(poolId, pool, { signer, provider, chainId, usdc });
    } catch (e) {
      log("error", poolId, "pool loop failed", { error: e.message });
    }
  }

  log("info", "keeper", "done");
}

// ─────────── Per-pool loop ───────────
async function runPool(poolId, pool, ctx) {
  const { signer, provider, usdc } = ctx;
  const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
  const vaultAddr = pool.vault;

  // ───── 1. Harvest ─────
  try {
    if (DRY_RUN) {
      log("info", poolId, "DRY: would harvestYield");
    } else {
      const tx = await vault.harvestYield();
      const rcpt = await tx.wait();
      log("info", poolId, "harvested", { tx: rcpt.hash, gas: rcpt.gasUsed.toString() });
    }
  } catch (e) {
    log("warn", poolId, "harvest skipped", { error: e.message.slice(0, 100) });
  }

  // ───── 1b. GMX Adapter: push/pull/settle ─────
  if (pool.yieldSource === "gmx-v2-gm-eth-usdc") {
    try {
      await runGmxCycle(pool, signer, poolId);
    } catch (e) {
      log("warn", poolId, "gmx cycle failed", { error: e.message.slice(0, 120) });
    }
  }

  // ───── 2. Basket state ─────
  let basket;
  try {
    basket = await loadBasket(vault);
  } catch (e) {
    log("warn", poolId, "basketLength failed", { error: e.message.slice(0, 80) });
    return;
  }
  if (basket.length === 0) {
    log("info", poolId, "basket not seeded — skipping basket ops");
    return;
  }

  let drift;
  try {
    drift = await vault.getBasketDrift();
  } catch (e) {
    log("warn", poolId, "getBasketDrift failed", { error: e.message.slice(0, 100) });
    return;
  }

  const tokens = drift[0];
  const driftBps = drift[3];

  log("info", poolId, "drift", {
    snapshot: tokens.map((t, i) => ({
      token: t,
      current: Number(drift[1][i]),
      target: Number(drift[2][i]),
      drift: Number(driftBps[i]),
    })),
  });

  // ───── 3. Route idle USDC to most-underweight token ─────
  const idleUsdc = await usdc.balanceOf(vaultAddr);
  if (idleUsdc >= MIN_IDLE_USDC) {
    let worstIdx = -1;
    let worstDrift = 0n;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase() === USDC_ADDR.toLowerCase()) continue;
      const d = BigInt(driftBps[i]);
      if (d < worstDrift) { worstDrift = d; worstIdx = i; }
    }
    if (worstIdx >= 0) {
      const tokenOut = tokens[worstIdx];
      const spendUsdc = idleUsdc / 2n; // fill half the gap per tick
      try {
        await executeBuyBasket(vault, vaultAddr, tokenOut, spendUsdc, ctx, poolId);
      } catch (e) {
        log("warn", poolId, "buyBasket failed", { error: e.message.slice(0, 120) });
      }
    }
  }

  // ───── 4. Rebalance: find largest over+under pair ─────
  let maxOverIdx = -1, maxUnderIdx = -1;
  let maxOver = 0n, maxUnder = 0n;
  for (let i = 0; i < tokens.length; i++) {
    const d = BigInt(driftBps[i]);
    if (d > maxOver) { maxOver = d; maxOverIdx = i; }
    if (d < maxUnder) { maxUnder = d; maxUnderIdx = i; }
  }
  // Asymmetric rebalance trigger: fire if the overweight token exceeds
  // DRIFT_SELL_BPS (3%) OR if the underweight token's absolute drift
  // exceeds DRIFT_BUY_BPS (2%). Either direction justifies the swap.
  // The -maxUnder flips the sign so we compare positive bps on both sides.
  const sellTriggered = maxOver    >= BigInt(DRIFT_SELL_BPS);
  const buyTriggered  = (-maxUnder) >= BigInt(DRIFT_BUY_BPS);
  if ((sellTriggered || buyTriggered) && maxOverIdx !== -1 && maxUnderIdx !== -1) {
    try {
      const inCfg = basket.find((b) => b.token.toLowerCase() === tokens[maxOverIdx].toLowerCase());
      const outCfg = basket.find((b) => b.token.toLowerCase() === tokens[maxUnderIdx].toLowerCase());
      log("info", poolId, "asymmetric rebalance trigger", {
        sellTriggered, buyTriggered,
        maxOver: maxOver.toString(),
        maxUnder: maxUnder.toString(),
      });
      await executeRebalance(vault, inCfg, outCfg, ctx, poolId);
    } catch (e) {
      log("warn", poolId, "rebalance failed", { error: e.message.slice(0, 120) });
    }
  }

  // ───── 5. Process pending withdrawals ─────
  const nextPosId = Number(await vault.nextPosId());
  for (let posId = 1; posId < nextPosId; posId++) {
    try {
      const pos = await vault.positions(posId);
      if (Number(pos.withdrawStatus) !== 1) continue; // only REQUESTED

      await processPendingWithdraw(vault, vaultAddr, posId, pos, basket, ctx, poolId);
    } catch (e) {
      log("warn", poolId, "pending-withdraw step failed", { posId, error: e.message.slice(0, 120) });
    }
  }
}

// ─────────── Pending withdrawal flow ───────────
async function processPendingWithdraw(vault, vaultAddr, posId, pos, basket, ctx, poolId) {
  const { signer, provider } = ctx;
  const wsdmTotalSupply = BigInt(await vault.wsdmTotalSupply());
  if (wsdmTotalSupply === 0n) {
    // No basket shares → just complete.
    if (!DRY_RUN) {
      const tx = await vault.completeWithdraw(posId);
      const rcpt = await tx.wait();
      log("info", poolId, "withdraw completed (no basket)", { posId, tx: rcpt.hash });
    }
    return;
  }

  // For every non-USDC basket token the vault currently holds, sell this
  // position's pro-rata slice: tokenAmount = bal * pos.wsdmAmount / wsdmTotalSupply
  let anySold = false;
  for (const bt of basket) {
    if (bt.token.toLowerCase() === USDC_ADDR.toLowerCase()) continue;
    const erc20 = new ethers.Contract(bt.token, ERC20_ABI, provider);
    const bal = BigInt(await erc20.balanceOf(vaultAddr));
    if (bal === 0n) continue;

    const amountIn = (bal * BigInt(pos.wsdmAmount)) / wsdmTotalSupply;
    if (amountIn === 0n) continue;

    try {
      const quote = await fetch0xQuote({
        chainId: ctx.chainId,
        sellToken: bt.token,
        buyToken: USDC_ADDR,
        sellAmount: amountIn.toString(),
        taker: vaultAddr,
      });
      const buyAmount = BigInt(quote.buyAmount);
      const minOut = (buyAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
      const swapTarget = quote.transaction.to;
      const swapData = quote.transaction.data;

      if (!(await vault.trustedSwapTargets(swapTarget))) {
        log("warn", poolId, "withdraw 0x target not trusted", { swapTarget, tokenIn: bt.token });
        continue;
      }

      if (DRY_RUN) {
        log("info", poolId, "DRY: would executeWithdrawalSwap", { posId, tokenIn: bt.token, amountIn: amountIn.toString(), minOut: minOut.toString() });
        anySold = true;
        continue;
      }

      const tx = await vault.executeWithdrawalSwap(posId, bt.token, amountIn, minOut, swapTarget, swapData);
      const rcpt = await tx.wait();
      log("info", poolId, "withdrawal swap", { posId, tokenIn: bt.token, tx: rcpt.hash });
      anySold = true;
    } catch (e) {
      log("warn", poolId, "withdraw swap step failed", { posId, tokenIn: bt.token, error: e.message.slice(0, 120) });
    }
  }

  // If nothing left to sell, complete the withdrawal.
  if (!anySold && !DRY_RUN) {
    try {
      const tx = await vault.completeWithdraw(posId);
      const rcpt = await tx.wait();
      log("info", poolId, "withdraw completed", { posId, tx: rcpt.hash });
    } catch (e) {
      log("warn", poolId, "completeWithdraw failed", { posId, error: e.message.slice(0, 120) });
    }
  } else if (anySold) {
    log("info", poolId, "withdraw: sold leg this tick, will complete next tick", { posId });
  }
}

// ─────────── Action helpers ───────────
async function executeBuyBasket(vault, vaultAddr, tokenOut, spendUsdc, ctx, poolId) {
  const quote = await fetch0xQuote({
    chainId: ctx.chainId,
    sellToken: USDC_ADDR,
    buyToken: tokenOut,
    sellAmount: spendUsdc.toString(),
    taker: vaultAddr,
  });
  const buyAmount = BigInt(quote.buyAmount);
  const minOut = (buyAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const swapTarget = quote.transaction.to;
  const swapData = quote.transaction.data;

  if (!(await vault.trustedSwapTargets(swapTarget))) {
    log("warn", poolId, "0x quote target not trusted", { swapTarget });
    return;
  }

  if (DRY_RUN) {
    log("info", poolId, "DRY: would executeBuyBasket", {
      tokenOut, spend: spendUsdc.toString(), minOut: minOut.toString(), swapTarget,
    });
    return;
  }
  const tx = await vault.executeBuyBasket(tokenOut, spendUsdc, minOut, swapTarget, swapData);
  const rcpt = await tx.wait();
  log("info", poolId, "buyBasket", { tokenOut, tx: rcpt.hash, gas: rcpt.gasUsed.toString() });
}

async function executeRebalance(vault, inCfg, outCfg, ctx, poolId) {
  // Clamp desired USDC size to what the vault's maxRebalanceSizeBps allows.
  // Vault reverts RebalanceTooBig() when inValueUSDC > basketValue*maxBps/1e4.
  // Use 90% of the cap to leave headroom for oracle drift.
  let targetUsdc = REBAL_USD;
  try {
    const [basketVal, maxBps] = await Promise.all([
      vault.totalBasketValue(),
      vault.maxRebalanceSizeBps(),
    ]);
    const cap = (basketVal * BigInt(maxBps) * 9n) / (10_000n * 10n);
    if (cap < targetUsdc) targetUsdc = cap;
  } catch (e) {
    log("warn", poolId, "rebalance cap lookup failed, using default", { error: e.message.slice(0, 80) });
  }
  if (targetUsdc < 1_000_000n) {
    log("info", poolId, "rebalance skipped — cap below $1", { cap: targetUsdc.toString() });
    return;
  }

  // Convert clamped USDC size to tokenIn native units via Chainlink feed.
  const tokenInAmount = await usdcToTokenAmount(ctx.provider, inCfg, targetUsdc);
  if (tokenInAmount === 0n) return;

  const quote = await fetch0xQuote({
    chainId: ctx.chainId,
    sellToken: inCfg.token,
    buyToken: outCfg.token,
    sellAmount: tokenInAmount.toString(),
    taker: await vault.getAddress(),
  });
  const buyAmount = BigInt(quote.buyAmount);
  const minOut = (buyAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const swapTarget = quote.transaction.to;
  const swapData = quote.transaction.data;

  if (!(await vault.trustedSwapTargets(swapTarget))) {
    log("warn", poolId, "0x rebalance target not trusted", { swapTarget });
    return;
  }

  if (DRY_RUN) {
    log("info", poolId, "DRY: would executeRebalance", {
      tokenIn: inCfg.token,
      tokenOut: outCfg.token,
      amountIn: tokenInAmount.toString(),
      minOut: minOut.toString(),
    });
    return;
  }

  const tx = await vault.executeRebalance(inCfg.token, outCfg.token, tokenInAmount, minOut, swapTarget, swapData);
  const rcpt = await tx.wait();
  log("info", poolId, "rebalance", { tokenIn: inCfg.token, tokenOut: outCfg.token, tx: rcpt.hash });
}

// ─────────── GMX Adapter: push/pull/settle cycle ───────────
async function runGmxCycle(pool, signer, poolId) {
  const adapter = new ethers.Contract(pool.adapter, GMX_ADAPTER_ABI, signer);

  const idle = await adapter.idleUsdc();
  const gm = await adapter.gmBalance();
  const pendDep = await adapter.pendingDeposit();
  const pendWd = await adapter.pendingWithdrawal();

  log("info", poolId, "gmx state", {
    idleUsdc: ethers.formatUnits(idle, 6),
    gmBalance: ethers.formatUnits(gm, 18),
    pendingDeposit: ethers.formatUnits(pendDep, 6),
    pendingWithdrawal: ethers.formatUnits(pendWd, 18),
  });

  // ── Step 1: Settle any completed GMX operations ──
  // If there's a pending deposit but GM balance increased, the GMX keeper
  // has executed. Clear the pending state.
  if (pendDep > 0n && gm > 0n) {
    log("info", poolId, "gmx settling deposit");
    if (!DRY_RUN) {
      const tx = await adapter.settleDeposit();
      const rcpt = await tx.wait();
      log("info", poolId, "gmx deposit settled", { tx: rcpt.hash });
    }
  }

  // If there's a pending withdrawal but idle USDC increased beyond what
  // we'd expect from vault deposits alone, the GMX withdrawal settled.
  if (pendWd > 0n) {
    // Simple heuristic: if pendingWithdrawal > 0 but gmBalance decreased
    // from the amount we sent, assume it settled. For robustness, just always
    // settle — it's a no-op if nothing changed.
    log("info", poolId, "gmx settling withdrawal");
    if (!DRY_RUN) {
      const tx = await adapter.settleWithdrawal();
      const rcpt = await tx.wait();
      log("info", poolId, "gmx withdrawal settled", { tx: rcpt.hash });
    }
  }

  // ── Step 2: Push excess float to GMX ──
  const [hasExcess, excessAmt] = await adapter.floatExcess();
  if (hasExcess && excessAmt > 1_000_000n) { // only push if > $1
    log("info", poolId, "gmx pushing excess to GMX", {
      amount: ethers.formatUnits(excessAmt, 6),
    });
    if (!DRY_RUN) {
      try {
        const tx = await adapter.pushToGmx(0, { value: GMX_EXECUTION_FEE });
        const rcpt = await tx.wait();
        log("info", poolId, "gmx pushToGmx", { tx: rcpt.hash, gas: rcpt.gasUsed.toString() });
      } catch (e) {
        log("warn", poolId, "gmx pushToGmx failed", { error: e.message.slice(0, 120) });
      }
    }
  }

  // ── Step 3: Pull from GMX if float is low ──
  const [hasDeficit, deficitAmt] = await adapter.floatDeficit();
  if (hasDeficit && deficitAmt > 1_000_000n && gm > 0n) {
    // Withdraw proportional GM to cover the deficit, not all.
    // Estimate: GM value ≈ idle + gm_value, so gmToWithdraw ≈ gm * deficit / (idle + deficit).
    // Cap at total GM balance. Use a 20% buffer so we don't under-pull.
    const totalEstimate = idle + deficitAmt; // rough proxy for total adapter value
    let gmToWithdraw = totalEstimate > 0n
      ? (gm * deficitAmt * 120n) / (totalEstimate * 100n)
      : gm;
    if (gmToWithdraw > gm) gmToWithdraw = gm;
    log("info", poolId, "gmx pulling from GMX (float deficit)", {
      deficit: ethers.formatUnits(deficitAmt, 6),
      gmToWithdraw: ethers.formatUnits(gmToWithdraw, 18),
    });
    if (!DRY_RUN) {
      try {
        const tx = await adapter.pullFromGmx(gmToWithdraw, 0, { value: GMX_EXECUTION_FEE });
        const rcpt = await tx.wait();
        log("info", poolId, "gmx pullFromGmx", { tx: rcpt.hash, gas: rcpt.gasUsed.toString() });
      } catch (e) {
        log("warn", poolId, "gmx pullFromGmx failed", { error: e.message.slice(0, 120) });
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
