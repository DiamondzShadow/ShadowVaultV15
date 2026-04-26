const { ethers } = require("ethers");
require("dotenv").config({ path: "/home/di0zchain/ShadowVaultV15/.env.pool-e" });

const POOL_F = "0x3F4396417f142fD406215E8437C448Cb28bf7552";
const USDC   = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const BASKET = "0x39D10E5823E4472070413070E8a51bc75F0bd0D0";
const YIELD  = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const NAVOR  = "0x61801bC99d1A8CBb80EBE2b4171c1C6dC1B684f8";

const ABI = [
  "function whitelistEnabled() view returns (bool)",
  "function paused() view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function maxTotalAssets() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function basketAdapter() view returns (address)",
  "function yieldAdapter() view returns (address)",
  "function navOracle() view returns (address)",
  "function asset() view returns (address)",
  "function usdc() view returns (address)",
  "function nft() view returns (address)",
  "function shadowPass() view returns (address)",
  "function basketReceipt() view returns (address)",
  "function yieldReceipt() view returns (address)",
  "function basketBps() view returns (uint16)",
  "function yieldBps() view returns (uint16)",
  "function allocation() view returns (uint16,uint16)",
  "function feeBps() view returns (uint16)",
  "function depositFeeBps() view returns (uint16)",
  "function withdrawFeeBps() view returns (uint16)",
  "function performanceFeeBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function nextTokenId() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const block = await provider.getBlockNumber();
  console.log("block:", block);
  const c = new ethers.Contract(POOL_F, ABI, provider);
  const tries = [
    "whitelistEnabled","paused","totalAssets","maxTotalAssets","depositCap","minDeposit",
    "basketAdapter","yieldAdapter","navOracle","asset","usdc","nft","shadowPass",
    "basketReceipt","yieldReceipt","basketBps","yieldBps","allocation","feeBps",
    "depositFeeBps","withdrawFeeBps","performanceFeeBps","treasury","nextTokenId","totalSupply",
  ];
  for (const k of tries) {
    try {
      const v = await c[k]();
      console.log(k.padEnd(22), Array.isArray(v) ? v.map(String).join(",") : v.toString());
    } catch (e) {
      console.log(k.padEnd(22), "—");
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
