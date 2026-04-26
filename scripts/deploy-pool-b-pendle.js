// SPDX-License-Identifier: MIT
// Pool B v2 — Pendle PT Fixed Yield replacement for the Silo version
//
// User declared Silo wstUSR/USDC dangerous. Rebuild Pool B with Pendle
// PT-gUSDC-25JUN2026 as the yield source. Uses the fixed PendleAdapter
// (FillOrderParams/Order structs updated to match Pendle V4).
//
// Basket: keep the same DeFi+RWA theme from current Pool B v15.2 so the
// product story is unchanged:
//   WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10
//
// Current Pool B v15.2 vault (0x0D32…8C90) stays deployed with its $5
// Silo position — user can withdraw it whenever Silo wstUSR/USDC
// utilization drops. Old Pool B is moved to `pools.B_silo_deprecated`
// in deployed.json and the new Pendle-backed vault takes the `B` slot.
//
// Reuses the oracle cardinality already bumped on PT-gUSDC-25JUN2026
// market (20M gas paid earlier, not redoing).

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Pendle market params (PT-gUSDC-25JUN2026 on Arbitrum) ───────────
const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";

// ─────────── Ecosystem constants ───────────
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

// Basket tokens (DeFi + RWA theme, same as old Pool B v15.2)
const WETH   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const GMX    = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// Chainlink / Pyth feeds
const ETH_USD_FEED    = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const GMX_USD_FEED    = "0xDB98056FecFff59D032aB628337A4887110df3dB";
const PENDLE_USD_FEED = "0x66853E19d73c0F9301fe099c324A1E9726953433";
const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const XAU_USD_FEED    = "0x587b3499d3234a93CCC411e945295e3735BBb6a4"; // Pyth wrapper
const ZERO_FEED       = "0x0000000000000000000000000000000000000000";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

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

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);
  console.log("");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // ─── 1. Deploy FIXED PendleAdapter ───
  console.log("── [1/7] Deploying PendleAdapter (Pool B, fixed FillOrderParams) ──");
  const PendleAdapter = await ethers.getContractFactory("PendleAdapter");
  const pendleAdapter = await PendleAdapter.deploy(
    signer.address,
    PENDLE_MARKET,
    PENDLE_PT,
    PENDLE_YT,
    PENDLE_SY,
  );
  await pendleAdapter.waitForDeployment();
  const pendleAdapterAddr = await pendleAdapter.getAddress();
  console.log("PendleAdapter (B):", pendleAdapterAddr);
  console.log("deploy tx:        ", pendleAdapter.deploymentTransaction().hash);
  console.log("");

  // ─── 2. Deploy Pool B v2 vault ───
  console.log("── [2/7] Deploying Pool B v2 ShadowVaultV15 (DeFi + RWA Pendle yield) ──");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vaultB = await Vault.deploy(
    signer.address,
    pendleAdapterAddr,
    TREASURY,
    SDM_TOKEN,
  );
  await vaultB.waitForDeployment();
  const vaultBAddr = await vaultB.getAddress();
  console.log("Pool B v2 vault:", vaultBAddr);
  console.log("deploy tx:     ", vaultB.deploymentTransaction().hash);
  console.log("");

  // ─── 3. Deploy Pool B v2 NFT ───
  console.log("── [3/7] Deploying Pool B v2 ShadowPositionNFTV15 ──");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nftB = await NFT.deploy("DeFi + RWA", signer.address);
  await nftB.waitForDeployment();
  const nftBAddr = await nftB.getAddress();
  console.log("Pool B v2 NFT:", nftBAddr);
  console.log("deploy tx:   ", nftB.deploymentTransaction().hash);
  console.log("");

  // ─── 4. Grant VAULT_ROLE on adapter / NFT / bonus ───
  console.log("── [4/7] Granting VAULT_ROLE on adapter / NFT / bonus V2.1 ──");
  let tx;

  console.log("  pendleAdapter.addVault(poolB)");
  tx = await pendleAdapter.addVault(vaultBAddr);
  console.log("  tx:", tx.hash); await tx.wait();

  const nft = new ethers.Contract(nftBAddr, NFT_ABI, signer);
  console.log("  nftB.addVault(poolB)");
  tx = await nft.addVault(vaultBAddr);
  console.log("  tx:", tx.hash); await tx.wait();

  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  console.log("  bonusV2.1.addVault(poolB)");
  tx = await bonus.addVault(vaultBAddr);
  console.log("  tx:", tx.hash); await tx.wait();
  console.log("");

  // ─── 5. Wire vault settings ───
  console.log("── [5/7] Wiring vault settings ──");
  const vault = new ethers.Contract(vaultBAddr, VAULT_ABI, signer);

  console.log("  setPositionNFT");
  tx = await vault.setPositionNFT(nftBAddr);
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

  // ─── 6. Add basket tokens (DeFi+RWA, same as old Pool B) ───
  console.log("── [6/7] Adding basket: WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10 ──");

  console.log("  addBasketToken(WETH, 2500, ETH/USD)");
  tx = await vault.addBasketToken(WETH, 2500, ETH_USD_FEED, 8, 18, 0);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(GMX, 2000, GMX/USD)");
  tx = await vault.addBasketToken(GMX, 2000, GMX_USD_FEED, 8, 18, 0);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(PENDLE, 2000, PENDLE/USD)");
  tx = await vault.addBasketToken(PENDLE, 2000, PENDLE_USD_FEED, 8, 18, 0);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(LINK, 1500, LINK/USD)");
  tx = await vault.addBasketToken(LINK, 1500, LINK_USD_FEED, 8, 18, 0);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(XAUt0, 1000, Pyth XAU/USD wrapper, 3-day staleness)");
  tx = await vault.addBasketToken(XAUT0, 1000, XAU_USD_FEED, 8, 6, 259200);
  console.log("  tx:", tx.hash); await tx.wait();

  console.log("  addBasketToken(USDC, 1000, $1 fallback)");
  tx = await vault.addBasketToken(USDC, 1000, ZERO_FEED, 0, 6, 0);
  console.log("  tx:", tx.hash); await tx.wait();
  console.log("");

  // ─── 7. Sanity reads + persist ───
  console.log("── [7/7] Sanity reads + persist ──");
  console.log("  yieldAdapter: ", await vault.yieldAdapter());
  console.log("  positionNFT:  ", await vault.positionNFT());
  console.log("  bonusAcc:     ", await vault.bonusAccumulator());
  console.log("  basketLength: ", (await vault.basketLength()).toString());

  // Move current Pool B v15.2 → B_silo_deprecated, put new Pendle Pool B in the B slot
  if (deployed.pools.B) {
    deployed.pools.B_silo_deprecated = {
      ...deployed.pools.B,
      note: "v15.2 Silo wstUSR/USDC — declared dangerous by user 2026-04-11. User's $5 position still here, withdraw when Silo utilization drops. Do not deposit new funds.",
    };
  }
  deployed.pools.B = {
    label: "DeFi + RWA Pendle",
    vault: vaultBAddr,
    positionNFT: nftBAddr,
    yieldSource: "pendle",
    adapter: pendleAdapterAddr,
    version: "v15.4",
    pendleMarket: PENDLE_MARKET,
    pendlePt:     PENDLE_PT,
    pendleYt:     PENDLE_YT,
    pendleSy:     PENDLE_SY,
    pendleMaturity: "2026-06-25T00:00:00Z",
    basket: "WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10",
  };
  deployed.adapters = deployed.adapters || {};
  deployed.adapters.pendle_b = pendleAdapterAddr;
  deployed.v15_4AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated.");
  console.log("");

  console.log("═══ Pool B v2 (Pendle) deployment complete ═══");
  console.log("  PendleAdapter (B):", pendleAdapterAddr);
  console.log("  Pool B v2 vault:  ", vaultBAddr);
  console.log("  Pool B v2 NFT:    ", nftBAddr);
  console.log("  Next: verify with $5 deposit (this proves the Pendle struct fix works)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
