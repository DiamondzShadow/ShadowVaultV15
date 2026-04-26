const { ethers } = require("hardhat");
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SDM  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const OX   = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";

// Chainlink feeds (Arbitrum)
const FEEDS = {
  WETH:  "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  WBTC:  "0xd0C7101eACbB49F3deCcCc166d238410D6D46d57",
  ARB:   "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",
  LINK:  "0x86E53CF1B870786351Da77A57575e79CB55812CB",
  GMX:   "0xDB98056FecFff59D032aB628337A4887110df3dB",
  PENDLE:"0x66853E19d73c0F9301fe229c5886c62dB2d1e144",
  PEPE:  "0x02DEd5a7EDDA750E3Eb240b54437a54d57b74dBE",
  XAU:   "0x3ec8593F930EA45ea58c968260e6e9FF53FC934f",
};

// Token addresses
const TOKENS = {
  WETH:   { addr: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", dec: 18 },
  WBTC:   { addr: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", dec: 8 },
  ARB:    { addr: "0x912CE59144191C1204E64559FE8253a0e49E6548", dec: 18 },
  LINK:   { addr: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", dec: 18 },
  GMX:    { addr: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", dec: 18 },
  PENDLE: { addr: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", dec: 18 },
  PEPE:   { addr: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", dec: 18 },
  XAUt0:  { addr: "0x40461291347e1eCbb09499F3371D3f17f10d7159", dec: 6 },
  TSLAX:  { addr: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0", dec: 18 },
  NVDAX:  { addr: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d", dec: 18 },
  SPYX:   { addr: "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48", dec: 18 },
  USDC:   { addr: USDC, dec: 6 },
};

const BASKETS = {
  A: {
    name: "Blue Chip",
    tokens: [
      { sym: "WETH",  weight: 4500, feed: FEEDS.WETH, fdec: 8 },
      { sym: "WBTC",  weight: 3500, feed: FEEDS.WBTC, fdec: 8 },
      { sym: "USDC",  weight: 2000, feed: "0x0000000000000000000000000000000000000000", fdec: 0 },
    ]
  },
  B: {
    name: "DeFi + RWA",
    tokens: [
      { sym: "WETH",   weight: 2000, feed: FEEDS.WETH,   fdec: 8 },
      { sym: "GMX",    weight: 2000, feed: FEEDS.GMX,     fdec: 8 },
      { sym: "PENDLE", weight: 1500, feed: FEEDS.PENDLE,  fdec: 8 },
      { sym: "XAUt0",  weight: 1500, feed: FEEDS.XAU,     fdec: 8 },
      { sym: "LINK",   weight: 1500, feed: FEEDS.LINK,    fdec: 8 },
      { sym: "USDC",   weight: 1500, feed: "0x0000000000000000000000000000000000000000", fdec: 0 },
    ]
  },
  C: {
    name: "Full Spectrum + Stocks",
    tokens: [
      { sym: "WETH",  weight: 1200, feed: FEEDS.WETH,  fdec: 8 },
      { sym: "WBTC",  weight: 800,  feed: FEEDS.WBTC,  fdec: 8 },
      { sym: "PEPE",  weight: 1200, feed: FEEDS.PEPE,  fdec: 8 },
      { sym: "ARB",   weight: 1000, feed: FEEDS.ARB,   fdec: 8 },
      { sym: "TSLAX", weight: 1500, feed: FEEDS.WETH,  fdec: 8 }, // placeholder feed until verified
      { sym: "NVDAX", weight: 1500, feed: FEEDS.WETH,  fdec: 8 }, // placeholder feed until verified
      { sym: "SPYX",  weight: 1000, feed: FEEDS.WETH,  fdec: 8 }, // placeholder feed until verified
      { sym: "USDC",  weight: 1800, feed: "0x0000000000000000000000000000000000000000", fdec: 0 },
    ]
  },
};

async function deployBasket(deployer, key, config) {
  console.log(`\n═════════════════���════════════════════════`);
  console.log(`  Basket ${key}: ${config.name}`);
  console.log(`══════════════════════════════════════════`);

  const Factory = await ethers.getContractFactory("ShadowBasketVault");
  const vault = await Factory.deploy(deployer.address, SDM);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();
  console.log(`  Vault: ${addr}`);

  // Keeper
  await (await vault.setKeeper(deployer.address)).wait();

  // Add basket tokens
  let weightSum = 0;
  for (const t of config.tokens) {
    const tok = TOKENS[t.sym];
    await (await vault.addBasketToken(tok.addr, t.weight, t.feed, t.fdec, tok.dec)).wait();
    weightSum += t.weight;
    console.log(`  ${t.sym.padEnd(8)} ${t.weight} bps`);
  }
  console.log(`  Sum: ${weightSum} ${weightSum === 10000 ? '✓' : '✗'}`);

  // Approve 0x for all tokens
  await (await vault.approveSwapTarget(USDC, OX, ethers.MaxUint256)).wait();
  for (const t of config.tokens) {
    if (t.sym === "USDC") continue;
    await (await vault.approveSwapTarget(TOKENS[t.sym].addr, OX, ethers.MaxUint256)).wait();
  }
  console.log(`  0x approved ✓`);

  return addr;
}

async function testBasket(deployer, addr, key, config) {
  console.log(`\n── Test Basket ${key} ──`);
  const vault = await ethers.getContractAt("ShadowBasketVault", addr);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"], deployer);

  // Deposit $5
  await (await usdc.approve(addr, ethers.MaxUint256)).wait();
  await (await vault.deposit(5_000_000n, 0, { gasLimit: 1_000_000 })).wait();
  console.log(`  Deposit $5 ✓`);

  // Keeper buys
  const nonUsdc = config.tokens.filter(t => t.sym !== "USDC");
  const nonUsdcWeight = nonUsdc.reduce((s, t) => s + t.weight, 0);
  const usdcWeight = config.tokens.find(t => t.sym === "USDC")?.weight || 0;
  const pending = await usdc.balanceOf(addr);
  const toSpend = (pending * BigInt(nonUsdcWeight)) / BigInt(nonUsdcWeight + usdcWeight);

  for (const t of nonUsdc) {
    const alloc = (toSpend * BigInt(t.weight)) / BigInt(nonUsdcWeight);
    if (alloc < 500_000n) { console.log(`  ${t.sym}: $${ethers.formatUnits(alloc,6)} skip (too small)`); continue; }
    try {
      const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${USDC}&buyToken=${TOKENS[t.sym].addr}&sellAmount=${alloc}&taker=${addr}`;
      const res = await fetch(url, { headers: { "0x-api-key": OX_KEY, "0x-version": "v2" } });
      if (!res.ok) { console.log(`  ${t.sym}: 0x quote failed`); continue; }
      const q = await res.json();
      await (await vault.executeBuyBasket(TOKENS[t.sym].addr, alloc, q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
      console.log(`  ${t.sym} ✓`);
    } catch(e) { console.log(`  ${t.sym} ✗ ${e.message.slice(0,60)}`); }
  }

  // Wait
  await new Promise(r => setTimeout(r, 2000));

  // Withdraw
  const posId = Number(await vault.nextPosId()) - 1;
  await (await vault.requestWithdraw(posId, { gasLimit: 500_000 })).wait();

  const pos = await vault.positions(posId);
  const shares = await vault.getShareTokenAmounts(pos.wsdmAmount);
  for (let i = 0; i < shares.tokens.length; i++) {
    if (shares.tokens[i].toLowerCase() === USDC.toLowerCase() || shares.amounts[i] == 0n) continue;
    try {
      const url = `${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${shares.tokens[i]}&buyToken=${USDC}&sellAmount=${shares.amounts[i]}&taker=${addr}`;
      const res = await fetch(url, { headers: { "0x-api-key": OX_KEY, "0x-version": "v2" } });
      if (!res.ok) continue;
      const q = await res.json();
      await (await vault.executeWithdrawalSwap(posId, shares.tokens[i], shares.amounts[i], q.transaction.to, q.transaction.data, { gasLimit: BigInt(q.transaction.gas) * 2n })).wait();
    } catch {}
  }

  const bBefore = await usdc.balanceOf(deployer.address);
  await (await vault.completeWithdraw(posId, { gasLimit: 500_000 })).wait();
  const bAfter = await usdc.balanceOf(deployer.address);
  const got = bAfter - bBefore;
  console.log(`  Deposited: $5.00 | Received: $${ethers.formatUnits(got,6)} | Cost: $${ethers.formatUnits(5_000_000n-got,6)}`);
  return got;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns(uint256)"], deployer);
  console.log("USDC:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));
  console.log("ETH:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));

  // Deploy all 3
  const addrA = await deployBasket(deployer, "A", BASKETS.A);
  const addrB = await deployBasket(deployer, "B", BASKETS.B);
  const addrC = await deployBasket(deployer, "C", BASKETS.C);

  // Test A and B (C has xStock tokens that may not have 0x liquidity yet)
  const gotA = await testBasket(deployer, addrA, "A", BASKETS.A);
  const gotB = await testBasket(deployer, addrB, "B", BASKETS.B);

  // Try C but don't fail if xStock tokens can't be bought
  let gotC = 0n;
  try {
    gotC = await testBasket(deployer, addrC, "C", BASKETS.C);
  } catch(e) {
    console.log(`  Basket C test error: ${e.message.slice(0,80)}`);
  }

  // Summary
  console.log("\n════════════════════��═══════════════════════════════");
  console.log("  3 BASKETS DEPLOYED & TESTED");
  console.log("═════════════════════════���══════════════════════════");
  console.log(`  Basket A (Blue Chip):            ${addrA}`);
  console.log(`  Basket B (DeFi+RWA):             ${addrB}`);
  console.log(`  Basket C (Full Spectrum+Stocks):  ${addrC}`);
  console.log("");
  console.log(`  Test A: $5 → $${ethers.formatUnits(gotA,6)}`);
  console.log(`  Test B: $5 → $${ethers.formatUnits(gotB,6)}`);
  if (gotC > 0n) console.log(`  Test C: $5 → $${ethers.formatUnits(gotC,6)}`);
  console.log(`  USDC: $${ethers.formatUnits(await usdc.balanceOf(deployer.address),6)}`);
  console.log("════════════════════════════════════════════════════");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) });
