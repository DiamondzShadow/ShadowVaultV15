// Read-only preflight for the NFTValuer deploy. Confirms:
//   1. Deployer has ≥ 0.0005 ETH on Arbitrum
//   2. All 4 Pool NFTs are `accepted` in DiggerRegistry
//   3. Each Pool NFT's `vault()` getter matches the vault we plan to point
//      the valuer at (config-file consistency check)
const hre = require("hardhat");

const DIGGER_REGISTRY = "0x3f93B052CDA8CC0ff39BcaA04B015F86AA28af99";
const POOLS = [
  { label: "A", nft: "0xdfA8D9fe6a0FD947362a40f41f7A385c3425Dd4a", vault: "0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa" },
  { label: "B", nft: "0x67940CD1D7000494433B1Be44Dde494994393174", vault: "0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce" },
  { label: "C", nft: "0x9C86B7C9f4195d3d5150A39983ca0536353109f6", vault: "0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1" },
  { label: "D", nft: "0x4281BE12D425c6BBA1A79C5C7D1c718fC5037171", vault: "0x109B722501A713E48465cA0509E8724f6640b9D4" },
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (Number(net.chainId) !== 42161) throw new Error(`Expected 42161, got ${net.chainId}`);

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("deployer:", deployer.address);
  console.log("ETH bal :", hre.ethers.formatEther(bal));
  if (bal < hre.ethers.parseEther("0.0005")) throw new Error("deployer ETH < 0.0005");

  const registry = await hre.ethers.getContractAt("DiggerRegistry", DIGGER_REGISTRY);
  const nftAbi = ["function vault() view returns (address)"];

  console.log("\nRegistry + Pool sanity:");
  for (const p of POOLS) {
    const c = await registry.collections(p.nft);
    if (!c.accepted) throw new Error(`${p.label} not accepted`);
    const nft = new hre.ethers.Contract(p.nft, nftAbi, hre.ethers.provider);
    const v = await nft.vault();
    const match = v.toLowerCase() === p.vault.toLowerCase();
    console.log(`  Pool ${p.label}: accepted=✓ maxLtv=${c.maxLtvBps}bps  nft.vault()=${v} ${match ? "✓" : "✗ MISMATCH"}`);
    if (!match) throw new Error(`${p.label} vault mismatch: deployed=${v}, config=${p.vault}`);
  }

  console.log("\npreflight OK — safe to run deploy-nft-valuer.cjs");
}

main().catch(e => { console.error(e); process.exit(1); });
