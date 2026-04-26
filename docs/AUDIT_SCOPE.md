# ShadowVaultV15 — Audit Scope

This document defines the precise audit scope for ShadowVaultV15. Anything not listed in
"In scope" is explicitly out of scope. Marketplace and ShadowPass NFT layers are deferred
to a milestone-2 audit.

## In scope (5,188 nSLOC across 30 files)

### Vault core (1,978 nSLOC)

| File | Raw | nSLOC | Role |
|---|---:|---:|---|
| `contracts/ShadowVaultV15.sol` | 1035 | 713 | Main USDC yield vault (Arb + Polygon, Pools A–D) |
| `contracts/ShadowVaultHyperBasket.sol` | 331 | 210 | HyperEVM Pool E variant (yield + basket allocation) |
| `contracts/ShadowPositionNFTV15.sol` | 414 | 304 | ERC-721 receipt NFT, posId↔tokenId synced |
| `contracts/BonusAccumulatorV2_1.sol` | 301 | 213 | Per-position bonus accrual (current; V1 + V2 deprecated) |
| `contracts/RevenueRouter.sol` | 126 | 83 | Fee splitter (Arb) |
| `contracts/RevenueRouterHC.sol` | 137 | 89 | Fee splitter (HyperEVM) |
| `contracts/SDMArbitrumMirror.sol` | 97 | 57 | Read-only mirror of canonical SDM balance for tier checks |
| `contracts/SDMDiscountOracle.sol` | 53 | 35 | Tier→fee-discount lookup |
| `contracts/HyperSkin.sol` | 203 | 106 | Pool E skin NFT trait engine |
| `contracts/PoolSB_MirrorNFT.sol` | 265 | 168 | Polygon/Base Pool B NFT mirror |

### Yield adapters (1,457 nSLOC)

| File | Raw | nSLOC | Role |
|---|---:|---:|---|
| `contracts/adapters/AaveAdapterV6.sol` | 471 | 273 | Aave V3 USDC supply (Pool C) — **current** |
| `contracts/adapters/GmxAdapter.sol` | 551 | 358 | GMX V2 GM market deposit |
| `contracts/adapters/MorphoAdapter.sol` | 197 | 122 | Morpho Steakhouse USDC vault |
| `contracts/adapters/FluidAdapter.sol` | 192 | 115 | Fluid USDC supply |
| `contracts/adapters/SiloAdapter.sol` | 240 | 141 | Silo lending USDC supply |
| `contracts/adapters/HLPAdapterHCv2.sol` | 414 | 245 | HyperEVM HLP via HyperCore (Pool E) — **current** |
| `contracts/adapters/BasketAdapterHC.sol` | 244 | 149 | HyperCore basket allocator (Pool F) |
| `contracts/adapters/PythFeed.sol` | 100 | 54 | Pyth price-feed wrapper |

### Lending (1,025 nSLOC)

| File | Raw | nSLOC | Role |
|---|---:|---:|---|
| `contracts/lending/LendingPool.sol` | 1075 | 622 | NFT-collateralized USDC borrowing — **current** |
| `contracts/lending/AaveV3Sink.sol` | 88 | 52 | Idle USDC sink → Aave V3 (Arb) |
| `contracts/lending/CompoundV3Sink.sol` | 108 | 58 | Idle USDC sink → Compound V3 (Arb) |
| `contracts/lending/SweepControllerV2.sol` | 291 | 189 | Idle-cash sweep orchestrator — **current** |
| `contracts/lending/HyperRemoteMirror.sol` | 184 | 104 | Read-only mirror of HyperEVM positions for valuation |

### Cross-chain bridges (680 nSLOC)

| File | Raw | nSLOC | Role |
|---|---:|---:|---|
| `contracts/lz/HyperPositionLocker.sol` | 272 | 168 | LayerZero locker on HyperEVM (locks Pool E NFT) |
| `contracts/lz/HyperPositionWrapper.sol` | 240 | 169 | LayerZero wrapper on Arb (mints mirror NFT) |
| `contracts/lz/ShadowPassValuer.sol` | 91 | 49 | NAV oracle for ShadowPass-bridged positions |
| `contracts/ccip/ArbPositionWrapper.sol` | 223 | 153 | CCIP wrapper on Arb (mints mirror of Polygon NFT) |
| `contracts/ccip/PolygonNFTLocker.sol` | 246 | 141 | CCIP locker on Polygon |

### In-scope interfaces (48 nSLOC)

`contracts/interfaces/IYieldAdapter.sol`, `IBonusAccumulator.sol`, `INFTValuer.sol`,
`IShadowPositionNFT.sol`.

