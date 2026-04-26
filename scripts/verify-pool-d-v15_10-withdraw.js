// ═════════════════════════════════════════════════════════════════════════════
//  Verify Pool D v15.10 WITHDRAW end-to-end.
//  Uses the FLEX position minted in verify-pool-d-v15_10.js (posId 1).
//  Deployer has KEEPER_ROLE so we can requestWithdraw + completeWithdraw
//  without waiting the withdrawTimeout.
// ═════════════════════════════════════════════════════════════════════════════

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const VAULT_ABI = [
  "function requestWithdraw(uint256 posId) external",
  "function completeWithdraw(uint256 posId) external",
  "function positions(uint256 posId) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function pendingWithdraws(uint256 posId) view returns (address user, uint256 usdcGathered, uint256 yieldUSDC, uint256 basketUSDC, uint256 feeBps, uint256 requestTime)",
  "function onTimeFeeBps() view returns (uint256)",
  "function earlyExitFeeBps() view returns (uint256)",
  "function nextPosId() view returns (uint256)",
  "event WithdrawRequested(uint256 indexed posId, address indexed user, uint256 feeBps)",
  "event WithdrawCompleted(uint256 indexed posId, address indexed user, uint256 payout, uint256 fee)",
];
const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function totalSupply() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8")
  );
  const VAULT = deployed.pools.D.vault;
  const NFT   = deployed.pools.D.positionNFT;

  if (deployed.pools.D.version !== "v15.10") {
    throw new Error(`Expected Pool D v15.10; got ${deployed.pools.D.version}`);
  }

  console.log("signer:       ", signer.address);
  console.log("Pool D vault: ", VAULT);
  console.log("Pool D NFT:   ", NFT);

  const vault = new ethers.Contract(VAULT, VAULT_ABI, signer);
  const nft   = new ethers.Contract(NFT, NFT_ABI, signer);
  const usdc  = new ethers.Contract(USDC, ERC20_ABI, signer);

  const posId = 1n;

  const pos = await vault.positions(posId);
  const depositor = pos[0], tier = pos[1], depositAmount = pos[2], wsdmAmount = pos[3];
  const loanOutstanding = pos[9], withdrawStatus = pos[10];
  console.log(`\nPosition ${posId}:`);
  console.log("  depositor:      ", depositor);
  console.log("  tier:           ", tier.toString(), "(0=FLEX)");
  console.log("  depositAmount:  ", depositAmount.toString());
  console.log("  wsdmAmount:     ", wsdmAmount.toString());
  console.log("  loanOutstanding:", loanOutstanding.toString());
  console.log("  withdrawStatus: ", withdrawStatus.toString(), "(0=NONE, 1=REQUESTED, 2=COMPLETED)");

  if (depositor.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`posId ${posId} not owned by signer; owned by ${depositor}`);
  }
  if (withdrawStatus !== 0n) {
    throw new Error(`posId ${posId} already has a pending withdraw (status ${withdrawStatus})`);
  }

  const preBalance = await usdc.balanceOf(signer.address);
  console.log(`\nUSDC balance BEFORE: ${ethers.formatUnits(preBalance, 6)}`);

  console.log(`\n[1/2] requestWithdraw(${posId})...`);
  const tx1 = await vault.requestWithdraw(posId);
  console.log(`  tx: ${tx1.hash}`);
  const receipt1 = await tx1.wait();

  const pw = await vault.pendingWithdraws(posId);
  const total = pw[1] + pw[2] + pw[3];
  console.log("  pendingWithdraws:");
  console.log("    user:        ", pw[0]);
  console.log("    usdcGathered:", pw[1].toString());
  console.log("    yieldUSDC:   ", pw[2].toString());
  console.log("    basketUSDC:  ", pw[3].toString());
  console.log("    feeBps:      ", pw[4].toString());
  console.log("    total:       ", total.toString());

  console.log(`\n[2/2] completeWithdraw(${posId}) via KEEPER_ROLE...`);
  const tx2 = await vault.completeWithdraw(posId);
  console.log(`  tx: ${tx2.hash}`);
  const receipt2 = await tx2.wait();

  const postBalance = await usdc.balanceOf(signer.address);
  const delta = postBalance - preBalance;
  console.log(`\nUSDC balance AFTER:  ${ethers.formatUnits(postBalance, 6)}`);
  console.log(`USDC returned:       ${ethers.formatUnits(delta, 6)}`);

  const posAfter = await vault.positions(posId);
  const statusAfter = posAfter[10];
  console.log(`\nPosition ${posId} withdrawStatus AFTER: ${statusAfter.toString()} (expect 2=COMPLETED)`);

  // NFT should still exist (v15 doesn't burn on withdraw — it marks COMPLETED)
  const stillOwned = await nft.ownerOf(posId);
  console.log(`nft.ownerOf(${posId}) AFTER: ${stillOwned}`);

  if (statusAfter !== 2n) {
    throw new Error("withdraw didn't complete");
  }
  if (delta === 0n) {
    throw new Error("zero USDC returned");
  }

  console.log("\n✓ Pool D v15.10 withdraw path clean.");
}

main().catch((e) => { console.error(e); process.exit(1); });
