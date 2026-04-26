// Revoke VAULT_ROLE on the deprecated BonusAccumulator v1 for all 3
// pools. Belt-and-suspenders after v15.3 — the vaults are already
// unwired so the v1 accumulator can't be called anymore, but pulling
// the role off makes the deprecation explicit on-chain.

const { ethers } = require("hardhat");

const OLD_BONUS = "0x5Fe2C414433D3CB8B6e656a7D8951D73cE7fbdb2";
const POOLS = {
  A: "0x3EABca4E9F1dA0CA6b61a3CC942c09Dd51D77E32",
  B: "0x0D32FA2788Ee6D19ae6ccc5BDB657C7321Ce8C90",
  C: "0x2Ddd79fFdE4d382A40267E5D533F761d86365D64",
};

const ACC_ABI = [
  "function removeVault(address) external",
  "function hasRole(bytes32,address) view returns (bool)",
  "function VAULT_ROLE() view returns (bytes32)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const acc = new ethers.Contract(OLD_BONUS, ACC_ABI, signer);
  const role = await acc.VAULT_ROLE();
  console.log("VAULT_ROLE:", role);

  for (const [id, addr] of Object.entries(POOLS)) {
    const had = await acc.hasRole(role, addr);
    console.log(`\nPool ${id} (${addr}): VAULT_ROLE=${had}`);
    if (!had) {
      console.log("  already revoked, skip");
      continue;
    }
    const tx = await acc.removeVault(addr);
    console.log("  revoke tx:", tx.hash);
    await tx.wait();
    const now = await acc.hasRole(role, addr);
    console.log(`  ✓ Pool ${id} VAULT_ROLE on old accumulator = ${now}`);
  }

  console.log("\nold BonusAccumulator v1 is fully disarmed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
