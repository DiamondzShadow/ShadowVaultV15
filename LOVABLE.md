# ShadowVaultV15 — Lovable Frontend Brief

> **One-sentence pitch:** A multi-pool Arbitrum index vault where users deposit USDC, get a dynamic on-chain NFT receipt, earn Aave/Silo/Fluid yield plus auto-rebalanced basket exposure across blue-chip, DeFi+RWA, and full-spectrum baskets — with SDM-holder fee discounts and tier-locked boosts up to 3×.

**Live on Arbitrum mainnet (v15.3.1).** Keeper cron runs every 3 hours. BonusAccumulatorV2.1 `0x73c793E669e393aB02ABc12BccD16eF188514026` (vault-namespaced + forgiving deregister). 0x v2 AllowanceHolder trusted on all pools.

---

## Tech stack to use in Lovable

| Concern | Use | Per CLAUDE.md rule |
|---|---|---|
| Chain | **Arbitrum One (42161)** — hardcode, no chain switcher | ✓ |
| TX library | **Thirdweb v5 `^5.119.1`** — `useSendTransaction`, `useReadContract`, `useActiveAccount` | ✓ never wagmi/viem |
| Read-only (off-frontend scripts) | ethers v6 | ✓ |
| Contract bundle | `import { ADDRESSES, VAULT_ABI, ... } from './abi/v15'` | Already generated in `~/ShadowVaultV15/abi/v15.ts` — drop into Lovable src |

---

## Pages you asked for

### 1. Vault page (USER) — **READY TO BUILD**

The main user interface. Wallet connects, picks a pool, deposits USDC with a tier lock, gets an NFT back, manages positions.

**What's live:**
- 3 pools (A/B/C) with 3/6/8 basket tokens respectively
- 5 tiers: FLEX (1×), 30D (1.2×), 90D (1.5×), 180D (2×), 365D (3×)
- SDM holders ≥ 10,000 SDM get **50% discount** on on-time fee (0.60% vs 1.20%)
- Two-step withdrawal: `requestWithdraw` → keeper sells basket → `completeWithdraw`
- FLEX tier can `claimYield` or `compoundYield` anytime
- Everything reads from `VAULT_ABI`, `NFT_ABI`, `BONUS_ACCUMULATOR_ABI` in `v15.ts`

**Key reads per pool (all live):**
```ts
vault.totalDeposited()         // uint256 USDC (6-dec)
vault.totalYieldHarvested()    // uint256 USDC lifetime
vault.totalFeesCollected()     // uint256 USDC to treasury
vault.wsdmTotalSupply()        // basket share total (6-dec)
vault.yieldTotalShares()       // boosted yield-adapter allocation total
vault.basketLength()           // number of basket tokens
vault.basketTokens(i)          // (token, weightBps, priceFeed, feedDecimals, tokenDecimals, maxStalenessSecs)
vault.getBasketDrift()         // (tokens, currentBps, targetBps, driftBps)
vault.estimatePositionValue(id) // (basketVal, yieldVal, total)
vault.positions(id)            // full Position struct
nft.ownerOf(id)                // EVM address
nft.tokenURI(id)               // data:application/json;base64,... dynamic SVG
bonusAcc.pendingForToken(id)   // USDC, accrued across Bridge/SDM/Validator streams
```

**Key writes:**
```ts
USDC.approve(vaultAddr, amount)
vault.deposit(amount, tier)               // 0=FLEX 1=30D 2=90D 3=180D 4=365D → mints NFT
vault.requestWithdraw(posId)              // step 1
vault.completeWithdraw(posId)             // step 2 (anyone can call after keeper sells, or user after 30 min)
vault.claimYield(posId)                   // FLEX only
vault.compoundYield(posId)                // FLEX only — reinvest into basket
bonusAcc.claim(posId)                     // claim bridge/SDM/validator bonuses
```

**Thirdweb v5 snippet — deposit:**
```tsx
import { useSendTransaction, useActiveAccount } from "thirdweb/react";
import { getContract, prepareContractCall } from "thirdweb";
import { ADDRESSES, VAULT_ABI, ERC20_ABI, TOKENS } from "@/abi/v15";
import { arbitrum } from "thirdweb/chains";

export function DepositButton({ poolId, amountUsdc, tier }: { poolId: "A"|"B"|"C", amountUsdc: bigint, tier: 0|1|2|3|4 }) {
  const account = useActiveAccount();
  const { mutate: sendTx, isPending } = useSendTransaction();

  const vault = getContract({ client, chain: arbitrum, address: ADDRESSES.pools[poolId].vault, abi: VAULT_ABI });
  const usdc  = getContract({ client, chain: arbitrum, address: TOKENS.USDC.address, abi: ERC20_ABI });

  async function go() {
    // 1. Approve USDC
    const approveTx = prepareContractCall({
      contract: usdc,
      method: "approve",
      params: [ADDRESSES.pools[poolId].vault, amountUsdc],
    });
    await sendTx(approveTx);

    // 2. Deposit
    const depositTx = prepareContractCall({
      contract: vault,
      method: "deposit",
      params: [amountUsdc, tier],
    });
    await sendTx(depositTx);
  }
  return <button disabled={!account || isPending} onClick={go}>Deposit ${Number(amountUsdc) / 1e6}</button>;
}
```

