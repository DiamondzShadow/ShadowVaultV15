const hre = require("hardhat");

const LOCKER_A    = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const ENDPOINT    = "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9";
const RECV_ULN    = "0x7cacBe439EaD55fa1c22790330b12835c6884a91";
const ARB_EID     = 30110;
const HYPER_EID   = 30367;
const WRAPPER_B   = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const USER        = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const PACKET_VERSION = 1;
const CONFIG_TYPE_ULN = 2;

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

function encodeUlnConfig(c) {
  const sortAsc = (arr) => [...arr].sort((a,b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)"],
    [{
      confirmations: c.confirmations,
      requiredDVNCount: c.required.length,
      optionalDVNCount: c.optional.length,
      optionalDVNThreshold: c.threshold,
      requiredDVNs: sortAsc(c.required),
      optionalDVNs: sortAsc(c.optional),
    }]
  );
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const me = await signer.getAddress();
  console.log("me:", me);

  const endpoint = new hre.ethers.Contract(ENDPOINT, [
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params) external",
    "function getConfig(address,address,uint32,uint32) view returns (bytes)",
  ], signer);

  const recvUln = new hre.ethers.Contract(RECV_ULN, [
    "function verify(bytes,bytes32,uint64) external",
    "function commitVerification(bytes,bytes32) external",
    "function hashLookup(bytes32,bytes32,address) view returns (uint64,bool)",
    "function getUlnConfig(address,uint32) view returns (tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs))",
  ], signer);

  // Set temp config
  console.log("\n[1] set 1-of-1 deployer DVN config");
  const tempCfg = encodeUlnConfig({ confirmations: 1n, required: [me], optional: [], threshold: 0 });
  const tx1 = await endpoint.setConfig(LOCKER_A, RECV_ULN, [
    { eid: ARB_EID, configType: CONFIG_TYPE_ULN, config: tempCfg }
  ]);
  await tx1.wait();
  console.log("    tx:", tx1.hash);

  // Read effective ULN config — this combines custom + default
  const eff = await recvUln.getUlnConfig(LOCKER_A, ARB_EID);
  console.log("\n[2] effective ULN config (post-setConfig):");
  console.log("    confirmations    :", eff[0]);
  console.log("    requiredDVNCount :", eff[1]);
  console.log("    optionalDVNCount :", eff[2]);
  console.log("    optionalThreshold:", eff[3]);
  console.log("    requiredDVNs    :", eff[4]);
  console.log("    optionalDVNs    :", eff[5]);

  // Try the verify+commit for token 1
  const guid = "0x49254d4712a1979716bd158610ce2161e42cf82807de9452abee2a6562408e8b";
  const wid  = "0x07f34e1205e64ad351aeefb800ce210de00f0f430c96f8899afa743769e8301d";
  const payload = hre.ethers.AbiCoder.defaultAbiCoder().encode(["uint8","uint256","address"], [3, wid, USER]);
  const header  = buildPacketHeader(1, ARB_EID, WRAPPER_B, HYPER_EID, LOCKER_A);
  const phash   = buildPayloadHash(guid, payload);

  console.log("\n[3] verify");
  console.log("    header:", header);
  console.log("    phash :", phash);

  const tx3 = await recvUln.verify(header, phash, 1n);
  await tx3.wait();
  console.log("    tx:", tx3.hash);

  // Read hashLookup
  const headerHash = hre.ethers.keccak256(header);
  const hl = await recvUln.hashLookup(headerHash, phash, me);
  console.log("\n[4] hashLookup:");
  console.log("    confirmations:", hl[0]);
  console.log("    submitted    :", hl[1]);

  console.log("\n[5] dry-run commitVerification (callStatic)");
  try {
    await recvUln.commitVerification.staticCall(header, phash);
    console.log("    OK");
  } catch (e) {
    console.log("    revert:", e?.shortMessage ?? e?.message ?? e);
    console.log("    info:", e?.info?.error?.data ?? "(no data)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
