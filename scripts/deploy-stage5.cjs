// Stage 5 redeploy: RevenueRouter (Arb) + RevenueRouterHC (HyperEVM) +
// HyperRemoteMirror (Arb), all with rescue. Old contracts become zombies.
//
// Rewire:
//   - SweepControllerV2 (Arb): setRemote(new HyperRemoteMirror)
//   - Pool E v2 (Hyper): setRevenueRouter? (depends on vault interface)
//     → actually, V15 revenue router is read by vaults on deposit fees; it's
//       a setter. For the router v1 on Hyper, every Pool E v2 vault uses it
//       already. We replace by setting the new addr on every consumer.
//
// Run per chain.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const balBefore = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`chain ${chainId} | deployer ${deployer.address} | bal ${hre.ethers.formatEther(balBefore)}`);

  if (chainId === 42161) {
    // ── Arb ─────────────────────────────────────────────────────
    const arbCfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "deployed.json"), "utf8"));
    const lendCfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"), "utf8"));

    const admin = deployer.address;
    const OLD_ROUTER = arbCfg.core.revenueRouter;
    const OLD_MIRROR = lendCfg.contracts.hyperRemoteMirror;
    const USDC       = lendCfg.usdc;
    const TREASURY   = lendCfg.treasury;
    const KEEPER     = lendCfg.keeper;
    const SWEEP_V2   = lendCfg.contracts.sweepController;

    // RevenueRouter expects a "seeder" address — carry over from old if available.
    console.log("\n1. Read old RevenueRouter seeder");
    const oldR = await hre.ethers.getContractAt("RevenueRouter", OLD_ROUTER);
    const seeder = await oldR.seeder();
    console.log("   seeder:", seeder);
    const treasuryOld = await oldR.treasury();
    console.log("   treasury:", treasuryOld);

    console.log("\n2. Deploy new RevenueRouter");
    const RR = await hre.ethers.getContractFactory("RevenueRouter");
    const router = await RR.deploy(admin, seeder, treasuryOld);
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();
    console.log("   ", routerAddr);

    console.log("\n3. Deploy new HyperRemoteMirror");
    // Look up constructor fields from old contract
    const oldM = await hre.ethers.getContractAt("HyperRemoteMirror", OLD_MIRROR);
    const oldPayout = await oldM.keeperPayoutWallet();
    // Controller is the SweepV2 address; keeper same as old
    const HM = await hre.ethers.getContractFactory("HyperRemoteMirror");
    const mirror = await HM.deploy(admin, SWEEP_V2, KEEPER, USDC, oldPayout);
    await mirror.waitForDeployment();
    const mirrorAddr = await mirror.getAddress();
    console.log("   ", mirrorAddr);

    console.log("\n4. SweepV2.setRemote(newMirror)");
    const sweep = await hre.ethers.getContractAt("SweepControllerV2", SWEEP_V2);
    try {
      await (await sweep.setRemote(mirrorAddr)).wait();
      console.log("   done");
    } catch (e) { console.log("   (no setRemote — check SweepControllerV2 ABI;", (e.shortMessage||e.message).slice(0,80), ")"); }

    // Persist
    arbCfg.core.revenueRouter_v1_unused = OLD_ROUTER;
    arbCfg.core.revenueRouter = routerAddr;
    fs.writeFileSync(path.resolve(__dirname, "..", "config", "deployed.json"), JSON.stringify(arbCfg, null, 2));

    lendCfg.contracts.hyperRemoteMirror_v1_unused = OLD_MIRROR;
    lendCfg.contracts.hyperRemoteMirror = mirrorAddr;
    lendCfg.redeployedAt = new Date().toISOString();
    fs.writeFileSync(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"), JSON.stringify(lendCfg, null, 2));

    console.log("\n═══ Arb Stage 5 summary ═══");
    console.log("RevenueRouter      :", routerAddr);
    console.log("HyperRemoteMirror  :", mirrorAddr);
  } else if (chainId === 999) {
    // ── HyperEVM ────────────────────────────────────────────────
    const peCfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"), "utf8"));
    const admin = deployer.address;
    const USDC     = peCfg.usdc;
    const TREASURY = peCfg.treasury;
    const OLD_ROUTER = peCfg.revenueRouter;
    const oldR = await hre.ethers.getContractAt("RevenueRouterHC", OLD_ROUTER);
    const seeder = await oldR.seeder();
    console.log("   old router   :", OLD_ROUTER);
    console.log("   seeder       :", seeder);

    console.log("\n1. Deploy new RevenueRouterHC");
    const RR = await hre.ethers.getContractFactory("RevenueRouterHC");
    const router = await RR.deploy(admin, USDC, seeder, TREASURY);
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();
    console.log("   ", routerAddr);

    peCfg.revenueRouter_v1_unused = OLD_ROUTER;
    peCfg.revenueRouter = routerAddr;
    peCfg.redeployedAt = new Date().toISOString();
    fs.writeFileSync(path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"), JSON.stringify(peCfg, null, 2));

    console.log("\n═══ HyperEVM Stage 5 summary ═══");
    console.log("RevenueRouterHC    :", routerAddr);
    console.log("\nNOTE: Pool E v2 vault + adapter may reference the old router.");
    console.log("If they have a setRevenueRouter or similar setter, call it separately.");
  } else {
    throw new Error(`unsupported chain ${chainId}`);
  }

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\nNative spent: ${hre.ethers.formatEther(balBefore - balAfter)}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
