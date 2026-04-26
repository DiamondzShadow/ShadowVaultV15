// $5 FLEX deposit+withdraw test for Pool C v3 (Aave V3 USDC)
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

async function main() {
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8"));
  const pool = deployed.pools.C;

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const vault = new ethers.Contract(pool.vault, VAULT_ABI, signer);

  console.log("Pool C vault:", pool.vault);
  console.log("USDC balance:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));

  // Approve + deposit
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

  // requestWithdraw
  console.log("\n── requestWithdraw(1) ──");
  const reqTx = await vault.requestWithdraw(1, { gasLimit: 3_000_000 });
  console.log("  tx:", reqTx.hash);
  const reqRcpt = await reqTx.wait();
  console.log("  gas:", reqRcpt.gasUsed.toString(), "status:", reqRcpt.status);

  // Wait for timelock
  const pending = await vault.pendingWithdraws(1);
  const now = Math.floor(Date.now() / 1000);
  const readyAt = Number(pending[2]);
  if (readyAt > now) {
    const wait = readyAt - now + 5;
    console.log("  waiting", wait, "s...");
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  // completeWithdraw
  console.log("\n── completeWithdraw(1) ──");
  const balBefore = await usdc.balanceOf(signer.address);
  const compTx = await vault.completeWithdraw(1, { gasLimit: 1_000_000 });
  console.log("  tx:", compTx.hash);
  await compTx.wait();

  const balAfter = await usdc.balanceOf(signer.address);
  const received = balAfter - balBefore;
  const recovery = ((Number(received) / 5_000_000) * 100).toFixed(2);
  console.log("\n═══ Pool C RESULT ═══");
  console.log("  Deposited: $5.00");
  console.log("  Received:  $" + ethers.formatUnits(received, 6));
  console.log("  Recovery:  " + recovery + "%");
  console.log("  STATUS:", Number(received) >= 4_750_000 ? "PASS" : "CHECK");
}

main().catch((e) => { console.error(e); process.exit(1); });
