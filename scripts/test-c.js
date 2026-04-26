const { ethers } = require("hardhat");
const USDC="0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ADDR_C="0x2c443D426471Cce721bf95d8921dAa4043c83c76";
const OX_API="https://api.0x.org";const OX_KEY="cdfabb51-56f8-470c-a9a9-470731443332";
async function q(sell,buy,amt,taker){const r=await fetch(`${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sell}&buyToken=${buy}&sellAmount=${amt}&taker=${taker}`,{headers:{"0x-api-key":OX_KEY,"0x-version":"v2"}});if(!r.ok)throw new Error(`0x ${r.status}`);return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const TK={WETH:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",WBTC:"0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",ARB:"0x912CE59144191C1204E64559FE8253a0e49E6548",LINK:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",GMX:"0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",PEPE:"0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00"};
async function main(){
  const[deployer]=await ethers.getSigners();
  const v=await ethers.getContractAt("ShadowBasketVault",ADDR_C);
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
  console.log("USDC:",ethers.formatUnits(await usdc.balanceOf(deployer.address),6));

  console.log("\n══ Test C: Full Spectrum ══");
  await(await usdc.approve(ADDR_C,ethers.MaxUint256)).wait();
  await(await v.deposit(5_000_000n,0,{gasLimit:1_000_000})).wait();
  console.log("  Deposit $5 ✓");

  const syms=["WETH","PEPE","ARB","GMX","LINK"];
  const pending=await usdc.balanceOf(ADDR_C);
  const perToken=pending/BigInt(syms.length+1);
  for(const sym of syms){
    if(perToken<500_000n){console.log(`  ${sym} skip`);continue;}
    try{const r=await q(USDC,TK[sym],perToken.toString(),ADDR_C);await(await v.executeBuyBasket(TK[sym],perToken,r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${sym} ✓`);}
    catch(e){console.log(`  ${sym} ✗ ${e.message.slice(0,50)}`);}
  }
  await sleep(2000);

  const posId=Number(await v.nextPosId())-1;
  await(await v.requestWithdraw(posId,{gasLimit:500_000})).wait();
  const pos=await v.positions(posId);
  const shares=await v.getShareTokenAmounts(pos.wsdmAmount);
  for(let i=0;i<shares.tokens.length;i++){
    if(shares.tokens[i].toLowerCase()===USDC.toLowerCase()||shares.amounts[i]==0n)continue;
    try{const r=await q(shares.tokens[i],USDC,shares.amounts[i].toString(),ADDR_C);await(await v.executeWithdrawalSwap(posId,shares.tokens[i],shares.amounts[i],r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();}catch{}
  }
  const b0=await usdc.balanceOf(deployer.address);
  await(await v.completeWithdraw(posId,{gasLimit:500_000})).wait();
  const b1=await usdc.balanceOf(deployer.address);
  const got=b1-b0;
  console.log(`  $5.00 → $${ethers.formatUnits(got,6)} (cost $${ethers.formatUnits(5_000_000n-got,6)})`);

  console.log("\n══════════════════════════════════════════════");
  console.log("  ALL 3 BASKETS");
  console.log("══════════════════════════════════════════════");
  console.log("  A: 0xdb490619D0420d47E82A025BE4054e1274d77A3e  $5→$4.997");
  console.log("  B: 0x5e46252746eD6Cf0A77f20B45daB4d110270657C  $5→$4.985");
  console.log(`  C: ${ADDR_C}  $5→$${ethers.formatUnits(got,6)}`);
  console.log(`  USDC: $${ethers.formatUnits(b1,6)}`);
  console.log("══════════════════════════════════════════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
