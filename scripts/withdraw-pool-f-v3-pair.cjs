// One-shot helper: drain the deployer's pre-v3 ShadowPass pair via
// v3.1.withdrawPair. Confirms both legs settle in a single tx and returns
// USDC to the holder.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`Expected chainId 999, got ${chainId}`);

  const cfg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "config", "deployed-pool-f-hc-v3.json"), "utf8"));
  const VAULT = cfg.vault;
  const USDC  = cfg.usdc;

  const YIELD_TOKEN_ID  = 1n;
  const BASKET_TOKEN_ID = 1n;

  console.log("Signer:", signer.address);
  console.log("Vault :", VAULT);
  console.log("Pair  :", `yieldId=${YIELD_TOKEN_ID} basketId=${BASKET_TOKEN_ID}`);

  const vault = await hre.ethers.getContractAt([
    "function previewWithdrawPair(uint256) view returns (uint256 basketPreview, uint256 yieldPreview, uint256 total)",
    "function withdrawPair(uint256,uint256,address) returns (uint256 payout)",
    "function basketOfYield(uint256) view returns (uint256)",
    "function yieldPrincipalOf(uint256) view returns (uint128)",
    "event PairWithdrawn(address indexed depositor, uint256 yieldTokenId, uint256 basketTokenId, uint256 basketPayout, uint256 yieldPayout, uint256 payout)",
  ], VAULT, signer);

  // Pre-flight reads
  const preview  = await vault.previewWithdrawPair(YIELD_TOKEN_ID);
  const pair     = await vault.basketOfYield(YIELD_TOKEN_ID);
  const principal= await vault.yieldPrincipalOf(YIELD_TOKEN_ID);
  console.log("Preview (basket, yield, total):",
    preview[0].toString(), preview[1].toString(), preview[2].toString());
  console.log("basketOfYield(1):", pair.toString());
  console.log("yieldPrincipalOf(1):", principal.toString());

  if (pair !== BASKET_TOKEN_ID) throw new Error("pair mapping mismatch — abort");

  // Hyperliquid EIP-1559 quirk: priority fee MUST be 0n (RPC returns 0; tip
  // is burned anyway). maxFee = baseFee * 2 with a 1-gwei floor.
  const block = await hre.ethers.provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  let maxFee = baseFee * 2n;
  if (maxFee < 1_000_000_000n) maxFee = 1_000_000_000n;

  const usdc = await hre.ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"], USDC, signer);
  const balBefore = await usdc.balanceOf(signer.address);
  console.log("USDC balance before:", balBefore.toString());

  console.log("\nSubmitting withdrawPair…");
  const tx = await vault.withdrawPair(YIELD_TOKEN_ID, BASKET_TOKEN_ID, signer.address, {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: 0n,
  });
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("gas used:", r.gasUsed?.toString());

  // Decode the PairWithdrawn event for payout breakdown.
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
  console.log("USDC balance after :", balAfter.toString());
  console.log("Delta:", (balAfter - balBefore).toString(), "wei (6-dec)");
}

main().catch((e) => { console.error(e); process.exit(1); });
