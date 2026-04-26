const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("SDMArbitrumMirror", function () {
  this.timeout(60_000);

  let admin, keeper, alice, bob, eve;
  let mirror;

  beforeEach(async function () {
    [admin, keeper, alice, bob, eve] = await ethers.getSigners();
    const F = await ethers.getContractFactory("SDMArbitrumMirror");
    mirror = await F.deploy(admin.address, keeper.address);
    await mirror.waitForDeployment();
  });

  describe("constructor + constants", function () {
    it("exposes ERC20-shaped name/symbol/decimals", async function () {
      expect(await mirror.name()).to.eq("Arbitrum SDM Mirror");
      expect(await mirror.symbol()).to.eq("mSDM-arb");
      expect(await mirror.decimals()).to.eq(18);
    });
    it("hard-codes Arb SDM source token + chain id", async function () {
      expect((await mirror.SOURCE_TOKEN()).toLowerCase())
        .to.eq("0x602b869eEf1C9F0487F31776bad8Af3C4A173394".toLowerCase());
      expect(await mirror.SOURCE_CHAIN_ID()).to.eq(42161);
    });
    it("admin holds DEFAULT_ADMIN_ROLE; keeper holds KEEPER_ROLE", async function () {
      const adminRole = "0x" + "0".repeat(64);
      const keeperRole = await mirror.KEEPER_ROLE();
      expect(await mirror.hasRole(adminRole, admin.address)).to.eq(true);
      expect(await mirror.hasRole(keeperRole, keeper.address)).to.eq(true);
      expect(await mirror.hasRole(keeperRole, alice.address)).to.eq(false);
    });
  });

  describe("setBalance", function () {
    it("only KEEPER_ROLE can call", async function () {
      await expect(mirror.connect(eve).setBalance(alice.address, 1n))
        .to.be.revertedWithCustomError(mirror, "AccessControlUnauthorizedAccount");
    });
    it("updates balanceOf, lastUpdate, globalLastSync; emits BalanceMirrored", async function () {
      const amt = ethers.parseUnits("12345", 18);
      const tx = await mirror.connect(keeper).setBalance(alice.address, amt);
      const rc = await tx.wait();
      const block = await ethers.provider.getBlock(rc.blockNumber);
      expect(await mirror.balanceOf(alice.address)).to.eq(amt);
      expect(await mirror.lastUpdate(alice.address)).to.eq(block.timestamp);
      expect(await mirror.globalLastSync()).to.eq(block.timestamp);
      await expect(tx).to.emit(mirror, "BalanceMirrored")
        .withArgs(alice.address, 0n, amt, block.timestamp);
    });
    it("overwrites a prior balance and reflects the previous value in the event", async function () {
      const a = ethers.parseUnits("10", 18);
      const b = ethers.parseUnits("3", 18);
      await mirror.connect(keeper).setBalance(alice.address, a);
      const tx = await mirror.connect(keeper).setBalance(alice.address, b);
      const rc = await tx.wait();
      const block = await ethers.provider.getBlock(rc.blockNumber);
      await expect(tx).to.emit(mirror, "BalanceMirrored")
        .withArgs(alice.address, a, b, block.timestamp);
      expect(await mirror.balanceOf(alice.address)).to.eq(b);
    });
  });

  describe("setBatch", function () {
    it("requires KEEPER_ROLE", async function () {
      await expect(mirror.connect(eve).setBatch([alice.address], [1n]))
        .to.be.revertedWithCustomError(mirror, "AccessControlUnauthorizedAccount");
    });
    it("rejects empty batches", async function () {
      await expect(mirror.connect(keeper).setBatch([], []))
        .to.be.revertedWithCustomError(mirror, "EmptyBatch");
    });
    it("rejects mismatched array lengths", async function () {
      await expect(mirror.connect(keeper).setBatch([alice.address], [1n, 2n]))
        .to.be.revertedWithCustomError(mirror, "LengthMismatch");
    });
    it("enforces MAX_BATCH cap", async function () {
      const max = Number(await mirror.MAX_BATCH());
      const users   = Array(max + 1).fill(alice.address);
      const amounts = Array(max + 1).fill(1n);
      await expect(mirror.connect(keeper).setBatch(users, amounts))
        .to.be.revertedWithCustomError(mirror, "TooManyEntries");
    });
    it("writes all entries and emits BalanceMirrored per user + one BatchMirrored", async function () {
      const users = [alice.address, bob.address, eve.address];
      const amts  = [1_000n, 2_000n, 3_000n];
      const tx = await mirror.connect(keeper).setBatch(users, amts);
      const rc = await tx.wait();
      const block = await ethers.provider.getBlock(rc.blockNumber);
      for (let i = 0; i < users.length; i++) {
        expect(await mirror.balanceOf(users[i])).to.eq(amts[i]);
        expect(await mirror.lastUpdate(users[i])).to.eq(block.timestamp);
      }
      expect(await mirror.globalLastSync()).to.eq(block.timestamp);
      await expect(tx).to.emit(mirror, "BatchMirrored").withArgs(users.length, block.timestamp);
    });
  });

  describe("admin", function () {
    it("admin can grant + revoke KEEPER_ROLE", async function () {
      const role = await mirror.KEEPER_ROLE();
      await mirror.connect(admin).addKeeper(alice.address);
      expect(await mirror.hasRole(role, alice.address)).to.eq(true);
      await mirror.connect(admin).removeKeeper(alice.address);
      expect(await mirror.hasRole(role, alice.address)).to.eq(false);
    });
    it("non-admin cannot grant", async function () {
      await expect(mirror.connect(keeper).addKeeper(alice.address))
        .to.be.revertedWithCustomError(mirror, "AccessControlUnauthorizedAccount");
    });
  });

  describe("vault integration shape", function () {
    it("vault-style IERC20.balanceOf(user) call returns the mirrored amount", async function () {
      // Confirm the contract honors the IERC20 balanceOf shape that
      // ShadowVaultV15._applySDMDiscount uses verbatim.
      const erc20 = new ethers.Contract(
        await mirror.getAddress(),
        ["function balanceOf(address) view returns (uint256)"],
        ethers.provider,
      );
      const amt = ethers.parseUnits("9999", 18);
      await mirror.connect(keeper).setBalance(alice.address, amt);
      expect(await erc20.balanceOf(alice.address)).to.eq(amt);
    });
  });
});
