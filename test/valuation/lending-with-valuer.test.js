// LendingPool × NFTValuer integration.
// Verifies:
//  - Pool.valueOf delegates to valuer when set, falls back to direct vault call when unset
//  - Borrow is gated by valuer.strategy == VAULT_UNWIND (refuses floor/static collateral in v1.3)
//  - Liquidation unwind target resolves via valuer.vaultFor(nft)
//  - Max-value clamp on valuer reduces effective collateral

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_BOND = 1_000n * 10n ** 6n;
const ONE_USDC = 10n ** 6n;

describe("LendingPool × NFTValuer", function () {
  this.timeout(60_000);

  let admin, treasury, project, alice, bob;
  let usdc, registry, vault, nft, pool, valuer, oracle;

  beforeEach(async function () {
    [admin, treasury, project, alice, bob] = await ethers.getSigners();

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

    const L = await ethers.getContractFactory("LendingPool");
    pool = await L.deploy(admin.address, await usdc.getAddress(), await registry.getAddress());

    const Val = await ethers.getContractFactory("NFTValuer");
    valuer = await Val.deploy(admin.address, await registry.getAddress());

    // Fund everyone
    for (const u of [project, alice, bob]) {
      await usdc.mint(u.address, 100_000n * ONE_USDC);
      await usdc.connect(u).approve(await registry.getAddress(), ethers.MaxUint256);
      await usdc.connect(u).approve(await pool.getAddress(), ethers.MaxUint256);
    }

    // Project opens digger, registers NFT at 50% LTV
    await registry.connect(project).openDigger(MIN_BOND, 1000, 7000, 2000);
    await registry.connect(project).registerCollection(1, await nft.getAddress(), ZERO, 5000);

    // Bob mints tokenId 1 → $10,000 value per vault
    await nft.mint(bob.address);
    await vault.setValue(1n, 10_000n * ONE_USDC);
    await nft.connect(bob).setApprovalForAll(await pool.getAddress(), true);

    // Alice supplies liquidity
    await pool.connect(alice).supply(50_000n * ONE_USDC);
  });

  describe("legacy path (valuer unset)", function () {
    it("pool.valueOf falls back to nft.vault().estimatePositionValue", async function () {
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(10_000n * ONE_USDC);
    });
    it("borrow works against vault-backed NFT via legacy path", async function () {
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 4_000n * ONE_USDC))
        .to.emit(pool, "Borrowed");
    });
  });

  describe("with valuer set → VAULT_POSITION", function () {
    beforeEach(async function () {
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 0);
      await pool.setValuer(await valuer.getAddress());
    });

    it("pool.valueOf delegates to valuer.liveValue", async function () {
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(10_000n * ONE_USDC);
      await vault.setValue(1n, 7_777n * ONE_USDC);
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(7_777n * ONE_USDC);
    });

    it("borrow succeeds (strategy == VAULT_UNWIND)", async function () {
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 4_000n * ONE_USDC))
        .to.emit(pool, "Borrowed");
    });

    it("max-clamp on valuer reduces borrow capacity", async function () {
      // Reconfigure with clamp at $2,000 → 50% LTV → max borrow $1,000
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 2_000n * ONE_USDC);
      // Vault still reads $10k but clamp says $2k
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(2_000n * ONE_USDC);

      // Try $4k borrow — would be 40% LTV without clamp, 200% LTV with (rejected)
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 4_000n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "LtvExceeded");

      // $900 borrow → 45% LTV on $2k → passes
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 900n * ONE_USDC))
        .to.emit(pool, "Borrowed");
    });

    it("setValuer to zero rolls back to legacy path", async function () {
      await pool.setValuer(ZERO);
      // Back to direct vault call
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(10_000n * ONE_USDC);
    });
  });

  describe("with valuer set → FLOOR_ORACLE (non-vault-unwind)", function () {
    beforeEach(async function () {
      await oracle.setFloor(await nft.getAddress(), 500n * ONE_USDC);
      await valuer.setFloorMode(await nft.getAddress(), await oracle.getAddress(), 0);
      await pool.setValuer(await valuer.getAddress());
    });

    it("borrow reverts with MarketplaceNotSet when strategy is MARKETPLACE_AUCTION and no marketplace wired", async function () {
      // v1.4: MARKETPLACE_AUCTION is now a valid strategy, but requires the
      // pool's marketplace pointer to be set before any borrow can land.
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "MarketplaceNotSet");
    });

    it("valueOf still returns the floor (useful for UI)", async function () {
      expect(await pool.getFunction("valueOf")(await nft.getAddress(), 1n)).to.eq(500n * ONE_USDC);
    });
  });

  describe("with valuer set → STATIC", function () {
    beforeEach(async function () {
      await valuer.setStaticMode(await nft.getAddress(), 3_000n * ONE_USDC);
      await pool.setValuer(await valuer.getAddress());
    });

    it("borrow reverts with MarketplaceNotSet when strategy is MARKETPLACE_AUCTION and no marketplace wired", async function () {
      await expect(pool.connect(bob).borrow(await nft.getAddress(), 1n, 100n * ONE_USDC))
        .to.be.revertedWithCustomError(pool, "MarketplaceNotSet");
    });
  });

  describe("admin setValuer", function () {
    it("only DEFAULT_ADMIN_ROLE can set", async function () {
      await expect(pool.connect(bob).setValuer(await valuer.getAddress())).to.be.reverted;
    });
    it("emits ValuerUpdated", async function () {
      await expect(pool.setValuer(await valuer.getAddress()))
        .to.emit(pool, "ValuerUpdated").withArgs(await valuer.getAddress());
    });
  });

  describe("liquidation path uses valuer.vaultFor()", function () {
    beforeEach(async function () {
      await valuer.setVaultMode(await nft.getAddress(), await vault.getAddress(), 0);
      await pool.setValuer(await valuer.getAddress());
      // Bob borrows $4k against $10k NFT (40% LTV, cap 50%)
      await pool.connect(bob).borrow(await nft.getAddress(), 1n, 4_000n * ONE_USDC);
    });

    it("trigger + complete use valuer.vaultFor(nft) not nft.vault()", async function () {
      // Advance past minLoanDuration
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine", []);

      // Crash vault value → loan underwater
      await vault.setValue(1n, 3_000n * ONE_USDC); // debt ~$4k > threshold on $3k collat

      // Configure vault to pay out $3k on completeWithdraw
      await usdc.mint(await vault.getAddress(), 3_000n * ONE_USDC);
      await vault.setNextPayout(1n, 3_000n * ONE_USDC);

      await expect(pool.connect(alice).triggerLiquidation(1n))
        .to.emit(pool, "LiquidationTriggered");

      await expect(pool.connect(alice).completeLiquidation(1n))
        .to.emit(pool, "LiquidationCompleted");
    });

    // Regression for the HIGH-severity finding from pre-deploy review:
    // if the admin reconfigures the valuer mid-loan (mode switch, clear,
    // or even `setValuer(0)`), liquidation MUST still resolve via the
    // unwind target snapshotted on the Loan at borrow time.
    it("mid-loan valuer.clear() does NOT brick liquidation (unwindTarget is snapshotted)", async function () {
      // Advance past minLoanDuration + make loan underwater
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine", []);
      await vault.setValue(1n, 3_000n * ONE_USDC);
      await usdc.mint(await vault.getAddress(), 3_000n * ONE_USDC);
      await vault.setNextPayout(1n, 3_000n * ONE_USDC);

      // Admin clears the valuer config for this collection. In the pre-fix
      // code, `_unwindTarget` would then call `valuer.vaultFor` which
      // reverts `NotVaultMode` on a cleared collection → liquidation
      // bricked. After the fix, the loan's snapshotted unwindTarget is
      // used, so liquidation still proceeds.
      await valuer.clear(await nft.getAddress());

      await expect(pool.connect(alice).triggerLiquidation(1n))
        .to.emit(pool, "LiquidationTriggered");
      await expect(pool.connect(alice).completeLiquidation(1n))
        .to.emit(pool, "LiquidationCompleted");
    });

    it("mid-loan setValuer(0) rollback does NOT brick liquidation", async function () {
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine", []);
      await vault.setValue(1n, 3_000n * ONE_USDC);
      await usdc.mint(await vault.getAddress(), 3_000n * ONE_USDC);
      await vault.setNextPayout(1n, 3_000n * ONE_USDC);

      // Admin rolls valuer back to 0 → even a cleared valuer state
      // doesn't affect the loan's stored unwindTarget.
      await pool.setValuer(ZERO);

      await expect(pool.connect(alice).triggerLiquidation(1n))
        .to.emit(pool, "LiquidationTriggered");
      await expect(pool.connect(alice).completeLiquidation(1n))
        .to.emit(pool, "LiquidationCompleted");
    });
  });

  describe("setVaultMode strict probe (fix for MED E)", function () {
    it("rejects an EOA as vault source", async function () {
      await expect(valuer.setVaultMode(await nft.getAddress(), bob.address, 0))
        .to.be.revertedWithCustomError(valuer, "VaultInterfaceCheckFailed");
    });
    it("rejects a contract with no estimatePositionValue selector (ERC20)", async function () {
      await expect(valuer.setVaultMode(await nft.getAddress(), await usdc.getAddress(), 0))
        .to.be.revertedWithCustomError(valuer, "VaultInterfaceCheckFailed");
    });
  });
});
