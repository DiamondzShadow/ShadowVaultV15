// Seed-deposit 5 USDC into Pool E v2.
// After deposit, polls every 5s for ~3min showing:
//   - adapter.inFlightToHC
//   - adapter.reportedHCEquity (precompile 0x802 — HLP equity)
//   - HC spot/perp via REST (sanity cross-check)
// Stops early once HLP equity reflects the deposit (the bug-fix proof).

const hre = require("hardhat");
const hl  = require("@nktkas/hyperliquid");

const VAULT   = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const ADAPTER = "0x2F6aCbdd25FF081efE2f2f4fF239189DaC6C67a9";
const USDC    = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const AMOUNT  = 5_000_000n;
const TIER_FLEX = 0;

async function readHc(info, addr) {
  const [spot, perp] = await Promise.all([
    info.spotClearinghouseState({ user: addr }).catch(() => ({ balances: [] })),
    info.clearinghouseState({ user: addr }).catch(() => ({ withdrawable: "0" })),
  ]);
  const usdc = (spot.balances || []).find(b => b.coin === "USDC");
  return {
    spot: usdc ? parseFloat(usdc.total) : 0,
    perp: parseFloat(perp.withdrawable || "0"),
  };
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const usdc  = new hre.ethers.Contract(USDC, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], signer);
  const vault = new hre.ethers.Contract(VAULT, [
    "function deposit(uint256,uint8) external",
    "function nextPosId() view returns (uint256)",
  ], signer);
  const adapter = new hre.ethers.Contract(ADAPTER, [
    "function idleUsdc() view returns (uint256)",
    "function inFlightToHC() view returns (uint256)",
    "function reportedHCEquity() view returns (uint64)",
    "function reportedSpotUsdc() view returns (uint64)",
    "function reportedPerpUsdc() view returns (uint64)",
    "function totalAssets() view returns (uint256)",
  ], signer);

  console.log("Signer:", signer.address);
  console.log("Vault :", VAULT);
  console.log("Amount:", "$" + (Number(AMOUNT)/1e6).toFixed(2));

  console.log("\n--- Pre-state ---");
  const balUsdc = await usdc.balanceOf(signer.address);
  console.log("signer USDC EVM:", "$" + (Number(balUsdc)/1e6).toFixed(6));
  const [pre_idle, pre_inFlight, pre_eq, pre_total] = await Promise.all([
    adapter.idleUsdc(), adapter.inFlightToHC(),
    adapter.reportedHCEquity(), adapter.totalAssets(),
  ]);
  console.log("adapter idle      :", "$" + (Number(pre_idle)/1e6).toFixed(6));
  console.log("adapter inFlightTo:", "$" + (Number(pre_inFlight)/1e6).toFixed(6));
  console.log("adapter HLP equity:", "$" + (Number(pre_eq)/1e6).toFixed(6));
  console.log("adapter totalAssets:", "$" + (Number(pre_total)/1e6).toFixed(6));

  console.log("\n[1] approve vault for", AMOUNT.toString(), "USDC");
  const ax = await usdc.approve(VAULT, AMOUNT);
  console.log("    tx:", ax.hash);
  await ax.wait();

  console.log("\n[2] vault.deposit(" + AMOUNT.toString() + ", FLEX)");
  const dx = await vault.deposit(AMOUNT, TIER_FLEX);
  console.log("    tx:", dx.hash);
  const rc = await dx.wait();
  console.log("    mined block", rc.blockNumber);

  // Poll loop
  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });
  console.log("\n--- Polling adapter + HC for HLP settle (CoreWriter actions are delayed a few seconds) ---");
  for (let i = 0; i < 36; i++) {
    const [idle, inFlight, eq, spot6, perp6, total] = await Promise.all([
      adapter.idleUsdc(),
      adapter.inFlightToHC(),
      adapter.reportedHCEquity(),
      adapter.reportedSpotUsdc(),
      adapter.reportedPerpUsdc(),
      adapter.totalAssets(),
    ]);
    const hc = await readHc(info, ADAPTER);
    console.log(`[${(i*5).toString().padStart(3," ")}s] inFlight=$${(Number(inFlight)/1e6).toFixed(2)} hlpEq=$${(Number(eq)/1e6).toFixed(2)} spot[ev]=$${(Number(spot6)/1e6).toFixed(2)} perp[ev]=$${(Number(perp6)/1e6).toFixed(2)} | hc.spot=${hc.spot} hc.perp=${hc.perp} | total=$${(Number(total)/1e6).toFixed(2)}`);
    if (eq >= AMOUNT) {
      console.log("\n✓ HLP equity reflects the full deposit — v2 deposit flow works end-to-end.");
      console.log("  Next: keeper will pick up confirmDeposit on its next 3-hour cron, or run manually:");
      console.log("    pm2 trigger hlp-hc-keeper-v2 (or wait for cron)");
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log("\n[!] 3 min elapsed without HLP equity reflecting full deposit — investigate");
}

main().catch(e => { console.error(e); process.exit(1); });
