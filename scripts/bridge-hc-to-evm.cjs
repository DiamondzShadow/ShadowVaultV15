// Bridge USDC from deployer HC spot → deployer EVM via CoreWriter SEND_ASSET action.
// This is the same mechanism the adapter uses in sweepFromCore.

const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const CORE_WRITER   = "0x3333333333333333333333333333333333333333";
const USDC_SYS_ADDR = "0x2000000000000000000000000000000000000000";
const USDC_TOKEN_IDX = 0;
const SPOT_DEX = 0xFFFFFFFF;
const SEND_ASSET_ACTION = 13;

(async () => {
  const amountWei = BigInt(process.argv[2] || "300000000"); // default 3 USDC (8 dec)

  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  console.log("Sender:", w.address);
  console.log("Bridging HC USDC →", w.address, "amount (wei 8dec):", amountWei.toString());

  // abi.encode(destination, fromSubAccount, sourceDex, destinationDex, token, amountWei)
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const body = abi.encode(
    ["address", "address", "uint32", "uint32", "uint64", "uint64"],
    [USDC_SYS_ADDR, ethers.ZeroAddress, SPOT_DEX, SPOT_DEX, USDC_TOKEN_IDX, amountWei]
  );
  // prefix: uint8(1) version + uint24 actionId (SEND_ASSET_ACTION = 13, big-endian 3 bytes)
  const prefix = "0x01" + SEND_ASSET_ACTION.toString(16).padStart(6, "0");
  const raw = prefix + body.slice(2);
  console.log("raw action:", raw);

  const cw = new ethers.Contract(CORE_WRITER, [
    "function sendRawAction(bytes)"
  ], w);
  const tx = await cw.sendRawAction(raw);
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("mined block", r.blockNumber);

  const usdc = new ethers.Contract("0xb88339CB7199b77E23DB6E890353E22632Ba630f", [
    "function balanceOf(address) view returns (uint256)"
  ], p);
  console.log("waiting for EVM arrival (SEND_ASSET is CoreWriter-scheduled, can take 20-60s)...");
  const startBal = await usdc.balanceOf(w.address);
  console.log("  start EVM USDC:", ethers.formatUnits(startBal, 6));
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000));
    const bal = await usdc.balanceOf(w.address);
    console.log(`  [${i*6}s] EVM USDC:`, ethers.formatUnits(bal, 6));
    if (bal > startBal) {
      console.log("✓ USDC arrived on EVM");
      return;
    }
  }
  console.log("⚠ did not arrive in 120s");
})().catch(e => { console.error(e); process.exit(1); });