**"Fire" design notes:**
- Dark theme (`#0f0f14` bg matches the NFT SVG)
- Tier colors: FLEX green `#22c55e`, 30D blue `#3b82f6`, 90D purple `#a855f7`, 180D gold `#eab308`, 365D red `#ef4444`
- Show the NFT preview as the HERO of each position card — `tokenURI` returns a base64 SVG you can `<img src={dataUri}/>` directly
- Show effective fee badge: if user holds ≥10k SDM, flash "SDM 50% OFF" badge
- Pool A → Blue Chip badge, Pool B → DeFi + RWA badge, Pool C → Full Spectrum badge
- Basket weights as a stacked bar chart that drifts over time (read `getBasketDrift` on a 10s interval)
- Live APY readout — compute from `totalYieldHarvested / totalDeposited × 365 / days_since_deploy`

---

### 2. Oracle page — **v15.3.2 MISSION CONTROL REDESIGN**

**Design intent:** this is not a spreadsheet — it's a Bloomberg-style live dashboard. Every number updates every 10s, hero metrics are 48-96pt, protocol logos glow, sparklines pulse, actionable drift cards have a red pulse border, tokens tickker across the top. When Pool A is earning, a little green ↗ floats next to the yield number. When drift hits 3%, the Trade Opportunities card expands and animates. A user should be able to glance at this page and immediately know: "what do I own, what's it earning, what's about to happen."

**Eight sections** stacked top to bottom, each in its own dark card with a subtle gradient border. Uses `framer-motion` for all number transitions (tween 400ms), `recharts` for sparklines/gauges, pulse via Tailwind's `animate-pulse`. Import from the regenerated bundle:

```ts
import {
  ADDRESSES, VAULT_ABI, NFT_ABI, YIELD_ADAPTER_ABI,
  KEEPER, TOKENS, TIER,
  CHAINLINK_FEED_ABI, AAVE_POOL_ABI, ERC4626_ABI,
  AAVE_V3_POOL_ARBITRUM, ARBITRUM_SEQUENCER_UPTIME_FEED,
} from "@/abi/v15";
```

---

#### 2-HERO. Top-of-page TVL ticker (full width, 120px tall)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ShadowVault V15 · Arbitrum                                          │
│                                                                      │
│   $ 20.00   TVL        3 pools        2.87% blended APR              │
│   ─────    ─────      ─────          ──────                         │
│   +0.00%   since       WETH BTC GMX   on yield legs                  │
│   24h      04-11       ARB LINK PEPE                                 │
│                                                                      │
│  [Pool A · $12]  [Pool B · $5 ]  [Pool C · $3]   next keeper: 48m   │
└──────────────────────────────────────────────────────────────────────┘
```

Reads: sum of `totalDeposited()` across all pools. 24h sparkline via subgraph or by re-reading at `block.number - 7200` (approx 24h ago on Arbitrum) and computing delta. The three pool chips at the bottom are clickable and scroll the page to that pool's cards.

---

#### 2A. Per-pool yield source card — BIG and visually striking (1 card × 3 pools)

For each pool, a full-width card showing the underlying protocol prominently. Each card has:

- **Protocol logo** (64×64) top-left — Aave / Silo / Fluid SVG
- **Hero APR** 72pt font, green `#22c55e` — live from protocol
- **Deployed** amount 48pt, with a live-incrementing counter that ticks every second using `currentLiquidityRate` extrapolation so the number visibly grows (psychological: "this is earning RIGHT NOW")
- **Realized yield** (lifetime) 32pt
- **Projected annual** at current APR 32pt — "$X.XX/year at 2.87%"
- **Mini sparkline** of totalAssets over last 24h (requires off-chain polling history)
- **Harvest button** (keeper-only, disabled for users, tooltip: "Next auto-harvest: HH:MM UTC")
- **Status pill**: `🟢 LIVE` or `⏸ PAUSED` or `🔴 SILO FULL` (if pool B Silo utilization > 95%)

**Data reads:**
```ts
// Per-pool parallel reads
const [totalYieldHarvested, yieldTotalShares, adapterTotalAssets, basketValue] =
  await Promise.all([
    readContract({ contract: vault, method: "totalYieldHarvested" }),  // realized lifetime
    readContract({ contract: vault, method: "yieldTotalShares" }),
    readContract({ contract: adapter, method: "totalAssets" }),        // currently deployed
    readContract({ contract: vault, method: "totalBasketValue" }),     // basket leg in USDC
  ]);

// Live APR from underlying protocol (NOT from vault):
// Pool A (Aave):
const rd = await readContract({
  contract: getContract({ client, chain: arbitrum, address: AAVE_V3_POOL_ARBITRUM, abi: AAVE_POOL_ABI }),
  method: "getReserveData",
  params: [TOKENS.USDC.address],
});
const aprBps = (rd.currentLiquidityRate * 31_536_000n * 10_000n) / (10n ** 27n);
const aprPct = Number(aprBps) / 100;  // → 2.87

// Pool C (Fluid ERC-4626 fToken):
// fToken.convertToAssets(1e18) sampled at two blocks ~60s apart → instantaneous APR
const sampleA = await readContract({ contract: fluidFToken, method: "convertToAssets", params: [10n**18n], block: "latest" });
// (60s later, or at blockNumber - 5)
const sampleB = await readContract({ contract: fluidFToken, method: "convertToAssets", params: [10n**18n], block: blockNumBefore });
const growth = (sampleA * 10n**18n) / sampleB - 10n**18n;
const annualized = (growth * (365n * 24n * 60n)) / 60n;  // crude extrapolation
const fluidAprPct = Number(annualized) / 1e16;  // → 3.42

// Pool B (Silo v2): call the Silo market's rate oracle if you have the address,
// else show "N/A" and deep-link to https://v2.silo.finance

// Projected annual yield in USDC on current deployment:
const projectedAnnualUsdc = (adapterTotalAssets * BigInt(Math.floor(aprPct * 100))) / 10_000n;
```

