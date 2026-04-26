const hre = require("hardhat");
const ROUTER = "0xe3F850FEa1cA73442EA618AaD0dc2cfc5d35fe21";
const VAULT  = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
// keccak256("AUTHORIZED_ROLE")
const AUTHORIZED_ROLE = "0x46a52cf33029de9f84853745a87af28464c80bf0346df1b32e205fc73319f622";

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const router = new hre.ethers.Contract(
    ROUTER,
    [
      "function hasRole(bytes32,address) view returns (bool)",
      "function addAuthorized(address) external",
      "function AUTHORIZED_ROLE() view returns (bytes32)",
    ],
    signer,
  );
  const role = await router.AUTHORIZED_ROLE();
  console.log("AUTHORIZED_ROLE =", role);
  const has = await router.hasRole(role, VAULT);
  console.log("vault has AUTHORIZED_ROLE?", has);
  if (has) { console.log("nothing to do"); return; }
  console.log("granting...");
  const tx = await router.addAuthorized(VAULT);
  console.log("tx", tx.hash);
  await tx.wait();
  console.log("mined.");
  const has2 = await router.hasRole(role, VAULT);
  console.log("post: vault has AUTHORIZED_ROLE?", has2);
}
main().catch(e => { console.error(e); process.exit(1); });
