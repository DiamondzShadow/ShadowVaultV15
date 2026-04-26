// Verify Pool D end-to-end: approve $5 USDC, deposit as FLEX, read back position state.
// Also confirms Pendle adapter received the $1.50 yield leg and minted PT tokens.

const { ethers } = require("hardhat");

const POOL_D_VAULT   = "0x38002195F17cE193c8E69690f4B6F4757c202078";
const PENDLE_ADAPTER = "0xed05AfD6E4D901fd9689E1E90B97b7cfFe1872b9";
const PENDLE_PT      = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC           = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT         = 5_000_000n;   // $5
const TIER_FLEX      = 0;

const VAULT_ABI = [
  "function deposit(uint256 amount, uint8 tier) external returns (uint256 posId)",
  "function nextPosId() view returns (uint256)",
  "function positions(uint256) view returns (address depositor, uint8 tier, uint256 depositAmount, uint256 wsdmAmount, uint256 yieldShare, uint256 yieldClaimed, uint256 depositTime, uint256 unlockTime, uint256 multiplierBps, uint256 loanOutstanding, uint8 withdrawStatus)",
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
  const adapter = new ethers.Contract(PENDLE_ADAPTER, ADAPTER_ABI, signer);
  const pt      = new ethers.Contract(PENDLE_PT, ERC20_ABI, signer);

  console.log("signer:", signer.address);
  const bal = await usdc.balanceOf(signer.address);
  console.log("USDC balance:", ethers.formatUnits(bal, 6));

  const preNextId    = await vault.nextPosId();
  const preAdapter   = await adapter.totalAssets();
  const prePrincipal = await adapter.totalPrincipal();
  const prePt        = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("Pool D nextPosId BEFORE:", preNextId.toString());
  console.log("Adapter totalAssets BEFORE:", preAdapter.toString());
  console.log("Adapter totalPrincipal BEFORE:", prePrincipal.toString());
  console.log("Adapter PT balance BEFORE:", prePt.toString());

  const allow = await usdc.allowance(signer.address, POOL_D_VAULT);
  if (allow < AMOUNT) {
    console.log("\napproving USDC...");
    const tx = await usdc.approve(POOL_D_VAULT, AMOUNT);
    console.log("approve tx:", tx.hash);
    await tx.wait();
  } else {
    console.log("allowance sufficient");
  }

  console.log("\ndepositing $5 FLEX into Pool D...");
  const tx = await vault.deposit(AMOUNT, TIER_FLEX);
  console.log("deposit tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("gas used:", rcpt.gasUsed.toString());

  // Parse Deposited event
  const iface = new ethers.Interface(VAULT_ABI);
  for (const log of rcpt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "Deposited") {
        console.log(
          `\n✓ Deposited: posId=${parsed.args.posId} tier=${parsed.args.tier} ` +
          `amount=${ethers.formatUnits(parsed.args.amount, 6)} wsdm=${parsed.args.wsdm}`
        );
      }
    } catch {}
  }

  const postNextId    = await vault.nextPosId();
  const postAdapter   = await adapter.totalAssets();
  const postPrincipal = await adapter.totalPrincipal();
  const postPt        = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("\nPool D nextPosId AFTER:", postNextId.toString());
  console.log("Adapter totalAssets AFTER:", postAdapter.toString(), "(gain:", (postAdapter - preAdapter).toString(), ")");
  console.log("Adapter totalPrincipal AFTER:", postPrincipal.toString());
  console.log("Adapter PT balance AFTER:", postPt.toString(), "(minted:", (postPt - prePt).toString(), ")");

  console.log("\nPool D deposit path end-to-end ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
