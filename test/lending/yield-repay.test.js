// LendingPool yield-to-loan auto-repay.
// Borrower sets `yieldRepayBps` per loan; anyone can call harvestAndApply
// to harvest from the underlying vault and split per the borrower's setting.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;
const PRINCIPAL = 500n * ONE_USDC;

describe("LendingPool — yield-to-loan auto-repay", function () {
  this.timeout(60_000);

  let admin, treasury, project, alice, bob, carol, keeper;
  let usdc, registry, vault, nft, pool, loanId;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, carol, keeper] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

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

    for (const u of [project, alice, bob, carol, keeper]) {
      await (await usdc.mint(u.address, 100_000n * ONE_USDC)).wait();
      await (await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    }

    await (await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    await (await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000)).wait();

    await (await nft.mint(bob.address)).wait();
    await (await vault.setValue(1n, 1_000n * ONE_USDC)).wait();
    await (await nft.connect(bob).setApprovalForAll(await pool.getAddress(), true)).wait();

    await (await pool.connect(alice).supply(5_000n * ONE_USDC)).wait();
    await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, PRINCIPAL)).wait();
    loanId = 1n;
  });

  describe("setYieldRepayBps", function () {
    it("borrower sets, event emitted, value stored", async function () {
      const tx = await pool.connect(bob).setYieldRepayBps(loanId, 5_000);
      await expect(tx).to.emit(pool, "YieldRepayBpsSet").withArgs(loanId, 0, 5_000);
      const l = await pool.loans(loanId);
      expect(l.yieldRepayBps).to.eq(5_000);
    });
    it("non-borrower cannot set", async function () {
      await expect(pool.connect(carol).setYieldRepayBps(loanId, 5_000))
        .to.be.revertedWithCustomError(pool, "NotBorrower");
    });
    it("rejects > 10000", async function () {
      await expect(pool.connect(bob).setYieldRepayBps(loanId, 10_001))
        .to.be.revertedWithCustomError(pool, "BadParam");
    });
  });

  describe("harvestAndApply", function () {
    const YIELD = 100n * ONE_USDC;

    beforeEach(async function () {
      // Stage a 100 USDC yield harvest on the underlying mock vault.
      await (await vault.setNextYield(1n, YIELD)).wait();
      await (await usdc.mint(await vault.getAddress(), YIELD)).wait();
    });

    it("yieldRepayBps=0 → 100% to borrower", async function () {
      const before = await usdc.balanceOf(bob.address);
      const lBefore = await pool.loans(loanId);
      const tx = await pool.connect(carol).harvestAndApply(loanId);
      await tx.wait();
      const after = await usdc.balanceOf(bob.address);
      const lAfter = await pool.loans(loanId);

      expect(after - before).to.eq(YIELD);
      expect(lAfter.principal).to.eq(lBefore.principal); // loan unchanged
    });

    it("yieldRepayBps=10000 → 100% to loan; principal drops; borrower gets 0", async function () {
      await (await pool.connect(bob).setYieldRepayBps(loanId, 10_000)).wait();
      const before = await usdc.balanceOf(bob.address);

      await (await pool.connect(carol).harvestAndApply(loanId)).wait();

      const after = await usdc.balanceOf(bob.address);
      // No yield to borrower (all went to loan).
      expect(after - before).to.eq(0n);
      const l = await pool.loans(loanId);
      // Principal dropped by ~100 USDC (minus the small interest accrued).
      expect(l.principal).to.be.lessThan(PRINCIPAL);
      expect(PRINCIPAL - l.principal).to.be.greaterThan(95n * ONE_USDC);
    });

    it("yieldRepayBps=5000 → 50/50 split", async function () {
      await (await pool.connect(bob).setYieldRepayBps(loanId, 5_000)).wait();
      const before = await usdc.balanceOf(bob.address);
      const tx = await pool.connect(carol).harvestAndApply(loanId);
      const rc = await tx.wait();

      const after = await usdc.balanceOf(bob.address);
      // Borrower got 50% of yield.
      expect(after - before).to.eq(50n * ONE_USDC);

      // 50% applied to loan: principal decreased by ~50 USDC (less the small interest accrued).
      const l = await pool.loans(loanId);
      expect(PRINCIPAL - l.principal).to.be.greaterThan(45n * ONE_USDC);
      expect(PRINCIPAL - l.principal).to.be.lessThan(50n * ONE_USDC);
    });

    it("anyone can call harvestAndApply (no role gate)", async function () {
      await (await pool.connect(bob).setYieldRepayBps(loanId, 10_000)).wait();
      // keeper (random EOA) calls.
      await (await pool.connect(keeper).harvestAndApply(loanId)).wait();
      const l = await pool.loans(loanId);
      expect(l.principal).to.be.lessThan(PRINCIPAL);
    });

    it("zero yield → no-op (no revert)", async function () {
      // Reset nextYield.
      await (await vault.setNextYield(1n, 0n)).wait();
      const tx = await pool.connect(carol).harvestAndApply(loanId);
      await tx.wait();
      const l = await pool.loans(loanId);
      expect(l.principal).to.eq(PRINCIPAL);
    });

    it("harvest that exceeds remaining debt closes the loan + refunds dust to borrower", async function () {
      await (await pool.connect(bob).setYieldRepayBps(loanId, 10_000)).wait();
      // Stage 600 USDC yield (exceeds 500 principal + tiny interest).
      const big = 600n * ONE_USDC;
      await (await vault.setNextYield(1n, big)).wait();
      await (await usdc.mint(await vault.getAddress(), big)).wait();

      const before = await usdc.balanceOf(bob.address);
      await (await pool.connect(carol).harvestAndApply(loanId)).wait();
      const after = await usdc.balanceOf(bob.address);

      // Loan should be closed.
      const l = await pool.loans(loanId);
      expect(l.status).to.eq(3n); // CLOSED
      expect(await nft.ownerOf(1n)).to.eq(bob.address);
      // Dust (~100 USDC) refunded to borrower.
      expect(after - before).to.be.greaterThan(99n * ONE_USDC);
    });

    it("liquidating loan rejects harvestAndApply", async function () {
      await ethers.provider.send("evm_increaseTime", [60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await vault.setValue(1n, 700n * ONE_USDC)).wait();
      await (await pool.connect(carol).triggerLiquidation(loanId)).wait();
      await expect(pool.connect(carol).harvestAndApply(loanId))
        .to.be.revertedWithCustomError(pool, "LoanNotActive");
    });
  });
});
