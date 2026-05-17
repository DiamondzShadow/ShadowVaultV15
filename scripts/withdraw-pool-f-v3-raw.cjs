// Raw drain: bypasses hardhat-ethers signer to avoid its gas-overriding
// quirks on HyperEVM. Uses ethers.Wallet + manual sendTransaction with
// explicit fields (gasLimit, maxFeePerGas, maxPriorityFeePerGas).
//
// Prereq: idle/totalAssets ≥ 95% on HLPAdapter (see -with-topup script
// for the basketAdapter borrow that gets us there).

require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");

const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);

  const cfg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "config", "deployed-pool-f-hc-v3.json"), "utf8"));

  const VAULT = cfg.vault;
  const USDC  = cfg.usdc;

  const YIELD_ID  = 1n;
  const BASKET_ID = 1n;

  const usdc = new ethers.Contract(USDC,
    ["function balanceOf(address) view returns (uint256)"], provider);
  const vault = new ethers.Contract(VAULT, [
    "function previewWithdrawPair(uint256) view returns (uint256,uint256,uint256)",
    "function withdrawPair(uint256,uint256,address) returns (uint256)",
    "event PairWithdrawn(address indexed depositor, uint256 yieldTokenId, uint256 basketTokenId, uint256 basketPayout, uint256 yieldPayout, uint256 payout)",
  ], deployer);

  const preview = await vault.previewWithdrawPair(YIELD_ID);
  console.log("Preview (basket, yield, total):", preview[0].toString(), preview[1].toString(), preview[2].toString());

  // Encode calldata ourselves so the tx payload is fully explicit.
  const data = vault.interface.encodeFunctionData("withdrawPair", [YIELD_ID, BASKET_ID, deployer.address]);

  const block = await provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  let maxFee = baseFee * 2n;
  if (maxFee < 100_000_000n) maxFee = 100_000_000n; // 0.1 gwei floor

  const nonce = await provider.getTransactionCount(deployer.address, "latest");
  const balBefore = await usdc.balanceOf(deployer.address);
  const hypeBefore = await provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address);
  console.log("Nonce :", nonce, "USDC:", balBefore.toString(), "HYPE:", ethers.formatEther(hypeBefore));
  console.log("maxFee:", maxFee.toString(), "gasLimit: 600000");

  // Manual tx — bypass hardhat-ethers entirely. The wallet will sign with
  // these exact fields; the node validates `gas * maxFeePerGas + value <= balance`.
  const tx = await deployer.sendTransaction({
    to: VAULT,
    data,
    value: 0n,
    nonce,
    chainId: 999n,
    type: 2,                          // EIP-1559
    gasLimit: 600_000n,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: 0n,
  });
  console.log("Submitted:", tx.hash);
  const r = await tx.wait();
  console.log("gas used:", r.gasUsed?.toString(), "status:", r.status);

  const ev = r.logs
    .map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "PairWithdrawn");
  if (ev) {
    console.log("PairWithdrawn:",
      "basketPayout:", ev.args.basketPayout?.toString(),
      "yieldPayout:",  ev.args.yieldPayout?.toString(),
      "total:",        ev.args.payout?.toString());
  }

  const balAfter = await usdc.balanceOf(deployer.address);
  console.log("USDC delta:", (balAfter - balBefore).toString(),
    "wei (= $" + (Number(balAfter - balBefore) / 1e6).toFixed(6) + ")");
}

main().catch((e) => { console.error(e); process.exit(1); });
