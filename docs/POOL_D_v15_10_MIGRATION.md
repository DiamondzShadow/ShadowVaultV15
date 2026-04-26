# Pool D v15.10 Migration — ERC721 Collision Fix

**Root cause:** v15.9 Pool D's position NFT (`0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171`) has `tokenId 3` owned by `0x000…dEaD` (transferred, not burned). `ShadowVaultV15.deposit()` next mint collides at tokenId 3 and reverts with `ERC721InvalidSender(0)` (selector `0x73c6ac6e`).

**Fix:** deploy a fresh vault + fresh NFT for Pool D as v15.10. Reuse the existing Fluid adapter (`0x763460Df40F5bA8f55854e5AcD167F4D33D66865`) — it's immutable, proven, and supports multiple vaults via `addVault`.

---

## Preflight

- [ ] Deployer wallet funded with ≥ 0.01 ETH on Arbitrum for deploy gas
- [ ] `DEPLOYER_KEY` + `ARB_RPC` set in env
- [ ] `config/deployed.json` exists and has a `pools.D` entry
- [ ] Confirm only deployer-owned positions exist on old Pool D (posIds 1, 2). On-chain check:
  ```bash
  cast call 0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171 "ownerOf(uint256)(address)" 1 --rpc-url $ARB_RPC
  cast call 0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171 "ownerOf(uint256)(address)" 2 --rpc-url $ARB_RPC
  ```
  Both should return the deployer (`0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3`). If any external wallet owns a Pool D position, coordinate withdraw first.

---

## Deploy

```bash
cd ~/ShadowVaultV15
DEPLOYER_KEY=0x... ARB_RPC=https://arb1.arbitrum.io/rpc \
  npx hardhat run scripts/redeploy-pool-d-v15_10.js --network arbitrum
```

Expected output at the end:
```
  POOL D v15.10 DEPLOYED
  vault: 0x<NEW_VAULT>
  nft:   0x<NEW_NFT>
  adapter (reused): 0x763460Df40F5bA8f55854e5AcD167F4D33D66865
```

`config/deployed.json` is rewritten with the new Pool D addresses and the old Pool D archived under `pools.D_v15_9_stuck`.

---

## Verify

```bash
DEPLOYER_KEY=0x... ARB_RPC=... \
  npx hardhat run scripts/verify-pool-d-v15_10.js --network arbitrum
```

Runs a $5 FLEX deposit. Succeeds when:
- New NFT mints tokenId 1 owned by the deployer
- Adapter `totalAssets` increases by ~$2 (the 40% USDC slice)
- `vault.nextPosId` advances from 1 to 2

If this fails with the same `0x73c6ac6e` selector, something in the new NFT is pre-polluted — revert and investigate before exposing to users.

---

## Frontend patches

### 1. `~/diamondz-bridge/src/abi/v15.ts`

In `ADDRESSES.pools.D`, replace `vault` and `positionNFT` with the v15.10 addresses:

```diff
     "D": {
       "label": "Hard Assets Fluid",
-      "vault": "0x109B722501A713E48465cA0509E8724f6640b9D4",
-      "positionNFT": "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171",
+      "vault": "0x<NEW_VAULT>",
+      "positionNFT": "0x<NEW_NFT>",
       "yieldSource": "fluid",
       "adapter": "0x763460Df40F5bA8f55854e5AcD167F4D33D66865",
-      "version": "v15.9-whitelist",
+      "version": "v15.10",
       "basket": "WBTC 40 / XAUt0 40 / USDC 20",
       "apyRange": "3-5%",
       "riskTier": "Moderate"
     }
```

In `ADDRESSES.deprecated`, add the retired v15.9 Pool D entry:

```json
"D_v15_9_stuck": {
  "label": "Hard Assets Fluid (v15.9 — NFT collision)",
  "vault": "0x109B722501A713E48465cA0509E8724f6640b9D4",
  "positionNFT": "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171",
  "yieldSource": "fluid",
  "adapter": "0x763460Df40F5bA8f55854e5AcD167F4D33D66865",
  "note": "v15.9 — ERC721 tokenId 3 parked on 0xdEaD via transferFrom (not _burn). vault.deposit reverts with ERC721InvalidSender(0) = 0x73c6ac6e. Replaced by v15.10 2026-04-24."
}
```

### 2. Frontend error decoder — merge NFT errors

Wherever the Pool D deposit error is decoded against `VAULT_ABI` + `FLUID_ADAPTER_ABI`, also include `NFT_ABI` errors so position-NFT-level reverts show human-readable names:

```ts
import { VAULT_ABI, NFT_ABI, FLUID_ADAPTER_ABI } from "@/abi/v15";

const depositErrorAbi = [
  ...VAULT_ABI,
  ...FLUID_ADAPTER_ABI,
  ...NFT_ABI.filter((e) => e.type === "error"),
];
```

This is an independent bug fix — worth doing even after v15.10 ships, because any future NFT revert will otherwise show as a raw selector again.

### 3. `~/shadowz-dex-gateway`

Grep for the old Pool D addresses and update anywhere they appear:

```bash
cd ~/shadowz-dex-gateway
grep -rn "0x109B722501A713E48465cA0509E8724f6640b9D4\|0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171" src/
```

---

## Post-deploy cleanup (optional, can wait)

- **Adapter old-vault removal** — once the deployer's test positions on old v15.9 Pool D vault are withdrawn, call `FluidAdapter.removeVault(0x109B722501A713E48465cA0509E8724f6640b9D4)` from the admin Safe. Not urgent; multiple vaults on one adapter is the intended pattern.
- **Archive the old vault in the DAO proposal UI** — `~/diamondz-bridge/src/components/dao/CreateProposal.tsx` references Pool D; verify the dropdown shows the v15.10 vault now.

---

## Rollback

If the v15.10 deploy runs but verify fails, revert the `config/deployed.json` change (git has it) and leave the frontend pointed at the old v15.9 addresses. Users can't deposit to Pool D either way until the new deploy is verified clean, so a rollback just buys time.

`git checkout HEAD -- config/deployed.json` inside `~/ShadowVaultV15` undoes the write.
