const { ethers } = require("ethers");
const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const SKIN = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const LOCKER_A = "0xe04534850F5A562F63D3eFD24D8D1A143420235B";
const USER = process.argv[2];

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function totalSupply() view returns (uint256)",
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const skin = new ethers.Contract(SKIN, ABI, p);
  const total = await skin.totalSupply().catch(() => null);
  console.log("HyperSkin totalSupply:", total?.toString() ?? "n/a");
  if (USER) {
    const bal = await skin.balanceOf(USER);
    console.log(`balanceOf(${USER}):`, bal.toString());
  }
  // Walk tokens 1..total and report owner
  if (total) {
    const max = Number(total);
    for (let i = 1; i <= max; i++) {
      try {
        const owner = await skin.ownerOf(i);
        console.log(`token ${i} -> ${owner}`);
      } catch (e) {
        console.log(`token ${i} -> burned/missing`);
      }
    }
  }
})();
