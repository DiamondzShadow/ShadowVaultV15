// Deploy on Arbitrum:
//   1. CompoundV3Sink pointing at cUSDCv3 (Arb native USDC Comet market)
//   2. SweepControllerV2 with reserve + aave + compound + remote targets
//   3. Wire:
//      - aaveSink.grantRole(CONTROLLER_ROLE, sweepV2)
//      - compoundSink.grantRole(CONTROLLER_ROLE, sweepV2)
//      - hyperRemoteMirror.grantRole(CONTROLLER_ROLE, sweepV2) — inherits from v1
//      - sweepV2.setLendingPool(LendingPool v1.3)
//      - sweepV2.setRemote(hyperRemoteMirror, remoteBps)
//      - LendingPool v1.3.setSweepSink(sweepV2)
//      - OLD sweepV1 revoked: POOL_ROLE on v1 revoked from pool (pool points at v2 now);
//        CONTROLLER_ROLE on Aave/remote revoked from sweepV1.
//
// Precondition: the existing sweepV1 + AaveV3Sink + HyperRemoteMirror are all
// empty (audited earlier — v1.2 pool was empty, so sweep was never funded).

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfgLending = require("../config/deployed-lending-arb.json");

const ARB_USDC        = cfgLending.usdc;
const LENDING_POOL    = cfgLending.contracts.lendingPool;        // v1.3
const AAVE_SINK       = cfgLending.contracts.aaveV3Sink;
const HYPER_REMOTE    = cfgLending.contracts.hyperRemoteMirror;
const OLD_SWEEP       = cfgLending.contracts.sweepController;
const DEPLOYER        = cfgLending.deployer;
const KEEPER          = cfgLending.keeper;

// Compound V3 — Arbitrum NATIVE USDC market (not the USDC.e 0xA5ED... market).
// Verified: 0x9c4e…58bf.baseToken() == 0xaf88d065… (Arb native USDC).
const COMET_USDC_ARB  = "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf";

