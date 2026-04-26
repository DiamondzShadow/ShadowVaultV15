// Whitelist the lending sweep keeper EOA on Pool E v2 vault so it can
// deposit USDC on behalf of the lending protocol's HyperEVM allocation.
const hre = require("hardhat");
const VAULT = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57"; // Pool E v2
const KEEPER = "0x506cB442df1B58ae4F654753BEf9E531088ca0eB";
(async () => {
  const [s] = await hre.ethers.getSigners();
  const v = new hre.ethers.Contract(VAULT, [
    "function setWhitelist(address,bool)",
    "function whitelisted(address) view returns (bool)",
  ], s);
  console.log("keeper currently whitelisted?", await v.whitelisted(KEEPER));
  const tx = await v.setWhitelist(KEEPER, true);
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("post:", await v.whitelisted(KEEPER));
})();
