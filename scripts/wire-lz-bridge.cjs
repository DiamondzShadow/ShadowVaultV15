// Cross-chain wire-up for the LZ bridge.
//
// Per-chain sequence (run twice — once on each network):
//   1. setPeer(remoteEid, bytes32(remoteAddr))
//   2. setEnforcedOptions — Type 3 LZ option, 400k gas on destination
//   3. setConfig on BOTH send + receive libraries, pinning:
//        requiredDVNs = [LZ Labs, Nethermind] sorted ASC (2/2)
//        optionalDVNs = [Horizen, BitGo]       sorted ASC (1-of-2)
//      This eliminates the 1-of-1 attack that killed Kelp's $292M bridge.
//
// Also (Arb only, done once):
//   4. DiggerRegistry.registerCollection(wrapper, 0, 5000bps)
//   5. NFTValuer.setMirrorMode(wrapper, wrapper, 0)
//   6. Locker.setVaultFor(...) for each Hyper NFT we want bridgeable
//      (initially Pool E HyperSkin, whose vault has estimatePositionValue)

const hre  = require("hardhat");
const path = require("node:path");

// ───── DVN addresses (verified via metadata.layerzero-api.com, 2026-04-21)
const DVNS = {
  // Arbitrum (30110)
  42161: {
    sendUln:    null,    // fetched dynamically
    receiveUln: null,
    lzLabs:     "0x2f55c492897526677c5b68fb199ea31e2c126416",
    nethermind: "0xa7b5189bca84cd304d8553977c7c614329750d99",
    horizen:    "0x19670df5e16bea2ba9b9e68b48c054c5baea06b8",
    bitgo:      "0x0711dd777ae626ef5e0a4f50e199c7a0e0666857",
  },
  // HyperEVM (30367)
  999: {
    sendUln:    null,
    receiveUln: null,
    lzLabs:     "0xc097ab8cd7b053326dfe9fb3e3a31a0cce3b526f",
    nethermind: "0x8e49ef1dfae17e547ca0e7526ffda81fbaca810a",
    horizen:    "0xbb83ecf372cbb6daa629ea9a9a53bec6d601f229",
    bitgo:      "0xf55e9daef79eec17f76e800f059495f198ef8348",
  },
};

// LZ send/receive library addresses per chain (from metadata API):
const LIBS = {
  42161: {
    sendUln302:    "0x975bcD720be66659e3EB3C0e4F1866a3020E493A",
    receiveUln302: "0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6",
  },
  // Verified via metadata.layerzero-api.com/v1/metadata/deployments on 2026-04-21
  999: {
    sendUln302:    "0xfd76d9CB0Bac839725aB79127E7411fe71b1e3CA",
    receiveUln302: "0x7cacBe439EaD55fa1c22790330b12835c6884a91",
  },
};

// Addresses are loaded fresh from config on each run so redeploys flow
// through without hand-editing this file.
const hyperCfg = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json"));
const arbCfg   = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-arb.json"));
const LOCKER  = hyperCfg.contracts.hyperPositionLocker;
const WRAPPER = arbCfg.contracts.hyperPositionWrapper;

const HYPER_EID = 30367;
const ARB_EID   = 30110;

const CONFIG_TYPE_ULN = 2;

// Type-3 option: LZ v2 executor lzReceive option with gas=400k, value=0
function buildLzReceiveOption(gas) {
  const gasHex = hre.ethers.toBeHex(gas, 16).slice(2);
  const valHex = hre.ethers.toBeHex(0n, 16).slice(2);
  return "0x" + "0003" + "01" + "0021" + "01" + gasHex + valHex;
}

// UlnConfig ABI-encoded
function encodeUlnConfig({ confirmations, required, optional, threshold }) {
  const sortAsc = (arr) => [...arr].sort((a,b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  const requiredSorted = sortAsc(required);
  const optionalSorted = sortAsc(optional);
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)"],
    [{
      confirmations,
      requiredDVNCount: required.length,
      optionalDVNCount: optional.length,
      optionalDVNThreshold: threshold,
      requiredDVNs: requiredSorted,
      optionalDVNs: optionalSorted,
    }]
  );
}

