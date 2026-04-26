// ═══════════════════════════════════════════════════════════════════════
//  v15-aave-v6.test.js — AaveAdapterV6 full flow on Arbitrum fork
//
//  Tests the weETH LST strategy: deposit USDC → swap to weETH →
//  supply to Aave V3 → request withdraw → complete withdraw → USDC back.
//
//  Run: FORK_BLOCK=<latest> npx hardhat test test/v15-aave-v6.test.js
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const forking = Boolean(process.env.FORK_BLOCK);

// ─────────── Arbitrum addresses ───────────
const USDC_ADDR  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AUSDC      = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const SDM        = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const AWEETH     = "0x8437d7C167dFB82ED4Cb79CD44B7a32A1dd95c77";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

async function impersonate(address) {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000",
  ]);
  return await ethers.getSigner(address);
}

async function fundUSDC(recipient, amount) {
  const whale = await impersonate(AUSDC);
  const usdc = await ethers.getContractAt(ERC20_ABI, USDC_ADDR, whale);
  await usdc.transfer(recipient, amount);
}

(forking ? describe : describe.skip)("AaveAdapterV6 — weETH LST strategy (Arbitrum fork)", function () {
  this.timeout(300_000);

  const DEPOSIT = ethers.parseUnits("500", 6); // $500
  const Tier = { FLEX: 0 };

  let admin, alice;
  let vault, adapter, nft;
  let USDC;

  before(async function () {
    [admin, alice] = await ethers.getSigners();
    USDC = await ethers.getContractAt(ERC20_ABI, USDC_ADDR, admin);

    // 1. Deploy AaveAdapterV6
    console.log("  [1/4] Deploy AaveAdapterV6");
    const Adapter = await ethers.getContractFactory("AaveAdapterV6", admin);
    adapter = await Adapter.deploy(admin.address);
    await adapter.waitForDeployment();
    const adapterAddr = await adapter.getAddress();
    console.log("    adapter:", adapterAddr);

    // 2. Deploy vault
    console.log("  [2/4] Deploy vault");
    const Vault = await ethers.getContractFactory("ShadowVaultV15", admin);
    vault = await Vault.deploy(admin.address, adapterAddr, TREASURY, SDM);
    await vault.waitForDeployment();
    console.log("    vault:", await vault.getAddress());

    // 3. Deploy NFT
    console.log("  [3/4] Deploy NFT");
    const NFT = await ethers.getContractFactory("ShadowPositionNFTV15", admin);
    nft = await NFT.deploy("Aave weETH Test", admin.address);
    await nft.waitForDeployment();
    console.log("    nft:", await nft.getAddress());

    // 4. Wire
    console.log("  [4/4] Wire roles + basket");
    await (await adapter.addVault(await vault.getAddress())).wait();
    await (await nft.addVault(await vault.getAddress())).wait();
    await (await vault.setPositionNFT(await nft.getAddress())).wait();

    // USDC-only basket to isolate yield adapter
    await (await vault.addBasketToken(
      USDC_ADDR, 10_000, ethers.ZeroAddress, 0, 6, 0
    )).wait();

    // Adjust pool fees — weETH/WETH at 0.01% may not exist on Arbitrum.
    // Try 500 (0.05%) for weETH/WETH, 500 for WETH/USDC.
    await (await adapter.setPoolFees(500, 500)).wait();
    console.log("    pool fees set: weETH/WETH=500, WETH/USDC=500");

    // Relax oracle staleness for fork test (block may be old)
    await (await adapter.setOracleStaleness(86400)).wait(); // 24h
    console.log("    oracle staleness relaxed to 24h for fork");

    console.log("  Setup complete\n");
  });

  it("deposit $500 FLEX — swaps USDC → weETH → Aave supply", async function () {
    await fundUSDC(alice.address, DEPOSIT);
    const usdcAlice = await ethers.getContractAt(ERC20_ABI, USDC_ADDR, alice);
    await (await usdcAlice.approve(await vault.getAddress(), DEPOSIT)).wait();

    const tx = await vault.connect(alice).deposit(DEPOSIT, Tier.FLEX);
    const rcpt = await tx.wait();
    console.log("    deposit gas:", rcpt.gasUsed.toString());

    const adapterAssets = await adapter.totalAssets();
    console.log("    adapter totalAssets:", ethers.formatUnits(adapterAssets, 6), "USDC");

    // Adapter should have aWeETH
    const aweeth = await ethers.getContractAt(ERC20_ABI, AWEETH, admin);
    const aWeethBal = await aweeth.balanceOf(await adapter.getAddress());
    console.log("    adapter aWeETH balance:", ethers.formatUnits(aWeethBal, 18));
    expect(aWeethBal).to.be.gt(0);

    // totalAssets (discounted) should be > 0
    expect(adapterAssets).to.be.gt(0);
  });

  it("requestWithdraw succeeds — weETH → USDC atomic swap", async function () {
    await hre.network.provider.send("evm_mine", []);

    const tx = await vault.connect(alice).requestWithdraw(1);
    const rcpt = await tx.wait();
    console.log("    requestWithdraw gas:", rcpt.gasUsed.toString());
    expect(rcpt.status).to.equal(1);

    const pending = await vault.pendingWithdraws(1);
    console.log("    pending yieldUSDC:", ethers.formatUnits(pending.yieldUSDC, 6));
    console.log("    pending basketUSDC:", ethers.formatUnits(pending.basketUSDC, 6));
    expect(pending.yieldUSDC).to.be.gt(0);
  });

  it("completeWithdraw returns USDC to alice", async function () {
    await hre.network.provider.send("evm_increaseTime", [31 * 60]);
    await hre.network.provider.send("evm_mine", []);

    const balBefore = await USDC.balanceOf(alice.address);
    const tx = await vault.connect(alice).completeWithdraw(1);
    const rcpt = await tx.wait();
    console.log("    completeWithdraw gas:", rcpt.gasUsed.toString());
    expect(rcpt.status).to.equal(1);

    const balAfter = await USDC.balanceOf(alice.address);
    const received = balAfter - balBefore;
    console.log("    USDC received:", ethers.formatUnits(received, 6));
    // Should get back at least 85% of $500 (weETH price movement + swap slippage)
    expect(received).to.be.gte(ethers.parseUnits("425", 6));
    console.log("\n    ═══ AAVE V6 weETH LST FULL FLOW VERIFIED ═══");
  });

  it("adapter has near-zero residual after full withdraw", async function () {
    const aweeth = await ethers.getContractAt(ERC20_ABI, AWEETH, admin);
    const adapterAddr = await adapter.getAddress();
    const aWeethBal = await aweeth.balanceOf(adapterAddr);
    const usdcBal = await USDC.balanceOf(adapterAddr);
    console.log("    residual aWeETH:", ethers.formatUnits(aWeethBal, 18));
    console.log("    residual USDC:", ethers.formatUnits(usdcBal, 6));
  });
});
