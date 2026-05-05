// One-shot: send 2 USDC from Arb Safe → user wallet so they have something
// to round-trip through the v0.3 limit-order flow on /agent/orders.

const hre = require("hardhat");
const { ethers } = hre;

const SAFE   = "0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TARGET = "0xC318FAf42584781c18507831974402ACC88e152a";   // user wallet
const AMOUNT = 2_000_000n;   // 2 USDC (6 decimals)

const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  if ((await ethers.provider.getNetwork()).chainId !== 42161n) throw new Error("not Arb");

  // Build USDC.transfer(TARGET, AMOUNT) calldata
  const usdcIface = new ethers.Interface(["function transfer(address,uint256)"]);
  const data = usdcIface.encodeFunctionData("transfer", [TARGET, AMOUNT]);

  // Pre-validated owner sig (Safe is 1-of-1 with deployer as sole owner)
  const sig = ethers.concat([
    ethers.zeroPadValue(signer.address, 32),
    ethers.zeroPadValue("0x", 32),
    "0x01",
  ]);

  const safe = new ethers.Contract(SAFE, SAFE_ABI, signer);
  console.log(`→ Sending ${Number(AMOUNT) / 1e6} USDC: Safe ${SAFE} → ${TARGET}`);
  const tx = await safe.execTransaction(USDC, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sig);
  console.log("  tx:", tx.hash);
  await tx.wait();
  console.log("✓ done");
}

main().catch((e) => { console.error(e); process.exit(1); });
