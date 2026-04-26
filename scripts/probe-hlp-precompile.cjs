const { ethers } = require("ethers");
require("dotenv").config({ path: ".env.pool-e" });

const VAULT_EQUITY_PRECOMPILE = "0x0000000000000000000000000000000000000802";
const ADAPTER = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
const HLP_VAULT_GUESSES = [
  "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303",
];

(async () => {
  const p = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const abi = ethers.AbiCoder.defaultAbiCoder();

  for (const user of [DEPLOYER, ADAPTER]) {
    for (const vault of HLP_VAULT_GUESSES) {
      const calldata = abi.encode(["address", "address"], [user, vault]);
      try {
        const r = await p.call({ to: VAULT_EQUITY_PRECOMPILE, data: calldata });
        console.log(`user=${user} vault=${vault} → ok, raw=${r}`);
      } catch (e) {
        console.log(`user=${user} vault=${vault} → revert:`, e.shortMessage || e.message);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
