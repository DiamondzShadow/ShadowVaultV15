// v1.2: LendingPool with auto-pull from sweep + per-collection APR override.
// Idempotent rewire pattern — same as v1.1 redeploy.

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
  console.log("Old pool (v1.1):", OLD_POOL);

  const F = await hre.ethers.getContractFactory("LendingPool");
  const pool = await F.deploy(deployer.address, ARB_USDC, REGISTRY);
  await pool.waitForDeployment();
  const newAddr = await pool.getAddress();
  console.log("\nNew LendingPool (v1.2):", newAddr);

  // Re-wire sweep controller.
  console.log("\n→ SweepController.setLendingPool(newPool)");
  const sweep = new hre.ethers.Contract(
    SWEEP,
    [
      "function setLendingPool(address)",
      "function POOL_ROLE() view returns (bytes32)",
      "function revokeRole(bytes32,address)",
    ],
    deployer,
  );
  await (await sweep.setLendingPool(newAddr)).wait();
  console.log("  done");

  const POOL_ROLE = await sweep.POOL_ROLE();
  console.log("→ revoke POOL_ROLE on old v1.1 pool");
  await (await sweep.revokeRole(POOL_ROLE, OLD_POOL)).wait();
  console.log("  done");

  console.log("\n→ RoyaltyRouter.setLendingPool(newPool)");
  const router = new hre.ethers.Contract(
    ROUTER,
    ["function setLendingPool(address)"],
    deployer,
  );
  await (await router.setLendingPool(newAddr)).wait();
  console.log("  done");

  console.log("\n→ LendingPool.setSweepSink(SweepController)");
  await (await pool.setSweepSink(SWEEP)).wait();
  console.log("  done");

  // Persist
  cfg.contracts.lendingPool_v1_1_unused = OLD_POOL;
  cfg.contracts.lendingPool = newAddr;
  cfg.deployedAt = new Date().toISOString();
  cfg.notes = "v1.2 with auto-pull on borrow/withdraw + per-collection APR override. v1.1 at lendingPool_v1_1_unused.";
  const outfile = path.join(__dirname, "..", "config", "deployed-lending-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(cfg, null, 2));
  console.log("\nwrote", outfile);

  console.log("\n✓ v1.2 live + rewired:", newAddr);
}

main().catch(e => { console.error(e); process.exit(1); });
