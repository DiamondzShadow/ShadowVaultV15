// Verify that v15.3 unblocked Pool A — approve $5 USDC and deposit
// into Pool A with FLEX tier from the deployer EOA.

const { ethers } = require("hardhat");

const POOL_A_VAULT = "0x3EABca4E9F1dA0CA6b61a3CC942c09Dd51D77E32";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT = 5_000_000n; // $5 USDC (6 decimals)
const TIER_FLEX = 0;

const VAULT_ABI = [
  "function deposit(uint256 amount, uint8 tier) external returns (uint256 posId)",
  "function nextPosId() view returns (uint256)",
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
  "function bonusAccumulator() view returns (address)",
  "event Deposited(uint256 indexed posId, address indexed user, uint8 tier, uint256 amount, uint256 wsdm)",
];

const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const vault = new ethers.Contract(POOL_A_VAULT, VAULT_ABI, signer);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, signer);

  const balance = await usdc.balanceOf(signer.address);
  console.log("USDC balance:", ethers.formatUnits(balance, 6));
  if (balance < AMOUNT) throw new Error("insufficient USDC");

  const bonusAcc = await vault.bonusAccumulator();
  console.log("pool A bonusAccumulator:", bonusAcc);
  const preNextId = await vault.nextPosId();
  console.log("pool A nextPosId BEFORE:", preNextId);

  // Approve
  const allowance = await usdc.allowance(signer.address, POOL_A_VAULT);
  if (allowance < AMOUNT) {
    console.log("\napproving USDC...");
    const tx = await usdc.approve(POOL_A_VAULT, AMOUNT);
    console.log("approve tx:", tx.hash);
    await tx.wait();
  } else {
    console.log("allowance sufficient, skip approve");
  }

  // Deposit
  console.log(`\ndepositing $5 FLEX on pool A...`);
  const tx = await vault.deposit(AMOUNT, TIER_FLEX);
  console.log("deposit tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("gas used:", receipt.gasUsed.toString());

  // Parse event
  const iface = new ethers.Interface(VAULT_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "Deposited") {
        console.log(
          `\n✓ Deposited: posId=${parsed.args.posId} user=${parsed.args.user} ` +
          `tier=${parsed.args.tier} amount=${ethers.formatUnits(parsed.args.amount, 6)} ` +
          `wsdm=${parsed.args.wsdm}`
        );
      }
    } catch {}
  }

  const postNextId = await vault.nextPosId();
  console.log("pool A nextPosId AFTER:", postNextId);
  console.log("\nPool A deposit is UNBLOCKED.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