**Card layout (Pool A example):**

```
┌─ Pool A · Blue Chip ─────────────────────────────────────────────┐
│  [Aave logo 64px]       2.87% APR  ↗ live         🟢 LIVE         │
│                         ───────────                                │
│                                                                    │
│   Deployed       Realized       Projected annual                   │
│   $3.00          $0.0000        $0.086                             │
│   ────           ─────          ─────                              │
│   growing:       lifetime       at current rate                    │
│   $3.000002      harvest total                                     │
│                                                                    │
│  [▲▲▁▁▁▁▲ 24h sparkline totalAssets ─────────────────]            │
│                                                                    │
│  Next auto-harvest: 15:00 UTC  (in 48m 12s)                       │
└──────────────────────────────────────────────────────────────────┘
```

Repeat this card layout for Pool B (Silo) and Pool C (Fluid). Color the APR number by source: Aave blue, Silo purple, Fluid teal.

---

#### 2B. **Basket Holdings table** per pool — THE TOKENS HELD VIEW (NEW, directly addresses "it doesn't show tokens held")

This is what was missing from my earlier spec. Each pool has a basket of tokens — the vault holds them literally in its balance. Show a live table of every basket token with quantity, USD value, target vs current weight, drift, and PnL since acquisition.

```ts
// For each pool, walk basketTokens(i) and read live balances + prices
const length = await vault.basketLength();
const rows = [];

for (let i = 0n; i < length; i++) {
  const cfg = await vault.basketTokens(i);
  //  cfg = { token, targetWeightBps, priceFeed, feedDecimals, tokenDecimals, maxStalenessSecs }

  const erc20 = getContract({ client, chain: arbitrum, address: cfg.token, abi: ERC20_ABI });
  const balance = await readContract({ contract: erc20, method: "balanceOf", params: [pool.vault] });

  // Get live price from the bound feed (Chainlink or Pyth wrapper)
  let priceUsd = 1; // USDC fallback
  if (cfg.priceFeed !== "0x0000000000000000000000000000000000000000") {
    const feed = getContract({ client, chain: arbitrum, address: cfg.priceFeed, abi: CHAINLINK_FEED_ABI });
    const [, answer] = await readContract({ contract: feed, method: "latestRoundData" });
    priceUsd = Number(answer) / (10 ** Number(cfg.feedDecimals));
  }

  const qty = Number(balance) / (10 ** Number(cfg.tokenDecimals));
  const valueUsd = qty * priceUsd;
  rows.push({
    symbol: lookupSymbolFromTokens(cfg.token),
    quantity: qty,
    priceUsd,
    valueUsd,
    targetBps: Number(cfg.targetWeightBps),
  });
}

// Compute current bps and drift for each row
const totalValue = rows.reduce((s, r) => s + r.valueUsd, 0);
rows.forEach(r => {
  r.currentBps = totalValue > 0 ? Math.round((r.valueUsd / totalValue) * 10_000) : 0;
  r.driftBps = r.currentBps - r.targetBps;
});
```

**Table layout:**

```
┌─ Pool A · Basket Holdings ──────────────────────────────────────────────────────┐
│  Token    Qty         Price      Value       Weight        Drift   Status       │
│  ──────── ─────────── ────────── ─────────── ───────────── ─────── ──────────   │
│  WETH     0           $3,847.12  $0.00       0% → 45%      -4500   🔴 BUY       │
│  WBTC     0           $110,244   $0.00       0% → 35%      -3500   🔴 BUY       │
│  USDC     7.00        $1.00      $7.00       100% → 20%    +8000   🔴 SELL      │
│                                                                                  │
│  Basket total: $7.00 · Yield leg: $3.00 · Pool total: $10.00                    │
│  Next keeper will swap ~$2.80 USDC → WETH and ~$2.17 USDC → WBTC                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Once basket buys happen (post-keeper-tick), the table will show real WETH/WBTC quantities with live prices. The "Weight" column should be a **stacked bar chart visualization** with two bars: current (top) and target (bottom), so the user visually sees the mismatch.

**Cost basis & token PnL (nice-to-have):** track each basket token's cost basis by summing `KeeperSwapExecuted(tokenIn=USDC, tokenOut=WETH)` events — `avgCost = sum(usdcSpent) / sum(wethBought)`. Then `pnlPct = (currentPrice - avgCost) / avgCost`. If below 1% noise, show `±0%`. Color green/red.

---

#### 2C. Blended yield card per pool — TOTAL YIELD BREAKDOWN (NEW)

Pool yield comes from TWO sources:
1. **Yield adapter APR** on the ~30% parked in Aave/Fluid/Silo
2. **Basket appreciation** on the ~70% held as real tokens (WETH going up in USD = yield)

A lot of users don't realize they're earning on both legs. Show them explicitly:

```
┌─ Pool A · Total Yield Breakdown ──────────────────────────────────┐
│                                                                    │
│   Total yield earned:       $0.00   (+0.00% since deposit)         │
│   ══════════════════════════════════                              │
│                                                                    │
│   ├─ Yield leg (Aave):      $0.0000   at  2.87% APR               │
│   │    Deployed: $3.00                                             │
│   │    Earned:   $0.0000  realized  + $0.0000 unrealized          │
│   │                                                                │
│   ├─ Basket leg (tokens):   $0.00     (WETH/WBTC price moves)     │
│   │    Held:     $7.00                                             │
│   │    Cost basis: $7.00                                           │
│   │    Unrealized PnL: $0.00                                       │
│   │                                                                │
│   └─ Blended APR:           ~0.86%   (weight-adjusted)             │
│        = 0.30 × 2.87% (Aave) + 0.70 × 0.00% (basket ytd)          │
│                                                                    │
│   Projected annual:         $0.172   if rates hold                 │
│   ─────────────────────────────────                               │
│   Est. per-$100 deposit:    $0.86/year                             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Blended APR computation:
```ts
const yieldLegWeight = Number(basketBps); // 7000 = 70% basket
const basketLegWeight = 10_000 - yieldLegWeight;   // 3000 = 30% yield

// yield adapter APR (from 2A) is on the yield leg only
const yieldLegAprPct = aprPct;  // e.g. 2.87

// basket leg APR is unrealized price appreciation, annualized from holdings
// Simple v1: basketPnlSinceDeposit / daysSinceDeposit × 365
// Better v2: compute token-level returns weighted by target weight
const basketLegAprPct = computeBasketApprApr(rows, daysSinceDeposit);

const blendedApr = (yieldLegWeight * yieldLegAprPct + basketLegWeight * basketLegAprPct) / 10_000;
```

