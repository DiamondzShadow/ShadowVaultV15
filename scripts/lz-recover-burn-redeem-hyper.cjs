// Phase 2 — Hyper side: deliver the BURN_REDEEM packets that the burn txs
// just emitted on Arb. Same DVN-bypass trick as Phase 1: temporarily set
// Locker A's receive ULN config to require deployer EOA as the only DVN,
// sign the two stuck packets, execute, restore.
//
// On success Locker A._lzReceive runs, which transfers the original NFT
// to redeemer (= deployer = user).

const hre = require("hardhat");

const LOCKER_A    = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const ENDPOINT    = "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9";
const RECV_ULN    = "0x7cacBe439EaD55fa1c22790330b12835c6884a91";
const ARB_EID     = 30110;
const HYPER_EID   = 30367;

const WRAPPER_B   = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const NFT         = "0x5f90c2f0e9ce11a19d49a2e54d9df7759c7581ae";
const USER        = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const CONFIG_TYPE_ULN = 2;
const PACKET_VERSION = 1;

// Real DVN set on the Hyper side (per memory + audit log) — restored at end.
const REAL_DVNS = {
  required: [
    "0xc097ab8cd7b053326dfe9fb3e3a31a0cce3b526f", // LZ Labs
    "0x8e49ef1dfae17e547ca0e7526ffda81fbaca810a", // Nethermind
  ],
  optional: [
    "0xbb83ecf372cbb6daa629ea9a9a53bec6d601f229", // Horizen
    "0xf55e9daef79eec17f76e800f059495f198ef8348", // BitGo
  ],
  threshold: 1,
  confirmations: 20n,
};

// Compute payload for BURN_REDEEM(action=3, wid, redeemer)
function burnRedeemPayload(wid, redeemer) {
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint8", "uint256", "address"],
    [3, wid, redeemer]
  );
}

// Two BurnRequested-emitted GUIDs from the actual burn tx receipts on Arb.
const STUCK = [
  {
    label: "wid for tokenId 1",
    wid: "0x07f34e1205e64ad351aeefb800ce210de00f0f430c96f8899afa743769e8301d",
    nonce: 1,
    guid: "0x49254d4712a1979716bd158610ce2161e42cf82807de9452abee2a6562408e8b",
  },
  {
    label: "wid for tokenId 2",
    wid: "0x0041544b40f3dd396120a786df1974ef59e4e66dadaa18cf05d61a1d0afa323d",
    nonce: 2,
    guid: "0xb49453b0ba38062b460b43f963416ca4d2fdd8acf46e2d8edb38f8be9245377d",
  },
];

function pad32hex(addrOrHex) {
  let h = addrOrHex.toLowerCase().replace(/^0x/, "");
  while (h.length < 64) h = "0" + h;
  return "0x" + h;
}

function buildPacketHeader(nonce, srcEid, sender, dstEid, receiver) {
  const v   = hre.ethers.toBeHex(PACKET_VERSION, 1).slice(2);
  const n   = hre.ethers.toBeHex(BigInt(nonce), 8).slice(2);
  const se  = hre.ethers.toBeHex(srcEid, 4).slice(2);
  const sb  = pad32hex(sender).slice(2);
  const de  = hre.ethers.toBeHex(dstEid, 4).slice(2);
  const rb  = pad32hex(receiver).slice(2);
  return "0x" + v + n + se + sb + de + rb;
}

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
  if (me.toLowerCase() !== USER.toLowerCase()) throw new Error("not deployer");

  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`expected Hyper 999, got ${chainId}`);

  const endpoint = new hre.ethers.Contract(ENDPOINT, [
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params) external",
    "function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) external payable",
    "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
    "function verifiable(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver) view returns (bool)",
  ], signer);

  const recvUln = new hre.ethers.Contract(RECV_ULN, [
    "function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external",
    "function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external",
  ], signer);

  const nftC = new hre.ethers.Contract(NFT, [
    "function ownerOf(uint256) view returns (address)",
  ], signer);

  // [1] snapshot
  console.log("[1] snapshot original receive ULN config");
  const orig = await endpoint.getConfig(LOCKER_A, RECV_ULN, ARB_EID, CONFIG_TYPE_ULN);
  console.log("    saved");

  // [2] flip to deployer-as-sole-DVN
  console.log("\n[2] set Locker A receive ULN to 1-of-1 [deployer]");
  const tempCfg = encodeUlnConfig({
    confirmations: 1n,
    required: [me],
    optional: [],
    threshold: 0,
  });
  const tx2 = await endpoint.setConfig(LOCKER_A, RECV_ULN, [
    { eid: ARB_EID, configType: CONFIG_TYPE_ULN, config: tempCfg },
  ]);
  await tx2.wait();
  console.log("    tx:", tx2.hash);

  try {
    for (const pkt of STUCK) {
      console.log(`\n[3] packet ${pkt.label}`);
      const header  = buildPacketHeader(pkt.nonce, ARB_EID, WRAPPER_B, HYPER_EID, LOCKER_A);
      const payload = burnRedeemPayload(pkt.wid, USER);
      const phash   = buildPayloadHash(pkt.guid, payload);
      console.log("    header:", header.slice(0, 60) + "...");
      console.log("    phash :", phash);

      console.log("    → recvUln.verify");
      const tx3a = await recvUln.verify(header, phash, 1n);
      await tx3a.wait();
      console.log("      tx:", tx3a.hash);

      console.log("    → recvUln.commitVerification");
      const tx3b = await recvUln.commitVerification(header, phash);
      await tx3b.wait();
      console.log("      tx:", tx3b.hash);

      const origin = { srcEid: ARB_EID, sender: pad32hex(WRAPPER_B), nonce: pkt.nonce };
      const verifiable = await endpoint.verifiable(origin, LOCKER_A);
      console.log("    verifiable:", verifiable);

      console.log("    → endpoint.lzReceive (releases NFT)");
      const tx3c = await endpoint.lzReceive(origin, LOCKER_A, pkt.guid, payload, "0x");
      await tx3c.wait();
      console.log("      tx:", tx3c.hash);
    }
  } finally {
    console.log("\n[5] restore original receive ULN config");
    const restored = encodeUlnConfig(REAL_DVNS);
    const tx5 = await endpoint.setConfig(LOCKER_A, RECV_ULN, [
      { eid: ARB_EID, configType: CONFIG_TYPE_ULN, config: restored },
    ]);
    await tx5.wait();
    console.log("    tx:", tx5.hash);
  }

  // [6] confirm NFTs back
  for (const tid of [1, 2]) {
    const owner = await nftC.ownerOf(tid);
    console.log(`[6] NFT ${tid} owner = ${owner}${owner.toLowerCase()===USER.toLowerCase() ? " ✓ recovered" : ""}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
