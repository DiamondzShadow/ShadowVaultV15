const hre = require("hardhat");

const LOCKER          = "0xFC8f588bF9CCa0D1832F2735236Fc3eecdbc7381";
const WRAPPER         = "0x4228b8E98786F26bb43dF217F18Af9E8D537fd68";
const SHADOWPASS      = "0x397BaB25a41Aaa5cF76F19DE8794D5476B576CCC";
const SHADOWPASS_VALR = "0x27980Da17BAC6884631412b30B5eD1C49915C702";
const HYPERSKIN       = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0"; // Pool E
const POOL_E_VAULT_V2 = null; // fill from config if needed
const VALUER_V2_ARB   = "0xD90f5aE128118D9477C47478B9c5acbD69190ca1";
const REGISTRY_ARB    = null; // fetch from marketplace config
const KEEPER          = "0xCD20FE6E10838d8AEc242E0438A65c3d704D3E3d";

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  console.log(`═══ extras audit — chain ${chainId} ═══`);

  if (chainId === 999) {
    const locker = new hre.ethers.Contract(LOCKER, [
      "function vaultOf(address) view returns (address)",
      "function KEEPER_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function owner() view returns (address)",
    ], hre.ethers.provider);

    const shadowPassVault = await locker.vaultOf(SHADOWPASS);
    console.log("locker.vaultOf(ShadowPass):", shadowPassVault);
    console.log("  expected (ShadowPassValuer):", SHADOWPASS_VALR);
    console.log("  match:", shadowPassVault.toLowerCase() === SHADOWPASS_VALR.toLowerCase());

    const skinVault = await locker.vaultOf(HYPERSKIN);
    console.log("locker.vaultOf(HyperSkin Pool E):", skinVault);
    console.log("  set:", skinVault !== hre.ethers.ZeroAddress);

    const keeperRole = await locker.KEEPER_ROLE();
    console.log("locker.hasRole(KEEPER, 0xCD20…3E3d):", await locker.hasRole(keeperRole, KEEPER));
    console.log("locker.owner():", await locker.owner());

    const hypeBal = await hre.ethers.provider.getBalance(KEEPER);
    console.log(`\nKeeper HYPE balance: ${hre.ethers.formatEther(hypeBal)} HYPE (need ≥0.1)`);

    // Try one live valuer call on tokenId 1 (if ShadowPass #1 exists)
    try {
      const valr = new hre.ethers.Contract(SHADOWPASS_VALR, [
        "function estimatePositionValue(uint256) view returns (uint256)",
      ], hre.ethers.provider);
      const v = await valr.estimatePositionValue(1);
      console.log(`ShadowPassValuer.estimatePositionValue(1): ${hre.ethers.formatUnits(v, 6)} USDC (0 = no pass minted or oracle frozen)`);
    } catch (e) {
      console.log("valuer call failed:", e.shortMessage || e.message);
    }
  }

  if (chainId === 42161) {
    const wrapper = new hre.ethers.Contract(WRAPPER, [
      "function polygonLocker() view returns (address)",
      "function hyperLocker() view returns (address)",
      "function owner() view returns (address)",
    ], hre.ethers.provider);
    try { console.log("wrapper.hyperLocker():", await wrapper.hyperLocker()); } catch (e) {
      try { console.log("wrapper.polygonLocker() (old name):", await wrapper.polygonLocker()); } catch {}
    }
    console.log("wrapper.owner():", await wrapper.owner());

    const valuer = new hre.ethers.Contract(VALUER_V2_ARB, [
      "function modeOf(address) view returns (uint8)",
      "function estimate(address,uint256) view returns (uint256)",
    ], hre.ethers.provider);
    try {
      const mode = await valuer.modeOf(WRAPPER);
      const names = ["NONE", "VAULT_POSITION", "VAULT_MIRROR"];
      console.log(`NFTValuer.modeOf(wrapper): ${mode} (${names[Number(mode)] || "?"})`);
    } catch (e) {
      console.log("valuer modeOf failed:", e.shortMessage || e.message);
    }

    // Registry: query the canonical digger registry if we can locate it
    // Marketplace config might have it
    try {
      const mkt = require("../config/deployed-marketplace-arb.json");
      if (mkt.registry || mkt.diggerRegistry) {
        const regAddr = mkt.registry || mkt.diggerRegistry;
        const reg = new hre.ethers.Contract(regAddr, [
          "function isRegistered(address) view returns (bool)",
          "function collectionLtvBps(address) view returns (uint16)",
        ], hre.ethers.provider);
        console.log(`DiggerRegistry.isRegistered(wrapper): ${await reg.isRegistered(WRAPPER)}`);
        try { console.log(`DiggerRegistry.collectionLtvBps(wrapper): ${await reg.collectionLtvBps(WRAPPER)}`); } catch {}
      }
    } catch (e) { console.log("registry check skipped:", e.message.slice(0,80)); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
