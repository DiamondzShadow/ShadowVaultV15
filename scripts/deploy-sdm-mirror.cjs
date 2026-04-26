// Deploy SDMArbitrumMirror on HyperEVM and wire it into Pool E v2 vault as
// the discount oracle. Idempotent on the wiring step (skips if already wired).

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const VAULT  = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const KEEPER = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";
const SDM_DISCOUNT_BPS = 5000n;          // 50% off
const SDM_THRESHOLD = 10_000n * 10n ** 18n; // 10,000 SDM

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Vault   :", VAULT);
  console.log("Keeper  :", KEEPER);

  const F = await hre.ethers.getContractFactory("SDMArbitrumMirror");
  console.log("\n→ deploying SDMArbitrumMirror(admin=deployer, keeper=KEEPER_EOA)...");
  const mirror = await F.deploy(deployer.address, KEEPER);
  await mirror.waitForDeployment();
  const mirrorAddr = await mirror.getAddress();
  console.log("  SDMArbitrumMirror:", mirrorAddr);

  const vault = new hre.ethers.Contract(VAULT, [
    "function sdmToken() view returns (address)",
    "function sdmThreshold() view returns (uint256)",
    "function sdmDiscountBps() view returns (uint256)",
    "function setSDMToken(address)",
    "function setSDMDiscount(uint256)",
    "function setSDMThreshold(uint256)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], deployer);

  const ADMIN_ROLE = "0x" + "0".repeat(64);
  const isAdmin = await vault.hasRole(ADMIN_ROLE, deployer.address);
  if (!isAdmin) throw new Error("deployer lacks DEFAULT_ADMIN_ROLE on vault");

  const [curToken, curThr, curDisc] = await Promise.all([
    vault.sdmToken().catch(() => "0x0000000000000000000000000000000000000000"),
    vault.sdmThreshold().catch(() => 0n),
    vault.sdmDiscountBps().catch(() => 0n),
  ]);
  console.log("\n  current vault SDM config:");
  console.log("    sdmToken      :", curToken);
  console.log("    sdmThreshold  :", curThr.toString());
  console.log("    sdmDiscountBps:", curDisc.toString());

  console.log("\n→ vault.setSDMToken(mirror)");
  await (await vault.setSDMToken(mirrorAddr)).wait();
  console.log("  done");

  if (curDisc !== SDM_DISCOUNT_BPS) {
    console.log(`\n→ vault.setSDMDiscount(${SDM_DISCOUNT_BPS}) (50% off)`);
    await (await vault.setSDMDiscount(SDM_DISCOUNT_BPS)).wait();
    console.log("  done");
  } else {
    console.log("\n  sdmDiscountBps already at target");
  }

  if (curThr !== SDM_THRESHOLD) {
    console.log(`\n→ vault.setSDMThreshold(${SDM_THRESHOLD}) (10,000 SDM)`);
    await (await vault.setSDMThreshold(SDM_THRESHOLD)).wait();
    console.log("  done");
  } else {
    console.log("\n  sdmThreshold already at target");
  }

  // Persist
  const out = {
    chainId: 999,
    sdmMirror: mirrorAddr,
    vault: VAULT,
    keeper: KEEPER,
    deployer: deployer.address,
    sourceChainId: 42161,
    sourceToken: "0x602b869eEf1C9F0487F31776bad8Af3C4A173394",
    discountBps: SDM_DISCOUNT_BPS.toString(),
    threshold: SDM_THRESHOLD.toString(),
    deployedAt: new Date().toISOString(),
  };
  const outfile = path.join(__dirname, "..", "config", "deployed-sdm-mirror-hc.json");
  fs.writeFileSync(outfile, JSON.stringify(out, null, 2));
  console.log("\nwrote", outfile);

  console.log("\n✓ SDM mirror live + wired");
  console.log("  Next: start the Arb→HyperEVM SDM sync keeper");
  console.log("    pm2 start keeper/sdm-mirror-sync.js --name sdm-mirror-sync --cron '*/15 * * * *'");
}

main().catch(e => { console.error(e); process.exit(1); });
