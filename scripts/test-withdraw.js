const { ethers } = require("hardhat");

const VAULT = "0x9809f6A1Ce2B9A026179f7f8deccf46341a62c0e";
const USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";
const OX_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";

async function get0xQuote(sellToken, buyToken, sellAmount) {
  const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}&taker=${VAULT}`;
  const res = await fetch(url, { headers: { "0x-api-key": OX_KEY, "0x-version": "v2" } });
  if (!res.ok) throw new Error(`0x ${res.status}: ${(await res.text()).slice(0,100)}`);
  return res.json();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("ShadowBasketVault", VAULT);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)"], deployer);

  console.log("═══ WITHDRAW TEST ═══");
  const balBefore = await usdc.balanceOf(deployer.address);
  console.log("USDC before:", ethers.formatUnits(balBefore, 6));

  const pv = await vault.estimatePositionValue(1);
  console.log("Pos 1 value: $" + ethers.formatUnits(pv.total, 6));

  // Step 1: Request withdrawal
  console.log("\n1. Requesting withdrawal...");
  const tx1 = await vault.requestWithdraw(1, { gasLimit: 500_000 });
  const r1 = await tx1.wait();
  console.log("   ✓ Requested | Gas:", r1.gasUsed.toString());

  const pw = await vault.pendingWithdraws(1);
  console.log("   Yield USDC:", ethers.formatUnits(pw.yieldUSDC, 6));
  console.log("   Fee bps:", pw.feeBps.toString());

  // Step 2: Keeper sells each basket token for USDC via 0x
  console.log("\n2. Selling basket tokens...");

  // Get pro-rata token amounts
  const pos = await vault.positions(1);
  const shares = await vault.getShareTokenAmounts(pos.wsdmAmount);

  for (let i = 0; i < shares.tokens.length; i++) {
    const token = shares.tokens[i];
    const amount = shares.amounts[i];
    if (token.toLowerCase() === USDC.toLowerCase()) continue; // USDC doesn't need swap
    if (amount == 0n) continue;

    const tok = new ethers.Contract(token, ["function symbol() view returns(string)", "function decimals() view returns(uint8)"], deployer);
    const sym = await tok.symbol();
    const dec = await tok.decimals();
    console.log(`\n   ${sym}: selling ${ethers.formatUnits(amount, dec)}`);

    // Approve 0x to spend this token from vault
    await (await vault.approveSwapTarget(token, OX_HOLDER, ethers.MaxUint256)).wait();

    try {
      const quote = await get0xQuote(token, USDC, amount.toString());
      console.log(`   Route: ${quote.route.fills.map(f => f.source).join(" → ")}`);

      const tx = await vault.executeWithdrawalSwap(
        1, // posId
        token,
        amount,
        quote.transaction.to,
        quote.transaction.data,
        { gasLimit: BigInt(quote.transaction.gas) * 2n }
      );
      const r = await tx.wait();
      console.log(`   ✓ Gas: ${r.gasUsed}`);
    } catch (e) {
      console.log(`   ✗ ${e.message.slice(0, 150)}`);
    }
  }

  // Check gathered
  const pw2 = await vault.pendingWithdraws(1);
  console.log("\n   USDC gathered from sells:", ethers.formatUnits(pw2.usdcGathered, 6));

  // Step 3: Complete withdrawal
  console.log("\n3. Completing withdrawal...");
  const tx3 = await vault.completeWithdraw(1, { gasLimit: 300_000 });
  const r3 = await tx3.wait();
  console.log("   ✓ Completed | Gas:", r3.gasUsed.toString());

  const balAfter = await usdc.balanceOf(deployer.address);
  const received = balAfter - balBefore;
  console.log("\n═══ RESULT ═══");
  console.log("USDC received:", ethers.formatUnits(received, 6));
  console.log("Deposited:", "5.0");
  console.log("Net cost:", ethers.formatUnits(5_000_000n - received, 6), "(fee + slippage)");
  console.log("USDC after:", ethers.formatUnits(balAfter, 6));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
