// Redeploy ALL 4 pools with whitelist-enabled ShadowVaultV15 contract
//
// The whitelist code was added to the Solidity source after the current
// live pools were deployed.  This script redeploys fresh vault + NFT for
// each pool, reuses the existing adapters (immutable, already proven),
// re-wires everything, and writes the new addresses to deployed.json.
//
// IMPORTANT: Active positions on old vaults (Pool A posId 2-4, Pool D posId 1)
// must be withdrawn BEFORE running this script, or they will be stranded.
//
// Usage:
//   DEPLOYER_KEY=0x... ARB_RPC=... npx hardhat run scripts/redeploy-all-whitelist.js --network arbitrum

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────── Ecosystem constants ───────────
const TREASURY   = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";
const SDM_TOKEN  = "0x602b869eEf1C9F0487F31776bad8Af3C4A173394";
const BONUS_V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";

// Trusted swap targets
const ZEROX_V2_ALLOWANCE_HOLDER = "0xfeEA2A79D7d3d36753C8917AF744D71f13C9b02a";
const ONEINCH_V5_ROUTER         = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const ZEROX_LEGACY_EP           = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

const KEEPER_ROLE_HASH = ethers.id("KEEPER_ROLE");

// ─────────── Basket tokens ───────────
const WETH   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC   = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const GMX    = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const PENDLE = "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8";
const LINK   = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4";
const ARB    = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const PEPE   = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00";
const XAUT0  = "0x40461291347e1eCbb09499F3371D3f17f10d7159";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// ─────────── Chainlink feeds ───────────
const ETH_USD_FEED    = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
const BTC_USD_FEED    = "0x6ce185860a4963106506C203335A2910413708e9";
const GMX_USD_FEED    = "0xDB98056FecFff59D032aB628337A4887110df3dB";
const PENDLE_USD_FEED = "0x66853E19D73C0F9301Fe229c5886C62db2D1E144";
const LINK_USD_FEED   = "0x86E53CF1B870786351Da77A57575e79CB55812CB";
const ARB_USD_FEED    = "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6";
const PEPE_USD_FEED   = "0x4153629e7cc3Cb7EcB3624F3B863822ffd004707"; // PythFeed wrapper (deployed V15)
const XAU_USD_FEED    = "0x587b3499d3234a93CCC411e945295e3735BBb6a4";
const ZERO_FEED       = "0x0000000000000000000000000000000000000000";

// ─────────── Existing adapters (reused, not redeployed) ───────────
const ADAPTERS = {
  A: "0x387Be58c90ac000ded0494b260c2A9dd9086e1E5",  // MorphoAdapter (Steakhouse)
  B: "0x19c60f4dBd1a73b0396485714aDf63835F199F79",  // GmxAdapter (GM ETH/USDC)
  C: "0xe9231FD442C849B293B1652aE739D165179710d6",  // AaveAdapterV5
  D: "0x763460Df40F5bA8f55854e5AcD167F4D33D66865",  // FluidAdapter
};

