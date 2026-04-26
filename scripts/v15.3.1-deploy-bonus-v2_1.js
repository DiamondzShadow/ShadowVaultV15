// SPDX-License-Identifier: MIT
// v15.3.1 — Deploy BonusAccumulatorV2.1 (forgiving deregister) and
// rewire all 3 pools. Fixes the migration gap left by v15.3 where
// positions registered on v1 would brick the vault's withdraw path
// because V2.deregisterPosition reverts NotRegistered.
//
// Flow:
//   1. Deploy BonusAccumulatorV2_1(deployer)
//   2. For each pool: grantRole VAULT_ROLE on V2.1, setBonusAccumulator(V2.1)
//   3. Revoke VAULT_ROLE on the old V2 for all 3 pools (disarm)
//   4. Persist v2_1 address + deprecate v2 in config/deployed.json

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOLS = ["A", "B", "C"];
const OLD_V2 = "0xa8CB26753A5eddE5D1353E6d02cA4FCd299114A7";

const VAULT_ABI = [
  "function setBonusAccumulator(address) external",
  "function bonusAccumulator() view returns (address)",
];

const ACC_ABI = [
  "function removeVault(address) external",
  "function hasRole(bytes32,address) view returns (bool)",
  "function VAULT_ROLE() view returns (bytes32)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // 1. Deploy V2.1
  console.log("\n── Deploying BonusAccumulatorV2_1 ──");
  const Factory = await ethers.getContractFactory("BonusAccumulatorV2_1");
  const v2_1 = await Factory.deploy(signer.address);
  await v2_1.waitForDeployment();
  const v2_1Addr = await v2_1.getAddress();
  console.log("BonusAccumulatorV2_1:", v2_1Addr);
  console.log("deploy tx:", v2_1.deploymentTransaction().hash);

  // 2. Rewire each pool to V2.1
  for (const id of POOLS) {
    const info = deployed.pools[id];
    console.log(`\n── Pool ${id} ${info.label} (${info.vault}) ──`);

    console.log("  V2.1 grantRole(VAULT_ROLE)");
    const grantTx = await v2_1.addVault(info.vault);
    console.log("  tx:", grantTx.hash);
    await grantTx.wait();

    const vault = new ethers.Contract(info.vault, VAULT_ABI, signer);
    console.log("  setBonusAccumulator(V2.1)");
    const setTx = await vault.setBonusAccumulator(v2_1Addr);
    console.log("  tx:", setTx.hash);
    await setTx.wait();

    const now = await vault.bonusAccumulator();
    if (now.toLowerCase() !== v2_1Addr.toLowerCase()) {
      throw new Error(`pool ${id} rewire failed: ${now}`);
    }
    console.log(`  ✓ pool ${id} bonusAccumulator = ${now}`);
  }

  // 3. Disarm old V2
  console.log("\n── Disarming old V2 (revoke VAULT_ROLE) ──");
  const oldAcc = new ethers.Contract(OLD_V2, ACC_ABI, signer);
  const role = await oldAcc.VAULT_ROLE();
  for (const id of POOLS) {
    const vaultAddr = deployed.pools[id].vault;
    const had = await oldAcc.hasRole(role, vaultAddr);
    if (!had) {
      console.log(`  pool ${id}: already revoked`);
      continue;
    }
    const tx = await oldAcc.removeVault(vaultAddr);
    console.log(`  pool ${id} revoke tx: ${tx.hash}`);
    await tx.wait();
  }

  // 4. Persist
  deployed.core.bonusAccumulatorV2_1 = v2_1Addr;
  deployed.core.bonusAccumulatorV2_deprecated = OLD_V2;
  deployed.core.bonusAccumulator = v2_1Addr;
  deployed.v15_3_1AppliedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");

  console.log("\nv15.3.1 complete.");
  console.log("BonusAccumulatorV2_1:", v2_1Addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
