const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("ETH:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));

  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const SDM  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
  const OX   = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
  const TREASURY = deployer.address;

  // ─── 1. Deploy ───
  console.log("\n1. Deploying ShadowBasketVault...");
  const Factory = await ethers.getContractFactory("ShadowBasketVault");
  const vault = await Factory.deploy(TREASURY, SDM);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();
  console.log("   Vault:", addr);

  // ─── 2. Set keeper ───
  console.log("\n2. Setting keeper...");
  await (await vault.setKeeper(deployer.address)).wait();
  console.log("   Keeper:", deployer.address);

  // ─── 3. Add basket tokens ───
  console.log("\n3. Adding basket tokens...");

  const tokens = [
    { name: "WETH", token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", weight: 3000, feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", fdec: 8, tdec: 18 },
    { name: "WBTC", token: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", weight: 2000, feed: "0xd0C7101eACbB49F3deCcCc166d238410D6D46d57", fdec: 8, tdec: 8 },
    { name: "ARB",  token: "0x912CE59144191C1204E64559FE8253a0e49E6548", weight: 1500, feed: "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6", fdec: 8, tdec: 18 },
    { name: "LINK", token: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", weight: 1500, feed: "0x86E53CF1B870786351Da77A57575e79CB55812CB", fdec: 8, tdec: 18 },
    { name: "USDC", token: USDC, weight: 2000, feed: "0x0000000000000000000000000000000000000000", fdec: 0, tdec: 6 },
  ];

  for (const t of tokens) {
    await (await vault.addBasketToken(t.token, t.weight, t.feed, t.fdec, t.tdec)).wait();
    console.log(`   ${t.name}: ${t.weight} bps`);
  }

  // ─── 4. Verify basket weights sum ───
  const len = await vault.basketLength();
  let weightSum = 0;
  for (let i = 0; i < Number(len); i++) {
    const tc = await vault.basketTokens(i);
    weightSum += Number(tc.targetWeightBps);
  }
  console.log("   Weight sum:", weightSum, weightSum === 10000 ? "✓" : "✗");

  // ─── 5. Test Chainlink feeds ───
  console.log("\n4. Testing Chainlink feeds...");
  for (let i = 0; i < tokens.length - 1; i++) {
    const feed = new ethers.Contract(tokens[i].feed, [
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
      "function decimals() view returns (uint8)",
    ], deployer);
    const [, price,,,] = await feed.latestRoundData();
    const dec = await feed.decimals();
    console.log(`   ${tokens[i].name}: $${ethers.formatUnits(price, dec)}`);
  }

  // ─── 6. Test deposit $5 FLEX ───
  console.log("\n5. Test deposit $5 FLEX...");
  const usdc = new ethers.Contract(USDC, [
    "function approve(address,uint256) returns(bool)",
    "function balanceOf(address) view returns(uint256)",
  ], deployer);

  const balBefore = await usdc.balanceOf(deployer.address);
  console.log("   USDC before:", ethers.formatUnits(balBefore, 6));

  await (await usdc.approve(addr, ethers.MaxUint256)).wait();
  const tx = await vault.deposit(5_000_000n, 0, { gasLimit: 1_000_000 }); // tier 0 = FLEX
  const r = await tx.wait();
  console.log("   ✓ Deposit OK | Gas:", r.gasUsed.toString());

  const pos = await vault.positions(1);
  console.log("   Pos 1: deposit=", ethers.formatUnits(pos.depositAmount, 6),
    "wsdm=", pos.wsdmAmount.toString(),
    "aave=", pos.aaveShare.toString(),
    "tier=", pos.tier.toString());

  // Check vault state
  const basketVal = await vault.totalBasketValue();
  const aaveAssets = await vault.aaveTotalAssets();
  console.log("   Basket value:", ethers.formatUnits(basketVal, 6), "USDC (pending buy)");
  console.log("   Aave assets:", ethers.formatUnits(aaveAssets, 6), "USDC");
  console.log("   USDC in vault:", ethers.formatUnits(await usdc.balanceOf(addr), 6), "(pending basket buy)");

  // ─── Summary ───
  console.log("\n════════════════════════════════════════════");
  console.log("  ShadowBasketVault:", addr);
  console.log("  Keeper:", deployer.address);
  console.log("  Treasury:", TREASURY);
  console.log("  SDM:", SDM);
  console.log("  Basket: WETH(30%) WBTC(20%) ARB(15%) LINK(15%) USDC(20%)");
  console.log("  Allocation: 70% basket / 30% Aave");
  console.log("  Deposit $5 ✓ — run keeper to buy basket tokens");
  console.log("════════════════════════════════════════════");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
