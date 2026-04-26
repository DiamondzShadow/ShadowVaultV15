const { ethers } = require("ethers");
const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const LOCKER_A = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const SKIN = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const VAULT = "0x31D4BD9C446865333fB219F9ebAB6EbFCA9302Ba";
const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
const HYPER_TREASURY_SAFE = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";

const ABI = [
  "function vaultOf(address) view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function peers(uint32) view returns (bytes32)",
  "function ARB_EID() view returns (uint32)",
  "function dstGasLimit() view returns (uint128)",
];
(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(LOCKER_A, ABI, p);
  console.log("vaultOf(skin) =", await c.vaultOf(SKIN));
  const adminRole = await c.DEFAULT_ADMIN_ROLE();
  console.log("DEFAULT_ADMIN deployer?", await c.hasRole(adminRole, DEPLOYER));
  console.log("DEFAULT_ADMIN safe?    ", await c.hasRole(adminRole, HYPER_TREASURY_SAFE));
  const arbEid = await c.ARB_EID();
  console.log("ARB_EID =", arbEid);
  console.log("peers(ARB) =", await c.peers(arbEid));
  console.log("dstGasLimit =", (await c.dstGasLimit()).toString());
})();
