// ═══════════════════════════════════════════════════════════════════════
//  v15-guards.test.js — access control + swap target allowlist +
//  sequencer uptime gate + drift-size caps. Runs against an Arbitrum fork.
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { deployStack, fundUSDC, usdcFor, addresses: A } = require("./helpers/setup");

const forking = Boolean(process.env.FORK_BLOCK);

(forking ? describe : describe.skip)("ShadowVaultV15 — guardrails (Arbitrum fork)", function () {
  this.timeout(300_000);

  let stack;
  let admin, alice, attacker;

  before(async function () {
    [admin, alice, attacker] = await ethers.getSigners();
    stack = await deployStack(admin);
  });

  // ───────── Access control ─────────

  it("non-admin cannot add basket tokens", async function () {
    await expect(
      stack.vaultA.connect(attacker).addBasketToken(A.WETH, 5000, A.ETH_USD_FEED, 8, 18, 0),
    ).to.be.reverted;
  });

  it("non-admin cannot change allocation", async function () {
    await expect(
      stack.vaultA.connect(attacker).setAllocation(5000, 5000),
    ).to.be.reverted;
  });

  it("non-keeper cannot execute basket buy", async function () {
    const dummyCalldata = "0x";
    await expect(
      stack.vaultA.connect(attacker).executeBuyBasket(
        A.USDC, 1_000_000, 0, await stack.mockSwapper.getAddress(), dummyCalldata,
      ),
    ).to.be.reverted;
  });

  it("non-keeper cannot harvest yield", async function () {
    await expect(stack.vaultA.connect(attacker).harvestYield()).to.be.reverted;
  });

  it("adapter rejects deposit from non-vault caller", async function () {
    await expect(
      stack.aaveAdapter.connect(attacker).deposit(1_000_000),
    ).to.be.reverted;
  });

  it("adapter syncAccounting gated to DEFAULT_ADMIN_ROLE", async function () {
    await expect(
      stack.aaveAdapter.connect(attacker).syncAccounting(0),
    ).to.be.reverted;

    // admin can do it
    await (await stack.aaveAdapter.connect(admin).syncAccounting(0)).wait();
    expect(await stack.aaveAdapter.totalPrincipal()).to.equal(0);
  });

  // ───────── Swap target allowlist ─────────

  it("rebalance reverts when swap target is not allowlisted", async function () {
    // Seed vault with some USDC so it's not a zero-amount revert
    const amt = ethers.parseUnits("100", 6);
    await fundUSDC(alice.address, amt);
    const usdcAlice = await usdcFor(alice);
    await (await usdcAlice.approve(await stack.vaultA.getAddress(), amt)).wait();
    await (await stack.vaultA.connect(alice).deposit(amt, 0)).wait();

    const randomTarget = ethers.Wallet.createRandom().address;
    await expect(
      stack.vaultA.connect(admin).executeRebalance(
        A.USDC, A.USDC, 1_000_000, 0, randomTarget, "0x",
      ),
    ).to.be.revertedWithCustomError(stack.vaultA, "UntrustedSwapTarget");
  });

  // ───────── Basket token validation ─────────

  it("executeBuyBasket reverts when tokenOut is not in the basket", async function () {
    await expect(
      stack.vaultA.connect(admin).executeBuyBasket(
        A.WETH, // not a basket token in the test setup (Pool A test config = USDC only)
        1_000_000,
        0,
        await stack.mockSwapper.getAddress(),
        "0x",
      ),
    ).to.be.revertedWithCustomError(stack.vaultA, "NotBasketToken");
  });

  // ───────── Pausable ─────────

  it("pause blocks new deposits, unpause restores them", async function () {
    await (await stack.vaultA.connect(admin).pause()).wait();

    const amt = ethers.parseUnits("5", 6);
    await fundUSDC(alice.address, amt);
    const usdcAlice = await usdcFor(alice);
    await (await usdcAlice.approve(await stack.vaultA.getAddress(), amt)).wait();

    await expect(stack.vaultA.connect(alice).deposit(amt, 0)).to.be.reverted;

    await (await stack.vaultA.connect(admin).unpause()).wait();
    // Deposit now succeeds
    await (await stack.vaultA.connect(alice).deposit(amt, 0)).wait();
  });

  // ───────── Adapter asset-mismatch constructor guard ─────────

  it("adapter asset() matches USDC", async function () {
    expect(await stack.aaveAdapter.asset()).to.equal(A.USDC);
  });

  // ───────── v15.1: per-token staleness ─────────

  it("addBasketToken rejects staleness above MAX_PRICE_STALENESS (7 days)", async function () {
    const tooHigh = 604800 + 1; // 1 week + 1 second
    await expect(
      stack.vaultA.connect(admin).addBasketToken(
        A.WETH, 1000, A.ETH_USD_FEED, 8, 18, tooHigh,
      ),
    ).to.be.revertedWithCustomError(stack.vaultA, "StalenessTooHigh");
  });

  it("setTokenStaleness lets admin tighten an existing token's window", async function () {
    // Pool A in the default deployStack has 1 basket token (USDC, index 0).
    // Updating it is a no-op functionally (stablecoin has no feed) but proves
    // the admin path works and the bound is enforced.
    await (await stack.vaultA.connect(admin).setTokenStaleness(0, 7200)).wait();
    await expect(
      stack.vaultA.connect(admin).setTokenStaleness(0, 604801),
    ).to.be.revertedWithCustomError(stack.vaultA, "StalenessTooHigh");
    await expect(
      stack.vaultA.connect(attacker).setTokenStaleness(0, 100),
    ).to.be.reverted;
  });
});
