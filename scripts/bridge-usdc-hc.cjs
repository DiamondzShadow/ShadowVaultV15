const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const CORE_DEPOSIT = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";
const SPOT_DEX = 0xFFFFFFFF;
const AMOUNT = 5_000_000n;

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  const usdc = new ethers.Contract(USDC, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)"
  ], w);
  const wallet = new ethers.Contract(CORE_DEPOSIT, [
    "function deposit(uint256,uint32)"
  ], w);

  console.log("USDC before:", ethers.formatUnits(await usdc.balanceOf(w.address), 6));

  console.log("approving CoreDepositWallet...");
  const ax = await usdc.approve(CORE_DEPOSIT, AMOUNT);
  await ax.wait();
  console.log("approve tx:", ax.hash);

  console.log("deposit(5 USDC, SPOT_DEX)...");
  const tx = await wallet.deposit(AMOUNT, SPOT_DEX);
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("mined in block", r.blockNumber);

  console.log("USDC after EVM:", ethers.formatUnits(await usdc.balanceOf(w.address), 6));
  console.log("wait ~20s for HC ingestion...");
})().catch(e => { console.error(e); process.exit(1); });
