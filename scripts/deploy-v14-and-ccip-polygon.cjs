// Polygon: deploy LendingPool v1.4 + NFTValuer v2 + PolygonNFTLocker,
// re-register Pool A/B/C/D, rewire pool ↔ sweep ↔ valuer.
//
// Pre-check: existing Polygon v1.3 pool must be empty.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg = require("../config/deployed-polygon-stack.json");

const POLY_USDC      = cfg.usdc;
const REGISTRY       = cfg.contracts.diggerRegistry;
const ROUTER         = cfg.contracts.royaltyRouter;
const MARKETPLACE    = cfg.contracts.marketplace;
const OLD_VALUER     = cfg.contracts.nftValuer;
const OLD_POOL       = cfg.contracts.lendingPool;
const SWEEP          = cfg.contracts.sweepController;

// CCIP mainnet Polygon config
const CCIP_ROUTER_POLY = "0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe";
const ARB_SELECTOR     = 4949039107694359620n;
const LINK_POLY        = "0xb0897686c545045aFc77CF20EB7b720d195c8bF6";
const KEEPER           = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";

const POOLS = [
  { label: "A", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c", vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf" },
  { label: "B", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8", vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4" },
  { label: "C", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7", vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF" },
  { label: "D", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309", vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08" },
];

function section(t) { console.log("\n" + "━".repeat(72) + "\n" + t + "\n" + "━".repeat(72)); }
function step(m)    { console.log(`\n→ ${m}`); }

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 137) throw new Error(`Expected 137, got ${net.chainId}`);

  section("Polygon v1.4 + valuer v2 + PolygonNFTLocker deploy");
  console.log("Deployer:", deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("POL bal :", hre.ethers.formatEther(bal));

  // Pre-check: old pool must be empty
  const oldPool = await hre.ethers.getContractAt("LendingPool", OLD_POOL);
  const sh = await oldPool.totalShares();
  const bw = await oldPool.totalBorrowed();
  const rs = await oldPool.protocolReserve();
  if (sh !== 0n || bw !== 0n || rs !== 0n) throw new Error(`old Poly pool not empty: ${sh}/${bw}/${rs}`);
  console.log("Polygon v1.3 pool empty ✓");

  // ═════════ 1. NFTValuer v2
  section("1. NFTValuer v2");
  const V = await hre.ethers.getContractFactory("NFTValuer");
  const valuer = await V.deploy(deployer.address, REGISTRY);
  await valuer.waitForDeployment();
  const valuerAddr = await valuer.getAddress();
  console.log("  NFTValuer v2:", valuerAddr);

  // ═════════ 2. Reconfigure Pool A-D
  section("2. Reconfigure Pool A-D");
  for (const p of POOLS) {
    step(`setVaultMode(${p.label})`);
    await (await valuer.setVaultMode(p.nft, p.vault, 0)).wait();
  }

  // ═════════ 3. LendingPool v1.4
  section("3. LendingPool v1.4");
  const L = await hre.ethers.getContractFactory("LendingPool");
  const pool = await L.deploy(deployer.address, POLY_USDC, REGISTRY);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("  LendingPool v1.4:", poolAddr);

  // ═════════ 4. Wire v1.4
  section("4. Wire v1.4");
  await (await pool.setValuer(valuerAddr)).wait();
  await (await pool.setMarketplace(MARKETPLACE)).wait();
  await (await pool.setSweepSink(SWEEP)).wait();

  // ═════════ 5. SweepV2 rewire
  section("5. SweepV2 rewire → v1.4");
  const sweep = new hre.ethers.Contract(
    SWEEP,
    ["function setLendingPool(address)","function POOL_ROLE() view returns (bytes32)","function revokeRole(bytes32,address)"],
    deployer,
  );
  await (await sweep.setLendingPool(poolAddr)).wait();
  const POOL_ROLE = await sweep.POOL_ROLE();
  await (await sweep.revokeRole(POOL_ROLE, OLD_POOL)).wait();

  // ═════════ 6. Marketplace LIQUIDATOR_ROLE + RoyaltyRouter
  section("6. Marketplace LIQUIDATOR_ROLE + Router rewire");
  const marketplace = new hre.ethers.Contract(
    MARKETPLACE,
    ["function LIQUIDATOR_ROLE() view returns (bytes32)","function grantRole(bytes32,address)","function revokeRole(bytes32,address)"],
    deployer,
  );
  const LIQ = await marketplace.LIQUIDATOR_ROLE();
  await (await marketplace.grantRole(LIQ, poolAddr)).wait();
  const router = new hre.ethers.Contract(ROUTER, ["function setLendingPool(address)"], deployer);
  await (await router.setLendingPool(poolAddr)).wait();

  // ═════════ 7. Retire v1.3
  section("7. Retire v1.3");
  try { await (await oldPool.pause()).wait(); console.log("  v1.3 paused ✓"); } catch {}
  try { await (await marketplace.revokeRole(LIQ, OLD_POOL)).wait(); } catch {}

  // ═════════ 8. PolygonNFTLocker
  section("8. Deploy PolygonNFTLocker");
  const PL = await hre.ethers.getContractFactory("PolygonNFTLocker");
  const locker = await PL.deploy(deployer.address, KEEPER, CCIP_ROUTER_POLY, ARB_SELECTOR, LINK_POLY);
  await locker.waitForDeployment();
  const lockerAddr = await locker.getAddress();
  console.log("  PolygonNFTLocker:", lockerAddr);

  // ═════════ 9. Wire locker vaults for Pool A-D
  section("9. Locker.setVaultFor(Pool A-D)");
  for (const p of POOLS) {
    step(`setVaultFor(${p.label})`);
    await (await locker.setVaultFor(p.nft, p.vault)).wait();
  }

  // ═════════ 10. Persist
  section("10. Save config");
  cfg.contracts.lendingPool_v1_3_unused = OLD_POOL;
  cfg.contracts.lendingPool = poolAddr;
  cfg.contracts.nftValuer_v1_unused = OLD_VALUER;
  cfg.contracts.nftValuer = valuerAddr;
  cfg.contracts.polygonNFTLocker = lockerAddr;
  cfg.ccip = {
    router: CCIP_ROUTER_POLY,
    arbSelector: ARB_SELECTOR.toString(),
    link: LINK_POLY,
  };
  cfg.deployedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-polygon-stack.json"), JSON.stringify(cfg, null, 2));

  section("Verify hints");
  console.log(`npx hardhat verify --network polygon ${valuerAddr} ${deployer.address} ${REGISTRY}`);
  console.log(`npx hardhat verify --network polygon ${poolAddr} ${deployer.address} ${POLY_USDC} ${REGISTRY}`);
  console.log(`npx hardhat verify --network polygon ${lockerAddr} ${deployer.address} ${KEEPER} ${CCIP_ROUTER_POLY} ${ARB_SELECTOR} ${LINK_POLY}`);
  console.log("\n✓ Polygon v1.4 + locker live — pair with ArbPositionWrapper via setArbWrapper/setPolygonLocker");
}

main().catch(e => { console.error(e); process.exit(1); });
