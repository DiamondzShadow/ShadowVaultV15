// Phase 2 — Arb side: burn the wrappers we just recovered. Each burn emits
// a BURN_REDEEM LZ packet to Locker A on Hyper. The packets will get DVN-
// stuck the same way the LOCK packets did, so we capture the guids here so
// the Hyper-side recovery script can verify+execute them.

const hre = require("hardhat");

const WRAPPER_B = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const ENDPOINT  = "0x1a44076050125825900e736c501f859c50fE728c";
const HYPER_EID = 30367;
const ARB_EID   = 30110;
const LOCKER_A  = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const NFT       = "0x5f90c2f0e9ce11a19d49a2e54d9df7759c7581ae";
const USER      = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const ACT_BURN_REDEEM = 3;

function pad32(addrOrHex) {
  let h = addrOrHex.toLowerCase().replace(/^0x/, "");
  while (h.length < 64) h = "0" + h;
  return "0x" + h;
}

// LZ V2 GUID = keccak256(abi.encodePacked(nonce u64, srcEid u32, sender address, dstEid u32, receiver bytes32))
function computeGuid(nonce, srcEid, sender, dstEid, receiverBytes32) {
  const n  = hre.ethers.toBeHex(BigInt(nonce), 8).slice(2);
  const se = hre.ethers.toBeHex(srcEid, 4).slice(2);
  const sb = sender.toLowerCase().replace(/^0x/, "").padStart(40, "0");  // 20 bytes
  const de = hre.ethers.toBeHex(dstEid, 4).slice(2);
  const rb = receiverBytes32.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return hre.ethers.keccak256("0x" + n + se + sb + de + rb);
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const me = await signer.getAddress();
  if (me.toLowerCase() !== USER.toLowerCase()) throw new Error("not deployer");

  const wrapper = new hre.ethers.Contract(WRAPPER_B, [
    "function ownerOf(uint256) view returns (address)",
    "function quoteBurn(uint256,address,bytes) view returns ((uint256,uint256))",
    "function burnAndRedeem(uint256,address,bytes) external payable returns (bytes32)",
  ], signer);

  const endpoint = new hre.ethers.Contract(ENDPOINT, [
    "function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) view returns (uint64)",
  ], signer);

  // Compute wrapperIds (= keccak256(abi.encode(nft, tokenId)))
  const wid1 = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [NFT, 1n])
  );
  const wid2 = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [NFT, 2n])
  );

  const targets = [
    { wid: wid1, label: "wid for tokenId 1" },
    { wid: wid2, label: "wid for tokenId 2" },
  ];

  // Read current outbound nonce from Wrapper B → Locker A. Each burn
  // increments by 1, so the first burn becomes nonce+1, second nonce+2.
  const lockerBytes32 = pad32(LOCKER_A);
  const baseNonce = await endpoint.outboundNonce(WRAPPER_B, HYPER_EID, lockerBytes32);
  console.log("base outboundNonce (Wrapper B → Locker A):", baseNonce.toString());

  const captured = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const expectedNonce = Number(baseNonce) + i + 1;
    console.log(`\n[burn] ${t.label} wid=${t.wid.slice(0, 10)}... nonce=${expectedNonce}`);

    // Quote fee
    const fee = await wrapper.quoteBurn(t.wid, USER, "0x");
    const native = BigInt(fee[0] ?? fee.nativeFee ?? 0);
    const buffered = (native * 12n) / 10n;
    console.log(`  fee: ${native} wei (buffered ${buffered})`);

    // Fire burnAndRedeem
    const tx = await wrapper.burnAndRedeem(t.wid, USER, "0x", { value: buffered });
    const rc = await tx.wait();
    console.log(`  tx: ${tx.hash} block=${rc.blockNumber}`);

    // Compute payload + GUID locally — avoids LZ scan latency
    const payload = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "uint256", "address"],
      [ACT_BURN_REDEEM, t.wid, USER]
    );
    const guid = computeGuid(expectedNonce, ARB_EID, WRAPPER_B, HYPER_EID, lockerBytes32);

    captured.push({
      label: t.label,
      wid: t.wid,
      nonce: expectedNonce,
      guid,
      payload,
      arbTx: tx.hash,
    });
  }

  console.log("\n────────────────────────────────────────");
  console.log("CAPTURED PACKETS (paste into Hyper recovery script)");
  console.log("────────────────────────────────────────");
  console.log(JSON.stringify(captured, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
