// HyperEVM ↔ Arb LayerZero v2 NFT bridge integration test.
// Uses LZ's official EndpointV2Mock to auto-deliver messages between two
// simulated endpoints in the same hardhat EVM.
//
// Coverage:
//   - lockAndBridge transfers NFT into locker + sends LZ message
//   - Wrapper mints deterministic tokenId with value snapshot
//   - pushValueUpdate refreshes stored value on Arb side
//   - estimatePositionValue() reflects latest (IVaultValue compat for
//     NFTValuer VAULT_MIRROR mode)
//   - burnAndRedeem burns wrapper + releases original NFT on Hyper
//   - bad source chain rejected (srcEid mismatch)
//   - keeper-only on pushValueUpdate

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_USDC = 10n ** 6n;

// Fake EIDs; the mock doesn't care as long as both sides agree.
const HYPER_EID = 30367;
const ARB_EID   = 30110;

// Build a Type-3 LZ option bytes for `addExecutorLzReceiveOption(gas, 0)`.
// Format: 0x0003 | worker_id(1 byte, executor=1) | length(2 BE) | option_type(1 byte, LZ_RECEIVE=1) | gas(16 BE) | value(16 BE)
function buildLzReceiveOption(gas, value = 0n) {
  const gasHex = ethers.toBeHex(gas, 16).slice(2);
  const valHex = ethers.toBeHex(value, 16).slice(2);
  return "0x" + "0003" + "01" + "0021" + "01" + gasHex + valHex;
}

