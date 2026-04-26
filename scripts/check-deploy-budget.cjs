const hre = require("hardhat");
async function main() {
  const [s] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(s.address);
  const net = await hre.ethers.provider.getNetwork();
  console.log(`chain ${net.chainId} | deployer ${s.address} | balance ${hre.ethers.formatEther(bal)}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
