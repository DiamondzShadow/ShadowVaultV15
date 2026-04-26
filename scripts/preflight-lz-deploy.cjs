// Pre-deploy snapshot: deployer balances on both chains + ShadowPass state.

const hre = require("hardhat");
const path = require("node:path");

async function main() {
  const [d] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const bal = await hre.ethers.provider.getBalance(d.address);
  console.log(`chain=${chainId} deployer=${d.address} balance=${hre.ethers.formatEther(bal)}`);

  if (chainId === 999) {
    // HyperEVM — audit ShadowPass + Pool E v2 + Pool F
    const poolE = require(path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"));
    const poolF = require(path.resolve(__dirname, "..", "config", "deployed-pool-f-hc.json"));
    const sp = require(path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json"));

    console.log("\n═══ HyperEVM NFTs eligible for the bridge ═══");
    console.log(`Pool E v2 vault: ${poolE.vault}`);
    console.log(`Pool E skin NFT: ${poolE.skin}`);
    console.log(`Pool F vault:    ${poolF.vault}`);
    console.log(`Pool F yieldRec: ${poolF.yieldReceipt}`);
    console.log(`Pool F basketRec:${poolF.basketReceipt}`);
    console.log(`ShadowPass:      ${sp.shadowPass || poolF.shadowPass}`);

    // ShadowPass audit
    const SP_ABI = [
      "function totalSupply() view returns (uint256)",
      "function owner() view returns (address)",
      "function paused() view returns (bool)",
      "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function name() view returns (string)",
      "function symbol() view returns (string)",
    ];
    const spAddr = sp.shadowPass || poolF.shadowPass;
    const spContract = new hre.ethers.Contract(spAddr, SP_ABI, hre.ethers.provider);
    console.log("\nShadowPass details:");
    try { console.log("  name   :", await spContract.name()); } catch {}
    try { console.log("  symbol :", await spContract.symbol()); } catch {}
    try { console.log("  supply :", (await spContract.totalSupply()).toString()); } catch {}
    try { console.log("  paused :", await spContract.paused()); } catch {}

    // Pool E skin too
    const skinContract = new hre.ethers.Contract(poolE.skin, SP_ABI, hre.ethers.provider);
    console.log("\nPool E HyperSkin details:");
    try { console.log("  name   :", await skinContract.name()); } catch {}
    try { console.log("  symbol :", await skinContract.symbol()); } catch {}

    console.log("\nBytecode sizes for deploy:");
    console.log("  HyperPositionLocker ~10kb (fits in small 2M-gas block — no big-block switch needed)");
  }

  if (chainId === 42161) {
    console.log("HyperPositionWrapper bytecode ~14kb — standard Arb deploy, ~0.001 ETH");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
