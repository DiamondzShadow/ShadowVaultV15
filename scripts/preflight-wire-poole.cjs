const hre = require("hardhat");

const LOCKER = "0xFC8f588bF9CCa0D1832F2735236Fc3eecdbc7381";
const SKIN_V2   = "0x5f90c2f0E9CE11A19d49A2E54d9df7759C7581ae";
const SKIN_V1   = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const VAULT_V2  = "0x481D57E356cF99E44C25675C57C178D9Ef46BD57";

async function main() {
  const skinV2 = new hre.ethers.Contract(SKIN_V2, [
    "function vault() view returns (address)",
    "function totalSupply() view returns (uint256)",
    "function name() view returns (string)",
  ], hre.ethers.provider);
  const vaultV2 = new hre.ethers.Contract(VAULT_V2, [
    "function estimatePositionValue(uint256) view returns (uint256,uint256,uint256)",
    "function positionNFT() view returns (address)",
  ], hre.ethers.provider);
  const locker = new hre.ethers.Contract(LOCKER, [
    "function vaultOf(address) view returns (address)",
  ], hre.ethers.provider);

  console.log("Pool E v2 skin  :", SKIN_V2);
  try { console.log("  skin.name()     :", await skinV2.name()); } catch {}
  try { console.log("  skin.vault()    :", await skinV2.vault()); } catch (e) { console.log("  vault() reverted:", e.shortMessage||e.message); }
  try { console.log("  skin.totalSupply:", (await skinV2.totalSupply()).toString()); } catch {}

  console.log("\nPool E v2 vault :", VAULT_V2);
  try { console.log("  vault.positionNFT():", await vaultV2.positionNFT()); } catch {}
  try {
    const r = await vaultV2.estimatePositionValue(1);
    console.log(`  estimatePositionValue(1): basket=${r[0]}, yield=${r[1]}, total=${r[2]} (6dp USDC)`);
  } catch (e) { console.log("  estimatePositionValue(1) reverted:", e.shortMessage||e.message); }

  console.log("\nCurrent wiring:");
  console.log("  locker.vaultOf(skinV2):", await locker.vaultOf(SKIN_V2));
  console.log("  locker.vaultOf(skinV1):", await locker.vaultOf(SKIN_V1));
}
main().catch(e=>{console.error(e);process.exit(1);});
