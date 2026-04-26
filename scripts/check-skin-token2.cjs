const { ethers } = require("ethers");
const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const SKIN = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const LOCKER_A = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const WRAPPER_B = "0x72bD38e770956D4194fD87Ae6C9424b1FF44FA5F";
const ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const skin = new ethers.Contract(SKIN, ABI, p);
  for (const id of [1,2,3]) {
    try {
      const o = await skin.ownerOf(id);
      console.log(`token ${id} -> owner=${o}`);
    } catch (e) {
      console.log(`token ${id} -> nonexistent / burned`);
    }
  }
  console.log(`balanceOf(locker_A)=${await skin.balanceOf(LOCKER_A)}`);
  console.log(`token1 getApproved=${await skin.getApproved(1)}`);
  console.log(`token1 isApprovedForAll(deployer, locker)=${await skin.isApprovedForAll("0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3", LOCKER_A)}`);
})();
