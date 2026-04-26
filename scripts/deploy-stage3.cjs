// Stage 3 redeploy: DiggerRegistry v2 + RoyaltyRouter + EcosystemMarketplace +
// NFTValuer v3 + LendingPool v1.5 — on Arb (42161) or Polygon (137).
//
// The old pool/marketplace/valuer/registry become zombies. Old pool is
// paused. In-house collections migrate to the new class system
// (Pool A-D NFTs, LZ+CCIP wrappers).
//
// Run per chain: `npx hardhat run scripts/deploy-stage3.cjs --network <n>`.

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const cfgName = chainId === 42161 ? "deployed-lending-arb.json"
                : chainId === 137   ? "deployed-polygon-stack.json"
                : null;
  if (!cfgName) throw new Error(`unsupported chain ${chainId}`);
  const cfgPath = path.resolve(__dirname, "..", "config", cfgName);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  const USDC    = cfg.usdc;
  const TREASURY = cfg.treasury;
  const OLD_POOL = cfg.contracts.lendingPool;
  const OLD_MARKET = cfg.contracts.marketplace || null;
  const SWEEP_V2 = cfg.contracts.sweepController; // SweepV2 already has rescue; reuse

  console.log(`\n═══ Stage 3 redeploy — chain ${chainId} ═══`);
  console.log("Deployer :", deployer.address);
  console.log("USDC     :", USDC);
  console.log("Treasury :", TREASURY);
  console.log("Old pool :", OLD_POOL);
  console.log("SweepV2  :", SWEEP_V2);

  // Collections to register as IN_HOUSE on this chain.
  // valueSource: for position NFTs = the vault; for bridge wrappers = the wrapper itself.
  const inHouse = chainId === 42161
    ? [
        { label: "ArbPositionWrapper (CCIP)", nft: cfg.contracts.arbPositionWrapper,  valueSource: cfg.contracts.arbPositionWrapper,   ltv: 5000 },
        { label: "HyperPositionWrapper (LZ)", nft: cfg.contracts.hyperPositionWrapper, valueSource: cfg.contracts.hyperPositionWrapper, ltv: 5000 },
      ]
    : [
        // Polygon: Pool A/B/C/D NFTs + their vaults. Discovered from polygon config.
        ...((cfg.digger1 && cfg.digger1.collections) || []).map(p => ({
          label: `Pool ${p.label || p.nft.slice(0,8)}`,
          nft:   p.nft,
          valueSource: p.vault,
          ltv: p.maxLtvBps || 5000,
        })),
      ];

  const balBefore = await hre.ethers.provider.getBalance(deployer.address);

  // ═══ 1. DiggerRegistry v2 ═══
  console.log("\n1. Deploy DiggerRegistry v2");
  const DR = await hre.ethers.getContractFactory("DiggerRegistry");
  const registry = await DR.deploy(deployer.address, USDC, TREASURY);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("   ", registryAddr);

  // ═══ 2. RoyaltyRouter ═══
  console.log("\n2. Deploy RoyaltyRouter");
  const RR = await hre.ethers.getContractFactory("RoyaltyRouter");
  const router = await RR.deploy(deployer.address, USDC, registryAddr, TREASURY);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("   ", routerAddr);

  // ═══ 3. EcosystemMarketplace ═══
  console.log("\n3. Deploy EcosystemMarketplace");
  const EM = await hre.ethers.getContractFactory("EcosystemMarketplace");
  const marketplace = await EM.deploy(deployer.address, USDC, registryAddr, routerAddr);
  await marketplace.waitForDeployment();
  const mktAddr = await marketplace.getAddress();
  console.log("   ", mktAddr);

  // ═══ 4. NFTValuer v3 ═══
  console.log("\n4. Deploy NFTValuer v3");
  const NV = await hre.ethers.getContractFactory("NFTValuer");
  const valuer = await NV.deploy(deployer.address, registryAddr);
  await valuer.waitForDeployment();
  const valuerAddr = await valuer.getAddress();
  console.log("   ", valuerAddr);

  // ═══ 5. LendingPool v1.5 ═══
  console.log("\n5. Deploy LendingPool v1.5");
  const LP = await hre.ethers.getContractFactory("LendingPool");
  const pool = await LP.deploy(deployer.address, USDC, registryAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("   ", poolAddr);

  // ═══ 6. Register in-house collections ═══
  console.log(`\n6. Register ${inHouse.length} in-house collection(s)`);
  for (const c of inHouse) {
    if (!c.nft || !c.valueSource) { console.log(`   skip ${c.label} (missing addr)`); continue; }
    console.log(`   • ${c.label}  nft=${c.nft}  src=${c.valueSource}  ltv=${c.ltv}bps`);
    const tx = await registry.registerInHouseCollection(c.nft, c.valueSource, c.ltv);
    await tx.wait();
  }

  // ═══ 7. Configure NFTValuer for each collection ═══
  console.log(`\n7. Configure NFTValuer for ${inHouse.length} collection(s)`);
  for (const c of inHouse) {
    if (!c.nft || !c.valueSource) continue;
    // Bridge wrappers (source == nft) → VAULT_MIRROR (marketplace-auction liq)
    // Pool NFTs (source == vault)     → VAULT_POSITION (vault-unwind liq)
    if (c.nft.toLowerCase() === c.valueSource.toLowerCase()) {
      console.log(`   • setMirrorMode ${c.label}`);
      await (await valuer.setMirrorMode(c.nft, c.valueSource, 0)).wait();
    } else {
      console.log(`   • setVaultMode  ${c.label}`);
      await (await valuer.setVaultMode(c.nft, c.valueSource, 0)).wait();
    }
  }

  // ═══ 8. Wire LendingPool ═══
  console.log("\n8. Wire LendingPool v1.5");
  console.log("   • setValuer");
  await (await pool.setValuer(valuerAddr)).wait();
  console.log("   • setMarketplace");
  await (await pool.setMarketplace(mktAddr)).wait();
  if (SWEEP_V2) {
    console.log("   • setSweepSink(SweepV2)");
    await (await pool.setSweepSink(SWEEP_V2)).wait();
  }

  // ═══ 9. Marketplace LIQUIDATOR_ROLE for new pool ═══
  console.log("\n9. Marketplace.grantRole(LIQUIDATOR, pool)");
  const LIQ_ROLE = await marketplace.LIQUIDATOR_ROLE();
  await (await marketplace.grantRole(LIQ_ROLE, poolAddr)).wait();

  // ═══ 10. RoyaltyRouter setLendingPool ═══
  try {
    console.log("\n10. RoyaltyRouter.setLendingPool(pool)");
    await (await router.setLendingPool(poolAddr)).wait();
  } catch (e) { console.log("    (skipped —", (e.shortMessage||e.message).slice(0, 60), ")"); }

  // ═══ 11. SweepV2 POOL_ROLE ═══
  if (SWEEP_V2) {
    console.log("\n11. SweepV2.grantRole(POOL_ROLE, pool)");
    const sweep = await hre.ethers.getContractAt("SweepControllerV2", SWEEP_V2);
    const POOL_ROLE = await sweep.POOL_ROLE();
    if (await sweep.hasRole(POOL_ROLE, poolAddr)) {
      console.log("    already has ✓");
    } else {
      await (await sweep.grantRole(POOL_ROLE, poolAddr)).wait();
      console.log("    granted");
    }
    // Update setLendingPool too
    try { await (await sweep.setLendingPool(poolAddr)).wait(); console.log("    setLendingPool(pool) ✓"); } catch {}
  }

  // ═══ 12. Pause old pool ═══
  console.log("\n12. Pause old pool v1.4");
  try {
    const oldPool = await hre.ethers.getContractAt("LendingPool", OLD_POOL);
    if (!(await oldPool.paused())) {
      await (await oldPool.pause()).wait();
      console.log("    paused ✓");
    } else {
      console.log("    already paused ✓");
    }
  } catch (e) { console.log("   (pause skipped —", (e.shortMessage||e.message).slice(0,80), ")"); }

  // ═══ persist ═══
  cfg.contracts.lendingPool_v1_4_unused = cfg.contracts.lendingPool;
  cfg.contracts.lendingPool             = poolAddr;
  cfg.contracts.marketplace_v1_unused   = cfg.contracts.marketplace || null;
  cfg.contracts.marketplace             = mktAddr;
  cfg.contracts.nftValuer_v2_unused     = cfg.contracts.nftValuer;
  cfg.contracts.nftValuer               = valuerAddr;
  cfg.diggerRegistry_v1_unused          = cfg.diggerRegistry;
  cfg.diggerRegistry                    = registryAddr;
  cfg.contracts.diggerRegistry          = registryAddr;
  cfg.royaltyRouter_v1_unused           = cfg.royaltyRouter;
  cfg.royaltyRouter                     = routerAddr;
  cfg.contracts.royaltyRouter           = routerAddr;
  cfg.redeployedAt                      = new Date().toISOString();
  cfg.notes = (cfg.notes || "") + ` | Stage 3 redeploy ${new Date().toISOString()}: rescue + in-house class.`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const balAfter = await hre.ethers.provider.getBalance(deployer.address);
  console.log("\n═══ Stage 3 summary ═══");
  console.log("DiggerRegistry v2   :", registryAddr);
  console.log("RoyaltyRouter       :", routerAddr);
  console.log("EcosystemMarketplace:", mktAddr);
  console.log("NFTValuer v3        :", valuerAddr);
  console.log("LendingPool v1.5    :", poolAddr);
  console.log("\nNative spent:", hre.ethers.formatEther(balBefore - balAfter));
}

main().catch(e=>{console.error(e);process.exit(1);});
