// Resume Polygon v1.4 deploy from step 8 — just the locker + vaultFor wiring.
// The prior run already deployed + wired everything up through v1.3 retire.

const hre = require("hardhat");
const fs  = require("node:fs");
const path = require("node:path");

const cfg = require("../config/deployed-polygon-stack.json");

const CCIP_ROUTER_POLY = "0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe";
const ARB_SELECTOR     = 4949039107694359620n;
// Lowercase to dodge the checksum-case mismatch in ethers v6.
const LINK_POLY        = hre.ethers.getAddress("0xb0897686c545045afc77cf20eb7b720d195c8bf6");
const KEEPER           = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";

const POOLS = [
  { label: "A", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c", vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf" },
  { label: "B", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8", vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4" },
  { label: "C", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7", vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF" },
  { label: "D", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309", vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08" },
];

// Addresses already deployed in the prior (partial) run
const NEW_POOL   = "0x3596A83d971680D6ec3560b1d54C0387ab872Db0";
const NEW_VALUER = "0x0004bCaF16d3Fb16Df210615d9a666486297B79C";
const OLD_POOL   = cfg.contracts.lendingPool;        // pre-v1.4 (already retired)
const OLD_VALUER = cfg.contracts.nftValuer;          // pre-v2 (kept as zombie)

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (Number((await hre.ethers.provider.getNetwork()).chainId) !== 137) throw new Error("not Polygon");
  console.log("resuming from step 8 — locker deploy");
  console.log("LINK_POLY (normalized):", LINK_POLY);

  const PL = await hre.ethers.getContractFactory("PolygonNFTLocker");
  const locker = await PL.deploy(deployer.address, KEEPER, CCIP_ROUTER_POLY, ARB_SELECTOR, LINK_POLY);
  await locker.waitForDeployment();
  const lockerAddr = await locker.getAddress();
  console.log("PolygonNFTLocker:", lockerAddr);

  for (const p of POOLS) {
    console.log(`  setVaultFor(${p.label})`);
    await (await locker.setVaultFor(p.nft, p.vault)).wait();
  }

  // Persist — bring cfg up to date with the prior-run deploys + this locker.
  cfg.contracts.lendingPool_v1_3_unused = OLD_POOL;
  cfg.contracts.lendingPool = NEW_POOL;
  cfg.contracts.nftValuer_v1_unused = OLD_VALUER;
  cfg.contracts.nftValuer = NEW_VALUER;
  cfg.contracts.polygonNFTLocker = lockerAddr;
  cfg.ccip = {
    router: CCIP_ROUTER_POLY,
    arbSelector: ARB_SELECTOR.toString(),
    link: LINK_POLY,
  };
  cfg.deployedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "..", "config", "deployed-polygon-stack.json"), JSON.stringify(cfg, null, 2));

  console.log("\nVerify:");
  console.log(`npx hardhat verify --network polygon ${NEW_VALUER} ${deployer.address} ${cfg.contracts.diggerRegistry}`);
  console.log(`npx hardhat verify --network polygon ${NEW_POOL} ${deployer.address} ${cfg.usdc} ${cfg.contracts.diggerRegistry}`);
  console.log(`npx hardhat verify --network polygon ${lockerAddr} ${deployer.address} ${KEEPER} ${CCIP_ROUTER_POLY} ${ARB_SELECTOR} ${LINK_POLY}`);
}

main().catch(e => { console.error(e); process.exit(1); });
