const { expect } = require("chai");
const { ethers } = require("hardhat");

// Smoke tests for the ShadowPass NFT architecture:
//   - BasketNavOracle staleness + drift cap enforcement
//   - YieldReceipt mint + tokenURI
//   - BasketReceipt mint + liveValue
//   - ShadowPass wrap / unwrap round-trip

describe("ShadowPass architecture", () => {
  let admin, keeper, vault, alice;
  let oracle, yieldReceipt, basketReceipt, pass;
  let mockAdapter;

  beforeEach(async () => {
    [admin, keeper, vault, alice] = await ethers.getSigners();

    // Oracle
    const Oracle = await ethers.getContractFactory("BasketNavOracle");
    oracle = await Oracle.deploy(admin.address);
    await oracle.grantRole(await oracle.KEEPER_ROLE(), keeper.address);
    await oracle.grantRole(await oracle.PAUSER_ROLE(), admin.address);

    // Yield Receipt
    const YR = await ethers.getContractFactory("YieldReceipt");
    yieldReceipt = await YR.deploy(admin.address);

    // Mock adapter
    const MockAdapter = await ethers.getContractFactory("MockYieldAdapter");
    mockAdapter = await MockAdapter.deploy();

    // Register strategy in YieldReceipt
    await yieldReceipt.registerStrategy(
      "HyperCash",
      vault.address,
      await mockAdapter.getAddress(),
      "Hyperliquid HLP",
      "~20%"
    );

    // Basket Receipt
    const BR = await ethers.getContractFactory("BasketReceipt");
    basketReceipt = await BR.deploy(admin.address, await oracle.getAddress());
    await basketReceipt.registerVault(vault.address);

    // ShadowPass
    const SP = await ethers.getContractFactory("ShadowPass");
    pass = await SP.deploy(
      admin.address,
      await yieldReceipt.getAddress(),
      await basketReceipt.getAddress()
    );
  });

  describe("BasketNavOracle", () => {
    it("registers basket, pushes NAV, reads it back", async () => {
      const tx = await oracle.registerBasket("HyperCore", 900, 1000); // 15min stale, 10% drift
      await tx.wait();
      await oracle.connect(keeper).pushNav(0, 1_000_000n); // 1 USDC

      const [nav, at] = await oracle.getNav(0);
      expect(nav).to.equal(1_000_000n);
      expect(at).to.be.greaterThan(0);
    });

    it("reverts on stale NAV", async () => {
      await oracle.registerBasket("HyperCore", 10, 1000);
      await oracle.connect(keeper).pushNav(0, 1_000_000n);
      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);
      await expect(oracle.getNav(0)).to.be.revertedWithCustomError(oracle, "NavStale");
    });

    it("enforces drift cap", async () => {
      await oracle.registerBasket("HyperCore", 900, 1000); // 10% max drift
      await oracle.connect(keeper).pushNav(0, 1_000_000n);
      // 20% jump should revert
      await expect(oracle.connect(keeper).pushNav(0, 1_200_000n))
        .to.be.revertedWithCustomError(oracle, "DriftExceeded");
      // 5% jump is fine
      await oracle.connect(keeper).pushNav(0, 1_050_000n);
    });

    it("lenient read does not revert when stale", async () => {
      await oracle.registerBasket("HyperCore", 1, 1000);
      await oracle.connect(keeper).pushNav(0, 1_000_000n);
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);
      const [nav, , stale] = await oracle.getNavLenient(0);
      expect(nav).to.equal(1_000_000n);
      expect(stale).to.equal(true);
    });
  });

  describe("YieldReceipt", () => {
    it("mints from vault and renders tokenURI", async () => {
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint128", "uint8"],
        [5_000_000n, 0] // $5 FLEX
      );
      await yieldReceipt.connect(vault).mint(alice.address, posData);
      expect(await yieldReceipt.balanceOf(alice.address)).to.equal(1n);
      expect(await yieldReceipt.ownerOf(1)).to.equal(alice.address);
      const uri = await yieldReceipt.tokenURI(1);
      expect(uri).to.match(/^data:application\/json;base64,/);
    });

    it("rejects mint from non-vault", async () => {
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint128", "uint8"],
        [5_000_000n, 0]
      );
      await expect(
        yieldReceipt.connect(alice).mint(alice.address, posData)
      ).to.be.revertedWithCustomError(yieldReceipt, "AccessControlUnauthorizedAccount");
    });

    it("computes live accrued yield from adapter", async () => {
      await mockAdapter.setBalances(10_000_000n, 9_000_000n); // 11.1% gain
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint128", "uint8"],
        [9_000_000n, 0]
      );
      await yieldReceipt.connect(vault).mint(alice.address, posData);
      const accrued = await yieldReceipt.liveAccruedYield(1);
      // (10 - 9) * 9 / 9 = 1_000_000
      expect(accrued).to.equal(1_000_000n);
    });
  });

  describe("BasketReceipt", () => {
    beforeEach(async () => {
      await oracle.registerBasket("HyperCore", 900, 1000);
      await oracle.connect(keeper).pushNav(0, 1_000_000n); // $1 per share
    });

    it("mints with nav snapshot and renders tokenURI", async () => {
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint128", "uint8"],
        [0, 5_000_000n, 0]
      );
      await basketReceipt.connect(vault).mint(alice.address, posData);
      expect(await basketReceipt.balanceOf(alice.address)).to.equal(1n);
      const uri = await basketReceipt.tokenURI(1);
      expect(uri).to.match(/^data:application\/json;base64,/);
    });

    it("scales liveValue with nav", async () => {
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint128", "uint8"],
        [0, 5_000_000n, 0]
      );
      await basketReceipt.connect(vault).mint(alice.address, posData);
      // NAV doubles → value doubles
      await oracle.connect(keeper).pushNav(0, 1_050_000n); // up 5%, within drift
      const [val] = await basketReceipt.liveValue(1);
      // 5_000_000 * 1.05 / 1.00 = 5_250_000
      expect(val).to.equal(5_250_000n);
    });

    it("rejects mint if NAV is unavailable for basket", async () => {
      await oracle.registerBasket("NoNav", 900, 1000);
      const posData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint128", "uint8"],
        [1, 5_000_000n, 0]
      );
      await expect(
        basketReceipt.connect(vault).mint(alice.address, posData)
      ).to.be.revertedWithCustomError(basketReceipt, "NavUnavailable");
    });
  });

  describe("ShadowPass wrap / unwrap", () => {
    let yieldId, basketId;

    beforeEach(async () => {
      await oracle.registerBasket("HyperCore", 900, 1000);
      await oracle.connect(keeper).pushNav(0, 1_000_000n);
      const yPos = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint128", "uint8"],
        [5_000_000n, 0]
      );
      const bPos = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint64", "uint128", "uint8"],
        [0, 5_000_000n, 0]
      );
      await yieldReceipt.connect(vault).mint(alice.address, yPos);
      await basketReceipt.connect(vault).mint(alice.address, bPos);
      yieldId = 1; basketId = 1;
    });

    it("wraps two receipts into a ShadowPass", async () => {
      await yieldReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await basketReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await pass.connect(alice).wrap(yieldId, basketId);

      expect(await pass.balanceOf(alice.address)).to.equal(1n);
      expect(await yieldReceipt.ownerOf(yieldId)).to.equal(await pass.getAddress());
      expect(await basketReceipt.ownerOf(basketId)).to.equal(await pass.getAddress());
      const uri = await pass.tokenURI(1);
      expect(uri).to.match(/^data:application\/json;base64,/);
    });

    it("unwrap returns both receipts to caller", async () => {
      await yieldReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await basketReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await pass.connect(alice).wrap(yieldId, basketId);
      await pass.connect(alice).unwrap(1);

      expect(await yieldReceipt.ownerOf(yieldId)).to.equal(alice.address);
      expect(await basketReceipt.ownerOf(basketId)).to.equal(alice.address);
      await expect(pass.ownerOf(1)).to.be.revertedWithCustomError(pass, "ERC721NonexistentToken");
    });

    it("rejects wrap if caller does not own both", async () => {
      await yieldReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await basketReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      // vault tries to wrap Alice's tokens
      await expect(
        pass.connect(vault).wrap(yieldId, basketId)
      ).to.be.revertedWithCustomError(pass, "NotOwnerOfChild");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Rescue — active escrows protected, strays recoverable
  // ═══════════════════════════════════════════════════════════════════
  describe("ShadowPass rescue", () => {
    let yieldId, basketId, passId;

    beforeEach(async () => {
      await oracle.registerBasket("HyperCore", 900, 1000);
      await oracle.connect(keeper).pushNav(0, 1_000_000n);
      yieldId = await yieldReceipt.connect(vault).mint.staticCall(
        alice.address, ethers.AbiCoder.defaultAbiCoder().encode(["uint128","uint8"], [1_000n * 10n ** 6n, 0])
      );
      await yieldReceipt.connect(vault).mint(
        alice.address, ethers.AbiCoder.defaultAbiCoder().encode(["uint128","uint8"], [1_000n * 10n ** 6n, 0])
      );
      basketId = await basketReceipt.connect(vault).mint.staticCall(
        alice.address, ethers.AbiCoder.defaultAbiCoder().encode(["uint64","uint128","uint8"], [0, 500n * 10n ** 6n, 0])
      );
      await basketReceipt.connect(vault).mint(
        alice.address, ethers.AbiCoder.defaultAbiCoder().encode(["uint64","uint128","uint8"], [0, 500n * 10n ** 6n, 0])
      );
      await yieldReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await basketReceipt.connect(alice).setApprovalForAll(await pass.getAddress(), true);
      await pass.connect(alice).wrap(yieldId, basketId);
      passId = 1n;
    });

    it("reverse-index tracks active wrap", async () => {
      expect(await pass.yieldEscrowedBy(yieldId)).to.equal(passId);
      expect(await pass.basketEscrowedBy(basketId)).to.equal(passId);
    });

    it("rescueNft REVERTS for active yield escrow", async () => {
      await expect(
        pass.rescueNft(await yieldReceipt.getAddress(), yieldId, admin.address)
      ).to.be.revertedWithCustomError(pass, "NftIsActiveEscrow");
    });

    it("rescueNft REVERTS for active basket escrow", async () => {
      await expect(
        pass.rescueNft(await basketReceipt.getAddress(), basketId, admin.address)
      ).to.be.revertedWithCustomError(pass, "NftIsActiveEscrow");
    });

    it("unwrap clears reverse index → rescue works on unescrowed tokens", async () => {
      await pass.connect(alice).unwrap(passId);
      expect(await pass.yieldEscrowedBy(yieldId)).to.equal(0n);
      expect(await pass.basketEscrowedBy(basketId)).to.equal(0n);
    });

    it("rescueToken moves stray ERC-20", async () => {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await usdc.mint(await pass.getAddress(), 100n * 10n ** 6n);
      await pass.rescueToken(await usdc.getAddress(), admin.address, 100n * 10n ** 6n);
      expect(await usdc.balanceOf(admin.address)).to.equal(100n * 10n ** 6n);
    });

    it("non-admin cannot rescue", async () => {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await expect(
        pass.connect(alice).rescueToken(await usdc.getAddress(), alice.address, 0n)
      ).to.be.reverted;
    });
  });
});
