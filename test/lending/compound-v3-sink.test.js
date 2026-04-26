// CompoundV3Sink unit tests — mirrors AaveV3Sink coverage:
// constructor guards, access control, deposit, withdraw (normal + over-cap),
// yield accrual via totalAssets, rescueToken.
//
// Uses MockComet which behaves like cUSDCv3: balance grows in-place on
// accrueInterest (no wrapped aToken).

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_USDC = 10n ** 6n;

describe("CompoundV3Sink", function () {
  this.timeout(60_000);

  let admin, controller, alice, bob;
  let usdc, comet, sink;

  beforeEach(async function () {
    [admin, controller, alice, bob] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();

    const C = await ethers.getContractFactory("MockComet");
    comet = await C.deploy(await usdc.getAddress());

    const S = await ethers.getContractFactory("CompoundV3Sink");
    sink = await S.deploy(
      admin.address,
      controller.address,
      await usdc.getAddress(),
      await comet.getAddress(),
    );

    // Fund controller with USDC + approve sink
    await usdc.mint(controller.address, 1_000_000n * ONE_USDC);
    await usdc.connect(controller).approve(await sink.getAddress(), ethers.MaxUint256);
  });

  describe("constructor", function () {
    it("rejects zero addresses", async function () {
      const S = await ethers.getContractFactory("CompoundV3Sink");
      await expect(S.deploy(ZERO, controller.address, await usdc.getAddress(), await comet.getAddress()))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
      await expect(S.deploy(admin.address, ZERO, await usdc.getAddress(), await comet.getAddress()))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
      await expect(S.deploy(admin.address, controller.address, ZERO, await comet.getAddress()))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
      await expect(S.deploy(admin.address, controller.address, await usdc.getAddress(), ZERO))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
    });

    it("rejects a Comet whose baseToken doesn't match USDC", async function () {
      const wrongUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const wrongComet = await (await ethers.getContractFactory("MockComet")).deploy(await wrongUsdc.getAddress());
      const S = await ethers.getContractFactory("CompoundV3Sink");
      await expect(S.deploy(admin.address, controller.address, await usdc.getAddress(), await wrongComet.getAddress()))
        .to.be.revertedWithCustomError(S, "BaseTokenMismatch");
    });

    it("grants roles correctly", async function () {
      const ADMIN = "0x" + "0".repeat(64);
      const CONTROLLER = await sink.CONTROLLER_ROLE();
      expect(await sink.hasRole(ADMIN, admin.address)).to.eq(true);
      expect(await sink.hasRole(CONTROLLER, controller.address)).to.eq(true);
      expect(await sink.hasRole(CONTROLLER, admin.address)).to.eq(false);
    });
  });

  describe("deposit", function () {
    it("only CONTROLLER_ROLE can deposit", async function () {
      await usdc.mint(alice.address, 1000n * ONE_USDC);
      await usdc.connect(alice).approve(await sink.getAddress(), ethers.MaxUint256);
      await expect(sink.connect(alice).deposit(100n * ONE_USDC)).to.be.reverted;
    });
    it("rejects zero amount", async function () {
      await expect(sink.connect(controller).deposit(0))
        .to.be.revertedWithCustomError(sink, "ZeroAmount");
    });
    it("pulls USDC, supplies to Comet, emits event", async function () {
      await expect(sink.connect(controller).deposit(1_000n * ONE_USDC))
        .to.emit(sink, "SinkDeposited").withArgs(controller.address, 1_000n * ONE_USDC, 1_000n * ONE_USDC);
      expect(await sink.totalAssets()).to.eq(1_000n * ONE_USDC);
      expect(await comet.balanceOf(await sink.getAddress())).to.eq(1_000n * ONE_USDC);
    });
    it("multiple deposits accumulate", async function () {
      await sink.connect(controller).deposit(500n * ONE_USDC);
      await sink.connect(controller).deposit(750n * ONE_USDC);
      expect(await sink.totalAssets()).to.eq(1_250n * ONE_USDC);
    });
  });

  describe("withdraw", function () {
    beforeEach(async function () {
      await sink.connect(controller).deposit(10_000n * ONE_USDC);
    });

    it("only CONTROLLER_ROLE can withdraw", async function () {
      await expect(sink.connect(alice).withdraw(100n * ONE_USDC)).to.be.reverted;
    });
    it("rejects zero amount", async function () {
      await expect(sink.connect(controller).withdraw(0))
        .to.be.revertedWithCustomError(sink, "ZeroAmount");
    });
    it("returns USDC to caller and updates totalAssets", async function () {
      const before = await usdc.balanceOf(controller.address);
      await expect(sink.connect(controller).withdraw(4_000n * ONE_USDC))
        .to.emit(sink, "SinkWithdrawn");
      const after = await usdc.balanceOf(controller.address);
      expect(after - before).to.eq(4_000n * ONE_USDC);
      expect(await sink.totalAssets()).to.eq(6_000n * ONE_USDC);
    });
    it("caps withdraw at available balance", async function () {
      const before = await usdc.balanceOf(controller.address);
      await sink.connect(controller).withdraw(99_999n * ONE_USDC);
      const after = await usdc.balanceOf(controller.address);
      expect(after - before).to.eq(10_000n * ONE_USDC);
      expect(await sink.totalAssets()).to.eq(0);
    });
    it("reverts if no balance at all", async function () {
      await sink.connect(controller).withdraw(10_000n * ONE_USDC);
      await expect(sink.connect(controller).withdraw(1n * ONE_USDC))
        .to.be.revertedWithCustomError(sink, "InsufficientBalance");
    });
  });

  describe("yield accrual", function () {
    it("totalAssets reflects Comet-credited interest", async function () {
      await sink.connect(controller).deposit(1_000n * ONE_USDC);
      // Simulate Comet crediting 50 USDC of interest
      await usdc.mint(await comet.getAddress(), 50n * ONE_USDC);
      await comet.accrueInterest(await sink.getAddress(), 50n * ONE_USDC);
      expect(await sink.totalAssets()).to.eq(1_050n * ONE_USDC);
    });
    it("withdraw after yield pulls principal + yield", async function () {
      await sink.connect(controller).deposit(1_000n * ONE_USDC);
      await usdc.mint(await comet.getAddress(), 50n * ONE_USDC);
      await comet.accrueInterest(await sink.getAddress(), 50n * ONE_USDC);
      const before = await usdc.balanceOf(controller.address);
      await sink.connect(controller).withdraw(999_999n * ONE_USDC);
      const after = await usdc.balanceOf(controller.address);
      expect(after - before).to.eq(1_050n * ONE_USDC);
    });
  });

  describe("rescueToken", function () {
    it("only admin can call", async function () {
      await expect(sink.connect(alice).rescueToken(bob.address, alice.address, 1))
        .to.be.reverted;
    });
    it("blocks USDC rescue (managed state)", async function () {
      await expect(sink.connect(admin).rescueToken(await usdc.getAddress(), admin.address, 1))
        .to.be.revertedWithCustomError(sink, "ZeroAddress");
    });
    it("pulls a non-USDC token", async function () {
      const stray = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await stray.mint(await sink.getAddress(), 1_000n * ONE_USDC);
      await sink.connect(admin).rescueToken(await stray.getAddress(), admin.address, 1_000n * ONE_USDC);
      expect(await stray.balanceOf(admin.address)).to.eq(1_000n * ONE_USDC);
    });
  });
});
