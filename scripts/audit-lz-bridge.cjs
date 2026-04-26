// Audit the LZ bridge wire-up: setPeer (both sides), enforced options, and
// the DVN setConfig on both libraries. Run per chain.

const hre = require("hardhat");

const path = require("node:path");
const LOCKER  = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json")).contracts.hyperPositionLocker;
const WRAPPER = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-arb.json")).contracts.hyperPositionWrapper;
const ARB_EID = 30110;
const HYPER_EID = 30367;

const LIBS = {
  42161: { sendUln302: "0x975bcD720be66659e3EB3C0e4F1866a3020E493A", receiveUln302: "0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6", endpoint: "0x1a44076050125825900e736c501f859c50fE728c" },
  999:   { sendUln302: "0xfd76d9CB0Bac839725aB79127E7411fe71b1e3CA", receiveUln302: "0x7cacBe439EaD55fa1c22790330b12835c6884a91", endpoint: "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9" },
};

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const oapp = chainId === 999 ? LOCKER : WRAPPER;
  const remote = chainId === 999 ? WRAPPER : LOCKER;
  const remoteEid = chainId === 999 ? ARB_EID : HYPER_EID;
  const libs = LIBS[chainId];

  const c = new hre.ethers.Contract(oapp, [
    "function peers(uint32) view returns (bytes32)",
    "function enforcedOptions(uint32,uint16) view returns (bytes)",
  ], hre.ethers.provider);

  console.log(`═══ LZ bridge audit — chain ${chainId} ═══`);
  console.log("OApp:", oapp);

  // Peer
  const peer = await c.peers(remoteEid);
  const expected = hre.ethers.zeroPadValue(remote, 32);
  console.log(`peer[eid=${remoteEid}]: ${peer}`);
  console.log(`  matches expected ${remote.slice(0,10)}…:`, peer.toLowerCase() === expected.toLowerCase());

  // Enforced options — check presence for all message types
  const msgTypes = chainId === 999 ? [1, 2] : [3];
  for (const mt of msgTypes) {
    const opt = await c.enforcedOptions(remoteEid, mt);
    console.log(`enforcedOptions[eid=${remoteEid}, msgType=${mt}]: ${opt.length > 2 ? "SET (" + opt.length/2 + " bytes)" : "EMPTY ✗"}`);
  }

  // Live DVN config readback via endpoint.getConfig
  const endpoint = new hre.ethers.Contract(libs.endpoint, [
    "function getConfig(address,address,uint32,uint32) view returns (bytes)",
  ], hre.ethers.provider);

  for (const [label, lib] of [["send", libs.sendUln302], ["receive", libs.receiveUln302]]) {
    try {
      const raw = await endpoint.getConfig(oapp, lib, remoteEid, 2 /* CONFIG_TYPE_ULN */);
      const [cfg] = hre.ethers.AbiCoder.defaultAbiCoder().decode([
        "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)"
      ], raw);
      console.log(`\n${label}Uln302 ULN config (eid=${remoteEid}):`);
      console.log(`  confirmations        : ${cfg.confirmations}`);
      console.log(`  requiredDVNCount     : ${cfg.requiredDVNCount}`);
      console.log(`  optionalDVNCount     : ${cfg.optionalDVNCount}`);
      console.log(`  optionalDVNThreshold : ${cfg.optionalDVNThreshold}`);
      console.log(`  requiredDVNs         :`, cfg.requiredDVNs);
      console.log(`  optionalDVNs         :`, cfg.optionalDVNs);

      // Security gates
      const ok = (cfg.requiredDVNCount >= 2n || (cfg.requiredDVNCount >= 1n && cfg.optionalDVNCount >= 1n && cfg.optionalDVNThreshold >= 1n));
      console.log(`  ⇒ ${ok ? "✓ multi-DVN (safe)" : "✗ WEAK — 1/1 setup (unsafe — Kelp footgun)"}`);
    } catch (e) {
      console.log(`${label}Uln302 getConfig failed:`, e.shortMessage || e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
