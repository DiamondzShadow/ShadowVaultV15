// Quick $3 FLEX deposit test for Pool A v3 (Morpho Steakhouse)
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DEPOSIT = ethers.parseUnits("5", 6); // $5 (MIN_DEPOSIT)

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
  "function yieldAdapter() view returns (address)",
  "function positions(uint256) view returns (uint256 depositedUSDC, uint256 yieldShares, uint256 basketValue, uint8 tier, uint256 depositTime, bool withdrawn)",
];

const ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const pool = deployed.pools.A;
  const vaultAddr = pool.vault;

  console.log("Pool A vault:", vaultAddr);
  console.log("Adapter:     ", pool.adapter);

  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
  const adapter = new ethers.Contract(pool.adapter, ADAPTER_ABI, signer);

  const bal = await usdc.balanceOf(signer.address);
  console.log("USDC balance:", ethers.formatUnits(bal, 6));

  // ── 1. Deposit $3 FLEX ──
  console.log("\n── [1/4] Deposit $3 FLEX ──");
  const allowance = await usdc.allowance(signer.address, vaultAddr);
  if (allowance < DEPOSIT) {
    const appTx = await usdc.approve(vaultAddr, ethers.MaxUint256);
    console.log("  approve tx:", appTx.hash);
    await appTx.wait();
  }

  const depTx = await vault.deposit(DEPOSIT, 0, { gasLimit: 1_500_000 });
  console.log("  deposit tx:", depTx.hash);
  const depRcpt = await depTx.wait();
  console.log("  gas used:", depRcpt.gasUsed.toString());

  // ── 2. Check adapter state ──
  console.log("\n── [2/4] Adapter state ──");
  const totalAssets = await adapter.totalAssets();
  const totalPrincipal = await adapter.totalPrincipal();
  console.log("  totalAssets:   ", ethers.formatUnits(totalAssets, 6), "USDC");
  console.log("  totalPrincipal:", ethers.formatUnits(totalPrincipal, 6), "USDC");

  // ── 3. Request withdraw ──
  console.log("\n── [3/4] Request withdraw (posId=1) ──");
  const reqTx = await vault.requestWithdraw(1, { gasLimit: 1_500_000 });
  console.log("  requestWithdraw tx:", reqTx.hash);
  const reqRcpt = await reqTx.wait();
  console.log("  gas used:", reqRcpt.gasUsed.toString());

  const pending = await vault.pendingWithdraws(1);
  console.log("  yieldUSDC:  ", ethers.formatUnits(pending.yieldUSDC, 6));
  console.log("  basketUSDC: ", ethers.formatUnits(pending.basketUSDC, 6));
  console.log("  readyAt:    ", pending.readyAt.toString());

  // ── 4. Wait and complete withdraw ──
  console.log("\n── [4/4] Complete withdraw ──");
  const now = Math.floor(Date.now() / 1000);
  const readyAt = Number(pending.readyAt);
  if (readyAt > now) {
    const wait = readyAt - now + 5;
    console.log("  waiting", wait, "seconds for timelock...");
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  const balBefore = await usdc.balanceOf(signer.address);
  const compTx = await vault.completeWithdraw(1, { gasLimit: 1_000_000 });
  console.log("  completeWithdraw tx:", compTx.hash);
  const compRcpt = await compTx.wait();
  console.log("  gas used:", compRcpt.gasUsed.toString());

  const balAfter = await usdc.balanceOf(signer.address);
  const received = balAfter - balBefore;
  console.log("\n═══ RESULT ═══");
  console.log("  Deposited: $5.00");
  console.log("  Received:  $" + ethers.formatUnits(received, 6));
  console.log("  Net cost:  $" + ethers.formatUnits(DEPOSIT - received, 6));
  console.log("  Recovery:  " + ((Number(received) / Number(DEPOSIT)) * 100).toFixed(2) + "%");

  if (received >= ethers.parseUnits("4.75", 6)) {
    console.log("  STATUS: PASS (>= 95% recovery)");
  } else {
    console.log("  STATUS: FAIL (< 95% recovery)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
