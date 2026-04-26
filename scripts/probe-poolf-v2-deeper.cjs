const { ethers } = require("ethers");
require("dotenv").config({ path: "/home/di0zchain/ShadowVaultV15/.env.pool-e" });

const POOL_F = "0x3F4396417f142fD406215E8437C448Cb28bf7552";
const NAVOR  = "0x61801bC99d1A8CBb80EBE2b4171c1C6dC1B684f8";
const YIELD_ON_CHAIN = "0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9";

const NAV_ABI = [
  "function getNavLenient(uint64) view returns (uint256 navUsd6, uint64 at, bool stale, bool frozen)",
];
const VAULT_ABI = [
  "function basketId() view returns (uint64)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
];
const YIELD_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  console.log("signer:", wallet.address);

  const v = new ethers.Contract(POOL_F, VAULT_ABI, provider);
  const bid = await v.basketId();
  console.log("basketId:", bid.toString());

  const adminRole = await v.DEFAULT_ADMIN_ROLE();
  const isAdmin = await v.hasRole(adminRole, wallet.address);
  console.log("deployer is DEFAULT_ADMIN:", isAdmin);

  const nav = new ethers.Contract(NAVOR, NAV_ABI, provider);
  const [navUsd6, at, stale, frozen] = await nav.getNavLenient(bid);
  console.log("nav.getNavLenient =>", { nav: navUsd6.toString(), at: at.toString(), stale, frozen });

  const code = await provider.getCode(YIELD_ON_CHAIN);
  console.log("yieldAdapter on-chain code length:", code.length);
  if (code.length > 2) {
    const y = new ethers.Contract(YIELD_ON_CHAIN, YIELD_ABI, provider);
    try { console.log("yieldAdapter.totalAssets:", (await y.totalAssets()).toString()); } catch (e) { console.log("totalAssets err:", e.shortMessage || e.message); }
    try { console.log("yieldAdapter.totalPrincipal:", (await y.totalPrincipal()).toString()); } catch (e) { console.log("totalPrincipal err:", e.shortMessage || e.message); }
  }
})().catch(e => { console.error(e); process.exit(1); });
