// Grant DEFAULT_ADMIN_ROLE on Pool F contracts to the Safe (dual admin with
// deployer during beta bake; renounce deployer after 7 days clean).

const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const poolF = require("../config/deployed-pool-f-hc.json");
const SAFE = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const w = new ethers.Wallet(process.env.DEPLOYER_KEY, p);

  const iface = [
    "function grantRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ];
  const vault = new ethers.Contract(poolF.vault, iface, w);
  const basket = new ethers.Contract(poolF.basketAdapter, iface, w);

  for (const [name, c] of [["vaultF", vault], ["basketAdapter", basket]]) {
    if (await c.hasRole(DEFAULT_ADMIN_ROLE, SAFE)) {
      console.log(`${name}: Safe already admin`);
    } else {
      const tx = await c.grantRole(DEFAULT_ADMIN_ROLE, SAFE);
      await tx.wait();
      console.log(`${name}: Safe granted admin — tx ${tx.hash}`);
    }
  }
})();
