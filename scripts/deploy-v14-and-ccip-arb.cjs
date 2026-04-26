// Arb: deploy LendingPool v1.4 + NFTValuer v2 (with VAULT_MIRROR mode) +
// ArbPositionWrapper, rewire everything.
//
// Pre-check: v1.3 pool must be empty (no shares, no loans, no reserve).
// Same drain-and-redeploy pattern as v1.2→v1.3.
//
// Sequence:
//   1. Deploy NFTValuer v2 (new mode).
//   2. Re-configure Pool A-D on NFTValuer v2 (same as old valuer).
//   3. Deploy LendingPool v1.4.
//   4. Wire v1.4: setValuer(v2), setMarketplace(existing), setSweepSink.
//   5. Grant v1.4 POOL_ROLE on SweepControllerV2, revoke on v1.3.
//   6. Grant v1.4 LIQUIDATOR_ROLE on EcosystemMarketplace.
//   7. Rewire RoyaltyRouter.setLendingPool(v1.4).
//   8. Pause v1.3, revoke its POOL_ROLE and LIQUIDATOR_ROLE if any.
//   9. Deploy ArbPositionWrapper (CCIP receiver).
//  10. Register wrapper as a collection under digger #1, LTV 5000bps.
//  11. Configure NFTValuer v2 in VAULT_MIRROR mode for the wrapper.
//  12. Persist addresses + print verify commands.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfgLending = require("../config/deployed-lending-arb.json");
const cfgMarketplace = require("../config/deployed-marketplace-arb.json");

const ARB_USDC   = cfgLending.usdc;
const REGISTRY   = cfgMarketplace.contracts.diggerRegistry;
const ROUTER     = cfgMarketplace.contracts.royaltyRouter;
const MARKETPLACE = cfgMarketplace.contracts.marketplace;
const OLD_VALUER = cfgMarketplace.contracts.nftValuer;
const OLD_POOL   = cfgLending.contracts.lendingPool;        // v1.3
const SWEEP      = cfgLending.contracts.sweepController;    // v2
const DEPLOYER   = cfgLending.deployer;

// CCIP mainnet config — Polygon ↔ Arbitrum
const CCIP_ROUTER_ARB = "0x141fa059441E0ca23ce184B6A78bafD2A517DdE8";
const POLY_SELECTOR    = 4051577828743386545n;
const LINK_ARB         = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";

