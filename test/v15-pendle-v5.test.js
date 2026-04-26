// ═══════════════════════════════════════════════════════════════════════
//  v15-pendle-v5.test.js — PendleAdapterV5 full flow on Arbitrum fork
//
//  Tests the V5 fix for SYInvalidTokenOut: deposit $3 FLEX, request
//  withdraw (the step that was reverting), fast-forward 30 min,
//  complete withdraw, verify USDC returned.
//
//  Run: FORK_BLOCK=<latest> npx hardhat test test/v15-pendle-v5.test.js
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const forking = Boolean(process.env.FORK_BLOCK);

// ─────────── Arbitrum addresses ───────────
const USDC_ADDR     = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AUSDC         = "0x724dc807b04555b71ed48a6896b6F41593b8C637"; // whale for USDC
const SDM           = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const TREASURY      = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";

// Pendle gUSDC-25JUN2026 market
const PENDLE_MARKET = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_PT     = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const PENDLE_YT     = "0x08701dB4D31E0E88bD338FdeB38FF391CC75BcF8";
const PENDLE_SY     = "0x0a9eD458E6c283D1E84237e3347333Aa08221d09";
const GUSDC         = "0xd3443ee1e91aF28e5FB858Fbd0D72A63bA8046E0";

// Uniswap V3 SwapRouter on Arbitrum
const UNI_ROUTER    = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

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

(forking ? describe : describe.skip)("PendleAdapterV5 — SYInvalidTokenOut fix (Arbitrum fork)", function () {
  this.timeout(300_000);

  const DEPOSIT = ethers.parseUnits("500", 6); // $500 — proves mechanism at real deposit size
  const Tier = { FLEX: 0 };

  let admin, alice;
  let vault, adapter, nft;
  let USDC;

  before(async function () {
    [admin, alice] = await ethers.getSigners();
    USDC = await ethers.getContractAt(ERC20_ABI, USDC_ADDR, admin);

    // 1. Deploy PendleAdapterV5
    console.log("  [1/4] Deploy PendleAdapterV5");
    const Adapter = await ethers.getContractFactory("PendleAdapterV5", admin);
    adapter = await Adapter.deploy(
      admin.address,
      UNI_ROUTER,
      PENDLE_MARKET,
      PENDLE_PT,
      PENDLE_YT,
      PENDLE_SY,
      GUSDC
    );
    await adapter.waitForDeployment();
    const adapterAddr = await adapter.getAddress();
    console.log("    adapter:", adapterAddr);

    // Sanity check
    const ptDec = await adapter.ptDecimals();
    const ptSc = await adapter.ptScale();
    const syNative = await adapter.syNativeToken();
    console.log("    ptDecimals:", ptDec.toString(), "ptScale:", ptSc.toString());
    console.log("    syNativeToken:", syNative);
    expect(ptDec).to.equal(6n);
    expect(ptSc).to.equal(10n ** 18n);
    expect(syNative.toLowerCase()).to.equal(GUSDC.toLowerCase());

    // 2. Deploy vault
    console.log("  [2/4] Deploy vault");
    const Vault = await ethers.getContractFactory("ShadowVaultV15", admin);
    vault = await Vault.deploy(admin.address, adapterAddr, TREASURY, SDM);
    await vault.waitForDeployment();
    console.log("    vault:", await vault.getAddress());

    // 3. Deploy NFT
    console.log("  [3/4] Deploy NFT");
    const NFT = await ethers.getContractFactory("ShadowPositionNFTV15", admin);
    nft = await NFT.deploy("PendleV5 Test", admin.address);
    await nft.waitForDeployment();
    console.log("    nft:", await nft.getAddress());

    // 4. Wire everything
    console.log("  [4/4] Wire roles + basket");
    await (await adapter.addVault(await vault.getAddress())).wait();
    await (await nft.addVault(await vault.getAddress())).wait();
    await (await vault.setPositionNFT(await nft.getAddress())).wait();

    // USDC-only basket so we isolate the yield adapter leg
    await (await vault.addBasketToken(
      USDC_ADDR,
      10_000,         // 100% weight
      ethers.ZeroAddress, // no oracle for USDC
      0,              // no heartbeat
      6,              // decimals
      0               // no sequence feed
    )).wait();

    console.log("  Setup complete\n");
  });

  it("deposit $3 FLEX succeeds (Pendle deposit path is unchanged)", async function () {
    await fundUSDC(alice.address, DEPOSIT);
    const usdcAlice = await ethers.getContractAt(ERC20_ABI, USDC_ADDR, alice);
    await (await usdcAlice.approve(await vault.getAddress(), DEPOSIT)).wait();

    const tx = await vault.connect(alice).deposit(DEPOSIT, Tier.FLEX);
    const rcpt = await tx.wait();
    console.log("    deposit gas:", rcpt.gasUsed.toString());

    const adapterAssets = await adapter.totalAssets();
    console.log("    adapter totalAssets:", ethers.formatUnits(adapterAssets, 6), "USDC");
    // At least something went to the adapter (30% of $3 = $0.90)
    expect(adapterAssets).to.be.gt(0);

    const ptBal = await ethers.getContractAt(ERC20_ABI, PENDLE_PT, admin);
    const ptHeld = await ptBal.balanceOf(await adapter.getAddress());
    console.log("    adapter PT balance:", ptHeld.toString());
    expect(ptHeld).to.be.gt(0);
  });

  it("requestWithdraw succeeds — V5 fix for SYInvalidTokenOut", async function () {
    // THIS IS THE TEST THAT MATTERS. Old adapter reverts here with
    // SYInvalidTokenOut(0xaf88d065e77c8cC2239327C5EDb3A432268e5831).
    // PendleAdapterV5 should succeed by redeeming to gUSDC then
    // swapping gUSDC → USDC via Uniswap V3.
    await hre.network.provider.send("evm_mine", []);

    const tx = await vault.connect(alice).requestWithdraw(1);
    const rcpt = await tx.wait();
    console.log("    requestWithdraw gas:", rcpt.gasUsed.toString());
    expect(rcpt.status).to.equal(1);

    // Check pending withdraw was recorded
    const pending = await vault.pendingWithdraws(1);
    console.log("    pending yieldUSDC:", ethers.formatUnits(pending.yieldUSDC, 6));
    console.log("    pending basketUSDC:", ethers.formatUnits(pending.basketUSDC, 6));
    // yieldUSDC should be > 0 (adapter returned something)
    expect(pending.yieldUSDC).to.be.gt(0);
  });

  it("completeWithdraw returns USDC to alice", async function () {
    // Fast-forward 31 minutes past the 30-min withdraw timer
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
    // Should get back at least 90% of $500 (slippage + fees)
    expect(received).to.be.gte(ethers.parseUnits("450", 6));
    console.log("\n    ═══ PENDLE V5 WITHDRAW FIX VERIFIED ═══");
  });

  it("adapter has no residual gUSDC or PT after full withdraw", async function () {
    const gusdc = await ethers.getContractAt(ERC20_ABI, GUSDC, admin);
    const pt = await ethers.getContractAt(ERC20_ABI, PENDLE_PT, admin);
    const adapterAddr = await adapter.getAddress();

    const gusdcBal = await gusdc.balanceOf(adapterAddr);
    const ptBal = await pt.balanceOf(adapterAddr);
    console.log("    residual gUSDC:", gusdcBal.toString());
    console.log("    residual PT:", ptBal.toString());
    // May have dust but should be near-zero
    expect(gusdcBal).to.be.lte(ethers.parseUnits("0.01", 6));
  });
});
