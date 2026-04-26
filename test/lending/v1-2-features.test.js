// LendingPool v1.2: auto-pull from sweep on borrow + per-collection APR.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;

describe("LendingPool v1.2 — auto-pull + per-collection APR", function () {
  this.timeout(60_000);

  let admin, treasury, project, alice, bob, carol, keeper;
  let usdc, ausdc, aave;
  let registry, vault, nft, pool, aaveSink, mirror, sweep;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, carol, keeper] = await ethers.getSigners();

    const U  = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

    const AU = await ethers.getContractFactory("MockAUsdc");
    ausdc = await AU.deploy();
    await ausdc.waitForDeployment();

    const AP = await ethers.getContractFactory("MockAavePool");
    aave = await AP.deploy(await usdc.getAddress(), await ausdc.getAddress());
    await aave.waitForDeployment();

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);
    await registry.waitForDeployment();

    const V = await ethers.getContractFactory("MockPositionVault");
    vault = await V.deploy(await usdc.getAddress());
    await vault.waitForDeployment();

    const N = await ethers.getContractFactory("MockPositionNFT");
    nft = await N.deploy("MP", "MP", await vault.getAddress());
    await nft.waitForDeployment();

    const L = await ethers.getContractFactory("LendingPool");
    pool = await L.deploy(admin.address, await usdc.getAddress(), await registry.getAddress());
    await pool.waitForDeployment();

    const AS = await ethers.getContractFactory("AaveV3Sink");
    aaveSink = await AS.deploy(admin.address, admin.address, await usdc.getAddress(), await ausdc.getAddress(), await aave.getAddress());
    await aaveSink.waitForDeployment();

    const MR = await ethers.getContractFactory("HyperRemoteMirror");
    mirror = await MR.deploy(admin.address, admin.address, keeper.address, await usdc.getAddress(), keeper.address);
    await mirror.waitForDeployment();

    const SC = await ethers.getContractFactory("SweepController");
    sweep = await SC.deploy(admin.address, keeper.address, await usdc.getAddress(), await aaveSink.getAddress(), await mirror.getAddress());
    await sweep.waitForDeployment();

    // Wire roles: sweep controller can call into sinks.
    await (await aaveSink.connect(admin).grantRole(await aaveSink.CONTROLLER_ROLE(), await sweep.getAddress())).wait();
    await (await mirror.connect(admin).grantRole(await mirror.CONTROLLER_ROLE(), await sweep.getAddress())).wait();
    // Pool ↔ Sweep wiring
    await (await sweep.connect(admin).setLendingPool(await pool.getAddress())).wait();
    await (await pool.connect(admin).setSweepSink(await sweep.getAddress())).wait();

    // Fund
    for (const u of [project, alice, bob, carol]) {
      await (await usdc.mint(u.address, 100_000n * ONE_USDC)).wait();
      await (await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    await (await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000)).wait();

    await (await nft.mint(bob.address)).wait();
    await (await vault.setValue(1n, 1_000n * ONE_USDC)).wait();
    await (await nft.connect(bob).setApprovalForAll(await pool.getAddress(), true)).wait();
  });

  /* ────────── auto-pull on borrow ────────── */

  describe("borrow auto-pulls from sweep when idle insufficient", function () {
    it("idle=0, sweep has $5000 in Aave → borrow $400 succeeds via auto-pull", async function () {
      // Pool has 0 idle USDC. Seed sweep controller with 5000 idle, then rebalance →
      // 50% to Aave = 2500, controller keeps 2500 idle for reserve buffer.
      await (await usdc.connect(carol).transfer(await sweep.getAddress(), 5_000n * ONE_USDC)).wait();
      await (await sweep.connect(keeper).rebalance()).wait();
      expect(await aaveSink.totalAssets()).to.eq(2_500n * ONE_USDC);

      // Borrow $400 — pool idle = 0, so it must auto-pull. Since controller
      // has 2500 idle, the pull drains controller idle first (Aave untouched).
      const before = await usdc.balanceOf(bob.address);
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, 400n * ONE_USDC)).wait();
      const after = await usdc.balanceOf(bob.address);
      expect(after - before).to.eq(400n * ONE_USDC);
    });

    it("idle=0, controller idle=0 → borrow drains Aave via auto-pull", async function () {
      // Skip controller's own buffer to force the Aave drain path. Send USDC
      // straight into the AaveV3Sink as if the controller had already swept.
      await (await usdc.connect(carol).transfer(await aaveSink.getAddress(), 0n)).wait();
      // Need controller-grant on aave's controller role... already done in setup.
      // Easiest: have admin (still has CONTROLLER_ROLE on the sink) call deposit.
      await (await usdc.connect(admin).approve(await aaveSink.getAddress(), 2_000n * ONE_USDC)).wait();
      await (await usdc.mint(admin.address, 2_000n * ONE_USDC)).wait();
      await (await aaveSink.connect(admin).deposit(2_000n * ONE_USDC)).wait();
      expect(await aaveSink.totalAssets()).to.eq(2_000n * ONE_USDC);

      // Pool idle still 0, controller idle 0. Borrow must drain Aave.
      const aaveBefore = await aaveSink.totalAssets();
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, 400n * ONE_USDC)).wait();
      const aaveAfter = await aaveSink.totalAssets();
      expect(aaveBefore - aaveAfter).to.eq(400n * ONE_USDC);
    });

    it("auto-pull on supplier withdraw too", async function () {
      // Alice supplies $1000 → pool has 1000 idle.
      await (await pool.connect(alice).supply(1_000n * ONE_USDC)).wait();
      // Manually move pool's idle into the sweep controller via a workaround:
      // we don't have a direct "pool→sweep sweep" function in v1, so we
      // simulate by transferring USDC out (which a real sweep flow would do
      // once auto-pool→sweep wiring lands). For this test we just transfer.
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Move 600 of pool's idle to controller, then to Aave.
      // Use admin pause + impersonation? Simpler: use a manual transfer from the pool
      // by funding via a different account. This test is mostly about the auto-pull
      // mechanic being triggered when withdraw needs more than idle.
      // Direct approach: drain 600 from pool by having Alice borrow against an NFT she owns.
      // Mint an NFT to alice and have her borrow.
      await (await nft.mint(alice.address)).wait();
      await (await vault.setValue(2n, 1_000n * ONE_USDC)).wait();
      await (await nft.connect(alice).setApprovalForAll(await pool.getAddress(), true)).wait();
      await (await pool.connect(alice).borrow(await nft.getAddress(), 2n, 500n * ONE_USDC)).wait();
      // Pool idle now = 1000 - 500 = 500. Move some into Aave so withdraw needs to pull.
      await (await usdc.connect(carol).transfer(await sweep.getAddress(), 1_000n * ONE_USDC)).wait();
      await (await sweep.connect(keeper).rebalance()).wait();

      // Now alice tries to withdraw all her shares — needs USDC > pool's 500 idle.
      const aliceShares = await pool.sharesOf(alice.address);
      const expectAssets = await pool.previewWithdraw(aliceShares);
      // expectAssets should be > pool idle, forcing auto-pull from sweep.
      expect(expectAssets).to.be.greaterThan(500n * ONE_USDC);
      // (test passes if no revert)
      await (await pool.connect(alice).withdraw(aliceShares)).wait();
    });

    it("revert InsufficientLiquidity if sweep can't cover either", async function () {
      // No sweep funds. Pool empty. Borrow should still revert.
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  /* ────────── per-collection APR ────────── */

  describe("per-collection APR override", function () {
    it("default APR if no override; override applied if set", async function () {
      expect(await pool.aprFor(await nft.getAddress())).to.eq(800);
      await (await pool.connect(admin).setBorrowAprOverride(await nft.getAddress(), 1_500)).wait();
      expect(await pool.aprFor(await nft.getAddress())).to.eq(1_500);
      // Setting override = 0 reverts to default.
      await (await pool.connect(admin).setBorrowAprOverride(await nft.getAddress(), 0)).wait();
      expect(await pool.aprFor(await nft.getAddress())).to.eq(800);
    });

    it("override sanity capped at 50% APR", async function () {
      await expect(pool.connect(admin).setBorrowAprOverride(await nft.getAddress(), 5_001))
        .to.be.revertedWithCustomError(pool, "BadParam");
    });

    it("borrow + repay accrues at the override rate", async function () {
      // Set 20% APR for this collection.
      await (await pool.connect(admin).setBorrowAprOverride(await nft.getAddress(), 2_000)).wait();
      // Alice supplies; bob borrows 500 USDC; advance 30 days; check debt is ~30 days × 20% APR.
      await (await pool.connect(alice).supply(5_000n * ONE_USDC)).wait();
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, 500n * ONE_USDC)).wait();
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      const debt = await pool.debtOf(1n);
      // Expected interest at 20% APR for 30 days on 500 USDC = ~8.21 USDC.
      expect(debt).to.be.greaterThan(500n * ONE_USDC + 7n * ONE_USDC);
      expect(debt).to.be.lessThan(500n * ONE_USDC + 9n * ONE_USDC);
    });

    it("only admin can set override", async function () {
      await expect(pool.connect(carol).setBorrowAprOverride(await nft.getAddress(), 1000))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });
});
