const hre = require("hardhat");
const path = require("node:path");
async function main() {
  const cfg = require(path.resolve("config/deployed-lending-arb.json"));
  const SWEEP = cfg.contracts.sweepController;
  const MIRROR = cfg.contracts.hyperRemoteMirror;

  const sweep = new hre.ethers.Contract(SWEEP, [
    "function remote() view returns (address)",
    "function remoteBps() view returns (uint16)",
  ], hre.ethers.provider);
  const mirror = new hre.ethers.Contract(MIRROR, [
    "function CONTROLLER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function totalAssets() view returns (uint256)",
    "function mirrored() view returns (uint256)",
    "function pendingOutbound() view returns (uint256)",
    "function pendingInbound() view returns (uint256)",
  ], hre.ethers.provider);

  const [remoteAddr, bps] = await Promise.all([sweep.remote(), sweep.remoteBps()]);
  console.log("sweep.remote()            :", remoteAddr);
  console.log("sweep.remoteBps()         :", Number(bps), "bps");
  console.log("matches deployed mirror   :", remoteAddr.toLowerCase() === MIRROR.toLowerCase());

  const role = await mirror.CONTROLLER_ROLE();
  console.log("mirror CONTROLLER_ROLE on sweep:", await mirror.hasRole(role, SWEEP));

  const [ta, m, po, pi] = await Promise.all([
    mirror.totalAssets().catch(() => 0n),
    mirror.mirrored().catch(() => 0n),
    mirror.pendingOutbound().catch(() => 0n),
    mirror.pendingInbound().catch(() => 0n),
  ]);
  const toNum = (n) => Number(n) / 1e6;
  console.log(`mirror totalAssets:   $${toNum(ta)}`);
  console.log(`mirror mirrored:      $${toNum(m)}`);
  console.log(`mirror pendingOut:    $${toNum(po)}`);
  console.log(`mirror pendingIn:     $${toNum(pi)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
