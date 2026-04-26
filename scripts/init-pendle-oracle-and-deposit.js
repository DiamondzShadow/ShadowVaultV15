// Initialize the Pendle oracle cardinality on our adapter's market, then
// retry the $5 Pool D deposit. The pre-deploy getOracleState returned
// (true, 901, true) — we need to bump `increaseObservationsCardinalityNext`
// to 901 so the TWAP window is coverable.

const { ethers } = require("hardhat");

const POOL_D_VAULT    = "0x38002195F17cE193c8E69690f4B6F4757c202078";
const PENDLE_ADAPTER  = "0xed05AfD6E4D901fd9689E1E90B97b7cfFe1872b9";
const PENDLE_MARKET   = "0x0934E592cEe932b04B3967162b3CD6c85748C470";
const PENDLE_ORACLE   = "0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2";
const PENDLE_PT       = "0x97c1a4AE3E0DA8009aFf13e3e3EE7eA5ee4Afe84";
const USDC            = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const AMOUNT          = 5_000_000n;

const ADAPTER_ABI = [
  "function initializeOracle() external",
  "function totalAssets() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];

const ORACLE_ABI = [
  "function getOracleState(address market, uint32 duration) view returns (bool increaseCardinalityRequired, uint16 cardinalityRequired, bool oldestObservationSatisfied)",
];

const MARKET_ABI = [
  "function increaseObservationsCardinalityNext(uint16 cardinalityNext) external",
];

const VAULT_ABI = [
  "function deposit(uint256,uint8) external returns (uint256)",
  "function nextPosId() view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const oracle = new ethers.Contract(PENDLE_ORACLE, ORACLE_ABI, signer);
  const market = new ethers.Contract(PENDLE_MARKET, MARKET_ABI, signer);
  const adapter = new ethers.Contract(PENDLE_ADAPTER, ADAPTER_ABI, signer);

  console.log("\n── Initial oracle state ──");
  let [needBump, cardReq, oldestOk] = await oracle.getOracleState(PENDLE_MARKET, 900);
  console.log(`  increaseCardinalityRequired: ${needBump}`);
  console.log(`  cardinalityRequired: ${cardReq}`);
  console.log(`  oldestObservationSatisfied: ${oldestOk}`);

  if (needBump) {
    console.log(`\n── Calling market.increaseObservationsCardinalityNext(${cardReq}) directly ──`);
    // Call the market directly — simpler than routing through adapter's init
    // which passes the same value. Costs gas for pre-allocating the next slots.
    const tx = await market.increaseObservationsCardinalityNext(cardReq);
    console.log("tx:", tx.hash);
    const rcpt = await tx.wait();
    console.log("gas used:", rcpt.gasUsed.toString());

    console.log("\n── Re-checking oracle state ──");
    [needBump, cardReq, oldestOk] = await oracle.getOracleState(PENDLE_MARKET, 900);
    console.log(`  increaseCardinalityRequired: ${needBump}`);
    console.log(`  cardinalityRequired: ${cardReq}`);
    console.log(`  oldestObservationSatisfied: ${oldestOk}`);
  }

  if (needBump) {
    console.log("\n⚠ Oracle still wants more cardinality. Pendle grows slots per-swap.");
    console.log("  The market is active so it should fill fast. Waiting 30s then retrying.");
    await new Promise((r) => setTimeout(r, 30_000));
    [needBump, cardReq, oldestOk] = await oracle.getOracleState(PENDLE_MARKET, 900);
    console.log(`  increaseCardinalityRequired: ${needBump}`);
  }

  if (needBump) {
    console.log("\n✗ Oracle still not ready after 30s. Aborting deposit. Cardinality will grow over time as Pendle sees swaps on the market. Retry the deposit script later.");
    return;
  }

  // ─── Try deposit ───
  const vault = new ethers.Contract(POOL_D_VAULT, VAULT_ABI, signer);
  const usdc  = new ethers.Contract(USDC, ERC20_ABI, signer);
  const pt    = new ethers.Contract(PENDLE_PT, ERC20_ABI, signer);

  console.log("\n── Oracle ready — attempting $5 deposit ──");
  const bal = await usdc.balanceOf(signer.address);
  console.log("USDC balance:", ethers.formatUnits(bal, 6));

  const allow = await usdc.allowance(signer.address, POOL_D_VAULT);
  if (allow < AMOUNT) {
    const tx = await usdc.approve(POOL_D_VAULT, AMOUNT);
    console.log("approve tx:", tx.hash);
    await tx.wait();
  }

  const preAdapter = await adapter.totalAssets();
  const prePt = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("Adapter totalAssets before:", preAdapter.toString());
  console.log("Adapter PT balance before:", prePt.toString());

  const tx = await vault.deposit(AMOUNT, 0);
  console.log("\ndeposit tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("gas used:", rcpt.gasUsed.toString());

  const postAdapter = await adapter.totalAssets();
  const postPt = await pt.balanceOf(PENDLE_ADAPTER);
  console.log("Adapter totalAssets after:", postAdapter.toString());
  console.log("Adapter PT balance after:", postPt.toString(), "(minted:", (postPt - prePt).toString(), ")");
  console.log("Pool D nextPosId:", (await vault.nextPosId()).toString());
  console.log("\nPool D live with PendleAdapter earning ~PT-gUSDC-25JUN2026 rate ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
