const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });

const RPC = process.env.HYPEREVM_RPC;
const PK  = process.env.DEPLOYER_KEY;
const POOL_E = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const POOL_F = "0xe442CFF139B6339f7468240b4119E7b2B7841772";

const ABI = [
  "function whitelistEnabled() view returns (bool)",
  "function whitelisted(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log("deployer:", wallet.address);
  console.log("hyper block:", await provider.getBlockNumber());

  for (const [name, addr] of [["Pool E", POOL_E], ["Pool F", POOL_F]]) {
    const c = new ethers.Contract(addr, ABI, provider);
    const code = (await provider.getCode(addr)).length;
    if (code <= 2) { console.log(`${name} ${addr} — NO CODE`); continue; }
    const [wEnabled, wDeployer, adminRole] = await Promise.all([
      c.whitelistEnabled(),
      c.whitelisted(wallet.address),
      c.DEFAULT_ADMIN_ROLE(),
    ]);
    const isAdmin = await c.hasRole(adminRole, wallet.address);
    console.log(`${name} ${addr}`);
    console.log(`  whitelistEnabled = ${wEnabled}`);
    console.log(`  whitelisted[deployer] = ${wDeployer}`);
    console.log(`  deployer is DEFAULT_ADMIN = ${isAdmin}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
