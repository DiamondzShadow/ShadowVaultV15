// GmGmxAdapterV1 + GmNavOracle.
//   Unit (no fork):  npx hardhat test test/gmx-gm-v1.test.js
//   Fork (real GMX): FORK_BLOCK=<recent arbitrum block> npx hardhat test test/gmx-gm-v1.test.js
//
// The fork suite drives REAL GMX V2 contracts: it creates a GM deposit + withdrawal request, cancels them
// after GMX's REQUEST_EXPIRATION_TIME, and checks that GMX's own handler calls the adapter's callbacks
// (pending accounting cleared, funds refunded). That proves the struct layouts AND callback selectors match
// GMX — a mismatch is silent on mainnet because GMX swallows callback reverts.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const forking = Boolean(process.env.FORK_BLOCK);

// Arbitrum One — addresses from @gmx-io/sdk 2.9.1 configs + live ExchangeRouter getters (2026-11-17)
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const GM_ETH_USDC = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336";
const EXCHANGE_ROUTER = "0x6776c2b52179BC737193DE3bc75262681006AA27";
const DEPOSIT_VAULT = "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55";
const WITHDRAWAL_VAULT = "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55";
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734"; // 0x v2
const USDC_WHALE = "0xC6962004f452bE9203591991D15f6b388e09E8D0"; // Uniswap v3 WETH/USDC pool (fork only)
const GM_WHALE = "0x528A5bac7E746C9A509A1f4F6dF58A03d44279F9"; // GLV vault holding GM ETH/USDC (fork only)
const EXEC_FEE = ethers.parseEther("0.01");

async function impersonate(address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
  return ethers.getSigner(address);
}
async function warp(secs) {
  await hre.network.provider.send("evm_increaseTime", [secs]);
  await hre.network.provider.send("evm_mine", []);
}

describe("GmNavOracle (unit)", function () {
  let oracle, admin, keeper, guardian, other;
  const M = "0x00000000000000000000000000000000000000aa";

  beforeEach(async function () {
    [admin, keeper, guardian, other] = await ethers.getSigners();
    oracle = await (await ethers.getContractFactory("GmNavOracle")).deploy(admin.address);
    await oracle.grantRole(await oracle.KEEPER_ROLE(), keeper.address);
    await oracle.grantRole(await oracle.PAUSER_ROLE(), guardian.address);
    await oracle.registerMarket(M, 900, 1000); // 15 min, 10%
  });

  it("first push is free, later pushes are drift-capped", async function () {
    await oracle.connect(keeper).pushNav(M, 1_000_000_000n);
    expect(await oracle.getNavUsdc(M)).to.equal(1_000_000_000n);
    await oracle.connect(keeper).pushNav(M, 1_099_000_000n); // +9.9%
    await expect(oracle.connect(keeper).pushNav(M, 1_300_000_000n)).to.be.revertedWithCustomError(oracle, "DriftExceeded");
  });

  it("reverts when stale or frozen, lenient view still reads", async function () {
    await oracle.connect(keeper).pushNav(M, 5_000_000n);
    await warp(901);
    await expect(oracle.getNavUsdc(M)).to.be.revertedWithCustomError(oracle, "NavStale");
    const [nav, , stale] = await oracle.getNavLenient(M);
    expect(nav).to.equal(5_000_000n);
    expect(stale).to.equal(true);
    await oracle.connect(keeper).pushNav(M, 5_000_000n);
    await oracle.connect(guardian).setMarketPaused(M, true);
    await expect(oracle.getNavUsdc(M)).to.be.revertedWithCustomError(oracle, "MarketFrozen");
  });

  it("only the keeper pushes, only admin configures, unknown markets revert", async function () {
    await expect(oracle.connect(other).pushNav(M, 1n)).to.be.reverted;
    await expect(oracle.connect(keeper).registerMarket(other.address, 1, 1)).to.be.reverted;
    await expect(oracle.getNavUsdc(other.address)).to.be.revertedWithCustomError(oracle, "UnknownMarket");
    await expect(oracle.registerMarket(other.address, 0, 1)).to.be.revertedWithCustomError(oracle, "BadConfig");
  });
});

