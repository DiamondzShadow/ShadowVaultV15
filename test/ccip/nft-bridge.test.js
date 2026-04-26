// CCIP Polygon↔Arb NFT bridge integration test.
// Uses paired MockCCIPRouters that relay messages in-tx between the two
// "chains" (both simulated in the same EVM for test purposes).
//
// Coverage:
//  - lockAndBridge pulls the NFT, emits Locked_ and CCIP sends to wrapper
//  - wrapper mints a deterministic tokenId with initial value snapshot
//  - pushValueUpdate refreshes stored value on Arb side
//  - estimatePositionValue() reflects latest pushed value (IVaultValue compat)
//  - burnAndRedeem burns wrapper + CCIP message releases the original NFT
//  - access control: non-router rejected, bad source chain rejected, bad sender rejected
//  - unknown CCIP action rejected

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const POLY_SELECTOR = 4051577828743386545n;
const ARB_SELECTOR  = 4949039107694359620n;
const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_USDC = 10n ** 6n;

describe("CCIP NFT bridge — Polygon → Arb lock-and-mint", function () {
  this.timeout(60_000);

  let admin, keeper, alice, bob;
  let polyRouter, arbRouter;
  let polyNft, polyVault;
  let locker, wrapper;

  beforeEach(async function () {
    [admin, keeper, alice, bob] = await ethers.getSigners();

    // Paired mock routers
    const Router = await ethers.getContractFactory("MockCCIPRouter");
    polyRouter = await Router.deploy();
    arbRouter  = await Router.deploy();
    await polyRouter.setPaired(await arbRouter.getAddress(), POLY_SELECTOR);
    await arbRouter.setPaired(await polyRouter.getAddress(), ARB_SELECTOR);

    // Polygon side: a mock position NFT + a mock vault
    const PV = await ethers.getContractFactory("MockPositionVault");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const polyUsdc = await MockUSDC.deploy();
    polyVault = await PV.deploy(await polyUsdc.getAddress());
    const PN = await ethers.getContractFactory("MockPositionNFT");
    polyNft = await PN.deploy("Poly", "P", await polyVault.getAddress());

    // Deploy locker on "Polygon" — uses polyRouter
    const L = await ethers.getContractFactory("PolygonNFTLocker");
    locker = await L.deploy(admin.address, keeper.address, await polyRouter.getAddress(), ARB_SELECTOR, ZERO);

    // Deploy wrapper on "Arb" — uses arbRouter
    const W = await ethers.getContractFactory("ArbPositionWrapper");
    wrapper = await W.deploy(admin.address, await arbRouter.getAddress(), POLY_SELECTOR, ZERO);

    // Wire: locker knows arbWrapper, wrapper knows polygonLocker, vaultOf wired
    await locker.setArbWrapper(await wrapper.getAddress());
    await wrapper.setPolygonLocker(await locker.getAddress());
    await locker.setVaultFor(await polyNft.getAddress(), await polyVault.getAddress());

    // Mint NFT to alice and seed a vault value
    await polyNft.mint(alice.address);
    await polyVault.setValue(1n, 5_000n * ONE_USDC); // position worth $5,000
    await polyNft.connect(alice).setApprovalForAll(await locker.getAddress(), true);
  });

  describe("lockAndBridge", function () {
    it("transfers NFT to locker + mints wrapper on Arb with value snapshot", async function () {
      const expectedWid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      await expect(locker.connect(alice).lockAndBridge(await polyNft.getAddress(), 1n))
        .to.emit(locker, "Locked_")
        .to.emit(wrapper, "Minted");

      // Locker holds the NFT
      expect(await polyNft.ownerOf(1n)).to.eq(await locker.getAddress());

      // Wrapper minted with the deterministic id
      expect(await wrapper.ownerOf(expectedWid)).to.eq(alice.address);

      // Stored value on wrapper matches vault.estimatePositionValue
      const [, , total] = await wrapper.estimatePositionValue(expectedWid);
      expect(total).to.eq(5_000n * ONE_USDC);
    });

    it("records the lock info on Polygon side", async function () {
      const wid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      await locker.connect(alice).lockAndBridge(await polyNft.getAddress(), 1n);
      const L = await locker.locked(wid);
      expect(L.originalOwner).to.eq(alice.address);
      expect(L.polyNft).to.eq(await polyNft.getAddress());
      expect(L.polyTokenId).to.eq(1n);
      expect(L.lockedAt).to.be.gt(0);
    });

    it("reverts if vaultFor is not set for the NFT", async function () {
      const P2 = await (await ethers.getContractFactory("MockPositionNFT"))
        .deploy("X", "X", await polyVault.getAddress());
      await P2.mint(alice.address);
      await P2.connect(alice).setApprovalForAll(await locker.getAddress(), true);
      await expect(locker.connect(alice).lockAndBridge(await P2.getAddress(), 1n))
        .to.be.revertedWithCustomError(locker, "VaultNotSet");
    });
  });

  describe("pushValueUpdate (keeper)", function () {
    beforeEach(async function () {
      await locker.connect(alice).lockAndBridge(await polyNft.getAddress(), 1n);
    });

    it("refreshes the stored value on Arb", async function () {
      const wid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      // Position appreciates to $7,500
      await polyVault.setValue(1n, 7_500n * ONE_USDC);
      await expect(locker.connect(keeper).pushValueUpdate(await polyNft.getAddress(), 1n))
        .to.emit(wrapper, "ValueUpdated").withArgs(wid, 7_500n * ONE_USDC);
      const [, , total] = await wrapper.estimatePositionValue(wid);
      expect(total).to.eq(7_500n * ONE_USDC);
    });

    it("only KEEPER_ROLE can push updates", async function () {
      await expect(locker.connect(alice).pushValueUpdate(await polyNft.getAddress(), 1n))
        .to.be.reverted;
    });

    it("reverts for an unlocked (never locked) position", async function () {
      await expect(locker.connect(keeper).pushValueUpdate(bob.address, 99n))
        .to.be.revertedWithCustomError(locker, "NotLocked");
    });
  });

  describe("burnAndRedeem", function () {
    beforeEach(async function () {
      await locker.connect(alice).lockAndBridge(await polyNft.getAddress(), 1n);
    });

    it("burns wrapper + CCIP releases original NFT to redeemer", async function () {
      const wid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      await expect(wrapper.connect(alice).burnAndRedeem(wid, bob.address))
        .to.emit(wrapper, "BurnRequested")
        .to.emit(locker, "Released");
      await expect(wrapper.ownerOf(wid)).to.be.reverted; // ERC721NonexistentToken
      expect(await polyNft.ownerOf(1n)).to.eq(bob.address);
    });

    it("only wrapper owner (or approved) can burn", async function () {
      const wid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      await expect(wrapper.connect(bob).burnAndRedeem(wid, bob.address))
        .to.be.revertedWithCustomError(wrapper, "NotOwner");
    });

    it("approved operator can burn on behalf", async function () {
      const wid = await locker.wrapperIdOf(await polyNft.getAddress(), 1n);
      await wrapper.connect(alice).approve(bob.address, wid);
      await expect(wrapper.connect(bob).burnAndRedeem(wid, alice.address))
        .to.emit(locker, "Released");
      expect(await polyNft.ownerOf(1n)).to.eq(alice.address);
    });
  });

  describe("CCIP receive security", function () {
    it("wrapper rejects non-router caller", async function () {
      const empty = [];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","address","address","uint256","uint256"],
        [1, alice.address, await polyNft.getAddress(), 1n, 100n * ONE_USDC]
      );
      const fakeMsg = {
        messageId: ethers.ZeroHash,
        sourceChainSelector: POLY_SELECTOR,
        sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await locker.getAddress()]),
        data: payload,
        destTokenAmounts: empty,
      };
      await expect(wrapper.connect(alice).ccipReceive(fakeMsg))
        .to.be.revertedWithCustomError(wrapper, "NotRouter");
    });

    it("wrapper rejects wrong source chain", async function () {
      // Temporarily re-paire the polyRouter to send under a DIFFERENT selector
      const Wrong = await ethers.getContractFactory("MockCCIPRouter");
      const wrongRouter = await Wrong.deploy();
      await wrongRouter.setPaired(await arbRouter.getAddress(), 9999n);
      await arbRouter.setPaired(await wrongRouter.getAddress(), 9999n);
      // Now the wrapper would receive source=9999 instead of POLY_SELECTOR. Send directly:
      const empty = [];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","address","address","uint256","uint256"],
        [1, alice.address, await polyNft.getAddress(), 1n, 100n * ONE_USDC]
      );
      // Call deliver on arbRouter with wrong source
      await expect(
        arbRouter.deliver(
          9999n,
          await locker.getAddress(),
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await wrapper.getAddress()]),
          payload,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(wrapper, "BadSourceChain");
    });

    it("wrapper rejects wrong sender", async function () {
      const empty = [];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","address","address","uint256","uint256"],
        [1, alice.address, await polyNft.getAddress(), 1n, 100n * ONE_USDC]
      );
      await expect(
        arbRouter.deliver(
          POLY_SELECTOR,
          bob.address,  // NOT the configured locker
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await wrapper.getAddress()]),
          payload,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(wrapper, "BadSender");
    });

    it("wrapper rejects unknown action", async function () {
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","address","uint256","uint256"],
        [99, await polyNft.getAddress(), 1n, 100n * ONE_USDC]
      );
      await expect(
        arbRouter.deliver(
          POLY_SELECTOR,
          await locker.getAddress(),
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await wrapper.getAddress()]),
          payload,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(wrapper, "UnknownAction");
    });
  });

  describe("admin", function () {
    it("setArbWrapper requires DEFAULT_ADMIN_ROLE", async function () {
      await expect(locker.connect(alice).setArbWrapper(bob.address)).to.be.reverted;
    });
    it("setPolygonLocker requires DEFAULT_ADMIN_ROLE", async function () {
      await expect(wrapper.connect(alice).setPolygonLocker(bob.address)).to.be.reverted;
    });
    it("setArbWrapper rejects zero", async function () {
      await expect(locker.setArbWrapper(ZERO)).to.be.revertedWithCustomError(locker, "ZeroAddress");
    });
  });
});
