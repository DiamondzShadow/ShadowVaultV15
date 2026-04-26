const { expect } = require("chai");
const { ethers } = require("hardhat");

// Smoke tests for the Pool F stack: ShadowVaultHyperBasket + BasketAdapterHC
// deposit path — verifies both NFTs are minted, allocation is respected,
// and NAV staleness gates deposits.

describe("Pool F — ShadowVaultHyperBasket + BasketAdapterHC", () => {
  let admin, keeper, alice, treasury;
  let usdc, oracle, yieldReceipt, basketReceipt, basketAdapter, yieldAdapter, vault;

  const BASKET_ID = 0n;

  beforeEach(async () => {
    [admin, keeper, alice, treasury] = await ethers.getSigners();

    // USDC mock
    const USDC = await ethers.getContractFactory("MockUSDC");
    usdc = await USDC.deploy();

    // NAV Oracle + basket
    const Oracle = await ethers.getContractFactory("BasketNavOracle");
    oracle = await Oracle.deploy(admin.address);
    await oracle.grantRole(await oracle.KEEPER_ROLE(), keeper.address);
    await oracle.registerBasket("HyperCore", 900, 1000);
    await oracle.connect(keeper).pushNav(BASKET_ID, 1_000_000n); // $1 par

    // Receipts
    const YR = await ethers.getContractFactory("YieldReceipt");
    yieldReceipt = await YR.deploy(admin.address);
    const BR = await ethers.getContractFactory("BasketReceipt");
    basketReceipt = await BR.deploy(admin.address, await oracle.getAddress());

    // Basket adapter
    const BA = await ethers.getContractFactory("BasketAdapterHC");
    basketAdapter = await BA.deploy(
      admin.address,
      keeper.address,
      await usdc.getAddress(),
      BASKET_ID
    );

    // Yield adapter (reuse mock — it exposes totalAssets/totalPrincipal but
    // we need a deposit() to match IYieldAdapterLite. Use the mock here.)
    const MockYield = await ethers.getContractFactory("MockYieldAdapterDeposit");
    yieldAdapter = await MockYield.deploy(await usdc.getAddress());

    // Vault
    const Vault = await ethers.getContractFactory("ShadowVaultHyperBasket");
    vault = await Vault.deploy(
      admin.address,
      await usdc.getAddress(),
      await yieldAdapter.getAddress(),
      await basketAdapter.getAddress(),
      await yieldReceipt.getAddress(),
      await basketReceipt.getAddress(),
      await oracle.getAddress(),
      treasury.address
    );

    // Wire roles: vault needs VAULT_ROLE on both receipts + basket adapter
    await yieldReceipt.registerStrategy(
      "HyperCore",
      await vault.getAddress(),
      await yieldAdapter.getAddress(),
      "Hyperliquid HLP",
      "~20%"
    );
    await basketReceipt.registerVault(await vault.getAddress());
    await basketAdapter.addVault(await vault.getAddress());

    // Allocation 60/40 basket/yield
    await vault.setAllocation(6000, 4000);

    // Whitelist alice, give her USDC
    await vault.setWhitelist(alice.address, true);
    await usdc.mint(alice.address, 1_000_000_000n); // $1000
  });

  describe("deposit", () => {
    it("mints both receipts and splits per allocation", async () => {
      await usdc.connect(alice).approve(await vault.getAddress(), 100_000_000n);
      const tx = await vault.connect(alice).deposit(100_000_000n, 0); // $100, FLEX
      const rc = await tx.wait();

      // Both balances +1
      expect(await yieldReceipt.balanceOf(alice.address)).to.equal(1n);
      expect(await basketReceipt.balanceOf(alice.address)).to.equal(1n);

      // Allocation: yield=40, basket=60 of $100
      expect(await yieldAdapter.totalPrincipal()).to.equal(40_000_000n);
      expect(await usdc.balanceOf(await basketAdapter.getAddress())).to.equal(60_000_000n);

      // Pair mapping set both ways
      expect(await vault.basketOfYield(1)).to.equal(1n);
      expect(await vault.yieldOfBasket(1)).to.equal(1n);
      expect(await vault.isPair(1, 1)).to.equal(true);
    });

    it("reverts if NAV is stale", async () => {
      // Make NAV stale
      await ethers.provider.send("evm_increaseTime", [1000]);
      await ethers.provider.send("evm_mine", []);
      await usdc.connect(alice).approve(await vault.getAddress(), 100_000_000n);
      await expect(
        vault.connect(alice).deposit(100_000_000n, 0)
      ).to.be.revertedWithCustomError(vault, "NavStale");
    });

    it("reverts if not whitelisted", async () => {
      await vault.setWhitelist(alice.address, false);
      await usdc.connect(alice).approve(await vault.getAddress(), 100_000_000n);
      await expect(
        vault.connect(alice).deposit(100_000_000n, 0)
      ).to.be.revertedWithCustomError(vault, "NotWhitelisted");
    });

    it("reverts below min deposit", async () => {
      await usdc.connect(alice).approve(await vault.getAddress(), 1_000_000n);
      await expect(
        vault.connect(alice).deposit(1_000_000n, 0) // $1 — below $5 min
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });
  });

  describe("totalAssets", () => {
    it("sums yield + basket sides with NAV multiplier", async () => {
      await usdc.connect(alice).approve(await vault.getAddress(), 100_000_000n);
      await vault.connect(alice).deposit(100_000_000n, 0);

      // NAV still 1.00 → total = 40 (yield) + 60 (basket) = 100
      expect(await vault.totalAssets()).to.equal(100_000_000n);

      // Bump NAV 5% → basket side = 63, total = 103
      await oracle.connect(keeper).pushNav(BASKET_ID, 1_050_000n);
      expect(await vault.totalAssets()).to.equal(103_000_000n);
    });
  });

  describe("basket adapter", () => {
    it("enforces per-tx cap", async () => {
      // Default $500 per-tx cap; try $600
      await usdc.mint(alice.address, 1_000_000_000n);
      await vault.setWhitelist(alice.address, true);
      // Allocation 60/40 → basket portion of $1000 is $600, exceeds $500 cap
      await usdc.connect(alice).approve(await vault.getAddress(), 1_000_000_000n);
      await expect(
        vault.connect(alice).deposit(1_000_000_000n, 0)
      ).to.be.revertedWithCustomError(basketAdapter, "PerTxLimit");
    });

    it("keeper can sweep to trader", async () => {
      await usdc.connect(alice).approve(await vault.getAddress(), 100_000_000n);
      await vault.connect(alice).deposit(100_000_000n, 0);

      // Set trader, sweep $60
      const traderAddr = ethers.Wallet.createRandom().address;
      await basketAdapter.setTrader(traderAddr);
      await basketAdapter.connect(keeper).sweepToTrader(60_000_000n);
      expect(await usdc.balanceOf(traderAddr)).to.equal(60_000_000n);
      expect(await basketAdapter.inFlightOut()).to.equal(60_000_000n);
    });
  });
});
