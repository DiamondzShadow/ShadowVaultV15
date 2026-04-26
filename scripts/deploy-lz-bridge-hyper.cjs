// Deploy HyperPositionLocker on HyperEVM (chain 999).
// Bytecode ~10kb → fits in small 2M-gas block, no big-block switch required.
//
// Admin = per-chain HyperEVM Safe.
// Keeper = the current KEEPER_KEY wallet (will pay LZ fees from HYPE balance).

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

// LZ v2 HyperEVM endpoint + EIDs (verified via metadata.layerzero-api.com)
const LZ_ENDPOINT_HYPER = "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9";
const ARB_EID           = 30110;

// HyperEVM admin Safe (per reference_safes.md)
const ADMIN_SAFE_HYPER  = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
// Use deployer as admin for initial bake; rotate to Safe alongside other
// HyperEVM admin rotations (memory: 7-day bake then renounce).
const KEEPER            = new hre.ethers.Wallet(process.env.KEEPER_KEY).address;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 999) throw new Error(`Expected 999, got ${net.chainId}`);

  console.log("Deployer:", deployer.address);
  console.log("Keeper  :", KEEPER);
  console.log("LZ endpoint:", LZ_ENDPOINT_HYPER);
  console.log("Arb EID :", ARB_EID);

  const F = await hre.ethers.getContractFactory("HyperPositionLocker");
  const c = await F.deploy(deployer.address, KEEPER, LZ_ENDPOINT_HYPER, ARB_EID);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("\n✓ HyperPositionLocker:", addr);

  // Persist
  const cfgPath = path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json");
  const cfg = {
    chainId: 999,
    deployer: deployer.address,
    keeper: KEEPER,
    lzEndpoint: LZ_ENDPOINT_HYPER,
    arbEid: ARB_EID,
    contracts: { hyperPositionLocker: addr },
    adminSafe: ADMIN_SAFE_HYPER,
    deployedAt: new Date().toISOString(),
    notes: "Admin = deployer EOA during initial bake; rotate to Safe after arb-side deploy + full cross-wire + DVN setConfig is confirmed working.",
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log("wrote", cfgPath);

  console.log("\nVerify (Purrsec / Hyperscan):");
  console.log(`  npx hardhat verify --network hyperevm ${addr} ${deployer.address} ${KEEPER} ${LZ_ENDPOINT_HYPER} ${ARB_EID}`);
}

main().catch(e => { console.error(e); process.exit(1); });