async function main() {
  const [admin] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  console.log(`\n═══ LZ bridge wiring — chain ${chainId} ═══`);
  console.log("Signer:", admin.address);

  const oappAddr = chainId === 999 ? LOCKER : WRAPPER;
  const remoteEid = chainId === 999 ? ARB_EID : HYPER_EID;
  const remoteAddr = chainId === 999 ? WRAPPER : LOCKER;
  const endpointAddr = chainId === 999
    ? "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9"
    : "0x1a44076050125825900e736c501f859c50fE728c";
  const dvns = DVNS[chainId];
  const libs = LIBS[chainId];
  const msgTypes = chainId === 999 ? [1, 2] : [3];

  const oapp = new hre.ethers.Contract(oappAddr, [
    "function setPeer(uint32,bytes32) external",
    "function peers(uint32) view returns (bytes32)",
    "function setEnforcedOptions(tuple(uint32 eid, uint16 msgType, bytes options)[]) external",
    "function endpoint() view returns (address)",
  ], admin);

  // ───── Step 1: setPeer
  console.log("\n1. setPeer");
  const remoteBytes32 = hre.ethers.zeroPadValue(remoteAddr, 32);
  const curPeer = await oapp.peers(remoteEid);
  if (curPeer.toLowerCase() === remoteBytes32.toLowerCase()) {
    console.log("   already set ✓");
  } else {
    const tx = await oapp.setPeer(remoteEid, remoteBytes32);
    await tx.wait();
    console.log("   tx:", tx.hash);
  }

  // ───── Step 2: setEnforcedOptions
  console.log("\n2. setEnforcedOptions (400k gas dst)");
  const opt = buildLzReceiveOption(400_000n);
  const enforced = msgTypes.map(mt => ({ eid: remoteEid, msgType: mt, options: opt }));
  const tx2 = await oapp.setEnforcedOptions(enforced);
  await tx2.wait();
  console.log("   tx:", tx2.hash);

  // ───── Step 3: setConfig ULN on both libs (DVN pin — CRITICAL)
  console.log("\n3. setConfig (DVN pin: 2 required + 2 optional 1-of-2)");
  const endpoint = new hre.ethers.Contract(endpointAddr, [
    "function setConfig(address,address,tuple(uint32 eid, uint32 configType, bytes config)[]) external",
  ], admin);

  const ulnConfig = encodeUlnConfig({
    confirmations: 20n,
    required: [dvns.lzLabs, dvns.nethermind],
    optional: [dvns.horizen, dvns.bitgo],
    threshold: 1,
  });

  const params = [{ eid: remoteEid, configType: CONFIG_TYPE_ULN, config: ulnConfig }];

  console.log("   → endpoint.setConfig(oapp, sendUln302, ULN)");
  const tx3a = await endpoint.setConfig(oappAddr, libs.sendUln302, params);
  await tx3a.wait();
  console.log("     tx:", tx3a.hash);

  console.log("   → endpoint.setConfig(oapp, receiveUln302, ULN)");
  const tx3b = await endpoint.setConfig(oappAddr, libs.receiveUln302, params);
  await tx3b.wait();
  console.log("     tx:", tx3b.hash);

  console.log(`\n✓ chain ${chainId} wired`);

  if (chainId === 42161) {
    // Arb extra: DiggerRegistry + NFTValuer config
    console.log("\n═══ Arb-side extras ═══");
    const mCfg = require(path.resolve(__dirname, "..", "config", "deployed-marketplace-arb.json"));
    const lCfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));

    console.log("\n4. DiggerRegistry.registerCollection(wrapper, 0, 5000 bps)");
    const registry = await hre.ethers.getContractAt("DiggerRegistry", mCfg.contracts.diggerRegistry);
    const col = await registry.collections(WRAPPER);
    if (col.accepted) {
      console.log("   already registered ✓");
    } else {
      const rtx = await registry.registerCollection(1n, WRAPPER, hre.ethers.ZeroAddress, 5000);
      await rtx.wait();
      console.log("   tx:", rtx.hash);
    }

    console.log("\n5. NFTValuer.setMirrorMode(wrapper, wrapper, 0)");
    const valuer = await hre.ethers.getContractAt("NFTValuer", lCfg.contracts.nftValuer);
    const [mode] = await valuer.configOf(WRAPPER);
    if (Number(mode) === 4) {
      console.log("   already VAULT_MIRROR ✓");
    } else {
      const vtx = await valuer.setMirrorMode(WRAPPER, WRAPPER, 0);
      await vtx.wait();
      console.log("   tx:", vtx.hash);
    }
  }

  if (chainId === 999) {
    // Hyper extra: configure vaultOf for Pool E HyperSkin
    console.log("\n═══ HyperEVM-side extras ═══");
    const poolE = require(path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"));
    console.log(`\n4. locker.setVaultFor(PoolE HyperSkin, PoolE vault)`);
    console.log(`   skin  : ${poolE.skin}`);
    console.log(`   vault : ${poolE.vault}`);
    const locker = await hre.ethers.getContractAt("HyperPositionLocker", LOCKER);
    const cur = await locker.vaultOf(poolE.skin);
    if (cur.toLowerCase() === poolE.vault.toLowerCase()) {
      console.log("   already set ✓");
    } else {
      const ltx = await locker.setVaultFor(poolE.skin, poolE.vault);
      await ltx.wait();
      console.log("   tx:", ltx.hash);
    }

    // ShadowPass via ShadowPassValuer (sums yield + basket receipts)
    const spCfgPath = path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json");
    try {
      const sp = require(spCfgPath);
      if (sp.shadowPassValuer && sp.shadowPass) {
        console.log("\n5. locker.setVaultFor(ShadowPass, ShadowPassValuer)");
        console.log(`   pass   : ${sp.shadowPass}`);
        console.log(`   valuer : ${sp.shadowPassValuer}`);
        const curSp = await locker.vaultOf(sp.shadowPass);
        if (curSp.toLowerCase() === sp.shadowPassValuer.toLowerCase()) {
          console.log("   already set ✓");
        } else {
          const stx = await locker.setVaultFor(sp.shadowPass, sp.shadowPassValuer);
          await stx.wait();
          console.log("   tx:", stx.hash);
        }
      }
    } catch (e) { console.log("   (shadowpass config not found — skipping)"); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