// Arb V15 pools (same as NFTValuer v1 config)
const POOLS = [
  { label: "A", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a", vault: "0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa" },
  { label: "B", nft: "0x67940CD1D7000494433B1Be44Dde494994393174", vault: "0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce" },
  { label: "C", nft: "0x9C86B7C9f4195d3d5150A39983ca0536353109f6", vault: "0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1" },
  { label: "D", nft: "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", vault: "0x109B722501A713E48465cA0509E8724f6640b9D4" },
];

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected 42161, got ${net.chainId}`);

  section("v1.4 + NFTValuer v2 + CCIP wrapper deploy on Arbitrum");
  console.log("Deployer:", deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("ETH bal :", hre.ethers.formatEther(bal));

  // Safety: v1.3 pool must be empty.
  const oldPool = await hre.ethers.getContractAt("LendingPool", OLD_POOL);
  const totalShares = await oldPool.totalShares();
  const totalBorrowed = await oldPool.totalBorrowed();
  const reserve = await oldPool.protocolReserve();
  if (totalShares !== 0n || totalBorrowed !== 0n || reserve !== 0n) {
    throw new Error(`v1.3 pool NOT empty: shares=${totalShares} borrowed=${totalBorrowed} reserve=${reserve}`);
  }
  console.log("v1.3 pool empty ✓");

  // ═════════ 1. NFTValuer v2
  section("1. Deploy NFTValuer v2 (adds VAULT_MIRROR mode)");
  const V = await hre.ethers.getContractFactory("NFTValuer");
  const valuer = await V.deploy(deployer.address, REGISTRY);
  await valuer.waitForDeployment();
  const valuerAddr = await valuer.getAddress();
  console.log("  NFTValuer v2:", valuerAddr);

  // ═════════ 2. Reconfigure Pool A-D on v2
  section("2. Reconfigure Pool A-D in VAULT_POSITION");
  for (const p of POOLS) {
    step(`setVaultMode(${p.label})`);
    await (await valuer.setVaultMode(p.nft, p.vault, 0)).wait();
  }

  // ═════════ 3. Deploy LendingPool v1.4
  section("3. Deploy LendingPool v1.4");
  const L = await hre.ethers.getContractFactory("LendingPool");
  const pool = await L.deploy(deployer.address, ARB_USDC, REGISTRY);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("  LendingPool v1.4:", poolAddr);

  // ═════════ 4. Wire v1.4
  section("4. Wire v1.4");
  step("pool.setValuer(NFTValuer v2)");
  await (await pool.setValuer(valuerAddr)).wait();
  step("pool.setMarketplace(EcosystemMarketplace)");
  await (await pool.setMarketplace(MARKETPLACE)).wait();
  step("pool.setSweepSink(SweepControllerV2)");
  await (await pool.setSweepSink(SWEEP)).wait();

  // ═════════ 5. SweepController rewire
  section("5. SweepControllerV2 rewire → v1.4");
  const sweep = new hre.ethers.Contract(
    SWEEP,
    [
      "function setLendingPool(address)",
      "function POOL_ROLE() view returns (bytes32)",
      "function revokeRole(bytes32,address)",
    ],
    deployer,
  );
  step("sweep.setLendingPool(v1.4)");
  await (await sweep.setLendingPool(poolAddr)).wait();
  const POOL_ROLE = await sweep.POOL_ROLE();
  step("sweep.revokeRole(POOL_ROLE, v1.3)");
  await (await sweep.revokeRole(POOL_ROLE, OLD_POOL)).wait();

  // ═════════ 6. Marketplace LIQUIDATOR_ROLE
  section("6. Marketplace.grantRole(LIQUIDATOR_ROLE, v1.4)");
  const marketplace = new hre.ethers.Contract(
    MARKETPLACE,
    [
      "function LIQUIDATOR_ROLE() view returns (bytes32)",
      "function grantRole(bytes32,address)",
      "function revokeRole(bytes32,address)",
    ],
    deployer,
  );
  const LIQUIDATOR_ROLE = await marketplace.LIQUIDATOR_ROLE();
  await (await marketplace.grantRole(LIQUIDATOR_ROLE, poolAddr)).wait();

  // ═════════ 7. RoyaltyRouter supplier-cut → v1.4
  section("7. RoyaltyRouter.setLendingPool(v1.4)");
  const router = new hre.ethers.Contract(ROUTER, ["function setLendingPool(address)"], deployer);
  await (await router.setLendingPool(poolAddr)).wait();

  // ═════════ 8. Retire v1.3
  section("8. Pause v1.3 + revoke its marketplace role");
  try {
    await (await oldPool.pause()).wait();
    console.log("  v1.3 paused ✓");
  } catch (e) {
    console.log("  (v1.3 pause skipped — may already be paused)");
  }
  try {
    await (await marketplace.revokeRole(LIQUIDATOR_ROLE, OLD_POOL)).wait();
    console.log("  v1.3 LIQUIDATOR_ROLE revoked ✓");
  } catch (e) {
    console.log("  (v1.3 had no LIQUIDATOR_ROLE — skip)");
  }

  // ═════════ 9. ArbPositionWrapper
  section("9. Deploy ArbPositionWrapper");
  const W = await hre.ethers.getContractFactory("ArbPositionWrapper");
  // LINK fee mode (set link=0 for native). Using LINK is cleaner for a
  // contract-initiated burnAndRedeem keeper flow later.
  const wrapper = await W.deploy(deployer.address, CCIP_ROUTER_ARB, POLY_SELECTOR, LINK_ARB);
  await wrapper.waitForDeployment();
  const wrapperAddr = await wrapper.getAddress();
  console.log("  ArbPositionWrapper:", wrapperAddr);

  // ═════════ 10. Register wrapper as collection under digger #1
  section("10. Register wrapper in DiggerRegistry");
  const registry = await hre.ethers.getContractAt("DiggerRegistry", REGISTRY);
  await (await registry.registerCollection(1n, wrapperAddr, hre.ethers.ZeroAddress, 5000)).wait();
  console.log("  registered wrapper as digger #1 collection, 50% LTV");

  // ═════════ 11. Configure valuer VAULT_MIRROR for wrapper
  section("11. valuer.setMirrorMode(wrapper, wrapper)");
  // The wrapper implements IVaultValue itself, so source == wrapper.
  await (await valuer.setMirrorMode(wrapperAddr, wrapperAddr, 0)).wait();
  const [mode, src] = await valuer.configOf(wrapperAddr);
  const modeStr = ["NONE","VAULT_POSITION","FLOOR_ORACLE","STATIC_USDC","VAULT_MIRROR"][Number(mode)];
  console.log(`  readback: mode=${modeStr} source=${src}`);
  if (modeStr !== "VAULT_MIRROR") throw new Error("mirror mode readback mismatch");

  // ═════════ 12. Persist
  section("12. Save config");
  cfgLending.contracts.lendingPool_v1_3_unused = OLD_POOL;
  cfgLending.contracts.lendingPool = poolAddr;
  cfgLending.contracts.nftValuer_v1_unused = OLD_VALUER;
  cfgLending.contracts.nftValuer = valuerAddr;
  cfgLending.contracts.arbPositionWrapper = wrapperAddr;
  cfgLending.ccip = {
    router: CCIP_ROUTER_ARB,
    polySelector: POLY_SELECTOR.toString(),
    link: LINK_ARB,
  };
  cfgLending.deployedAt = new Date().toISOString();
  cfgLending.notes = "v1.4 + NFTValuer v2 (VAULT_MIRROR) + ArbPositionWrapper. Wrapper registered as collection, valuer VAULT_MIRROR mode.";
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-lending-arb.json"), JSON.stringify(cfgLending, null, 2));

  // Also update marketplace config to point at the new valuer.
  cfgMarketplace.contracts.nftValuer_v1_unused = OLD_VALUER;
  cfgMarketplace.contracts.nftValuer = valuerAddr;
  cfgMarketplace.contracts.arbPositionWrapper = wrapperAddr;
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-marketplace-arb.json"), JSON.stringify(cfgMarketplace, null, 2));
  console.log("wrote deployed-lending-arb.json + deployed-marketplace-arb.json");

  section("Verify hints");
  console.log(`npx hardhat verify --network arbitrum ${valuerAddr} ${deployer.address} ${REGISTRY}`);
  console.log(`npx hardhat verify --network arbitrum ${poolAddr} ${deployer.address} ${ARB_USDC} ${REGISTRY}`);
  console.log(`npx hardhat verify --network arbitrum ${wrapperAddr} ${deployer.address} ${CCIP_ROUTER_ARB} ${POLY_SELECTOR} ${LINK_ARB}`);
  console.log("\n✓ Arb v1.4 + wrapper live");
}

main().catch(e => { console.error(e); process.exit(1); });
