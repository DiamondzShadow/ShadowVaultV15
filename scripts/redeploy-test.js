const { ethers } = require("hardhat");

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SDM  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const OX_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";

const BASKET = [
  { name: "WETH", token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", weight: 3000, feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", fdec: 8, tdec: 18 },
  { name: "WBTC", token: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", weight: 2000, feed: "0xd0C7101eACbB49F3deCcCc166d238410D6D46d57", fdec: 8, tdec: 8 },
  { name: "ARB",  token: "0x912CE59144191C1204E64559FE8253a0e49E6548", weight: 1500, feed: "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6", fdec: 8, tdec: 18 },
  { name: "LINK", token: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", weight: 1500, feed: "0x86E53CF1B870786351Da77A57575e79CB55812CB", fdec: 8, tdec: 18 },
  { name: "USDC", token: USDC, weight: 2000, feed: "0x0000000000000000000000000000000000000000", fdec: 0, tdec: 6 },
];

async function get0xQuote(sellToken, buyToken, sellAmount, taker) {
  const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}&taker=${taker}`;
  const res = await fetch(url, { headers: { "0x-api-key": OX_KEY, "0x-version": "v2" } });
  if (!res.ok) throw new Error(`0x ${res.status}: ${(await res.text()).slice(0,120)}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"], deployer);
  console.log("USDC:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));

  // ─── Deploy ───
  console.log("\n1. Deploy...");
  const vault = await (await ethers.getContractFactory("ShadowBasketVault")).deploy(deployer.address, SDM);
  await vault.waitForDeployment();
  const VAULT = await vault.getAddress();
  console.log("   Vault:", VAULT);

  await (await vault.setKeeper(deployer.address)).wait();
  for (const t of BASKET) {
    await (await vault.addBasketToken(t.token, t.weight, t.feed, t.fdec, t.tdec)).wait();
  }
  console.log("   Basket configured ✓");

  // Approve 0x for all tokens
  await (await vault.approveSwapTarget(USDC, OX_HOLDER, ethers.MaxUint256)).wait();
  for (const t of BASKET.filter(t => t.token !== USDC)) {
    await (await vault.approveSwapTarget(t.token, OX_HOLDER, ethers.MaxUint256)).wait();
  }
  console.log("   0x approved ✓");

  // ─── Deposit $5 FLEX ───
  console.log("\n2. Deposit $5 FLEX...");
  await (await usdc.approve(VAULT, ethers.MaxUint256)).wait();
  await (await vault.deposit(5_000_000n, 0, { gasLimit: 1_000_000 })).wait();
  console.log("   ✓ Pos 1 created, $3.50 pending basket buy");

  // ─── Keeper buys ───
  console.log("\n3. Keeper buying basket tokens...");
  const pendingUSDC = await usdc.balanceOf(VAULT);
  const nonUsdc = BASKET.filter(t => t.token !== USDC);
  const nonUsdcWeight = nonUsdc.reduce((s, t) => s + t.weight, 0);
  const usdcWeight = BASKET.find(t => t.token === USDC)?.weight || 0;
  const toSpend = (pendingUSDC * BigInt(nonUsdcWeight)) / BigInt(nonUsdcWeight + usdcWeight);

  for (const t of nonUsdc) {
    const alloc = (toSpend * BigInt(t.weight)) / BigInt(nonUsdcWeight);
    if (alloc < 500_000n) { console.log(`   ${t.name}: $${ethers.formatUnits(alloc,6)} too small, skip`); continue; }
    try {
      const q = await get0xQuote(USDC, t.token, alloc.toString(), VAULT);
      await (await vault.executeBuyBasket(t.token, alloc, q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
      console.log(`   ${t.name}: ✓ bought with $${ethers.formatUnits(alloc, 6)}`);
    } catch(e) { console.log(`   ${t.name}: ✗ ${e.message.slice(0,80)}`); }
  }

  // Show state
  const bv = await vault.totalBasketValue();
  console.log("   Basket value: $" + ethers.formatUnits(bv, 6));

  // ─── Wait for timestamp cooldown ───
  await sleep(2000);

  // ─── Withdraw ───
  console.log("\n4. Request withdraw...");
  await (await vault.requestWithdraw(1, { gasLimit: 500_000 })).wait();
  console.log("   ✓ Requested");

  // Sell basket tokens
  console.log("\n5. Keeper selling tokens...");
  const pos = await vault.positions(1);
  const shares = await vault.getShareTokenAmounts(pos.wsdmAmount);
  for (let i = 0; i < shares.tokens.length; i++) {
    if (shares.tokens[i].toLowerCase() === USDC.toLowerCase()) continue;
    if (shares.amounts[i] == 0n) continue;
    const tok = new ethers.Contract(shares.tokens[i], ["function symbol() view returns(string)","function decimals() view returns(uint8)"], deployer);
    const sym = await tok.symbol();
    const dec = await tok.decimals();
    const amt = shares.amounts[i];
    console.log(`   ${sym}: ${ethers.formatUnits(amt, dec)}`);
    try {
      const q = await get0xQuote(shares.tokens[i], USDC, amt.toString(), VAULT);
      await (await vault.executeWithdrawalSwap(1, shares.tokens[i], amt, q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
      console.log(`   ✓ sold`);
    } catch(e) { console.log(`   ✗ ${e.message.slice(0,80)}`); }
  }

  console.log("\n6. Complete withdraw...");
  const balBefore = await usdc.balanceOf(deployer.address);
  await (await vault.completeWithdraw(1, { gasLimit: 500_000 })).wait();
  const balAfter = await usdc.balanceOf(deployer.address);
  const received = balAfter - balBefore;

  console.log("\n════════════════════════════════");
  console.log("  RESULT");
  console.log("════════════════════════════════");
  console.log("Vault:", VAULT);
  console.log("Deposited: $5.00");
  console.log("Received:  $" + ethers.formatUnits(received, 6));
  console.log("Fee+slippage: $" + ethers.formatUnits(5_000_000n - received, 6));
  console.log("USDC final:", ethers.formatUnits(balAfter, 6));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
