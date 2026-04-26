const { ethers } = require("hardhat");
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SDM  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const OX_HOLDER = "0x0000000000001ff3684f28c67538d4d072c22734";
const OX_API = "https://api.0x.org";
const OX_KEY = "cdfabb51-56f8-470c-a9a9-470731443332";
async function q(sell,buy,amt,taker){const r=await fetch(`${OX_API}/swap/allowance-holder/quote?chainId=42161&sellToken=${sell}&buyToken=${buy}&sellAmount=${amt}&taker=${taker}`,{headers:{"0x-api-key":OX_KEY,"0x-version":"v2"}});if(!r.ok)throw new Error(await r.text());return r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const[deployer]=await ethers.getSigners();
  const usdc=new ethers.Contract(USDC,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
  console.log("USDC:",ethers.formatUnits(await usdc.balanceOf(deployer.address),6));

  // Rescue from old vault
  for(const old of ["0x9809f6A1Ce2B9A026179f7f8deccf46341a62c0e","0x088985afb5af4219336177F7B4A461af9f0CD725"]){
    const v=await ethers.getContractAt("ShadowBasketVault",old);
    try{
      const bal=await usdc.balanceOf(old);
      if(bal>0n){await(await v.rescueToken(USDC,bal)).wait();console.log("Rescued",ethers.formatUnits(bal,6),"from",old);}
      // Rescue other tokens too
      for(const t of["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1","0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f","0x912CE59144191C1204E64559FE8253a0e49E6548","0xf97f4df75117a78c1A5a0DBb814Af92458539FB4"]){
        const tok=new ethers.Contract(t,["function balanceOf(address) view returns(uint256)"],deployer);
        const b=await tok.balanceOf(old);
        if(b>0n){await(await v.rescueToken(t,b)).wait();console.log("  Rescued token from",old);}
      }
    }catch(e){console.log("Rescue",old,":",e.message.slice(0,60));}
  }

  // Sell any non-USDC tokens in deployer wallet
  const SWAP_ROUTER="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
  const rAbi=["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) external payable returns(uint256)"];
  const router=new ethers.Contract(SWAP_ROUTER,rAbi,deployer);
  for(const t of["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1","0x912CE59144191C1204E64559FE8253a0e49E6548","0xf97f4df75117a78c1A5a0DBb814Af92458539FB4"]){
    const tok=new ethers.Contract(t,["function balanceOf(address) view returns(uint256)","function approve(address,uint256) returns(bool)"],deployer);
    const b=await tok.balanceOf(deployer.address);
    if(b>0n){
      await(await tok.approve(SWAP_ROUTER,b)).wait();
      try{await(await router.exactInputSingle([t,USDC,3000,deployer.address,b,0,0],{gasLimit:500000})).wait();console.log("Sold token →USDC");}catch{}
    }
  }

  console.log("\nUSDC after rescue:",ethers.formatUnits(await usdc.balanceOf(deployer.address),6));

  // Deploy fresh
  console.log("\nDeploying fresh vault...");
  const vault=await(await ethers.getContractFactory("ShadowBasketVault")).deploy(deployer.address,SDM);
  await vault.waitForDeployment();
  const VAULT=await vault.getAddress();
  console.log("Vault:",VAULT);

  await(await vault.setKeeper(deployer.address)).wait();
  const basket=[
    {n:"WETH",t:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",w:3000,f:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",fd:8,td:18},
    {n:"WBTC",t:"0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",w:2000,f:"0xd0C7101eACbB49F3deCcCc166d238410D6D46d57",fd:8,td:8},
    {n:"ARB",t:"0x912CE59144191C1204E64559FE8253a0e49E6548",w:1500,f:"0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6",fd:8,td:18},
    {n:"LINK",t:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",w:1500,f:"0x86E53CF1B870786351Da77A57575e79CB55812CB",fd:8,td:18},
    {n:"USDC",t:USDC,w:2000,f:"0x0000000000000000000000000000000000000000",fd:0,td:6},
  ];
  for(const b of basket){await(await vault.addBasketToken(b.t,b.w,b.f,b.fd,b.td)).wait();}
  console.log("Basket ✓");

  // Approve 0x
  await(await vault.approveSwapTarget(USDC,OX_HOLDER,ethers.MaxUint256)).wait();
  for(const b of basket.filter(x=>x.t!==USDC)){await(await vault.approveSwapTarget(b.t,OX_HOLDER,ethers.MaxUint256)).wait();}
  console.log("0x approved ✓");

  // Deposit $5 FLEX
  console.log("\n── DEPOSIT $5 FLEX ──");
  await(await usdc.approve(VAULT,ethers.MaxUint256)).wait();
  await(await vault.deposit(5_000_000n,0,{gasLimit:1_000_000})).wait();
  console.log("✓ Deposited");

  // Buy basket tokens (skip WBTC too small)
  console.log("\n── KEEPER BUY ──");
  const buys=[{n:"WETH",t:"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",u:1_050_000n},{n:"ARB",t:"0x912CE59144191C1204E64559FE8253a0e49E6548",u:525_000n},{n:"LINK",t:"0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",u:525_000n}];
  for(const b of buys){
    try{const r=await q(USDC,b.t,b.u.toString(),VAULT);await(await vault.executeBuyBasket(b.t,b.u,r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${b.n} ✓`);}
    catch(e){console.log(`  ${b.n} ✗ ${e.message.slice(0,60)}`);}
  }
  console.log("Basket value: $"+ethers.formatUnits(await vault.totalBasketValue(),6));

  // Wait
  await sleep(2000);

  // Request withdraw
  console.log("\n── REQUEST WITHDRAW ──");
  await(await vault.requestWithdraw(1,{gasLimit:500_000})).wait();
  console.log("✓ Requested");
  const pw=await vault.pendingWithdraws(1);
  console.log("  yieldUSDC:",ethers.formatUnits(pw.yieldUSDC,6),"basketUSDC:",ethers.formatUnits(pw.basketUSDC,6));

  // Sell tokens
  console.log("\n── KEEPER SELL ──");
  const pos=await vault.positions(1);
  const shares=await vault.getShareTokenAmounts(pos.wsdmAmount);
  for(let i=0;i<shares.tokens.length;i++){
    if(shares.tokens[i].toLowerCase()===USDC.toLowerCase())continue;
    if(shares.amounts[i]==0n)continue;
    const tok=new ethers.Contract(shares.tokens[i],["function symbol() view returns(string)"],deployer);
    const sym=await tok.symbol();
    try{const r=await q(shares.tokens[i],USDC,shares.amounts[i].toString(),VAULT);await(await vault.executeWithdrawalSwap(1,shares.tokens[i],shares.amounts[i],r.transaction.to,r.transaction.data,{gasLimit:BigInt(r.transaction.gas)*2n})).wait();console.log(`  ${sym} ✓`);}
    catch(e){console.log(`  ${sym} ✗ ${e.message.slice(0,60)}`);}
  }
  const pw2=await vault.pendingWithdraws(1);
  console.log("  Gathered:",ethers.formatUnits(pw2.usdcGathered,6));

  // Complete
  console.log("\n── COMPLETE WITHDRAW ──");
  const b0=await usdc.balanceOf(deployer.address);
  await(await vault.completeWithdraw(1,{gasLimit:500_000})).wait();
  const b1=await usdc.balanceOf(deployer.address);
  const got=b1-b0;

  console.log("\n════════════════════════════════════════");
  console.log("  ShadowBasketVault:",VAULT);
  console.log("  Deposited:  $5.00");
  console.log("  Received:   $"+ethers.formatUnits(got,6));
  console.log("  Cost:       $"+ethers.formatUnits(5_000_000n-got,6),"(fee+slippage)");
  console.log("  USDC final: $"+ethers.formatUnits(b1,6));
  console.log("════════════════════════════════════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
