// Continue Pool C v2 after deployer-ETH OOG blocked the vault deploy.
// PendleAdapter is already deployed — reuse it.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ADAPTER = "0xf2FB71e254503B9a667Aa0eD450ef19061B2be7F"; // already deployed
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
const WBTC   = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const GMX    = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const ARB    = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const PEPE   = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_USD_FEED    = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const BTC_USD_FEED    = "0x6ce185860a4963106506C203335A2910413708e9";
const GMX_USD_FEED    = "0xDB98056FecFff59D032aB628337A4887110df3dB";
const ARB_USD_FEED    = "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6";
const PENDLE_USD_FEED = "0x66853E19d73c0F9301fe099c324A1E9726953433";
const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const PEPE_PYTH_FEED  = "0x4153629e7cc3Cb7EcB3624F3B863822ffd004707";
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
  const ethBal = await ethers.provider.getBalance(signer.address);
  console.log("ETH:", ethers.formatEther(ethBal));

  console.log("\n[1/4] Deploy Pool C v2 vault (reuse existing adapter)");
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vault = await Vault.deploy(signer.address, ADAPTER, TREASURY, SDM_TOKEN);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("  ", vaultAddr, "tx:", vault.deploymentTransaction().hash);

  console.log("\n[2/4] Deploy Pool C v2 NFT");
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nft = await NFT.deploy("Full Spectrum Pendle", signer.address);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("  ", nftAddr, "tx:", nft.deploymentTransaction().hash);

  console.log("\n[3/4] Wire + basket");
  const adapter = new ethers.Contract(ADAPTER, ["function addVault(address)"], signer);
  const nftC = new ethers.Contract(nftAddr, ["function addVault(address)"], signer);
  const bonusC = new ethers.Contract(BONUS_V2_1, ["function addVault(address)"], signer);
  const vC = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  let tx;
  tx = await adapter.addVault(vaultAddr); await tx.wait(); console.log("  adapter.addVault");
  tx = await nftC.addVault(vaultAddr); await tx.wait(); console.log("  nft.addVault");
  tx = await bonusC.addVault(vaultAddr); await tx.wait(); console.log("  bonus.addVault");
  tx = await vC.setPositionNFT(nftAddr); await tx.wait(); console.log("  setPositionNFT");
  tx = await vC.setBonusAccumulator(BONUS_V2_1); await tx.wait(); console.log("  setBonusAcc");
  tx = await vC.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true); await tx.wait(); console.log("  trust 0xAH");
  tx = await vC.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true); await tx.wait(); console.log("  trust 1inch");
  tx = await vC.grantRole(ethers.id("KEEPER_ROLE"), signer.address); await tx.wait(); console.log("  grant KEEPER");

  tx = await vC.addBasketToken(WETH, 2500, ETH_USD_FEED, 8, 18, 0);      await tx.wait(); console.log("  WETH 25");
  tx = await vC.addBasketToken(WBTC, 1500, BTC_USD_FEED, 8, 8, 0);       await tx.wait(); console.log("  WBTC 15");
  tx = await vC.addBasketToken(GMX, 1500, GMX_USD_FEED, 8, 18, 0);       await tx.wait(); console.log("  GMX 15");
  tx = await vC.addBasketToken(ARB, 1500, ARB_USD_FEED, 8, 18, 0);       await tx.wait(); console.log("  ARB 15");
  tx = await vC.addBasketToken(PENDLE, 1000, PENDLE_USD_FEED, 8, 18, 0); await tx.wait(); console.log("  PENDLE 10");
  tx = await vC.addBasketToken(LINK, 1000, LINK_USD_FEED, 8, 18, 0);     await tx.wait(); console.log("  LINK 10");
  tx = await vC.addBasketToken(PEPE, 500, PEPE_PYTH_FEED, 8, 18, 3600);  await tx.wait(); console.log("  PEPE 5");
  tx = await vC.addBasketToken(USDC, 500, ZERO_FEED, 0, 6, 0);           await tx.wait(); console.log("  USDC 5");

  console.log("\n[4/4] Persist");
  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  if (deployed.pools.C && deployed.pools.C.yieldSource === "fluid") {
    deployed.pools.C_fluid_deprecated = { ...deployed.pools.C, note: "v15.2 Fluid — superseded by Pool C v2 Pendle 2026-04-11" };
  }
  deployed.pools.C = {
    label: "Full Spectrum Pendle",
    vault: vaultAddr,
    positionNFT: nftAddr,
    yieldSource: "pendle",
    adapter: ADAPTER,
    version: "v15.4-c2",
    pendleMarket: PENDLE_MARKET,
    pendlePt: PENDLE_PT,
    pendleYt: PENDLE_YT,
    pendleSy: PENDLE_SY,
    ptDecimals: 6,
    ptScale: "1000000000000000000",
    pendleMaturity: "2026-06-25T00:00:00Z",
    basket: "WETH 25 / WBTC 15 / GMX 15 / ARB 15 / PENDLE 10 / LINK 10 / PEPE 5 / USDC 5",
  };
  deployed.adapters.pendle_c = ADAPTER;
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("basketLength:", (await vC.basketLength()).toString());

  console.log("\n═══ Pool C v2 Pendle complete ═══");
  console.log("  vault:", vaultAddr, "adapter:", ADAPTER);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
