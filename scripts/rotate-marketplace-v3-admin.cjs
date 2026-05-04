// Rotate MarketplaceV3 admin from deployer EOA → canonical Arb Safe.
// Idempotent: skips grants/revokes that are already in the desired state.

const hre = require("hardhat");

const MARKETPLACE_V3 = "0x375eD66ABf360444cf2c23fCa1f4b12484087236";
const TARGET_ADMIN   = "0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363"; // Arb Safe (per reference_safes.md)

const DEFAULT_ADMIN_ROLE = "0x" + "0".repeat(64);
const PAUSER_ROLE        = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("PAUSER_ROLE"));

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected Arbitrum, got ${net.chainId}`);

  console.log("Deployer    :", deployer.address);
  console.log("Marketplace :", MARKETPLACE_V3);
  console.log("Target admin:", TARGET_ADMIN);
  console.log();

  const m = await hre.ethers.getContractAt("EcosystemMarketplaceV3", MARKETPLACE_V3, deployer);

  // Step 1+2 — grant both roles to the Safe (idempotent).
  for (const [name, role] of [["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE], ["PAUSER_ROLE", PAUSER_ROLE]]) {
    const has = await m.hasRole(role, TARGET_ADMIN);
    if (has) { console.log(`✓ Safe already has ${name}, skipping grant`); continue; }
    process.stdout.write(`→ grantRole(${name}, Safe)…  `);
    const tx = await m.grantRole(role, TARGET_ADMIN);
    await tx.wait();
    console.log(tx.hash);
  }

  // Step 3+4 — revoke both roles from the deployer (idempotent).
  for (const [name, role] of [["PAUSER_ROLE", PAUSER_ROLE], ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE]]) {
    const has = await m.hasRole(role, deployer.address);
    if (!has) { console.log(`✓ Deployer already lacks ${name}, skipping revoke`); continue; }
    process.stdout.write(`→ renounceRole(${name}, deployer)…  `);
    // OZ AccessControl: an account renounces its own role via renounceRole(role, callerConfirmation).
    const tx = await m.renounceRole(role, deployer.address);
    await tx.wait();
    console.log(tx.hash);
  }

  console.log();
  console.log("Final state:");
  console.log("  Safe   has DEFAULT_ADMIN_ROLE:", await m.hasRole(DEFAULT_ADMIN_ROLE, TARGET_ADMIN));
  console.log("  Safe   has PAUSER_ROLE       :", await m.hasRole(PAUSER_ROLE, TARGET_ADMIN));
  console.log("  Deployer has DEFAULT_ADMIN   :", await m.hasRole(DEFAULT_ADMIN_ROLE, deployer.address));
  console.log("  Deployer has PAUSER_ROLE     :", await m.hasRole(PAUSER_ROLE, deployer.address));
}

main().catch((e) => { console.error(e); process.exit(1); });
