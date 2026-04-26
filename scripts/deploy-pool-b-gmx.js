// Pool B v6 — "DeFi + RWA" with GMX V2 GM Pool yield
//
// Replaces Morpho Gauntlet adapter with GmxAdapter targeting
// GLV [WETH-USDC] on Arbitrum. 15-25% APY from trader PnL + funding.
// Same basket: WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Ecosystem constants ───────────
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

// ─────────── GMX V2 addresses (Arbitrum) ───────────
// From gmx-ai/plugins/gmx-io/skills/gmx-trading/references/contract-addresses.md
const GMX_EXCHANGE_ROUTER  = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41";
const GMX_SYNTHETICS_ROUTER = "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6";
const GMX_DEPOSIT_VAULT    = "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55";
const GMX_WITHDRAWAL_VAULT = "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55";

// GLV [WETH-USDC] — diversified across 40+ GM markets
const GLV_WETH_USDC = "0x528A5bac7E746C9A509A1f4F6dF58A03d44279F9";
// For GM deposits, market = the GLV token itself when using GlvRouter,
// but for ExchangeRouter GM deposits we need a specific GM market.
// Use the WETH/USDC GM market as the target:
const GM_ETH_USDC = "0x70d95587d40a2caf56bd97485ab3eec10bee6336";

