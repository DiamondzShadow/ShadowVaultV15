# ShadowVaultV15 Keeper

One-shot Node.js keeper that pokes each V15 vault every 3 hours via PM2's
`cron_restart`. Designed so every invocation is a fresh process — no long-
running state, no memory leaks, no hung connections.

## What it does per run

For every pool in `config/deployed.json`:

1. `harvestYield()` — Aave/Fluid/Silo interest → vault → 3% fee to treasury → reinvest rest
2. `getBasketDrift()` — read weights via vault view helper
3. If idle USDC ≥ $10, route **half** of it to the most-underweight basket token via 0x (`executeBuyBasket`)
4. If max overweight ≥ 3%, sell the overweight token for the underweight token via 0x (`executeRebalance`) — $500 per tick, repeated runs converge drift
5. Scan positions 1..nextPosId for `withdrawStatus == REQUESTED`; if no basket tokens are held, call `completeWithdraw` (otherwise the keeper needs to sell basket tokens first — full withdrawal flow is TODO)

Every step emits a structured JSON log line so log forwarders or `pm2 logs`
can consume it.

## Required env

| Var | Purpose |
|---|---|
| `ARB_RPC` | Arbitrum mainnet RPC URL |
| `KEEPER_KEY` | Keeper EOA private key (must hold `KEEPER_ROLE` on every vault) |
| `ZEROEX_API_KEY` | 0x API key (required by v2 authenticated endpoints) |
| `DEPLOYED_PATH` | Optional override, defaults to `../config/deployed.json` |
| `DRY_RUN` | Set to `"1"` to log intended actions without sending txs |

## Run once manually

```bash
ARB_RPC=... KEEPER_KEY=0x... ZEROEX_API_KEY=... node keeper/keeper.js
```

## PM2 mode (cron every 3h)

```bash
pm2 start ecosystem.keeper.config.cjs
pm2 save
pm2 logs v15-keeper
```

## Known limitations (work in progress)

- **Withdrawal swap flow**: if a position is pending and basket tokens are
  held, the keeper currently just logs; the actual multi-swap withdraw
  path needs to compute pro-rata basket shares per token and issue one
  `executeWithdrawalSwap` per token. Added in a follow-up.
- **Rebalance sizing**: a fixed $500 per tick. Production version should
  scale with drift magnitude and basket TVL.
- **Rebalance tokenIn conversion**: the current `executeRebalance` call
  passes `REBAL_USD` as `amountIn` which assumes `tokenIn` is USDC. For
  WETH→WBTC rebalance the keeper must first quote the USDC→tokenIn rate
  via Chainlink and convert. This is the next thing to fix.
- **No gas price governance**: the keeper uses the provider's default
  gas estimation. For Arbitrum this is usually fine; add EIP-1559 bounds
  if needed.
- **No pending-withdraw multi-swap**: the keeper logs pending positions
  but doesn't fully execute the basket-sell path yet.

## Safety guarantees from the vault side

The keeper cannot drain the vault even if its calldata is malicious:

- `executeRebalance` validates `swapTarget ∈ trustedSwapTargets`
- `bought < minOut` reverts with `SlippageExceeded`
- `spent > amountIn` reverts with `RebalanceTooBig`
- rebalance amount > 20% of basket value reverts with `RebalanceTooBig`
- Chainlink sequencer uptime checked on every swap
- all swaps are re-entrancy-guarded

So the worst a compromised keeper bot can do is waste gas and poke
Chainlink-bounded swaps within drift limits.