---

#### 2D. Per-position PnL card — user-specific (wallet must be connected)

Only shown if `account` is connected and owns at least 1 position NFT. For every position, render a card with the NFT image as the hero:

```
┌─ [NFT SVG 128×128]    Position #2 · Pool A · FLEX ────────────────┐
│                       ────────────────────────────                │
│                       Deposited $5.00 · Apr 11 13:10 UTC          │
│                                                                    │
│                       Current value:  $5.00   (+0.00%)             │
│                       ├─ Basket leg:  $3.50   (your share)         │
│                       └─ Yield leg:   $1.50   earning 2.87%        │
│                                                                    │
│                       Available to claim: $0.0000                  │
│                       [ Claim Yield ]  [ Compound ]                │
│                                                                    │
│                       Unlocks in: FLEX — no lock                   │
│                       [Request Withdraw]                           │
└────────────────────────────────────────────────────────────────────┘
```

Reads:
```ts
const [basketVal, yieldVal, total] = await readContract({
  contract: vault, method: "estimatePositionValue", params: [posId],
});
const pos = await readContract({ contract: vault, method: "positions", params: [posId] });
const availableYield = yieldVal > pos.yieldClaimed ? yieldVal - pos.yieldClaimed : 0n;
const pnl = total - pos.depositAmount;
const pnlPct = Number((pnl * 10_000n) / pos.depositAmount) / 100;

// NFT image (base64 SVG in tokenURI)
const uri = await readContract({ contract: nft, method: "tokenURI", params: [posId] });
const json = JSON.parse(atob(uri.split(",")[1]));
const imgSrc = json.image; // data:image/svg+xml;base64,...
```

**Color the PnL number:** green if positive, red if negative, neutral gray if zero.

Enumerate the user's owned positions via NFT `ownerOf(i)` from 1..nextPosId-1 for each pool (or via `balanceOf(user)` + `tokenOfOwnerByIndex` if the NFT is ERC721Enumerable).

---

#### 2E. Trade Opportunities / Rebalance Preview (redesign — make it LOUD)

Same data as before (`vault.getBasketDrift()` + KEEPER thresholds), but render as a vertically stacked comparison:

```
┌─ Pool A · Next Rebalance — in 48m 12s ────────────────────────────┐
│                                                                    │
│  🔥🔥🔥  3 TRADE OPPORTUNITIES  (drift ≥ 3%)                       │
│                                                                    │
│  ┌────────────────────────┐         ┌────────────────────────┐    │
│  │  SELL  USDC            │    →    │  BUY  WETH             │    │
│  │  ~$2.80                │         │  ~0.000728 WETH        │    │
│  │  (−80% → 20% target)   │         │  (0% → 45% target)     │    │
│  └────────────────────────┘         └────────────────────────┘    │
│                                                                    │
│  ┌────────────────────────┐         ┌────────────────────────┐    │
│  │  SELL  USDC            │    →    │  BUY  WBTC             │    │
│  │  ~$2.17                │         │  ~0.0000197 WBTC       │    │
│  │  (remaining overweight)│         │  (0% → 35% target)     │    │
│  └────────────────────────┘         └────────────────────────┘    │
│                                                                    │
│  ──────────────────────────────────────────────────────────────    │
│  Max per tick: $X.XX  (20% of basket)                              │
│  Slippage tolerance: 0.5%                                          │
│  Using: 0x v2 AllowanceHolder · fallback 1inch v5                  │
└────────────────────────────────────────────────────────────────────┘
```

Each "card" in the sell/buy grid is ~160×100, black background with a 1px neon outline, pulses when `|driftBps| >= 300`. The arrow `→` in the middle animates every 2s.

**Drift coloring (entire card border):**
- `|drift| < 100 bps` → green border "balanced"
- `100 ≤ |drift| < 300` → yellow border "drifting"
- `|drift| ≥ 300 bps` → red border + pulse "actionable next tick"
- `|drift| ≥ 1000 bps` → red border bold + faster pulse "severely unbalanced"

**Countdown to next tick (cron `0 */3 * * *` UTC):**
```ts
const now = new Date();
const nextTick = new Date(now);
nextTick.setUTCMinutes(0, 0, 0);
nextTick.setUTCHours(Math.ceil(now.getUTCHours() / 3) * 3);
if (nextTick <= now) nextTick.setUTCHours(nextTick.getUTCHours() + 3);
const ms = nextTick.getTime() - now.getTime();
const hh = Math.floor(ms / 3_600_000);
const mm = Math.floor((ms % 3_600_000) / 60_000);
const ss = Math.floor((ms % 60_000) / 1000);
// render "Xh YYm ZZs", update every 1s via setInterval
```

