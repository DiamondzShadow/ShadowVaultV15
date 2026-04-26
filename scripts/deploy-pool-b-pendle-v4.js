// Pool B v4 — decimal-aware PendleAdapter
// PT-gUSDC is 6-dec, not 18-dec. Adapter now queries IERC20Metadata(pt).decimals()
// and computes ptScale = 10^(ptDecimals + 12). Fixes the 1e12 overcount bug.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
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

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function grantRole(bytes32,address) external",
  "function basketLength() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const PendleAdapter = await ethers.getContractFactory("PendleAdapter");
  console.log("\n[1/5] Deploy PendleAdapter v4");
  const adapter = await PendleAdapter.deploy(signer.address, PENDLE_MARKET, PENDLE_PT, PENDLE_YT, PENDLE_SY);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("  ", adapterAddr, "tx:", adapter.deploymentTransaction().hash);

  // Sanity check: ptDecimals and ptScale
  const [ptDec, ptSc] = await Promise.all([
    adapter.ptDecimals(),
    adapter.ptScale(),
  ]);
  console.log("   ptDecimals:", ptDec.toString(), "(expect 6)");
  console.log("   ptScale:   ", ptSc.toString(), "(expect 1000000000000000000 = 1e18)");
  if (ptDec != 6n || ptSc != 10n ** 18n) throw new Error("decimal fix didn't stick");

  console.log("\n[2/5] Deploy Pool B v4 vault");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vault = await Vault.deploy(signer.address, adapterAddr, TREASURY, SDM_TOKEN);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("  ", vaultAddr, "tx:", vault.deploymentTransaction().hash);

  console.log("\n[3/5] Deploy Pool B v4 NFT");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nft = await NFT.deploy("DeFi + RWA", signer.address);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("  ", nftAddr, "tx:", nft.deploymentTransaction().hash);

  console.log("\n[4/5] Wire roles + settings");
  let tx;
  tx = await adapter.addVault(vaultAddr); await tx.wait(); console.log("  adapter.addVault");
  const nftC = new ethers.Contract(nftAddr, ["function addVault(address)"], signer);
  tx = await nftC.addVault(vaultAddr); await tx.wait(); console.log("  nft.addVault");
  const bonusC = new ethers.Contract(BONUS_V2_1, ["function addVault(address)"], signer);
  tx = await bonusC.addVault(vaultAddr); await tx.wait(); console.log("  bonus.addVault");
  const vC = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
  tx = await vC.setPositionNFT(nftAddr); await tx.wait(); console.log("  setPositionNFT");
  tx = await vC.setBonusAccumulator(BONUS_V2_1); await tx.wait(); console.log("  setBonusAccumulator");
  tx = await vC.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true); await tx.wait(); console.log("  trust 0xAllowanceHolder");
  tx = await vC.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true); await tx.wait(); console.log("  trust 1inch");
  tx = await vC.grantRole(ethers.id("KEEPER_ROLE"), signer.address); await tx.wait(); console.log("  grant KEEPER");

  tx = await vC.addBasketToken(WETH, 2500, ETH_USD_FEED, 8, 18, 0); await tx.wait(); console.log("  basket WETH 25");
  tx = await vC.addBasketToken(GMX, 2000, GMX_USD_FEED, 8, 18, 0); await tx.wait(); console.log("  basket GMX 20");
  tx = await vC.addBasketToken(PENDLE, 2000, PENDLE_USD_FEED, 8, 18, 0); await tx.wait(); console.log("  basket PENDLE 20");
  tx = await vC.addBasketToken(LINK, 1500, LINK_USD_FEED, 8, 18, 0); await tx.wait(); console.log("  basket LINK 15");
  tx = await vC.addBasketToken(XAUT0, 1000, XAU_USD_FEED, 8, 6, 259200); await tx.wait(); console.log("  basket XAUt0 10");
  tx = await vC.addBasketToken(USDC, 1000, ZERO_FEED, 0, 6, 0); await tx.wait(); console.log("  basket USDC 10");

  console.log("\n[5/5] Persist");
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  if (deployed.pools.B && deployed.pools.B.adapter !== adapterAddr) {
    deployed.pools.B_pendle_v3_wrong_decimals = deployed.pools.B;
    deployed.pools.B_pendle_v3_wrong_decimals.note = "v3 adapter hardcoded 1e30 assuming 18-dec PT, but PT-gUSDC is 6-dec. Deposit would overshoot minPtOut by 1e12. Replaced by v4.";
  }
  deployed.pools.B = {
    label: "DeFi + RWA Pendle",
    vault: vaultAddr,
    positionNFT: nftAddr,
    yieldSource: "pendle",
    adapter: adapterAddr,
    version: "v15.4-v4",
    pendleMarket: PENDLE_MARKET,
    pendlePt: PENDLE_PT,
    pendleYt: PENDLE_YT,
    pendleSy: PENDLE_SY,
    ptDecimals: Number(ptDec),
    ptScale: ptSc.toString(),
    pendleMaturity: "2026-06-25T00:00:00Z",
    basket: "WETH 25 / GMX 20 / PENDLE 20 / LINK 15 / XAUt0 10 / USDC 10",
  };
  deployed.adapters.pendle_b = adapterAddr;
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("basketLength:", (await vC.basketLength()).toString());

  console.log("\n═══ Pool B v4 deployed ═══");
  console.log("  PendleAdapter v4:", adapterAddr);
  console.log("  Pool B v4 vault: ", vaultAddr);
  console.log("  Pool B v4 NFT:   ", nftAddr);
}

main().catch((e) => { console.error(e); process.exit(1); });
