// ═════════════════════════════════════════════════════════════════════════════
//  Redeploy Pool D as v15.10 — fix for ERC721InvalidSender (0x73c6ac6e)
//  The v15.9 Pool D NFT (0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171) has
//  tokenId 3 parked on 0x…dEaD (transferred, not burned). Next vault.deposit()
//  reverts in _mint because the tokenId slot is occupied.
//
//  Strategy: fresh vault + fresh NFT. REUSE existing Fluid adapter
//  (0x763460Df40F5bA8f55854e5AcD167F4D33D66865) — it's immutable and already
//  proven. Adapter supports multiple vaults via addVault() so old v15.9 can
//  still be used for withdraws while the new v15.10 takes new deposits.
//
//  Usage:
//    DEPLOYER_KEY=0x... ARB_RPC=... \
//      npx hardhat run scripts/redeploy-pool-d-v15_10.js --network arbitrum
//
//  After deploy, run: scripts/verify-pool-d-v15_10.js for a $5 deposit check.
// ═════════════════════════════════════════════════════════════════════════════

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Ecosystem constants (unchanged from v15.9) ───────────
const TREASURY       = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN      = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1     = "0x73c793E669e393aB02ABc12BccD16eF188514026";
const USDC_ARB       = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARB_SEQ_UPTIME = "0xFdB631F5EE196F0ed6FAa767959853A9F217697D";

// Trusted swap targets
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeEA2A79D7d3d36753C8917AF744D71f13C9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

// ─────────── Pool D basket tokens + Chainlink feeds ───────────
const WBTC  = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const XAUT0 = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const BTC_USD_FEED = "0x6ce185860a4963106506C203335A2910413708e9";
const XAU_USD_FEED = "0x587b3499d3234a93CCC411e945295e3735BBb6a4";
const ZERO_FEED    = "0x0000000000000000000000000000000000000000";

// ─────────── Reused adapter (Fluid, already deployed v15.4) ───────────
const FLUID_ADAPTER = "0x763460Df40F5bA8f55854e5AcD167F4D33D66865";

// ─────────── Pool D v15.10 config (identical basket to v15.9) ───────────
const POOL_D = {
  label:   "Hard Assets Fluid",
  nftName: "Hard Assets",
  adapter: FLUID_ADAPTER,
  basket: [
    { token: WBTC,  weight: 4000, feed: BTC_USD_FEED, feedDec: 8, tokenDec: 8, staleness: 0      },
    { token: XAUT0, weight: 4000, feed: XAU_USD_FEED, feedDec: 8, tokenDec: 6, staleness: 259200 },
    { token: USDC,  weight: 2000, feed: ZERO_FEED,    feedDec: 0, tokenDec: 6, staleness: 0      },
  ],
};

// Previous deployment being retired (for config archival)
const PREVIOUS = {
  vault: "0x109B722501A713E48465cA0509E8724f6640b9D4", // v15.9 Pool D vault
  nft:   "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", // v15.9 Pool D NFT (tokenId 3 stuck on 0xdEaD)
  version: "v15.9-whitelist",
  note: "v15.9 — ERC721 tokenId 3 parked on 0xdEaD via transferFrom (not _burn). vault.deposit reverts with ERC721InvalidSender(0). Superseded by v15.10 2026-04-24.",
};

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function grantRole(bytes32,address) external",
  "function setAllocation(uint256,uint256) external",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
  "function basketLength() view returns (uint256)",
  "function whitelistEnabled() view returns (bool)",
  "function nextPosId() view returns (uint256)",
];
const NFT_ABI     = [
  "function addVault(address) external",
  "function setVault(address) external",
  "function setBonusAccumulator(address) external",
  "function setYieldSource(string) external",
  "function setRiskTier(string) external",
  "function setApyRange(string) external",
  "function totalSupply() view returns (uint256)",
];
const BONUS_ABI   = ["function addVault(address) external"];
const ADAPTER_ABI = ["function addVault(address) external"];

const pause = (ms = 1500) => new Promise(r => setTimeout(r, ms));