---

#### 2F. Feed freshness table (per pool)

Unchanged from earlier — walk `basketTokens(i)`, call `latestRoundData()` on each `priceFeed`, show age vs `maxStalenessSecs`, color STALE red. Put this in a collapsed accordion by default, expand when user clicks — it's important for operators but not hero content for users.

---

#### 2G. Arbitrum sequencer banner

Full-width banner **only renders when problem detected**:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠  ARBITRUM SEQUENCER DOWN — deposits and rebalances paused.    │
│     Feed status: answer=1 since 14:32 UTC · grace period active  │
└──────────────────────────────────────────────────────────────────┘
```

Red `#dc2626` background, white text, sticks to top of page and also top of `/vault` while active. Reads `ARBITRUM_SEQUENCER_UPTIME_FEED.latestRoundData()` on `CHAINLINK_FEED_ABI` every 10s.

---

#### 2H. Footer: Keeper activity feed

Horizontal scrolling ticker of the last 20 keeper actions across all pools. One line per event:

```
14:30 · Pool B · harvest · 221k gas · tx 0x3d26...
12:00 · Pool A · harvest · 77k gas  · tx 0x79ca...
12:00 · Pool C · harvest · 230k gas · tx 0xb027...
...
```

Read events:
```ts
// Filter Deposited / WithdrawRequested / KeeperSwapExecuted / Harvested from last N blocks
const logs = await viemClient.getLogs({
  address: [A, B, C],
  fromBlock: currentBlock - 50_000n,  // ~48h on Arbitrum
  events: parseAbiItems([
    "event Deposited(uint256 indexed posId, address indexed user, uint8 tier, uint256 amount, uint256 wsdm)",
    "event KeeperSwapExecuted(address tokenIn, address tokenOut, uint256 spent, uint256 bought)",
    "event YieldHarvested(uint256 profit)",
  ]),
});
```

---

**Oracle page visual directives for Lovable:**

- Use **Tailwind** with custom colors: `bg-base: #0f0f14`, `bg-card: #161620`, `bg-elevated: #1f1f2e`, `text-primary: #f5f5f7`, `text-muted: #8a8a99`, `accent-aave: #2e5cff`, `accent-silo: #8b5cf6`, `accent-fluid: #14b8a6`, `success: #22c55e`, `warn: #eab308`, `danger: #ef4444`
- Use **framer-motion** for every number transition — `AnimatePresence` + key-changes on updated values, tween 400ms ease-out
- Use **recharts** for sparklines (yield card) and stacked bar charts (holdings weight viz)
- Use **lucide-react** icons: `TrendingUp`, `Flame`, `Zap`, `AlertTriangle`, `Activity`, `Coins`
- Numbers: `font-mono`, `tabular-nums`, `tracking-tight`
- Headers: `font-display` (use Space Grotesk or similar geometric sans)
- Glow effect on hero APR numbers: `text-shadow: 0 0 20px rgba(34,197,94,0.4)`
- Card borders: `1px solid rgba(255,255,255,0.06)` with a subtle gradient glow on hover
- Pulse animation on actionable drift: `animate-pulse` + a custom keyframe for a 2s red-border swell

---

#### 2A. Yield adapter health — per pool

For each pool (A/B/C), show realized yield, unrealized yield, APR estimate, and a sparkline of totalAssets over time. This replaces the prior "totalYieldHarvested only" view that showed ~0 even when positions were earning.

```ts
// Read pool vault + adapter in parallel
const vault = getContract({ client, chain: arbitrum, address: pool.vault, abi: VAULT_ABI });
const adapter = getContract({ client, chain: arbitrum, address: pool.adapter, abi: YIELD_ADAPTER_ABI });

const [
  totalYieldHarvested,   // lifetime realized yield claimed into the vault
  yieldTotalShares,      // sum of boosted yieldShare across active positions
  adapterTotalAssets,    // current USDC value of vault's position inside Aave/Fluid/Silo
] = await Promise.all([
  readContract({ contract: vault,   method: "totalYieldHarvested" }),
  readContract({ contract: vault,   method: "yieldTotalShares" }),
  readContract({ contract: adapter, method: "totalAssets" }),
]);

// Unrealized yield = adapter.totalAssets − principal.
// Principal = sum of all deposits' yield legs minus harvests so far. We can
// approximate principal = adapterTotalAssets at the last harvest tx (read
// from past KeeperSwapExecuted or HarvestYield events) — or use the
// AaveAdapter's internal `principal` state var if you add a public getter.
// For the initial UI, use the simpler path: show totalAssets directly and
// label "Currently deployed".
```

**Card layout per pool:**

```
┌─ Pool A · Blue Chip · Aave ─────────────────────────────────┐
│  Deployed in Aave:   $3.00  ▲ (live)                        │
│  Realized yield:     $0.00  (lifetime)                      │
│  Est. APR:           2.87%  (Aave currentLiquidityRate)     │
│  Est. annual yield:  $0.086 at current APR                  │
│  Next harvest:       15:00 UTC  (in 48m)                    │
└─────────────────────────────────────────────────────────────┘
```

**Live APR per yield source — read from the underlying protocol, not the vault:**

