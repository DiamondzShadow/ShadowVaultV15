// SPDX-License-Identifier: MIT
// Pool D — "Hard Assets" (v15.4 pivot)
//
// User wanted "stocks + BTC" for Pool D. Investigation on Arbitrum:
//   - No tokenized stocks (Backed bSPY, Dinari SPY.D, Berry tSPY) have
//     deep enough DEX liquidity to be a V15 basket token (all < $100
//     supply or < $50/day volume).
//   - Spiko USTBL ($168M TVL real RWA) requires KYC/whitelist for
//     mint/redeem AND has ~$50/day DEX volume, so 0x/1inch can't route
//     a basket buy.
//   - Pendle has no USTBL PT market on Arbitrum.
//
// Pivot to "Hard Assets" — the closest thing to the spirit of
// "real-world store of value + BTC" that actually works today on
// Arbitrum with real Chainlink/Pyth feeds already in the V15 ecosystem:
//
//   Basket:  WBTC 40 / XAUt0 40 / USDC 20   (Digital Gold + physical gold)
//   Yield:   Fluid fUSDC (new adapter instance, same pattern as Pool C)
//   Theme:   "hard assets that hold value"
//
// Uses the corrected uint32 addBasketToken signature (earlier Pool D
// attempt hit the uint256/uint32 ABI bug). Reuses all the wiring
// lessons from v15.3.1: V2.1 bonus accumulator, 0x AllowanceHolder
// trusted from the start, grant VAULT_ROLE on all three receivers.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Ecosystem constants ───────────
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

// Trusted swap targets
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

// Basket tokens
const WBTC   = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// Price feeds
const BTC_USD_FEED     = "0x6ce185860a4963106506C203335A2910413708e9"; // Chainlink BTC/USD
const XAU_USD_FEED     = "0x587b3499d3234a93CCC411e945295e3735BBb6a4"; // V15's PythFeed wrapper (XAU/USD)
const ZERO_FEED        = "0x0000000000000000000000000000000000000000";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

// Correct signatures this time — uint32 for maxStalenessSecs
const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address token, uint256 weightBps, address priceFeed, uint8 feedDecimals, uint8 tokenDecimals, uint32 maxStalenessSecs) external",
  "function grantRole(bytes32,address) external",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
  "function basketLength() view returns (uint256)",
];