async function deployPoolD(signer) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  POOL D v15.10 — ${POOL_D.label}`);
  console.log(`${"═".repeat(60)}`);

  // 1. Deploy vault
  console.log(`\n[1/6] Deploy vault`);
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vault = await Vault.deploy(
    signer.address,
    POOL_D.adapter,
    TREASURY,
    SDM_TOKEN,
    USDC_ARB,
    ARB_SEQ_UPTIME,
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`  vault: ${vaultAddr}`);
  await pause();

  // 2. Deploy NFT
  console.log(`[2/6] Deploy NFT`);
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nft = await NFT.deploy(POOL_D.nftName, signer.address);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log(`  nft: ${nftAddr}`);
  await pause();

  // 3. Grant VAULT_ROLE on adapter / NFT / bonus
  console.log(`[3/6] Grant VAULT_ROLE`);
  const adapterC = new ethers.Contract(POOL_D.adapter, ADAPTER_ABI, signer);
  let tx;
  tx = await adapterC.addVault(vaultAddr);
  console.log(`  adapter.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  const nftC = new ethers.Contract(nftAddr, NFT_ABI, signer);
  tx = await nftC.addVault(vaultAddr);
  console.log(`  nft.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  // Wire NFT metadata reads (vault ref + bonus + display traits).
  // Without these, tokenURI renders empty Yield Source / Risk Tier / APY,
  // and Current Value reads as 0 (NFT computes value via vault.positions).
  tx = await nftC.setVault(vaultAddr);
  console.log(`  nft.setVault tx: ${tx.hash}`); await tx.wait(); await pause();
  tx = await nftC.setBonusAccumulator(BONUS_V2_1);
  console.log(`  nft.setBonusAccumulator tx: ${tx.hash}`); await tx.wait(); await pause();
  tx = await nftC.setYieldSource("Fluid fUSDC");
  console.log(`  nft.setYieldSource tx: ${tx.hash}`); await tx.wait(); await pause();
  tx = await nftC.setRiskTier("Moderate");
  console.log(`  nft.setRiskTier tx: ${tx.hash}`); await tx.wait(); await pause();
  tx = await nftC.setApyRange("3-5%");
  console.log(`  nft.setApyRange tx: ${tx.hash}`); await tx.wait(); await pause();

  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  tx = await bonus.addVault(vaultAddr);
  console.log(`  bonus.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  // 4. Wire vault
  console.log(`[4/6] Wire vault`);
  const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  tx = await v.setPositionNFT(nftAddr);
  console.log(`  setPositionNFT tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setBonusAccumulator(BONUS_V2_1);
  console.log(`  setBonusAccumulator tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
  console.log(`  trust 0x AllowanceHolder tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
  console.log(`  trust 1inch tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ZEROX_LEGACY_EP, true);
  console.log(`  trust 0x legacy tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.grantRole(KEEPER_ROLE_HASH, signer.address);
  console.log(`  grantRole KEEPER tx: ${tx.hash}`); await tx.wait(); await pause();

  // Allocation 40/60 (matches live v15.9 setting)
  tx = await v.setAllocation(4000, 6000);
  console.log(`  setAllocation 40/60 tx: ${tx.hash}`); await tx.wait(); await pause();

  // 5. Add basket tokens
  console.log(`[5/6] Add basket tokens`);
  for (const t of POOL_D.basket) {
    tx = await v.addBasketToken(t.token, t.weight, t.feed, t.feedDec, t.tokenDec, t.staleness);
    console.log(`  addBasketToken ${t.token} weight=${t.weight} tx: ${tx.hash}`);
    await tx.wait(); await pause();
  }

  // 6. Sanity reads
  console.log(`[6/6] Sanity reads`);
  const nftSupply = await nftC.totalSupply();
  console.log(`  yieldAdapter:      ${await v.yieldAdapter()}`);
  console.log(`  positionNFT:       ${await v.positionNFT()}`);
  console.log(`  bonusAccumulator:  ${await v.bonusAccumulator()}`);
  console.log(`  basketLength:      ${(await v.basketLength()).toString()}`);
  console.log(`  whitelistEnabled:  ${await v.whitelistEnabled()}`);
  console.log(`  nextPosId:         ${(await v.nextPosId()).toString()}`);
  console.log(`  nft.totalSupply:   ${nftSupply.toString()}  ← should be 0`);

  if (nftSupply.toString() !== "0") {
    console.warn(`  ⚠  nft.totalSupply != 0 — check before enabling deposits`);
  }

  return { vault: vaultAddr, nft: nftAddr };
}

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);
  console.log("Redeploying ONLY Pool D as v15.10 (ERC721 collision fix)\n");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  const result = await deployPoolD(signer);

  // Archive old Pool D under D_v15_9_stuck
  deployed.pools.D_v15_9_stuck = {
    ...deployed.pools.D,
    ...PREVIOUS,
    deprecated: true,
  };

  // Install new Pool D as current
  deployed.pools.D = {
    ...deployed.pools.D,
    vault: result.vault,
    positionNFT: result.nft,
    version: "v15.10",
    nftVersion: "v15.10",
    note: "v15.10 — ERC721 collision fix, fresh vault + NFT, reuses v15.4 Fluid adapter",
  };

  deployed.v15_10_poolD_deployedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\n✓ deployed.json updated.");

  console.log("\n" + "═".repeat(60));
  console.log("  POOL D v15.10 DEPLOYED");
  console.log("═".repeat(60));
  console.log(`  vault: ${result.vault}`);
  console.log(`  nft:   ${result.nft}`);
  console.log(`  adapter (reused): ${FLUID_ADAPTER}`);
  console.log("\nNext steps:");
  console.log("  1. Run: npx hardhat run scripts/verify-pool-d-v15_10.js --network arbitrum");
  console.log("  2. Patch ~/diamondz-bridge/src/abi/v15.ts Pool D entry");
  console.log("  3. Patch ~/shadowz-dex-gateway config if it references Pool D directly");
  console.log("  4. (Optional) adapter.removeVault(oldVault) from Safe once old vault is drained");
  console.log("  5. Announce migration to any depositors on old Pool D (only deployer owns posIds 1–2)");
}

main().catch((e) => { console.error(e); process.exit(1); });
