// $5 FLEX deposit+withdraw test for Pool B v6 (GMX adapter)
// Since keeper hasn't pushed to GMX yet, all yield USDC is in the float.
// Withdraw should work instantly from idle USDC.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DEPOSIT = ethers.parseUnits("5", 6);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const VAULT_ABI = [
  "function deposit(uint256,uint8) external",
  "function requestWithdraw(uint256) external",
  "function completeWithdraw(uint256) external",
  "function pendingWithdraws(uint256) view returns (uint256 yieldUSDC, uint256 basketUSDC, uint256 readyAt, bool completed)",
];
const ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function idleUsdc() view returns (uint256)",
  "function gmBalance() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));
  const pool = deployed.pools.B;

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);
  const adapter = new ethers.Contract(pool.adapter, ADAPTER_ABI, signer);

  console.log("Pool B vault:", pool.vault);
  console.log("Adapter:     ", pool.adapter);
  console.log("USDC balance:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));

  // ── Deposit $5 FLEX ──
  console.log("\n── Deposit $5 FLEX ──");
  const allowance = await usdc.allowance(signer.address, pool.vault);
  if (allowance < DEPOSIT) {
    const appTx = await usdc.approve(pool.vault, ethers.MaxUint256);
    console.log("  approve tx:", appTx.hash); await appTx.wait();
  }
  const depTx = await vault.deposit(DEPOSIT, 0, { gasLimit: 1_500_000 });
  console.log("  deposit tx:", depTx.hash);
  const depRcpt = await depTx.wait();
  console.log("  gas:", depRcpt.gasUsed.toString(), "status:", depRcpt.status);

  // ── Adapter state ──
  console.log("\n── Adapter state after deposit ──");
  console.log("  totalAssets:   ", ethers.formatUnits(await adapter.totalAssets(), 6));
  console.log("  totalPrincipal:", ethers.formatUnits(await adapter.totalPrincipal(), 6));
  console.log("  idleUsdc:      ", ethers.formatUnits(await adapter.idleUsdc(), 6));
  console.log("  gmBalance:     ", ethers.formatUnits(await adapter.gmBalance(), 18));

  // ── requestWithdraw ──
  console.log("\n── requestWithdraw(1) ──");
  const reqTx = await vault.requestWithdraw(1, { gasLimit: 3_000_000 });
  console.log("  tx:", reqTx.hash);
  const reqRcpt = await reqTx.wait();
  console.log("  gas:", reqRcpt.gasUsed.toString(), "status:", reqRcpt.status);

  // ── Wait for timelock ──
  const pending = await vault.pendingWithdraws(1);
  const now = Math.floor(Date.now() / 1000);
  const readyAt = Number(pending[2]);
  if (readyAt > now) {
    const wait = readyAt - now + 5;
    console.log("  waiting", wait, "s...");
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  // ── completeWithdraw ──
  console.log("\n── completeWithdraw(1) ──");
  const balBefore = await usdc.balanceOf(signer.address);
  const compTx = await vault.completeWithdraw(1, { gasLimit: 1_000_000 });
  console.log("  tx:", compTx.hash);
  await compTx.wait();

  const balAfter = await usdc.balanceOf(signer.address);
  const received = balAfter - balBefore;
  const recovery = ((Number(received) / 5_000_000) * 100).toFixed(2);

  console.log("\n── Adapter state after withdraw ──");
  console.log("  totalAssets:   ", ethers.formatUnits(await adapter.totalAssets(), 6));
  console.log("  idleUsdc:      ", ethers.formatUnits(await adapter.idleUsdc(), 6));

  console.log("\n═══ Pool B GMX RESULT ═══");
  console.log("  Deposited: $5.00");
  console.log("  Received:  $" + ethers.formatUnits(received, 6));
  console.log("  Recovery:  " + recovery + "%");
  console.log("  STATUS:", Number(received) >= 4_750_000 ? "PASS" : "CHECK");
}

main().catch((e) => { console.error(e); process.exit(1); });
