// SPDX-License-Identifier: MIT
// v15.3 — Deploy BonusAccumulatorV2 (vault-namespaced keys) and rewire
// all 3 pool vaults. Prerequisite: scripts/emergency-unblock.js has
// already been run (bonusAccumulator = 0 on every pool).
//
// Flow:
//   1. Deploy BonusAccumulatorV2(deployer)
//   2. For each pool: grantRole VAULT_ROLE, then vault.setBonusAccumulator(V2)
//   3. Write new address into config/deployed.json under core.bonusAccumulatorV2
//   4. Print tx hashes for the record

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOLS = ["A", "B", "C"];

const VAULT_ABI = [
  "function setBonusAccumulator(address) external",
  "function bonusAccumulator() view returns (address)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // 1. Deploy V2
  console.log("\n── Deploying BonusAccumulatorV2 ──");
  const Factory = await ethers.getContractFactory("BonusAccumulatorV2");
  const v2 = await Factory.deploy(signer.address);
  await v2.waitForDeployment();
  const v2Addr = await v2.getAddress();
  console.log("BonusAccumulatorV2:", v2Addr);
  console.log("deploy tx:", v2.deploymentTransaction().hash);

  // 2. Rewire each pool
  for (const id of POOLS) {
    const info = deployed.pools[id];
    console.log(`\n── Pool ${id} ${info.label} (${info.vault}) ──`);

    // 2a. Grant VAULT_ROLE on V2 to this vault
    console.log("  grantRole(VAULT_ROLE)");
    const grantTx = await v2.addVault(info.vault);
    console.log("  tx:", grantTx.hash);
    await grantTx.wait();

    // 2b. Point vault at V2
    const vault = new ethers.Contract(info.vault, VAULT_ABI, signer);
    console.log("  setBonusAccumulator(V2)");
    const setTx = await vault.setBonusAccumulator(v2Addr);
    console.log("  tx:", setTx.hash);
    await setTx.wait();

    const now = await vault.bonusAccumulator();
    if (now.toLowerCase() !== v2Addr.toLowerCase()) {
      throw new Error(`pool ${id} rewire failed: ${now}`);
    }
    console.log(`  ✓ pool ${id} bonusAccumulator = ${now}`);
  }

  // 3. Persist
  deployed.core.bonusAccumulatorV2 = v2Addr;
  deployed.core.bonusAccumulatorV1_deprecated = deployed.core.bonusAccumulator;
  deployed.core.bonusAccumulator = v2Addr;
  deployed.v15_3AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");

  console.log("\nv15.3 complete.");
  console.log("BonusAccumulatorV2:", v2Addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
