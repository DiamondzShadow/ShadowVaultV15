const { ethers } = require("ethers");
const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const SKIN_V2 = "0x5f90c2f0E9CE11A19d49A2E54d9df7759C7581ae";
const VAULT_V2 = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";
const LOCKER_A = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function totalSupply() view returns (uint256)",
];
const LOCKER_ABI = [
  "function vaultOf(address) view returns (address)",
  "function quoteLock(address,uint256,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
];
(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const nft = new ethers.Contract(SKIN_V2, NFT_ABI, p);
  const locker = new ethers.Contract(LOCKER_A, LOCKER_ABI, p);

  const total = await nft.totalSupply().catch(() => null);
  console.log("v2 SKIN totalSupply:", total?.toString() ?? "n/a");
  for (const id of [1, 2, 3]) {
    try {
      const o = await nft.ownerOf(id);
      console.log(`token ${id} -> ${o}`);
    } catch { console.log(`token ${id} -> nonexistent`); }
  }
  console.log(`balanceOf(deployer) = ${await nft.balanceOf(DEPLOYER)}`);
  console.log(`isApprovedForAll(deployer, locker) = ${await nft.isApprovedForAll(DEPLOYER, LOCKER_A)}`);
  console.log(`Locker.vaultOf(skin_v2) = ${await locker.vaultOf(SKIN_V2)}`);
  if ((await locker.vaultOf(SKIN_V2)).toLowerCase() === VAULT_V2.toLowerCase()) {
    const fee1 = await locker.quoteLock(SKIN_V2, 1, "0x").catch(e => "ERR:"+e.message.slice(0,80));
    const fee2 = await locker.quoteLock(SKIN_V2, 2, "0x").catch(e => "ERR:"+e.message.slice(0,80));
    console.log(`quote token1: ${typeof fee1 === "string" ? fee1 : ethers.formatEther(fee1.nativeFee) + " HYPE"}`);
    console.log(`quote token2: ${typeof fee2 === "string" ? fee2 : ethers.formatEther(fee2.nativeFee) + " HYPE"}`);
  }
})();
