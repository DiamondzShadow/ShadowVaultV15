// LendingPool v1.4 + NFTValuer VAULT_MIRROR mode integration.
//
// Flow under test: an Arb-side wrapper NFT (exposes IVaultValue via
// estimatePositionValue but has no vault-unwind path) gets used as lending
// collateral. When the loan goes underwater, liquidation escrows the wrapper
// into EcosystemMarketplace and opens a liquidationList. Buyer purchases
// → completeMarketplaceLiquidation settles the debt from sale proceeds.
//
// Also tests the unwind path: if the marketplace listing gets emergency-
// returned by admin, the loan restores to ACTIVE (not closed) and the
// wrapper is back in the pool as collateral.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;

describe("LendingPool v1.4 — MARKETPLACE_AUCTION liquidation", function () {
  this.timeout(90_000);

  let admin, treasury, project, alice, bob, buyer;
  let usdc, registry, router, marketplace, valuer, pool;
  let wrapperNft; // stand-in for ArbPositionWrapper — exposes estimatePositionValue

  beforeEach(async function () {
    [admin, treasury, project, alice, bob, buyer] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);

    const RR = await ethers.getContractFactory("RoyaltyRouter");
    router = await RR.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), treasury.address);

    const M = await ethers.getContractFactory("EcosystemMarketplace");
    marketplace = await M.deploy(admin.address, await usdc.getAddress(), await registry.getAddress(), await router.getAddress());

    const V = await ethers.getContractFactory("NFTValuer");
    valuer = await V.deploy(admin.address, await registry.getAddress());

    const L = await ethers.getContractFactory("LendingPool");
    pool = await L.deploy(admin.address, await usdc.getAddress(), await registry.getAddress());

    // Wire valuer + marketplace into pool
    await pool.setValuer(await valuer.getAddress());
    await pool.setMarketplace(await marketplace.getAddress());

    // Grant LIQUIDATOR_ROLE to pool so it can call marketplace.liquidationList
    const LIQUIDATOR = await marketplace.LIQUIDATOR_ROLE();
    await marketplace.grantRole(LIQUIDATOR, await pool.getAddress());

    // Deploy a mock wrapper NFT that implements IVaultValue
    // (MockPositionVault-like but is itself the ERC721). We'll use the
    // existing MockPositionNFT + MockPositionVault pair, treating the vault
    // itself as the "value source" for the VAULT_MIRROR config.
    const MV = await ethers.getContractFactory("MockPositionVault");
    const mockVault = await MV.deploy(await usdc.getAddress());
    const MN = await ethers.getContractFactory("MockPositionNFT");
    wrapperNft = await MN.deploy("Wrapper", "W", await mockVault.getAddress());

    // Fund everyone
    for (const u of [project, alice, bob, buyer]) {
      await usdc.mint(u.address, 100_000n * ONE_USDC);
      await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256);
      await usdc.connect(u).approve(await pool.getAddress(), ethers.MaxUint256);
      await usdc.connect(u).approve(await marketplace.getAddress(), ethers.MaxUint256);
    }

    // Project opens digger + registers the wrapper collection at 50% LTV
    await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000);
    await registry.connect(project).registerCollection(1, await wrapperNft.getAddress(), ZERO, 5000);

    // Configure valuer in VAULT_MIRROR mode — wrapper uses mockVault as its
    // value source but strategy must be MARKETPLACE_AUCTION.
    await valuer.setMirrorMode(
      await wrapperNft.getAddress(),
      await mockVault.getAddress(),
      0 // no clamp
    );

    // Mint wrapper #1 to bob, set its value to $10k
    await wrapperNft.mint(bob.address);
    await mockVault.setValue(1n, 10_000n * ONE_USDC);
    await wrapperNft.connect(bob).setApprovalForAll(await pool.getAddress(), true);

    // Alice seeds liquidity
    await pool.connect(alice).supply(50_000n * ONE_USDC);
  });

  describe("borrow against a MARKETPLACE_AUCTION collateral", function () {
    it("succeeds when valuer says MARKETPLACE_AUCTION and marketplace is wired", async function () {
      const tx = await pool.connect(bob).borrow(await wrapperNft.getAddress(), 1n, 4_000n * ONE_USDC);
      await expect(tx).to.emit(pool, "Borrowed");
      // Loan snapshotted with liqStrategy = 1 (MARKETPLACE_AUCTION)
      const L = await pool.loans(1n);
      expect(L.liqStrategy).to.eq(1);
      expect(L.unwindTarget).to.eq(ZERO); // no vault-unwind for wrapper
    });

    it("fails with MarketplaceNotSet if admin unsets marketplace", async function () {
      await pool.setMarketplace(ZERO);
      await expect(pool.connect(bob).borrow(await wrapperNft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "MarketplaceNotSet");
    });
  });

  describe("triggerLiquidation → MARKETPLACE_AUCTION path", function () {
    beforeEach(async function () {
      await pool.connect(bob).borrow(await wrapperNft.getAddress(), 1n, 4_000n * ONE_USDC);
      // advance past minLoanDuration
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine", []);
    });

    it("escrows NFT into marketplace + opens liquidationList at 90% of value", async function () {
      // Crash value to $3k to go underwater (debt ~$4k > liq threshold on $3k)
      const MV = await ethers.getContractAt("MockPositionVault", await (await valuer.configOf(await wrapperNft.getAddress()))[1]);
      await MV.setValue(1n, 3_000n * ONE_USDC);

      const tx = await pool.connect(alice).triggerLiquidation(1n);
      await expect(tx).to.emit(pool, "MarketplaceLiquidationTriggered");

      // Marketplace now holds the NFT
      expect(await wrapperNft.ownerOf(1n)).to.eq(await marketplace.getAddress());

      // Loan state
      const L = await pool.loans(1n);
      expect(L.status).to.eq(2); // LIQUIDATING
      expect(L.auctionListingId).to.be.gt(0);
      expect(L.auctionPriceUSDC).to.eq((3_000n * ONE_USDC * 9_000n) / 10_000n); // 90% markdown
    });

    it("completeMarketplaceLiquidation after buyer purchases: debt cleared + surplus to borrower", async function () {
      // Crash + trigger
      const mockVaultAddr = (await valuer.configOf(await wrapperNft.getAddress()))[1];
      const MV = await ethers.getContractAt("MockPositionVault", mockVaultAddr);
      await MV.setValue(1n, 5_000n * ONE_USDC); // soft crash: $5k still > $4k debt
      // Make loan underwater via debt drift — raise value back up after interest accrues
      await MV.setValue(1n, 3_500n * ONE_USDC);
      await pool.connect(alice).triggerLiquidation(1n);

      const L0 = await pool.loans(1n);
      const listingId = L0.auctionListingId;
      const listingPrice = L0.auctionPriceUSDC;

      // Buyer buys the liquidation listing
      await marketplace.connect(buyer).buy(listingId);
      expect(await wrapperNft.ownerOf(1n)).to.eq(buyer.address);

      // Complete the liquidation
      const tx = await pool.connect(alice).completeMarketplaceLiquidation(1n);
      await expect(tx).to.emit(pool, "MarketplaceLiquidationSettled");

      const L1 = await pool.loans(1n);
      expect(L1.status).to.eq(3); // CLOSED
      expect(L1.principal).to.eq(0);
    });

    it("reverts with AuctionStillActive if listing still open", async function () {
      const mockVaultAddr = (await valuer.configOf(await wrapperNft.getAddress()))[1];
      const MV = await ethers.getContractAt("MockPositionVault", mockVaultAddr);
      await MV.setValue(1n, 3_000n * ONE_USDC);
      await pool.connect(alice).triggerLiquidation(1n);

      await expect(pool.connect(alice).completeMarketplaceLiquidation(1n))
        .to.be.revertedWithCustomError(pool, "AuctionStillActive");
    });

    it("emergency-return unwinds liquidation: loan back to ACTIVE, NFT back with pool", async function () {
      const mockVaultAddr = (await valuer.configOf(await wrapperNft.getAddress()))[1];
      const MV = await ethers.getContractAt("MockPositionVault", mockVaultAddr);
      await MV.setValue(1n, 3_000n * ONE_USDC);
      await pool.connect(alice).triggerLiquidation(1n);

      const L0 = await pool.loans(1n);
      const listingId = L0.auctionListingId;

      // Marketplace admin emergency-returns the NFT. The "seller" in the
      // liquidationList call was the LendingPool → emergencyReturn sends NFT
      // back to the LendingPool.
      await marketplace.connect(admin).emergencyReturn(listingId);
      expect(await wrapperNft.ownerOf(1n)).to.eq(await pool.getAddress());

      // Listing is now inactive — completeMarketplaceLiquidation should detect
      // the NFT came back and unwind liquidation rather than settle it.
      const tx = await pool.connect(alice).completeMarketplaceLiquidation(1n);
      await expect(tx).to.emit(pool, "MarketplaceLiquidationUnwound");

      const L1 = await pool.loans(1n);
      expect(L1.status).to.eq(1); // ACTIVE again
      expect(L1.auctionListingId).to.eq(0);
    });
  });

  describe("completeLiquidation must NOT fire for MARKETPLACE_AUCTION loans", function () {
    it("reverts NotAuctionLiquidation", async function () {
      await pool.connect(bob).borrow(await wrapperNft.getAddress(), 1n, 4_000n * ONE_USDC);
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine", []);

      const mockVaultAddr = (await valuer.configOf(await wrapperNft.getAddress()))[1];
      const MV = await ethers.getContractAt("MockPositionVault", mockVaultAddr);
      await MV.setValue(1n, 3_000n * ONE_USDC);
      await pool.connect(alice).triggerLiquidation(1n);

      // Cannot use VAULT_UNWIND path on a MARKETPLACE_AUCTION loan.
      await expect(pool.connect(alice).completeLiquidation(1n))
        .to.be.revertedWithCustomError(pool, "NotAuctionLiquidation");
    });
  });

  describe("admin params", function () {
    it("setAuctionParams rejects out-of-range values", async function () {
      await expect(pool.setAuctionParams(4_999, 86400)).to.be.revertedWithCustomError(pool, "BadParam");
      await expect(pool.setAuctionParams(10_001, 86400)).to.be.revertedWithCustomError(pool, "BadParam");
      await expect(pool.setAuctionParams(9_000, 59 * 60)).to.be.revertedWithCustomError(pool, "BadParam");
      await expect(pool.setAuctionParams(9_000, 31 * 24 * 60 * 60)).to.be.revertedWithCustomError(pool, "BadParam");
    });
    it("setAuctionParams accepts valid values + emits", async function () {
      await expect(pool.setAuctionParams(8_500, 10 * 24 * 60 * 60))
        .to.emit(pool, "AuctionParamsUpdated").withArgs(8_500, 10 * 24 * 60 * 60);
      expect(await pool.auctionStartMarkdownBps()).to.eq(8_500);
      expect(await pool.auctionExpirySec()).to.eq(10 * 24 * 60 * 60);
    });
  });
});
