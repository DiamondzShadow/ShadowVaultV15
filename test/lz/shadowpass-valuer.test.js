// ShadowPassValuer composition math + oracle-state gating.
// Uses minimal stub contracts to avoid pulling in the full ShadowPass stack.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ONE_USDC = 10n ** 6n;

describe("ShadowPassValuer", function () {
  this.timeout(30_000);
  let valuer, pass, yr, br;
  let admin;

  beforeEach(async function () {
    [admin] = await ethers.getSigners();

    const Pass = await ethers.getContractFactory("MockShadowPass");
    const YR   = await ethers.getContractFactory("MockYieldReceipt");
    const BR   = await ethers.getContractFactory("MockBasketReceipt");
    pass = await Pass.deploy();
    yr   = await YR.deploy();
    br   = await BR.deploy();

    const V = await ethers.getContractFactory("ShadowPassValuer");
    valuer = await V.deploy(await pass.getAddress(), await yr.getAddress(), await br.getAddress());
  });

  describe("constructor", function () {
    it("rejects zero addresses", async function () {
      const V = await ethers.getContractFactory("ShadowPassValuer");
      const zero = "0x0000000000000000000000000000000000000000";
      await expect(V.deploy(zero, await yr.getAddress(), await br.getAddress()))
        .to.be.revertedWithCustomError(V, "ZeroAddress");
    });
  });

  describe("estimatePositionValue composition", function () {
    it("sums yield principal + accrued + basket value", async function () {
      // passId 1 → (yieldTokenId 11, basketTokenId 22)
      await pass.setWrapped(1n, 11n, 22n);
      // yield leg — principal $1000, accrued $50
      await yr.setPosition(11n, 1_000n * ONE_USDC, 1);
      await yr.setAccrued(11n, 50n * ONE_USDC);
      // basket leg — $2,500, not stale, not frozen
      await br.setValue(22n, 2_500n * ONE_USDC, false, false);

      const [b, y, t] = await valuer.estimatePositionValue(1n);
      expect(y).to.eq(1_050n * ONE_USDC);
      expect(b).to.eq(2_500n * ONE_USDC);
      expect(t).to.eq(3_550n * ONE_USDC);
    });

    it("treats frozen basket as 0 (lending refuses)", async function () {
      await pass.setWrapped(1n, 11n, 22n);
      await yr.setPosition(11n, 1_000n * ONE_USDC, 1);
      await yr.setAccrued(11n, 0n);
      // Basket frozen — valuer returns 0 for the basket leg regardless of reported value
      await br.setValue(22n, 2_500n * ONE_USDC, false, true /* frozen */);

      const [b, y, t] = await valuer.estimatePositionValue(1n);
      expect(b).to.eq(0n);
      expect(y).to.eq(1_000n * ONE_USDC);
      expect(t).to.eq(1_000n * ONE_USDC);
    });

    it("stale-but-not-frozen basket still reports value", async function () {
      await pass.setWrapped(1n, 11n, 22n);
      await yr.setPosition(11n, 1_000n * ONE_USDC, 1);
      await yr.setAccrued(11n, 25n * ONE_USDC);
      await br.setValue(22n, 3_000n * ONE_USDC, true /* stale */, false);

      const [b, y, t] = await valuer.estimatePositionValue(1n);
      expect(b).to.eq(3_000n * ONE_USDC);
      expect(t).to.eq(4_025n * ONE_USDC);
    });

    it("zero accrued + zero basket ⇒ yields principal only", async function () {
      await pass.setWrapped(1n, 11n, 22n);
      await yr.setPosition(11n, 500n * ONE_USDC, 0);
      // basket unset → stub returns (0, false, false)

      const [b, y, t] = await valuer.estimatePositionValue(1n);
      expect(b).to.eq(0n);
      expect(y).to.eq(500n * ONE_USDC);
      expect(t).to.eq(500n * ONE_USDC);
    });
  });

  describe("liveValueDetail flags", function () {
    it("returns (stale, frozen) from the basket oracle", async function () {
      await pass.setWrapped(1n, 11n, 22n);
      await yr.setPosition(11n, 1_000n * ONE_USDC, 0);
      await br.setValue(22n, 500n * ONE_USDC, true, true);
      const [bv, yv, tv, stale, frozen] = await valuer.liveValueDetail(1n);
      expect(stale).to.eq(true);
      expect(frozen).to.eq(true);
      expect(bv).to.eq(0n); // frozen ⇒ 0
      expect(yv).to.eq(1_000n * ONE_USDC);
      expect(tv).to.eq(1_000n * ONE_USDC);
    });
  });
});
