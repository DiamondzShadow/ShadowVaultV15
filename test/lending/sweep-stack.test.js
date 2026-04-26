// AaveV3Sink + HyperRemoteMirror + SweepController happy paths + role gates.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_USDC = 10n ** 6n;

describe("Sweep stack — AaveV3Sink / HyperRemoteMirror / SweepController", function () {
  this.timeout(60_000);

  let admin, controllerAdmin, keeper, alice, bob, lendingPool;
  let usdc, ausdc, aave;
  let aaveSink, remote, controller;

  beforeEach(async function () {
    [admin, controllerAdmin, keeper, alice, bob, lendingPool] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

    const A = await ethers.getContractFactory("MockAUsdc");
    ausdc = await A.deploy();
    await ausdc.waitForDeployment();

    const P = await ethers.getContractFactory("MockAavePool");
    aave = await P.deploy(await usdc.getAddress(), await ausdc.getAddress());
    await aave.waitForDeployment();

    // Sink — admin is admin, controller is `controllerAdmin` for now;
    // we'll redirect to the SweepController address after deploy.
    const S = await ethers.getContractFactory("AaveV3Sink");
    aaveSink = await S.deploy(
      admin.address, controllerAdmin.address,
      await usdc.getAddress(), await ausdc.getAddress(), await aave.getAddress(),
    );
    await aaveSink.waitForDeployment();

    const M = await ethers.getContractFactory("HyperRemoteMirror");
    remote = await M.deploy(
      admin.address, controllerAdmin.address, keeper.address,
      await usdc.getAddress(), bob.address /* keeper payout wallet */,
    );
    await remote.waitForDeployment();

    const C = await ethers.getContractFactory("SweepController");
    controller = await C.deploy(
      admin.address, keeper.address,
      await usdc.getAddress(),
      await aaveSink.getAddress(),
      await remote.getAddress(),
    );
    await controller.waitForDeployment();

    // Re-grant CONTROLLER_ROLE on the sinks to the actual SweepController.
    const sinkRole = await aaveSink.CONTROLLER_ROLE();
    await (await aaveSink.connect(admin).grantRole(sinkRole, await controller.getAddress())).wait();
    const remoteRole = await remote.CONTROLLER_ROLE();
    await (await remote.connect(admin).grantRole(remoteRole, await controller.getAddress())).wait();

    // Wire pool role.
    await (await controller.connect(admin).setLendingPool(lendingPool.address)).wait();

    // Fund + approve all relevant signers.
    for (const u of [alice, bob, controllerAdmin, keeper, lendingPool]) {
      await (await usdc.mint(u.address, 100_000n * ONE_USDC)).wait();
      await (await usdc.connect(u).approve(await aaveSink.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await remote.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await controller.getAddress(), ethers.MaxUint256)).wait();
    }
  });

  /* ────────── AaveV3Sink ────────── */

  describe("AaveV3Sink", function () {
    it("controller deposits + withdraws synchronously", async function () {
      const amt = 1_000n * ONE_USDC;
      // controllerAdmin still has CONTROLLER_ROLE from constructor.
      await (await aaveSink.connect(controllerAdmin).deposit(amt)).wait();
      expect(await aaveSink.totalAssets()).to.eq(amt);

      const before = await usdc.balanceOf(controllerAdmin.address);
      await (await aaveSink.connect(controllerAdmin).withdraw(500n * ONE_USDC)).wait();
      const after = await usdc.balanceOf(controllerAdmin.address);
      expect(after - before).to.eq(500n * ONE_USDC);
      expect(await aaveSink.totalAssets()).to.eq(500n * ONE_USDC);
    });

    it("non-controller cannot deposit / withdraw", async function () {
      await expect(aaveSink.connect(alice).deposit(ONE_USDC))
        .to.be.revertedWithCustomError(aaveSink, "AccessControlUnauthorizedAccount");
      await expect(aaveSink.connect(alice).withdraw(ONE_USDC))
        .to.be.revertedWithCustomError(aaveSink, "AccessControlUnauthorizedAccount");
    });

    it("rejects rescue of USDC + aUSDC", async function () {
      await expect(aaveSink.connect(admin).rescueToken(await usdc.getAddress(), alice.address, 1n))
        .to.be.revertedWithCustomError(aaveSink, "ZeroAddress");
      await expect(aaveSink.connect(admin).rescueToken(await ausdc.getAddress(), alice.address, 1n))
        .to.be.revertedWithCustomError(aaveSink, "ZeroAddress");
    });
  });

  /* ────────── HyperRemoteMirror ────────── */

  describe("HyperRemoteMirror", function () {
    it("controller deposits → keeper confirms → mirrored grows", async function () {
      const amt = 500n * ONE_USDC;
      const bobBefore = await usdc.balanceOf(bob.address);
      await (await remote.connect(controllerAdmin).deposit(amt)).wait();
      // Keeper payout wallet is bob in setup → bob got USDC.
      const bobAfter = await usdc.balanceOf(bob.address);
      expect(bobAfter - bobBefore).to.eq(amt);
      expect(await remote.pendingOutbound()).to.eq(amt);
      expect(await remote.totalAssets()).to.eq(amt);

      // Keeper attests.
      await (await remote.connect(keeper).confirmDeposit(amt)).wait();
      expect(await remote.pendingOutbound()).to.eq(0n);
      expect(await remote.mirrored()).to.eq(amt);
    });

    it("controller requestWithdraw → keeper confirms → USDC delivered to deliverTo", async function () {
      const amt = 500n * ONE_USDC;
      // First seed: deposit + confirm so mirrored > 0.
      await (await remote.connect(controllerAdmin).deposit(amt)).wait();
      await (await remote.connect(keeper).confirmDeposit(amt)).wait();

      // Request unwind.
      await (await remote.connect(controllerAdmin).requestWithdraw(amt)).wait();
      expect(await remote.pendingInbound()).to.eq(amt);

      // Keeper transfers USDC into themselves first (simulating bridged-back funds).
      // Then approves remote to pull and forward.
      await (await usdc.mint(keeper.address, amt)).wait();
      await (await usdc.connect(keeper).approve(await remote.getAddress(), amt)).wait();
      const aliceBefore = await usdc.balanceOf(alice.address);
      await (await remote.connect(keeper).confirmReturn(amt, alice.address)).wait();
      const aliceAfter = await usdc.balanceOf(alice.address);
      expect(aliceAfter - aliceBefore).to.eq(amt);
      expect(await remote.pendingInbound()).to.eq(0n);
      expect(await remote.mirrored()).to.eq(0n);
    });

    it("requestWithdraw rejects > mirrored", async function () {
      await expect(remote.connect(controllerAdmin).requestWithdraw(1n))
        .to.be.revertedWithCustomError(remote, "ExceedsMirrored");
    });
  });

  /* ────────── SweepController ────────── */

  describe("SweepController.rebalance", function () {
    it("moves controller-idle USDC into Aave + Remote per target weights", async function () {
      // Fund controller with 10000 USDC of "idle".
      await (await usdc.connect(alice).transfer(await controller.getAddress(), 10_000n * ONE_USDC)).wait();
      // Default targets: 20% reserve / 50% Aave / 30% remote.
      // total = 10000, aave target = 5000, remote target = 3000.

      const tx = await controller.connect(keeper).rebalance();
      await tx.wait();

      const inAave   = await aaveSink.totalAssets();
      const inRemote = await remote.totalAssets();
      const idle     = await ethers.provider.send("eth_call", [{
        to: await usdc.getAddress(),
        data: "0x70a08231" + ethers.zeroPadValue(await controller.getAddress(), 32).slice(2),
      }, "latest"]);
      const idleNum = BigInt(idle);

      expect(inAave).to.eq(5_000n * ONE_USDC);
      expect(inRemote).to.eq(3_000n * ONE_USDC);
      expect(idleNum).to.eq(2_000n * ONE_USDC); // reserve target stays idle on the controller
    });

    it("setTargets requires sum=10000", async function () {
      await expect(controller.connect(admin).setTargets(2000, 5000, 2000))
        .to.be.revertedWithCustomError(controller, "BadParam");
      await (await controller.connect(admin).setTargets(1000, 6000, 3000)).wait();
      expect(await controller.reserveBps()).to.eq(1000);
      expect(await controller.aaveBps()).to.eq(6000);
      expect(await controller.remoteBps()).to.eq(3000);
    });

    it("only KEEPER_ROLE can rebalance", async function () {
      await expect(controller.connect(alice).rebalance())
        .to.be.revertedWithCustomError(controller, "AccessControlUnauthorizedAccount");
    });
  });

  describe("SweepController.pull (LendingPool drain)", function () {
    it("drains controller idle first, then Aave; queues remote unwind for the rest", async function () {
      // Fund controller idle = 1000, Aave = 4000, mirrored = 3000.
      await (await usdc.connect(alice).transfer(await controller.getAddress(), 1_000n * ONE_USDC)).wait();
      // Seed Aave directly via controllerAdmin (still has CONTROLLER_ROLE).
      await (await aaveSink.connect(controllerAdmin).deposit(4_000n * ONE_USDC)).wait();
      // Seed remote.
      await (await remote.connect(controllerAdmin).deposit(3_000n * ONE_USDC)).wait();
      await (await remote.connect(keeper).confirmDeposit(3_000n * ONE_USDC)).wait();

      // Pool requests 6,000 USDC.
      const lpBefore = await usdc.balanceOf(lendingPool.address);
      await (await controller.connect(lendingPool).pull(6_000n * ONE_USDC)).wait();
      const lpAfter = await usdc.balanceOf(lendingPool.address);
      // Pool should receive 1000 (idle) + 4000 (Aave) = 5000.
      expect(lpAfter - lpBefore).to.eq(5_000n * ONE_USDC);

      // Remote was asked to queue 1000 of unwind.
      expect(await remote.pendingInbound()).to.eq(1_000n * ONE_USDC);
    });

    it("non-pool cannot call pull", async function () {
      await expect(controller.connect(alice).pull(1n))
        .to.be.revertedWithCustomError(controller, "AccessControlUnauthorizedAccount");
    });
  });
});
