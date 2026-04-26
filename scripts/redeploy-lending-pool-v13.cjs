// v1.3: LendingPool with NFTValuer dispatch + loan-time unwindTarget snapshot.
// Idempotent rewire pattern — same sequencing as v1.1 / v1.2 redeploys, with
// two additions:
//   - pool.setValuer(NFTValuer) after setSweepSink
//   - pause the old v1.2 pool so nothing new can land in it
//
// Precondition (verified by preflight audit): v1.2 pool is empty — no
// suppliers, no loans, no protocol reserve, no sweep balance. If that
// changes between audit and this run, STOP and redo the audit.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfgLending    = require("../config/deployed-lending-arb.json");
const cfgMarketplace = require("../config/deployed-marketplace-arb.json");
const cfgValuer     = require("../config/deployed-valuer-arb.json");

const REGISTRY   = cfgMarketplace.contracts.diggerRegistry;
const ROUTER     = cfgMarketplace.contracts.royaltyRouter;
const VALUER     = cfgValuer.contracts.nftValuer;
const ARB_USDC   = cfgLending.usdc;
const SWEEP      = cfgLending.contracts.sweepController;
const OLD_POOL   = cfgLending.contracts.lendingPool;

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected 42161, got ${net.chainId}`);

  section(`LendingPool v1.3 redeploy on Arbitrum`);
  console.log("Deployer:", deployer.address);
  console.log("Old pool (v1.2):", OLD_POOL);
  console.log("Registry:", REGISTRY);
  console.log("Router  :", ROUTER);
  console.log("Valuer  :", VALUER);
  console.log("Sweep   :", SWEEP);

  // Safety guard: re-confirm old pool is empty NOW, not just at audit time.
  const oldPool = await hre.ethers.getContractAt("LendingPool", OLD_POOL);
  const oldShares = await oldPool.totalShares();
  const oldBorrowed = await oldPool.totalBorrowed();
  const oldReserve = await oldPool.protocolReserve();
  console.log("\nOld v1.2 live state:");
  console.log(`  totalShares  : ${oldShares.toString()}`);
  console.log(`  totalBorrowed: ${oldBorrowed.toString()}`);
  console.log(`  reserve      : ${oldReserve.toString()}`);
  if (oldShares !== 0n || oldBorrowed !== 0n || oldReserve !== 0n) {
    throw new Error("v1.2 is NOT empty — stop, re-run audit, decide migration path");
  }

  // ═════════ 1. Deploy v1.3
  section("1. Deploy LendingPool v1.3");
  const F = await hre.ethers.getContractFactory("LendingPool");
  const pool = await F.deploy(deployer.address, ARB_USDC, REGISTRY);
  await pool.waitForDeployment();
  const newAddr = await pool.getAddress();
  console.log("  LendingPool v1.3:", newAddr);

  // ═════════ 2. Pause v1.2 so nothing new ever lands in the zombie
  section("2. Pause old v1.2");
  try {
    await (await oldPool.pause()).wait();
    console.log("  paused ✓");
  } catch (e) {
    console.log("  (pause skipped — already paused or no PAUSER_ROLE)");
  }

  // ═════════ 3. Rewire SweepController
  section("3. SweepController rewire");
  const sweep = new hre.ethers.Contract(
    SWEEP,
    [
      "function setLendingPool(address)",
      "function POOL_ROLE() view returns (bytes32)",
      "function revokeRole(bytes32,address)",
    ],
    deployer,
  );
  step("SweepController.setLendingPool(v1.3)");
  await (await sweep.setLendingPool(newAddr)).wait();
  const POOL_ROLE = await sweep.POOL_ROLE();
  step("SweepController.revokeRole(POOL_ROLE, v1.2)");
  await (await sweep.revokeRole(POOL_ROLE, OLD_POOL)).wait();

  // ═════════ 4. Rewire RoyaltyRouter (supplier-cut sink now flows to v1.3)
  section("4. RoyaltyRouter rewire");
  const router = new hre.ethers.Contract(
    ROUTER,
    ["function setLendingPool(address)"],
    deployer,
  );
  step("RoyaltyRouter.setLendingPool(v1.3)");
  await (await router.setLendingPool(newAddr)).wait();

  // ═════════ 5. Wire v1.3 → SweepController + NFTValuer
  section("5. Wire v1.3 adapters");
  step("pool.setSweepSink(SweepController)");
  await (await pool.setSweepSink(SWEEP)).wait();
  step("pool.setValuer(NFTValuer)");
  await (await pool.setValuer(VALUER)).wait();

  // Sanity read-back
  const readValuer = await pool.valuer();
  const readSweep  = await pool.sweepSink();
  if (readValuer.toLowerCase() !== VALUER.toLowerCase()) throw new Error("valuer readback mismatch");
  if (readSweep.toLowerCase() !== SWEEP.toLowerCase()) throw new Error("sweep readback mismatch");
  console.log("  valuer readback:", readValuer);
  console.log("  sweep  readback:", readSweep);

  // ═════════ 6. Persist
  section("6. Save config");
  cfgLending.contracts.lendingPool_v1_2_unused = OLD_POOL;
  cfgLending.contracts.lendingPool = newAddr;
  cfgLending.contracts.nftValuer  = VALUER;
  cfgLending.deployedAt = new Date().toISOString();
  cfgLending.notes =
    "v1.3 with NFTValuer dispatch + Loan.unwindTarget snapshot (fix for mode-switch brick). " +
    "v1.2 drained & paused at lendingPool_v1_2_unused.";
  const outfile = path.join(__dirname, "..", "config", "deployed-lending-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(cfgLending, null, 2));
  console.log("wrote", outfile);

  // ═════════ 7. Next steps
  section("7. Verify + post-deploy");
  console.log("Verify on Arbiscan:");
  console.log(`  npx hardhat verify --network arbitrum ${newAddr} ${deployer.address} ${ARB_USDC} ${REGISTRY}`);
  console.log("\nUpdate Lovable ABI `src/abi/lending.ts`:");
  console.log(`  export const LENDING_POOL_ADDRESS = "${newAddr}" as const;`);
  console.log("\nOptional: verify valuer wiring with a view call:");
  console.log(`  cast call ${newAddr} 'valuer()(address)' --rpc-url arb  # → ${VALUER}`);

  console.log("\n✓ v1.3 live:", newAddr);
}

main().catch(e => { console.error(e); process.exit(1); });
