const hre = require("hardhat");

const POOL_F_VAULT   = "0xe442CFF139B6339f7468240b4119E7b2B7841772";
const BASKET_ADAPTER = "0x39D10E5823E4472070413070E8a51bc75F0bd0D0";
const NAV_ORACLE     = "0x61801bC99d1A8CBb80EBE2b4171c1C6dC1B684f8";
const USDC_HC        = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const DEPLOYER       = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

async function main() {
  const vault = new hre.ethers.Contract(POOL_F_VAULT, [
    "function minDeposit() view returns (uint256)",
    "function maxDeposit() view returns (uint256)",
    "function whitelistEnabled() view returns (bool)",
    "function whitelisted(address) view returns (bool)",
    "function paused() view returns (bool)",
    "function yieldBps() view returns (uint256)",
    "function basketBps() view returns (uint256)",
    "function yieldReceipt() view returns (address)",
    "function basketReceipt() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function basketId() view returns (uint64)",
  ], hre.ethers.provider);

  const oracle = new hre.ethers.Contract(NAV_ORACLE, [
    "function getNav(uint64) view returns (uint256 navUsd6, uint64 at)",
    "function getNavLenient(uint64) view returns (uint256 navUsd6, uint64 at, bool stale)",
  ], hre.ethers.provider);

  const usdc = new hre.ethers.Contract(USDC_HC, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ], hre.ethers.provider);

  console.log("═══ Pool F deposit preflight ═══");

  for (const [label, fn, args] of [
    ["minDeposit", "minDeposit", []],
    ["maxDeposit", "maxDeposit", []],
    ["whitelistEnabled", "whitelistEnabled", []],
    ["whitelisted(deployer)", "whitelisted", [DEPLOYER]],
    ["paused", "paused", []],
    ["yieldBps / basketBps", null, null],
    ["yieldReceipt", "yieldReceipt", []],
    ["basketReceipt", "basketReceipt", []],
    ["basketId", "basketId", []],
    ["totalAssets", "totalAssets", []],
  ]) {
    if (!fn) {
      try {
        const y = await vault.yieldBps();
        const b = await vault.basketBps();
        console.log(`  ${label.padEnd(22)} : y=${y} b=${b} (sum=${Number(y)+Number(b)})`);
      } catch (e) { console.log(`  ${label}: reverted`); }
      continue;
    }
    try {
      const v = await vault[fn](...args);
      console.log(`  ${label.padEnd(22)} : ${v.toString ? v.toString() : v}`);
    } catch (e) { console.log(`  ${label}: reverted — ${(e.shortMessage||e.message).slice(0,60)}`); }
  }

  console.log("\n═══ NAV oracle (basket 0) ═══");
  try {
    const [nav, at, stale] = await oracle.getNavLenient(0);
    const now = Math.floor(Date.now()/1000);
    console.log(`  nav         : ${nav} (${Number(nav)/1e6} USDC per share)`);
    console.log(`  updatedAt   : ${at} (${new Date(Number(at)*1000).toISOString()})`);
    console.log(`  age         : ${now - Number(at)}s`);
    console.log(`  stale       : ${stale}`);
  } catch (e) { console.log("  oracle read failed:", e.shortMessage||e.message); }

  console.log("\n═══ Deployer USDC on HyperEVM ═══");
  try {
    const bal = await usdc.balanceOf(DEPLOYER);
    const allow = await usdc.allowance(DEPLOYER, POOL_F_VAULT);
    console.log(`  USDC balance: ${Number(bal)/1e6}`);
    console.log(`  vault allowance: ${Number(allow)/1e6}`);
  } catch (e) { console.log("  usdc read failed:", e.shortMessage||e.message); }

  const hype = await hre.ethers.provider.getBalance(DEPLOYER);
  console.log(`  HYPE balance: ${hre.ethers.formatEther(hype)}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
