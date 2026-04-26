const { ethers } = require("hardhat");
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SDM  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const OX   = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";
const ADDR_A = "0xdb490619D0420d47E82A025BE4054e1274d77A3e";
async function q(sell,buy,amt,taker){const r=await fetch(`${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sell}&buyToken=${buy}&sellAmount=${amt}&taker=${taker}`,{headers:{"0x-api-key":OX_KEY,"0x-version":"v2"}});if(!r.ok)throw new Error(`0x ${r.status}`);return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const TOKENS={
  WETH:{addr:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",dec:18},
  WBTC:{addr:"0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",dec:8},
  ARB:{addr:"0x912CE59144191C1204E64559FE8253a0e49E6548",dec:18},
  LINK:{addr:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",dec:18},
  GMX:{addr:"0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",dec:18},
  PENDLE:{addr:"0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",dec:18},
  PEPE:{addr:"0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",dec:18},
  XAUt0:{addr:"0x40461291347e1eCbb09499F3371D3f17f10d7159",dec:6},
  USDC:{addr:USDC,dec:6},
};

const BASKET_B = [
  {sym:"WETH",  w:2000,feed:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",fd:8},
  {sym:"GMX",   w:2000,feed:"0xDB98056FecFff59D032aB628337A4887110df3dB",fd:8},
  {sym:"PENDLE",w:1500,feed:"0x66853E19D73C0F9301Fe229c5886C62db2D1E144",fd:8},
  {sym:"XAUt0", w:1500,feed:"0x3ec8593F930EA45ea58c968260e6e9FF53FC934f",fd:8},
  {sym:"LINK",  w:1500,feed:"0x86E53CF1B870786351Da77A57575e79CB55812CB",fd:8},
  {sym:"USDC",  w:1500,feed:"0x0000000000000000000000000000000000000000",fd:0},
];
const BASKET_C = [
  {sym:"WETH",  w:1500,feed:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",fd:8},
  {sym:"WBTC",  w:1000,feed:"0xd0C7101eACbB49F3deCcCc166d238410D6D46d57",fd:8},
  {sym:"PEPE",  w:1500,feed:"0x02DEd5a7EDDA750E3Eb240b54437a54d57b74dBE",fd:8},
  {sym:"ARB",   w:1500,feed:"0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",fd:8},
  {sym:"GMX",   w:1500,feed:"0xDB98056FecFff59D032aB628337A4887110df3dB",fd:8},
  {sym:"LINK",  w:1000,feed:"0x86E53CF1B870786351Da77A57575e79CB55812CB",fd:8},
  {sym:"USDC",  w:2000,feed:"0x0000000000000000000000000000000000000000",fd:0},
];

async function deploy(deployer, name, basket) {
  console.log(`\n══ Basket ${name} ══`);
  const v = await (await ethers.getContractFactory("ShadowBasketVault")).deploy(deployer.address, SDM);
  await v.waitForDeployment();
  const addr = await v.getAddress();
  console.log("  Vault:", addr);
  await(await v.setKeeper(deployer.address)).wait();
  for(const t of basket){
    await(await v.addBasketToken(TOKENS[t.sym].addr,t.w,t.feed,t.fd,TOKENS[t.sym].dec)).wait();
    console.log(`  ${t.sym} ${t.w}`);
  }
  await(await v.approveSwapTarget(USDC,OX,ethers.MaxUint256)).wait();
  for(const t of basket.filter(x=>x.sym!=="USDC")){
    await(await v.approveSwapTarget(TOKENS[t.sym].addr,OX,ethers.MaxUint256)).wait();
  }
  console.log("  Ready ✓");
  return addr;
}

async function test(deployer, addr, name, basket) {
  console.log(`\n── Test ${name} ──`);
  const v=await ethers.getContractAt("ShadowBasketVault",addr);
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
  await(await usdc.approve(addr,ethers.MaxUint256)).wait();
  await(await v.deposit(5_000_000n,0,{gasLimit:1_000_000})).wait();
  console.log("  Deposit ✓");

  // Buy
  const nonUsdc=basket.filter(t=>t.sym!=="USDC");
  const nw=nonUsdc.reduce((s,t)=>s+t.w,0);
  const uw=basket.find(t=>t.sym==="USDC")?.w||0;
  const pending=await usdc.balanceOf(addr);
  const spend=(pending*BigInt(nw))/BigInt(nw+uw);
  for(const t of nonUsdc){
    const alloc=(spend*BigInt(t.w))/BigInt(nw);
    if(alloc<500_000n){console.log(`  ${t.sym} skip ($${ethers.formatUnits(alloc,6)})`);continue;}
    try{const r=await q(USDC,TOKENS[t.sym].addr,alloc.toString(),addr);await(await v.executeBuyBasket(TOKENS[t.sym].addr,alloc,r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${t.sym} ✓`);}
    catch(e){console.log(`  ${t.sym} ✗ ${e.message.slice(0,50)}`);}
  }
  await sleep(2000);

  // Withdraw
  const posId=Number(await v.nextPosId())-1;
  await(await v.requestWithdraw(posId,{gasLimit:500_000})).wait();
  const pos=await v.positions(posId);
  const shares=await v.getShareTokenAmounts(pos.wsdmAmount);
  for(let i=0;i<shares.tokens.length;i++){
    if(shares.tokens[i].toLowerCase()===USDC.toLowerCase()||shares.amounts[i]==0n)continue;
    try{const r=await q(shares.tokens[i],USDC,shares.amounts[i].toString(),addr);await(await v.executeWithdrawalSwap(posId,shares.tokens[i],shares.amounts[i],r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();}catch{}
  }
  const b0=await usdc.balanceOf(deployer.address);
  await(await v.completeWithdraw(posId,{gasLimit:500_000})).wait();
  const b1=await usdc.balanceOf(deployer.address);
  const got=b1-b0;
  console.log(`  $5 → $${ethers.formatUnits(got,6)} (cost $${ethers.formatUnits(5_000_000n-got,6)})`);
  return got;
}

async function main(){
  const[deployer]=await ethers.getSigners();
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)"],deployer);
  console.log("USDC:",ethers.formatUnits(await usdc.balanceOf(deployer.address),6));

  // Deploy B and C (A already at ADDR_A)
  const addrB=await deploy(deployer,"B (DeFi+RWA)",BASKET_B);
  const addrC=await deploy(deployer,"C (Full Spectrum)",BASKET_C);

  // Test A
  const gotA=await test(deployer,ADDR_A,"A (Blue Chip)",[
    {sym:"WETH",w:4500},{sym:"WBTC",w:3500},{sym:"USDC",w:2000}
  ]);
  const gotB=await test(deployer,addrB,"B (DeFi+RWA)",BASKET_B);
  const gotC=await test(deployer,addrC,"C (Full Spectrum)",BASKET_C);

  console.log("\n══════════════════════════════════════════════");
  console.log("  ALL 3 BASKETS DEPLOYED & TESTED");
  console.log("══════════════════════════════════════════════");
  console.log(`  A (Blue Chip):      ${ADDR_A}  $5→$${ethers.formatUnits(gotA,6)}`);
  console.log(`  B (DeFi+RWA):       ${addrB}  $5→$${ethers.formatUnits(gotB,6)}`);
  console.log(`  C (Full Spectrum):  ${addrC}  $5→$${ethers.formatUnits(gotC,6)}`);
  console.log(`  USDC: $${ethers.formatUnits(await usdc.balanceOf(deployer.address),6)}`);
  console.log("══════════════════════════════════════════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
