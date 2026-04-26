const hre = require("hardhat");
async function main() {
  const SWEEP = "0xEc181596A44AFF5747338f6139dBd35C2A930B11";
  const MIRROR = "0xFb192B3e83E3FacC51a14aA78a9d37a50f587964";
  const sweep = await hre.ethers.getContractAt("SweepControllerV2", SWEEP);
  const remoteBps = await sweep.remoteBps();
  console.log("remote bps:", remoteBps.toString());
  const tx = await sweep.setRemote(MIRROR, remoteBps);
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("remote set:", await sweep.remote());
}
main().catch(e=>{console.error(e);process.exit(1);});
