const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const cfg = require("../config/deployed-pool-e-hc.json");
const AMOUNT = 5_000_000n; // 5 USDC — matches vault MIN_DEPOSIT

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  console.log("Depositor:", w.address);
  console.log("Vault    :", cfg.vault);
  console.log("USDC     :", cfg.usdc);

  const usdc = new ethers.Contract(cfg.usdc, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], w);
  const vault = new ethers.Contract(cfg.vault, [
    "function deposit(uint256,uint8) returns (uint256)",
  ], w);
  const adapter = new ethers.Contract(cfg.adapter, [
    "function totalAssets() view returns (uint256)",
    "function totalPrincipal() view returns (uint256)",
    "function inFlightToHC() view returns (uint256)",
  ], p);
  const skin = new ethers.Contract(cfg.skin, [
    "function balanceOf(address) view returns (uint256)",
    "function ownerOf(uint256) view returns (address)",
  ], p);

  const bal = await usdc.balanceOf(w.address);
  console.log("USDC balance:", ethers.formatUnits(bal, 6));
  if (bal < AMOUNT) throw new Error("insufficient USDC");

  const allow = await usdc.allowance(w.address, cfg.vault);
  if (allow < AMOUNT) {
    console.log("\napproving vault for 5 USDC...");
    const a = await usdc.approve(cfg.vault, AMOUNT);
    await a.wait();
    console.log("  tx:", a.hash);
  }

  console.log("\nadapter.totalAssets before:", ethers.formatUnits(await adapter.totalAssets(), 6));

  console.log("\nvault.deposit(5_000_000, Tier.FLEX=0)...");
  const tx = await vault.deposit(AMOUNT, 0);
  console.log("  tx:", tx.hash);
  const rc = await tx.wait();
  console.log("  mined block", rc.blockNumber, "gas", rc.gasUsed.toString());

  console.log("\nadapter.totalAssets after :", ethers.formatUnits(await adapter.totalAssets(), 6));
  console.log("adapter.totalPrincipal    :", ethers.formatUnits(await adapter.totalPrincipal(), 6));
  console.log("adapter.inFlightToHC      :", ethers.formatUnits(await adapter.inFlightToHC(), 6));

  const owned = await skin.balanceOf(w.address);
  console.log("deployer NFT count:", owned.toString());
  if (owned > 0n) {
    try {
      // tokenId probably starts at 1; just try 1 and 0
      for (const tid of [1n, 0n]) {
        try {
          const owner = await skin.ownerOf(tid);
          console.log(`  ShadowPass tokenId ${tid} owner:`, owner);
        } catch {}
      }
    } catch {}
  }

  console.log("\n✓ Pool E seed deposit complete — first ShadowPass NFT minted");
})().catch(e => { console.error(e); process.exit(1); });
