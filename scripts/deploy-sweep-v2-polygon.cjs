// Deploy on Polygon:
//   1. AaveV3Sink (wrapping Polygon Aave V3 USDC native market)
//   2. SweepControllerV2 with reserve + aave targets (no compound, no remote —
//      Polygon has no native-USDC Comet yet and no HyperEVM leg)
//   3. Wire pool → sweep → aave
//
// Polygon Aave V3:
//   Pool     : 0x794a61358D6845594F94dc1DB02A252b5b4814aD
//   aUSDC-n  : 0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD (native USDC aToken)

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg = require("../config/deployed-polygon-stack.json");

const POLY_USDC        = cfg.usdc; // 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
const LENDING_POOL     = cfg.contracts.lendingPool;
const DEPLOYER         = cfg.deployer;
const KEEPER           = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB"; // reuse Arb keeper EOA

const AAVE_POOL_POLY   = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AUSDC_POLY       = "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD";

// Targets: 30% reserve / 70% aave. No compound (no native market), no remote (no HyperEVM on Poly).
const RESERVE_BPS = 3000;
const AAVE_BPS    = 7000;

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 137) throw new Error(`Expected 137, got ${net.chainId}`);

  section("SweepV2 + AaveSink deploy on Polygon");
  console.log("Deployer :", deployer.address);
  console.log("Pool     :", LENDING_POOL);
  console.log("USDC     :", POLY_USDC);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("POL bal  :", hre.ethers.formatEther(bal));

  // ═════════ 1. AaveV3Sink
  section("1. Deploy AaveV3Sink (Polygon)");
  const AS = await hre.ethers.getContractFactory("AaveV3Sink");
  const aaveSink = await AS.deploy(deployer.address, deployer.address, POLY_USDC, AUSDC_POLY, AAVE_POOL_POLY);
  await aaveSink.waitForDeployment();
  const aaveSinkAddr = await aaveSink.getAddress();
  console.log("  AaveV3Sink:", aaveSinkAddr);

  // ═════════ 2. SweepControllerV2
  section("2. Deploy SweepControllerV2 (Polygon)");
  const SC = await hre.ethers.getContractFactory("SweepControllerV2");
  const sweep = await SC.deploy(deployer.address, KEEPER, POLY_USDC);
  await sweep.waitForDeployment();
  const sweepAddr = await sweep.getAddress();
  console.log("  SweepV2:", sweepAddr);

  // ═════════ 3. Configure targets
  section("3. Configure targets (reserve 30% / aave 70%)");
  step(`setReserveBps(${RESERVE_BPS})`);
  await (await sweep.setReserveBps(RESERVE_BPS)).wait();
  step(`addSink(AaveV3Sink, ${AAVE_BPS}, "aave")`);
  await (await sweep.addSink(aaveSinkAddr, AAVE_BPS, "aave")).wait();

  // ═════════ 4. Grant CONTROLLER_ROLE to sweep on aave sink
  section("4. Wire CONTROLLER_ROLE on AaveSink → sweep");
  const CONTROLLER = await aaveSink.CONTROLLER_ROLE();
  await (await aaveSink.grantRole(CONTROLLER, sweepAddr)).wait();

  // ═════════ 5. Wire pool ↔ sweep
  section("5. Wire LendingPool ↔ sweep");
  const pool = await hre.ethers.getContractAt("LendingPool", LENDING_POOL);
  step("sweep.setLendingPool(LendingPool)");
  await (await sweep.setLendingPool(LENDING_POOL)).wait();
  step("pool.setSweepSink(sweep)");
  await (await pool.setSweepSink(sweepAddr)).wait();

  // ═════════ 6. Persist
  section("6. Save config");
  cfg.contracts.aaveV3Sink = aaveSinkAddr;
  cfg.contracts.sweepController = sweepAddr;
  cfg.aave = { pool: AAVE_POOL_POLY, aUsdc: AUSDC_POLY };
  cfg.config = cfg.config || {};
  cfg.config.sweepTargets = { reserveBps: RESERVE_BPS, aaveBps: AAVE_BPS };
  cfg.deployedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-polygon-stack.json"), JSON.stringify(cfg, null, 2));
  console.log("wrote deployed-polygon-stack.json");

  section("7. Verify hints");
  console.log(`npx hardhat verify --network polygon ${aaveSinkAddr} ${deployer.address} ${deployer.address} ${POLY_USDC} ${AUSDC_POLY} ${AAVE_POOL_POLY}`);
  console.log(`npx hardhat verify --network polygon ${sweepAddr} ${deployer.address} ${KEEPER} ${POLY_USDC}`);

  console.log("\n✓ SweepV2 + AaveSink live on Polygon");
}

main().catch(e => { console.error(e); process.exit(1); });
