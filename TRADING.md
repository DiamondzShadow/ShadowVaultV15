# Pool F Basket Trading — operational guide

## The actors

| Role | Address | Holds | Signs |
|---|---|---|---|
| **Deployer** (admin) | `0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3` | gas + small USDC | admin txs (cap changes, role grants) |
| **Treasury Safe** | `0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E` | accrued fees | nothing autonomously |
| **Keeper** (nudger) | `0x506cB442df1B58ae4F654753BEf9E531088ca0eB` | small HYPE | adapter state-machine nudges (`confirmDeposit`, `sweepFromCore`, `sweepToTrader`), oracle `pushNav` |
| **Trader** (basket EOA) | `0x3c1E4659206428cbE082C0207732227f1635E64D` | USDC + basket tokens (HYPE, BTC, ETH) on HC | HC spot orders, EVM↔HC bridges |

**Why split keeper from trader:** if the keeper key leaks, the attacker can call adapter functions but cannot move basket funds. If the trader key leaks, the attacker can drain basket-held tokens but cannot touch the yield leg or call adapter admin. The `maxSweep` cap on `BasketAdapterHC` (default $10k) bounds blast-radius per leak.

## End-to-end basket flow

```
USER deposit
   │
   ▼
ShadowVaultHyperBasket.deposit(amount, tier)
   │
   ├─► YieldReceipt.mint(user, ...)       (YIELD leg accounting)
   ├─► BasketReceipt.mint(user, ...)      (BASKET leg accounting, snapshots NAV)
   ├─► HLPAdapterHC.deposit(40%)          (yield → HLP, Pool E pattern)
   └─► BasketAdapterHC.deposit(60%)       (USDC parked in adapter)
                            │
                            │ keeper polls idleUsdc, sees > MIN_SWEEP
                            ▼
              BasketAdapterHC.sweepToTrader(amount)
                            │
                            ▼  (USDC EVM transferred to trader EOA)
                       Trader EOA
                            │
                            ├─► CoreDepositWallet.deposit(amount, SPOT_DEX)
                            │   (USDC EVM → HC spot)
                            │
                            └─► HL spot LIMIT_ORDER per basket weight
                                40% HYPE/USDC, 30% BTC/USDC, 20% ETH/USDC
                                (signed via @nktkas/hyperliquid SDK)

NAV LOOP (every 10 min via pm2 cron `nav-from-hc`)
   │
   ├─► info.spotMetaAndAssetCtxs() → mark prices for all coins
   ├─► info.spotClearinghouseState({user: trader}) → trader holdings
   ├─► nav = Σ (holdings[coin] × prices[coin])
   └─► oracle.pushNav(0, navUsd6)  (drift cap enforced server-side)


USER withdraw (pair)
   │
   ▼
ShadowVaultHyperBasket.withdrawPair(yieldId, basketId, to)
   │
   ├─► BasketAdapterHC.withdraw(amount, to)
   │       │
   │       ├─ if idle USDC ≥ ask → send immediately
   │       └─ else → emit BasketWithdrawPending(amount)
   │              │
   │              │ keeper sees event
   │              ▼
   │       Trader EOA sells basket on HC for USDC
   │              │
   │              ├─► spot SELL order across HYPE/BTC/ETH
   │              ├─► spotSend / sendAsset USDC HC → BasketAdapterHC EVM
   │              ▼
   │       BasketAdapterHC.recordRecovery(amount)
   │       BasketAdapterHC.clearPendingWithdraw(amount)
   │       Vault retries withdraw, idle now covers
   │
   └─► YieldReceipt + BasketReceipt burned (or transferred back to vault)
```

## Trader funding (one-time + ongoing)

Send to `0x3c1E4659206428cbE082C0207732227f1635E64D` on HyperEVM:

| Asset | Amount | Why |
|---|---|---|
| HYPE | **0.05** (~$2.20) | Gas for one EVM→HC bridge tx + a few admin/spotSend txs over the year |
| USDC | comes from adapter | First sweep funds the basket. Ensure adapter has been seeded via Pool F deposits + `sweepToTrader` |