- **Aave (Pool A)** — call Aave v3 Pool `getReserveData(USDC)`:
  ```ts
  const aave = getContract({ client, chain: arbitrum, address: AAVE_V3_POOL_ARBITRUM, abi: AAVE_POOL_ABI });
  const rd = await readContract({ contract: aave, method: "getReserveData", params: [TOKENS.USDC.address] });
  const currentLiquidityRate = rd.currentLiquidityRate;        // uint128 ray (27 dec)
  const SECONDS_PER_YEAR = 31_536_000n;
  const aprBps = (currentLiquidityRate * SECONDS_PER_YEAR * 10_000n) / (10n ** 27n);
  // Render as (Number(aprBps) / 100).toFixed(2) + "%"
  ```

- **Fluid (Pool C)** — the FluidAdapter wraps an ERC-4626 `fUSDC`. Read `totalAssets` and `totalSupply` on the fToken at two points ~60s apart → implied rate. Simpler: compute instantaneous APR from `convertToAssets(1e18) / 1e18` delta between two blocks. Address via `adapter.fToken()` if exposed, else hardcode from deployed.json's adapter config.

- **Silo (Pool B)** — Silo v2 wstUSR/USDC market. Read `siloMarket.getCollateralAssets()` + `getDebtAssets()` for utilization. Utilization × borrow APR × (1 − reserve factor) ≈ supply APR. Silo exposes rate oracles per market — if integration is messy for v1, show "N/A — see Silo UI" and deep-link to `https://v2.silo.finance/market/...`.

**Principal tracking (to show unrealized yield cleanly):**

The current adapter contracts keep `principal` internal. Two options:

1. **Quick (no contract change):** track principal off-chain by summing `Deposited` events from each pool, multiplying by `yieldBps/10000` = 0.30. `realized = totalYieldHarvested`. `unrealized = adapter.totalAssets − off_chain_principal − realized`. Store last value in Lovable's state.
2. **Clean (needs v15.4 minor patch):** add `function principal() external view returns (uint256)` to each adapter. Already present internally — just expose it. I can ship that in a follow-up session.

---

#### 2B. Per-position yield breakdown

For any NFT the connected user owns, show the yield earned on **that specific** position (not the pool-aggregate). This is what a FLEX holder checks before calling `claimYield`.

```ts
// estimatePositionValue does the heavy lifting on-chain
const [basketVal, yieldVal, total] = await readContract({
  contract: vault,
  method: "estimatePositionValue",
  params: [posId],
});

// Derive the "available yield to claim" — basically what claimYield would
// pay out right now, minus any already-claimed.
const pos = await readContract({ contract: vault, method: "positions", params: [posId] });
const availableYield = yieldVal > pos.yieldClaimed ? yieldVal - pos.yieldClaimed : 0n;

// PnL vs deposit (includes both basket appreciation AND yield)
const pnl = total - pos.depositAmount;
const pnlBps = (pnl * 10_000n) / pos.depositAmount;
```

**Card layout:**

```
┌─ Position #2 · Pool A · FLEX ──────────────────────────────┐
│  Deposited:         $5.00                                  │
│  Current value:     $5.00                                  │
│  ├─ Basket leg:     $3.50   (idle USDC, awaiting keeper)   │
│  └─ Yield leg:      $1.50                                  │
│  PnL:               $0.00  (+0.00%)                        │
│  Available to claim: $0.0000                                │
│  [ Claim Yield ]  [ Compound ]  (FLEX only, disabled $0)   │
└────────────────────────────────────────────────────────────┘
```

Show the basket leg breakdown: when keeper has already rebalanced, the basket leg is held as real tokens (WETH/WBTC/etc). When it's post-deposit pre-keeper, it's all USDC. Use `vault.getBasketDrift()` to distinguish.

---

#### 2C. **Trade opportunities** — drift-triggered rebalance preview (NEW)

This is the "3%+ trade opportunity" view. Every basket token whose current weight drifts more than `KEEPER.driftRebalanceBps` (= 300 bps = 3%) away from target is a live rebalance candidate — the next keeper tick will execute a 0x swap to bring it back in line. Surface this so users can see why the pool is about to trade.

```ts
import { KEEPER } from "@/abi/v15";

// Single call returns everything:
const [tokens, currentBps, targetBps, driftBps] =
  await readContract({ contract: vault, method: "getBasketDrift" });

const opportunities = tokens.map((token, i) => ({
  token,
  symbol: lookupSymbolFromTokens(token),
  currentBps: Number(currentBps[i]),
  targetBps:  Number(targetBps[i]),
  driftBps:   Number(driftBps[i]),    // SIGNED — negative = underweight, positive = overweight
  isActionable: Math.abs(Number(driftBps[i])) >= KEEPER.driftRebalanceBps,
})).sort((a, b) => Math.abs(b.driftBps) - Math.abs(a.driftBps));

// The next keeper tick will pair the MOST overweight with the MOST underweight
// and swap min(abs(drift_over), abs(drift_under)) × basketValue / 10_000
// bounded by KEEPER.maxRebalanceSizeBps (20%).
const basketValue = await readContract({ contract: vault, method: "totalBasketValue" });
const maxPairSizeUsdc = (basketValue * BigInt(KEEPER.maxRebalanceSizeBps)) / 10_000n;
```

**Card layout:**

```
┌─ Pool A · Next rebalance preview ──────────────────────────┐
│  🔥 3 trade opportunities (drift ≥ 3%)                      │
│                                                             │
│  USDC   overweight by 8000 bps (target 2000 / current 10000)│
│    → will SELL ~$2.80 → WETH (−4500 bps drift)             │
│                                                             │
│  WETH   underweight by 4500 bps                             │
│    → will BUY ~$2.80 from USDC                             │
│                                                             │
│  WBTC   underweight by 3500 bps                             │
│    → will BUY ~$2.17 from USDC                             │
│                                                             │
│  Max per tick:  $X.XX  (20% of basket)                     │
│  Next keeper:   15:00 UTC  (countdown 48m 12s)             │
└─────────────────────────────────────────────────────────────┘
```

