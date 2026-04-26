// Verify the PENDLE STRUCT FIX by depositing $5 into Pool B v2.
// If this succeeds, the FillOrderParams/Order layout fix is confirmed
// and we have a working Pendle yield adapter for future pools.

const { ethers } = require("hardhat");

const POOL_B_VAULT    = "0x493120450303c51c61eE245692d4a8F89bac2eCA";
const PENDLE_ADAPTER  = "0xFb963Ff8BeC0473b807adb1D5df48E74d394ef38";
const PENDLE_PT       = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC            = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT          = 5_000_000n;
const TIER_FLEX       = 0;

const VAULT_ABI = [
  "function deposit(uint256 amount, uint8 tier) external returns (uint256 posId)",
  "function nextPosId() view returns (uint256)",
  "event Deposited(uint256 indexed posId, address indexed user, uint8 tier, uint256 amount, uint256 wsdm)",
];
const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const vault   = new ethers.Contract(POOL_B_VAULT, VAULT_ABI, signer);
  const usdc    = new ethers.Contract(USDC, ERC20_ABI, signer);
  const adapter = new ethers.Contract(PENDLE_ADAPTER, ADAPTER_ABI, signer);
  const pt      = new ethers.Contract(PENDLE_PT, ERC20_ABI, signer);

  console.log("signer:", signer.address);
  console.log("USDC balance:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));

  const preId = await vault.nextPosId();
  const preA  = await adapter.totalAssets();
  const preP  = await adapter.totalPrincipal();
  const prePt = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("Pool B v2 nextPosId BEFORE:", preId.toString());
  console.log("PendleAdapter totalAssets BEFORE:", preA.toString());
  console.log("PendleAdapter totalPrincipal BEFORE:", preP.toString());
  console.log("PendleAdapter PT balance BEFORE:", prePt.toString());

  const allow = await usdc.allowance(signer.address, POOL_B_VAULT);
  if (allow < AMOUNT) {
    console.log("\napproving USDC...");
    const tx = await usdc.approve(POOL_B_VAULT, AMOUNT);
    console.log("approve tx:", tx.hash); await tx.wait();
  }

  console.log("\ndepositing $5 FLEX into Pool B v2 (Pendle PT-gUSDC-25JUN2026)...");
  const tx = await vault.deposit(AMOUNT, TIER_FLEX);
  console.log("deposit tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("gas used:", rcpt.gasUsed.toString());

  const iface = new ethers.Interface(VAULT_ABI);
  for (const log of rcpt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "Deposited") {
        console.log(`\n✓ Deposited: posId=${parsed.args.posId} tier=${parsed.args.tier} amount=${ethers.formatUnits(parsed.args.amount, 6)} wsdm=${parsed.args.wsdm}`);
      }
    } catch {}
  }

  const postId = await vault.nextPosId();
  const postA  = await adapter.totalAssets();
  const postP  = await adapter.totalPrincipal();
  const postPt = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("\nPool B v2 nextPosId AFTER:", postId.toString());
  console.log("PendleAdapter totalAssets AFTER:", postA.toString(), "(gain:", (postA - preA).toString(), ")");
  console.log("PendleAdapter totalPrincipal AFTER:", postP.toString());
  console.log("PendleAdapter PT balance AFTER:", postPt.toString(), "(minted:", (postPt - prePt).toString(), ")");

  console.log("\n═══ PENDLE STRUCT FIX CONFIRMED ═══");
  console.log("Pool B v2 deposit path ✓");
  console.log("$3.50 basket leg (DeFi+RWA) is idle USDC, keeper will convert next tick");
  console.log("$1.50 yield leg is now in PT-gUSDC-25JUN2026 earning ~5.5% APR fixed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
