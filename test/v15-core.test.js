// ═══════════════════════════════════════════════════════════════════════
//  v15-core.test.js — deposit / withdraw / claim / compound / harvest
//
//  These are FORK tests — they require:
//    FORK_BLOCK=451185800 ARB_RPC=<rpc-url> npx hardhat test test/v15-core.test.js
//
//  Without FORK_BLOCK the whole describe block is skipped (graceful).
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const {
  addresses: A,
  fundUSDC,
  deployStack,
  usdcFor,
  advanceTime,
} = require("./helpers/setup");

const forking = Boolean(process.env.FORK_BLOCK);

(forking ? describe : describe.skip)("ShadowVaultV15 — core flows (Arbitrum fork)", function () {
  this.timeout(300_000);

  // Tier enum ordering must match contract
  const Tier = { FLEX: 0, THIRTY: 1, NINETY: 2, ONEIGHTY: 3, YEAR: 4 };

  let stack;
  let admin, alice, bob;
  let USDC;

  before(async function () {
    [admin, alice, bob] = await ethers.getSigners();
    stack = await deployStack(admin);
    USDC = await usdcFor(admin);
  });

  // Use a $10,000 deposit so 30-day Aave yield (~$33) comfortably clears the
  // $1 MIN_CLAIM threshold and the 1.2% withdraw fee is material enough to
  // meaningfully test the fee math.
  const DEPOSIT = ethers.parseUnits("10000", 6);

  it("deposit: mints NFT, stores position, routes yield leg to Aave", async function () {
    await fundUSDC(alice.address, DEPOSIT);

    const usdcAlice = await usdcFor(alice);
    await (await usdcAlice.approve(await stack.vaultA.getAddress(), DEPOSIT)).wait();

    const vaultAlice = stack.vaultA.connect(alice);
    await (await vaultAlice.deposit(DEPOSIT, Tier.FLEX)).wait();

    // NFT is at position 1
    const nftOwner = await stack.nftA.ownerOf(1);
    expect(nftOwner).to.equal(alice.address);

    const pos = await stack.vaultA.positions(1);
    expect(pos.depositAmount).to.equal(DEPOSIT);
    expect(pos.tier).to.equal(Tier.FLEX);

    // Yield leg: 30% to Aave. Adapter totalAssets should reflect ~$3000 USDC.
    const adapterAssets = await stack.aaveAdapter.totalAssets();
    expect(adapterAssets).to.be.gte(ethers.parseUnits("2999.99", 6));
    expect(adapterAssets).to.be.lte(ethers.parseUnits("3000.01", 6));

    // Total deposited counter updated
    expect(await stack.vaultA.totalDeposited()).to.equal(DEPOSIT);

    // Vault holds basket leg = $7000 as idle USDC
    const vaultUsdc = await USDC.balanceOf(await stack.vaultA.getAddress());
    expect(vaultUsdc).to.equal(ethers.parseUnits("7000", 6));

    // Bonus accumulator: position registered with weight = deposit (FLEX multiplier = 1x)
    const totalWeight = await stack.bonusAcc.totalWeight();
    expect(totalWeight).to.equal(DEPOSIT);
  });

  it("harvest: keeper claims accrued Aave interest, fee to treasury, rest redeposits", async function () {
    // Advance 30 days to let Aave interest accrue.
    await advanceTime(30 * 24 * 60 * 60);

    const treasuryBefore = await USDC.balanceOf(A.TREASURY);
    const adapterBefore = await stack.aaveAdapter.totalAssets();

    const tx = await stack.vaultA.connect(admin).harvestYield();
    const rcpt = await tx.wait();

    const treasuryAfter = await USDC.balanceOf(A.TREASURY);
    const adapterAfter = await stack.aaveAdapter.totalAssets();

    // Treasury should have received the 3% protocol fee on harvested profit.
    // $3000 deposited × ~4% APY × 30/365 days ≈ $10 raw profit.
    // Adapter's harvest skims 50% = ~$5 profit returned to vault.
    // Vault routes 3% = ~$0.15 to treasury, reinvests ~$4.85.
    expect(treasuryAfter).to.be.gt(treasuryBefore);

    // Principal is preserved: adapter still holds ≥ the original $3000 deposit
    // (half of the yield was skimmed as profit, half remains as a buffer,
    //  and the reinvested portion offsets most of the treasury fee).
    expect(adapterAfter).to.be.gte(ethers.parseUnits("3000", 6));
  });

  it("claimYield: FLEX user claims accrued yield proportional to their share", async function () {
    // Advance more time to accrue fresh yield AFTER harvest
    await advanceTime(30 * 24 * 60 * 60);

    const aliceUsdcBefore = await USDC.balanceOf(alice.address);
    const tx = await stack.vaultA.connect(alice).claimYield(1);
    const rcpt = await tx.wait();
    const aliceUsdcAfter = await USDC.balanceOf(alice.address);

    expect(aliceUsdcAfter).to.be.gt(aliceUsdcBefore);
  });

  it("requestWithdraw + completeWithdraw: full roundtrip returns USDC to user", async function () {
    const aliceUsdcBefore = await USDC.balanceOf(alice.address);

    // Block-level cooldown: roll forward one block from the most-recent deposit.
    await hre.network.provider.send("evm_mine", []);

    const req = await stack.vaultA.connect(alice).requestWithdraw(1);
    await req.wait();

    const pending = await stack.vaultA.pendingWithdraws(1);
    expect(pending.user).to.equal(alice.address);

    // Basket leg is 100% USDC (Pool A test config) so no keeper swaps needed.
    // Keeper can call completeWithdraw immediately.
    const comp = await stack.vaultA.connect(admin).completeWithdraw(1);
    await comp.wait();

    const aliceUsdcAfter = await USDC.balanceOf(alice.address);
    const received = aliceUsdcAfter - aliceUsdcBefore;

    // Alice deposited $10,000 → should get back ~$10,000 minus on-time fee
    // (1.2% = $120) plus accrued yield. Net should be > $9,850.
    expect(received).to.be.gt(ethers.parseUnits("9850", 6));
  });

  it("bonus accumulator: notify → pending increases → claim pays out", async function () {
    // Seed a new FLEX position for this test (Alice's first one is closed).
    const depositAmount = ethers.parseUnits("500", 6);
    await fundUSDC(bob.address, depositAmount);
    const usdcBob = await usdcFor(bob);
    await (await usdcBob.approve(await stack.vaultA.getAddress(), depositAmount)).wait();
    await (await stack.vaultA.connect(bob).deposit(depositAmount, Tier.FLEX)).wait();

    const posId = 2; // Bob's position

    // Grant admin NOTIFIER_ROLE so we can push funds (using adminNotifyBonus is easier).
    // Seed 10 USDC into the Bridge stream via adminNotifyBonus path.
    const notifyAmount = ethers.parseUnits("10", 6);
    await fundUSDC(admin.address, notifyAmount);
    const usdcAdmin = USDC;
    await (await usdcAdmin.approve(await stack.bonusAcc.getAddress(), notifyAmount)).wait();
    await (await stack.bonusAcc.adminNotifyBonus(0 /* STREAM_BRIDGE */, notifyAmount)).wait();

    // Bob should see pending accrual — since he's the only registered position, weight = his full deposit,
    // so pending ~= 10 USDC.
    const pending = await stack.bonusAcc.pendingForToken(posId);
    expect(pending).to.be.gt(ethers.parseUnits("9.9", 6));
    expect(pending).to.be.lte(ethers.parseUnits("10", 6));

    // Bob claims and gets paid.
    const bobBefore = await USDC.balanceOf(bob.address);
    await (await stack.bonusAcc.connect(bob).claim(posId)).wait();
    const bobAfter = await USDC.balanceOf(bob.address);
    expect(bobAfter - bobBefore).to.be.gte(ethers.parseUnits("9.9", 6));
  });
});