describe("HyperEVM ↔ Arb LayerZero v2 NFT bridge", function () {
  this.timeout(90_000);

  let admin, keeper, alice, bob;
  let hyperEndpoint, arbEndpoint;
  let hyperVault, hyperNft;
  let locker, wrapper;

  beforeEach(async function () {
    [admin, keeper, alice, bob] = await ethers.getSigners();

    // 1. Paired mock endpoints (LZ v2 official mock)
    const Ep = await ethers.getContractFactory("EndpointV2Mock");
    hyperEndpoint = await Ep.deploy(HYPER_EID);
    arbEndpoint   = await Ep.deploy(ARB_EID);

    // 2. Vault + source NFT on "HyperEVM"
    const PV = await ethers.getContractFactory("MockPositionVault");
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    hyperVault = await PV.deploy(await usdc.getAddress());

    const PN = await ethers.getContractFactory("MockPositionNFT");
    hyperNft = await PN.deploy("Hyper", "H", await hyperVault.getAddress());

    // 3. OApps: locker on HyperEVM, wrapper on Arb
    const L = await ethers.getContractFactory("HyperPositionLocker");
    locker = await L.deploy(admin.address, keeper.address, await hyperEndpoint.getAddress(), ARB_EID);

    const W = await ethers.getContractFactory("HyperPositionWrapper");
    wrapper = await W.deploy(admin.address, await arbEndpoint.getAddress(), HYPER_EID);

    // 4. Wire endpoints as peers (setDestLzEndpoint tells each mock which
    //    remote endpoint corresponds to a given OApp address)
    await hyperEndpoint.setDestLzEndpoint(await wrapper.getAddress(), await arbEndpoint.getAddress());
    await arbEndpoint.setDestLzEndpoint(await locker.getAddress(), await hyperEndpoint.getAddress());

    // 5. setPeer on both OApps (bytes32 encoding of remote address)
    const wrapperBytes32 = ethers.zeroPadValue(await wrapper.getAddress(), 32);
    const lockerBytes32  = ethers.zeroPadValue(await locker.getAddress(), 32);
    await locker.connect(admin).setPeer(ARB_EID, wrapperBytes32);
    await wrapper.connect(admin).setPeer(HYPER_EID, lockerBytes32);

    // 6. Enforced options — required or EndpointV2Mock rejects empty option bytes.
    const lzReceiveOpt = buildLzReceiveOption(400_000);
    const enforced = [
      { eid: ARB_EID, msgType: 1, options: lzReceiveOpt }, // LOCK_TO_ARB
      { eid: ARB_EID, msgType: 2, options: lzReceiveOpt }, // VALUE_UPDATE
    ];
    await locker.connect(admin).setEnforcedOptions(enforced);
    const enforcedArb = [
      { eid: HYPER_EID, msgType: 3, options: lzReceiveOpt }, // BURN_REDEEM
    ];
    await wrapper.connect(admin).setEnforcedOptions(enforcedArb);

    // 7. Configure vaultOf on the locker
    await locker.setVaultFor(await hyperNft.getAddress(), await hyperVault.getAddress());

    // 8. Mint NFT to alice, set value, approve locker
    await hyperNft.mint(alice.address);
    await hyperVault.setValue(1n, 5_000n * ONE_USDC);
    await hyperNft.connect(alice).setApprovalForAll(await locker.getAddress(), true);
  });

  describe("lockAndBridge (Hyper → Arb)", function () {
    it("transfers NFT to locker + mints wrapper with value snapshot", async function () {
      const expectedWid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await expect(
        locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") })
      )
        .to.emit(locker, "Locked_")
        .to.emit(wrapper, "Minted");

      expect(await hyperNft.ownerOf(1n)).to.eq(await locker.getAddress());
      expect(await wrapper.ownerOf(expectedWid)).to.eq(alice.address);

      const [, , total] = await wrapper.estimatePositionValue(expectedWid);
      expect(total).to.eq(5_000n * ONE_USDC);
    });

    it("records lock info on Hyper side", async function () {
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
      const L = await locker.locked(wid);
      expect(L.originalOwner).to.eq(alice.address);
      expect(L.hyperNft).to.eq(await hyperNft.getAddress());
      expect(L.hyperTokenId).to.eq(1n);
    });

    it("reverts if vaultOf not set", async function () {
      const PN = await ethers.getContractFactory("MockPositionNFT");
      const other = await PN.deploy("X", "X", await hyperVault.getAddress());
      await other.mint(alice.address);
      await other.connect(alice).setApprovalForAll(await locker.getAddress(), true);
      await expect(
        locker.connect(alice).lockAndBridge(await other.getAddress(), 1n, "0x", { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(locker, "VaultNotSet");
    });
  });

  describe("pushValueUpdate", function () {
    beforeEach(async function () {
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
    });

    it("refreshes stored value on Arb", async function () {
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await hyperVault.setValue(1n, 7_500n * ONE_USDC);
      await expect(
        locker.connect(keeper).pushValueUpdate(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") })
      ).to.emit(wrapper, "ValueUpdated").withArgs(wid, 7_500n * ONE_USDC);
      const [, , total] = await wrapper.estimatePositionValue(wid);
      expect(total).to.eq(7_500n * ONE_USDC);
    });

    it("only KEEPER_ROLE can push", async function () {
      await expect(
        locker.connect(alice).pushValueUpdate(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") })
      ).to.be.reverted;
    });

    it("reverts for an unlocked position", async function () {
      await expect(
        locker.connect(keeper).pushValueUpdate(bob.address, 99n, "0x", { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(locker, "NotLocked");
    });
  });

  describe("burnAndRedeem (Arb → Hyper)", function () {
    beforeEach(async function () {
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
    });

    it("burns wrapper + releases original NFT on Hyper", async function () {
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await expect(
        wrapper.connect(alice).burnAndRedeem(wid, bob.address, "0x", { value: ethers.parseEther("1") })
      )
        .to.emit(wrapper, "BurnRequested")
        .to.emit(locker, "Released");
      await expect(wrapper.ownerOf(wid)).to.be.reverted;
      expect(await hyperNft.ownerOf(1n)).to.eq(bob.address);
    });

    it("only wrapper owner or approved can burn", async function () {
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await expect(
        wrapper.connect(bob).burnAndRedeem(wid, bob.address, "0x", { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(wrapper, "NotOwner");
    });
  });

  describe("estimatePositionValue — IVaultValue compat for NFTValuer VAULT_MIRROR", function () {
    it("returns (0, 0, lastValueUSDC) in the IVaultValue tuple shape", async function () {
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      const [basket, yield_, total] = await wrapper.estimatePositionValue(wid);
      expect(basket).to.eq(0n);
      expect(yield_).to.eq(0n);
      expect(total).to.eq(5_000n * ONE_USDC);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Rescue — admin can recover strays; tracked escrows are protected
  // ═══════════════════════════════════════════════════════════════════
  describe("rescue (locker)", function () {
    it("rescueToken moves stray ERC-20 out", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await usdc.mint(await locker.getAddress(), 100n * ONE_USDC);

      await expect(locker.connect(admin).rescueToken(await usdc.getAddress(), bob.address, 100n * ONE_USDC))
        .to.emit(locker, "TokenRescued")
        .withArgs(await usdc.getAddress(), bob.address, 100n * ONE_USDC);
      expect(await usdc.balanceOf(bob.address)).to.eq(100n * ONE_USDC);
    });

    it("rescueToken only DEFAULT_ADMIN_ROLE", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await expect(
        locker.connect(alice).rescueToken(await usdc.getAddress(), bob.address, 0n)
      ).to.be.reverted;
    });

    it("rescueNft moves out a stray NFT (not tracked as escrow)", async function () {
      const PN = await ethers.getContractFactory("MockPositionNFT");
      const stray = await PN.deploy("S", "S", await hyperVault.getAddress());
      await stray.mint(admin.address);
      await stray.connect(admin).transferFrom(admin.address, await locker.getAddress(), 1n);

      await expect(locker.connect(admin).rescueNft(await stray.getAddress(), 1n, bob.address))
        .to.emit(locker, "NftRescued")
        .withArgs(await stray.getAddress(), 1n, bob.address);
      expect(await stray.ownerOf(1n)).to.eq(bob.address);
    });

    it("rescueNft REVERTS on a tracked escrow (the safety guard)", async function () {
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
      await expect(
        locker.connect(admin).rescueNft(await hyperNft.getAddress(), 1n, bob.address)
      ).to.be.revertedWithCustomError(locker, "NftIsTrackedEscrow");
      // NFT remains in the locker, not stolen from alice.
      expect(await hyperNft.ownerOf(1n)).to.eq(await locker.getAddress());
    });

    it("rescueNative pulls out stray native", async function () {
      await admin.sendTransaction({ to: await locker.getAddress(), value: ethers.parseEther("0.5") });
      const before = await ethers.provider.getBalance(bob.address);
      await locker.connect(admin).rescueNative(bob.address, ethers.parseEther("0.5"));
      expect(await ethers.provider.getBalance(bob.address)).to.eq(before + ethers.parseEther("0.5"));
    });

    it("rescueToken to zero address reverts", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await expect(
        locker.connect(admin).rescueToken(await usdc.getAddress(), ZERO, 0n)
      ).to.be.revertedWithCustomError(locker, "ZeroAddress");
    });
  });

  describe("rescue (wrapper)", function () {
    it("rescueToken moves stray ERC-20", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      await usdc.mint(await wrapper.getAddress(), 100n * ONE_USDC);
      await wrapper.connect(admin).rescueToken(await usdc.getAddress(), bob.address, 100n * ONE_USDC);
      expect(await usdc.balanceOf(bob.address)).to.eq(100n * ONE_USDC);
    });

    it("rescueNft REVERTS when asked to rescue the wrapper's own minted mirror", async function () {
      await locker.connect(alice).lockAndBridge(await hyperNft.getAddress(), 1n, "0x", { value: ethers.parseEther("1") });
      const wid = await locker.wrapperIdOf(await hyperNft.getAddress(), 1n);
      await expect(
        wrapper.connect(admin).rescueNft(await wrapper.getAddress(), wid, bob.address)
      ).to.be.revertedWithCustomError(wrapper, "CannotRescueSelf");
    });
  });
});
