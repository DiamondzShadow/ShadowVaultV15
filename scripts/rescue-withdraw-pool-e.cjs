// Complete the Phase-A rescue: pull the $5 out of Pool E via vault.requestWithdraw(1) →
// vault.completeWithdraw(1). Run AFTER rescue-pool-e-stuck.cjs + poll-sweep confirmed
// adapter idle ≥ position share.
//
// Roles:
//   - requestWithdraw is called by the position owner (deployer = tokenId #1 holder)
//   - completeWithdraw is called by deployer (who now holds KEEPER_ROLE on the vault — verify)
//
// Dry-run by default. EXECUTE=1 to send.

const hre = require("hardhat");

const VAULT   = "0x31D4BD9C446865333fB219F9ebAB6EbFCA9302Ba";
const ADAPTER = "0x5c45a7a4fE3A28FA8d55521F8F501173312C20e4";
const NFT     = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0";
const POS_ID  = 1n;
const KEEPER_ROLE = "0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab";
const EXECUTE = process.env.EXECUTE === "1";

const VAULT_ABI = [
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function pendingWithdraws(uint256) view returns (address user, uint256 usdcGathered, uint256 yieldUSDC, uint256 basketUSDC, uint256 feeBps, uint256 requestTime)",
  "function yieldTotalShares() view returns (uint256)",
  "function wsdmTotalSupply() view returns (uint256)",
  "function lastDepositTime(address) view returns (uint256)",
  "function withdrawTimeout() view returns (uint256)",
  "function onTimeFeeBps() view returns (uint256)",
  "function earlyExitFeeBps() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function treasury() view returns (address)",
  "function requestWithdraw(uint256) external",
  "function completeWithdraw(uint256) external",
];
const ADAPTER_ABI = [
  "function idleUsdc() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];
const NFT_ABI = [
  "function ownerOf(uint256) view returns (address)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function usd(n) { return "$" + (Number(n)/1e6).toFixed(6); }

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const vault = new hre.ethers.Contract(VAULT, VAULT_ABI, signer);
  const adapter = new hre.ethers.Contract(ADAPTER, ADAPTER_ABI, signer);
  const nft = new hre.ethers.Contract(NFT, NFT_ABI, signer);
  const usdcAddr = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
  const usdc = new hre.ethers.Contract(usdcAddr, USDC_ABI, signer);

  console.log("\n=== Pool E rescue: vault withdraw ===");
  console.log("signer:", signer.address);
  console.log("mode  :", EXECUTE ? "EXECUTE" : "DRY-RUN");

  const [owner, pos, ptotal, idle, adapterTotal, yieldShares, wsdmTotal, lastDep, timeout, onTime, early, isKeeper, treasury, userUsdc] = await Promise.all([
    nft.ownerOf(POS_ID),
    vault.positions(POS_ID),
    adapter.totalPrincipal(),
    adapter.idleUsdc(),
    adapter.totalAssets(),
    vault.yieldTotalShares(),
    vault.wsdmTotalSupply(),
    vault.lastDepositTime(signer.address),
    vault.withdrawTimeout(),
    vault.onTimeFeeBps(),
    vault.earlyExitFeeBps(),
    vault.hasRole(KEEPER_ROLE, signer.address),
    vault.treasury(),
    usdc.balanceOf(signer.address),
  ]);

  const block = await hre.ethers.provider.getBlock("latest");

  console.log("\n--- Pre-state ---");
  console.log("position #1 owner:    ", owner);
  console.log("  yieldShare:         ", pos.yieldShare.toString());
  console.log("  wsdmAmount:         ", pos.wsdmAmount.toString());
  console.log("  tier:               ", pos.tier.toString(), "(0=FLEX, 1=30D, 2=90D)");
  console.log("  unlockTime:         ", pos.unlockTime.toString(), "(now:", block.timestamp, ")");
  console.log("  withdrawStatus:     ", pos.withdrawStatus.toString(), "(0=NONE, 1=REQUESTED, 2=COMPLETED)");
  console.log("  loanOutstanding:    ", pos.loanOutstanding.toString());
  console.log("vault.yieldTotalShares:", yieldShares.toString());
  console.log("vault.wsdmTotalSupply:", wsdmTotal.toString());
  console.log("vault.lastDepositTime:", lastDep.toString());
  console.log("vault.withdrawTimeout:", timeout.toString(), "sec");
  console.log("vault.onTimeFeeBps:   ", onTime.toString(), "bps");
  console.log("vault.earlyExitFeeBps:", early.toString(), "bps");
  console.log("vault.treasury:       ", treasury);
  console.log("signer has KEEPER_ROLE on vault:", isKeeper);
  console.log("adapter.idleUsdc:     ", usd(idle));
  console.log("adapter.totalAssets:  ", usd(adapterTotal));
  console.log("adapter.totalPrincipal:", usd(ptotal));
  console.log("signer USDC balance:  ", usd(userUsdc));

  // Preview withdraw math
  const share = yieldShares > 0n ? (adapterTotal * pos.yieldShare) / yieldShares : 0n;
  console.log("\n--- Preview ---");
  console.log("yieldUSDC (share):    ", usd(share));
  console.log("adapter will deliver: ", usd(share > idle ? idle : share));
  console.log("95% gate passes:      ", share > 0n ? ((share > idle ? idle : share) * 100n >= share * 95n) : "n/a");
  const early_ = (pos.tier !== 0n) && (BigInt(block.timestamp) < pos.unlockTime);
  const feeBps = early_ ? early : onTime;
  console.log("feeBps (", early_ ? "early" : "on-time", "):", feeBps.toString());

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("\n[ABORT] signer is not position owner");
    return;
  }
  if (pos.withdrawStatus !== 0n) {
    console.log("\n[ABORT] position already in withdraw flow, status =", pos.withdrawStatus.toString());
    return;
  }
  if (pos.loanOutstanding !== 0n) {
    console.log("\n[ABORT] position has outstanding loan");
    return;
  }
  if (BigInt(lastDep) === BigInt(block.timestamp)) {
    console.log("\n[ABORT] cooldown active (lastDepositTime == now)");
    return;
  }

  if (!EXECUTE) {
    console.log("\n[DRY-RUN] no txs sent. Re-run with EXECUTE=1.");
    return;
  }

  // --- step 1: requestWithdraw ---
  console.log("\n[1/2] requestWithdraw(" + POS_ID + ") ...");
  const tx1 = await vault.requestWithdraw(POS_ID);
  console.log("  tx:", tx1.hash);
  await tx1.wait();
  console.log("  mined.");

  const pw = await vault.pendingWithdraws(POS_ID);
  console.log("  pendingWithdraw.yieldUSDC:", usd(pw.yieldUSDC));
  console.log("  pendingWithdraw.basketUSDC:", usd(pw.basketUSDC));
  console.log("  pendingWithdraw.feeBps:   ", pw.feeBps.toString());

  // --- step 2: completeWithdraw ---
  if (!isKeeper) {
    console.log("\n[NOTE] signer lacks KEEPER_ROLE on vault — must either grant role or wait withdrawTimeout");
    // Check if we can self-complete via timeout (user branch)
    console.log("[NOTE] will attempt completeWithdraw via timeout path after", timeout.toString(), "sec");
    return;
  }

  console.log("\n[2/2] completeWithdraw(" + POS_ID + ") ...");
  const tx2 = await vault.completeWithdraw(POS_ID);
  console.log("  tx:", tx2.hash);
  await tx2.wait();
  console.log("  mined.");

  const userAfter = await usdc.balanceOf(signer.address);
  console.log("\n--- Post-state ---");
  console.log("signer USDC balance:", usd(userAfter), "(delta: +" + usd(userAfter - userUsdc) + ")");
}

main().catch(e => { console.error(e); process.exit(1); });
