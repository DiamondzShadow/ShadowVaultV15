// Deploy ShadowPassValuer on HyperEVM + wire it into the LZ bridge locker so
// ShadowPass NFTs become bridgeable with live value mirrored to Arb.

const hre  = require("hardhat");
const fs   = require("node:fs");
const path = require("node:path");

async function main() {
  const [d] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 999) throw new Error("not HyperEVM");
  console.log("deployer:", d.address);
  console.log("HYPE bal:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(d.address)));

  const sp = require(path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json"));
  const bridge = require(path.resolve(__dirname, "..", "config", "deployed-lz-bridge-hyper.json"));

  console.log("ShadowPass  :", sp.shadowPass);
  console.log("YieldReceipt:", sp.yieldReceipt);
  console.log("BasketRecpt :", sp.basketReceipt);

  // Deploy valuer
  const F = await hre.ethers.getContractFactory("ShadowPassValuer");
  const v = await F.deploy(sp.shadowPass, sp.yieldReceipt, sp.basketReceipt);
  await v.waitForDeployment();
  const vAddr = await v.getAddress();
  console.log("\n✓ ShadowPassValuer:", vAddr);

  // Wire into the LZ bridge locker: bridge will call valuer.estimatePositionValue(passId)
  const locker = await hre.ethers.getContractAt("HyperPositionLocker", bridge.contracts.hyperPositionLocker);
  console.log("\nlocker.setVaultFor(ShadowPass, ShadowPassValuer)");
  const tx = await locker.setVaultFor(sp.shadowPass, vAddr);
  await tx.wait();
  console.log("  tx:", tx.hash);

  // Readback
  const got = await locker.vaultOf(sp.shadowPass);
  if (got.toLowerCase() !== vAddr.toLowerCase()) throw new Error(`readback mismatch ${got}`);
  console.log("  readback ✓");

  // Persist
  sp.shadowPassValuer = vAddr;
  sp.valuerDeployedAt = new Date().toISOString();
  fs.writeFileSync(path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json"), JSON.stringify(sp, null, 2));

  console.log("\nShadowPass is now bridgeable via the LZ bridge.");
  console.log("Users call locker.lockAndBridge(shadowPass, passId, ...) to mirror onto Arb.");
  console.log("\nVerify:");
  console.log(`  npx hardhat verify --network hyperevm ${vAddr} ${sp.shadowPass} ${sp.yieldReceipt} ${sp.basketReceipt}`);
}

main().catch(e => { console.error(e); process.exit(1); });
