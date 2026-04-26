// Redeploy PolygonNFTLocker with the CORRECT Polygon LINK address.
// The first deploy used a researched address (0xb089...) that turned out
// to be Ethereum mainnet LINK, not Polygon LINK. Real Polygon LINK is
// 0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39 (verified on-chain: symbol
// "LINK", code.length=24888).
//
// The old locker has no state (no NFTs locked yet), so this is a pure
// redeploy + rewire, not a migration.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

const cfg = require("../config/deployed-polygon-stack.json");

const CCIP_ROUTER_POLY = "0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe";
const ARB_SELECTOR     = 4949039107694359620n;
const LINK_POLY_REAL   = "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39"; // verified on-chain
const KEEPER           = new hre.ethers.Wallet(process.env.KEEPER_KEY).address;
const WRAPPER_ARB      = require("../config/deployed-lending-arb.json").contracts.arbPositionWrapper;

const POOLS = [
  { label: "A", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c", vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf" },
  { label: "B", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8", vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4" },
  { label: "C", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7", vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF" },
  { label: "D", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309", vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08" },
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (Number((await hre.ethers.provider.getNetwork()).chainId) !== 137) throw new Error("not Polygon");
  console.log("deployer:", deployer.address, "keeper:", KEEPER);

  const OLD_LOCKER = cfg.contracts.polygonNFTLocker;
  console.log("retiring old locker:", OLD_LOCKER);

  // Deploy v2 locker with correct LINK
  const PL = await hre.ethers.getContractFactory("PolygonNFTLocker");
  const locker = await PL.deploy(deployer.address, KEEPER, CCIP_ROUTER_POLY, ARB_SELECTOR, LINK_POLY_REAL);
  await locker.waitForDeployment();
  const lockerAddr = await locker.getAddress();
  console.log("new PolygonNFTLocker:", lockerAddr);

  // Rewire Pool A-D vaultFor
  for (const p of POOLS) {
    console.log(`  setVaultFor(${p.label})`);
    await (await locker.setVaultFor(p.nft, p.vault)).wait();
  }

  // Point new locker at the existing Arb wrapper
  await (await locker.setArbWrapper(WRAPPER_ARB)).wait();
  console.log("  setArbWrapper →", WRAPPER_ARB);

  // Persist
  cfg.contracts.polygonNFTLocker_v1_unused_badlink = OLD_LOCKER;
  cfg.contracts.polygonNFTLocker = lockerAddr;
  cfg.ccip.link = LINK_POLY_REAL;
  cfg.deployedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-polygon-stack.json"), JSON.stringify(cfg, null, 2));
  console.log("wrote config");

  console.log("\nNext: on Arb, wrapper.setPolygonLocker(new) — run wire-ccip-bridge.cjs --network arbitrum");
  console.log(`Verify: npx hardhat verify --network polygon ${lockerAddr} ${deployer.address} ${KEEPER} ${CCIP_ROUTER_POLY} ${ARB_SELECTOR} ${LINK_POLY_REAL}`);
}

main().catch(e => { console.error(e); process.exit(1); });
