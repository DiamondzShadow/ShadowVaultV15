// SPDX-License-Identifier: MIT
// Pool D — Pendle PT-gUSDC-25JUN2026 Fixed Yield Vault
//
// One-shot deploy that ships an entire 4th pool using the existing
// PendleAdapter.sol. Picks the PT-gUSDC-25JUN2026 market on Arbitrum
// (gUSDC = Pendle's generic USDC yield aggregator, currently the best
// USDC-denominated PT market on Arbitrum per total supply + adapter
// doc comment).
//
// Sequence:
//   1. Deploy PendleAdapter(admin, market, pt, yt, sy)
//   2. Deploy ShadowVaultV15(admin, pendleAdapter, treasury, sdm)
//   3. Deploy ShadowPositionNFTV15("Pendle Fixed Yield", admin)
//   4. Wire up roles:
//      - pendleAdapter.addVault(poolD)         VAULT_ROLE
//      - nftD.addVault(poolD)                  VAULT_ROLE
//      - bonusAccV2_1.addVault(poolD)          VAULT_ROLE
//   5. Wire settings:
//      - poolD.setPositionNFT(nftD)
//      - poolD.setBonusAccumulator(bonusAccV2_1)
//      - poolD.setTrustedSwapTarget(0xfeea… = 0x v2 AllowanceHolder)
//      - poolD.setTrustedSwapTarget(0x1111…1582 = 1inch v5)
//      - poolD.grantRole(KEEPER_ROLE, deployer)   — for keeper ops
//   6. Basket: simple 3-token blend
//      - WETH 40% (Chainlink ETH/USD)
//      - WBTC 30% (Chainlink BTC/USD)
//      - USDC 30% (no feed, $1 fallback)
//   7. Optional: initializeOracle() on adapter if cardinality is below
//      Pendle's recommended threshold
//   8. Persist to config/deployed.json under pools.D
//
// Follow the same wiring rules that were learned the hard way this
// session: V2.1 bonus accumulator (not v1 or V2), 0x AllowanceHolder
// in trusted list from the start, grant VAULT_ROLE on ALL three
// receiver contracts (adapter, NFT, bonus) before any deposit.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Target Pendle market (PT-gUSDC-25JUN2026 on Arbitrum) ───────────
const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";

// ─────────── Ecosystem constants ───────────
const TREASURY     = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN    = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1   = "0x73c793E669e393aB02ABc12BccD16eF188514026";

// Trusted swap targets
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EXCHANGE_PROXY = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

// Basket tokens
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// Chainlink feeds on Arbitrum
const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // ETH/USD
const BTC_USD_FEED = "0x6ce185860a4963106506C203335A2910413708e9"; // BTC/USD
const ZERO_FEED    = "0x0000000000000000000000000000000000000000"; // USDC uses $1 fallback

// Role hashes
const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

// Vault / NFT / bonus minimal ABIs
const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address token, uint256 weightBps, address priceFeed, uint8 feedDecimals, uint8 tokenDecimals, uint256 maxStalenessSecs) external",
  "function grantRole(bytes32,address) external",
  "function bonusAccumulator() view returns (address)",
  "function positionNFT() view returns (address)",
  "function yieldAdapter() view returns (address)",
  "function basketLength() view returns (uint256)",
];

const NFT_ABI = [
  "function addVault(address) external",
];

const BONUS_ABI = [
  "function addVault(address) external",
];

