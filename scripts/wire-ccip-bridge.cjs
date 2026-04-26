// Cross-wire the CCIP bridge: tell each side about the other.
//   - On Arb: wrapper.setPolygonLocker(lockerAddr)
//   - On Polygon: locker.setArbWrapper(wrapperAddr)
// Run once per chain.

const hre  = require("hardhat");

const cfgArb = require("../config/deployed-lending-arb.json");
const cfgPoly = require("../config/deployed-polygon-stack.json");

const WRAPPER = cfgArb.contracts.arbPositionWrapper;
const LOCKER  = cfgPoly.contracts.polygonNFTLocker;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  if (chainId === 42161) {
    console.log("Arb side: wrapper.setPolygonLocker");
    const w = await hre.ethers.getContractAt("ArbPositionWrapper", WRAPPER);
    await (await w.setPolygonLocker(LOCKER)).wait();
    console.log(`  wrapper ${WRAPPER} now knows locker ${LOCKER}`);
  } else if (chainId === 137) {
    console.log("Polygon side: locker.setArbWrapper");
    const l = await hre.ethers.getContractAt("PolygonNFTLocker", LOCKER);
    await (await l.setArbWrapper(WRAPPER)).wait();
    console.log(`  locker ${LOCKER} now knows wrapper ${WRAPPER}`);
  } else {
    throw new Error(`unexpected chainId ${chainId}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
