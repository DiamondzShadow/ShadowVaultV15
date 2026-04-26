// Check existing LendingPool state before redeploy. Abort if there are
// open loans / suppliers that would strand funds in the old pool.
const hre = require("hardhat");
const path = require("node:path");

const LENDING_POOL_KEY = "lendingPool";

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const cfgName = chainId === 42161 ? "deployed-lending-arb.json"
                : chainId === 137   ? "deployed-polygon-stack.json"
                : null;
  if (!cfgName) throw new Error(`unsupported chain ${chainId}`);
  const cfg = require(path.resolve(__dirname, "..", "config", cfgName));

  const poolAddr = cfg.contracts[LENDING_POOL_KEY] || cfg.contracts.lendingPool;
  const regAddr  = cfg.diggerRegistry || cfg.contracts.diggerRegistry;
  console.log(`chain ${chainId} | LendingPool ${poolAddr} | Registry ${regAddr}`);

  const pool = new hre.ethers.Contract(poolAddr, [
    "function totalBorrowed() view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function protocolReserve() view returns (uint256)",
    "function paused() view returns (bool)",
  ], hre.ethers.provider);

  const reg = new hre.ethers.Contract(regAddr, [
    "function totalBondedUSDC() view returns (uint256)",
    "function nextDiggerId() view returns (uint256)",
  ], hre.ethers.provider);

  console.log("\nLendingPool state:");
  console.log(`  totalBorrowed    : ${(await pool.totalBorrowed()).toString()}`);
  console.log(`  totalShares      : ${(await pool.totalShares()).toString()}`);
  console.log(`  totalAssets      : ${(await pool.totalAssets()).toString()}`);
  console.log(`  protocolReserve  : ${(await pool.protocolReserve()).toString()}`);
  console.log(`  paused           : ${await pool.paused()}`);

  console.log("\nDiggerRegistry state (v1):");
  console.log(`  nextDiggerId     : ${(await reg.nextDiggerId()).toString()}`);
  try {
    console.log(`  totalBondedUSDC  : ${(await reg.totalBondedUSDC()).toString()} (v2 only — v1 reverts)`);
  } catch {
    console.log(`  (v1: no totalBondedUSDC yet)`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const nativeBal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\nDeployer native bal: ${hre.ethers.formatEther(nativeBal)}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
