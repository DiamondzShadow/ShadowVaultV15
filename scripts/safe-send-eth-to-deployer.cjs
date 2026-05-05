// One-shot: Arb Safe → deployer ETH top-up via Safe execTransaction.
// Safe is 1-of-1 with deployer as sole owner — uses the pre-validated
// signature form (no offline signing needed).

const hre = require("hardhat");
const { ethers } = hre;

const SAFE   = "0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363";
const TARGET = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";  // deployer
const VALUE  = ethers.parseEther("0.00015");

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  if ((await ethers.provider.getNetwork()).chainId !== 42161n) throw new Error("not Arb");
  if (signer.address.toLowerCase() !== TARGET.toLowerCase()) throw new Error(`signer mismatch ${signer.address}`);

  const safe = new ethers.Contract(SAFE, SAFE_ABI, signer);

  // Pre-validated signature for the sole owner: 32 bytes left-padded owner addr
  // + 32 zero bytes + 0x01. Safe accepts this when msg.sender == owner and
  // threshold == 1, no actual ECDSA needed.
  const sig = ethers.concat([
    ethers.zeroPadValue(signer.address, 32),
    ethers.zeroPadValue("0x", 32),
    "0x01",
  ]);

  console.log("Safe nonce:", await safe.nonce());
  console.log(`→ exec: send ${ethers.formatEther(VALUE)} ETH from Safe → ${TARGET}`);
  const tx = await safe.execTransaction(
    TARGET, VALUE, "0x", 0,           // to, value, data, operation
    0, 0, 0,                          // safeTxGas, baseGas, gasPrice
    ethers.ZeroAddress, ethers.ZeroAddress,  // gasToken, refundReceiver
    sig,
  );
  console.log("  tx:", tx.hash);
  await tx.wait();
  console.log("✓ done. Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(TARGET)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
