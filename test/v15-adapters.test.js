// ═══════════════════════════════════════════════════════════════════════
//  v15-adapters.test.js — per-adapter end-to-end coverage
//
//  The core tests cover AaveAdapterV5 thoroughly. This file adds
//  coverage for FluidAdapter (Fluid fUSDC) and SiloAdapter (Silo V2
//  wstUSR/USDC market) against live Arbitrum state:
//
//    - deposit routes USDC into the real underlying protocol
//    - totalAssets reflects the deposited principal
//    - withdraw returns USDC to the vault
//    - harvest returns 0 profit (no time passed) without reverting
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const {
  addresses: A,
  fundUSDC,
  deployVaultWithAdapter,
  usdcFor,
} = require("./helpers/setup");

const forking = Boolean(process.env.FORK_BLOCK);

(forking ? describe : describe.skip)("ShadowVaultV15 — yield adapters (Arbitrum fork)", function () {
  this.timeout(300_000);

  const Tier = { FLEX: 0 };
  const DEPOSIT = ethers.parseUnits("5000", 6); // $5000

  let admin, alice;
  let USDC;

  before(async function () {
    [admin, alice] = await ethers.getSigners();
    USDC = await usdcFor(admin);
  });

  // ═════════════════════════════════════════════════════════════
  //  FluidAdapter — live fUSDC integration
  // ═════════════════════════════════════════════════════════════

  describe("FluidAdapter", function () {
    let vault, adapter;

    before(async function () {
      ({ vault, adapter } = await deployVaultWithAdapter(admin, "FluidAdapter", "Fluid Test"));
    });

    it("deposit routes USDC into live fUSDC", async function () {
      await fundUSDC(alice.address, DEPOSIT);
      const usdcAlice = await usdcFor(alice);
      await (await usdcAlice.approve(await vault.getAddress(), DEPOSIT)).wait();
      await (await vault.connect(alice).deposit(DEPOSIT, Tier.FLEX)).wait();

      // 30% of $5000 = $1500 to Fluid
      const adapterAssets = await adapter.totalAssets();
      expect(adapterAssets).to.be.gte(ethers.parseUnits("1499.9", 6));
      expect(adapterAssets).to.be.lte(ethers.parseUnits("1500.1", 6));

      // Adapter records principal
      expect(await adapter.totalPrincipal()).to.equal(ethers.parseUnits("1500", 6));
    });

    it("harvest returns 0 profit without reverting (no time passed)", async function () {
      const tx = await vault.connect(admin).harvestYield();
      const rcpt = await tx.wait();
      // harvestYield is a no-op when profit == 0, no revert expected
      expect(rcpt.status).to.equal(1);
    });

    it("requestWithdraw pulls yield leg from Fluid", async function () {
      await hre.network.provider.send("evm_mine", []);
      await (await vault.connect(alice).requestWithdraw(1)).wait();

      const pending = await vault.pendingWithdraws(1);
      // yieldUSDC should be ~$1500 (minus rounding)
      expect(pending.yieldUSDC).to.be.gte(ethers.parseUnits("1499.9", 6));
      expect(pending.yieldUSDC).to.be.lte(ethers.parseUnits("1500.1", 6));

      // Adapter balance after withdraw should be ~0
      const adapterAssets = await adapter.totalAssets();
      expect(adapterAssets).to.be.lte(ethers.parseUnits("0.01", 6));
    });

    it("completeWithdraw delivers USDC to user", async function () {
      const before = await USDC.balanceOf(alice.address);
      await (await vault.connect(admin).completeWithdraw(1)).wait();
      const after = await USDC.balanceOf(alice.address);
      expect(after - before).to.be.gt(ethers.parseUnits("4900", 6));
    });

    it("syncAccounting admin-only reset works", async function () {
      await (await adapter.connect(admin).syncAccounting(0)).wait();
      expect(await adapter.totalPrincipal()).to.equal(0);
    });
  });

  // ═════════════════════════════════════════════════════════════
  //  SiloAdapter — live Silo V2 wstUSR/USDC market
  // ═════════════════════════════════════════════════════════════

  describe("SiloAdapter", function () {
    let vault, adapter;

    before(async function () {
      ({ vault, adapter } = await deployVaultWithAdapter(admin, "SiloAdapter", "Silo Test"));
    });

    it("adapter points at the wstUSR/USDC V2 market by default", async function () {
      const silo = await adapter.silo();
      expect(silo.toLowerCase()).to.equal("0xa9a4bd976dbcfc2b89f554467ac85e2c758e2618");
    });

    it("deposit routes USDC into live Silo V2", async function () {
      await fundUSDC(alice.address, DEPOSIT);
      const usdcAlice = await usdcFor(alice);
      await (await usdcAlice.approve(await vault.getAddress(), DEPOSIT)).wait();
      await (await vault.connect(alice).deposit(DEPOSIT, Tier.FLEX)).wait();

      const adapterAssets = await adapter.totalAssets();
      // Silo shares may round down by 1 wei on mint — allow small tolerance.
      expect(adapterAssets).to.be.gte(ethers.parseUnits("1499.99", 6));
      expect(adapterAssets).to.be.lte(ethers.parseUnits("1500.01", 6));

      expect(await adapter.totalPrincipal()).to.equal(ethers.parseUnits("1500", 6));
    });

    it("harvest is a safe no-op when no profit accrued", async function () {
      const tx = await vault.connect(admin).harvestYield();
      await tx.wait();
    });

    it("requestWithdraw: REVERTS with AdapterPartialWithdraw when Silo is utilization-capped (v15.2 safety)", async function () {
      await hre.network.provider.send("evm_mine", []);

      // At this fork block wstUSR/USDC Silo is ~75% utilized, so a full
      // withdraw of the adapter's $1500 position recovers only ~$1129 (75.3%).
      // v15.2 requires ≥95% recovery — anything less reverts to protect the
      // position's yield share from being orphaned. User retries once
      // utilization drops.
      await expect(vault.connect(alice).requestWithdraw(1))
        .to.be.revertedWithCustomError(vault, "AdapterPartialWithdraw");

      // Position stays in NONE state so the user can retry later.
      const pos = await vault.positions(1);
      expect(pos.withdrawStatus).to.equal(0); // NONE
    });

    it("setSilo reverts when balance is non-zero", async function () {
      // Position 1 still has Silo shares (withdraw was reverted, position intact).
      const otherSilo = "0x2433D6AC11193b4695D9ca73530de93c538aD18a"; // sUSDX/USDC USDC-side
      await expect(adapter.connect(admin).setSilo(otherSilo))
        .to.be.revertedWithCustomError(adapter, "SiloBusy");
    });
  });
});
