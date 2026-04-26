// LZ message recovery on the Arb side — Wrapper B (0x72bD38e7...) is the
// receiver of two LOCK packets sent from Locker A on HyperEVM but never
// delivered (0 DVN signatures, stuck 90+ min).
//
// Strategy: temporarily reconfigure Wrapper B's receive ULN config so the
// deployer EOA is the sole required DVN, sign both packet hashes from the
// deployer, commit, then execute. Restore the original 4-DVN config when done.
//
// What this is NOT: a permanent backdoor. The receive config gets restored at
// the end so future inbound LZ messages still need the real 2-of-2 + 2-optional
// DVN spec. We never touch the locker's send-side config.
//
// Refs:
//   ReceiveUln302.verify(bytes,bytes32,uint64)
//   ReceiveUln302.commitVerification(bytes,bytes32)
//   EndpointV2.lzReceive(Origin,address,bytes32,bytes,bytes)

const hre = require("hardhat");

const WRAPPER_B   = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const ENDPOINT    = "0x1a44076050125825900e736c501f859c50fE728c";
const RECV_ULN    = "0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6";
const SEND_ULN    = "0x975bcD720be66659e3EB3C0e4F1866a3020E493A";
const HYPER_EID   = 30367;

const LOCKER_A    = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const POOL_E_NFT  = "0x5f90c2f0e9ce11a19d49a2e54d9df7759c7581ae";
const USER        = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const CONFIG_TYPE_ULN = 2;
const PACKET_VERSION = 1;

// --- Real DVN set (current/intended config — restored at end) ---
const REAL_DVNS = {
  required: [
    "0x2f55c492897526677c5b68fb199ea31e2c126416", // LZ Labs
    "0xa7b5189bca84cd304d8553977c7c614329750d99", // Nethermind
  ],
  optional: [
    "0x0711dd777ae626ef5e0a4f50e199c7a0e0666857", // BitGo
    "0x19670df5e16bea2ba9b9e68b48c054c5baea06b8", // Horizen
  ],
  threshold: 1,
  confirmations: 20n,
};

// --- The two stuck packets, copied from LZ scan ---
const STUCK = [
  {
    nonce: 1,
    guid: "0x61e15b7213cd3c740b91c443f912fa200e9c6657b082dd9f1572edbb849e6a26",
    payload: "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000c5d133296e17ba25df0409a6c31607bf3b78e3e30000000000000000000000005f90c2f0e9ce11a19d49a2e54d9df7759c7581ae000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000004c4b9c",
    label: "tokenId 2",
  },
  {
    nonce: 2,
    guid: "0xe8ce2853a17ea31773dfa9c5f54ae6cb6dbd0b9666004808ff745bbe7c7283ad",
    payload: "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000c5d133296e17ba25df0409a6c31607bf3b78e3e30000000000000000000000005f90c2f0e9ce11a19d49a2e54d9df7759c7581ae000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000004c4b9f",
    label: "tokenId 1",
  },
];

function pad32hex(addrOrHex) {
  let h = addrOrHex.toLowerCase().replace(/^0x/, "");
  while (h.length < 64) h = "0" + h;
  return "0x" + h;
}

// Per LZ ULN: keccak256(packed(version u8, nonce u64, srcEid u32, sender b32,
//                              dstEid u32, receiver b32)) — 81 bytes total.
function buildPacketHeader(nonce, srcEid, sender, dstEid, receiver) {
  const v   = hre.ethers.toBeHex(PACKET_VERSION, 1).slice(2);
  const n   = hre.ethers.toBeHex(BigInt(nonce), 8).slice(2);
  const se  = hre.ethers.toBeHex(srcEid, 4).slice(2);
  const sb  = pad32hex(sender).slice(2);
  const de  = hre.ethers.toBeHex(dstEid, 4).slice(2);
  const rb  = pad32hex(receiver).slice(2);
  return "0x" + v + n + se + sb + de + rb;
}

// Per LZ Encoder: payloadHash = keccak256(guid || message)
function buildPayloadHash(guid, message) {
  const g = guid.replace(/^0x/, "");
  const m = message.replace(/^0x/, "");
  return hre.ethers.keccak256("0x" + g + m);
}

