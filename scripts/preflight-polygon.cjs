// Read-only preflight on Polygon PoS (chain 137). Inspects:
//   - Deployer POL balance (gas)
//   - Each Polygon V15 pool vault: totalAssets, depositor count, deployer balance
//   - Each Position NFT: total supply, deployer's token IDs
//   - Summarizes drainable value per pool
// Does NOT move anything. Safe to run repeatedly.

const hre = require("hardhat");

const POOLS = [
  { label: "A (Blue Chip)",      vault: "0xBAF20b022c7D30E4F2f42238152A9AE7D183aaEf", nft: "0x6bef5509890dc0f0B613ea8efe471ed9c23D7B1c" },
  { label: "B (Polygon DeFi)",   vault: "0xB9FA2148A18Ac8a2Eea91e8529BAbc3B943970a4", nft: "0x819736a28a2922c302a16A0c4CE39F402FFdbbc8" },
  { label: "C (Full Spectrum)",  vault: "0xA92767d3AdE9859EaD492158aE26A70C883A34fF", nft: "0x05CDD626ed21D6B3De096849a51ca5dA892dD5B7" },
  { label: "D (Hard Money)",     vault: "0xa2A7227752C8f77b866D7903db39F1317f30fA08", nft: "0x45985109C0235c320D2a0c9111C4CE905720C309" },
];

const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const DEPLOYER = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";

function fmt(n, dec = 6) { return (Number(n) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec }); }

const vaultAbi = [
  "function totalAssets() view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 depositTime, uint256 unlockTime, uint8 withdrawStatus)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
];
const nftAbi = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
];
const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 137) throw new Error(`Expected 137, got ${net.chainId}`);
  const bal = await hre.ethers.provider.getBalance(signer.address);
  console.log("reader :", signer.address);
  console.log("POL bal:", hre.ethers.formatEther(bal), "POL");

  const usdc = new hre.ethers.Contract(USDC, erc20Abi, hre.ethers.provider);

  let totalValue = 0n;
  let anyOtherHolders = false;
  const drain = [];

  for (const p of POOLS) {
    console.log("\n═══", p.label, "═══");
    const v = new hre.ethers.Contract(p.vault, vaultAbi, hre.ethers.provider);
    const n = new hre.ethers.Contract(p.nft, nftAbi, hre.ethers.provider);
    let ta = 0n, paused = false, owner = "?";
    try { ta = await v.totalAssets(); } catch (e) { console.log("  totalAssets reverted (empty basket?)"); }
    try { paused = await v.paused(); } catch {}
    try { owner = await v.owner(); } catch {}
    const usdcInVault = await usdc.balanceOf(p.vault);
    console.log(`  vault      : ${p.vault}`);
    console.log(`  owner      : ${owner}`);
    console.log(`  paused     : ${paused}`);
    console.log(`  totalAssets: ${fmt(ta)} USDC`);
    console.log(`  idle USDC  : ${fmt(usdcInVault)} USDC`);

    // NFT state
    let totalSupply = 0n, deployerBal = 0n, deployerTokenIds = [];
    try { totalSupply = await n.totalSupply(); } catch {}
    try { deployerBal = await n.balanceOf(DEPLOYER); } catch {}
    console.log(`  NFT        : ${p.nft}`);
    console.log(`  NFT supply : ${totalSupply.toString()}`);
    console.log(`  deployer NFTs: ${deployerBal.toString()}`);

    if (deployerBal > 0n && totalSupply <= 10n) {
      // list specific tokenIds held by deployer + their position data
      for (let i = 0n; i < deployerBal; i++) {
        try {
          const id = await n.tokenOfOwnerByIndex(DEPLOYER, i);
          deployerTokenIds.push(id);
          const pos = await v.positions(id);
          const status = ["NONE","REQUESTED","COMPLETED"][Number(pos.withdrawStatus)];
          console.log(`    tokenId #${id}: deposit=${fmt(pos.depositAmount)} USDC tier=${pos.tier} status=${status}`);
        } catch (e) { console.log(`    tokenId index ${i}: read failed ${e.shortMessage || e.message}`); }
      }
    }

    // Are there OTHER NFT holders? Iterate supply and check owner.
    if (totalSupply > 0n && totalSupply <= 20n) {
      let otherHolders = 0;
      for (let id = 1n; id <= totalSupply; id++) {
        try {
          const o = await n.ownerOf(id);
          if (o.toLowerCase() !== DEPLOYER.toLowerCase()) otherHolders++;
        } catch {}
      }
      if (otherHolders > 0) {
        anyOtherHolders = true;
        console.log(`  ⚠ OTHER HOLDERS: ${otherHolders} NFT(s) held by addresses other than deployer`);
      } else {
        console.log(`  ✓ only deployer holds NFTs in this pool`);
      }
    } else if (totalSupply > 20n) {
      console.log(`  ⚠ ${totalSupply} NFTs minted — too many to iterate, assume multi-user`);
      anyOtherHolders = true;
    }

    totalValue += ta;
    drain.push({ pool: p.label, vault: p.vault, totalAssets: ta.toString(), idle: usdcInVault.toString(), deployerNFTs: deployerBal.toString(), totalNFTSupply: totalSupply.toString() });
  }

  console.log("\n═══ Summary ═══");
  console.log(`4 pools total value: ${fmt(totalValue)} USDC`);
  console.log(`multi-user risk    : ${anyOtherHolders ? "YES — other NFT holders exist somewhere" : "NO — deployer is sole holder across inspected pools"}`);
  console.log("\nJSON:", JSON.stringify(drain, null, 2));

  console.log("\nCCIP lane status (Polygon ↔ Arb):");
  console.log("  per prior memory, SDM CCIP mesh Arb<->Poly is live (chain 137 ↔ 42161)");
  console.log("  CCIP router Polygon: 0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe");
  console.log("  CCIP chain selector Arb: 4949039107694359620");
  console.log("  NFT bridging via CCIP is NOT currently wired — needs CCIP-enabled NFT wrapper.");
}

main().catch(e => { console.error(e); process.exit(1); });
