// SPDX-License-Identifier: MIT
// Emergency V15 unblock — two fixes bundled:
//   (1) setBonusAccumulator(address(0)) on all 3 pools to bypass the
//       AlreadyRegistered() collision in the shared BonusAccumulator.
//   (2) setTrustedSwapTarget(0xfeea2a79d7d3d36753c8917af744d71f13c9b02a, true)
//       on all 3 pools so the keeper's 0x v2 AllowanceHolder calldata
//       lands on-chain on the next cron tick.
//
// These are dumb transparent fixes — intentionally no redeploy, no
// storage writes beyond two setters per vault. After this runs, v15.3
// (scripts/v15.3-deploy-bonus-v2.js) can deploy the namespaced bonus
// accumulator and rewire without any time pressure.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOLS = ["A", "B", "C"];
const ZEROX_ALLOWANCE_HOLDER = "0xfeea2a79d7d3d36753c8917af744d71f13c9b02a";

const VAULT_ABI = [
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function bonusAccumulator() view returns (address)",
  "function trustedSwapTargets(address) view returns (bool)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config", "deployed.json"), "utf8")
  );

  for (const id of POOLS) {
    const info = deployed.pools[id];
    console.log(`\n── Pool ${id} ${info.label} (${info.vault}) ──`);
    const vault = new ethers.Contract(info.vault, VAULT_ABI, signer);

    // 1. Unwire bonus accumulator if still set
    const currentBonus = await vault.bonusAccumulator();
    if (currentBonus !== ethers.ZeroAddress) {
      console.log(`  unwiring bonusAccumulator (was ${currentBonus})`);
      const tx = await vault.setBonusAccumulator(ethers.ZeroAddress);
      console.log(`  tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  ✓ bonusAccumulator = 0`);
    } else {
      console.log("  bonusAccumulator already zero, skip");
    }

    // 2. Whitelist 0x v2 AllowanceHolder
    const isTrusted = await vault.trustedSwapTargets(ZEROX_ALLOWANCE_HOLDER);
    if (!isTrusted) {
      console.log(`  whitelisting 0x AllowanceHolder ${ZEROX_ALLOWANCE_HOLDER}`);
      const tx = await vault.setTrustedSwapTarget(ZEROX_ALLOWANCE_HOLDER, true);
      console.log(`  tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  ✓ trustedSwapTargets[0xfeea...] = true`);
    } else {
      console.log("  0x AllowanceHolder already trusted, skip");
    }
  }

  console.log("\nemergency unblock complete.");
  console.log("next keeper cron tick should execute basket buys on Pools B and C.");
  console.log("Pool A deposits now work (no bonus registration blocking).");
  console.log("run scripts/v15.3-deploy-bonus-v2.js to restore bonus accrual.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
