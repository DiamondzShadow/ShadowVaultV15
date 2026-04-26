// Redeploy ONLY LendingPool (the others — AaveV3Sink, HyperRemoteMirror,
// SweepController — are unchanged and stay live). Rewires:
//   - SweepController.setLendingPool(newPool)  (new POOL_ROLE grant)
//   - RoyaltyRouter.setLendingPool(newPool)    (supplier-cut sink)
// Old pool is left on-chain but disconnected. Nothing was supplied/borrowed
// against it, so no migration needed.

const hre = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg     = require("../config/deployed-lending-arb.json");
const phase2  = require("../config/deployed-marketplace-arb.json");

const REGISTRY = phase2.contracts.diggerRegistry;
const ROUTER   = phase2.contracts.royaltyRouter;
const ARB_USDC = cfg.usdc;
const SWEEP    = cfg.contracts.sweepController;
const OLD_POOL = cfg.contracts.lendingPool;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Old pool:", OLD_POOL);

  const F = await hre.ethers.getContractFactory("LendingPool");
  const pool = await F.deploy(deployer.address, ARB_USDC, REGISTRY);
  await pool.waitForDeployment();
  const newAddr = await pool.getAddress();
  console.log("\nNew LendingPool:", newAddr);

  // Re-wire sweep controller.
  console.log("\n→ SweepController.setLendingPool(newPool)");
  const sweep = new hre.ethers.Contract(
    SWEEP,
    [
      "function setLendingPool(address)",
      "function lendingPool() view returns (address)",
      "function revokeRole(bytes32,address)",
      "function POOL_ROLE() view returns (bytes32)",
    ],
    deployer,
  );
  await (await sweep.setLendingPool(newAddr)).wait();
  console.log("  done");

  // Revoke POOL_ROLE on the old (zombie) pool address from the controller.
  const POOL_ROLE = await sweep.POOL_ROLE();
  console.log("→ SweepController revoke POOL_ROLE on old pool");
  await (await sweep.revokeRole(POOL_ROLE, OLD_POOL)).wait();
  console.log("  done");

  // Re-wire royalty router supplier-cut sink.
  console.log("\n→ RoyaltyRouter.setLendingPool(newPool)");
  const router = new hre.ethers.Contract(
    ROUTER,
    ["function setLendingPool(address)", "function lendingPool() view returns (address)"],
    deployer,
  );
  await (await router.setLendingPool(newAddr)).wait();
  console.log("  done");

  // Wire LendingPool's sweep sink reference.
  console.log("\n→ LendingPool.setSweepSink(SweepController)");
  await (await pool.setSweepSink(SWEEP)).wait();
  console.log("  done");

  // Persist
  cfg.contracts.lendingPool = newAddr;
  cfg.contracts.lendingPool_v1_unused = OLD_POOL;
  cfg.deployedAt = new Date().toISOString();
  cfg.notes = "v1.1 with yield-to-loan auto-repay. v1 (without yield-repay) at lendingPool_v1_unused.";
  const outfile = path.join(__dirname, "..", "config", "deployed-lending-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(cfg, null, 2));
  console.log("\nwrote", outfile);

  console.log("\n✓ Lending stack rewired. New LendingPool:", newAddr);
}

main().catch(e => { console.error(e); process.exit(1); });
