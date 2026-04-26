// ═══════════════════════════════════════════════════════════════════════
//  test/helpers/setup.js — fork-test helpers for ShadowVaultV15
//
//  Deploys the full V15 stack against an Arbitrum mainnet fork,
//  funds test users with USDC by impersonating the aUSDC contract
//  (which holds ~$91M of real USDC custody on Arbitrum), and exposes
//  helper constants and utility functions used across test files.
// ═══════════════════════════════════════════════════════════════════════

const hre = require("hardhat");
const { ethers } = hre;

// ─────────── Arbitrum addresses ───────────
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AUSDC = "0x724dc807b04555b71ed48a6896b6F41593b8C637"; // Aave V3 aUSDC — ~$91M USDC custody
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const AWETH = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8"; // Aave V3 aWETH — ~26k WETH custody
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const AWBTC = "0x078f358208685046a11C85e8ad32895DED33A249"; // Aave V3 aWBTC — ~2.7k WBTC custody
const SDM = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const TREASURY = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const BTC_USD_FEED = "0x6ce185860a4963106506C203335A2910413708e9";
const SEQUENCER_FEED = "0xFdB631F5EE196F0ed6FAa767959853A9F217697D";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

/// Impersonate an account and fund it with ETH for gas.
async function impersonate(address) {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000", // 1000 ETH
  ]);
  return await ethers.getSigner(address);
}

/// Transfer USDC from the aUSDC contract (which has ~$91M custody) to a recipient.
async function fundUSDC(recipient, amount) {
  const whale = await impersonate(AUSDC);
  const usdc = await ethers.getContractAt(ERC20_ABI, USDC, whale);
  await usdc.transfer(recipient, amount);
}

/// Transfer WETH from the aWETH contract to a recipient.
async function fundWETH(recipient, amount) {
  const whale = await impersonate(AWETH);
  const weth = await ethers.getContractAt(ERC20_ABI, WETH, whale);
  await weth.transfer(recipient, amount);
}

/// Transfer WBTC from the aWBTC contract to a recipient.
async function fundWBTC(recipient, amount) {
  const whale = await impersonate(AWBTC);
  const wbtc = await ethers.getContractAt(ERC20_ABI, WBTC, whale);
  await wbtc.transfer(recipient, amount);
}

/// Deploy a V15 vault bound to a specific yield adapter. Used by the
/// adapter-specific fork tests to exercise Fluid / Silo end-to-end.
/// The basket is configured as USDC-only so we only test the yield leg.
async function deployVaultWithAdapter(adminSigner, adapterContractName, poolLabel) {
  const admin = adminSigner.address;

  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15", adminSigner);
  const nft = await NFT.deploy(poolLabel, admin);
  await nft.waitForDeployment();

  const Adapter = await ethers.getContractFactory(adapterContractName, adminSigner);
  const adapter = await Adapter.deploy(admin);
  await adapter.waitForDeployment();

  const Vault = await ethers.getContractFactory("ShadowVaultV15", adminSigner);
  const vault = await Vault.deploy(admin, await adapter.getAddress(), TREASURY, SDM);
  await vault.waitForDeployment();

  await (await adapter.addVault(await vault.getAddress())).wait();
  await (await nft.addVault(await vault.getAddress())).wait();
  await (await vault.setPositionNFT(await nft.getAddress())).wait();

  // USDC-only basket for yield-adapter tests.
  await (await vault.addBasketToken(USDC, 10_000, ethers.ZeroAddress, 0, 6, 0)).wait();

  return { vault, adapter, nft };
}

/// Deploy the V15 stack WITHOUT adding any basket tokens. The caller is
/// responsible for configuring the basket (single-token, multi-token, etc.).
async function deployStackNoBasket(adminSigner) {
  const admin = adminSigner.address;

  const SDMOracle = await ethers.getContractFactory("SDMDiscountOracle", adminSigner);
  const sdmOracle = await SDMOracle.deploy(admin, ethers.parseUnits("10000", 18));
  await sdmOracle.waitForDeployment();

  const RevenueRouter = await ethers.getContractFactory("RevenueRouter", adminSigner);
  const revenueRouter = await RevenueRouter.deploy(admin, TREASURY, TREASURY);
  await revenueRouter.waitForDeployment();

  const BonusAcc = await ethers.getContractFactory("BonusAccumulator", adminSigner);
  const bonusAcc = await BonusAcc.deploy(admin);
  await bonusAcc.waitForDeployment();

  const AaveAdapter = await ethers.getContractFactory("AaveAdapterV5", adminSigner);
  const aaveAdapter = await AaveAdapter.deploy(admin);
  await aaveAdapter.waitForDeployment();

  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15", adminSigner);
  const nftA = await NFT.deploy("Blue Chip", admin);
  await nftA.waitForDeployment();

  const Vault = await ethers.getContractFactory("ShadowVaultV15", adminSigner);
  const vaultA = await Vault.deploy(
    admin,
    await aaveAdapter.getAddress(),
    TREASURY,
    SDM,
  );
  await vaultA.waitForDeployment();

  await (await aaveAdapter.addVault(await vaultA.getAddress())).wait();
  await (await nftA.addVault(await vaultA.getAddress())).wait();
  await (await vaultA.setPositionNFT(await nftA.getAddress())).wait();
  await (await vaultA.setBonusAccumulator(await bonusAcc.getAddress())).wait();
  await (await nftA.setBonusAccumulator(await bonusAcc.getAddress())).wait();
  await (await bonusAcc.addVault(await vaultA.getAddress())).wait();
  await (await revenueRouter.addAuthorized(await vaultA.getAddress())).wait();

  const MockSwapper = await ethers.getContractFactory("MockSwapper", adminSigner);
  const mockSwapper = await MockSwapper.deploy();
  await mockSwapper.waitForDeployment();
  await (await vaultA.setTrustedSwapTarget(await mockSwapper.getAddress(), true)).wait();

  return { admin, sdmOracle, revenueRouter, bonusAcc, aaveAdapter, nftA, vaultA, mockSwapper };
}

