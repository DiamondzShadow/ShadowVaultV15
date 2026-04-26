const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const ADAPTER = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const USDC    = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const AMOUNT  = 2_000_000n; // 2 USDC

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);
  const usdc = new ethers.Contract(USDC, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)"
  ], w);
  const adapter = new ethers.Contract(ADAPTER, [
    "function verifyRoute(uint256)",
    "function idleUsdc() view returns (uint256)"
  ], w);

  console.log("USDC (deployer) before:", ethers.formatUnits(await usdc.balanceOf(w.address), 6));
  console.log("USDC (adapter) before:", ethers.formatUnits(await adapter.idleUsdc(), 6));

  console.log("\napproving adapter for 5 USDC...");
  await (await usdc.approve(ADAPTER, AMOUNT)).wait();

  console.log("verifyRoute(5_000_000)...");
  const tx = await adapter.verifyRoute(AMOUNT);
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("mined block", r.blockNumber, "gas", r.gasUsed.toString());

  console.log("\nwaiting ~60s for HC→EVM return leg...");
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000));
    const bal = await adapter.idleUsdc();
    console.log(`  [${i*6}s] adapter USDC:`, ethers.formatUnits(bal, 6));
    if (bal >= AMOUNT * 9n / 10n) {
      console.log("\n✓ round trip complete — USDC returned to adapter");
      process.exit(0);
    }
  }
  console.log("\n⚠ round trip did not complete in 120s — check HC spot balance");
})().catch(e => { console.error(e); process.exit(1); });
