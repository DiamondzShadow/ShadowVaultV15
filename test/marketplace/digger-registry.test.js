const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("DiggerRegistry", function () {
  this.timeout(60_000);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const MIN_BOND = 1_000n * 10n ** 6n; // 1,000 USDC

  let admin, treasury, projectA, projectB, alice, eve;
  let usdc, registry, nftA, nftB;

  beforeEach(async function () {
    [admin, treasury, projectA, projectB, alice, eve] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

    // Two mock NFT contracts (any address works since registry only stores them).
    // Use existing HyperSkin compile artifact for one and just two arbitrary
    // EOAs for the others. For unit tests we only need address values.
    nftA = ethers.Wallet.createRandom().address;
    nftB = ethers.Wallet.createRandom().address;

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);
    await registry.waitForDeployment();

    // Fund + approve project signers
    for (const p of [projectA, projectB]) {
      await (await usdc.mint(p.address, MIN_BOND * 5n)).wait();
      await (await usdc.connect(p).approve(await registry.getAddress(), MIN_BOND * 5n)).wait();
    }
  });

  describe("constructor", function () {
    it("reverts on zero admin / usdc / treasury", async function () {
      const F = await ethers.getContractFactory("DiggerRegistry");
      await expect(F.deploy(ZERO, await usdc.getAddress(), treasury.address))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(admin.address, ZERO, treasury.address))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(admin.address, await usdc.getAddress(), ZERO))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("seeds defaults: minBond=1000 USDC, unstakeDelay=14 days", async function () {
      expect(await registry.minBondUSDC()).to.eq(MIN_BOND);
      expect(await registry.unstakeDelay()).to.eq(14 * 24 * 60 * 60);
      expect(await registry.protocolTreasury()).to.eq(treasury.address);
    });
  });

  describe("openDigger", function () {
    it("creates a digger with correct fields, transfers USDC bond, emits event", async function () {
      const tx = await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000);
      const rc = await tx.wait();
      // Check digger #1
      const d = await registry.diggers(1n);
      expect(d.owner).to.eq(projectA.address);
      expect(d.bondAmount).to.eq(MIN_BOND);
      expect(d.protocolBps).to.eq(1000);
      expect(d.supplierBps).to.eq(7000);
      expect(d.diggerBps).to.eq(2000);
      expect(d.paused).to.eq(false);
      expect(d.slashed).to.eq(false);
      expect(await usdc.balanceOf(await registry.getAddress())).to.eq(MIN_BOND);
      await expect(tx).to.emit(registry, "DiggerOpened").withArgs(1, projectA.address, MIN_BOND);
    });

    it("rejects bond below minimum", async function () {
      await expect(registry.connect(projectA).openDigger(MIN_BOND - 1n, 1000, 7000, 2000))
        .to.be.revertedWithCustomError(registry, "BondTooLow");
    });

    it("rejects fee split that doesn't sum to 10_000", async function () {
      await expect(registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 1000))
        .to.be.revertedWithCustomError(registry, "BadFeeSplit");
    });

    it("nextDiggerId increments", async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
      await (await registry.connect(projectB).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
      expect((await registry.diggers(1)).owner).to.eq(projectA.address);
      expect((await registry.diggers(2)).owner).to.eq(projectB.address);
    });
  });

  describe("addBond", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    });
    it("anyone can top up; bond grows; event emitted", async function () {
      await (await usdc.mint(alice.address, 500n * 1_000_000n)).wait();
      await (await usdc.connect(alice).approve(await registry.getAddress(), 500n * 1_000_000n)).wait();
      const tx = await registry.connect(alice).addBond(1, 500n * 1_000_000n);
      await expect(tx).to.emit(registry, "DiggerBondAdded").withArgs(1, 500n * 1_000_000n, MIN_BOND + 500n * 1_000_000n);
      expect((await registry.diggers(1)).bondAmount).to.eq(MIN_BOND + 500n * 1_000_000n);
    });
    it("reverts on unknown digger", async function () {
      await expect(registry.connect(alice).addBond(99, 1n))
        .to.be.revertedWithCustomError(registry, "UnknownDigger");
    });
    it("reverts on zero amount", async function () {
      await expect(registry.connect(projectA).addBond(1, 0))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });
  });

  describe("unstake flow", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    });
    it("queueUnstake → wait → unstake delivers USDC", async function () {
      await (await registry.connect(projectA).queueUnstake(1)).wait();
      await expect(registry.connect(projectA).unstake(1, MIN_BOND))
        .to.be.revertedWithCustomError(registry, "UnstakeNotReady");
      await ethers.provider.send("evm_increaseTime", [14 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      const before = await usdc.balanceOf(projectA.address);
      await (await registry.connect(projectA).unstake(1, MIN_BOND)).wait();
      const after = await usdc.balanceOf(projectA.address);
      expect(after - before).to.eq(MIN_BOND);
      expect((await registry.diggers(1)).bondAmount).to.eq(0);
      // Full withdraw clears the queue
      expect((await registry.diggers(1)).unstakeAt).to.eq(0);
    });
    it("only owner can unstake", async function () {
      await (await registry.connect(projectA).queueUnstake(1)).wait();
      await ethers.provider.send("evm_increaseTime", [14 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(registry.connect(eve).unstake(1, MIN_BOND))
        .to.be.revertedWithCustomError(registry, "NotDiggerOwner");
    });
    it("reverts if unstake not queued", async function () {
      await expect(registry.connect(projectA).unstake(1, 1n))
        .to.be.revertedWithCustomError(registry, "UnstakeNotQueued");
    });
  });

  describe("slash", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    });
    it("admin can slash partial; bond decremented, USDC sent", async function () {
      const before = await usdc.balanceOf(treasury.address);
      const tx = await registry.connect(admin).slash(1, 100n * 1_000_000n, treasury.address, "test");
      await expect(tx).to.emit(registry, "DiggerSlashed");
      const after = await usdc.balanceOf(treasury.address);
      expect(after - before).to.eq(100n * 1_000_000n);
      expect((await registry.diggers(1)).bondAmount).to.eq(MIN_BOND - 100n * 1_000_000n);
      expect((await registry.diggers(1)).slashed).to.eq(false);
    });
    it("full slash sets slashed=true", async function () {
      await (await registry.connect(admin).slash(1, MIN_BOND, treasury.address, "rip")).wait();
      expect((await registry.diggers(1)).slashed).to.eq(true);
      expect((await registry.diggers(1)).bondAmount).to.eq(0);
    });
    it("only SLASHER_ROLE can slash", async function () {
      await expect(registry.connect(eve).slash(1, 1n, treasury.address, "x"))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
    it("rejects > bond", async function () {
      await expect(registry.connect(admin).slash(1, MIN_BOND + 1n, treasury.address, "x"))
        .to.be.revertedWithCustomError(registry, "InsufficientBond");
    });
  });

  describe("collection registration", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    });
    it("owner can register a collection", async function () {
      const tx = await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000);
      await expect(tx).to.emit(registry, "CollectionRegistered").withArgs(1, nftA, ZERO, 5000);
      const c = await registry.collections(nftA);
      expect(c.diggerId).to.eq(1);
      expect(c.maxLtvBps).to.eq(5000);
      expect(c.accepted).to.eq(true);
      expect(await registry.diggerCollectionCount(1)).to.eq(1);
    });
    it("non-owner cannot register under someone else's digger", async function () {
      await expect(registry.connect(eve).registerCollection(1, nftA, ZERO, 5000))
        .to.be.revertedWithCustomError(registry, "NotDiggerOwner");
    });
    it("rejects double-registration", async function () {
      await (await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000)).wait();
      await expect(registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });
    it("rejects LTV > 80% for FOREIGN", async function () {
      await expect(registry.connect(projectA).registerCollection(1, nftA, ZERO, 8001))
        .to.be.revertedWithCustomError(registry, "LtvCapExceeded");
    });
    it("admin can remove a collection (e.g. due to spam)", async function () {
      await (await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000)).wait();
      await (await registry.connect(admin).removeCollection(nftA)).wait();
      expect((await registry.collections(nftA)).accepted).to.eq(false);
    });
  });

  describe("read API consumed by Marketplace + Lending", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
      await (await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000)).wait();
      // nftB is registered with maxLtv=0 — listable but not collateral
      await (await registry.connect(projectA).registerCollection(1, nftB, ZERO, 0)).wait();
    });
    it("isListable true for both, isCollateral only for nftA", async function () {
      expect(await registry.isListable(nftA)).to.eq(true);
      expect(await registry.isListable(nftB)).to.eq(true);
      expect(await registry.isCollateral(nftA)).to.eq(true);
      expect(await registry.isCollateral(nftB)).to.eq(false);
    });
    it("paused digger blocks both views", async function () {
      await (await registry.connect(projectA).setDiggerPaused(1, true)).wait();
      expect(await registry.isListable(nftA)).to.eq(false);
      expect(await registry.isCollateral(nftA)).to.eq(false);
    });
    it("slashed digger blocks both views", async function () {
      await (await registry.connect(admin).slash(1, MIN_BOND, treasury.address, "x")).wait();
      expect(await registry.isListable(nftA)).to.eq(false);
      expect(await registry.isCollateral(nftA)).to.eq(false);
    });
    it("feeSplit returns the digger's split for accepted; falls back to 100% protocol if unknown", async function () {
      const [d, s, p] = await registry.feeSplit(nftA);
      expect(d).to.eq(2000); expect(s).to.eq(7000); expect(p).to.eq(1000);
      const unknownNft = ethers.Wallet.createRandom().address;
      const [d2, s2, p2] = await registry.feeSplit(unknownNft);
      expect(d2).to.eq(0); expect(s2).to.eq(0); expect(p2).to.eq(10_000);
    });
    it("diggerOwnerOf returns the project owner for accepted, 0 for unknown", async function () {
      expect(await registry.diggerOwnerOf(nftA)).to.eq(projectA.address);
      expect(await registry.diggerOwnerOf(ethers.Wallet.createRandom().address)).to.eq(ZERO);
    });
  });

  describe("transferDiggerOwner", function () {
    beforeEach(async function () {
      await (await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    });
    it("owner can transfer; new owner can pause", async function () {
      await (await registry.connect(projectA).transferDiggerOwner(1, projectB.address)).wait();
      expect((await registry.diggers(1)).owner).to.eq(projectB.address);
      await expect(registry.connect(projectA).setDiggerPaused(1, true))
        .to.be.revertedWithCustomError(registry, "NotDiggerOwner");
      await (await registry.connect(projectB).setDiggerPaused(1, true)).wait();
    });
    it("rejects zero new owner", async function () {
      await expect(registry.connect(projectA).transferDiggerOwner(1, ZERO))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  v2: CollectionClass.{FOREIGN, IN_HOUSE}
  // ═══════════════════════════════════════════════════════════════════
  describe("in-house collection class (v2)", function () {
    const IN_HOUSE = 1;
    const FOREIGN  = 0;

    it("admin registers an in-house collection with higher LTV (up to 90%)", async function () {
      const valueSource = ethers.Wallet.createRandom().address;
      await expect(registry.connect(admin).registerInHouseCollection(nftA, valueSource, 8500))
        .to.emit(registry, "InHouseCollectionRegistered").withArgs(nftA, valueSource, 8500);
      expect(await registry.classOf(nftA)).to.eq(IN_HOUSE);
      expect(await registry.isListable(nftA)).to.eq(true);
      expect(await registry.isCollateral(nftA)).to.eq(true);
    });

    it("in-house hard caps at 90% LTV", async function () {
      const valueSource = ethers.Wallet.createRandom().address;
      await expect(registry.connect(admin).registerInHouseCollection(nftA, valueSource, 9001))
        .to.be.revertedWithCustomError(registry, "LtvCapExceeded");
    });

    it("non-admin CANNOT register in-house collection", async function () {
      const valueSource = ethers.Wallet.createRandom().address;
      await expect(registry.connect(projectA).registerInHouseCollection(nftA, valueSource, 5000))
        .to.be.reverted;
    });

    it("in-house isListable is not affected by digger pause/slash (no digger)", async function () {
      const valueSource = ethers.Wallet.createRandom().address;
      await registry.connect(admin).registerInHouseCollection(nftA, valueSource, 7000);
      // Even if we had diggers, they wouldn't affect in-house — no digger
      // check for IN_HOUSE. Just confirm the view.
      expect(await registry.isListable(nftA)).to.eq(true);
    });

    it("in-house feeSplit routes digger's cut to protocol (0, 9000, 1000)", async function () {
      await registry.connect(admin).registerInHouseCollection(nftA, ethers.Wallet.createRandom().address, 7000);
      const [d, s, p] = await registry.feeSplit(nftA);
      expect(d).to.eq(0);
      expect(s).to.eq(9000);
      expect(p).to.eq(1000);
    });

    it("diggerOwnerOf for in-house returns protocol treasury", async function () {
      await registry.connect(admin).registerInHouseCollection(nftA, ethers.Wallet.createRandom().address, 7000);
      expect(await registry.diggerOwnerOf(nftA)).to.eq(await registry.protocolTreasury());
    });

    it("migrateToInHouse flips a FOREIGN collection to IN_HOUSE", async function () {
      await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000);
      await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000);
      expect(await registry.classOf(nftA)).to.eq(FOREIGN);
      await expect(registry.connect(admin).migrateToInHouse([nftA]))
        .to.emit(registry, "CollectionClassChanged").withArgs(nftA, FOREIGN, IN_HOUSE);
      expect(await registry.classOf(nftA)).to.eq(IN_HOUSE);
    });

    it("migrateToInHouse is idempotent (second call is a no-op)", async function () {
      await registry.connect(admin).registerInHouseCollection(nftA, ethers.Wallet.createRandom().address, 7000);
      // Already in-house; migrate again → no event, no revert.
      await registry.connect(admin).migrateToInHouse([nftA]);
      expect(await registry.classOf(nftA)).to.eq(IN_HOUSE);
    });

    it("non-admin cannot migrate", async function () {
      await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000);
      await registry.connect(projectA).registerCollection(1, nftA, ZERO, 5000);
      await expect(registry.connect(projectA).migrateToInHouse([nftA])).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Rescue — USDC bond-aware guard
  // ═══════════════════════════════════════════════════════════════════
  describe("rescue", function () {
    it("USDC rescue capped at balance - totalBondedUSDC", async function () {
      await registry.connect(projectA).openDigger(MIN_BOND, 1000, 7000, 2000);
      // MIN_BOND sits as active bond. Send 100 USDC extra as a stray.
      await usdc.mint(await registry.getAddress(), 100n * 10n ** 6n);

      // Exactly the stray amount is rescuable.
      await expect(registry.connect(admin).rescueToken(await usdc.getAddress(), admin.address, 100n * 10n ** 6n))
        .to.emit(registry, "TokenRescued");

      // One wei more = drain guard kicks in.
      await usdc.mint(await registry.getAddress(), 5n);
      await expect(
        registry.connect(admin).rescueToken(await usdc.getAddress(), admin.address, 6n)
      ).to.be.revertedWithCustomError(registry, "WouldDrainBonds");
    });

    it("rescue non-USDC tokens freely", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const other = await MockUSDC.deploy();
      await other.mint(await registry.getAddress(), 100n * 10n ** 6n);
      await registry.connect(admin).rescueToken(await other.getAddress(), admin.address, 100n * 10n ** 6n);
      expect(await other.balanceOf(admin.address)).to.eq(100n * 10n ** 6n);
    });

    it("non-admin cannot rescue", async function () {
      await expect(
        registry.connect(projectA).rescueToken(await usdc.getAddress(), projectA.address, 0n)
      ).to.be.reverted;
    });
  });
});