After first sweep, trader bridges its USDC to HC (one tx, costs 1 USDC HC activation fee) and starts trading. From that point the trader operates on HC API only — no further EVM gas needed except for occasional EVM→HC top-ups when the adapter accumulates more USDC from new deposits.

## Where the trading bot lives

**Not yet built** as of 2026-04-15. Sketch:

`keeper/basket-trader.js` — pm2 cron every ~5 min:
1. Read `basketAdapter.idleUsdc()`. If `> MIN_SWEEP_USD` (e.g. $50), call `sweepToTrader(amount)` from KEEPER_ROLE.
2. Read trader EVM USDC. If `> 5` USDC, bridge via `CoreDepositWallet.deposit(amount, SPOT_DEX)` (signed by trader key).
3. Read trader HC spot balances. Compare vs target weights (HYPE 40 / BTC 30 / ETH 20 / USDC 10).
4. For each underweight coin: place a buy LIMIT_ORDER on HL via `@nktkas/hyperliquid` `ExchangeClient.order()`.
5. Tolerance: don't rebalance if drift < 1% (avoid churn).

`keeper/basket-rebalance-on-withdraw.js` — pm2 event-driven (poll adapter for `BasketWithdrawPending`):
1. On pending withdraw of amount `X`:
2. Sell pro-rata across basket coins to raise `X` USDC on HC.
3. Bridge USDC HC→adapter (spotSend with destination = adapter address).
4. Call `recordRecovery(X)` and `clearPendingWithdraw(X)` from KEEPER_ROLE.

Both can share the same trader key signer (no auth complexity).

## Risk limits already enforced on-chain

- `BasketAdapterHC.maxSweep` = $10,000 default — single sweep can't exceed this
- `BasketAdapterHC.maxPerDeposit` = $500 / `maxDailyDeposit` = $2,000 — bounds in-flight
- `BasketAdapterHC.sweepsPaused` admin flag — emergency stop
- `BasketNavOracle.maxDriftBps` = 1000 (10%) — keeper can't lie about NAV by >10% per push
- `BasketNavOracle.maxStalenessSecs` = 900 (15 min) — UI/vault refuse stale NAV
- Pool F vault `whitelistEnabled = true` — only opted-in beta testers can deposit

## Smoke-test checklist before opening Pool F to the wild

1. ☐ Fund trader EOA with 0.05 HYPE + ensure ≥ 5 USDC will reach it via first sweep
2. ☐ Deposit $5 to Pool F as deployer (whitelisted). Confirm 2 NFTs minted in `/shadowpass`.
3. ☐ Adapter idleUsdc shows $3 (60% of $5). Keeper sweeps to trader.
4. ☐ Trader bridges $3 to HC. Verify HC spot USDC balance via `info.spotClearinghouseState`.
5. ☐ Trader places small test order (e.g. buy $1 HYPE). Confirm HC fill.
6. ☐ NAV keeper picks up new HYPE holding, NAV reflects mark price.
7. ☐ Pair-withdraw flow: trader sells HYPE back, bridges USDC, vault completes payout.
8. ☐ Open whitelist: `vault.setWhitelistEnabled(false)`.

## Operational addresses (copy/paste reference)

```
HyperEVM chain id     999
USDC (HyperEVM)       0xb88339CB7199b77E23DB6E890353E22632Ba630f
CoreDepositWallet     0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24
NAV oracle            0x61801bC99d1A8CBb80EBE2b4171c1C6dC1B684f8
Basket adapter (F)    0x39D10E5823E4472070413070E8a51bc75F0bd0D0
Pool F vault          0xe442CFF139B6339f7468240b4119E7b2B7841772
ShadowPass wrapper    0x397BaB25a41Aaa5cF76F19DE8794D5476B576CCC
Yield receipt         0x389b19dCdb3c43A5c71b1949a510791Db619090b
Basket receipt        0x1f967c06EF54eA0E4855a9B09d7940adCcEda083
Trader EOA            0x3c1E4659206428cbE082C0207732227f1635E64D
Keeper EOA            0x506cB442df1B58ae4F654753BEf9E531088ca0eB
Treasury Safe         0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E
```
