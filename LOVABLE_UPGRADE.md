# Shadow Vault V15.8 — Lovable UI Upgrade Spec

## What Changed

Pendle adapters are **DEAD**. All pools now use USDC-native yield (no token swaps in adapters). Pool B upgraded to GMX V2 for 15-25% APY. NFTs now show live portfolio value + rich traits. Allocation changed from 70/30 to 40/60 (more yield, less basket).

**Remove all Pendle references from the UI.** No more PT-gUSDC, no SY tokens, no Pendle markets.

---

## Live Contract Addresses (Arbitrum 42161)

### Core (unchanged)
| Contract | Address |
|----------|---------|
| SDM Token | `0x602b869eEf1C9F0487F31776bad8Af3C4A173394` |
| SDM Discount Oracle | `0xfC18918f2A980665bC596c7af787bC30D8bdd7Ec` |
| Revenue Router | `0x13606740f02a7e96cFCD602E4ecBA4c5e56E3363` |
| Bonus Accumulator V2.1 | `0x73c793E669e393aB02ABc12BccD16eF188514026` |
| Treasury | `0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43` |
| USDC (Arbitrum native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

### Pool A — "Blue Chip Morpho"
| | Address |
|--|---------|
| Vault | `0x02756648d7a19Dda5CCa4Fd4148C20e8952b32c1` |
| NFT (v15.8) | `0x1F56EDeF6C62818a380A90C0Feef24f819d8d73c` |
| Adapter | `0x387Be58c90ac000ded0494b260c2A9dd9086e1E5` |
| Yield Protocol | Morpho Blue — Steakhouse High Yield USDC |
| Morpho Vault | `0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA` |
| Basket | WETH 45% / WBTC 35% / USDC 20% |
| Allocation | 40% basket / 60% yield |
| APY Range | 2-3% |
| Risk Tier | Conservative |

### Pool B — "DeFi + RWA GMX"
| | Address |
|--|---------|
| Vault | `0x283633e389FC969Ffe42d13C324E425980720e64` |
| NFT (v15.8) | `0xf64a622ac95ba095216A0D6b499A156E1028740A` |
| Adapter | `0x19c60f4dBd1a73b0396485714aDf63835F199F79` |
| Yield Protocol | GMX V2 — GM ETH/USDC Pool |
| GM Market | `0x70d95587d40a2caf56bd97485ab3eec10bee6336` |
| Basket | WETH 25% / GMX 20% / PENDLE 20% / LINK 15% / XAUt0 10% / USDC 10% |
| Allocation | 40% basket / 60% yield |
| APY Range | 15-25% |
| Risk Tier | Aggressive |

### Pool C — "Full Spectrum Aave"
| | Address |
|--|---------|
| Vault | `0x8E8be91B612d435bc481C738d9a94Eb1cEd162E6` |
| NFT (v15.8) | `0xaB8F92827d9e2Ac5AD16434F3d3f81A2c15Fe2DF` |
| Adapter | `0xe9231FD442C849B293B1652aE739D165179710d6` |
| Yield Protocol | Aave V3 — USDC Supply |
| Aave Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Basket | WETH 25% / WBTC 15% / GMX 15% / ARB 15% / PENDLE 10% / LINK 10% / PEPE 5% / USDC 5% |
| Allocation | 40% basket / 60% yield |
| APY Range | 1-2% |
| Risk Tier | Conservative |

### Pool D — "Hard Assets"
| | Address |
|--|---------|
| Vault | `0x07D31F7d2fc339556c8b31769B2721007C3Ac82D` |
| NFT (v15.8) | `0xf6cb269F1C60D6B60c227e45aBb8803b11FA8a55` |
| Adapter | `0x763460Df40F5bA8f55854e5AcD167F4D33D66865` |
| Yield Protocol | Fluid — fUSDC |
| Fluid Vault | `0x1A996cb54bb95462040408C06122D45D6Cdb6096` |
| Basket | WBTC 40% / XAUt0 40% / USDC 20% |
| Allocation | 40% basket / 60% yield |
| APY Range | 3-5% |
| Risk Tier | Moderate |

---

## Fee Structure

| Fee | Rate | Condition |
|-----|------|-----------|
| On-time withdrawal | 1.2% | FLEX tier or after lock expires |
| Early exit | 9.0% | LOCK tier withdrawn before unlock |
| SDM discount | 50% off | Hold ≥10,000 SDM → 0.6% on-time |
| Protocol yield fee | 3.0% | Taken on harvested yield by keeper |
| Min deposit | $5 USDC | Hard-coded in vault |
| Max deposit | $1,000,000 USDC | Hard-coded in vault |

---

## NFT Specification (ERC-721 `svPOS15`)

### Contract Interface
```solidity
// Public getters — read for pool info sidebar
poolLabel()      → string  // "Blue Chip Morpho"
yieldSource()    → string  // "Morpho Steakhouse"
riskTier()       → string  // "Conservative"
apyRange()       → string  // "2-3%"

// Per-token
ownerOf(tokenId) → address
tokenURI(tokenId) → string  // data:application/json;base64,...
```

### Token Metadata (JSON)
```json
{
  "name": "Shadow Vault V15 Position #3",
  "description": "On-chain receipt for a Shadow Vault V15 position. Dynamic traits update in real-time...",
  "image": "data:image/svg+xml;base64,...",
  "attributes": [
    { "trait_type": "Pool", "value": "Blue Chip Morpho" },
    { "trait_type": "Yield Source", "value": "Morpho Steakhouse" },
    { "trait_type": "Risk Tier", "value": "Conservative" },
    { "trait_type": "APY Range", "value": "2-3%" },
    { "trait_type": "Lock Tier", "value": "FLEX" },
    { "trait_type": "Deposit USDC", "display_type": "number", "value": 5 },
    { "trait_type": "Current Value USDC", "display_type": "number", "value": 4 },
    { "trait_type": "Boost", "value": "1.00x" },
    { "trait_type": "Bonus Accrued USDC", "display_type": "number", "value": 0 }
  ]
}
```

### Traits Legend
| Trait | Dynamic | Description |
|-------|---------|-------------|
| Pool | Static | Pool name from NFT contract |
| Yield Source | Static | Protocol earning yield (Morpho/GMX/Aave/Fluid) |
| Risk Tier | Static | Conservative / Moderate / Aggressive |
| APY Range | Static | Expected annual yield range |
| Lock Tier | Static | FLEX (instant) / 30D / 90D / 180D / 365D |
| Deposit USDC | Static | Original deposit amount |
| **Current Value USDC** | **LIVE** | Real-time portfolio value from vault oracle |
| Boost | Static | Multiplier based on lock tier (1x-3x) |
| **Bonus Accrued USDC** | **LIVE** | Accumulated bonus from BonusAccumulator |

### SVG Features
- Dark card (#0f0f14) with tier-colored accent bar
- Header: pool name + yield source + position number
- Deposit amount, boost multiplier
- Basket share (wSDM) + yield share
- **LIVE PORTFOLIO VALUE** — large dollar amount, updates every read
- **Basket / Yield breakdown** — shows how value splits between index fund and yield protocol
- **PnL** — green if profit, red if loss, calculated vs deposit
- Bonus streams accumulation
- Footer: "SHADOW VAULT V15 • ON-CHAIN RECEIPT"

---

## Vault Interface (for UI interactions)

### Read Functions (no gas)
```javascript
// Pool info
vault.basketBps()            // 4000 (40%)
vault.yieldBps()             // 6000 (60%)
vault.onTimeFeeBps()         // 120 (1.2%)
vault.earlyExitFeeBps()      // 900 (9%)
vault.basketLength()         // number of basket tokens
vault.basketTokens(index)    // token config at index
vault.wsdmTotalSupply()      // total basket shares
vault.totalDeposited()       // total USDC ever deposited

// Position info
vault.positions(posId)       // full position struct
vault.estimatePositionValue(posId)  // (basketVal, yieldVal, total) in USDC 6-dec
vault.pendingWithdraws(posId)       // pending withdrawal info
vault.getBasketDrift()       // current vs target weights for all tokens
vault.totalBasketValue()     // total basket value in USDC

// Adapter info
vault.yieldAdapter()         // adapter address
adapter.totalAssets()        // USDC value in yield protocol
adapter.totalPrincipal()     // cost basis
```

### Write Functions (user actions)
```javascript
// Deposit — user approves USDC first, then:
vault.deposit(amount, tier)
// amount: USDC in 6-dec (min 5_000_000 = $5)
// tier: 0=FLEX, 1=30D, 2=90D, 3=180D, 4=365D
// Returns: posId (uint256)
// Mints: NFT to msg.sender

// Withdraw — two step:
vault.requestWithdraw(posId)    // gas ~1.5-3M, starts 30min timer
// ... keeper sells basket tokens ...
vault.completeWithdraw(posId)   // after 30min or keeper calls

// Claim yield (FLEX only):
vault.claimYield(posId)         // claims accrued yield above deposit

// Compound yield back into basket (FLEX only):
vault.compoundYield(posId)
```

### Lock Tiers & Boosts
| Tier | Lock | Boost | Early Exit Fee |
|------|------|-------|----------------|
| FLEX | None | 1.00x | N/A |
| 30D | 30 days | 1.20x | 9% |
| 90D | 90 days | 1.50x | 9% |
| 180D | 180 days | 2.00x | 9% |
| 365D | 365 days | 3.00x | 9% |

---

## Deprecated Contracts (REMOVE from UI)

These are the old Pendle-based pools. **Remove all references:**

| Pool | Old Vault | Status |
|------|-----------|--------|
| A Pendle | `0x183f97fE454E9df27A884ABBF094a1729D1BCb0f` | SYInvalidTokenOut — withdrawals broken |
| B Pendle v4 | `0x6dc34609EA286f326ECf5dc087068dA964dDcCb3` | SYInvalidTokenOut — withdrawals broken |
| C Pendle | `0x198FDC12a937a70A75aaEaaB265b61a4FE1286F6` | SYInvalidTokenOut — withdrawals broken |
| B Silo | `0x0D32FA2788Ee6D19ae6ccc5BDB657C7321Ce8C90` | Silo 100% utilization — withdrawals stuck |
| B Morpho (Gauntlet) | `0x46faaE6Ba6c30De214BDb12dd8eD404eDa664232` | Replaced by GMX |
| A Aave (original) | `0x3EABca4E9F1dA0CA6b61a3CC942c09Dd51D77E32` | Replaced by Morpho |
| D Pendle (broken) | `0x38002195F17cE193c8E69690f4B6F4757c202078` | Never worked |

**All PendleAdapter, SiloAdapter references → DELETE.**

---

## UI Page Structure Suggestion

### Pool Cards (landing page)
Each pool shows:
- Pool name + icon
- Yield source badge (Morpho / GMX / Aave / Fluid)
- Risk tier badge (Conservative / Moderate / Aggressive)
- APY range
- Basket composition (token icons + weights)
- Total TVL (from `vault.totalBasketValue() + adapter.totalAssets()`)
- "Deposit" CTA button

### Position Dashboard (after connecting wallet)
For each NFT the user holds:
- SVG card (from tokenURI, rendered as image)
- Live value (from `estimatePositionValue`)
- PnL (value vs deposit, green/red)
- Yield source + APY
- Lock status (FLEX or days remaining)
- Actions: Withdraw / Claim Yield / Compound
- "List on OpenSea" link

### Deposit Flow
1. Select pool
2. Enter USDC amount (min $5)
3. Select tier (FLEX / 30D / 90D / 180D / 365D) — show boost multiplier
4. Approve USDC (if needed)
5. Deposit → receive NFT
6. Show NFT SVG + traits

### Withdraw Flow
1. Select position
2. Click "Withdraw" → calls `requestWithdraw(posId)`
3. Show "Processing..." with 30min countdown
4. Keeper sells basket tokens (automatic)
5. After timer → "Complete Withdraw" button → calls `completeWithdraw(posId)`
6. USDC returned to wallet

---

## Chain Config
```javascript
const CHAIN = {
  id: 42161,
  name: "Arbitrum One",
  rpc: "https://arb1.arbitrum.io/rpc",
  explorer: "https://arbiscan.io",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};
```