// ─────────── Basket tokens + feeds ───────────
const WETH   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const GMX    = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const ETH_USD_FEED    = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const GMX_USD_FEED    = "0xDB98056FecFff59D032aB628337A4887110df3dB";
const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const XAU_USD_FEED    = "0x587b3499d3234a93CCC411e945295e3735BBb6a4";
const ZERO_FEED       = "0x0000000000000000000000000000000000000000";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function grantRole(bytes32,address) external",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
  "function basketLength() view returns (uint256)",
];
const NFT_ABI     = ["function addVault(address) external"];
const BONUS_ABI   = ["function addVault(address) external"];
const ADAPTER_ABI = [
  "function addVault(address) external",
  "function addKeeper(address) external",
  "function totalAssets() view returns (uint256)",
  "function idleUsdc() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const PENDLE_USD_FEED = ethers.getAddress("0x66853e19d73c0f9301fe229c5886c62db2d1e144");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // ── 1. Deploy GmxAdapter ──
  console.log("\n[1/7] Deploy GmxAdapter (GMX V2 GM ETH/USDC)");
  const GmxAdapter = await ethers.getContractFactory("GmxAdapter");
  const adapter = await GmxAdapter.deploy(
    signer.address,       // admin
    GM_ETH_USDC,          // gmToken (GM market token)
    GM_ETH_USDC,          // market (same for GM pools)
    GMX_EXCHANGE_ROUTER,
    GMX_SYNTHETICS_ROUTER,
    GMX_DEPOSIT_VAULT,
    GMX_WITHDRAWAL_VAULT
  );
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("  adapter:", adapterAddr, "tx:", adapter.deploymentTransaction().hash);

  // ── 2. Deploy vault ──
  console.log("\n[2/7] Deploy Pool B v6 vault (DeFi+RWA GMX)");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vault = await Vault.deploy(signer.address, adapterAddr, TREASURY, SDM_TOKEN);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("  vault:", vaultAddr, "tx:", vault.deploymentTransaction().hash);

  // ── 3. Deploy NFT ──
  console.log("\n[3/7] Deploy Pool B v6 NFT");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nft = await NFT.deploy("DeFi RWA GMX", signer.address);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("  nft:", nftAddr, "tx:", nft.deploymentTransaction().hash);

  // ── 4. Grant roles ──
  console.log("\n[4/7] Grant VAULT_ROLE + KEEPER_ROLE on adapter / NFT / bonus");
  const adapterC = new ethers.Contract(adapterAddr, ADAPTER_ABI, signer);
  let tx;

  tx = await adapterC.addVault(vaultAddr);
  console.log("  adapter.addVault tx:", tx.hash); await tx.wait();

  tx = await adapterC.addKeeper(signer.address);
  console.log("  adapter.addKeeper tx:", tx.hash); await tx.wait();

  const nftC = new ethers.Contract(nftAddr, NFT_ABI, signer);
  tx = await nftC.addVault(vaultAddr);
  console.log("  nft.addVault tx:", tx.hash); await tx.wait();

  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  tx = await bonus.addVault(vaultAddr);
  console.log("  bonus.addVault tx:", tx.hash); await tx.wait();

  // ── 5. Wire vault ──
  console.log("\n[5/7] Wire vault settings");
  const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  tx = await v.setPositionNFT(nftAddr);
  console.log("  setPositionNFT tx:", tx.hash); await tx.wait();

  tx = await v.setBonusAccumulator(BONUS_V2_1);
  console.log("  setBonusAccumulator tx:", tx.hash); await tx.wait();

  tx = await v.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
  console.log("  trust 0x AllowanceHolder tx:", tx.hash); await tx.wait();

  tx = await v.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
  console.log("  trust 1inch tx:", tx.hash); await tx.wait();

  tx = await v.setTrustedSwapTarget(ZEROX_LEGACY_EP, true);
  console.log("  trust 0x legacy tx:", tx.hash); await tx.wait();

  tx = await v.grantRole(KEEPER_ROLE_HASH, signer.address);
  console.log("  grantRole KEEPER tx:", tx.hash); await tx.wait();

  // Set allocation to 40/60
  const SET_ALLOC_ABI = ["function setAllocation(uint256,uint256) external"];
  const vAlloc = new ethers.Contract(vaultAddr, SET_ALLOC_ABI, signer);
  tx = await vAlloc.setAllocation(4000, 6000);
  console.log("  setAllocation(40/60) tx:", tx.hash); await tx.wait();

  // ── 6. Add basket ──
  console.log("\n[6/7] Add basket: WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10");

  tx = await v.addBasketToken(WETH, 2500, ETH_USD_FEED, 8, 18, 0);
  console.log("  WETH tx:", tx.hash); await tx.wait();

  tx = await v.addBasketToken(GMX, 2000, GMX_USD_FEED, 8, 18, 0);
  console.log("  GMX tx:", tx.hash); await tx.wait();

  tx = await v.addBasketToken(PENDLE, 2000, PENDLE_USD_FEED, 8, 18, 0);
  console.log("  PENDLE tx:", tx.hash); await tx.wait();

  tx = await v.addBasketToken(LINK, 1500, LINK_USD_FEED, 8, 18, 0);
  console.log("  LINK tx:", tx.hash); await tx.wait();

  tx = await v.addBasketToken(XAUT0, 1000, XAU_USD_FEED, 8, 6, 259200);
  console.log("  XAUt0 tx:", tx.hash); await tx.wait();

  tx = await v.addBasketToken(USDC, 1000, ZERO_FEED, 0, 6, 0);
  console.log("  USDC tx:", tx.hash); await tx.wait();

  // ── 7. Sanity + persist ──
  console.log("\n[7/7] Sanity reads + persist");
  console.log("  yieldAdapter:", await v.yieldAdapter());
  console.log("  positionNFT: ", await v.positionNFT());
  console.log("  bonusAcc:    ", await v.bonusAccumulator());
  console.log("  basketLength:", (await v.basketLength()).toString());

  // Archive old Pool B and install new
  deployed.pools.B_morpho_deprecated = deployed.pools.B;
  deployed.pools.B = {
    label: "DeFi + RWA GMX",
    vault: vaultAddr,
    positionNFT: nftAddr,
    yieldSource: "gmx-v2-gm-eth-usdc",
    adapter: adapterAddr,
    gmMarket: GM_ETH_USDC,
    version: "v15.6",
    basket: "WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10",
    allocation: "40/60",
    gmxContracts: {
      exchangeRouter: GMX_EXCHANGE_ROUTER,
      syntheticsRouter: GMX_SYNTHETICS_ROUTER,
      depositVault: GMX_DEPOSIT_VAULT,
      withdrawalVault: GMX_WITHDRAWAL_VAULT,
    },
  };
  deployed.adapters.gmx_gm_eth_usdc = adapterAddr;

  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");

  console.log("\n═══ Pool B v6 (DeFi+RWA GMX) DEPLOYED ═══");
  console.log("  Adapter:  ", adapterAddr);
  console.log("  Vault:    ", vaultAddr);
  console.log("  NFT:      ", nftAddr);
  console.log("  GM Market:", GM_ETH_USDC);
  console.log("  Next: test with $5 deposit, then keeper pushToGmx");
}

main().catch((e) => { console.error(e); process.exit(1); });
