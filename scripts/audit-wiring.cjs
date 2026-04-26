// End-to-end wiring audit. Runs on one chain at a time; invoke twice:
//   npx hardhat run --network arbitrum scripts/audit-wiring.cjs
//   npx hardhat run --network polygon  scripts/audit-wiring.cjs
//
// Reports pass/fail for every cross-contract pointer and role grant the
// v1.4 + CCIP + keeper stack depends on.

const hre = require("hardhat");
const path = require("node:path");

const checks = [];
const fail = [];

function check(label, cond, detail = "") {
  const ok = !!cond;
  checks.push({ label, ok, detail });
  if (!ok) fail.push(label);
}

function eq(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const provider = hre.ethers.provider;

  let lCfg, mCfg;
  if (chainId === 42161) {
    lCfg = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json"));
    mCfg = require(path.resolve(__dirname, "..", "config", "deployed-marketplace-arb.json"));
  } else if (chainId === 137) {
    lCfg = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json"));
    mCfg = lCfg; // polygon config lumps everything together
  } else throw new Error(`unsupported chain ${chainId}`);

  const REGISTRY = mCfg.contracts.diggerRegistry;
  const ROUTER   = mCfg.contracts.royaltyRouter;
  const MARKETPLACE = mCfg.contracts.marketplace;
  const VALUER  = chainId === 42161 ? lCfg.contracts.nftValuer : lCfg.contracts.nftValuer;
  const POOL    = lCfg.contracts.lendingPool;
  const SWEEP   = lCfg.contracts.sweepController;

  console.log(`\n═══ Wiring audit — chain ${chainId} ═══\n`);
  console.log("Pool     :", POOL);
  console.log("Valuer   :", VALUER);
  console.log("Market   :", MARKETPLACE);
  console.log("Router   :", ROUTER);
  console.log("Sweep    :", SWEEP);

  // ─── LendingPool pointers
  const pool = await hre.ethers.getContractAt("LendingPool", POOL);
  const [valuerOnPool, mpOnPool, sweepOnPool] = await Promise.all([
    pool.valuer(), pool.marketplace(), pool.sweepSink(),
  ]);
  check("pool.valuer() == valuer",       eq(valuerOnPool, VALUER),     `got ${valuerOnPool}`);
  check("pool.marketplace() == marketplace", eq(mpOnPool, MARKETPLACE), `got ${mpOnPool}`);
  check("pool.sweepSink() == sweep",     eq(sweepOnPool, SWEEP),       `got ${sweepOnPool}`);

  // ─── SweepController pointers + POOL_ROLE
  const sweep = new hre.ethers.Contract(SWEEP, [
    "function lendingPool() view returns (address)",
    "function POOL_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function sinkCount() view returns (uint256)",
    "function sinks(uint256) view returns (address,uint16,bool,string)",
  ], provider);
  const [lpOnSweep, poolRole] = await Promise.all([sweep.lendingPool(), sweep.POOL_ROLE()]);
  check("sweep.lendingPool() == pool", eq(lpOnSweep, POOL), `got ${lpOnSweep}`);
  check("pool has POOL_ROLE on sweep", await sweep.hasRole(poolRole, POOL));

  // ─── Marketplace LIQUIDATOR_ROLE
  const mp = new hre.ethers.Contract(MARKETPLACE, [
    "function LIQUIDATOR_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);
  const liqRole = await mp.LIQUIDATOR_ROLE();
  check("pool has LIQUIDATOR_ROLE on marketplace", await mp.hasRole(liqRole, POOL));

  // ─── RoyaltyRouter supplier-cut pointer
  const rr = new hre.ethers.Contract(ROUTER, ["function lendingPool() view returns (address)"], provider);
  const lpOnRouter = await rr.lendingPool().catch(() => "0x");
  check("router.lendingPool() == pool", eq(lpOnRouter, POOL), `got ${lpOnRouter}`);

  // ─── NFTValuer config for known NFTs
  const valuer = await hre.ethers.getContractAt("NFTValuer", VALUER);
  const pools = chainId === 42161
    ? [
        { label: "Pool A (Arb)", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a", expectMode: 1 /*VAULT_POSITION*/ },
        { label: "Pool B (Arb)", nft: "0x67940CD1D7000494433B1Be44Dde494994393174", expectMode: 1 },
        { label: "Pool C (Arb)", nft: "0x9C86B7C9f4195d3d5150A39983ca0536353109f6", expectMode: 1 },
        { label: "Pool D (Arb)", nft: "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", expectMode: 1 },
        { label: "Wrapper (Arb)", nft: lCfg.contracts.arbPositionWrapper, expectMode: 4 /*VAULT_MIRROR*/ },
      ]
    : [
        { label: "Pool A (Poly)", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c", expectMode: 1 },
        { label: "Pool B (Poly)", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8", expectMode: 1 },
        { label: "Pool C (Poly)", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7", expectMode: 1 },
        { label: "Pool D (Poly)", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309", expectMode: 1 },
      ];
  const MODES = ["NONE","VAULT_POSITION","FLOOR_ORACLE","STATIC_USDC","VAULT_MIRROR"];
  for (const p of pools) {
    const [mode] = await valuer.configOf(p.nft);
    check(`valuer mode ${p.label} == ${MODES[p.expectMode]}`, Number(mode) === p.expectMode, `got ${MODES[Number(mode)]}`);
  }

  // ─── DiggerRegistry acceptance of each NFT
  const registry = await hre.ethers.getContractAt("DiggerRegistry", REGISTRY);
  for (const p of pools) {
    const c = await registry.collections(p.nft);
    check(`registry accepts ${p.label}`, c.accepted, `maxLtv=${c.maxLtvBps}bps`);
  }

  // ─── CCIP cross-references
  if (chainId === 42161) {
    const wrapper = await hre.ethers.getContractAt("ArbPositionWrapper", lCfg.contracts.arbPositionWrapper);
    const polyLockerExpected = require(path.resolve(__dirname, "..", "config", "deployed-polygon-stack.json")).contracts.polygonNFTLocker;
    check("wrapper.polygonLocker() == polygonNFTLocker (current)", eq(await wrapper.polygonLocker(), polyLockerExpected),
      `got ${await wrapper.polygonLocker()}`);
  } else {
    const locker = await hre.ethers.getContractAt("PolygonNFTLocker", lCfg.contracts.polygonNFTLocker);
    const wrapperExpected = require(path.resolve(__dirname, "..", "config", "deployed-lending-arb.json")).contracts.arbPositionWrapper;
    check("locker.arbWrapper() == arbPositionWrapper",
      eq(await locker.arbWrapper(), wrapperExpected), `got ${await locker.arbWrapper()}`);
    for (const p of pools) {
      const found = await locker.vaultOf(p.nft);
      check(`locker.vaultOf(${p.label}) set`, found !== hre.ethers.ZeroAddress && found !== "0x0000000000000000000000000000000000000000", `got ${found}`);
    }
    // LINK sanity — must be Polygon real LINK
    const LINK = await locker.LINK();
    check("locker.LINK == 0x53E0bca3… (Polygon LINK)", eq(LINK, "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39"), `got ${LINK}`);
  }

  // ─── Keeper has KEEPER_ROLE where needed
  const keeperAddr = process.env.KEEPER_KEY ? new hre.ethers.Wallet(process.env.KEEPER_KEY).address : null;
  if (keeperAddr) {
    const keeperRole = await sweep.hasRole ? await sweep.sinks(0).then(() => null).catch(() => null) : null;
    // check by reading KEEPER_ROLE hash from the contract
    const keeperHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
    check("keeper has KEEPER_ROLE on sweep", await sweep.hasRole(keeperHash, keeperAddr));
    if (chainId === 137) {
      const locker = await hre.ethers.getContractAt("PolygonNFTLocker", lCfg.contracts.polygonNFTLocker);
      check("keeper has KEEPER_ROLE on PolygonNFTLocker", await locker.hasRole(keeperHash, keeperAddr));
    }
  }

  // ─── Old zombie pool paused
  const oldPool = chainId === 42161 ? lCfg.contracts.lendingPool_v1_3_unused : lCfg.contracts.lendingPool_v1_3_unused;
  if (oldPool) {
    const zombie = new hre.ethers.Contract(oldPool, ["function paused() view returns (bool)"], provider);
    const p = await zombie.paused().catch(() => null);
    check(`v1.3 zombie ${oldPool.slice(0,10)}… paused`, p === true, `got ${p}`);
  }

  // ─── Old zombie sweep role revoked (Arb only — Polygon's pre-v2 sweep never existed)
  if (chainId === 42161 && lCfg.contracts.sweepController_v1_unused) {
    // Check that the OLD v1 sweep no longer has CONTROLLER_ROLE on the sinks.
    const CONTROLLER_HASH = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("CONTROLLER_ROLE"));
    const aaveSink = new hre.ethers.Contract(lCfg.contracts.aaveV3Sink, ["function hasRole(bytes32,address) view returns (bool)"], provider);
    const stillHas = await aaveSink.hasRole(CONTROLLER_HASH, lCfg.contracts.sweepController_v1_unused);
    check("v1 sweep CONTROLLER_ROLE revoked on AaveV3Sink", !stillHas);
  }

  // ─── Report
  console.log("\n─── Results ───");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"}  ${c.label}${c.detail ? "  (" + c.detail + ")" : ""}`);
  }
  console.log(`\n${checks.length - fail.length}/${checks.length} passing${fail.length ? "  |  FAIL: " + fail.join(", ") : ""}`);
  if (fail.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
