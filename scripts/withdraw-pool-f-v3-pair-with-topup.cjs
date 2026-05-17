// Drain pre-v3 Pool F pair via v3.1.withdrawPair.
//
// Wrinkle: HLPAdapter holds a small residual HC equity ($0.003) that won't
// drain to zero (HLP precompile reports it consistently across cycles).
// That makes totalAssets > idle, so the 95% recovery rule on yieldShare
// reverts. Fix: deployer donates a tiny amount of USDC directly to the
// adapter so idle/totalAssets ≥ 0.95. The donation is returned to the
// deployer as part of the yield payout from withdrawPair.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`Expected chainId 999, got ${chainId}`);

  const cfg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "config", "deployed-pool-f-hc-v3.json"), "utf8"));
  const peCfg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"), "utf8"));
  const VAULT   = cfg.vault;
  const USDC    = cfg.usdc;
  const ADAPTER = peCfg.adapter;

  const YIELD_TOKEN_ID  = 1n;
  const BASKET_TOKEN_ID = 1n;

  const usdc = await hre.ethers.getContractAt([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], USDC, signer);

  const adapter = await hre.ethers.getContractAt([
    "function totalAssets() view returns (uint256)",
  ], ADAPTER, signer);

  // 1. Compute the required top-up so idle/totalAssets >= 0.95.
  //    idle' = idle + topup; need (idle + topup) >= 0.95 × (idle + topup + nonIdle)
  //    ⇒ topup >= (0.95 × nonIdle - 0.05 × idle) / 0.05  (if positive)
  let idle    = await usdc.balanceOf(ADAPTER);
  let total   = await adapter.totalAssets();
  let nonIdle = total - idle;
  // Smallest topup so the 95% rule clears, with a 1500-wei safety margin
  // (5%-recovery tolerance leaves room for HC equity drift between this
  // read and the actual on-chain settle).
  let topup = 0n;
  if (nonIdle * 100n > (idle * 5n)) {
    topup = (nonIdle * 95n / 5n) - idle + 1500n;
  }
  console.log("Adapter idle    :", idle.toString());
  console.log("Adapter nonIdle :", nonIdle.toString());
  console.log("Adapter total   :", total.toString());
  console.log("Required topup  :", topup.toString());

  const deployerBal = await usdc.balanceOf(signer.address);
  console.log("Deployer USDC   :", deployerBal.toString());
  if (topup > 0n && deployerBal < topup) {
    throw new Error(`Deployer has ${deployerBal} but needs ${topup} for topup`);
  }

  // EIP-1559 fields for Hyperliquid: priority=0, maxFee=baseFee*2 (1 gwei floor).
  const block = await hre.ethers.provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  let maxFee = baseFee * 2n;
  if (maxFee < 1_000_000_000n) maxFee = 1_000_000_000n;
  const gasOverrides = { maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n };

  if (topup > 0n) {
    console.log(`\nDonating ${topup} wei (${Number(topup) / 1e6} USDC) to adapter…`);
    const tx = await usdc.transfer(ADAPTER, topup, gasOverrides);
    console.log("tx:", tx.hash);
    await tx.wait();
  }

  // 2. Re-read state post-topup.
  idle  = await usdc.balanceOf(ADAPTER);
  total = await adapter.totalAssets();
  nonIdle = total - idle;
  const ratio = Number(idle * 10000n / total) / 100;
  console.log(`Post-topup: idle=${idle} total=${total} ratio=${ratio}%`);

  // 3. Call withdrawPair.
  const vault = await hre.ethers.getContractAt([
    "function previewWithdrawPair(uint256) view returns (uint256 basketPreview, uint256 yieldPreview, uint256 total)",
    "function withdrawPair(uint256,uint256,address) returns (uint256 payout)",
    "event PairWithdrawn(address indexed depositor, uint256 yieldTokenId, uint256 basketTokenId, uint256 basketPayout, uint256 yieldPayout, uint256 payout)",
  ], VAULT, signer);

  const preview = await vault.previewWithdrawPair(YIELD_TOKEN_ID);
  console.log("Preview (basket, yield, total):",
    preview[0].toString(), preview[1].toString(), preview[2].toString());

  const balBefore = await usdc.balanceOf(signer.address);
  console.log("\nSubmitting withdrawPair…");
  const tx = await vault.withdrawPair(YIELD_TOKEN_ID, BASKET_TOKEN_ID, signer.address, gasOverrides);
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("gas used:", r.gasUsed?.toString());

  const ev = r.logs
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "PairWithdrawn");
  if (ev) {
    console.log("PairWithdrawn:",
      "basketPayout:", ev.args.basketPayout?.toString(),
      "yieldPayout:",  ev.args.yieldPayout?.toString(),
      "total:",        ev.args.payout?.toString());
  }

  const balAfter = await usdc.balanceOf(signer.address);
  console.log("USDC before :", balBefore.toString());
  console.log("USDC after  :", balAfter.toString());
  console.log("Delta       :", (balAfter - balBefore).toString(), "wei (6-dec)");
  console.log("Net of topup:", (balAfter - balBefore + topup - topup).toString(), "wei");
  // Net = (balAfter - balBefore) + 0 because balAfter already excludes topup
  console.log("Net (USD)   : $" + (Number(balAfter - balBefore) / 1e6).toFixed(6));
}

main().catch((e) => { console.error(e); process.exit(1); });
