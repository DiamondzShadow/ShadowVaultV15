const { ethers } = require("hardhat");

const VAULT = "0x088985afb5af4219336177F7B4A461af9f0CD725";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const OX_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";

async function get0xQuote(sellToken, buyToken, sellAmount) {
  const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}&taker=${VAULT}`;
  const res = await fetch(url, { headers: { "0x-api-key": OX_KEY, "0x-version": "v2" } });
  if (!res.ok) throw new Error(`0x ${res.status}: ${(await res.text()).slice(0,120)}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("ShadowBasketVault", VAULT);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"], deployer);
  console.log("USDC:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));

  // ─── Approve 0x ───
  console.log("Approving 0x...");
  const tokens = [
    USDC,
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    "0x912CE59144191C1204E64559FE8253a0e49E6548",
    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  ];
  for (const t of tokens) {
    try {
      const tx = await vault.approveSwapTarget(t, OX_HOLDER, ethers.MaxUint256);
      await tx.wait();
    } catch(e) { /* may already be approved */ }
  }
  console.log("Done ✓");

  // ─── Deposit $5 FLEX ───
  console.log("\nDeposit $5 FLEX...");
  await (await usdc.approve(VAULT, ethers.MaxUint256)).wait();
  await (await vault.deposit(5_000_000n, 0, { gasLimit: 1_000_000 })).wait();
  console.log("✓ Deposited. Vault USDC:", ethers.formatUnits(await usdc.balanceOf(VAULT), 6));

  // ─── Keeper buy (WETH + ARB + LINK, skip WBTC < $1) ───
  console.log("\nKeeper buying...");
  const buys = [
    { name: "WETH", token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: 1_050_000n },
    { name: "ARB",  token: "0x912CE59144191C1204E64559FE8253a0e49E6548", usdc: 525_000n },
    { name: "LINK", token: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", usdc: 525_000n },
  ];
  // WBTC skipped: $0.70 too small for 0x. USDC portion ($0.70) stays as basket USDC.
  for (const b of buys) {
    try {
      const q = await get0xQuote(USDC, b.token, b.usdc.toString());
      await (await vault.executeBuyBasket(b.token, b.usdc, q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
      console.log(`  ${b.name}: ✓`);
    } catch(e) { console.log(`  ${b.name}: ✗ ${e.message.slice(0,80)}`); }
  }

  console.log("Basket value: $" + ethers.formatUnits(await vault.totalBasketValue(), 6));

  // ─── Wait for cooldown ───
  console.log("\nWaiting 2s...");
  await sleep(2000);

  // ─── Request withdraw ───
  console.log("Request withdraw pos 1...");
  await (await vault.requestWithdraw(1, { gasLimit: 500_000 })).wait();
  console.log("✓ Requested");

  // ─── Sell tokens ───
  console.log("Selling tokens...");
  const pos = await vault.positions(1);
  const shares = await vault.getShareTokenAmounts(pos.wsdmAmount);
  for (let i = 0; i < shares.tokens.length; i++) {
    if (shares.tokens[i].toLowerCase() === USDC.toLowerCase()) continue;
    if (shares.amounts[i] == 0n) continue;
    const tok = new ethers.Contract(shares.tokens[i], ["function symbol() view returns(string)"], deployer);
    const sym = await tok.symbol();
    try {
      const q = await get0xQuote(shares.tokens[i], USDC, shares.amounts[i].toString());
      await (await vault.executeWithdrawalSwap(1, shares.tokens[i], shares.amounts[i], q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
      console.log(`  ${sym}: ✓`);
    } catch(e) { console.log(`  ${sym}: ✗ ${e.message.slice(0,80)}`); }
  }

  // ─── Complete ───
  console.log("Completing...");
  const balBefore = await usdc.balanceOf(deployer.address);
  await (await vault.completeWithdraw(1, { gasLimit: 500_000 })).wait();
  const balAfter = await usdc.balanceOf(deployer.address);
  const received = balAfter - balBefore;

  console.log("\n════════════════════════════════");
  console.log("  ShadowBasketVault:", VAULT);
  console.log("  Deposited: $5.00");
  console.log("  Received:  $" + ethers.formatUnits(received, 6));
  console.log("  Cost:      $" + ethers.formatUnits(5_000_000n - received, 6));
  console.log("  USDC now:  $" + ethers.formatUnits(balAfter, 6));
  console.log("════════════════════════════════");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
