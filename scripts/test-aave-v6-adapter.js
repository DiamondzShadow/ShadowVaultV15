const { ethers } = require("hardhat");
const hre = require("hardhat");

async function main() {
  const [admin] = await ethers.getSigners();
  console.log("admin:", admin.address);

  // Deploy adapter
  const Adapter = await ethers.getContractFactory("AaveAdapterV6");
  const adapter = await Adapter.deploy(admin.address);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("adapter:", adapterAddr);

  // Grant VAULT_ROLE to admin
  await (await adapter.addVault(admin.address)).wait();

  // Relax oracle staleness for fork
  await (await adapter.setOracleStaleness(86400)).wait();
  console.log("oracle staleness: 24h");

  // Check oracle
  try {
    const ta = await adapter.totalAssets();
    console.log("totalAssets (pre-deposit):", ta.toString());
  } catch(e) {
    console.log("totalAssets ERROR:", e.message.slice(0, 300));
    return;
  }

  // Fund admin with USDC
  const AUSDC = "0x724dc807b04555b71ed48a6896b6F41593b8C637";
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [AUSDC] });
  await hre.network.provider.send("hardhat_setBalance", [AUSDC, "0x3635C9ADC5DEA00000"]);
  const whale = await ethers.getSigner(AUSDC);
  const ERC20 = ["function transfer(address,uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns (uint256)"];
  const usdc = await ethers.getContractAt(ERC20, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", whale);
  await usdc.transfer(admin.address, 500_000_000n);
  console.log("admin USDC:", (await usdc.connect(admin).balanceOf(admin.address)).toString());

  // Approve
  await (await usdc.connect(admin).approve(adapterAddr, 500_000_000n)).wait();

  // Test fee tiers one at a time
  const feePairs = [
    [100, 500, "weETH/WETH=0.01%, WETH/USDC=0.05%"],
    [500, 500, "weETH/WETH=0.05%, WETH/USDC=0.05%"],
    [3000, 500, "weETH/WETH=0.3%, WETH/USDC=0.05%"],
    [10000, 500, "weETH/WETH=1%, WETH/USDC=0.05%"],
  ];

  for (const [weethFee, wethFee, label] of feePairs) {
    await (await adapter.setPoolFees(weethFee, wethFee)).wait();
    console.log(`\nTrying ${label}...`);
    try {
      const tx = await adapter.deposit(150_000_000n, { gasLimit: 3_000_000 });
      const r = await tx.wait();
      console.log(`  SUCCESS! gas: ${r.gasUsed.toString()}`);
      console.log(`  totalAssets: ${(await adapter.totalAssets()).toString()}`);

      // Also test withdraw
      try {
        const wtx = await adapter.withdraw(150_000_000n, { gasLimit: 3_000_000 });
        const wr = await wtx.wait();
        console.log(`  withdraw SUCCESS! gas: ${wr.gasUsed.toString()}`);
        console.log(`  USDC after withdraw: ${(await usdc.connect(admin).balanceOf(admin.address)).toString()}`);
      } catch(e) {
        console.log(`  withdraw FAILED: ${e.message.slice(0, 300)}`);
      }
      break; // stop on first success
    } catch(e) {
      console.log(`  FAILED: ${e.message.slice(0, 300)}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