(forking ? describe : describe.skip)("GmGmxAdapterV1 — real GMX V2 on an Arbitrum fork", function () {
  this.timeout(600_000);
  let admin, stranger, usdc, gm, oracle, adapter;

  before(async function () {
    [admin, stranger] = await ethers.getSigners();
    usdc = await ethers.getContractAt("IERC20", USDC);
    gm = await ethers.getContractAt("IERC20", GM_ETH_USDC);

    oracle = await (await ethers.getContractFactory("GmNavOracle")).deploy(admin.address);
    await oracle.grantRole(await oracle.KEEPER_ROLE(), admin.address);
    await oracle.registerMarket(GM_ETH_USDC, 3600, 1000);
    await oracle.pushNav(GM_ETH_USDC, 0n); // no GM yet

    adapter = await (await ethers.getContractFactory("GmGmxAdapterV1")).deploy(
      admin.address, admin.address, admin.address, // admin, vault (test), keeper (test)
      GM_ETH_USDC, WETH, ETH_USD_FEED, await oracle.getAddress(),
      ALLOWANCE_HOLDER, EXCHANGE_ROUTER, DEPOSIT_VAULT, WITHDRAWAL_VAULT);

    const whale = await impersonate(USDC_WHALE);
    await usdc.connect(whale).transfer(admin.address, 2_000_000_000n); // $2,000
    await usdc.approve(await adapter.getAddress(), ethers.MaxUint256);
  });

  it("reads GMX router / roleStore / dataStore from the live ExchangeRouter", async function () {
    expect(await adapter.gmxRouter()).to.equal("0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6");
    expect(await adapter.roleStore()).to.equal("0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72");
  });

  it("vault deposit is custodied in the buffer", async function () {
    await adapter.deposit(1_000_000_000n);
    expect(await adapter.totalAssets()).to.equal(1_000_000_000n);
    expect(await adapter.bufferAssets()).to.equal(1_000_000_000n);
  });

  let depKey;
  it("deployToGm creates a real GMX deposit request and tracks it by key", async function () {
    const key = await adapter.deployToGm.staticCall(500_000_000n, 0n, { value: EXEC_FEE });
    await (await adapter.deployToGm(500_000_000n, 0n, { value: EXEC_FEE })).wait();
    depKey = key;
    expect(await adapter.pendingByKey(depKey)).to.equal(500_000_000n);
    expect(await adapter.pendingDepositUsdc()).to.equal(500_000_000n);
    expect(await adapter.bufferAssets()).to.equal(500_000_000n);
    expect(await adapter.totalAssets()).to.equal(1_000_000_000n); // buffer + pending + NAV(0)
    expect(await usdc.allowance(await adapter.getAddress(), await adapter.gmxRouter())).to.equal(0n);
  });

  it("settleDeposit refuses while GMX still has the request", async function () {
    await expect(adapter.connect(stranger).settleDeposit(depKey)).to.be.revertedWithCustomError(adapter, "StillPending");
  });

  it("callbacks reject anyone without GMX's CONTROLLER role", async function () {
    const empty = { addressItems: { items: [], arrayItems: [] }, uintItems: { items: [], arrayItems: [] },
      intItems: { items: [], arrayItems: [] }, boolItems: { items: [], arrayItems: [] },
      bytes32Items: { items: [], arrayItems: [] }, bytesItems: { items: [], arrayItems: [] },
      stringItems: { items: [], arrayItems: [] } };
    await expect(adapter.connect(stranger).afterDepositExecution(depKey, empty, empty))
      .to.be.revertedWithCustomError(adapter, "NotGmxHandler");
  });

  it("GMX's own cancellation refunds USDC and calls afterDepositCancellation", async function () {
    await warp(400); // > REQUEST_EXPIRATION_TIME (300 s)
    await expect(adapter.cancelGmxDeposit(depKey)).to.emit(adapter, "DepositSettled").withArgs(depKey, 500_000_000n, false);
    expect(await adapter.pendingByKey(depKey)).to.equal(0n);
    expect(await adapter.pendingDepositUsdc()).to.equal(0n);
    expect(await adapter.bufferAssets()).to.equal(1_000_000_000n);
    await expect(adapter.settleDeposit(depKey)).to.be.revertedWithCustomError(adapter, "UnknownKey");
  });

  it("withdrawal round trip: GMX request, cancel, callback, GM refunded", async function () {
    const gmWhale = await impersonate(GM_WHALE);
    const amt = ethers.parseEther("100"); // 100 GM
    await gm.connect(gmWhale).transfer(await adapter.getAddress(), amt);
    const key = await adapter.unwindFromGm.staticCall(amt, 0n, 0n, { value: EXEC_FEE });
    await expect(adapter.unwindFromGm(amt, 0n, 0n, { value: EXEC_FEE })).to.emit(adapter, "WithdrawalRequested").withArgs(key, amt);
    expect(await gm.balanceOf(await adapter.getAddress())).to.equal(0n);
    await warp(400);
    await expect(adapter.cancelGmxWithdrawal(key)).to.emit(adapter, "WithdrawalSettled").withArgs(key, false);
    expect(await gm.balanceOf(await adapter.getAddress())).to.equal(amt);
  });

  it("vault withdraw pays from the buffer only (partial when short)", async function () {
    const before = await usdc.balanceOf(admin.address);
    await adapter.withdraw(1_500_000_000n);
    expect((await usdc.balanceOf(admin.address)) - before).to.equal(1_000_000_000n);
  });

  it("rescue cannot touch USDC, GM or the index token", async function () {
    await expect(adapter.rescueToken(GM_ETH_USDC, admin.address, 1n)).to.be.revertedWith("protected");
    await expect(adapter.rescueToken(USDC, admin.address, 1n)).to.be.revertedWith("protected");
    await expect(adapter.rescueToken(WETH, admin.address, 1n)).to.be.revertedWith("protected");
  });

  it("only the keeper deploys / unwinds / cancels", async function () {
    await expect(adapter.connect(stranger).deployToGm(1n, 0n, { value: 1n })).to.be.reverted;
    await expect(adapter.connect(stranger).unwindFromGm(1n, 0n, 0n, { value: 1n })).to.be.reverted;
    await expect(adapter.connect(stranger).cancelGmxDeposit(depKey)).to.be.reverted;
  });
});
