// NFTValuer unit tests: modes, config gating, valueOf/strategy/vaultFor
// semantics, max-clamp, access control, DiggerRegistry enforcement.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0x" + "0".repeat(64);
const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;

// Mode enum values from INFTValuer.Mode
const MODE_NONE = 0;
const MODE_VAULT = 1;
const MODE_FLOOR = 2;
const MODE_STATIC = 3;

// Strategy enum
const STRAT_VAULT_UNWIND = 0;
const STRAT_MARKETPLACE_AUCTION = 1;

describe("NFTValuer", function () {
  this.timeout(60_000);

  let admin, treasury, project, other;
  let usdc, registry, vault, nft, oracle, valuer;

  beforeEach(async function () {
    [admin, treasury, project, other] = await ethers.getSigners();

    const U = await ethers.getContractFactory("MockUSDC");
    usdc = await U.deploy();

    const R = await ethers.getContractFactory("DiggerRegistry");
    registry = await R.deploy(admin.address, await usdc.getAddress(), treasury.address);

    const V = await ethers.getContractFactory("MockPositionVault");
    vault = await V.deploy(await usdc.getAddress());

    const N = await ethers.getContractFactory("MockPositionNFT");
    nft = await N.deploy("MP", "MP", await vault.getAddress());

    const O = await ethers.getContractFactory("MockFloorOracle");
    oracle = await O.deploy();

    const Val = await ethers.getContractFactory("NFTValuer");
    valuer = await Val.deploy(admin.address, await registry.getAddress());

    // Fund project, open digger, register collection
    await usdc.mint(project.address, 10_000n * ONE_USDC);
    await usdc.connect(project).approve(await registry.getAddress(), ethers.MaxUint256);
    await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000);
    await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000);
  });

  describe("constructor", function () {
    it("rejects zero admin / registry", async function () {
      const F = await ethers.getContractFactory("NFTValuer");
      await expect(F.deploy(ZERO, await registry.getAddress()))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(admin.address, ZERO))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });
    it("grants admin both DEFAULT_ADMIN and CONFIG_ROLE", async function () {
      const CONFIG = await valuer.CONFIG_ROLE();
      expect(await valuer.hasRole(ADMIN_ROLE, admin.address)).to.eq(true);
      expect(await valuer.hasRole(CONFIG, admin.address)).to.eq(true);
    });
  });

  describe("unconfigured", function () {
    it("valueOf returns 0", async function () {
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(0n);
    });
    it("modeOf returns NONE", async function () {
      expect(await valuer.modeOf(await nft.getAddress())).to.eq(MODE_NONE);
    });
    it("strategy() reverts with UnconfiguredCollection", async function () {
      await expect(valuer.strategy(await nft.getAddress()))
        .to.be.revertedWithCustomError(valuer, "UnconfiguredCollection");
    });
    it("vaultFor() reverts with NotVaultMode", async function () {
      await expect(valuer.vaultFor(await nft.getAddress()))
        .to.be.revertedWithCustomError(valuer, "NotVaultMode");
    });
  });

  describe("VAULT_POSITION mode", function () {
    beforeEach(async function () {
      await vault.setValue(7n, 12_345n * ONE_USDC);
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 0);
    });

    it("valueOf returns vault.estimatePositionValue(tokenId).total", async function () {
      expect(await valuer.liveValue(await nft.getAddress(), 7n)).to.eq(12_345n * ONE_USDC);
    });
    it("returns per-tokenId (different values per id)", async function () {
      await vault.setValue(8n, 999n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 8n)).to.eq(999n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 7n)).to.eq(12_345n * ONE_USDC);
    });
    it("strategy() returns VAULT_UNWIND", async function () {
      expect(await valuer.strategy(await nft.getAddress())).to.eq(STRAT_VAULT_UNWIND);
    });
    it("vaultFor() returns the configured vault", async function () {
      expect(await valuer.vaultFor(await nft.getAddress())).to.eq(await vault.getAddress());
    });
    it("emits VaultModeSet on config", async function () {
      const N2 = await (await ethers.getContractFactory("MockPositionNFT"))
        .deploy("B", "B", await vault.getAddress());
      await registry.connect(project).registerCollection(1, await N2.getAddress(), ZERO, 5000);
      await expect(valuer.setVaultMode(await N2.getAddress(), await vault.getAddress(), 0))
        .to.emit(valuer, "VaultModeSet")
        .withArgs(await N2.getAddress(), await vault.getAddress(), 0);
    });
    it("maxValueClampUSDC caps inflated vault readings", async function () {
      // Reconfigure with a clamp at $5k
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 5_000n * ONE_USDC);
      await vault.setValue(7n, 999_999n * ONE_USDC); // vault goes haywire
      expect(await valuer.liveValue(await nft.getAddress(), 7n)).to.eq(5_000n * ONE_USDC);
    });
    it("clamp doesn't penalize values below the cap", async function () {
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 20_000n * ONE_USDC);
      await vault.setValue(7n, 8_000n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 7n)).to.eq(8_000n * ONE_USDC);
    });
  });

  describe("FLOOR_ORACLE mode", function () {
    beforeEach(async function () {
      await oracle.setFloor(await nft.getAddress(), 500n * ONE_USDC);
      await valuer.setFloorMode(await nft.getAddress(), await oracle.getAddress(), 0);
    });

    it("valueOf returns oracle.floorUSDC(nft), identical across tokenIds", async function () {
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(500n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 999n)).to.eq(500n * ONE_USDC);
    });
    it("strategy() returns MARKETPLACE_AUCTION", async function () {
      expect(await valuer.strategy(await nft.getAddress())).to.eq(STRAT_MARKETPLACE_AUCTION);
    });
    it("vaultFor() reverts NotVaultMode", async function () {
      await expect(valuer.vaultFor(await nft.getAddress()))
        .to.be.revertedWithCustomError(valuer, "NotVaultMode");
    });
    it("max-clamp also applies to floor", async function () {
      await valuer.setFloorMode(await nft.getAddress(), await oracle.getAddress(), 100n * ONE_USDC);
      await oracle.setFloor(await nft.getAddress(), 10_000n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(100n * ONE_USDC);
    });
  });

  describe("STATIC_USDC mode", function () {
    it("valueOf returns the configured value", async function () {
      await valuer.setStaticMode(await nft.getAddress(), 42_000n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(42_000n * ONE_USDC);
      expect(await valuer.liveValue(await nft.getAddress(), 999n)).to.eq(42_000n * ONE_USDC);
    });
    it("rejects zero value", async function () {
      await expect(valuer.setStaticMode(await nft.getAddress(), 0n))
        .to.be.revertedWithCustomError(valuer, "ZeroValue");
    });
    it("strategy() returns MARKETPLACE_AUCTION", async function () {
      await valuer.setStaticMode(await nft.getAddress(), 1n * ONE_USDC);
      expect(await valuer.strategy(await nft.getAddress())).to.eq(STRAT_MARKETPLACE_AUCTION);
    });
  });

  describe("DiggerRegistry gating", function () {
    it("setVaultMode reverts for unregistered collection", async function () {
      const N2 = await (await ethers.getContractFactory("MockPositionNFT"))
        .deploy("X", "X", await vault.getAddress());
      await expect(valuer.setVaultMode(await N2.getAddress(), await vault.getAddress(), 0))
        .to.be.revertedWithCustomError(valuer, "NotRegisteredInDiggerRegistry");
    });
    it("setFloorMode reverts for unregistered", async function () {
      const N2 = await (await ethers.getContractFactory("MockPositionNFT"))
        .deploy("X", "X", await vault.getAddress());
      await expect(valuer.setFloorMode(await N2.getAddress(), await oracle.getAddress(), 0))
        .to.be.revertedWithCustomError(valuer, "NotRegisteredInDiggerRegistry");
    });
    it("setStaticMode reverts for unregistered", async function () {
      const N2 = await (await ethers.getContractFactory("MockPositionNFT"))
        .deploy("X", "X", await vault.getAddress());
      await expect(valuer.setStaticMode(await N2.getAddress(), 1_000n * ONE_USDC))
        .to.be.revertedWithCustomError(valuer, "NotRegisteredInDiggerRegistry");
    });
  });

  describe("access control", function () {
    it("non-admin cannot setVaultMode", async function () {
      await expect(valuer.connect(other).setVaultMode(await nft.getAddress(), await vault.getAddress(), 0))
        .to.be.reverted;
    });
    it("non-admin cannot setFloorMode / setStaticMode / clear", async function () {
      await expect(valuer.connect(other).setFloorMode(await nft.getAddress(), await oracle.getAddress(), 0)).to.be.reverted;
      await expect(valuer.connect(other).setStaticMode(await nft.getAddress(), 1n)).to.be.reverted;
      await expect(valuer.connect(other).clear(await nft.getAddress())).to.be.reverted;
    });
    it("zero-address source rejected", async function () {
      await expect(valuer.setVaultMode(await nft.getAddress(), ZERO, 0))
        .to.be.revertedWithCustomError(valuer, "ZeroAddress");
      await expect(valuer.setFloorMode(await nft.getAddress(), ZERO, 0))
        .to.be.revertedWithCustomError(valuer, "ZeroAddress");
    });
  });

  describe("clear / reconfigure", function () {
    it("clear reverts strategy back to unconfigured", async function () {
      await valuer.setStaticMode(await nft.getAddress(), 1_000n * ONE_USDC);
      expect(await valuer.modeOf(await nft.getAddress())).to.eq(MODE_STATIC);
      await expect(valuer.clear(await nft.getAddress()))
        .to.emit(valuer, "Cleared").withArgs(await nft.getAddress());
      expect(await valuer.modeOf(await nft.getAddress())).to.eq(MODE_NONE);
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(0);
    });
    it("can switch mode without clearing first", async function () {
      await vault.setValue(1n, 9_000n * ONE_USDC);
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 0);
      expect(await valuer.modeOf(await nft.getAddress())).to.eq(MODE_VAULT);
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(9_000n * ONE_USDC);

      await valuer.setStaticMode(await nft.getAddress(), 5_000n * ONE_USDC);
      expect(await valuer.modeOf(await nft.getAddress())).to.eq(MODE_STATIC);
      expect(await valuer.liveValue(await nft.getAddress(), 1n)).to.eq(5_000n * ONE_USDC);
    });
  });

  describe("configOf view", function () {
    it("returns (mode, source, staticValue)", async function () {
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 100n * ONE_USDC);
      const [mode, src, sv] = await valuer.configOf(await nft.getAddress());
      expect(mode).to.eq(MODE_VAULT);
      expect(src).to.eq(await vault.getAddress());
      expect(sv).to.eq(100n * ONE_USDC);
    });
  });
});