**Drift coloring:**
- |drift| < 100 bps → green "balanced"
- 100 ≤ |drift| < 300 bps → yellow "drifting, not actionable yet"
- |drift| ≥ 300 bps → red "actionable next tick" + pulse animation
- |drift| ≥ 1000 bps → red bold "severely unbalanced"

**Countdown to next keeper tick:**

The keeper runs on cron `0 */3 * * *` UTC (every 3 hours at :00). Compute:
```ts
const now = new Date();
const nextTick = new Date(now);
nextTick.setUTCMinutes(0, 0, 0);
nextTick.setUTCHours(Math.ceil(now.getUTCHours() / 3) * 3);
if (nextTick <= now) nextTick.setUTCHours(nextTick.getUTCHours() + 3);
const msUntil = nextTick.getTime() - now.getTime();
// render as "Xh YYm ZZs"
```

---

#### 2D. Chainlink + Pyth feed health (keep existing)

```ts
for (let i = 0; i < basketLength; i++) {
  const cfg = await vault.basketTokens(i);
  //  cfg = { token, targetWeightBps, priceFeed, feedDecimals, tokenDecimals, maxStalenessSecs }

  if (cfg.priceFeed !== "0x0000000000000000000000000000000000000000") {
    const feed = getContract({ address: cfg.priceFeed, abi: CHAINLINK_FEED_ABI });
    const [roundId, answer, startedAt, updatedAt] = await feed.latestRoundData();
    const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
    const effectiveStaleness = Number(cfg.maxStalenessSecs) || 3600;
    const status = age < effectiveStaleness ? "FRESH" : "STALE — WOULD REVERT";
    //  render: symbol | price | updatedAt | age | staleness window | status
  }
}
```

Pyth-wrapped feeds (PEPE/USD, XAU/USD) use the same CHAINLINK_FEED_ABI because PythFeed.sol exposes the AggregatorV3 interface — no separate Pyth call needed.

---

#### 2E. Sequencer uptime (keep existing)

```ts
const seq = getContract({ address: ARBITRUM_SEQUENCER_UPTIME_FEED, abi: CHAINLINK_FEED_ABI });
const [, answer, startedAt] = await seq.latestRoundData();
// answer == 0 → UP, answer != 0 → DOWN
// if block.timestamp - startedAt < 3600 → GRACE PERIOD (post-restart, vault will revert with SequencerGracePeriod)
```

If sequencer is DOWN or in grace period, show a **full-width red banner at the top of the Oracle page AND the Vault page**: "Arbitrum sequencer is down — deposits/rebalances paused". The vault's `_checkSequencer()` gate is on every keeper call, so this matches on-chain reality.

---

**Oracle page layout summary:**
- Top banner: sequencer status
- Section 1: three yield-adapter cards (Pool A/B/C)
- Section 2: user's position cards (only if wallet connected and holding NFTs)
- Section 3: three Trade Opportunities cards (Pool A/B/C drift + rebalance preview)
- Section 4: Chainlink + Pyth feed table per pool
- Footer: `Last keeper run: <tx hash> at <timestamp>` — read latest Deposited/Harvested/KeeperSwapExecuted event from each pool vault

---

### 3. Admin page — **PARTIALLY READY** (missing whitelist, DAO)

What V15 contracts expose right now:

**✅ Available now** (all gated by `DEFAULT_ADMIN_ROLE` on the deployer EOA):
```ts
vault.setPositionNFT(addr)
vault.setBonusAccumulator(addr)
vault.setTreasury(addr)
vault.setSDMToken(addr)
vault.setSDMDiscount(bps)
vault.setSDMThreshold(amount)
vault.setAllocation(basketBps, yieldBps)           // change basket/yield split
vault.setFees(earlyBps, onTimeBps, yieldFeeBps)    // change fee %
vault.setWithdrawTimeout(seconds)
vault.setRebalanceSlippage(bps)
vault.setMaxRebalanceSize(bps)
vault.setTrustedSwapTarget(addr, bool)             // add/remove 0x/1inch/Paraswap
vault.addBasketToken(token, weightBps, feed, feedDec, tokDec, stalenessSecs)
vault.updateBasketWeight(index, newBps)
vault.setTokenStaleness(index, newSecs)            // v15.1
vault.pause() / vault.unpause()                    // PAUSER_ROLE
vault.rescueToken(token, to, amount)
// Roles — standard OZ AccessControl
vault.grantRole(KEEPER_ROLE, addr)
vault.revokeRole(KEEPER_ROLE, addr)
vault.renounceRole(DEFAULT_ADMIN_ROLE, signer)     // DANGER: permanent
adapter.syncAccounting(newPrincipal)               // recover from state drift
adapter.addVault(addr) / adapter.removeVault(addr)
```

**❌ NOT available — must ship v15.3 first:**
- `whitelist(addr) → bool` reads
- `setWhitelist(addr, bool)` / `setWhitelistBatch([addrs], [bools])`
- `whitelistEnabled` toggle
- **Render these controls as disabled/"coming in v15.3"** until I port the V11 whitelist code into V15 and redeploy or wrap.

**❌ NOT available — must ship v15.4 first:**
- Any governance/DAO controls

