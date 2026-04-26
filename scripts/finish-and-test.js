const { ethers } = require("hardhat");
const USDC="0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const OX="0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API="https://api.0x.org";
const OX_KEY="cdfabb51-56f8-470c-a9a9-470731443332";
async function q(sell,buy,amt,taker){const r=await fetch(`${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sell}&buyToken=${buy}&sellAmount=${amt}&taker=${taker}`,{headers:{"0x-api-key":OX_KEY,"0x-version":"v2"}});if(!r.ok)throw new Error(`0x ${r.status}`);return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const ADDR_A="0xdb490619D0420d47E82A025BE4054e1274d77A3e";
const ADDR_B="0x5e46252746eD6Cf0A77f20B45daB4d110270657C";
const ADDR_C="0x2c443D426471Cce721bf95d8921dAa4043c83c76";

const TK={
  WETH:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",WBTC:"0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  ARB:"0x912CE59144191C1204E64559FE8253a0e49E6548",LINK:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  GMX:"0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",PENDLE:"0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
  PEPE:"0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",XAUt0:"0x40461291347e1eCbb09499F3371D3f17f10d7159",
};

async function test(deployer,addr,name,nonUsdcSyms){
  console.log(`\n══ Test ${name} ══`);
  const v=await ethers.getContractAt("ShadowBasketVault",addr);
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
  await(await usdc.approve(addr,ethers.MaxUint256)).wait();
  await(await v.deposit(5_000_000n,0,{gasLimit:1_000_000})).wait();
  console.log("  Deposit $5 ✓");

  // Buy non-USDC tokens proportionally
  const pending=await usdc.balanceOf(addr);
  const perToken=pending/BigInt(nonUsdcSyms.length+1); // rough equal split for simplicity
  for(const sym of nonUsdcSyms){
    const alloc=perToken>500_000n?perToken:0n;
    if(alloc==0n){console.log(`  ${sym} skip`);continue;}
    try{
      const r=await q(USDC,TK[sym],alloc.toString(),addr);
      await(await v.executeBuyBasket(TK[sym],alloc,r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();
      console.log(`  ${sym} buy ✓`);
    }catch(e){console.log(`  ${sym} buy ✗ ${e.message.slice(0,50)}`);}
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
  console.log(`  $5.00 → $${ethers.formatUnits(got,6)} (cost $${ethers.formatUnits(5_000_000n-got,6)})`);
  return got;
}

async function main(){
  const[deployer]=await ethers.getSigners();
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)"],deployer);
  console.log("USDC:",ethers.formatUnits(await usdc.balanceOf(deployer.address),6));

  // Finish C approvals
  console.log("Finishing Basket C approvals...");
  const vc=await ethers.getContractAt("ShadowBasketVault",ADDR_C);
  for(const t of[USDC,TK.WETH,TK.WBTC,TK.PEPE,TK.ARB,TK.GMX,TK.LINK]){
    try{await(await vc.approveSwapTarget(t,OX,ethers.MaxUint256)).wait();}catch{}
  }
  console.log("Done ✓");

  // Test all 3
  const gotA=await test(deployer,ADDR_A,"A: Blue Chip",["WETH"]);
  const gotB=await test(deployer,ADDR_B,"B: DeFi+RWA",["WETH","GMX","PENDLE","XAUt0","LINK"]);
  const gotC=await test(deployer,ADDR_C,"C: Full Spectrum",["WETH","PEPE","ARB","GMX","LINK"]);

  console.log("\n══════════════════════════════════════════════");
  console.log("  ALL 3 BASKETS — RESULTS");
  console.log("══════════════════════════════════════════════");
  console.log(`  A: ${ADDR_A}  $5→$${ethers.formatUnits(gotA,6)}`);
  console.log(`  B: ${ADDR_B}  $5→$${ethers.formatUnits(gotB,6)}`);
  console.log(`  C: ${ADDR_C}  $5→$${ethers.formatUnits(gotC,6)}`);
  console.log(`  USDC: $${ethers.formatUnits(await usdc.balanceOf(deployer.address),6)}`);
  console.log("══════════════════════════════════════════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
