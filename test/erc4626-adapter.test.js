const { expect } = require("chai");
const { ethers } = require("hardhat");

// ERC4626Adapter — the generic adapter that lets ANY natively-4626 venue become a strategy
// without writing a new contract. These tests focus on the behaviours that differ from the
// happy path, because those are what bit us in production:
//   - a venue that stops accepting deposits (Morpho's Polygon USDC vault: maxDeposit() == 0)
//   - a venue that is solvent but illiquid (partial withdraw must NOT revert)
//   - the excess/2 harvest convention shared by every existing V15 adapter
//   - asset mismatch caught at construction, not at first deposit

const USDC = (n) => ethers.parseUnits(n.toString(), 6);

describe("ERC4626Adapter (generic 4626 strategy adapter)", () => {
  let admin, vault, other;
  let usdc, otherToken, yieldVault, adapter;

  beforeEach(async () => {
    [admin, vault, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    otherToken = await MockUSDC.deploy();

    const MockERC4626 = await ethers.getContractFactory("MockERC4626");
    yieldVault = await MockERC4626.deploy(await usdc.getAddress());

    const Adapter = await ethers.getContractFactory("ERC4626Adapter");
    adapter = await Adapter.deploy(
      admin.address,
      await yieldVault.getAddress(),
      await usdc.getAddress(),
      "Mock Venue USDC"
    );

    await adapter.connect(admin).addVault(vault.address);
    await usdc.mint(vault.address, USDC(1_000_000));
    await usdc.connect(vault).approve(await adapter.getAddress(), ethers.MaxUint256);
  });

  describe("construction", () => {
    it("records the asset, vault and label", async () => {
      expect(await adapter.asset()).to.equal(await usdc.getAddress());
      expect(await adapter.YIELD_VAULT()).to.equal(await yieldVault.getAddress());
      expect(await adapter.label()).to.equal("Mock Venue USDC");
    });

    it("rejects a vault whose asset() does not match the expected asset", async () => {
      // This is the guard that makes the adapter safe to point at an arbitrary address.
      const Adapter = await ethers.getContractFactory("ERC4626Adapter");
      await expect(
        Adapter.deploy(
          admin.address,
          await yieldVault.getAddress(),
          await otherToken.getAddress(), // wrong asset
          "Wrong"
        )
      ).to.be.revertedWithCustomError(adapter, "AssetMismatch");
    });

    it("rejects zero addresses", async () => {
      const Adapter = await ethers.getContractFactory("ERC4626Adapter");
      await expect(
        Adapter.deploy(admin.address, ethers.ZeroAddress, await usdc.getAddress(), "x")
      ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
    });
  });

  describe("deposit / withdraw", () => {
    it("round-trips a deposit", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      expect(await adapter.totalPrincipal()).to.equal(USDC(1000));
      expect(await adapter.totalAssets()).to.equal(USDC(1000));

      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(USDC(1000));
      expect(await usdc.balanceOf(vault.address) - before).to.equal(USDC(1000));
      expect(await adapter.totalPrincipal()).to.equal(0);
    });

    it("only VAULT_ROLE can deposit or withdraw", async () => {
      await expect(adapter.connect(other).deposit(USDC(1))).to.be.reverted;
      await expect(adapter.connect(other).withdraw(USDC(1))).to.be.reverted;
    });

    it("reverts VaultClosedToDeposits when the venue is at cap / winding down", async () => {
      // Reproduces Morpho's Polygon USDC vault, which reports maxDeposit() == 0.
      await yieldVault.setDepositsOpen(false);
      await expect(
        adapter.connect(vault).deposit(USDC(1000))
      ).to.be.revertedWithCustomError(adapter, "VaultClosedToDeposits");
      expect(await adapter.acceptingDeposits()).to.equal(false);
    });

    it("delivers what it can when the venue is illiquid, rather than reverting", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      await yieldVault.setLiquidityCap(USDC(300));

      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(USDC(1000));
      const delivered = await usdc.balanceOf(vault.address) - before;

      // Partial fill: the vault above depends on the returned/delivered amount.
      expect(delivered).to.equal(USDC(300));
      expect(await adapter.totalPrincipal()).to.equal(USDC(700));
      // The mock's cap is static, so 300 remains reachable; the point is that the adapter
      // capped the fill at available liquidity instead of reverting the whole withdrawal.
      expect(await adapter.availableLiquidity()).to.equal(USDC(300));
    });

    it("returns zero (not a revert) when there is nothing to withdraw", async () => {
      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).withdraw(USDC(100));
      expect(await usdc.balanceOf(vault.address)).to.equal(before);
    });
  });

  describe("yield and harvest", () => {
    it("totalAssets tracks exchange-rate appreciation", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      await yieldVault.accrue(USDC(100));

      // ERC-4626 conversion rounds DOWN in the vault's favour (OZ virtual shares), so assets
      // read back 1 wei light. Asserting exact equality here would be asserting a bug that
      // isn't one — the rounding direction is what protects the vault from share inflation.
      expect(await adapter.totalAssets()).to.be.closeTo(USDC(1100), 2n);
      expect(await adapter.totalPrincipal()).to.equal(USDC(1000));
      expect(await adapter.pendingYield()).to.be.closeTo(USDC(100), 2n);
    });

    it("harvests HALF the excess and leaves the rest compounding", async () => {
      // This convention is shared by MorphoAdapter, FluidAdapter and AaveAdapterV5. It is
      // deliberate; vault-side accounting assumes it.
      await adapter.connect(vault).deposit(USDC(1000));
      await yieldVault.accrue(USDC(100));

      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).harvest();
      const profit = await usdc.balanceOf(vault.address) - before;

      expect(profit).to.be.closeTo(USDC(50), 2n); // 4626 rounds down in the vault's favour
      // ~half the yield stays in the venue, still earning.
      expect(await adapter.totalAssets()).to.be.closeTo(USDC(1050), USDC(1));
    });

    it("harvests nothing when there is no profit", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).harvest();
      expect(await usdc.balanceOf(vault.address)).to.equal(before);
    });

    it("does not treat principal as profit after a partial withdrawal", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      await adapter.connect(vault).withdraw(USDC(400));
      const before = await usdc.balanceOf(vault.address);
      await adapter.connect(vault).harvest();
      expect(await usdc.balanceOf(vault.address)).to.equal(before);
    });
  });

  describe("admin", () => {
    it("syncAccounting is admin-only and resets principal", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      await expect(adapter.connect(vault).syncAccounting(USDC(1))).to.be.reverted;
      await adapter.connect(admin).syncAccounting(USDC(777));
      expect(await adapter.totalPrincipal()).to.equal(USDC(777));
    });

    it("rescueToken cannot take the managed asset or the vault shares", async () => {
      await adapter.connect(vault).deposit(USDC(1000));
      await expect(
        adapter.connect(admin).rescueToken(await usdc.getAddress(), admin.address, 1)
      ).to.be.revertedWith("protected");
      await expect(
        adapter.connect(admin).rescueToken(await yieldVault.getAddress(), admin.address, 1)
      ).to.be.revertedWith("protected");
    });

    it("rescueToken recovers an unrelated token", async () => {
      await otherToken.mint(await adapter.getAddress(), USDC(5));
      await adapter.connect(admin).rescueToken(await otherToken.getAddress(), admin.address, USDC(5));
      expect(await otherToken.balanceOf(admin.address)).to.equal(USDC(5));
    });
  });
});