## Out of scope — deferred to milestone 2 (1,329 nSLOC)

These are live but not in this audit cycle:
- `contracts/marketplace/` — `DiggerRegistry`, `EcosystemMarketplace`, `NFTValuer`, `RoyaltyRouter`
- `contracts/shadowpass/` — `ShadowPass`, `YieldReceipt`, `BasketReceipt`, `BasketNavOracle`

## Out of scope — deprecated / superseded (do not audit)

- `contracts/BonusAccumulator.sol` (v1) and `BonusAccumulatorV2.sol` — superseded by V2_1
- `contracts/adapters/AaveAdapterV5.sol` — superseded by V6
- `contracts/adapters/HLPAdapter.sol` and `HLPAdapterHC.sol` (v1) — superseded by HCv2
- `contracts/adapters/PendleAdapter.sol` and `PendleAdapterV5.sol` — protocol abandoned
- `contracts/lending/SweepController.sol` (v1) — superseded by V2
- `contracts/ccip/ICCIPRouter.sol` — interface only, no behavior to audit
- All `contracts/mocks/*` — test mocks, not deployed

## Out of scope — never deploy targets

`config/deployed*.json` files contain `*_v1_unused`, `*_v1_1_unused`, `*_legacy`,
`*_deprecated`, and `*_unused_badlink` keys. These addresses are listed only so the
canonical app never accidentally writes to them. They are **not** in audit scope.

## Trust model

All system contracts use OpenZeppelin `AccessControl` + per-chain Gnosis Safe as admin.
**No `Ownable` is used anywhere.** The deployer EOA is rotated to the Safe before any
contract handles user funds.

| Role | Holder | Where |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | per-chain Safe | every contract |
| `KEEPER_ROLE` | hot-key keeper EOA | adapter rebalances, NAV pushes |
| `PAUSER_ROLE` | per-chain Safe | every contract |
| `UPGRADER_ROLE` | per-chain Safe | upgradable contracts only |

Per-chain Safes:
- Arbitrum: `0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43`
- Polygon: `0xdF46A5083C01C82b2e70fF97E9cf27fC80000851`
- HyperEVM Pool E/F: addresses recorded in `config/deployed-pool-{e,f}-hc*.json`

## Key invariants for auditor focus

### Vault accounting
1. **Share/asset conservation.** Sum of all positions' `assets` (after rounding) ≤ vault's
   total managed USDC + accrued yield at all times.
2. **No mint/burn skew.** `nft.tokenId == vault.posId` enforced via `syncNextTokenId()`;
   never `nft.mint()` outside `vault.deposit()`.
3. **Withdraw orphan check.** `requestWithdraw` must not orphan yield-adapter shares when
   the underlying adapter (e.g. Silo) is at 100% utilization. Pool B v15.2 fix is in
   scope; verify it generalizes.

### Adapters
4. **`rescueToken`.** Every adapter exposes `rescueToken(token, to, amount)` with admin
   gating; auditor should verify it cannot drain principal-bearing tokens.
5. **`maxRedeem` / `maxDeposit`.** ERC-4626-style adapters must check caps and return 0
   gracefully rather than revert (avoids stuck epochs).
6. **HLPAdapterHCv2 spot↔perp class transfer.** v1 had a class-routing bug; verify v2's
   hop logic does not strand HLP equity on the wrong class.

### Lending
7. **NFT collateral valuation.** `LendingPool` uses `NFTValuer` (out-of-scope marketplace)
   for current value, plus the `HyperRemoteMirror` for cross-chain Pool E. Verify the
   liquidation path is solvent under valuer-revert conditions.
8. **Sweep correctness.** `SweepControllerV2` moves idle USDC into Aave/Compound sinks
   and back; verify it cannot over-sweep beyond `LendingPool.idleUSDC()`.

### Bridges
9. **LZ peer + DVN config.** `HyperPositionLocker` ↔ `HyperPositionWrapper` enforce
   `setPeer` + `enforcedOptions` + DVN setConfig (2 required + 2 optional verified
   on both libraries on both chains 2026-04-21). Verify a malformed inbound lzReceive
   cannot mint a wrapper without a real lock.
10. **CCIP roundtrip.** `PolygonNFTLocker` → CCIP → `ArbPositionWrapper` mints exactly
    one mirror per locked NFT; reverse path burns and unlocks.

### Cross-cutting
11. **UUPS authorization.** Every `_authorizeUpgrade` is `UPGRADER_ROLE`-gated; no
    contract has an open upgrade path.
