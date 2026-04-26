// Primes the adapter with HYPE on HC so it can pay sendAsset gas for bridgeToEvm.
// Two steps:
//   1. Deployer transfers native HYPE to 0x2222...2222 → deployer's HC HYPE balance
//   2. Deployer signs spotSend("HYPE:150", adapterAddress, amount) → adapter HC HYPE
//
// Usage: node scripts/prime-adapter-hype.cjs <evmHypeAmount> <adapter>
// e.g.   node scripts/prime-adapter-hype.cjs 0.02 0x5c45...

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const HYPE_SYS = "0x2222222222222222222222222222222222222222";

async function waitHcHype(info, addr, minCoreAmt, label) {
  for (let i = 0; i < 30; i++) {
    const res = await info.spotClearinghouseState({ user: addr });
    const hype = res.balances?.find(b => b.coin === "HYPE");
    const total = hype ? parseFloat(hype.total) : 0;
    console.log(`  [${label}] HC HYPE = ${total}`);
    if (total >= minCoreAmt) return total;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`${label} HC HYPE never reached ${minCoreAmt}`);
}

(async () => {
  const evmAmtStr = process.argv[2] || "0.02";
  const adapter = process.argv[3] || "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
  const sendAmt = (parseFloat(evmAmtStr) / 2).toString();  // send half to adapter

  const rpc = process.env.HYPEREVM_RPC;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);

  console.log("Deployer:", wallet.address);
  console.log("Adapter :", adapter);
  console.log("EVM HYPE bridge:", evmAmtStr, "HYPE →", HYPE_SYS);

  const bal = await provider.getBalance(wallet.address);
  console.log("  HYPE EVM before:", ethers.formatEther(bal));

  const tx = await wallet.sendTransaction({
    to: HYPE_SYS,
    value: ethers.parseEther(evmAmtStr),
  });
  console.log("  tx:", tx.hash);
  const r = await tx.wait();
  console.log("  mined block", r.blockNumber);

  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });
  console.log("\nwaiting for HC HYPE to land on deployer...");
  await waitHcHype(info, wallet.address, parseFloat(evmAmtStr) * 0.9, "deployer");

  console.log(`\nspotSend ${sendAmt} HYPE → ${adapter}`);
  const exchange = new hl.ExchangeClient({ wallet, transport: new hl.HttpTransport() });
  const res = await exchange.spotSend({
    destination: adapter,
    token: "HYPE:0x0d01dc56dcaaca66ad901c959b4011ec",
    amount: sendAmt,
  });
  console.log("spotSend response:", JSON.stringify(res, null, 2));

  console.log("\nwaiting for HC HYPE to land on adapter...");
  await waitHcHype(info, adapter, parseFloat(sendAmt) * 0.9, "adapter");

  console.log("\n✓ adapter primed with HYPE on HC");
})().catch(e => { console.error(e); process.exit(1); });
