// End-to-end-ish coverage for RoyaltyRouter + EcosystemMarketplace, sitting
// on top of DiggerRegistry. Tests the seller / buyer / liquidator paths,
// the digger pull-claim, the fee math, the listability gating, and the
// emergency hooks.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0x" + "0".repeat(64);

describe("EcosystemMarketplace + RoyaltyRouter flow", function () {
  this.timeout(60_000);

  const MIN_BOND = 1_000n * 10n ** 6n;

  let admin, treasury, project, alice, bob, carol;
  let usdc, registry, router, marketplace, nft;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, carol] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();
    await usdc.waitForDeployment();

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);
    await registry.waitForDeployment();

    const RR = await ethers.getContractFactory("RoyaltyRouter");
    router = await RR.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), treasury.address);
    await router.waitForDeployment();

    const M = await ethers.getContractFactory("EcosystemMarketplace");
    marketplace = await M.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), await router.getAddress());
    await marketplace.waitForDeployment();

    // Deploy a real ERC721 — we'll repurpose HyperSkin since the codebase
    // has it, but anything ERC721 works. Easier: deploy a tiny MockERC721.
    const NF = await ethers.getContractFactory("MockERC721");
    nft = await NF.deploy("Mock", "M");
    await nft.waitForDeployment();

    // Fund project for bond, alice + bob for buys.
    for (const u of [project, alice, bob, carol]) {
      await (await usdc.mint(u.address, 100_000n * 10n ** 6n)).wait();
      await (await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(u).approve(await marketplace.getAddress(), ethers.MaxUint256)).wait();
    }

    // Project opens digger, registers the NFT collection.
    await (await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000)).wait();
    await (await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000)).wait();

    // Alice owns tokenId #1, approves marketplace.
    await (await nft.mint(alice.address)).wait();
    await (await nft.connect(alice).setApprovalForAll(await marketplace.getAddress(), true)).wait();
  });

  describe("list + cancel", function () {
    it("list escrows the NFT and records the listing", async function () {
      const tx = await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n * 10n ** 6n, 0);
      const rc = await tx.wait();
      // Listing stored
      const l = await marketplace.listings(1);
      expect(l.seller).to.eq(alice.address);
      expect(l.priceUSDC).to.eq(100n * 10n ** 6n);
      expect(l.active).to.eq(true);
      // NFT escrowed
      expect(await nft.ownerOf(1)).to.eq(await marketplace.getAddress());
      // activeListingOf populated
      expect(await marketplace.activeListingOf(await nft.getAddress(), 1)).to.eq(1);
      await expect(tx).to.emit(marketplace, "Listed");
    });

    it("rejects list if collection not registered", async function () {
      const NF2 = await ethers.getContractFactory("MockERC721");
      const nft2 = await NF2.deploy("X", "X");
      await nft2.waitForDeployment();
      await (await nft2.mint(alice.address)).wait();
      await (await nft2.connect(alice).setApprovalForAll(await marketplace.getAddress(), true)).wait();
      await expect(marketplace.connect(alice).list(await nft2.getAddress(), 1n, 100n, 0))
        .to.be.revertedWithCustomError(marketplace, "NotListable");
    });

    it("rejects double-listing the same tokenId", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0)).wait();
      // Even with a fresh approval, the tokenId is already escrowed → seller no longer owns it
      await expect(marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0))
        .to.be.revertedWithCustomError(marketplace, "AlreadyListed");
    });

    it("cancel returns the NFT", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0)).wait();
      await (await marketplace.connect(alice).cancel(1)).wait();
      expect(await nft.ownerOf(1)).to.eq(alice.address);
      expect((await marketplace.listings(1)).active).to.eq(false);
      expect(await marketplace.activeListingOf(await nft.getAddress(), 1)).to.eq(0);
    });

    it("only seller can cancel", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0)).wait();
      await expect(marketplace.connect(bob).cancel(1))
        .to.be.revertedWithCustomError(marketplace, "NotSeller");
    });

    it("setPrice updates the listing", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0)).wait();
      await (await marketplace.connect(alice).setPrice(1, 200n)).wait();
      expect((await marketplace.listings(1)).priceUSDC).to.eq(200n);
    });
  });

  describe("buy", function () {
    const PRICE = 1_000n * 10n ** 6n; // 1,000 USDC

    beforeEach(async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, 0)).wait();
    });

    it("transfers NFT to buyer, USDC to seller (minus fee), routes fee per digger split", async function () {
      const fee = (PRICE * 250n) / 10_000n; // 2.5% protocol fee
      const sellerBefore = await usdc.balanceOf(alice.address);

      await (await marketplace.connect(bob).buy(1)).wait();

      // NFT moved to buyer
      expect(await nft.ownerOf(1)).to.eq(bob.address);
      // Seller received price - fee
      const sellerAfter = await usdc.balanceOf(alice.address);
      expect(sellerAfter - sellerBefore).to.eq(PRICE - fee);
      // Listing closed
      expect((await marketplace.listings(1)).active).to.eq(false);
      // Active mapping cleared
      expect(await marketplace.activeListingOf(await nft.getAddress(), 1)).to.eq(0);

      // Fee split: digger=20% supplier=70% protocol=10% (of fee)
      const toDigger   = (fee * 2000n) / 10_000n;
      const toSupplier = (fee * 7000n) / 10_000n;
      const toProtocol = fee - toDigger - toSupplier;
      // Supplier currently routes to treasury (lendingPool unset)
      expect(await usdc.balanceOf(treasury.address)).to.eq(toSupplier + toProtocol);
      // Digger cut queued for project
      expect(await router.pendingForDigger(project.address)).to.eq(toDigger);
    });

    it("project claims their digger cut", async function () {
      await (await marketplace.connect(bob).buy(1)).wait();
      const pBefore = await usdc.balanceOf(project.address);
      const pending = await router.pendingForDigger(project.address);
      await (await router.connect(project).claimDigger()).wait();
      const pAfter = await usdc.balanceOf(project.address);
      expect(pAfter - pBefore).to.eq(pending);
      expect(await router.pendingForDigger(project.address)).to.eq(0);
    });

    it("rejects buy when listing not listable (digger paused after list)", async function () {
      await (await registry.connect(project).setDiggerPaused(1, true)).wait();
      await expect(marketplace.connect(bob).buy(1))
        .to.be.revertedWithCustomError(marketplace, "NotListable");
    });

    it("rejects expired listing", async function () {
      // Re-list with expiry already past
      await (await marketplace.connect(alice).cancel(1)).wait();
      await (await nft.connect(alice).setApprovalForAll(await marketplace.getAddress(), true)).wait();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, PRICE, BigInt(now) + 10n)).wait();
      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);
      await expect(marketplace.connect(bob).buy(2))
        .to.be.revertedWithCustomError(marketplace, "Expired");
    });

    it("paused marketplace blocks buy", async function () {
      await (await marketplace.connect(admin).setPaused(true)).wait();
      await expect(marketplace.connect(bob).buy(1))
        .to.be.revertedWithCustomError(marketplace, "PausedErr");
    });
  });

  describe("admin", function () {
    it("setProtocolFee respects MAX_FEE_BPS", async function () {
      await expect(marketplace.connect(admin).setProtocolFee(1001))
        .to.be.revertedWithCustomError(marketplace, "FeeTooHigh");
      await (await marketplace.connect(admin).setProtocolFee(500)).wait();
      expect(await marketplace.protocolFeeBps()).to.eq(500);
    });

    it("emergencyReturn returns NFT to seller", async function () {
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 100n, 0)).wait();
      await (await marketplace.connect(admin).emergencyReturn(1)).wait();
      expect(await nft.ownerOf(1)).to.eq(alice.address);
    });
  });

  describe("RoyaltyRouter sink config", function () {
    it("setLendingPool routes supplier cut to that address instead of treasury", async function () {
      await (await router.connect(admin).setLendingPool(carol.address)).wait();
      await (await marketplace.connect(alice).list(await nft.getAddress(), 1n, 1_000n * 10n ** 6n, 0)).wait();

      const carolBefore = await usdc.balanceOf(carol.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);

      await (await marketplace.connect(bob).buy(1)).wait();

      const fee = (1_000n * 10n ** 6n * 250n) / 10_000n;
      const toSupplier = (fee * 7000n) / 10_000n;
      const toProtocol = fee - (fee * 2000n) / 10_000n - toSupplier;

      expect((await usdc.balanceOf(carol.address)) - carolBefore).to.eq(toSupplier);
      expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.eq(toProtocol);
    });

    it("revenue from unregistered nft routes 100% to treasury", async function () {
      // Send 100 USDC of "revenue" through router for an unregistered NFT.
      const unknownNft = ethers.Wallet.createRandom().address;
      await (await usdc.mint(carol.address, 100n * 10n ** 6n)).wait();
      await (await usdc.connect(carol).approve(await router.getAddress(), 100n * 10n ** 6n)).wait();

      const before = await usdc.balanceOf(treasury.address);
      await (await router.connect(carol).routeRevenue(unknownNft, 100n * 10n ** 6n)).wait();
      const after = await usdc.balanceOf(treasury.address);
      expect(after - before).to.eq(100n * 10n ** 6n);
    });
  });

  describe("liquidationList (LendingPool integration hook)", function () {
    it("requires LIQUIDATOR_ROLE", async function () {
      await expect(marketplace.connect(bob).liquidationList(await nft.getAddress(), 1n, 100n, 0))
        .to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");
    });

    it("LIQUIDATOR_ROLE can list a pre-escrowed NFT", async function () {
      // Grant role to bob (would be the LendingPool).
      const role = await marketplace.LIQUIDATOR_ROLE();
      await (await marketplace.connect(admin).grantRole(role, bob.address)).wait();

      // Bob 'recovers' the NFT (as the LendingPool would after liquidation).
      // First mint a new tokenId to bob, then transfer it into the marketplace.
      await (await nft.mint(bob.address)).wait();
      const tokenId = 2n;
      await (await nft.connect(bob)["safeTransferFrom(address,address,uint256)"](bob.address, await marketplace.getAddress(), tokenId)).wait();

      const tx = await marketplace.connect(bob).liquidationList(await nft.getAddress(), tokenId, 500n * 10n ** 6n, 0);
      await tx.wait();
      const l = await marketplace.listings(1);
      expect(l.seller).to.eq(bob.address);
      expect(l.priceUSDC).to.eq(500n * 10n ** 6n);
      expect(await nft.ownerOf(tokenId)).to.eq(await marketplace.getAddress());
    });
  });
});