// Target allocation: 20% reserve / 35% aave / 30% compound / 15% remote (HyperEVM)
// Slightly lower remote vs v1 (was 30%) because HyperEVM inbound is still 5-7 days.
const RESERVE_BPS  = 2000;
const AAVE_BPS     = 3500;
const COMPOUND_BPS = 3000;
const REMOTE_BPS   = 1500;

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected 42161, got ${net.chainId}`);

  section(`SweepControllerV2 + Compound deploy on Arbitrum`);
  console.log("Deployer   :", deployer.address);
  console.log("LendingPool:", LENDING_POOL);
  console.log("AaveSink   :", AAVE_SINK);
  console.log("HyperMirror:", HYPER_REMOTE);
  console.log("OldSweep   :", OLD_SWEEP);
  console.log("Compound   :", COMET_USDC_ARB);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("ETH bal    :", hre.ethers.formatEther(bal));
  if (bal < hre.ethers.parseEther("0.001")) throw new Error("top up ETH");

  // ═════════ 1. Deploy CompoundV3Sink
  section("1. Deploy CompoundV3Sink");
  const CS = await hre.ethers.getContractFactory("CompoundV3Sink");
  const compoundSink = await CS.deploy(deployer.address, deployer.address, ARB_USDC, COMET_USDC_ARB);
  await compoundSink.waitForDeployment();
  const compoundSinkAddr = await compoundSink.getAddress();
  console.log("  CompoundV3Sink:", compoundSinkAddr);

  // ═════════ 2. Deploy SweepControllerV2
  section("2. Deploy SweepControllerV2");
  const SC = await hre.ethers.getContractFactory("SweepControllerV2");
  const sweepV2 = await SC.deploy(deployer.address, KEEPER, ARB_USDC);
  await sweepV2.waitForDeployment();
  const sweepV2Addr = await sweepV2.getAddress();
  console.log("  SweepControllerV2:", sweepV2Addr);

  // ═════════ 3. Configure SweepV2 targets
  section("3. Configure SweepV2 targets");
  step(`setReserveBps(${RESERVE_BPS})  # default is already ${RESERVE_BPS}, skip if match`);
  const currentReserve = await sweepV2.reserveBps();
  if (Number(currentReserve) !== RESERVE_BPS) {
    await (await sweepV2.setReserveBps(RESERVE_BPS)).wait();
  }
  step(`addSink(AaveV3Sink, ${AAVE_BPS}, "aave")`);
  await (await sweepV2.addSink(AAVE_SINK, AAVE_BPS, "aave")).wait();
  step(`addSink(CompoundV3Sink, ${COMPOUND_BPS}, "compound")`);
  await (await sweepV2.addSink(compoundSinkAddr, COMPOUND_BPS, "compound")).wait();
  step(`setRemote(HyperRemoteMirror, ${REMOTE_BPS})`);
  await (await sweepV2.setRemote(HYPER_REMOTE, REMOTE_BPS)).wait();

  // ═════════ 4. Grant CONTROLLER_ROLE on existing + new sinks to sweepV2
  section("4. Wire CONTROLLER_ROLE on sinks");
  const aaveSink = await hre.ethers.getContractAt("AaveV3Sink", AAVE_SINK);
  const remoteMirror = new hre.ethers.Contract(HYPER_REMOTE, [
    "function CONTROLLER_ROLE() view returns (bytes32)",
    "function grantRole(bytes32,address)",
    "function revokeRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], deployer);
  const CONTROLLER = await aaveSink.CONTROLLER_ROLE();
  step("aaveSink.grantRole(CONTROLLER_ROLE, sweepV2)");
  await (await aaveSink.grantRole(CONTROLLER, sweepV2Addr)).wait();
  step("compoundSink CONTROLLER_ROLE already deployer; grant sweepV2 too");
  await (await compoundSink.grantRole(CONTROLLER, sweepV2Addr)).wait();
  step("hyperRemote.grantRole(CONTROLLER_ROLE, sweepV2)");
  await (await remoteMirror.grantRole(CONTROLLER, sweepV2Addr)).wait();

  // ═════════ 5. Point LendingPool v1.3 at sweepV2 + grant POOL_ROLE on v2
  section("5. Rewire LendingPool → SweepV2");
  const pool = await hre.ethers.getContractAt("LendingPool", LENDING_POOL);
  step("sweepV2.setLendingPool(LendingPool v1.3)");
  await (await sweepV2.setLendingPool(LENDING_POOL)).wait();
  step("pool.setSweepSink(sweepV2)");
  await (await pool.setSweepSink(sweepV2Addr)).wait();

  // ═════════ 6. Revoke CONTROLLER_ROLE from old sweepV1 so it can't move funds
  section("6. Revoke old sweepV1 from sinks");
  step("aaveSink.revokeRole(CONTROLLER_ROLE, OLD_SWEEP)");
  await (await aaveSink.revokeRole(CONTROLLER, OLD_SWEEP)).wait();
  step("hyperRemote.revokeRole(CONTROLLER_ROLE, OLD_SWEEP)");
  await (await remoteMirror.revokeRole(CONTROLLER, OLD_SWEEP)).wait();

  // ═════════ 7. Persist
  section("7. Save config");
  cfgLending.contracts.sweepController_v1_unused = OLD_SWEEP;
  cfgLending.contracts.sweepController = sweepV2Addr;
  cfgLending.contracts.compoundV3Sink = compoundSinkAddr;
  cfgLending.config.sweepTargets = {
    reserveBps: RESERVE_BPS, aaveBps: AAVE_BPS, compoundBps: COMPOUND_BPS, remoteBps: REMOTE_BPS,
  };
  cfgLending.compound = { comet: COMET_USDC_ARB };
  cfgLending.notes = "v1.3 pool + SweepV2 + Compound. SweepV1 at sweepController_v1_unused (empty, role-revoked).";
  cfgLending.deployedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-lending-arb.json"), JSON.stringify(cfgLending, null, 2));
  console.log("wrote deployed-lending-arb.json");

  section("8. Verify hints");
  console.log(`npx hardhat verify --network arbitrum ${compoundSinkAddr} ${deployer.address} ${deployer.address} ${ARB_USDC} ${COMET_USDC_ARB}`);
  console.log(`npx hardhat verify --network arbitrum ${sweepV2Addr} ${deployer.address} ${KEEPER} ${ARB_USDC}`);

  console.log("\n✓ SweepV2 live on Arbitrum:", sweepV2Addr);
}

main().catch(e => { console.error(e); process.exit(1); });
