// Prime the v2 adapter for first use:
//   1. Activate adapter HC account by bridging ≥2 USDC from deployer.
//      The HC activation fee (1 USDC) is taken from the inbound; the rest
//      lands on the adapter's HC spot balance as a small buffer.
//   2. Send 0.01 HYPE to the adapter's HC account so it can pay sendAsset
//      gas for the bridgeToEvm leg of withdrawals.
//
// Idempotent-safe: skips activation if adapter HC spot already shows USDC,
// skips HYPE prime if HC HYPE already > threshold.

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const ADAPTER = process.argv[2] || "0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9";
const USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const CORE_DEPOSIT = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24";
const SPOT_DEX = 0xFFFFFFFF;
const HYPE_SYS = "0x2222222222222222222222222222222222222222";

const ACTIVATION_USDC = 2_000_000n; // 2 USDC; 1 fee + 1 credited
const HYPE_TOTAL_EVM  = "0.02";     // 0.02 HYPE bridged; half sent to adapter
const HYPE_TO_ADAPTER = "0.01";

async function readHcUsdc(info, addr) {
  const s = await info.spotClearinghouseState({ user: addr });
  const u = (s.balances || []).find(b => b.coin === "USDC");
  return u ? parseFloat(u.total) : 0;
}
async function readHcHype(info, addr) {
  const s = await info.spotClearinghouseState({ user: addr });
  const h = (s.balances || []).find(b => b.coin === "HYPE");
  return h ? parseFloat(h.total) : 0;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);

  console.log("Deployer:", wallet.address);
  console.log("Adapter :", ADAPTER);

  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });

  const usdcOnHc = await readHcUsdc(info, ADAPTER);
  const hypeOnHc = await readHcHype(info, ADAPTER);
  console.log("\nadapter HC spot:");
  console.log("  USDC:", usdcOnHc);
  console.log("  HYPE:", hypeOnHc);

  // --- Step 1: activate via USDC bridge ---
  if (usdcOnHc > 0.5) {
    console.log("\n[1/3] adapter already has USDC on HC spot — skipping activation");
  } else {
    console.log(`\n[1/3] bridging ${ACTIVATION_USDC} (2 USDC) deployer→adapter HC spot via depositFor`);
    const usdc = new ethers.Contract(USDC, [
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ], wallet);
    const cdw = new ethers.Contract(CORE_DEPOSIT, [
      "function depositFor(address,uint256,uint32)",
    ], wallet);

    const balBefore = await usdc.balanceOf(wallet.address);
    console.log("  deployer USDC EVM before:", ethers.formatUnits(balBefore, 6));

    const ax = await usdc.approve(CORE_DEPOSIT, ACTIVATION_USDC);
    console.log("  approve tx:", ax.hash);
    await ax.wait();

    const tx = await cdw.depositFor(ADAPTER, ACTIVATION_USDC, SPOT_DEX);
    console.log("  depositFor tx:", tx.hash);
    await tx.wait();
    console.log("  mined.");

    console.log("  waiting for HC to credit (≤30s)...");
    for (let i = 0; i < 12; i++) {
      const u = await readHcUsdc(info, ADAPTER);
      console.log(`    [${i*5}s] adapter HC USDC = ${u}`);
      if (u >= 0.5) { console.log("  ✓ activated, USDC credited"); break; }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // --- Step 2: prime HYPE on EVM→deployer HC ---
  console.log("\n[2/3] bridging deployer HYPE EVM→HC");
  const balHype = await provider.getBalance(wallet.address);
  console.log("  deployer HYPE EVM:", ethers.formatEther(balHype));
  const tx2 = await wallet.sendTransaction({
    to: HYPE_SYS,
    value: ethers.parseEther(HYPE_TOTAL_EVM),
  });
  console.log("  tx:", tx2.hash);
  await tx2.wait();

  console.log("  waiting for HC HYPE to land on deployer (≤30s)...");
  for (let i = 0; i < 12; i++) {
    const h = await readHcHype(info, wallet.address);
    console.log(`    [${i*5}s] deployer HC HYPE = ${h}`);
    if (h >= parseFloat(HYPE_TOTAL_EVM) * 0.9) { console.log("  ✓ landed"); break; }
    await new Promise(r => setTimeout(r, 5000));
  }

  // --- Step 3: spotSend HYPE deployer HC→adapter HC ---
  if (hypeOnHc > 0.005) {
    console.log("\n[3/3] adapter already has HYPE on HC — skipping spotSend");
  } else {
    console.log(`\n[3/3] spotSend ${HYPE_TO_ADAPTER} HYPE → adapter`);
    const exchange = new hl.ExchangeClient({ wallet, transport: new hl.HttpTransport() });
    const res = await exchange.spotSend({
      destination: ADAPTER,
      token: "HYPE:0x0d01dc56dcaaca66ad901c959b4011ec",
      amount: HYPE_TO_ADAPTER,
    });
    console.log("  spotSend response:", JSON.stringify(res));

    console.log("  waiting for HC HYPE on adapter (≤30s)...");
    for (let i = 0; i < 12; i++) {
      const h = await readHcHype(info, ADAPTER);
      console.log(`    [${i*5}s] adapter HC HYPE = ${h}`);
      if (h >= parseFloat(HYPE_TO_ADAPTER) * 0.9) { console.log("  ✓ landed"); break; }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log("\n✓ adapter primed");
})().catch(e => { console.error(e); process.exit(1); });
