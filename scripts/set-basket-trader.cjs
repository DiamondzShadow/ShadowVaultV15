const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const ADAPTER = process.env.BASKET_ADAPTER_ADDR;
const TRADER  = process.env.TRADER_HC_ADDR;

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  const adapter = new ethers.Contract(ADAPTER, [
    "function setTrader(address)",
    "function trader() view returns (address)",
  ], w);

  console.log("Adapter:", ADAPTER);
  console.log("Setting trader =", TRADER);
  console.log("Current trader:", await adapter.trader());

  const tx = await adapter.setTrader(TRADER);
  await tx.wait();
  console.log("tx:", tx.hash);
  console.log("Confirmed trader:", await adapter.trader());
})().catch(e => { console.error(e); process.exit(1); });
