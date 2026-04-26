// Deploy the Phase 3 lending stack on Arbitrum.
//
// Order:
//   1. LendingPool         (admin=deployer, USDC, DiggerRegistry from Phase 2)
//   2. AaveV3Sink          (admin, controller=deployer-temp, USDC, aUSDC, Aave V3 Pool)
//   3. HyperRemoteMirror   (admin, controller=deployer-temp, keeper, USDC, keeper EOA payout wallet)
//   4. SweepController     (admin, keeper, USDC, AaveV3Sink, HyperRemoteMirror)
//   5. Wire roles:
//        - aaveSink.grantRole(CONTROLLER_ROLE, sweepController)
//        - remote.grantRole(CONTROLLER_ROLE, sweepController)
//        - sweepController.setLendingPool(lendingPool)
//        - lendingPool.setSweepSink(sweepController)        (informational v1)
//        - royaltyRouter.setLendingPool(lendingPool)        (Phase 2 → 3 wire)
//
// Deployer-temp on the sinks is a placeholder — admin transfers control to
// the real SweepController in step 5. Until then, deployer can manually
// move funds in/out for smoke tests.
//
// Saves config: config/deployed-lending-arb.json

const hre = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const ARB_USDC          = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARB_AUSDC         = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
const ARB_AAVE_V3_POOL  = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const TREASURY_SAFE     = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const KEEPER_EOA        = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";

// Pull DiggerRegistry from the Phase 2 deploy.
const phase2 = require("../config/deployed-marketplace-arb.json");
const REGISTRY  = phase2.contracts.diggerRegistry;
const ROUTER    = phase2.contracts.royaltyRouter;

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const a = await c.getAddress();
  console.log(`  ${name}: ${a}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected Arbitrum, got ${net.chainId}`);
  const balEth = await hre.ethers.provider.getBalance(deployer.address);

  section(`Lending stack deploy on Arbitrum (${net.chainId})`);
  console.log("Deployer    :", deployer.address);
  console.log("Treasury    :", TREASURY_SAFE);
  console.log("Keeper EOA  :", KEEPER_EOA);
  console.log("USDC        :", ARB_USDC);
  console.log("aUSDC       :", ARB_AUSDC);
  console.log("Aave V3 Pool:", ARB_AAVE_V3_POOL);
  console.log("Registry    :", REGISTRY);
  console.log("Router      :", ROUTER);
  console.log("ETH bal     :", hre.ethers.formatEther(balEth));
  if (balEth < hre.ethers.parseEther("0.001")) throw new Error("deployer ETH < 0.001");

  step("1. LendingPool");
  const pool = await deploy("LendingPool", [deployer.address, ARB_USDC, REGISTRY]);

  step("2. AaveV3Sink (controller=deployer-temp; rotated to SweepController in step 5)");
  const aaveSink = await deploy("AaveV3Sink", [
    deployer.address, deployer.address, ARB_USDC, ARB_AUSDC, ARB_AAVE_V3_POOL,
  ]);

  step("3. HyperRemoteMirror (controller=deployer-temp; rotated)");
  const remote = await deploy("HyperRemoteMirror", [
    deployer.address, deployer.address, KEEPER_EOA, ARB_USDC, KEEPER_EOA, /* keeper payout EOA */
  ]);

  step("4. SweepController");
  const sweep = await deploy("SweepController", [
    deployer.address, KEEPER_EOA, ARB_USDC,
    await aaveSink.getAddress(), await remote.getAddress(),
  ]);

  // ═════════ 5. Wire roles
  section("5. Wire roles");

  step("aaveSink → grant CONTROLLER_ROLE to sweepController");
  const aaveCtrlRole = await aaveSink.CONTROLLER_ROLE();
  await (await aaveSink.grantRole(aaveCtrlRole, await sweep.getAddress())).wait();

  step("remote → grant CONTROLLER_ROLE to sweepController");
  const remoteCtrlRole = await remote.CONTROLLER_ROLE();
  await (await remote.grantRole(remoteCtrlRole, await sweep.getAddress())).wait();

  step("sweepController → setLendingPool(LendingPool)");
  await (await sweep.setLendingPool(await pool.getAddress())).wait();

  step("LendingPool → setSweepSink(SweepController) (informational; auto-pull is v1.1)");
  await (await pool.setSweepSink(await sweep.getAddress())).wait();

  step("RoyaltyRouter (Phase 2) → setLendingPool(LendingPool) — supplier-cut now flows here");
  const router = new hre.ethers.Contract(
    ROUTER,
    ["function setLendingPool(address)"],
    deployer,
  );
  await (await router.setLendingPool(await pool.getAddress())).wait();

  // ═════════ 6. Persist
  section("6. Save config");
  const out = {
    chainId: Number(net.chainId),
    network: "arbitrum",
    usdc: ARB_USDC,
    ausdc: ARB_AUSDC,
    aaveV3Pool: ARB_AAVE_V3_POOL,
    treasury: TREASURY_SAFE,
    keeper: KEEPER_EOA,
    deployer: deployer.address,
    diggerRegistry: REGISTRY,
    royaltyRouter: ROUTER,
    contracts: {
      lendingPool: await pool.getAddress(),
      aaveV3Sink: await aaveSink.getAddress(),
      hyperRemoteMirror: await remote.getAddress(),
      sweepController: await sweep.getAddress(),
    },
    config: {
      borrowAprBps: 800,
      protocolReserveBps: 3000,
      liquidationBufferBps: 1000,
      liquidationBonusBps: 500,
      minLoanDuration: 60 * 60,
      minSupplyHold: 6 * 60 * 60,
      sweepTargets: { reserveBps: 2000, aaveBps: 5000, remoteBps: 3000 },
    },
    deployedAt: new Date().toISOString(),
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-lending-arb.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("wrote", outfile);

  section("Next steps");
  console.log("1. Verify all contracts on Arbiscan:");
  console.log(`   npx hardhat verify --network arbitrum ${await pool.getAddress()} \\`);
  console.log(`     ${deployer.address} ${ARB_USDC} ${REGISTRY}`);
  console.log("");
  console.log("2. Seed the pool with USDC supply (for testing borrow flow).");
  console.log("3. Push UI bundle: src/abi/lending.ts");
  console.log("4. (Optional) Deploy + start keeper for sweep rebalance + cross-chain.");
  console.log("");
  console.log("Addresses:");
  console.log(JSON.stringify(out.contracts, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