// ─────────── Pool configurations ───────────
const POOLS = {
  A: {
    label: "Blue Chip Morpho",
    nftName: "Blue Chip Morpho",
    adapter: ADAPTERS.A,
    basket: [
      { token: WETH, weight: 4500, feed: ETH_USD_FEED, feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: WBTC, weight: 3500, feed: BTC_USD_FEED, feedDec: 8, tokenDec: 8, staleness: 0 },
      { token: USDC, weight: 2000, feed: ZERO_FEED,    feedDec: 0, tokenDec: 6, staleness: 0 },
    ],
  },
  B: {
    label: "DeFi + RWA GMX",
    nftName: "DeFi + RWA",
    adapter: ADAPTERS.B,
    basket: [
      { token: WETH,   weight: 2500, feed: ETH_USD_FEED,    feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: GMX,    weight: 2000, feed: GMX_USD_FEED,    feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: PENDLE, weight: 2000, feed: PENDLE_USD_FEED, feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: LINK,   weight: 1500, feed: LINK_USD_FEED,   feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: XAUT0,  weight: 1000, feed: XAU_USD_FEED,    feedDec: 8, tokenDec: 6, staleness: 259200 },
      { token: USDC,   weight: 1000, feed: ZERO_FEED,       feedDec: 0, tokenDec: 6, staleness: 0 },
    ],
  },
  C: {
    label: "Full Spectrum Aave",
    nftName: "Full Spectrum Aave",
    adapter: ADAPTERS.C,
    basket: [
      { token: WETH,   weight: 2500, feed: ETH_USD_FEED,    feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: WBTC,   weight: 1500, feed: BTC_USD_FEED,    feedDec: 8, tokenDec: 8, staleness: 0 },
      { token: GMX,    weight: 1500, feed: GMX_USD_FEED,    feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: ARB,    weight: 1500, feed: ARB_USD_FEED,    feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: PENDLE, weight: 1000, feed: PENDLE_USD_FEED, feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: LINK,   weight: 1000, feed: LINK_USD_FEED,   feedDec: 8, tokenDec: 18, staleness: 0 },
      { token: PEPE,   weight: 500,  feed: PEPE_USD_FEED,   feedDec: 8, tokenDec: 18, staleness: 3600 },
      { token: USDC,   weight: 500,  feed: ZERO_FEED,       feedDec: 0, tokenDec: 6, staleness: 0 },
    ],
  },
  D: {
    label: "Hard Assets",
    nftName: "Hard Assets",
    adapter: ADAPTERS.D,
    basket: [
      { token: WBTC,  weight: 4000, feed: BTC_USD_FEED, feedDec: 8, tokenDec: 8, staleness: 0 },
      { token: XAUT0, weight: 4000, feed: XAU_USD_FEED, feedDec: 8, tokenDec: 6, staleness: 259200 },
      { token: USDC,  weight: 2000, feed: ZERO_FEED,    feedDec: 0, tokenDec: 6, staleness: 0 },
    ],
  },
};

const VAULT_ABI = [
  "function setPositionNFT(address) external",
  "function setBonusAccumulator(address) external",
  "function setTrustedSwapTarget(address,bool) external",
  "function addBasketToken(address,uint256,address,uint8,uint8,uint32) external",
  "function grantRole(bytes32,address) external",
  "function setAllocation(uint256,uint256) external",
  "function yieldAdapter() view returns (address)",
  "function positionNFT() view returns (address)",
  "function bonusAccumulator() view returns (address)",
  "function basketLength() view returns (uint256)",
  "function whitelistEnabled() view returns (bool)",
];
const NFT_ABI     = ["function addVault(address) external"];
const BONUS_ABI   = ["function addVault(address) external"];
const ADAPTER_ABI = ["function addVault(address) external"];

/// Small delay to let the sequencer sync nonce state between rapid txs.
const pause = (ms = 1500) => new Promise(r => setTimeout(r, ms));

