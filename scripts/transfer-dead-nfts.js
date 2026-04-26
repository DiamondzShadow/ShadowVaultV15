// Transfer COMPLETED-state position NFTs from deployer EOA to Gnosis Safe.
// Each NFT's vault-side withdrawStatus has been verified = 2 (COMPLETED)
// before this script was written. The keep-list positions (A#2, A#3, B#1,
// C#2) are NOT touched.
//
// Uses transferFrom (not safeTransferFrom) so the destination can be any
// contract without needing onERC721Received — the Gnosis Safe can always
// manage ERC721 tokens it holds via execTransaction even if its fallback
// handler doesn't implement the receiver interface.

const { ethers } = require("hardhat");

const SAFE = "0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363";

const TRANSFERS = [
  {
    pool: "A",
    label: "Blue Chip smoke",
    nftContract: "0x6F0C3e2cDeCb6D54ff3CA4e4346351BB273a99DF",
    tokenId: 1,
  },
  {
    pool: "C",
    label: "Full Spectrum smoke",
    nftContract: "0x9afA017A457682F3b7cb226Be205df7CCa467FdC",
    tokenId: 1,
  },
  {
    pool: "B_v1",
    label: "DeFi+RWA smoke (deprecated, $3 Silo orphan intact on adapter)",
    nftContract: "0x8e3Ca0a9F320ae43dA8150a48b561645584Ef66e",
    tokenId: 1,
  },
];

const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function transferFrom(address,address,uint256) external",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);
  console.log("dest safe:", SAFE);
  console.log("");

  for (const t of TRANSFERS) {
    console.log(`── Pool ${t.pool} · ${t.label} ──`);
    const nft = new ethers.Contract(t.nftContract, NFT_ABI, signer);

    // Pre-flight: confirm we still own it
    const owner = await nft.ownerOf(t.tokenId);
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(`  ✗ SKIP — current owner is ${owner}, not deployer`);
      continue;
    }
    console.log(`  current owner: ${owner}  ✓`);

    // Transfer
    console.log(`  transferFrom(signer, safe, ${t.tokenId})`);
    const tx = await nft.transferFrom(signer.address, SAFE, t.tokenId);
    console.log(`  tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`  gas used: ${rcpt.gasUsed}`);

    // Post-flight: confirm the Safe holds it now
    const newOwner = await nft.ownerOf(t.tokenId);
    if (newOwner.toLowerCase() !== SAFE.toLowerCase()) {
      throw new Error(`pool ${t.pool} transfer verification failed: owner is ${newOwner}, not Safe`);
    }
    console.log(`  ✓ Safe now holds token #${t.tokenId}\n`);
  }

  console.log("all dead NFTs transferred to Safe.");
  console.log("Verify on Arbiscan:");
  console.log(`  https://arbiscan.io/address/${SAFE}#tokentxnsErc721`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
