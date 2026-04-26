const { ethers } = require("hardhat");

const VAULT = "0x9809f6A1Ce2B9A026179f7f8deccf46341a62c0e";
const USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const OX_ALLOWANCE_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";

async function get0xQuote(sellToken, buyToken, sellAmount, taker) {
  const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}&taker=${taker}`;
  const res = await fetch(url, {
    headers: { "0x-api-key": OX_KEY, "0x-version": "v2" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`0x ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("ShadowBasketVault", VAULT);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)"], deployer);

  const pendingUSDC = await usdc.balanceOf(VAULT);
  console.log("Vault USDC (pending):", ethers.formatUnits(pendingUSDC, 6));
  if (pendingUSDC == 0n) { console.log("Nothing to buy."); return; }

  // Step 1: Approve 0x allowance holder on vault (one-time)
  console.log("\n1. Approving 0x allowance holder for all basket tokens...");
  await (await vault.approveSwapTarget(USDC, OX_ALLOWANCE_HOLDER, ethers.MaxUint256)).wait();
  console.log("   USDC approved ✓");

  // Read basket config
  const len = Number(await vault.basketLength());
  const tokens = [];
  for (let i = 0; i < len; i++) {
    const tc = await vault.basketTokens(i);
    tokens.push({ token: tc.token, weight: Number(tc.targetWeightBps), decimals: Number(tc.tokenDecimals) });
  }

  const nonUsdc = tokens.filter(t => t.token.toLowerCase() !== USDC.toLowerCase());
  const nonUsdcWeight = nonUsdc.reduce((s, t) => s + t.weight, 0);
  const usdcWeight = tokens.find(t => t.token.toLowerCase() === USDC.toLowerCase())?.weight || 0;
  const toSpend = (pendingUSDC * BigInt(nonUsdcWeight)) / BigInt(nonUsdcWeight + usdcWeight);

  console.log(`\n2. Buying ${nonUsdc.length} tokens with ${ethers.formatUnits(toSpend, 6)} USDC\n`);

  for (const t of nonUsdc) {
    const allocation = (toSpend * BigInt(t.weight)) / BigInt(nonUsdcWeight);
    if (allocation == 0n) continue;

    const tok = new ethers.Contract(t.token, ["function symbol() view returns(string)","function balanceOf(address) view returns(uint256)"], deployer);
    const sym = await tok.symbol();
    console.log(`── ${sym}: ${ethers.formatUnits(allocation, 6)} USDC ──`);

    try {
      const quote = await get0xQuote(USDC, t.token, allocation.toString(), VAULT);
      console.log(`   Route: ${quote.route.fills.map(f => f.source).join(" → ")}`);
      console.log(`   Buy amount: ${ethers.formatUnits(quote.buyAmount, t.decimals)}`);

      const tx = await vault.executeBuyBasket(
        t.token,
        allocation,
        quote.transaction.to,
        quote.transaction.data,
        { gasLimit: BigInt(quote.transaction.gas) * 2n }
      );
      const r = await tx.wait();
      const bal = await tok.balanceOf(VAULT);
      console.log(`   ✓ Gas: ${r.gasUsed} | Balance: ${ethers.formatUnits(bal, t.decimals)} ${sym}`);
    } catch (e) {
      console.log(`   ✗ ${e.message.slice(0, 150)}`);
    }
  }

  // Final state
  console.log("\n═══ Vault State ═══");
  console.log("USDC:", ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
  console.log("Basket value:", ethers.formatUnits(await vault.totalBasketValue(), 6));
  console.log("Aave:", ethers.formatUnits(await vault.aaveTotalAssets(), 6));

  const drift = await vault.getBasketDrift();
  console.log("\nDrift:");
  for (let i = 0; i < drift.tokens.length; i++) {
    const tc = await vault.basketTokens(i);
    const tok = new ethers.Contract(tc.token, ["function symbol() view returns(string)"], deployer);
    const sym = await tok.symbol();
    console.log(`  ${sym.padEnd(6)}: ${drift.currentBps[i].toString().padStart(5)} / ${drift.targetBps[i].toString().padStart(5)} (drift ${drift.driftBps[i]})`);
  }

  // Position value
  const pv = await vault.estimatePositionValue(1);
  console.log(`\nPos 1 value: basket=$${ethers.formatUnits(pv.basketVal, 6)} aave=$${ethers.formatUnits(pv.aaveVal, 6)} total=$${ethers.formatUnits(pv.total, 6)}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