const NFT_ABI   = ["function addVault(address) external"];
const BONUS_ABI = ["function addVault(address) external"];
const ADAPTER_ABI = [
  "function addVault(address) external",
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);
  console.log("");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // ─── 1. Deploy a dedicated FluidAdapter for Pool D ───
  console.log("── [1/7] Deploying FluidAdapter (Pool D instance) ──");
  const FluidAdapter = await ethers.getContractFactory("FluidAdapter");
  const fluidAdapterD = await FluidAdapter.deploy(signer.address);
  await fluidAdapterD.waitForDeployment();
  const fluidAdapterDAddr = await fluidAdapterD.getAddress();
  console.log("FluidAdapter (D):", fluidAdapterDAddr);
  console.log("deploy tx:", fluidAdapterD.deploymentTransaction().hash);
  console.log("");

  // ─── 2. Deploy Pool D vault ───
  console.log("── [2/7] Deploying Pool D ShadowVaultV15 (Hard Assets) ──");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vaultD = await Vault.deploy(
    signer.address,
    fluidAdapterDAddr,
    TREASURY,
    SDM_TOKEN,
  );
  await vaultD.waitForDeployment();
  const vaultDAddr = await vaultD.getAddress();
  console.log("Pool D vault:", vaultDAddr);
  console.log("deploy tx:   ", vaultD.deploymentTransaction().hash);
  console.log("");

  // ─── 3. Deploy Pool D NFT ───
  console.log("── [3/7] Deploying Pool D ShadowPositionNFTV15 (Hard Assets) ──");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nftD = await NFT.deploy("Hard Assets", signer.address);
  await nftD.waitForDeployment();
  const nftDAddr = await nftD.getAddress();
  console.log("Pool D NFT:", nftDAddr);
  console.log("deploy tx: ", nftD.deploymentTransaction().hash);
  console.log("");

  // ─── 4. Grant VAULT_ROLE on the three receivers ───
  console.log("── [4/7] Granting VAULT_ROLE on adapter / NFT / bonus V2.1 ──");
  let tx;

  console.log("  fluidAdapterD.addVault(poolD)");
  tx = await fluidAdapterD.addVault(vaultDAddr);
  console.log("  tx:", tx.hash);
  await tx.wait();

  const nft = new ethers.Contract(nftDAddr, NFT_ABI, signer);
  console.log("  nftD.addVault(poolD)");
  tx = await nft.addVault(vaultDAddr);
  console.log("  tx:", tx.hash);
  await tx.wait();

  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  console.log("  bonusV2.1.addVault(poolD)");
  tx = await bonus.addVault(vaultDAddr);
  console.log("  tx:", tx.hash);
  await tx.wait();
  console.log("");

  // ─── 5. Wire vault settings ───
  console.log("── [5/7] Wiring vault settings ──");
  const vault = new ethers.Contract(vaultDAddr, VAULT_ABI, signer);

  console.log("  setPositionNFT");
  tx = await vault.setPositionNFT(nftDAddr);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  setBonusAccumulator(V2.1)");
  tx = await vault.setBonusAccumulator(BONUS_V2_1);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  setTrustedSwapTarget(0x AllowanceHolder)");
  tx = await vault.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  setTrustedSwapTarget(1inch v5)");
  tx = await vault.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  setTrustedSwapTarget(0x legacy)");
  tx = await vault.setTrustedSwapTarget(ZEROX_LEGACY_EP, true);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  grantRole(KEEPER_ROLE, deployer)");
  tx = await vault.grantRole(KEEPER_ROLE_HASH, signer.address);
  console.log("  tx:", tx.hash); await tx.wait();
  console.log("");

  // ─── 6. Add basket tokens (CORRECT uint32 signature this time) ───
  console.log("── [6/7] Adding basket: WBTC 40 / XAUt0 40 / USDC 20 ──");

  console.log("  addBasketToken(WBTC, 4000, BTC/USD feed)");
  tx = await vault.addBasketToken(WBTC, 4000, BTC_USD_FEED, 8, 8, 0);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(XAUt0, 4000, Pyth XAU/USD wrapper, 3-day staleness)");
  tx = await vault.addBasketToken(XAUT0, 4000, XAU_USD_FEED, 8, 6, 259200);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(USDC, 2000, $1 fallback)");
  tx = await vault.addBasketToken(USDC, 2000, ZERO_FEED, 0, 6, 0);
  console.log("  tx:", tx.hash); await tx.wait();
  console.log("");

  // ─── 7. Sanity reads + persist ───
  console.log("── [7/7] Sanity reads + persist ──");
  console.log("  yieldAdapter: ", await vault.yieldAdapter());
  console.log("  positionNFT:  ", await vault.positionNFT());
  console.log("  bonusAcc:     ", await vault.bonusAccumulator());
  console.log("  basketLength: ", (await vault.basketLength()).toString());

  // Mark old broken Pool D as deprecated and install new Pool D
  if (deployed.pools.D && deployed.pools.D.adapter !== fluidAdapterDAddr) {
    deployed.pools.D_broken_pendle = {
      ...deployed.pools.D,
      note: "v15.4 attempt, Pendle adapter FillOrderParams struct bug, deposit reverts INVALID_SELECTOR — deprecated, do not use",
    };
  }
  deployed.pools.D = {
    label: "Hard Assets",
    vault: vaultDAddr,
    positionNFT: nftDAddr,
    yieldSource: "fluid",
    adapter: fluidAdapterDAddr,
    version: "v15.4",
    basket: "WBTC 40 / XAUt0 40 / USDC 20",
    theme: "digital gold + physical gold + stable reserve",
  };
  deployed.v15_4AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated.");
  console.log("");

  console.log("═══ Pool D (Hard Assets) deployment complete ═══");
  console.log("  FluidAdapter (D):", fluidAdapterDAddr);
  console.log("  Pool D vault:    ", vaultDAddr);
  console.log("  Pool D NFT:      ", nftDAddr);
  console.log("  Next: verify with $5 deposit");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
