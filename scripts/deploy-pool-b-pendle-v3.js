// Pool B v3 — retry with the SAME Pendle market but a new PendleAdapter
// that has MAX_SLIPPAGE_BPS=3000 (30%) and default slippageBps=1500 (15%).
//
// Why: Pool B v2 deployed cleanly but deposit failed with
// "Slippage: INSUFFICIENT_PT_OUT" even at the hard 5% cap. Reason is
// that tiny PT-gUSDC trades ($5) hit three stacking costs:
//   (1) SY exchangeRate conversion (1 SY ≈ 1.288 gUSDC) — the oracle
//       returns gUSDC/PT, not USDC/PT, so there's an extra layer
//   (2) Pendle AMM swap fee (1-2% typical)
//   (3) Curve price impact near zero-trade edge
// Stacked, a $5 deposit can eat 10-15% slippage which exceeds the 5% cap.
//
// v3 raises the cap and the default. Since yieldAdapter is immutable,
// Pool B v2 vault is a sunk cost. Marking it B_pendle_v2_broken and
// replacing with v3 as the canonical B.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Same Pendle market (cardinality already bumped, reuse)
const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";

const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

const WETH   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const GMX    = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_USD_FEED    = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const GMX_USD_FEED    = "0xDB98056FecFff59D032aB628337A4887110df3dB";
const PENDLE_USD_FEED = "0x66853E19d73c0F9301fe099c324A1E9726953433";
const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const XAU_USD_FEED    = "0x587b3499d3234a93CCC411e945295e3735BBb6a4";
const ZERO_FEED       = "0x0000000000000000000000000000000000000000";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address token, uint256 weightBps, address priceFeed, uint8 feedDecimals, uint8 tokenDecimals, uint32 maxStalenessSecs) external",
  "function grantRole(bytes32,address) external",
  "function yieldAdapter() view returns (address)",
  "function basketLength() view returns (uint256)",
];
const NFT_ABI   = ["function addVault(address) external"];
const BONUS_ABI = ["function addVault(address) external"];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  console.log("\n── [1/6] Deploying PendleAdapter v3 (30% max slippage) ──");
  const PendleAdapter = await ethers.getContractFactory("PendleAdapter");
  const adapter = await PendleAdapter.deploy(
    signer.address, PENDLE_MARKET, PENDLE_PT, PENDLE_YT, PENDLE_SY
  );
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("PendleAdapter v3:", adapterAddr, "tx:", adapter.deploymentTransaction().hash);

  console.log("\n── [2/6] Deploying Pool B v3 vault ──");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vaultB = await Vault.deploy(signer.address, adapterAddr, TREASURY, SDM_TOKEN);
  await vaultB.waitForDeployment();
  const vaultBAddr = await vaultB.getAddress();
  console.log("Pool B v3 vault:", vaultBAddr, "tx:", vaultB.deploymentTransaction().hash);

  console.log("\n── [3/6] Deploying Pool B v3 NFT ──");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nftB = await NFT.deploy("DeFi + RWA", signer.address);
  await nftB.waitForDeployment();
  const nftBAddr = await nftB.getAddress();
  console.log("Pool B v3 NFT:", nftBAddr, "tx:", nftB.deploymentTransaction().hash);

  console.log("\n── [4/6] Roles + settings ──");
  let tx;
  const nft = new ethers.Contract(nftBAddr, NFT_ABI, signer);
  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  const vault = new ethers.Contract(vaultBAddr, VAULT_ABI, signer);

  tx = await adapter.addVault(vaultBAddr);     console.log("adapter.addVault:", tx.hash); await tx.wait();
  tx = await nft.addVault(vaultBAddr);          console.log("nft.addVault:    ", tx.hash); await tx.wait();
  tx = await bonus.addVault(vaultBAddr);        console.log("bonus.addVault:  ", tx.hash); await tx.wait();
  tx = await vault.setPositionNFT(nftBAddr);    console.log("setPositionNFT:  ", tx.hash); await tx.wait();
  tx = await vault.setBonusAccumulator(BONUS_V2_1); console.log("setBonusAcc:    ", tx.hash); await tx.wait();
  tx = await vault.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true); console.log("trust 0xAllowanceHolder:", tx.hash); await tx.wait();
  tx = await vault.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);         console.log("trust 1inch v5:        ", tx.hash); await tx.wait();
  tx = await vault.setTrustedSwapTarget(ZEROX_LEGACY_EP, true);           console.log("trust 0x legacy:       ", tx.hash); await tx.wait();
  tx = await vault.grantRole(KEEPER_ROLE_HASH, signer.address);           console.log("grant KEEPER:          ", tx.hash); await tx.wait();

  console.log("\n── [5/6] Basket (DeFi+RWA same as before) ──");
  tx = await vault.addBasketToken(WETH, 2500, ETH_USD_FEED, 8, 18, 0);       console.log("WETH   25%:", tx.hash); await tx.wait();
  tx = await vault.addBasketToken(GMX, 2000, GMX_USD_FEED, 8, 18, 0);        console.log("GMX    20%:", tx.hash); await tx.wait();
  tx = await vault.addBasketToken(PENDLE, 2000, PENDLE_USD_FEED, 8, 18, 0);  console.log("PENDLE 20%:", tx.hash); await tx.wait();
  tx = await vault.addBasketToken(LINK, 1500, LINK_USD_FEED, 8, 18, 0);      console.log("LINK   15%:", tx.hash); await tx.wait();
  tx = await vault.addBasketToken(XAUT0, 1000, XAU_USD_FEED, 8, 6, 259200);  console.log("XAUt0  10%:", tx.hash); await tx.wait();
  tx = await vault.addBasketToken(USDC, 1000, ZERO_FEED, 0, 6, 0);           console.log("USDC   10%:", tx.hash); await tx.wait();

  console.log("\n── [6/6] Persist ──");
  console.log("basketLength:", (await vault.basketLength()).toString());

  // Deprecate v2 broken Pool B, install v3 as canonical
  if (deployed.pools.B && deployed.pools.B.version === "v15.4" && deployed.pools.B.yieldSource === "pendle") {
    deployed.pools.B_pendle_v2_broken = {
      ...deployed.pools.B,
      note: "Pool B v2 Pendle — deposit fails INSUFFICIENT_PT_OUT at 5% max slippage. Replaced by v3 with 30% slippage cap. yieldAdapter immutable so vault can't be saved.",
    };
  }
  deployed.pools.B = {
    label: "DeFi + RWA Pendle",
    vault: vaultBAddr,
    positionNFT: nftBAddr,
    yieldSource: "pendle",
    adapter: adapterAddr,
    version: "v15.4-v3",
    pendleMarket: PENDLE_MARKET,
    pendlePt:     PENDLE_PT,
    pendleYt:     PENDLE_YT,
    pendleSy:     PENDLE_SY,
    pendleMaturity: "2026-06-25T00:00:00Z",
    slippageConfig: "max=3000bps default=1500bps (raised from 500/50 for tiny-trade compatibility)",
    basket: "WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10",
  };
  deployed.adapters.pendle_b = adapterAddr;
  deployed.v15_4AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated");

  console.log("\n═══ Pool B v3 deployment complete ═══");
  console.log("  PendleAdapter v3:", adapterAddr);
  console.log("  Pool B v3 vault: ", vaultBAddr);
  console.log("  Pool B v3 NFT:   ", nftBAddr);
}

main().catch((e) => { console.error(e); process.exit(1); });