**Admin page layout:**
- **Who can sign?** Show current `DEFAULT_ADMIN_ROLE` holder (deployer EOA for now, Gnosis Safe post-test transfer)
- **Per-pool section** with all the setters above as form inputs
- **Role management** — grant/revoke KEEPER_ROLE, PAUSER_ROLE with a typed address input
- **Emergency** — big red PAUSE button for each pool
- **Whitelist management** — **grayed out with "Ship v15.3 first"** tooltip. Render the UI though — admin can pre-populate the whitelist CSV.
- **Treasury rescue** — rescueToken form (token address + amount, routes to treasury)

---

### 4. DAO page — **DOES NOT EXIST YET** — requires v15.4

You remembered correctly that a Governor + vSDM was **designed**, but it lives in `~/ShadowVaultV2/contracts/ShadowGovernor.sol` and **was never deployed to any chain**. The source is ~80 lines using OZ Governor + TimelockControl with:
- 9% quorum
- 3-day voting period
- 1-day timelock
- Voting token: `vSDM` (1:1 wrapped SDM with voting power)
- Controls: `setFees`, `setAllocation`, `setRevenueSplit`, pause, whitelist

What you remembered about "test a token then propose to add it" was a design intention — **it was never built** in any repo. I searched everywhere.

**Path to make the DAO page real:**
1. Port `ShadowGovernor` + `VotingSDM` from V2 to V15 (1-2 hours of work)
2. Add `GOVERNOR_ROLE` to each vault so governance can call `addBasketToken`, `setFees`, etc.
3. Deploy the Governor + Timelock + vSDM on Arbitrum
4. Governor becomes a holder of `DEFAULT_ADMIN_ROLE` (or a new `GOVERNOR_ROLE`) on each vault
5. Write a `proposeNewBasketToken(token, weight, feed, stalenessSecs)` helper

**DAO page layout (post v15.4):**
- **Proposals list** — active / succeeded / queued / executed
- **Create proposal** — typed form: Change fees, Add basket token, Update allocation, Set staleness, Pause/unpause
- **vSDM wrap / unwrap** — `SDM → vSDM` and `vSDM → SDM` buttons
- **Delegate votes** — `vSDM.delegate(to)` input
- **Proposal card** — title, description, voting window, quorum progress, for/against/abstain bar, "VOTE FOR / AGAINST / ABSTAIN" buttons

**Render the DAO page as a beautiful "Coming Soon" wireframe now** so Lovable can lay it out while I ship v15.4 in a follow-up session. When the contracts go live, just swap in real reads.

---

## Build order for Lovable

1. **Vault page** — build this first, it exercises 80% of the contract surface
2. **Oracle page** — static dashboard, high value, no writes, ships instantly
3. **Admin page** — skeleton with whitelist greyed out, add real whitelist after v15.3
4. **DAO page** — wireframe now, wire up after v15.4

## What to hand to Lovable

Paste this into your Lovable project's chat:

```
I'm building a multi-pool Arbitrum DeFi vault frontend for
ShadowVaultV15 (v15.3.1). Contract bundle (ABIs + addresses + tier
config + KEEPER thresholds) is in /src/abi/v15.ts. Network: Arbitrum
One (42161) only. TX library: thirdweb v5.

I need 4 pages (in order):

  1. /vault  — user deposit/withdraw/claim/compound with animated NFT
  2. /oracle — FIVE sections in one live dashboard:
       A. Yield adapter health per pool: adapter.totalAssets, realized
          yield (vault.totalYieldHarvested), live APR from the actual
          underlying protocol (Aave getReserveData, Fluid ERC-4626,
          Silo market), next-harvest countdown.
       B. Per-position yield breakdown using estimatePositionValue —
          show basket vs yield legs, PnL vs deposit, available claim.
       C. TRADE OPPORTUNITIES card per pool — list every basket token
          whose |driftBps| >= KEEPER.driftRebalanceBps (300 = 3%),
          visualize which will be swapped next keeper tick and by how
          much (bounded by KEEPER.maxRebalanceSizeBps = 2000 = 20%).
          Green/yellow/red coloring. Countdown to next cron :00 UTC.
       D. Chainlink/Pyth feed freshness table per basket token.
       E. Arbitrum sequencer uptime banner.
  3. /admin  — protected setters (whitelist "Coming Soon")
  4. /dao    — "Coming Soon" wireframe for proposals + vSDM

All five oracle sections should auto-refresh every 10s via thirdweb
useReadContract. Import KEEPER, CHAINLINK_FEED_ABI, AAVE_POOL_ABI,
ERC4626_ABI, YIELD_ADAPTER_ABI, AAVE_V3_POOL_ARBITRUM from v15.ts.

See ~/ShadowVaultV15/LOVABLE.md section "2. Oracle page" for the full
spec including code snippets for every read and the card layouts.

Design: dark theme #0f0f14, tier colors green/blue/purple/gold/red,
NFT preview as hero element on each position card. Monospace for
numbers, pulsing red outline on "actionable now" drift cards.
```

---

## What still needs to ship (tracked in project memory)

| Version | Work | Blocker |
|---|---|---|
| Adapter `principal()` getters | Expose internal principal on Aave/Fluid/Silo adapters so Oracle page can show realized + unrealized yield cleanly | Minor contract patch + redeploy each adapter |
| v15.3 whitelist | Port from V11 | Waiting on go-ahead |
| v15.4 governance | Port ShadowGovernor + vSDM from V2 repo | Waiting on go-ahead |
| Admin transfer to Gnosis Safe | Role handover | **Must explicitly approve after all mainnet tests pass** |
| Rescue $3 stuck in old Pool B_v1 Silo | Admin VAULT_ROLE grant + withdraw | Silo wstUSR/USDC utilization still high — wait for it to drop |
