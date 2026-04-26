// Grant KEEPER_ROLE on SweepControllerV2 (both chains) + PolygonNFTLocker
// to the current KEEPER_KEY signer, so autonomous keepers can operate.
//
// Usage:
//   npx hardhat run --network arbitrum scripts/grant-keeper-roles.cjs
//   npx hardhat run --network polygon  scripts/grant-keeper-roles.cjs

const hre = require("hardhat");
const path = require("node:path");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  console.log("network chainId:", chainId, "deployer:", deployer.address);

  // Derive keeper signer address from KEEPER_KEY env
  if (!process.env.KEEPER_KEY) throw new Error("KEEPER_KEY env required");
  const keeperAddr = new ethers.Wallet(process.env.KEEPER_KEY).address;
  console.log("keeper signer  :", keeperAddr);

  if (chainId === 42161) {
    const cfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));
    const sweep = await ethers.getContractAt("SweepControllerV2", cfg.contracts.sweepController);
    const role = await sweep.KEEPER_ROLE();
    if (!await sweep.hasRole(role, keeperAddr)) {
      console.log("grant KEEPER_ROLE on SweepV2 Arb →", keeperAddr);
      await (await sweep.grantRole(role, keeperAddr)).wait();
    } else {
      console.log("keeper already has KEEPER_ROLE on SweepV2 Arb ✓");
    }
    return;
  }

  if (chainId === 137) {
    const cfg = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json"));
    const sweep = await ethers.getContractAt("SweepControllerV2", cfg.contracts.sweepController);
    const role = await sweep.KEEPER_ROLE();
    if (!await sweep.hasRole(role, keeperAddr)) {
      console.log("grant KEEPER_ROLE on SweepV2 Polygon →", keeperAddr);
      await (await sweep.grantRole(role, keeperAddr)).wait();
    } else {
      console.log("keeper already has KEEPER_ROLE on SweepV2 Polygon ✓");
    }

    // Same for PolygonNFTLocker — keeper needs its own KEEPER_ROLE for pushValueUpdate
    const locker = await ethers.getContractAt("PolygonNFTLocker", cfg.contracts.polygonNFTLocker);
    const lockerRole = await locker.KEEPER_ROLE();
    if (!await locker.hasRole(lockerRole, keeperAddr)) {
      console.log("grant KEEPER_ROLE on PolygonNFTLocker →", keeperAddr);
      await (await locker.grantRole(lockerRole, keeperAddr)).wait();
    } else {
      console.log("keeper already has KEEPER_ROLE on PolygonNFTLocker ✓");
    }
    return;
  }

  throw new Error(`unsupported chain ${chainId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