async function deployPool(signer, poolId, cfg) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  POOL ${poolId} — ${cfg.label}`);
  console.log(`${"═".repeat(60)}`);

  // 1. Deploy vault
  console.log(`\n[1/6] Deploy vault (whitelist-enabled)`);
  const Vault = await ethers.getContractFactory("ShadowVaultV15");
  const vault = await Vault.deploy(signer.address, cfg.adapter, TREASURY, SDM_TOKEN);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`  vault: ${vaultAddr}`);
  await pause();

  // 2. Deploy NFT
  console.log(`[2/6] Deploy NFT`);
  const NFT = await ethers.getContractFactory("ShadowPositionNFTV15");
  const nft = await NFT.deploy(cfg.nftName, signer.address);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log(`  nft: ${nftAddr}`);
  await pause();

  // 3. Grant VAULT_ROLE on adapter / NFT / bonus
  console.log(`[3/6] Grant VAULT_ROLE`);
  const adapterC = new ethers.Contract(cfg.adapter, ADAPTER_ABI, signer);
  let tx;
  tx = await adapterC.addVault(vaultAddr);
  console.log(`  adapter.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  const nftC = new ethers.Contract(nftAddr, NFT_ABI, signer);
  tx = await nftC.addVault(vaultAddr);
  console.log(`  nft.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  const bonus = new ethers.Contract(BONUS_V2_1, BONUS_ABI, signer);
  tx = await bonus.addVault(vaultAddr);
  console.log(`  bonus.addVault tx: ${tx.hash}`); await tx.wait(); await pause();

  // 4. Wire vault
  console.log(`[4/6] Wire vault`);
  const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  tx = await v.setPositionNFT(nftAddr);
  console.log(`  setPositionNFT tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setBonusAccumulator(BONUS_V2_1);
  console.log(`  setBonusAccumulator tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ZEROX_V2_ALLOWANCE_HOLDER, true);
  console.log(`  trust 0x AllowanceHolder tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ONEINCH_V5_ROUTER, true);
  console.log(`  trust 1inch tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.setTrustedSwapTarget(ZEROX_LEGACY_EP, true);
  console.log(`  trust 0x legacy tx: ${tx.hash}`); await tx.wait(); await pause();

  tx = await v.grantRole(KEEPER_ROLE_HASH, signer.address);
  console.log(`  grantRole KEEPER tx: ${tx.hash}`); await tx.wait(); await pause();

  // Set allocation to 40/60 (current live setting)
  tx = await v.setAllocation(4000, 6000);
  console.log(`  setAllocation 40/60 tx: ${tx.hash}`); await tx.wait(); await pause();

  // 5. Add basket tokens
  console.log(`[5/6] Add basket tokens`);
  for (const t of cfg.basket) {
    tx = await v.addBasketToken(t.token, t.weight, t.feed, t.feedDec, t.tokenDec, t.staleness);
    console.log(`  addBasketToken tx: ${tx.hash}`); await tx.wait(); await pause();
  }

  // 6. Sanity check
  console.log(`[6/6] Sanity reads`);
  console.log(`  yieldAdapter:      ${await v.yieldAdapter()}`);
  console.log(`  positionNFT:       ${await v.positionNFT()}`);
  console.log(`  bonusAccumulator:  ${await v.bonusAccumulator()}`);
  console.log(`  basketLength:      ${(await v.basketLength()).toString()}`);
  console.log(`  whitelistEnabled:  ${await v.whitelistEnabled()}`);

  return { vault: vaultAddr, nft: nftAddr };
}

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);
  console.log("Redeploying ALL 4 pools with whitelist-enabled contract\n");

  const deployedPath = path.join(__dirname, "..", "config", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  const results = {};

  // Pool A already deployed + fully wired from first run (ran out of gas mid-B).
  // Skip re-deploying to save gas. Remove this block for a full fresh deploy.
  const SKIP = {
    A: { vault: "0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a" },
    B: { vault: "0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce", nft: "0x67940CD1D7000494433B1Be44Dde494994393174" },
  };

  for (const [poolId, cfg] of Object.entries(POOLS)) {
    if (SKIP[poolId]) {
      console.log(`\nSkipping Pool ${poolId} — already deployed at ${SKIP[poolId].vault}`);
      results[poolId] = SKIP[poolId];
      continue;
    }
    results[poolId] = await deployPool(signer, poolId, cfg);
  }

  // Archive old pools and install new ones
  for (const [poolId, addrs] of Object.entries(results)) {
    const oldKey = `${poolId}_pre_whitelist`;
    if (deployed.pools[poolId]) {
      deployed.pools[oldKey] = {
        ...deployed.pools[poolId],
        deprecated: true,
        note: `Pre-whitelist v15.8 pool — replaced by whitelist-enabled redeploy ${new Date().toISOString()}`,
      };
    }
    deployed.pools[poolId] = {
      ...deployed.pools[poolId],
      vault: addrs.vault,
      positionNFT: addrs.nft,
      version: "v15.9-whitelist",
      nftVersion: "v15.9-whitelist",
      note: undefined,
    };
  }

  deployed.v15_9_whitelistDeployedAt = new Date().toISOString();
  fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2));
  console.log("\ndeployed.json updated.");

  console.log("\n" + "═".repeat(60));
  console.log("  ALL 4 POOLS REDEPLOYED WITH WHITELIST");
  console.log("═".repeat(60));
  for (const [poolId, addrs] of Object.entries(results)) {
    console.log(`  Pool ${poolId}:`);
    console.log(`    Vault: ${addrs.vault}`);
    console.log(`    NFT:   ${addrs.nft}`);
  }
  console.log("\nNext steps:");
  console.log("  1. Verify each pool with $5 deposit");
  console.log("  2. Update dao.ts, v15.ts with new addresses");
  console.log("  3. Enable whitelist: vault.setWhitelistEnabled(true)");
  console.log("  4. Add authorized addresses: vault.setWhitelistBatch([...], true)");
}

main().catch((e) => { console.error(e); process.exit(1); });
