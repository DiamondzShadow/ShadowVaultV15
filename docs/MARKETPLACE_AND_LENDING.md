# Diamondz Marketplace + Lending — Architecture Reference

*Last updated 2026-04-20. Covers ShadowVaultV15 marketplace + lending + valuation sidecar. Source of truth for auditors, backend devs, and keeper operators. UI-facing copy lives in the Lovable `/docs` route — this file is the dev/auditor counterpart.*

---

## 1. TL;DR

Three coupled subsystems, one registry:

| Contract | Role | Live address (Arb 42161) |
|---|---|---|
| `DiggerRegistry` | Project onboarding, bonds, per-collection LTV caps, fee splits | `0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99` |
| `RoyaltyRouter` | 3-way fee split router (protocol / supplier / digger) | `0x9ad3Dd99923F539DFAb5b0Dc99E87431FDE9A438` |
| `EcosystemMarketplace` | On-chain fixed-price listings, liquidation landing zone | `0x311D7A411876a44C423f4bf170D48944A5c42696` |
| `LendingPool` (v1.2) | USDC lending against position NFTs, 4626-virtual-share supply accounting | `0xA1C503676e9572b792BEE9687d635b4A474690C1` |
| `AaveV3Sink` | Idle-USDC yield layer (Aave V3 supply) | `0x6CC249345f6C6a85F2128d03c3818026c492F18D` |
| `HyperRemoteMirror` | Cross-chain supply attestation (HyperEVM leg) | `0x6d114293629153d60eD1C19012BE117Df2d72963` |
| `SweepController` | Orchestrates idle USDC → Aave + HyperEVM splits | `0xE2239A47a98976984aab7bf4E8fea1Db04E1BdC3` |
| `NFTValuer` (v1.3, not yet deployed) | Per-tokenId valuation + liquidation-strategy dispatcher | *pending deploy* |

The digger bond is a project's skin in the game. The registry is the source of truth for *which NFTs are listable, which are borrowable, at what LTV, and how fees split*. The marketplace and lending pool both read from it. The valuer sidecar (v1.3) decouples LendingPool from any single valuation model so the system can accept multiple collateral types.

---

## 2. Diggers: how projects onboard

A "digger" is a project onboarding slot. Opening a digger requires:

