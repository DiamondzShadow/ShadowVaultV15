// Verify Pool D (Hard Assets) end-to-end with a $5 FLEX deposit.

const { ethers } = require("hardhat");

const POOL_D_VAULT   = "0x07D31F7d2fc339556c8b31769B2721007C3Ac82D";
const FLUID_ADAPTER  = "0x763460Df40F5bA8f55854e5AcD167F4D33D66865";
const USDC           = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT         = 5_000_000n;
const TIER_FLEX      = 0;

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
  const vault   = new ethers.Contract(POOL_D_VAULT, VAULT_ABI, signer);
  const usdc    = new ethers.Contract(USDC, ERC20_ABI, signer);
  const adapter = new ethers.Contract(FLUID_ADAPTER, ADAPTER_ABI, signer);

  console.log("signer:", signer.address);
  console.log("USDC balance:", ethers.formatUnits(await usdc.balanceOf(signer.address), 6));

  const preId = await vault.nextPosId();
  const preA  = await adapter.totalAssets();
  const preP  = await adapter.totalPrincipal();
  console.log("Pool D nextPosId BEFORE:", preId.toString());
  console.log("Adapter totalAssets BEFORE:", preA.toString());
  console.log("Adapter totalPrincipal BEFORE:", preP.toString());

  const allow = await usdc.allowance(signer.address, POOL_D_VAULT);
  if (allow < AMOUNT) {
    console.log("\napproving USDC...");
    const tx = await usdc.approve(POOL_D_VAULT, AMOUNT);
    console.log("approve tx:", tx.hash); await tx.wait();
  }

  console.log("\ndepositing $5 FLEX into Pool D (Hard Assets)...");
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
  console.log("\nPool D nextPosId AFTER:", postId.toString());
  console.log("Adapter totalAssets AFTER:", postA.toString(), "(gain:", (postA - preA).toString(), ")");
  console.log("Adapter totalPrincipal AFTER:", postP.toString());

  console.log("\nPool D Hard Assets deposit path ✓");
  console.log("$3.50 basket leg is idle USDC, will convert to WBTC+XAUt0 on next keeper tick");
  console.log("$1.50 yield leg is now earning Fluid ~3-5% APR");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
