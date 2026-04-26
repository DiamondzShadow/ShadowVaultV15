const { ethers } = require("hardhat");
const VAULT = "0x7f118Bc3e330034d58704E3131cBf8c3Eec3D61F";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";
async function q(sell,buy,amt){const r=await fetch(`${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sell}&buyToken=${buy}&sellAmount=${amt}&taker=${VAULT}`,{headers:{"0x-api-key":OX_KEY,"0x-version":"v2"}});if(!r.ok)throw new Error(await r.text());return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const[deployer]=await ethers.getSigners();
  const vault=await ethers.getContractAt("ShadowBasketVault",VAULT);
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
  const b0=await usdc.balanceOf(deployer.address);
  console.log("USDC:",ethers.formatUnits(b0,6));

  // Deposit $5 FLEX
  console.log("\n── DEPOSIT $5 FLEX ──");
  await(await usdc.approve(VAULT,ethers.MaxUint256)).wait();
  await(await vault.deposit(5_000_000n,0,{gasLimit:1_000_000})).wait();
  console.log("✓");

  // Keeper buy
  console.log("\n── KEEPER BUY ──");
  const buys=[
    {n:"WETH",t:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",u:1_050_000n},
    {n:"ARB",t:"0x912CE59144191C1204E64559FE8253a0e49E6548",u:525_000n},
    {n:"LINK",t:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",u:525_000n},
  ];
  for(const b of buys){
    try{const r=await q(USDC,b.t,b.u.toString());await(await vault.executeBuyBasket(b.t,b.u,r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${b.n} ✓`);}
    catch(e){console.log(`  ${b.n} ✗ ${e.message.slice(0,60)}`);}
  }

  // Position value
  const posId=2;
  const pv=await vault.estimatePositionValue(posId);
  console.log("  Position value: $"+ethers.formatUnits(pv.total,6));

  await sleep(2000);

  // Withdraw
  console.log("\n── WITHDRAW ──");
  await(await vault.requestWithdraw(posId,{gasLimit:500_000})).wait();
  const pw=await vault.pendingWithdraws(posId);
  console.log("  yield:",ethers.formatUnits(pw.yieldUSDC,6),"basket:",ethers.formatUnits(pw.basketUSDC,6));

  const pos=await vault.positions(posId);
  const shares=await vault.getShareTokenAmounts(pos.wsdmAmount);
  for(let i=0;i<shares.tokens.length;i++){
    if(shares.tokens[i].toLowerCase()===USDC.toLowerCase()||shares.amounts[i]==0n)continue;
    const tok=new ethers.Contract(shares.tokens[i],["function symbol() view returns(string)"],deployer);
    const sym=await tok.symbol();
    try{const r=await q(shares.tokens[i],USDC,shares.amounts[i].toString());await(await vault.executeWithdrawalSwap(posId,shares.tokens[i],shares.amounts[i],r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${sym} sold ✓`);}
    catch(e){console.log(`  ${sym} ✗ ${e.message.slice(0,60)}`);}
  }

  const bBefore=await usdc.balanceOf(deployer.address);
  await(await vault.completeWithdraw(posId,{gasLimit:500_000})).wait();
  const bAfter=await usdc.balanceOf(deployer.address);
  const got=bAfter-bBefore;

  console.log("\n════════════════════════════");
  console.log("  Deposited: $5.00");
  console.log("  Received:  $"+ethers.formatUnits(got,6));
  console.log("  Cost:      $"+ethers.formatUnits(5_000_000n-got,6));
  console.log("  USDC:      $"+ethers.formatUnits(bAfter,6));
  console.log("════════════════════════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
