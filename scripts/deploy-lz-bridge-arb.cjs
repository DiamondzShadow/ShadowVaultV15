// Deploy HyperPositionWrapper on Arbitrum. Mirror of HyperEVM locker.
// Gets registered in DiggerRegistry as a collection + configured in NFTValuer
// VAULT_MIRROR mode separately (via wire-lz-bridge.cjs).

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const LZ_ENDPOINT_ARB = "0x1a44076050125825900e736c501f859c50fE728c";
const HYPER_EID       = 30367;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected 42161, got ${net.chainId}`);

  const F = await hre.ethers.getContractFactory("HyperPositionWrapper");
  const c = await F.deploy(deployer.address, LZ_ENDPOINT_ARB, HYPER_EID);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("✓ HyperPositionWrapper:", addr);

  // Persist to a dedicated config + also update deployed-lending-arb.json
  const bridgePath = path.resolve(__dirname, "..", "config", "deployed-lz-bridge-arb.json");
  fs.writeFileSync(bridgePath, JSON.stringify({
    chainId: 42161,
    deployer: deployer.address,
    lzEndpoint: LZ_ENDPOINT_ARB,
    hyperEid: HYPER_EID,
    contracts: { hyperPositionWrapper: addr },
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log("wrote", bridgePath);

  // Add to the main lending config so audit-wiring.cjs picks it up
  const lendPath = path.resolve(__dirname, "..", "config", "deployed-lending-arb.json");
  const lend = JSON.parse(fs.readFileSync(lendPath, "utf8"));
  lend.contracts.hyperPositionWrapper = addr;
  lend.hyperBridge = { lzEndpoint: LZ_ENDPOINT_ARB, hyperEid: HYPER_EID };
  fs.writeFileSync(lendPath, JSON.stringify(lend, null, 2));
  console.log("updated", lendPath);

  console.log("\nVerify:");
  console.log(`  npx hardhat verify --network arbitrum ${addr} ${deployer.address} ${LZ_ENDPOINT_ARB} ${HYPER_EID}`);
}

main().catch(e => { console.error(e); process.exit(1); });
