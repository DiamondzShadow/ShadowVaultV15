// Retry requestWithdraw + completeWithdraw for Pool A posId=1
// Previous attempt ran out of gas at 1.5M. Morpho redeem is gas-heavy.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const VAULT_ABI = [
  "function requestWithdraw(uint256) external",
  "function completeWithdraw(uint256) external",
  "function pendingWithdraws(uint256) view returns (uint256 yieldUSDC, uint256 basketUSDC, uint256 readyAt, bool completed)",
];
const ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));
  const pool = deployed.pools.A;

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
  const adapter = new ethers.Contract(pool.adapter, ADAPTER_ABI, signer);

  console.log("Pool A vault:", pool.vault);
  console.log("Adapter totalAssets:", ethers.formatUnits(await adapter.totalAssets(), 6));

  // ── requestWithdraw with 3M gas ──
  console.log("\n── requestWithdraw(1) with 3M gas ──");
  const reqTx = await vault.requestWithdraw(1, { gasLimit: 3_000_000 });
  console.log("  tx:", reqTx.hash);
  const reqRcpt = await reqTx.wait();
  console.log("  gas used:", reqRcpt.gasUsed.toString());
  console.log("  status:", reqRcpt.status);

  const pending = await vault.pendingWithdraws(1);
  console.log("  yieldUSDC: ", ethers.formatUnits(pending.yieldUSDC, 6));
  console.log("  basketUSDC:", ethers.formatUnits(pending.basketUSDC, 6));
  console.log("  readyAt:   ", pending.readyAt.toString());

  // ── Wait for timelock ──
  const now = Math.floor(Date.now() / 1000);
  const readyAt = Number(pending.readyAt);
  if (readyAt > now) {
    const wait = readyAt - now + 5;
    console.log("\n  waiting", wait, "seconds...");
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  // ── completeWithdraw ──
  console.log("\n── completeWithdraw(1) ──");
  const balBefore = await usdc.balanceOf(signer.address);
  const compTx = await vault.completeWithdraw(1, { gasLimit: 1_000_000 });
  console.log("  tx:", compTx.hash);
  const compRcpt = await compTx.wait();
  console.log("  gas used:", compRcpt.gasUsed.toString());

  const balAfter = await usdc.balanceOf(signer.address);
  const received = balAfter - balBefore;
  console.log("\n═══ RESULT ═══");
  console.log("  Deposited: $5.00");
  console.log("  Received:  $" + ethers.formatUnits(received, 6));
  console.log("  Recovery:  " + ((Number(received) / 5_000_000) * 100).toFixed(2) + "%");

  if (received >= 4_750_000n) {
    console.log("  STATUS: PASS (>= 95% recovery)");
  } else {
    console.log("  STATUS: CHECK — may be normal due to fees");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