1. **A USDC bond** ≥ `minBondUSDC` (default 1000 USDC). The bond is the project's skin in the game.
2. **A fee split** — three bps numbers summing to 10_000: `protocolBps` (protocol cut), `supplierBps` (routed to lending pool once `setLendingPool` is called), `diggerBps` (project's cut).
3. **At least one NFT collection** registered via `registerCollection(diggerId, nft, oracle, maxLtvBps)`.

Once open, the digger owner can register more collections, top up the bond, update the fee split, soft-pause all their collections, transfer ownership, or queue an unstake (14-day cooldown) to withdraw the bond.

### Slashing

`SLASHER_ROLE` (admin/Safe) can slash a digger's bond at any time via `slash(diggerId, amount, to, reason)`. If the bond hits zero, `slashed = true` is set permanently and every collection under that digger stops working (both `isListable` and `isCollateral` return false).

The fail-safe slash reasons (locked in code review):
- Bad-debt incidents where the digger's NFTs caused supplier losses
- Oracle/metadata manipulation making collateral prices unreliable
- Listing griefing (spam listings, wash trades detected by analytics)
- Regulatory/KYC issues surfaced post-onboarding

### Pause vs slash

| | Pause (owner self-action) | Slash (protocol action) |
|---|---|---|
| Who triggers | Digger owner | Protocol SLASHER_ROLE |
| Existing listings | Stay live | Stay live (buyers can still complete) |
| Existing loans | Continue normally until repay/liq | Continue; liquidation path still fires |
| New listings | **Blocked** (`isListable = false`) | Blocked |
| New borrows | **Blocked** (`isCollateral = false`) | Blocked |
| Reversible | Yes, owner calls `setDiggerPaused(false)` | **No** — bond drained = permanent |

### The current live state (2026-04-20)

Digger #1 is Diamondz (deployer-owned during beta, Safe-owned post-bake). Bond temporarily set to 10 USDC (bumped to ≥1000 after next operator top-up). Fee split 10 / 70 / 20. Collections:

- Pool A NFT `0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a` — maxLTV 50%
- Pool B NFT `0x67940CD1D7000494433B1Be44Dde494994393174` — maxLTV 50%
- Pool C NFT `0x9C86B7C9f4195d3d5150A39983ca0536353109f6` — maxLTV 50%
- Pool D NFT `0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171` — maxLTV 50%

---

## 3. Marketplace flow

### Listing

`EcosystemMarketplace.list(nft, tokenId, priceUSDC, expiresAt)`:

1. Seller must own the NFT and have approved the marketplace (ERC721 `setApprovalForAll` or per-token `approve`).
2. `DiggerRegistry.isListable(nft)` must return true — slashed or paused collections are blocked.
3. NFT transfers into the marketplace escrow.
4. One active listing per tokenId (reverts with `AlreadyListed` otherwise).

### Buying

`EcosystemMarketplace.buy(listingId)`:

1. Buyer approves `priceUSDC` USDC to the marketplace.
2. `isListable` re-checked — if the digger has been paused/slashed since listing, the buy reverts (seller can `cancel` to recover).
3. Fee = `priceUSDC × protocolFeeBps / 10000` (default 2.5%, cap 10%).
4. Fee routes through `RoyaltyRouter.routeRevenue(nft, fee)` — the router splits it per the digger's fee split (protocol / supplier / digger).
5. `priceUSDC − fee` transfers to the seller. NFT transfers to the buyer.

### Cancel / updatePrice

Seller-only operations. Cancel returns the escrowed NFT to the seller; `setPrice(listingId, newPrice)` updates in-place.

### Liquidation listing (LendingPool hook)

`liquidationList(nft, tokenId, priceUSDC, expiresAt)` is gated by `LIQUIDATOR_ROLE`. The LendingPool will use this path in v1.4 to sell seized non-vault-backed NFTs (see §7). The NFT must already be in the marketplace's custody when the call fires — the flow is `pool → transfer NFT → marketplace.liquidationList`.

### Emergency return

`emergencyReturn(listingId)` (admin only) — unwinds an escrowed listing back to the seller. Used when a digger slashing mid-listing would otherwise strand the seller's NFT.

---

## 4. RoyaltyRouter: the fee waterfall

Every fee the marketplace collects flows through `RoyaltyRouter.routeRevenue(nft, amount)`:

1. Router reads `(diggerBps, supplierBps, protocolBps)` from `DiggerRegistry.feeSplit(nft)`.
2. Splits the amount three ways.
3. **Digger share** → `diggerOwnerOf(nft)`.
4. **Supplier share** → `lendingPool` address if `setLendingPool()` has been called, else `protocolTreasury` (this sink is hot-swappable without a marketplace redeploy).
5. **Protocol share** → `protocolTreasury`.

On interest paid to LendingPool (Phase 3.5 — not live), the same split will apply: the borrower's interest is decomposed by the same registry-defined fee split, giving the digger a revenue share in the lending product, not just the trading product.

---

## 5. LendingPool: how borrow / repay / liquidation work

### Supply side (ERC-4626 virtual shares)

- `supply(assets)` → `shares = assets × (totalShares + 10^6) / (totalAssets + 1)` (OZ virtual-offset rounding-floor).
- `totalAssets = idle USDC + totalBorrowed` — deliberately *excludes* accrued-but-unpaid interest so suppliers can't front-run share price growth.
- `withdraw(shares)` gated by `minSupplyHold` (6h default) from last `supply`.
- If pool is short on idle USDC, `withdraw` auto-pulls from `SweepController.pull(amount)` (Aave first, HyperEVM queued async).
- Virtual offset = `10^6`. A donation attack requires 10^6× the victim's deposit to meaningfully distort share price (tested with 1 USDC vs 1000 USDC, second supplier still receives ≥99% of their deposit value).

### Borrow side

`borrow(nft, tokenId, amount)`:

1. `DiggerRegistry.isCollateral(nft)` must return true.
2. No active loan on this (nft, tokenId).
3. Caller owns the NFT.
4. **(v1.3+)** If a valuer is set: `valuer.strategy(nft) == VAULT_UNWIND`. MARKETPLACE_AUCTION collateral is rejected until v1.4.
5. `value = valueOf(nft, tokenId)` — dispatches to valuer (v1.3) or `nft.vault().estimatePositionValue(tokenId).total` (legacy / fallback).
6. `ltvBps = borrowAmount × BPS / value` must be ≤ `maxLtvFor(nft)` (per-collection cap from registry, floor-capped at 75% `ABSOLUTE_MAX_LTV_BPS`).
7. Liquidity check — auto-pulls from Sweep if short.
8. NFT escrows, USDC pays out, loan record created, `lastBorrowBlock[borrower] = block.number`.

### Interest model

- Default APR: 8% (`DEFAULT_BORROW_APR_BPS = 800`). Per-collection overrides via `setBorrowAprOverride(nft, bps)`.
- Simple linear accrual: `newInterest = principal × apr × elapsed / (BPS × SECONDS_PER_YEAR)`.
- `_accrueInterest` called on every state-changing loan operation.
- On interest payment, `protocolReserveBps` (default 30%) goes to the reserve fund, the rest to suppliers via share-price growth.
- **Reserve fund is the first bad-debt absorber** — suppliers don't take losses until reserve hits zero.

### Repay

`repay(loanId, amount)`:

1. Accrue interest.
2. Apply to outstanding interest first, then principal.
3. If fully repaid, NFT returns to borrower; slot in `activeLoanOf[nft][tokenId]` frees.
4. Same-block borrow↔repay rejected (`lastBorrowBlock` check, proven by `SameBlockAttacker` test).

### Yield-repay (v1.1)

Borrower sets `yieldRepayBps(loanId, bps)` (0–10000). Then `harvestAndApply(loanId)`:

1. Calls `vault.claimYield(tokenId)` on the NFT's issuing vault (FLEX-tier only — other tiers return 0).
2. The vault sends the harvest to the current position owner — **which is the pool, because the NFT is escrowed**.
3. Pool splits: `toLoan = harvest × yieldRepayBps / BPS`, rest to borrower.
4. `toLoan` applied per standard repay accounting.

This is the "yield slider" UX in the Lovable UI. 50% = 50/50 between loan and wallet. 100% = all to loan (fastest payoff). Keeper-callable so borrowers don't need to manually run it.

### Liquidation (two-step)

Vault-backed NFTs (V15 Pools) liquidate via vault unwind, not marketplace auction. This is the key design intent captured in the v1.0 memo: *"Position NFTs are not pawn-shop assets — they're on-chain claims to USDC + yield."*

**Step 1: `triggerLiquidation(loanId)`** — public (anyone, incentive is the later completion bonus).

1. Loan must be ≥ `minLoanDuration` old (default 1h — borrower react window).
2. `health = debt × BPS / valueOf(...)`. Must exceed `liquidationThresholdFor(nft)` = `maxLtvBps + liquidationBufferBps` (default 10% buffer).
3. Loan status flips to `LIQUIDATING`.
4. Pool calls `vault.requestWithdraw(tokenId)` — vault enters its own withdraw cooldown (~30 min on V15 vaults).
5. Unwind target resolves via `_unwindTarget(nft)` → `valuer.vaultFor(nft)` (v1.3) or `nft.vault()` (legacy).

**Step 2: `completeLiquidation(loanId)`** — public, after vault cooldown.

1. Accrue interest one more time.
2. Call `vault.completeWithdraw(tokenId)` — vault transfers USDC payout to the pool.
3. Split payout:
   - Loan debt repaid first (`protocolReserveBps` of the interest goes to reserve).
   - `liquidationBonusBps` (5% default) of surplus → caller as liquidation incentive.
   - Remaining surplus → borrower.
4. If payout < debt (bad debt path): reserve absorbs first, suppliers lose value second, digger bond is slashed last (Phase 3.5).

### Same-tx attack defense

`lastBorrowBlock[borrower]` is checked on repay/harvest/trigger. Attacker contract pattern (borrow-then-repay-in-same-tx to manipulate share price) fails with `SameBlockBorrowRepay`. Proven by `contracts/mocks/SameBlockAttacker.sol` in the test suite.

---

## 6. NFTValuer (v1.3 — built, not yet deployed)

### Why it exists

LendingPool v1.2 hard-codes the valuation path: `IPositionNFTVault(nft).vault().estimatePositionValue(tokenId)`. This silently assumes every registered collection has a `vault()` getter. It works for V15 Pool NFTs, but:

1. **An outside NFT with no `vault()` reverts at borrow time** with no clear error — bad UX, also a footgun if a digger registers a non-vault NFT with `maxLtvBps > 0` by mistake.
2. **There's no way to surface a clamp / floor-oracle / static price** for collections that want to be borrowable but don't have a vault (e.g. pinned community NFTs, floor-oracle-backed collections).
3. **Liquidation strategy is also hard-coded** to vault-unwind — can't route an outside NFT to marketplace-auction liquidation.

`NFTValuer` is a **sidecar contract** that gives us all three axes without touching the already-deployed (and non-upgradeable) `DiggerRegistry`.

### Modes

```solidity
enum Mode { NONE, VAULT_POSITION, FLOOR_ORACLE, STATIC_USDC }
enum Strategy { VAULT_UNWIND, MARKETPLACE_AUCTION }
```

| Mode | `liveValue(nft, tokenId)` | `strategy(nft)` | For |
|---|---|---|---|
| `NONE` | returns 0 | reverts | Unconfigured (lending refuses) |
| `VAULT_POSITION` | `IVaultValue(source).estimatePositionValue(tokenId).total` | `VAULT_UNWIND` | V15 Pool NFTs (live per-tokenId value) |
| `FLOOR_ORACLE` | `IFloorOracle(source).floorUSDC(nft)` | `MARKETPLACE_AUCTION` | Outside collections with a floor feed |
| `STATIC_USDC` | configured `staticValueUSDC` | `MARKETPLACE_AUCTION` | Pinned / test collections |

### Max-value clamp

Every mode supports an optional upper bound. Stored as `staticValueUSDC` (0 = no clamp for dynamic modes; required positive for STATIC mode):

```solidity
if (c.staticValueUSDC != 0 && usdc > c.staticValueUSDC) usdc = c.staticValueUSDC;
```

This is a defense against a compromised or buggy vault returning an inflated value, causing a borrower to extract more than the NFT is really worth. Set it to ~1.5× the expected max per-tokenId value for a Pool NFT.

### Config surface (CONFIG_ROLE)

```solidity
setVaultMode(address nft, address vault, uint256 maxClamp);
setFloorMode(address nft, address oracle, uint256 maxClamp);
setStaticMode(address nft, uint256 valueUSDC);
clear(address nft);
```

All require the collection to already be registered in `DiggerRegistry` (revert `NotRegisteredInDiggerRegistry` otherwise). Admin = Safe in production.

### LendingPool wiring (v1.3 changes)

Three new branches, all guarded by `address(valuer) != address(0)`:

1. `valueOf(nft, tokenId)` — delegates to `valuer.liveValue(...)` when set. (Function kept named `valueOf` for API compat; valuer's version is `liveValue` to avoid colliding with `Object.prototype.valueOf` in JS clients.)
2. `borrow()` — pre-gate: `valuer.strategy(nft) == VAULT_UNWIND` or reverts `UnsupportedLiquidationStrategy`. Rejects floor/static collateral until v1.4 adds the marketplace-auction path.
3. `_unwindTarget(nft)` — returns `valuer.vaultFor(nft)` when set, else `nft.vault()`. Used by `triggerLiquidation`, `completeLiquidation`, and `harvestAndApply`.

`setValuer(address)` is admin-only, `address(0)` rolls back to the legacy path. This lets us A/B the valuer in production — deploy it, flip the pointer, and flip it back if anything misbehaves, without redeploying the pool.

### Why not edit DiggerRegistry instead?

`DiggerRegistry` is deployed at `0x3f93B052…af99` as a **non-upgradeable** contract. Changing its storage layout requires a new registry + a migration of the bond and collections — breaking the marketplace + lending contracts that reference it by immutable address. Sidecar valuer leaves all existing state in place and requires only a setter flip on the (redeployable) LendingPool.

---

## 7. Roadmap — what v1.4 adds

The valuer exposes `MARKETPLACE_AUCTION` strategy but LendingPool doesn't act on it yet. v1.4 closes the loop:

1. **Borrow path** — drops the `UnsupportedLiquidationStrategy` gate; floor/static-priced NFTs become borrowable.
2. **Trigger liquidation** — branches on strategy:
   - `VAULT_UNWIND`: same as today, call `vault.requestWithdraw`.
   - `MARKETPLACE_AUCTION`: transfer NFT to `EcosystemMarketplace` and call `liquidationList(nft, tokenId, startPrice, expiresAt)`. Start price = `valuer.liveValue × 0.9` (10% markdown to incentivize quick sale), expiry = 7 days.
3. **Complete liquidation** — becomes two flavors:
   - `VAULT_UNWIND`: same as today.
   - `MARKETPLACE_AUCTION`: `onMarketplaceSale(listingId, payout)` callback from the marketplace, fires when the listing sells. If unsold at expiry, admin can `rescheduleLiquidation` at a lower price.

Backward-compat: existing Pool NFT loans are unaffected because they all have `strategy == VAULT_UNWIND`.

---

## 8. Admin surface cheat sheet

### DiggerRegistry (Safe = DEFAULT_ADMIN_ROLE)
- `setMinBond(uint256)` — bump onboarding floor
- `setUnstakeDelay(uint256)` — capped at 90 days
- `setProtocolTreasury(address)` — fee sink
- `removeCollection(address)` — emergency delist (overrides digger)
- `slash(uint256, uint256, address, string)` — punitive bond pull

### RoyaltyRouter (Safe)
- `setLendingPool(address)` — the supplier-cut sink; flip this on Phase 3.5 deploy day

### EcosystemMarketplace (Safe)
- `setProtocolFee(uint16)` — capped 1000 bps (10%)
- `setPaused(bool)` — kill switch
- `emergencyReturn(uint256)` — unwind a stuck listing

### LendingPool (Safe)
- `setSweepSink(address)` — idle-USDC sink pointer
- `setValuer(address)` — **v1.3+: flip valuer on/off**
- `setBorrowAprOverride(address, uint256)` — per-collection APR
- `setProtocolReserveBps(uint16)` — fraction of interest → reserve
- `setLiquidationBufferBps(uint16)` / `setLiquidationBonusBps(uint16)`
- `setMinLoanDuration(uint256)` / `setMinSupplyHold(uint256)`
- `withdrawProtocolReserve(address, uint256)` — drain reserve to Safe
- `pause()` / `unpause()` (PAUSER_ROLE) — emergency stop

### NFTValuer (Safe = CONFIG_ROLE)
- `setVaultMode(nft, vault, maxClamp)`
- `setFloorMode(nft, oracle, maxClamp)`
- `setStaticMode(nft, value)`
- `clear(nft)`

---

## 9. Invariants (what MUST hold)

Property-tested or proven by equivalence in 201 passing tests:

1. **Supplier share price never decreases on an inbound supply.** Virtual offset defeats first-depositor grift.
2. **`totalAssets ≥ totalBorrowed`** always. Underflow = bug.
3. **Every escrowed NFT has exactly one active loan.** `activeLoanOf[nft][tokenId]` can't hold a stale/closed loanId.
4. **A slashed digger's collections are rejected by both `isListable` and `isCollateral`.** No new listings or borrows can land against a failed project.
5. **Fee splits always sum to 10_000 bps.** Enforced at registry config time.
6. **Borrow-time LTV ≤ collection maxLtvBps.** Further capped at `ABSOLUTE_MAX_LTV_BPS = 7500` (defense-in-depth on top of registry's 80% cap).
7. **Same-tx borrow↔repay is impossible.** `lastBorrowBlock` check.
8. **Liquidation requires both `age ≥ minLoanDuration` AND `health > threshold`.** Neither alone is sufficient.
9. **Bad debt is absorbed by reserve first, suppliers second, digger bond last.** Waterfall order is part of the design.
10. **(v1.3+)** If valuer is set, any collateral whose `strategy != VAULT_UNWIND` is refused at borrow time. Floor/static NFTs can be *valued* for UI but can't back a loan until v1.4.

---

## 10. Test coverage map

| Subsystem | Test file | Count |
|---|---|---|
| DiggerRegistry | `test/marketplace/digger-registry.test.js` | 28 |
| Marketplace flow | `test/marketplace/marketplace-flow.test.js` | 17 |
| LendingPool core | `test/lending/lending-pool.test.js` | 21 |
| Liquidation | `test/lending/lending-pool-liquidation.test.js` | 10 |
| Yield-repay | `test/lending/yield-repay.test.js` | 10 |
| Sweep stack | `test/lending/sweep-stack.test.js` | varies |
| v1.2 features | `test/lending/v1-2-features.test.js` | 8 |
| **NFTValuer unit** | `test/valuation/nft-valuer.test.js` | **29** |
| **Pool × Valuer integration** | `test/valuation/lending-with-valuer.test.js` | **12** |

Total: **201 passing** as of 2026-04-20.

---

## 11. Known gaps

1. **Valuer not deployed yet** — pool runs in legacy mode until operator deploys `NFTValuer`, runs `configure-valuer.cjs` for the 4 Pool collections, and calls `pool.setValuer(addr)`.
2. **Marketplace-auction liquidation** — v1.4 work; current code path reverts with `UnsupportedLiquidationStrategy` for non-vault-unwind NFTs.
3. **Per-collection floor oracles** — no production `IFloorOracle` implementation exists. First floor-mode collection will need one (Chainlink NFT floor feed wrapper, Reservoir API bridge, or keeper-pushed feed with staleness guards).
4. **Creator royalties** — not on-chain. Diggers take their cut and pay creators out-of-band.
5. **Off-chain order book / signatures** — every listing is on-chain escrow. Gas-sensitive projects should wait for v1.1 EIP-712 listings.
6. **Inbound HyperEVM bridge** — operator-manual (~10 days) because HL Bridge2 withdraw finalization is 5–7 days. No alternative bridge supports USDC on HyperEVM.

---

## 12. Change log

- **2026-04-20 v1.3 (this doc)** — added `NFTValuer` sidecar, rewired LendingPool valuation to delegate, documented modes + strategies + max-clamp + liquidation strategy dispatch. Not yet deployed.
- 2026-04-20 v1.2 — LendingPool auto-pull from Sweep on borrow + supplier-withdraw; per-collection borrow APR overrides.
- 2026-04-20 v1.1 — yield-repay slider (`setYieldRepayBps`, `harvestAndApply`).
- 2026-04-20 v1.0 — LendingPool initial deploy + liquidation flow + SweepController wiring.
- 2026-04-20 Marketplace Phase 2 — DiggerRegistry + RoyaltyRouter + EcosystemMarketplace initial deploy.
