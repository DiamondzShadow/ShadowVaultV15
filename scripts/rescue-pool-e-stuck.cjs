// Rescue $5 stuck on HC spot for Pool E adapter (HyperEVM).
//
// Context: HLPAdapterHC.deposit() pushed $5 to HC via CoreWriter, but the
// follow-up vaultTransfer(HLP, true, $5) silently failed — funds sit as HC
// spot USDC, not in HLP. Adapter accounting still shows inFlightToHC = $5.
// The 95% recovery rule on the vault refuses to satisfy a $7 withdraw with
// only $2 idle on EVM, so the user can't get their position out.
//
// This script (run from the deployer with DEFAULT_ADMIN_ROLE):
//   1. Grants KEEPER_ROLE to the deployer (so we can call keeper-only fns)
//   2. confirmDeposit($5)  → clears inFlightToHC counter
//   3. sweepFromCore($5)   → CoreWriter bridges HC spot USDC back to EVM
//      (~1 minute settle, ~$1 HC bridge fee deducted on the way back)
//
// Result after settle: adapter idle goes from $2 → ~$6, totalAssets ~$6.
// User can then requestWithdraw(1) on Pool E vault, 95% rule passes,
// 30-min vault timer, then completeWithdraw(1).
//
// Dry-run by default. Set EXECUTE=1 to actually send.
//
// Usage:
//   npx hardhat run scripts/rescue-pool-e-stuck.cjs --network hyperevm
//   EXECUTE=1 npx hardhat run scripts/rescue-pool-e-stuck.cjs --network hyperevm

const hre = require("hardhat");

const ADAPTER  = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const KEEPER_ROLE = "0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab";
const STUCK_USD6  = 5_000_000n;
const EXECUTE     = process.env.EXECUTE === "1";

const ABI = [
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address) external",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function idleUsdc() view returns (uint256)",
  "function inFlightToHC() view returns (uint256)",
  "function inFlightFromHC() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function confirmDeposit(uint256) external",
  "function sweepFromCore(uint64) external",
];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const a = new hre.ethers.Contract(ADAPTER, ABI, signer);

  console.log("\n=== Pool E HC stuck-funds rescue ===");
  console.log("signer :", signer.address);
  console.log("adapter:", ADAPTER);
  console.log("mode   :", EXECUTE ? "EXECUTE" : "DRY-RUN");

  const [admin, isAdmin, isKeeper, idle, inTo, inFrom, total] = await Promise.all([
    a.DEFAULT_ADMIN_ROLE(),
    a.hasRole("0x0000000000000000000000000000000000000000000000000000000000000000", signer.address),
    a.hasRole(KEEPER_ROLE, signer.address),
    a.idleUsdc(),
    a.inFlightToHC(),
    a.inFlightFromHC(),
    a.totalAssets(),
  ]);

  console.log("\n--- Pre-state ---");
  console.log("DEFAULT_ADMIN_ROLE held by signer:", isAdmin);
  console.log("KEEPER_ROLE held by signer:       ", isKeeper);
  console.log("idleUsdc:                          $" + (Number(idle)/1e6).toFixed(6));
  console.log("inFlightToHC:                      $" + (Number(inTo)/1e6).toFixed(6));
  console.log("inFlightFromHC:                    $" + (Number(inFrom)/1e6).toFixed(6));
  console.log("totalAssets:                       $" + (Number(total)/1e6).toFixed(6));

  if (!isAdmin) {
    console.log("\n[ABORT] signer does not hold DEFAULT_ADMIN_ROLE on adapter");
    return;
  }
  if (inTo < STUCK_USD6) {
    console.log(`\n[ABORT] inFlightToHC ($${Number(inTo)/1e6}) < expected stuck $5 — state has changed, recheck`);
    return;
  }

  console.log("\n--- Plan ---");
  if (!isKeeper) {
    console.log("1. grantRole(KEEPER_ROLE, signer)  — gain keeper-only function access");
  } else {
    console.log("1. KEEPER_ROLE already held — skipping grant");
  }
  console.log("2. confirmDeposit(5_000_000)        — clear inFlightToHC");
  console.log("3. sweepFromCore(5_000_000)         — HC→EVM bridge (~1 min, ~$1 fee)");

  if (!EXECUTE) {
    console.log("\n[DRY-RUN] no txs sent. Re-run with EXECUTE=1 to send.");
    return;
  }

  // ---- step 1
  if (!isKeeper) {
    console.log("\n[1/3] grantRole(KEEPER_ROLE, signer) ...");
    const tx1 = await a.grantRole(KEEPER_ROLE, signer.address);
    console.log("  tx:", tx1.hash);
    await tx1.wait();
    console.log("  mined.");
  }

  // ---- step 2
  console.log("\n[2/3] confirmDeposit(5_000_000) ...");
  const tx2 = await a.confirmDeposit(STUCK_USD6);
  console.log("  tx:", tx2.hash);
  await tx2.wait();
  console.log("  mined.");

  // ---- step 3
  console.log("\n[3/3] sweepFromCore(5_000_000) ...");
  const tx3 = await a.sweepFromCore(STUCK_USD6);
  console.log("  tx:", tx3.hash);
  await tx3.wait();
  console.log("  mined. CoreWriter queued — adapter EVM USDC will reflect in ~1 minute.");

  // ---- post
  const [idle2, inTo2, total2] = await Promise.all([
    a.idleUsdc(), a.inFlightToHC(), a.totalAssets(),
  ]);
  console.log("\n--- Post-state ---");
  console.log("idleUsdc:    $" + (Number(idle2)/1e6).toFixed(6));
  console.log("inFlightToHC:$" + (Number(inTo2)/1e6).toFixed(6));
  console.log("totalAssets: $" + (Number(total2)/1e6).toFixed(6));
  console.log("\nNote: CoreWriter is async. idleUsdc may take ~1 min to update.");
  console.log("Once it does, call vault.requestWithdraw(1) from the user wallet.");
}

main().catch(e => { console.error(e); process.exit(1); });
