// Coverage for EcosystemMarketplaceV3 — the non-custodial, sponsored-fill
// marketplace. Verifies seller never loses NFT custody during listing,
// fillFor delivers to any beneficiary, fee math matches v2, and isFillable
// catches every degenerate state without simulating a full fill.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";

describe("EcosystemMarketplaceV3 — non-custodial + sponsored fill", function () {
  this.timeout(60_000);

  const MIN_BOND = 1_000n * 10n ** 6n;
  const PRICE = 100n * 10n ** 6n;             // 100 USDC
  const FEE_BPS = 250n;                        // 2.5%
  const EXPECTED_FEE = (PRICE * FEE_BPS) / 10_000n;
  const EXPECTED_TO_SELLER = PRICE - EXPECTED_FEE;

  let admin, treasury, project, alice, bob, carol, sponsor;
  let usdc, registry, router, marketplace, nft;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, carol, sponsor] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);
    await registry.waitForDeployment();

    const RR = await ethers.getContractFactory("RoyaltyRouter");
    router = await RR.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), treasury.address);
    await router.waitForDeployment();

    const M = await ethers.getContractFactory("EcosystemMarketplaceV3");
    marketplace = await M.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), await router.getAddress());
    await marketplace.waitForDeployment();

    const NF = await ethers.getContractFactory("MockERC721");
    nft = await NF.deploy("Mock", "M");
    await nft.waitForDeployment();

    // Fund project for bond, buyers + sponsor for fills.
    for (const u of [project, alice, bob, carol, sponsor]) {
      await (await usdc.mint(u.address, 100_000n * 10n ** 6n)).wait();
      await (await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await marketplace.getAddress(), ethers.MaxUint256)).wait();
    }

    // Project opens digger, registers the NFT collection.
    await (await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    await (await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000)).wait();

    // Alice owns tokenId #1 and approves the marketplace to move her tokens.
    await (await nft.mint(alice.address)).wait();
    await (await nft.connect(alice).setApprovalForAll(await marketplace.getAddress(), true)).wait();
  });

  // ───────────────────────────── list / cancel / setPrice ──────────────

  describe("list (no escrow)", function () {
    it("records the order WITHOUT taking custody of the NFT", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      // Order recorded
      const o = await marketplace.orders(1);
      expect(o.seller).to.eq(alice.address);
      expect(o.priceUSDC).to.eq(PRICE);
      expect(o.active).to.eq(true);
      // Critical v3 invariant: NFT is still in seller's wallet
      expect(await nft.ownerOf(1)).to.eq(alice.address);
      expect(await marketplace.activeOrderOf(await nft.getAddress(), 1)).to.eq(1);
    });

    it("rejects list if collection not registered", async function () {
      const NF2 = await ethers.getContractFactory("MockERC721");
      const nft2 = await NF2.deploy("X", "X");
      await nft2.waitForDeployment();
      await (await nft2.mint(alice.address)).wait();
      await expect(marketplace.connect(alice).list(await nft2.getAddress(), 1n, PRICE, 0))
        .to.be.revertedWithCustomError(marketplace, "NotListable");
    });

    it("rejects list with zero price", async function () {
      await expect(marketplace.connect(alice).list(await nft.getAddress(), 1n, 0, 0))
        .to.be.revertedWithCustomError(marketplace, "ZeroPrice");
    });

    it("rejects list by non-owner", async function () {
      await expect(marketplace.connect(bob).list(await nft.getAddress(), 1n, PRICE, 0))
        .to.be.revertedWithCustomError(marketplace, "NotOwner");
    });

    it("rejects double-list of the same tokenId", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      await expect(marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0))
        .to.be.revertedWithCustomError(marketplace, "AlreadyListed");
    });
  });

  describe("cancel", function () {
    beforeEach(async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
    });

    it("flips order inactive — no NFT motion needed (was never escrowed)", async function () {
      const before = await nft.ownerOf(1);
      await (await marketplace.connect(alice).cancel(1)).wait();
      expect(await nft.ownerOf(1)).to.eq(before);
      expect((await marketplace.orders(1)).active).to.eq(false);
      expect(await marketplace.activeOrderOf(await nft.getAddress(), 1)).to.eq(0);
    });

    it("rejects cancel by non-seller", async function () {
      await expect(marketplace.connect(bob).cancel(1))
        .to.be.revertedWithCustomError(marketplace, "NotSeller");
    });

    it("rejects cancel of inactive order", async function () {
      await (await marketplace.connect(alice).cancel(1)).wait();
      await expect(marketplace.connect(alice).cancel(1))
        .to.be.revertedWithCustomError(marketplace, "OrderNotActive");
    });

    it("seller can re-list after cancelling", async function () {
      await (await marketplace.connect(alice).cancel(1)).wait();
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE * 2n, 0)).wait();
      const o = await marketplace.orders(2);
      expect(o.active).to.eq(true);
      expect(o.priceUSDC).to.eq(PRICE * 2n);
    });
  });

  describe("setPrice", function () {
    beforeEach(async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
    });

    it("seller can update price", async function () {
      await (await marketplace.connect(alice).setPrice(1, PRICE * 2n)).wait();
      expect((await marketplace.orders(1)).priceUSDC).to.eq(PRICE * 2n);
    });

    it("non-seller cannot update price", async function () {
      await expect(marketplace.connect(bob).setPrice(1, PRICE * 2n))
        .to.be.revertedWithCustomError(marketplace, "NotSeller");
    });

    it("rejects zero price", async function () {
      await expect(marketplace.connect(alice).setPrice(1, 0))
        .to.be.revertedWithCustomError(marketplace, "ZeroPrice");
    });
  });

  // ────────────────────────── fill / fillFor ─────────────────────────

  describe("fill (buy for self)", function () {
    beforeEach(async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
    });

    it("transfers NFT directly from seller to buyer (no escrow hop)", async function () {
      const sellerUsdcBefore = await usdc.balanceOf(alice.address);

      await (await marketplace.connect(bob).fill(1)).wait();

      // NFT is with bob
      expect(await nft.ownerOf(1)).to.eq(bob.address);
      // Seller got priceUSDC - fee
      expect(await usdc.balanceOf(alice.address)).to.eq(sellerUsdcBefore + EXPECTED_TO_SELLER);
      // Order is inactive
      expect((await marketplace.orders(1)).active).to.eq(false);
      expect(await marketplace.activeOrderOf(await nft.getAddress(), 1)).to.eq(0);
    });

    it("fee math matches v2: 2.5% routed via RoyaltyRouter", async function () {
      const sellerBefore = await usdc.balanceOf(alice.address);
      const buyerBefore = await usdc.balanceOf(bob.address);

      await (await marketplace.connect(bob).fill(1)).wait();

      expect(await usdc.balanceOf(alice.address) - sellerBefore).to.eq(EXPECTED_TO_SELLER);
      expect(buyerBefore - await usdc.balanceOf(bob.address)).to.eq(PRICE);
      // RoyaltyRouter accumulated the fee; nothing stuck on the marketplace.
      expect(await usdc.balanceOf(await marketplace.getAddress())).to.eq(0);
    });

    it("emits Filled with payer == beneficiary == msg.sender", async function () {
      await expect(marketplace.connect(bob).fill(1))
        .to.emit(marketplace, "Filled")
        .withArgs(1, bob.address, bob.address, alice.address, PRICE, EXPECTED_FEE);
    });

    it("rejects fill of inactive order", async function () {
      await (await marketplace.connect(alice).cancel(1)).wait();
      await expect(marketplace.connect(bob).fill(1))
        .to.be.revertedWithCustomError(marketplace, "OrderNotActive");
    });

    it("rejects fill after expiry", async function () {
      await (await marketplace.connect(alice).cancel(1)).wait();
      const past = BigInt(Math.floor(Date.now() / 1000) - 60);
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, past)).wait();
      await expect(marketplace.connect(bob).fill(2))
        .to.be.revertedWithCustomError(marketplace, "Expired");
    });

    it("reverts atomically if seller transferred the NFT away", async function () {
      // Alice yanks the NFT to carol after listing — fill must revert
      // with everything intact (no USDC pulled, no partial state).
      await (await nft.connect(alice).transferFrom(alice.address, carol.address, 1)).wait();
      const buyerBefore = await usdc.balanceOf(bob.address);
      await expect(marketplace.connect(bob).fill(1)).to.be.reverted;
      expect(await usdc.balanceOf(bob.address)).to.eq(buyerBefore);   // no money taken
      expect(await nft.ownerOf(1)).to.eq(carol.address);              // NFT untouched
    });

    it("reverts atomically if seller revoked approval", async function () {
      await (await nft.connect(alice).setApprovalForAll(await marketplace.getAddress(), false)).wait();
      const buyerBefore = await usdc.balanceOf(bob.address);
      await expect(marketplace.connect(bob).fill(1)).to.be.reverted;
      expect(await usdc.balanceOf(bob.address)).to.eq(buyerBefore);
    });

    it("respects pause", async function () {
      await (await marketplace.connect(admin).setPaused(true)).wait();
      await expect(marketplace.connect(bob).fill(1))
        .to.be.revertedWithCustomError(marketplace, "PausedErr");
    });
  });

  describe("fillFor (sponsored)", function () {
    beforeEach(async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
    });

    it("sponsor pays USDC, beneficiary receives the NFT", async function () {
      const sponsorUsdcBefore = await usdc.balanceOf(sponsor.address);
      const beneficiaryUsdcBefore = await usdc.balanceOf(carol.address);

      await (await marketplace.connect(sponsor).fillFor(1, carol.address)).wait();

      expect(await nft.ownerOf(1)).to.eq(carol.address);
      // Sponsor paid the full PRICE
      expect(sponsorUsdcBefore - await usdc.balanceOf(sponsor.address)).to.eq(PRICE);
      // Beneficiary paid nothing
      expect(await usdc.balanceOf(carol.address)).to.eq(beneficiaryUsdcBefore);
    });

    it("emits Filled with distinct payer and beneficiary", async function () {
      await expect(marketplace.connect(sponsor).fillFor(1, carol.address))
        .to.emit(marketplace, "Filled")
        .withArgs(1, sponsor.address, carol.address, alice.address, PRICE, EXPECTED_FEE);
    });

    it("rejects beneficiary == 0", async function () {
      await expect(marketplace.connect(sponsor).fillFor(1, ZERO))
        .to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });

    it("seller can fill on behalf of someone else (e.g. as a refund delivery)", async function () {
      // Seller=alice acts as sponsor and delivers the NFT to bob.
      // Fee math still applies — alice pays priceUSDC and gets back
      // priceUSDC - fee, so net fee is what she contributes.
      const aliceBefore = await usdc.balanceOf(alice.address);
      await (await marketplace.connect(alice).fillFor(1, bob.address)).wait();
      expect(await nft.ownerOf(1)).to.eq(bob.address);
      // Net cost to alice = fee
      expect(aliceBefore - await usdc.balanceOf(alice.address)).to.eq(EXPECTED_FEE);
    });
  });

  // ───────────────────────── isFillable view ─────────────────────────

  describe("isFillable view", function () {
    it("true for a fresh listing", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      expect(await marketplace.isFillable(1)).to.eq(true);
    });

    it("false after cancel", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      await (await marketplace.connect(alice).cancel(1)).wait();
      expect(await marketplace.isFillable(1)).to.eq(false);
    });

    it("false after seller transfers NFT away", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      await (await nft.connect(alice).transferFrom(alice.address, carol.address, 1)).wait();
      expect(await marketplace.isFillable(1)).to.eq(false);
    });

    it("false after seller revokes approval", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      await (await nft.connect(alice).setApprovalForAll(await marketplace.getAddress(), false)).wait();
      expect(await marketplace.isFillable(1)).to.eq(false);
    });

    it("false when paused", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
      await (await marketplace.connect(admin).setPaused(true)).wait();
      expect(await marketplace.isFillable(1)).to.eq(false);
    });

    it("false past expiry", async function () {
      const past = BigInt(Math.floor(Date.now() / 1000) - 60);
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, past)).wait();
      expect(await marketplace.isFillable(1)).to.eq(false);
    });
  });

  // ─────────────────────────── admin ────────────────────────────────

  describe("admin", function () {
    it("setProtocolFeeBps respects MAX_FEE_BPS", async function () {
      await (await marketplace.connect(admin).setProtocolFeeBps(100)).wait();
      expect(await marketplace.protocolFeeBps()).to.eq(100);
      await expect(marketplace.connect(admin).setProtocolFeeBps(2_000))
        .to.be.revertedWithCustomError(marketplace, "FeeTooHigh");
    });

    it("non-admin cannot setProtocolFeeBps", async function () {
      await expect(marketplace.connect(bob).setProtocolFeeBps(100)).to.be.reverted;
    });

    it("non-pauser cannot setPaused", async function () {
      await expect(marketplace.connect(bob).setPaused(true)).to.be.reverted;
    });
  });
});