/// Deploy the full V15 stack on the forked chain.
async function deployStack(adminSigner) {
  const admin = adminSigner.address;

  const SDMOracle = await ethers.getContractFactory("SDMDiscountOracle", adminSigner);
  const sdmOracle = await SDMOracle.deploy(admin, ethers.parseUnits("10000", 18));
  await sdmOracle.waitForDeployment();

  const RevenueRouter = await ethers.getContractFactory("RevenueRouter", adminSigner);
  // Treasury as seeder placeholder — SDMDODOSeeder not involved in tests
  const revenueRouter = await RevenueRouter.deploy(admin, TREASURY, TREASURY);
  await revenueRouter.waitForDeployment();

  const BonusAcc = await ethers.getContractFactory("BonusAccumulator", adminSigner);
  const bonusAcc = await BonusAcc.deploy(admin);
  await bonusAcc.waitForDeployment();

  const AaveAdapter = await ethers.getContractFactory("AaveAdapterV5", adminSigner);
  const aaveAdapter = await AaveAdapter.deploy(admin);
  await aaveAdapter.waitForDeployment();

  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15", adminSigner);
  const nftA = await NFT.deploy("Blue Chip", admin);
  await nftA.waitForDeployment();

  const Vault = await ethers.getContractFactory("ShadowVaultV15", adminSigner);
  const vaultA = await Vault.deploy(
    admin,
    await aaveAdapter.getAddress(),
    TREASURY,
    SDM,
  );
  await vaultA.waitForDeployment();

  // Wire adapter + NFT roles
  await (await aaveAdapter.addVault(await vaultA.getAddress())).wait();
  await (await nftA.addVault(await vaultA.getAddress())).wait();
  await (await vaultA.setPositionNFT(await nftA.getAddress())).wait();
  await (await vaultA.setBonusAccumulator(await bonusAcc.getAddress())).wait();
  await (await nftA.setBonusAccumulator(await bonusAcc.getAddress())).wait();
  await (await bonusAcc.addVault(await vaultA.getAddress())).wait();
  await (await revenueRouter.addAuthorized(await vaultA.getAddress())).wait();

  // Deploy MockSwapper and whitelist it
  const MockSwapper = await ethers.getContractFactory("MockSwapper", adminSigner);
  const mockSwapper = await MockSwapper.deploy();
  await mockSwapper.waitForDeployment();
  await (await vaultA.setTrustedSwapTarget(await mockSwapper.getAddress(), true)).wait();

  // Pool A basket: USDC-only (100%) for simple roundtrip tests — avoids needing
  // WETH/WBTC whale impersonation. WETH/WBTC tests are in their own describe block.
  await (await vaultA.addBasketToken(USDC, 10_000, ethers.ZeroAddress, 0, 6, 0)).wait();

  return {
    admin,
    sdmOracle,
    revenueRouter,
    bonusAcc,
    aaveAdapter,
    nftA,
    vaultA,
    mockSwapper,
  };
}

/// Get a USDC contract handle for any signer.
function usdcFor(signer) {
  return ethers.getContractAt(ERC20_ABI, USDC, signer);
}

/// Advance time by N seconds AND mine a block. Hardhat doesn't auto-mine
/// after evm_increaseTime, so we always pair them.
async function advanceTime(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}

module.exports = {
  addresses: { USDC, AUSDC, WETH, AWETH, WBTC, AWBTC, SDM, TREASURY, ETH_USD_FEED, BTC_USD_FEED, SEQUENCER_FEED },
  ERC20_ABI,
  impersonate,
  fundUSDC,
  fundWETH,
  fundWBTC,
  deployStack,
  deployStackNoBasket,
  deployVaultWithAdapter,
  usdcFor,
  advanceTime,
};
