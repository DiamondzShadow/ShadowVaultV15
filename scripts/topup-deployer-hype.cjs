require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env.pool-e") });
require("dotenv").config();
// Send a small amount of HYPE from HC_KEEPER → deployer so the deployer
// EOA has enough gas to call vault.withdrawPair after the basketAdapter
// borrow. One-shot helper, intentionally simple.

const hre = require("hardhat");

async function main() {
  const provider = hre.ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`Expected 999, got ${chainId}`);

  const keeperKey = process.env.HC_KEEPER_KEY;
  if (!keeperKey) throw new Error("HC_KEEPER_KEY not set");
  const keeper = new hre.ethers.Wallet(keeperKey, provider);

  const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
  const AMOUNT_HYPE = hre.ethers.parseEther("0.006");

  console.log("Keeper:", keeper.address);
  console.log("Bal   :", hre.ethers.formatEther(await provider.getBalance(keeper.address)));

  const block = await provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  let maxFee = baseFee * 2n;
  if (maxFee < 100_000_000n) maxFee = 100_000_000n;

  const tx = await keeper.sendTransaction({
    to: DEPLOYER,
    value: AMOUNT_HYPE,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: 0n,
    gasLimit: 22_000n,
  });
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("Deployer balance after:", hre.ethers.formatEther(await provider.getBalance(DEPLOYER)));
}

main().catch((e) => { console.error(e); process.exit(1); });