function encodeUlnConfig({ confirmations, required, optional, threshold }) {
  const sortAsc = (arr) => [...arr].sort((a,b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)"],
    [{
      confirmations,
      requiredDVNCount: required.length,
      optionalDVNCount: optional.length,
      optionalDVNThreshold: threshold,
      requiredDVNs: sortAsc(required),
      optionalDVNs: sortAsc(optional),
    }]
  );
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const me = await signer.getAddress();
  console.log("signer:", me);
  if (me.toLowerCase() !== USER.toLowerCase()) throw new Error("not deployer");

  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 42161) throw new Error(`expected Arb 42161, got ${chainId}`);

  const endpoint = new hre.ethers.Contract(ENDPOINT, [
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params) external",
    "function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) external payable",
    "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
    "function verifiable(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver) view returns (bool)",
  ], signer);

  const recvUln = new hre.ethers.Contract(RECV_ULN, [
    "function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external",
    "function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external",
    "function hashLookup(bytes32 headerHash, bytes32 payloadHash, address dvn) view returns (uint64 confirmations, bool submitted)",
  ], signer);

  // --- 1. snapshot original config ---
  console.log("\n[1] snapshot original receive ULN config");
  const origConfig = await endpoint.getConfig(WRAPPER_B, RECV_ULN, HYPER_EID, CONFIG_TYPE_ULN);
  console.log("    saved:", origConfig.slice(0, 70) + "...");

  // --- 2. flip to deployer-as-sole-DVN ---
  console.log("\n[2] set receive ULN config: requiredDVNs=[deployer] (1-of-1)");
  const tempConfig = encodeUlnConfig({
    confirmations: 1n,
    required: [me],
    optional: [],
    threshold: 0,
  });
  const tx2 = await endpoint.setConfig(WRAPPER_B, RECV_ULN, [
    { eid: HYPER_EID, configType: CONFIG_TYPE_ULN, config: tempConfig },
  ]);
  console.log("    tx:", tx2.hash);
  await tx2.wait();

  try {
    // --- 3. sign + commit each stuck packet ---
    for (const pkt of STUCK) {
      console.log(`\n[3] packet ${pkt.label} (nonce ${pkt.nonce})`);
      const header = buildPacketHeader(pkt.nonce, HYPER_EID, LOCKER_A, 30110, WRAPPER_B);
      const phash  = buildPayloadHash(pkt.guid, pkt.payload);
      console.log("    header:", header);
      console.log("    phash :", phash);

      console.log("    → recvUln.verify");
      const tx3a = await recvUln.verify(header, phash, 1n);
      await tx3a.wait();
      console.log("      tx:", tx3a.hash);

      console.log("    → recvUln.commitVerification");
      const tx3b = await recvUln.commitVerification(header, phash);
      await tx3b.wait();
      console.log("      tx:", tx3b.hash);

      const senderBytes32 = pad32hex(LOCKER_A);
      const origin = { srcEid: HYPER_EID, sender: senderBytes32, nonce: pkt.nonce };
      const verifiable = await endpoint.verifiable(origin, WRAPPER_B);
      console.log("    endpoint.verifiable:", verifiable);
    }

    // --- 4. execute lzReceive for each (mints wrapper) ---
    for (const pkt of STUCK) {
      console.log(`\n[4] lzReceive ${pkt.label}`);
      const senderBytes32 = pad32hex(LOCKER_A);
      const origin = { srcEid: HYPER_EID, sender: senderBytes32, nonce: pkt.nonce };
      const tx4 = await endpoint.lzReceive(origin, WRAPPER_B, pkt.guid, pkt.payload, "0x");
      console.log("    tx:", tx4.hash);
      await tx4.wait();
    }
  } finally {
    // --- 5. restore original config (always) ---
    console.log("\n[5] restore original receive ULN config (4-DVN)");
    const restored = encodeUlnConfig(REAL_DVNS);
    const tx5 = await endpoint.setConfig(WRAPPER_B, RECV_ULN, [
      { eid: HYPER_EID, configType: CONFIG_TYPE_ULN, config: restored },
    ]);
    console.log("    tx:", tx5.hash);
    await tx5.wait();
    console.log("    ✓ restored");
  }

  // --- 6. confirm wrappers landed ---
  const wrapper = new hre.ethers.Contract(WRAPPER_B, [
    "function balanceOf(address) view returns (uint256)",
    "function ownerOf(uint256) view returns (address)",
  ], signer);
  const bal = await wrapper.balanceOf(USER);
  console.log(`\n[6] wrapper.balanceOf(${USER}) = ${bal}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