const PENDLE_ADAPTER_ABI = [
  "function addVault(address) external",
  "function market() view returns (address)",
  "function pt() view returns (address)",
  "function asset() view returns (address)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);
  console.log("treasury:", TREASURY);
  console.log("sdm:     ", SDM_TOKEN);
  console.log("bonus:   ", BONUS_V2_1);
  console.log("");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // ─── 1. Deploy PendleAdapter ───
  console.log("── [1/8] Deploying PendleAdapter (PT-gUSDC-25JUN2026) ──");
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
  console.log("PendleAdapter:", pendleAdapterAddr);
  console.log("deploy tx:   ", pendleAdapter.deploymentTransaction().hash);
  console.log("");

  // ─── 2. Deploy Pool D vault ───
  console.log("── [2/8] Deploying ShadowVaultV15 Pool D ──");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vaultD = await Vault.deploy(
    signer.address,
    pendleAdapterAddr,
    TREASURY,
    SDM_TOKEN,
  );
  await vaultD.waitForDeployment();
  const vaultDAddr = await vaultD.getAddress();
  console.log("Pool D vault:", vaultDAddr);
  console.log("deploy tx:  ", vaultD.deploymentTransaction().hash);
  console.log("");

  // ─── 3. Deploy Pool D NFT ───
  console.log("── [3/8] Deploying ShadowPositionNFTV15 Pool D ──");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nftD = await NFT.deploy("Pendle Fixed Yield", signer.address);
  await nftD.waitForDeployment();
  const nftDAddr = await nftD.getAddress();
  console.log("Pool D NFT: ", nftDAddr);
  console.log("deploy tx: ", nftD.deploymentTransaction().hash);
  console.log("");

  // ─── 4. Grant VAULT_ROLE on adapter, NFT, bonus accumulator ───
  console.log("── [4/8] Granting VAULT_ROLE to Pool D on adapter / NFT / bonus ──");

  let tx;
  console.log("  pendleAdapter.addVault(poolD)");
  tx = await pendleAdapter.addVault(vaultDAddr);
  await tx.wait();
  console.log("  tx:", tx.hash);

  const nftContract = new ethers.Contract(nftDAddr, NFT_ABI, signer);
  console.log("  nftD.addVault(poolD)");
  tx = await nftContract.addVault(vaultDAddr);
  await tx.wait();
  console.log("  tx:", tx.hash);

  const bonusContract = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  console.log("  bonusV2.1.addVault(poolD)");
  tx = await bonusContract.addVault(vaultDAddr);
  await tx.wait();
  console.log("  tx:", tx.hash);
  console.log("");

  // ─── 5. Wire vault settings ───
  console.log("── [5/8] Wiring vault settings ──");
  const vault = new ethers.Contract(vaultDAddr, VAULT_ABI, signer);

  console.log("  setPositionNFT");
  tx = await vault.setPositionNFT(nftDAddr);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  setBonusAccumulator(V2.1)");
  tx = await vault.setBonusAccumulator(BONUS_V2_1);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  setTrustedSwapTarget(0x AllowanceHolder)");
  tx = await vault.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  setTrustedSwapTarget(1inch v5)");
  tx = await vault.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  setTrustedSwapTarget(0x legacy)");
  tx = await vault.setTrustedSwapTarget(ZEROX_LEGACY_EXCHANGE_PROXY, true);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  grantRole(KEEPER_ROLE, deployer)");
  tx = await vault.grantRole(KEEPER_ROLE_HASH, signer.address);
  await tx.wait();
  console.log("  tx:", tx.hash);
  console.log("");

  // ─── 6. Add basket tokens ───
  console.log("── [6/8] Adding basket tokens (WETH 40 / WBTC 30 / USDC 30) ──");

  console.log("  addBasketToken(WETH, 4000, ETH/USD)");
  tx = await vault.addBasketToken(WETH, 4000, ETH_USD_FEED, 8, 18, 0);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  addBasketToken(WBTC, 3000, BTC/USD)");
  tx = await vault.addBasketToken(WBTC, 3000, BTC_USD_FEED, 8, 8, 0);
  await tx.wait();
  console.log("  tx:", tx.hash);

  console.log("  addBasketToken(USDC, 3000, $1 fallback)");
  tx = await vault.addBasketToken(USDC, 3000, ZERO_FEED, 0, 6, 0);
  await tx.wait();
  console.log("  tx:", tx.hash);
  console.log("");

  // ─── 7. Sanity reads ───
  console.log("── [7/8] Sanity reads ──");
  console.log("  yieldAdapter: ", await vault.yieldAdapter());
  console.log("  positionNFT:  ", await vault.positionNFT());
  console.log("  bonusAcc:     ", await vault.bonusAccumulator());
  console.log("  basketLength: ", (await vault.basketLength()).toString());
  console.log("");

  // ─── 8. Persist ───
  console.log("── [8/8] Updating deployed.json ──");
  deployed.pools.D = {
    label: "Pendle Fixed Yield",
    vault: vaultDAddr,
    positionNFT: nftDAddr,
    yieldSource: "pendle",
    adapter: pendleAdapterAddr,
    version: "v15.4",
    pendleMarket: PENDLE_MARKET,
    pendlePt:     PENDLE_PT,
    pendleYt:     PENDLE_YT,
    pendleSy:     PENDLE_SY,
    pendleMaturity: "2026-06-25T00:00:00Z",
  };
  deployed.adapters = deployed.adapters || {};
  deployed.adapters.pendle = pendleAdapterAddr;
  deployed.v15_4AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated.");
  console.log("");

  console.log("═══ Pool D deployment complete ═══");
  console.log("  PendleAdapter: ", pendleAdapterAddr);
  console.log("  Pool D vault:  ", vaultDAddr);
  console.log("  Pool D NFT:    ", nftDAddr);
  console.log("  Next: test a $5 deposit via scripts/verify-pool-d-deposit.js");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