12. **Pause coverage.** `whenNotPaused` on every state-changing entry point. Pause must
    not break in-flight withdrawals or liquidations.
13. **Reentrancy.** External calls in vault/lending/adapter paths sit behind
    `ReentrancyGuard`. Verify no callback path (ERC-721 receiver, ERC-777, fallback) can
    re-enter during a `deposit`/`withdraw`/`borrow`/`repay`.

## Live deployments

### Arbitrum (chain 42161)
- USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- SDM: `0x602b869eEf1C9F0487F31776bad8Af3C4A173394`
- Treasury Safe: `0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43`
- BonusAccumulatorV2_1: `0x73c793E669e393aB02ABc12BccD16eF188514026`
- RevenueRouter: `0xf1DFeb7690f208Db9b02dCbbc986Dfe8aBF683a2`
- SDMDiscountOracle: `0xfC18918f2A980665bC596c7af787bC30D8bdd7Ec`
- LendingPool (current): `0xc2f02Dff81d019d10d23d9A29bC774830D54290E`
- AaveV3Sink: `0x6CC249345f6C6a85F2128d03c3818026c492F18D`
- CompoundV3Sink: `0xDC5078A79831ef732bB59f8378a795d7cea6585e`
- SweepControllerV2: `0xEc181596A44AFF5747338f6139dBd35C2A930B11`
- HyperRemoteMirror: `0xFb192B3e83E3FacC51a14aA78a9d37a50f587964`
- ArbPositionWrapper (CCIP): `0x43e91f1bceB6bFFc263313facB586436850a4BA0`
- HyperPositionWrapper (LZ): `0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F`
- Pool A–D vaults: see `~/diamondz-bridge/src/abi/v15.ts` and broadcast records under `broadcast/`

### Polygon (chain 137)
- USDC: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- Treasury Safe: `0xdF46A5083C01C82b2e70fF97E9cf27fC80000851`
- LendingPool: `0xB435bc688a01d46264710a16f087932D954D49A4`
- AaveV3Sink: `0xa40941C910F787df8Fd2EE226f11409AEB2fbBdb`
- SweepController: `0x41F03396F81a5B23BE7F8e286956697f049d8D62`
- PolygonNFTLocker (CCIP): `0xd67ACb5770467ce33152A9A02DecCd26242465aD`
- Pool A–D vaults: see broadcast records

### HyperEVM (chain 999)
- USDC: `0xb88339CB7199b77E23DB6E890353E22632Ba630f`
- Pool E v2 vault: `0x481D57E356cF99E44C25675C57C178D9Ef46BD57`
- Pool E v2 adapter (HLPAdapterHCv2): `0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9`
- Pool F v2 vault: `0x3F4396417f142fD406215E8437C448Cb28bf7552`
- Pool F basketAdapter (BasketAdapterHC): `0x39D10E5823E4472070413070E8a51bc75F0bd0D0`
- HyperPositionLocker (LZ): `0xe04534850F5A562F63D3eFD24D8D1A143420235B`
- RevenueRouterHC: `0xeECf14e46AAAC32d50DA4b3BaE475c4BbFE00664`

## Build and test

```bash
git clone https://github.com/DiamondzShadow/ShadowVaultV15
cd ShadowVaultV15
npm install
npx hardhat compile
npx hardhat test
```

Hardhat-based; ~280 unit tests covering vault + adapters + lending + bridges. Test
suite is provided as reference, not for review.

## Prior incidents that informed current design

These are documented for auditor context — the current code is the post-fix version:

- **Pool B Silo 100% utilization orphan** (Pool B v15.2) — `requestWithdraw` left yield
  shares stuck when underlying Silo was fully utilized.
- **BonusAccumulator posId collision** (V1 → V2) — shared registry without per-msg.sender
  namespacing caused two pools to overwrite each other's positions.
- **HLPAdapter spot↔perp class routing** (v1 → HCv2) — Pool E HLP equity stranded on the
  wrong account class.
- **LendingPool ERC721 collision** (Pool D v15.10) — `0x73c6ac6e` `ERC721InvalidSender`
  on tokenId 3 to `0xdEaD`. Fresh vault + NFT redeployed; collision path closed.
- **PolygonNFTLocker bad LINK** (v1 → current) — first deploy used wrong LINK address;
  CCIP fee charge silently failed. Listed as `_v1_unused_badlink` in deploy config.
- **Pendle adapter family** — four cumulative bugs (struct layout, slippage, PT decimals,
  `SYInvalidTokenOut`); the entire Pendle line is abandoned and out of scope.
