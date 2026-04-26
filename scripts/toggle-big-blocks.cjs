const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

(async () => {
  const useBig = process.argv[2] !== "off";
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY);
  const transport = new hl.HttpTransport();
  const client = new hl.ExchangeClient({ wallet, transport });
  console.log(`Toggling usingBigBlocks=${useBig} for ${wallet.address}`);
  const res = await client.evmUserModify({ usingBigBlocks: useBig });
  console.log(JSON.stringify(res, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
