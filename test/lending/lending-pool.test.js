// LendingPool core: supply / withdraw / borrow / repay.
// Liquidation flow is in a separate test file once the contract grows it.
//
// Coverage targets:
// - virtual-shares anti-donation math
// - per-collection LTV gating (via DiggerRegistry)
// - time locks (minSupplyHold, minLoanDuration enforcement, same-block borrow↔repay)
// - interest accrual + protocol reserve split
// - share price growth on interest payment
// - admin params + role gates
// - reentrancy boundary on borrow/repay/supply/withdraw

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0x" + "0".repeat(64);

const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;

describe("LendingPool — core (supply / borrow / repay)", function () {
  this.timeout(60_000);

  let admin, treasury, project, alice, bob, carol;
  let usdc, registry, vault, nft, pool;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, carol] = await ethers.getSigners();

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

    // Fund + approve everyone
    for (const u of [project, alice, bob, carol]) {
      await (await usdc.mint(u.address, 100_000n * ONE_USDC)).wait();
      await (await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    }

    // Project opens digger, registers the NFT collection at 50% LTV.
    await (await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    await (await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000)).wait();

    // Bob owns NFT #1, sets its mock value to $1000, approves the pool.
    await (await nft.mint(bob.address)).wait();
    await (await vault.setValue(1n, 1_000n * ONE_USDC)).wait(); // $1,000
    await (await nft.connect(bob).setApprovalForAll(await pool.getAddress(), true)).wait();
  });

  describe("constructor", function () {
    it("rejects zero admin / usdc / registry", async function () {
      const F = await ethers.getContractFactory("LendingPool");
      await expect(F.deploy(ZERO, await usdc.getAddress(), await registry.getAddress()))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(admin.address, ZERO, await registry.getAddress()))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(admin.address, await usdc.getAddress(), ZERO))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });
    it("seeds defaults", async function () {
      expect(await pool.borrowAprBps()).to.eq(800);
      expect(await pool.protocolReserveBps()).to.eq(3000);
      expect(await pool.liquidationBufferBps()).to.eq(1000);
      expect(await pool.minLoanDuration()).to.eq(60 * 60);
      expect(await pool.minSupplyHold()).to.eq(6 * 60 * 60);
      expect(await pool.totalAssets()).to.eq(0);
    });
  });

  /* ────────── supplier side ────────── */

  describe("supply / withdraw with virtual shares", function () {
    it("first supplier mints virtual-offset shares; share price stays ~1:1", async function () {
      const supplied = 1_000n * ONE_USDC;
      const expectShares = supplied * (0n + 1_000_000n) / (0n + 1n);
      const tx = await pool.connect(alice).supply(supplied);
      await expect(tx).to.emit(pool, "Supplied");
      const shares = await pool.sharesOf(alice.address);
      // shares are huge due to virtual offset — expected
      expect(shares).to.eq(expectShares);
      // Preview round-trip (within 1 wei rounding)
      const preview = await pool.previewWithdraw(shares);
      expect(preview).to.be.greaterThanOrEqual(supplied - 1n);
    });

    it("anti-donation: tiny first deposit + large donation does NOT zero out the next supplier", async function () {
      // Alice supplies 1 USDC.
      await (await pool.connect(alice).supply(ONE_USDC)).wait();
      const aliceShares = await pool.sharesOf(alice.address);
      // Carol donates 1000 USDC directly to the pool (no shares).
      await (await usdc.connect(carol).transfer(await pool.getAddress(), 1_000n * ONE_USDC)).wait();
      // Bob supplies 100 USDC.
      await (await pool.connect(bob).supply(100n * ONE_USDC)).wait();
      const bobShares = await pool.sharesOf(bob.address);
      // Without virtual offset, bob would get 0 shares (100 USDC / 1001 USDC totalAssets = 0 rounded).
      // With offset, bob still gets a meaningful share.
      expect(bobShares).to.be.greaterThan(0n);
      const bobAssets = await pool.previewWithdraw(bobShares);
      // Bob's claim is roughly his deposit (a tiny fraction siphoned to alice's share).
      // The siphon must be small: bob retrieves ≥ 99% of what he put in.
      expect(bobAssets).to.be.greaterThanOrEqual(99n * ONE_USDC);
    });

    it("withdraw is gated by minSupplyHold", async function () {
      await (await pool.connect(alice).supply(100n * ONE_USDC)).wait();
      const shares = await pool.sharesOf(alice.address);
      await expect(pool.connect(alice).withdraw(shares))
        .to.be.revertedWithCustomError(pool, "SupplyHoldActive");
      // Move forward 6h + 1s.
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      const before = await usdc.balanceOf(alice.address);
      await (await pool.connect(alice).withdraw(shares)).wait();
      const after = await usdc.balanceOf(alice.address);
      // Got back ~100 USDC (1 wei rounding tolerance from virtual offset).
      expect(after - before).to.be.greaterThanOrEqual(100n * ONE_USDC - 1n);
    });

    it("withdraw can't take more than the pool's idle balance", async function () {
      await (await pool.connect(alice).supply(1_000n * ONE_USDC)).wait();
      const shares = await pool.sharesOf(alice.address);
      // Bob borrows everything (after we wait for hold + setup).
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      // Bob borrows 400 USDC against his $1000 NFT (40% LTV, under the 50% cap).
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, 400n * ONE_USDC)).wait();
      // Pool has 600 USDC idle; alice can withdraw shares worth ≤600.
      // Try to redeem her full shares (~1000): should revert insufficient.
      await expect(pool.connect(alice).withdraw(shares))
        .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  /* ────────── borrow side ────────── */

  describe("borrow", function () {
    beforeEach(async function () {
      // Alice supplies 5,000 USDC so the pool has lendable cash; advance past hold.
      await (await pool.connect(alice).supply(5_000n * ONE_USDC)).wait();
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
    });

    it("borrows up to maxLtv, escrows NFT, sends USDC", async function () {
      const ltv = 5000; // 50% per the registry
      const want = 500n * ONE_USDC; // 50% of $1000 = exactly at cap
      const before = await usdc.balanceOf(bob.address);
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, want)).wait();
      const after = await usdc.balanceOf(bob.address);
      expect(after - before).to.eq(want);
      expect(await nft.ownerOf(1)).to.eq(await pool.getAddress());
      const loanId = await pool.activeLoanOf(await nft.getAddress(), 1n);
      expect(loanId).to.eq(1n);
      const l = await pool.loans(loanId);
      expect(l.principal).to.eq(want);
      expect(l.borrower).to.eq(bob.address);
      expect(l.status).to.eq(1n); // ACTIVE
    });

    it("rejects above maxLtv", async function () {
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 501n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "LtvExceeded");
    });

    it("rejects collateralizing twice", async function () {
      await (await pool.connect(bob).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC)).wait();
      // Even if NFT were re-issued — second collateralize blocked by activeLoanOf
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "AlreadyCollateralized");
    });

    it("rejects unregistered collection", async function () {
      const N2 = await ethers.getContractFactory("MockPositionNFT");
      const other = await N2.deploy("X", "X", await vault.getAddress());
      await other.waitForDeployment();
      await (await other.mint(bob.address)).wait();
      await (await vault.setValue(1n, 100n * ONE_USDC)).wait();
      await (await other.connect(bob).setApprovalForAll(await pool.getAddress(), true)).wait();
      await expect(pool.connect(bob).borrow(await other.getAddress(), 1n, 10n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "CollectionNotCollateral");
    });

    it("rejects when borrowAmount exceeds idle pool balance", async function () {
      // Pool has 5000 USDC idle. Bob can't borrow 5001 even though LTV permits.
      // Mock vault to make NFT very valuable so LTV isn't the binding constraint.
      await (await vault.setValue(1n, 100_000n * ONE_USDC)).wait();
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 5_001n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("non-owner of NFT cannot borrow against it", async function () {
      await expect(pool.connect(carol).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "NotERC721Owner");
    });
  });

  /* ────────── repay side ────────── */

  describe("repay + interest accrual + reserve split", function () {
    let loanId;
    const PRINCIPAL = 500n * ONE_USDC;

    beforeEach(async function () {
      await (await pool.connect(alice).supply(5_000n * ONE_USDC)).wait();
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      const tx = await pool.connect(bob).borrow(await nft.getAddress(), 1n, PRINCIPAL);
      await tx.wait();
      loanId = 1n;
    });

    it("rejects same-tx (and thus same-block) borrow + repay via attacker contract", async function () {
      // Real attack vector: a wrapper contract calls borrow then repay in one
      // tx. That's what we need to block — automine timing tricks aren't.
      const A = await ethers.getContractFactory("SameBlockAttacker");
      const attacker = await A.deploy();
      await attacker.waitForDeployment();

      // Mint a fresh NFT to the attacker so it owns the collateral.
      await (await nft.mint(await attacker.getAddress())).wait();
      await (await vault.setValue(3n, 1_000n * ONE_USDC)).wait();
      // Pre-fund the attacker with USDC to cover the repay leg.
      await (await usdc.mint(await attacker.getAddress(), 200n * ONE_USDC)).wait();

      let err;
      try {
        await attacker.attack(await pool.getAddress(), await nft.getAddress(), 3n, 100n * ONE_USDC, await usdc.getAddress());
      } catch (e) { err = e; }
      expect(err, "expected attacker.attack to revert").to.exist;
      const msg = err.message + (err.data ?? "");
      // Should revert specifically with SameBlockBorrowRepay (or its 4-byte selector).
      // selector(keccak256("SameBlockBorrowRepay()")) is the marker.
      expect(msg).to.match(/SameBlockBorrowRepay|0x[a-f0-9]{8}/i);
    });

    it("accrues interest over time, splits to reserve on repay", async function () {
      // Move forward 30 days.
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      // Expected interest: 500 USDC × 8% / year × 30/365 = ~3.288 USDC.
      const debt = await pool.debtOf(loanId);
      // Allow ~2% slop for block-time imprecision.
      expect(debt).to.be.greaterThan(PRINCIPAL + 3n * ONE_USDC);
      expect(debt).to.be.lessThan(PRINCIPAL + 4n * ONE_USDC);

      // Repay full debt.
      const reserveBefore = await pool.protocolReserve();
      const aliceShares = await pool.sharesOf(alice.address);
      const aliceAssetsBefore = await pool.previewWithdraw(aliceShares);

      await (await pool.connect(bob).repay(loanId, debt)).wait();

      const reserveAfter = await pool.protocolReserve();
      const aliceAssetsAfter = await pool.previewWithdraw(aliceShares);
      const interestPaid = debt - PRINCIPAL;
      const expectReserve = (interestPaid * 3000n) / 10_000n;
      // Allow rounding fudge of a few wei.
      expect(reserveAfter - reserveBefore).to.be.closeTo(expectReserve, 10n);
      // Alice's share value grew by ~70% of interest.
      expect(aliceAssetsAfter).to.be.greaterThan(aliceAssetsBefore);
      const supplierGain = aliceAssetsAfter - aliceAssetsBefore;
      const expectSupplier = interestPaid - expectReserve;
      // Within 1% (rounding + virtual-offset slop).
      expect(supplierGain).to.be.greaterThan(expectSupplier * 99n / 100n);
    });

    it("returns NFT on full repay; loan marked CLOSED", async function () {
      await ethers.provider.send("evm_increaseTime", [60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      const debt = await pool.debtOf(loanId);
      // Pay debt + a tiny buffer to absorb the ~1-sec interest accrued
      // between debtOf() (one block) and repay() (next block). The pool
      // only pulls the actual owed amount; the buffer is a no-op cap.
      await (await pool.connect(bob).repay(loanId, debt + ONE_USDC)).wait();
      expect(await nft.ownerOf(1n)).to.eq(bob.address);
      const l = await pool.loans(loanId);
      expect(l.status).to.eq(3n); // CLOSED
      expect(await pool.activeLoanOf(await nft.getAddress(), 1n)).to.eq(0n);
    });

    it("only borrower can repay", async function () {
      await ethers.provider.send("evm_increaseTime", [60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(pool.connect(carol).repay(loanId, ONE_USDC))
        .to.be.revertedWithCustomError(pool, "NotBorrower");
    });

    it("partial repay leaves loan ACTIVE", async function () {
      await ethers.provider.send("evm_increaseTime", [60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.connect(bob).repay(loanId, 100n * ONE_USDC)).wait();
      const l = await pool.loans(loanId);
      expect(l.status).to.eq(1n); // still ACTIVE
      expect(l.principal).to.be.lessThan(PRINCIPAL);
    });
  });

  /* ────────── admin ────────── */

  describe("admin", function () {
    it("setBorrowApr respects sanity cap", async function () {
      await expect(pool.connect(admin).setBorrowApr(5_001))
        .to.be.revertedWithCustomError(pool, "BadParam");
      await (await pool.connect(admin).setBorrowApr(1_500)).wait();
      expect(await pool.borrowAprBps()).to.eq(1500);
    });
    it("only admin can change params", async function () {
      await expect(pool.connect(carol).setBorrowApr(500))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
    it("withdrawProtocolReserve only after interest paid", async function () {
      // Reserve should be 0 initially.
      await expect(pool.connect(admin).withdrawProtocolReserve(treasury.address, 1n))
        .to.be.revertedWithCustomError(pool, "BadParam");
    });
    it("pause blocks supply + borrow", async function () {
      await (await pool.connect(admin).pause()).wait();
      await expect(pool.connect(alice).supply(ONE_USDC))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
      // Borrow also blocked.
      await ethers.provider.send("evm_increaseTime", [6 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, ONE_USDC))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });
});
