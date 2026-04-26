// Rescue pre-NFT positions that can't call requestWithdraw because
// positionNFT.ownerOf() reverts for unminted tokenIds.
//
// Strategy:
//   1. Deploy OwnerShim(vault) — returns depositor as ownerOf for any posId
//   2. vault.setPositionNFT(shim) — temporarily swap NFT
//   3. vault.requestWithdraw(posId) — now works (shim returns depositor)
//   4. vault.completeWithdraw(posId) — deployer has KEEPER_ROLE
//   5. vault.setPositionNFT(originalNFT) — restore (or leave if vault is being abandoned)
//
// Stuck positions:
//   Pool A (0x02756648...) — posId 2
//   Pool D (0x07D31F7d...) — posId 1
//
// Usage:
//   npx hardhat run scripts/rescue-pre-nft-positions.js --network arbitrum

const { ethers } = require("hardhat");

const VAULT_ABI = [
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function pendingWithdraws(uint256) view returns (address user, uint256 usdcGathered, uint256 yieldUSDC, uint256 basketUSDC, uint256 feeBps, uint256 requestTime)",
  "function requestWithdraw(uint256 posId) external",
  "function completeWithdraw(uint256 posId) external",
  "function setPositionNFT(address nft) external",
  "function positionNFT() view returns (address)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const STUCK = [
  { pool: "A", vault: "0x02756648d7a19Dda5CCa4Fd4148C20e8952b32c1", nft: "0x1F56EDeF6C62818a380A90C0Feef24f819d8d73c", posId: 2 },
  { pool: "D", vault: "0x07D31F7d2fc339556c8b31769B2721007C3Ac82D", nft: "0xf6cb269F1C60D6B60c227e45aBb8803b11FA8a55", posId: 1 },
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, ethers.provider);
  const balBefore = await usdc.balanceOf(signer.address);
  console.log("USDC before:", ethers.formatUnits(balBefore, 6), "\n");

  const Shim = await ethers.getContractFactory("OwnerShim");

  for (const s of STUCK) {
    console.log(`═══ Pool ${s.pool} — posId ${s.posId} ═══`);
    const vault = new ethers.Contract(s.vault, VAULT_ABI, signer);

    // Check position state
    const pos = await vault.positions(s.posId);
    const status = Number(pos.withdrawStatus);
    console.log(`  deposit: $${ethers.formatUnits(pos.depositAmount, 6)}, status: ${status}`);
    if (status === 2) {
      console.log("  already COMPLETED, skipping\n");
      continue;
    }

    // Step 1: Deploy shim
    console.log("  deploying OwnerShim...");
    const shim = await Shim.deploy(s.vault);
    await shim.waitForDeployment();
    const shimAddr = await shim.getAddress();
    console.log(`  shim: ${shimAddr}`);

    // Verify shim returns the right depositor
    const shimOwner = await shim.ownerOf(s.posId);
    console.log(`  shim.ownerOf(${s.posId}): ${shimOwner}`);
    if (shimOwner.toLowerCase() !== signer.address.toLowerCase()) {
      console.log("  ERROR: shim returns wrong owner, skipping\n");
      continue;
    }

    // Step 2: Swap NFT to shim
    console.log("  swapping positionNFT to shim...");
    let tx = await vault.setPositionNFT(shimAddr);
    await tx.wait();
    console.log(`  setPositionNFT tx: ${tx.hash}`);

    // Step 3: Request withdrawal
    if (status === 0) {
      console.log("  requesting withdrawal...");
      tx = await vault.requestWithdraw(s.posId, { gasLimit: 1_000_000 });
      const rcpt = await tx.wait();
      console.log(`  ✅ requestWithdraw tx: ${rcpt.hash} (gas: ${rcpt.gasUsed})`);
    }

    // Step 4: Complete withdrawal (deployer has KEEPER_ROLE)
    console.log("  completing withdrawal...");
    try {
      tx = await vault.completeWithdraw(s.posId, { gasLimit: 500_000 });
      const rcpt = await tx.wait();
      console.log(`  ✅ completeWithdraw tx: ${rcpt.hash} (gas: ${rcpt.gasUsed})`);
    } catch (e) {
      console.log(`  ⏳ completeWithdraw failed: ${e.message.slice(0, 150)}`);
      const pw = await vault.pendingWithdraws(s.posId);
      console.log(`  pending: gathered=$${ethers.formatUnits(pw.usdcGathered, 6)}, yield=$${ethers.formatUnits(pw.yieldUSDC, 6)}, basket=$${ethers.formatUnits(pw.basketUSDC, 6)}`);
    }

    // Step 5: Restore original NFT (vaults are being abandoned after redeploy anyway)
    console.log("  restoring original NFT...");
    tx = await vault.setPositionNFT(s.nft);
    await tx.wait();
    console.log(`  restored NFT: ${s.nft}\n`);
  }

  const balAfter = await usdc.balanceOf(signer.address);
  console.log(`USDC after:  ${ethers.formatUnits(balAfter, 6)}`);
  console.log(`Recovered:   $${ethers.formatUnits(balAfter - balBefore, 6)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
