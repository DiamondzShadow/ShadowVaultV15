// SweepControllerV2: generic N-sink allocator tests.
// Coverage:
//   - constructor + role separation
//   - addSink / setSinkTarget / deactivateSink + bps-sum invariant
//   - rebalance across Aave + Compound sinks (idle→sink on underfunded,
//     sink→idle on overfunded, full drain of inactive sinks)
//   - pull() drains idle first, then sinks in registration order
//   - access control (keeper-only rebalance, pool-only pull, admin-only config)
//   - minMove dust skip
//   - optional remote leg (address(0) disables)
//
// Uses MockComet + MockAavePool + MockAUsdc so the test run is hermetic.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_USDC = 10n ** 6n;
const BPS = 10_000n;

describe("SweepControllerV2 — N-sink allocator", function () {
  this.timeout(60_000);

  let admin, keeper, pool, alice;
  let usdc, ausdc, aavePool, comet, aaveSink, compoundSink, sweep;

  beforeEach(async function () {
    [admin, keeper, pool, alice] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();

    const A = await ethers.getContractFactory("MockAUsdc");
    ausdc = await A.deploy();

    const P = await ethers.getContractFactory("MockAavePool");
    aavePool = await P.deploy(await usdc.getAddress(), await ausdc.getAddress());

    const AS = await ethers.getContractFactory("AaveV3Sink");
    aaveSink = await AS.deploy(
      admin.address, admin.address, await usdc.getAddress(), await ausdc.getAddress(), await aavePool.getAddress()
    );

    const C = await ethers.getContractFactory("MockComet");
    comet = await C.deploy(await usdc.getAddress());

    const CS = await ethers.getContractFactory("CompoundV3Sink");
    compoundSink = await CS.deploy(
      admin.address, admin.address, await usdc.getAddress(), await comet.getAddress()
    );

    const S = await ethers.getContractFactory("SweepControllerV2");
    sweep = await S.deploy(admin.address, keeper.address, await usdc.getAddress());

    // Grant controller role on sinks to the sweep controller
    const CONTROLLER = await aaveSink.CONTROLLER_ROLE();
    await aaveSink.grantRole(CONTROLLER, await sweep.getAddress());
    await compoundSink.grantRole(CONTROLLER, await sweep.getAddress());

    // Register sinks in sweep: reserve 20% / aave 40% / compound 40%
    await sweep.addSink(await aaveSink.getAddress(), 4_000, "aave");
    await sweep.addSink(await compoundSink.getAddress(), 4_000, "compound");
    // reserve stays at default 2000 bps → sum = 10_000 ✓

    // Wire pool
    await sweep.setLendingPool(pool.address);
  });

  describe("constructor + role wiring", function () {
    it("rejects zero addresses", async function () {
      const S = await ethers.getContractFactory("SweepControllerV2");
      await expect(S.deploy(ZERO, keeper.address, await usdc.getAddress()))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
      await expect(S.deploy(admin.address, ZERO, await usdc.getAddress()))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
      await expect(S.deploy(admin.address, keeper.address, ZERO))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
    });
    it("POOL_ROLE is granted on setLendingPool", async function () {
      const POOL_ROLE = await sweep.POOL_ROLE();
      expect(await sweep.hasRole(POOL_ROLE, pool.address)).to.eq(true);
    });
  });

  describe("bps-sum invariant", function () {
    it("addSink that would overflow 10000 bps reverts", async function () {
      const Extra = await ethers.getContractFactory("CompoundV3Sink");
      const extra = await Extra.deploy(admin.address, admin.address, await usdc.getAddress(), await comet.getAddress());
      await expect(sweep.addSink(await extra.getAddress(), 5_000, "morpho"))
        .to.be.revertedWithCustomError(sweep, "BpsOverflow");
    });
    it("setReserveBps that would overflow reverts", async function () {
      await expect(sweep.setReserveBps(9_000))
        .to.be.revertedWithCustomError(sweep, "BpsOverflow");
    });
    it("can rebalance targets across sinks (drop compound, raise aave) so sum stays 10000", async function () {
      // Must lower first, then raise — each individual setSinkTarget has its own sum check.
      await sweep.setSinkTarget(1, 0);        // compound → 0 (sum 2000+4000+0 = 6000)
      await sweep.setSinkTarget(0, 8_000);    // aave → 8000 (sum 2000+8000+0 = 10000)
    });
  });

  describe("rebalance", function () {
    beforeEach(async function () {
      // Seed controller with 10_000 USDC
      await usdc.mint(await sweep.getAddress(), 10_000n * ONE_USDC);
    });

    it("first rebalance pushes 40% to each sink, leaves 20% idle", async function () {
      await sweep.connect(keeper).rebalance();
      expect(await aaveSink.totalAssets()).to.eq(4_000n * ONE_USDC);
      expect(await compoundSink.totalAssets()).to.eq(4_000n * ONE_USDC);
      expect(await usdc.balanceOf(await sweep.getAddress())).to.eq(2_000n * ONE_USDC);
      expect(await sweep.totalAssets()).to.eq(10_000n * ONE_USDC);
    });

    it("second rebalance is a no-op (within minMove dust)", async function () {
      await sweep.connect(keeper).rebalance();
      const beforeAave = await aaveSink.totalAssets();
      const beforeCompound = await compoundSink.totalAssets();
      await sweep.connect(keeper).rebalance();
      expect(await aaveSink.totalAssets()).to.eq(beforeAave);
      expect(await compoundSink.totalAssets()).to.eq(beforeCompound);
    });

    it("changing target on a sink shifts funds on next rebalance", async function () {
      await sweep.connect(keeper).rebalance();
      // Move from 40/40 aave/compound to 60/20 — lower compound first to stay within bps.
      await sweep.setSinkTarget(1, 2_000);  // compound → 2000 (sum 2000+4000+2000 = 8000)
      await sweep.setSinkTarget(0, 6_000);  // aave → 6000 (sum 2000+6000+2000 = 10000)
      await sweep.connect(keeper).rebalance();
      expect(await aaveSink.totalAssets()).to.eq(6_000n * ONE_USDC);
      expect(await compoundSink.totalAssets()).to.eq(2_000n * ONE_USDC);
      expect(await usdc.balanceOf(await sweep.getAddress())).to.eq(2_000n * ONE_USDC);
    });

    it("deactivated sink gets fully drained on rebalance", async function () {
      await sweep.connect(keeper).rebalance();
      expect(await compoundSink.totalAssets()).to.eq(4_000n * ONE_USDC);

      // Deactivate compound first (drops its bps to 0, sum = 2000+4000 = 6000)
      await sweep.deactivateSink(1);
      // Now raise aave to 8000 (sum 2000+8000 = 10000)
      await sweep.setSinkTarget(0, 8_000);
      await sweep.connect(keeper).rebalance();
      expect(await compoundSink.totalAssets()).to.eq(0);
      expect(await aaveSink.totalAssets()).to.eq(8_000n * ONE_USDC);
    });

    it("only keeper can rebalance", async function () {
      await expect(sweep.connect(alice).rebalance()).to.be.reverted;
    });

    it("minMove skips dust deltas", async function () {
      await sweep.connect(keeper).rebalance();
      // Add $10 to the controller — below 50 USDC minMove, should NOT flow to sinks.
      await usdc.mint(await sweep.getAddress(), 10n * ONE_USDC);
      const beforeAave = await aaveSink.totalAssets();
      await sweep.connect(keeper).rebalance();
      // Targets are now based on a new totalAssets of 10010, so aave target = 4004.
      // Diff is 4 USDC < minMove 50 — no move.
      expect(await aaveSink.totalAssets()).to.eq(beforeAave);
    });
  });

  describe("pull (pool-driven)", function () {
    beforeEach(async function () {
      await usdc.mint(await sweep.getAddress(), 10_000n * ONE_USDC);
      await sweep.connect(keeper).rebalance();
      // Now: idle=2000, aave=4000, compound=4000
    });

    it("drains idle first, then sinks in registration order", async function () {
      const before = await usdc.balanceOf(pool.address);
      // Ask for 5000 USDC: 2000 from idle, then 3000 from aave (sink 0)
      await sweep.connect(pool).pull(5_000n * ONE_USDC);
      const after = await usdc.balanceOf(pool.address);
      expect(after - before).to.eq(5_000n * ONE_USDC);
      expect(await usdc.balanceOf(await sweep.getAddress())).to.eq(0);
      expect(await aaveSink.totalAssets()).to.eq(1_000n * ONE_USDC);
      expect(await compoundSink.totalAssets()).to.eq(4_000n * ONE_USDC);
    });

    it("cascades across multiple sinks when needed", async function () {
      const before = await usdc.balanceOf(pool.address);
      // Ask for 8000: 2000 idle + 4000 aave + 2000 compound
      await sweep.connect(pool).pull(8_000n * ONE_USDC);
      const after = await usdc.balanceOf(pool.address);
      expect(after - before).to.eq(8_000n * ONE_USDC);
      expect(await aaveSink.totalAssets()).to.eq(0);
      expect(await compoundSink.totalAssets()).to.eq(2_000n * ONE_USDC);
    });

    it("delivers only what's available when pool asks for more than syncLiquidity", async function () {
      const before = await usdc.balanceOf(pool.address);
      await sweep.connect(pool).pull(99_999n * ONE_USDC);
      const after = await usdc.balanceOf(pool.address);
      // Max available is 10_000 (idle + both sinks).
      expect(after - before).to.eq(10_000n * ONE_USDC);
      expect(await sweep.syncLiquidity()).to.eq(0);
    });

    it("only POOL_ROLE can pull", async function () {
      await expect(sweep.connect(alice).pull(1n * ONE_USDC)).to.be.reverted;
      await expect(sweep.connect(keeper).pull(1n * ONE_USDC)).to.be.reverted;
    });
  });

  describe("totalAssets reflects yield", function () {
    it("counts accrued yield in the aggregate", async function () {
      await usdc.mint(await sweep.getAddress(), 10_000n * ONE_USDC);
      await sweep.connect(keeper).rebalance();
      expect(await sweep.totalAssets()).to.eq(10_000n * ONE_USDC);

      // Simulate Compound accruing 100 USDC interest
      await usdc.mint(await comet.getAddress(), 100n * ONE_USDC);
      await comet.accrueInterest(await compoundSink.getAddress(), 100n * ONE_USDC);
      expect(await sweep.totalAssets()).to.eq(10_100n * ONE_USDC);
    });
  });

  describe("remote leg (optional)", function () {
    it("remote=0 is accepted on Polygon-style deploy (no async leg)", async function () {
      // Default state: remote is 0 and remoteBps is 0. bps sum invariant still holds.
      expect(await sweep.remoteBps()).to.eq(0);
      expect(await sweep.remote()).to.eq(ZERO);
    });
    it("setRemote with nonzero bps requires the bps sum to still hit 10000", async function () {
      // Try to set remote to 3000 bps without freeing that up from sinks/reserve → overflow
      await expect(sweep.setRemote(keeper.address /* stand-in addr */, 3_000))
        .to.be.revertedWithCustomError(sweep, "BpsOverflow");
    });
    it("setRemote to address(0) requires bps=0", async function () {
      await expect(sweep.setRemote(ZERO, 1_000))
        .to.be.revertedWithCustomError(sweep, "BadParam");
    });
  });
});
