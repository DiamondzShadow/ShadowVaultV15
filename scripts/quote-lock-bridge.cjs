const { ethers } = require("ethers");
const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const LOCKER_A = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const SKIN = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const TOKEN_ID = 1;
const USER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const ABI = [
  "function quoteLock(address,uint256,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function vaultOf(address) view returns (address)",
  "function wrapperIdOf(address,uint256) view returns (uint256)",
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const locker = new ethers.Contract(LOCKER_A, ABI, p);
  const vault = await locker.vaultOf(SKIN);
  const wid = await locker.wrapperIdOf(SKIN, TOKEN_ID);
  console.log(`vaultOf(skin): ${vault}`);
  console.log(`wrapperIdOf(skin, token1): ${wid}`);
  const fee = await locker.quoteLock(SKIN, TOKEN_ID, "0x");
  console.log(`LZ nativeFee: ${ethers.formatEther(fee.nativeFee)} HYPE`);
  const bal = await p.getBalance(USER);
  console.log(`Deployer HYPE balance: ${ethers.formatEther(bal)}`);
  console.log(`Sufficient: ${bal > fee.nativeFee * 2n ? "YES (with 2x headroom)" : bal > fee.nativeFee ? "tight" : "NO"}`);
})();
