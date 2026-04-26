# Keeper Operations — SweepV2 + CCIP value-push

*Last updated 2026-04-20.*

## What's running

Three processes under PM2, all `autorestart:false + cron_restart` so each fire is a fresh process:

| PM2 name | Cron | Script | Purpose |
|---|---|---|---|
| `sweep-v2-arb` | `*/30 * * * *` | `keeper/sweep-v2.js` | Call `SweepControllerV2.rebalance()` on Arb |
| `sweep-v2-poly` | `*/30 * * * *` | `keeper/sweep-v2.js` | Call `SweepControllerV2.rebalance()` on Polygon |
| `ccip-value-push` | `5 * * * *` | `keeper/ccip-value-push.js` | Push fresh position values from Polygon → Arb wrapper via CCIP |
| `lz-value-push` | `10 * * * *` | `keeper/lz-value-push.js` | Push fresh position values from HyperEVM → Arb wrapper via LayerZero v2 |

## Keeper wallet

All three use the same signer, derived from `KEEPER_KEY` in the project `.env`:

- Address: `0xCD20FE6E10838d8AEc242E0438A65c3d704D3E3d`
- Roles granted:
  - `KEEPER_ROLE` on `SweepControllerV2` Arb (`0xEc181596…0B11`)
  - `KEEPER_ROLE` on `SweepControllerV2` Polygon (`0x41F03396…8D62`)
  - `KEEPER_ROLE` on `PolygonNFTLocker` (`0xd67ACb57…65aD`)
  - `KEEPER_ROLE` on `HyperPositionLocker` (`0xFC8f588b…7381`) — granted at deploy

## Funding requirements (operator action)

### Gas

- **Arb ETH**: ≥ 0.01 ETH for gas over a week of `rebalance()` calls. Rebalance is cheap (~100-200k gas) but the process runs 48×/day.
- **Polygon POL**: ≥ 1 POL. Rebalance + CCIP call combined runs ~300-500k gas. POL is ~$0.08 so very cheap.

### LINK for CCIP

The `ccip-value-push` keeper pays CCIP fees in **LINK on Polygon**:

- Token: `0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39` (symbol LINK, 18 dec)
- Destination: keeper wallet `0xCD20FE6E…3E3d`
- Recommended: **≥ 5 LINK** to start (a single CCIP push costs ~0.1-0.5 LINK on Polygon→Arb; 5 LINK = 10-50 pushes buffer)

**Polygon scale-up later:** as more Polygon positions lock into the bridge, keeper needs more LINK. Monitor `ccip-value-push` warnings (`keeper LINK balance below threshold — fees may revert`) and top up before balance hits `MIN_LINK_WEI` (default 1 LINK).

### LINK for user burn-redeem

Users calling `ArbPositionWrapper.burnAndRedeem()` pay the back-bridge fee:

- Token: `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` (Arb LINK)
- Paid from `msg.sender` on each call; user needs enough to cover the CCIP fee at call time.
- UI should surface the required LINK allowance + show a top-up path (e.g. 1inch / Uniswap ARB→LINK link).

### HYPE for LZ bridge keeper + user lock

`lz-value-push` + user `lockAndBridge` both pay LayerZero v2 fees in native HYPE (not LINK):

- Keeper wallet `0xCD20FE6E…3E3d` needs **≥ 0.1 HYPE** on HyperEVM. One `pushValueUpdate` costs ~0.01-0.03 HYPE depending on DVN fee.
- Users locking a HyperEVM position pay from their own HYPE balance via `msg.value` — the UI should quote via `locker.quoteLock(nft, tokenId, options)` and request msg.value = fee × 1.2 to absorb small slippage in quote-vs-actual.
- `burnAndRedeem` on Arb pays in native ETH (not LINK) for the LZ leg — cleaner than the CCIP wrapper which uses LINK.

## Monitoring

### Logs

```bash
pm2 logs sweep-v2-arb --lines 50
pm2 logs sweep-v2-poly --lines 50
pm2 logs ccip-value-push --lines 50
```

Log format is JSON per line with `ts`, `level`, `step`, `msg` fields. Parse with `jq` for production dashboards.

### Status

```bash
pm2 list | grep -E 'sweep-v2|ccip-value'
pm2 describe sweep-v2-arb
```

A process showing `status=stopped` with `uptime=0` and a non-zero `cron restart` is healthy — it's waiting for the next cron tick.

### Expected-output sanity

When there's nothing to do, the sweep keepers log `skip — controller has 0 total assets` and exit. This is normal while the lending pool is unfunded. Once USDC flows into the pool + sweep, rebalances start moving funds.

## Common failure modes

### `signer lacks KEEPER_ROLE`

Keeper wallet doesn't have the role. Run `scripts/grant-keeper-roles.cjs` on the affected chain:

```bash
npx hardhat run --network arbitrum scripts/grant-keeper-roles.cjs
npx hardhat run --network polygon  scripts/grant-keeper-roles.cjs
```

### `keeper LINK balance below threshold`

Operator needs to send LINK to the keeper wallet (see Funding Requirements above).

### `could not decode result data`

Usually an RPC or config issue — the keeper is calling a function on a contract that doesn't exist there. Check:
- `ARB_RPC` / `POLYGON_RPC` point at the right chain
- The sweep/locker addresses in `config/deployed-*.json` are correct
- The contract hasn't been replaced since the config was last written

### CCIP message stuck

If a `pushValueUpdate` fires but the Arb-side `ValueUpdated` event never arrives:
- Confirm the CCIP message landed: check [CCIP Explorer](https://ccip.chain.link) with the `ccipMessageId` from the keeper log
- If "waiting" > 1 hour, CCIP had a backlog or OCR committee delay — not a keeper bug
- If "failed", the Arb-side wrapper's `ccipReceive` reverted — inspect the revert reason on CCIP Explorer, check wrapper's `polygonLocker` state matches the sender

## Commands reference

```bash
# Start all 3 keepers (first time or after reboot)
pm2 start ecosystem.sweep-v2.config.cjs && pm2 save

# Stop everything cleanly
pm2 stop sweep-v2-arb sweep-v2-poly ccip-value-push

# Force a rebalance NOW without waiting for cron
pm2 restart sweep-v2-arb --update-env

# Tail live logs in 3 splits
tmux new-session -d 'pm2 logs sweep-v2-arb' \; split-window 'pm2 logs sweep-v2-poly' \; split-window 'pm2 logs ccip-value-push' \; attach

# Dry-run any keeper without committing a tx
CHAIN_ID=42161 DRY_RUN=1 node keeper/sweep-v2.js
CHAIN_ID=137   DRY_RUN=1 node keeper/sweep-v2.js
DRY_RUN=1      LOOKBACK=10000 node keeper/ccip-value-push.js
```

## Rotation to Safe (pending)

All three keepers use a dedicated keeper EOA, not the deployer. When admin rotates to per-chain Safes post-bake:
- Admin roles (`DEFAULT_ADMIN_ROLE` on every contract) move to Safe
- `KEEPER_ROLE` stays on the keeper EOA (keepers are automated, need instant execution, not multisig)
- `CONFIG_ROLE` on `NFTValuer` moves to Safe too
- `LIQUIDATOR_ROLE` on `EcosystemMarketplace` stays on `LendingPool v1.4` (it's the one calling `liquidationList`)

Once the Safe rotation happens, update this doc with the new admin addresses.
