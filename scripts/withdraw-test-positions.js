// Withdraw all active test positions before whitelist redeploy
//
// Active positions:
//   Pool A (0x02756648...) — posIds 2, 3, 4  ($5 each)
//   Pool D (0x07D31F7d...) — posId 1         ($5)
//
// Two-step flow: requestWithdraw → completeWithdraw
// Deployer has KEEPER_ROLE so can completeWithdraw immediately (no timeout wait).
// For $5 positions the basket leg is dust — completeWithdraw should succeed
// right after request even if basket tokens haven't been sold.
//
// Usage:
//   npx hardhat run scripts/withdraw-test-positions.js --network arbitrum

const { ethers } = require("hardhat");

const VAULT_ABI = [
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function pendingWithdraws(uint256) view returns (address user, uint256 usdcGathered, uint256 yieldUSDC, uint256 basketUSDC, uint256 feeBps, uint256 requestTime)",
  "function requestWithdraw(uint256 posId) external",
  "function completeWithdraw(uint256 posId) external",
  "function withdrawTimeout() view returns (uint256)",
  "function nextPosId() view returns (uint256)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const POOLS = [
  { id: "A", vault: "0x02756648d7a19Dda5CCa4Fd4148C20e8952b32c1", posIds: [2, 3, 4] },
  { id: "D", vault: "0x07D31F7d2fc339556c8b31769B2721007C3Ac82D", posIds: [1] },
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, ethers.provider);
  const balBefore = await usdc.balanceOf(signer.address);
  console.log("USDC before:", ethers.formatUnits(balBefore, 6), "\n");

  for (const pool of POOLS) {
    const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
    console.log(`═══ Pool ${pool.id} (${pool.vault}) ═══`);

    for (const posId of pool.posIds) {
      try {
        const pos = await vault.positions(posId);
        const status = Number(pos.withdrawStatus);
        const statusName = ["NONE", "REQUESTED", "COMPLETED"][status] || `UNKNOWN(${status})`;

        console.log(`\n  posId ${posId}: ${statusName}, deposit=$${ethers.formatUnits(pos.depositAmount, 6)}, wsdm=${pos.wsdmAmount.toString()}`);

        if (status === 2) {
          console.log("    already COMPLETED, skipping");
          continue;
        }

        // Step 1: Request withdrawal if not already requested
        if (status === 0) {
          console.log("    requesting withdrawal...");
          const tx = await vault.requestWithdraw(posId, { gasLimit: 1_000_000 });
          const rcpt = await tx.wait();
          console.log(`    ✅ requestWithdraw tx: ${rcpt.hash} (gas: ${rcpt.gasUsed})`);
        } else {
          console.log("    already REQUESTED");
        }

        // Check pending state
        const pw = await vault.pendingWithdraws(posId);
        console.log(`    pending: gathered=$${ethers.formatUnits(pw.usdcGathered, 6)}, yield=$${ethers.formatUnits(pw.yieldUSDC, 6)}, basket=$${ethers.formatUnits(pw.basketUSDC, 6)}`);

        // Step 2: Complete (deployer has KEEPER_ROLE so can complete immediately)
        console.log("    attempting completeWithdraw...");
        try {
          const tx = await vault.completeWithdraw(posId, { gasLimit: 500_000 });
          const rcpt = await tx.wait();
          console.log(`    ✅ completeWithdraw tx: ${rcpt.hash} (gas: ${rcpt.gasUsed})`);
        } catch (e) {
          const msg = e.message.slice(0, 200);
          console.log(`    ⏳ completeWithdraw failed: ${msg}`);
          const timeout = await vault.withdrawTimeout();
          const waitSecs = Number(pw.requestTime) + Number(timeout) - Math.floor(Date.now() / 1000);
          if (waitSecs > 0) {
            console.log(`    user can complete in ${Math.ceil(waitSecs / 60)} minutes (after timeout)`);
          }
        }
      } catch (e) {
        console.log(`  posId ${posId}: ERROR — ${e.message.slice(0, 200)}`);
      }
    }
    console.log("");
  }

  const balAfter = await usdc.balanceOf(signer.address);
  console.log(`USDC after: ${ethers.formatUnits(balAfter, 6)}`);
  console.log(`Recovered: $${ethers.formatUnits(balAfter - balBefore, 6)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
