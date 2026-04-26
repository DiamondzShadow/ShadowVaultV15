// Read-only snapshot of LendingPool v1.2 state prior to v1.3 migration.
// Confirms:
//   - Who holds supplier shares (should only be the deployer if user claim "we're
//     the only ones using it" is true)
//   - Whether any loans are active
//   - Protocol reserve balance
//   - SweepController allocations (idle in pool + Aave + HyperEVM)
//
// Does NOT move any funds. Safe to run repeatedly.

const hre = require("hardhat");

const POOL_V12      = "0xA1C503676e9572b792BEE9687d635b4A474690C1";
const SWEEP_CTRL    = "0xE2239A47a98976984aab7bf4E8fea1Db04E1BdC3";
const AAVE_SINK     = "0x6CC249345f6C6a85F2128d03c3818026c492F18D";
const HYPER_MIRROR  = "0x6d114293629153d60eD1C19012BE117Df2d72963";
const USDC          = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DEPLOYER      = "0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3";
const SAFE          = "0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43";

function fmt(n, dec = 6) {
  return (Number(n) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec });
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  console.log("reader:", signer.address);

  const pool = await hre.ethers.getContractAt("LendingPool", POOL_V12);
  const usdc = await hre.ethers.getContractAt("IERC20", USDC);

  // ───── Supplier side
  console.log("\n═══ Supplier side ═══");
  const totalShares = await pool.totalShares();
  const totalBorrowed = await pool.totalBorrowed();
  const poolUSDC = await usdc.balanceOf(POOL_V12);
  const totalAssets = await pool.totalAssets();
  console.log("totalShares     :", totalShares.toString());
  console.log("totalBorrowed   :", fmt(totalBorrowed), "USDC");
  console.log("pool idle USDC  :", fmt(poolUSDC), "USDC");
  console.log("totalAssets     :", fmt(totalAssets), "USDC");

  const deployerShares = await pool.sharesOf(DEPLOYER);
  const safeShares     = await pool.sharesOf(SAFE);
  console.log(`deployer shares : ${deployerShares.toString()}`);
  console.log(`safe shares     : ${safeShares.toString()}`);
  const deployerWithdrawable = deployerShares > 0n
    ? await pool.previewWithdraw(deployerShares) : 0n;
  const safeWithdrawable = safeShares > 0n
    ? await pool.previewWithdraw(safeShares) : 0n;
  console.log(`deployer would withdraw: ${fmt(deployerWithdrawable)} USDC`);
  console.log(`safe would withdraw    : ${fmt(safeWithdrawable)} USDC`);

  // Anyone else? Compare sum of known shares to totalShares.
  const known = deployerShares + safeShares;
  const unknown = totalShares - known;
  console.log(`unknown shares  : ${unknown.toString()}  (${unknown === 0n ? "ZERO — only known holders" : "OTHER HOLDERS EXIST — stop, inspect before migrating"})`);

  // ───── Loan side
  console.log("\n═══ Loans ═══");
  const nextLoanId = await pool.nextLoanId();
  const openLoanIds = [];
  for (let i = 1n; i < nextLoanId; i++) {
    const L = await pool.loans(i);
    // Loan tuple: borrower, nft, tokenId, principal, lastAccrualTime, startTime, accruedFeesUnpaid, yieldRepayBps, status, unwindTarget
    // v1.2 deployed BEFORE the unwindTarget field was added, so it's the 9-field layout.
    const status = Number(L.status);
    const statusStr = ["NONE","ACTIVE","LIQUIDATING","CLOSED"][status];
    if (status === 1 || status === 2) {
      openLoanIds.push(i);
      console.log(`  loan #${i}: borrower=${L.borrower} nft=${L.nft} tokenId=${L.tokenId} principal=${fmt(L.principal)} USDC status=${statusStr}`);
    }
  }
  console.log(`total loans created: ${nextLoanId - 1n}`);
  console.log(`active/liquidating : ${openLoanIds.length}`);

  // ───── Reserve
  console.log("\n═══ Reserve ═══");
  const reserve = await pool.protocolReserve();
  console.log("protocolReserve :", fmt(reserve), "USDC");

  // ───── Sweep stack
  console.log("\n═══ Sweep stack ═══");
  const sweep = await hre.ethers.getContractAt("SweepController", SWEEP_CTRL);
  const sweepIdleUSDC = await usdc.balanceOf(SWEEP_CTRL);
  console.log("sweep idle USDC:", fmt(sweepIdleUSDC));
  try {
    const targets = await sweep.targets();
    console.log("targets        :", targets.reserveBps, "/", targets.aaveBps, "/", targets.remoteBps, "bps (reserve/aave/remote)");
  } catch {}
  // AaveSink balance
  try {
    const aaveUsdc = await usdc.balanceOf(AAVE_SINK);
    console.log("aave-sink idle :", fmt(aaveUsdc));
  } catch {}
  // aTokens in the sink
  try {
    const aToken = await hre.ethers.getContractAt("IERC20", "0x724dc807b04555b71ed48a6896b6F41593b8C637"); // aArbUSDCn
    const aBal = await aToken.balanceOf(AAVE_SINK);
    console.log("aave-sink aUSDC:", fmt(aBal));
  } catch (e) {
    console.log("(could not read aUSDC)");
  }

  // HyperRemoteMirror attested balance
  try {
    const mirror = await hre.ethers.getContractAt("HyperRemoteMirror", HYPER_MIRROR);
    const attestedRemote = await mirror.remoteBalance();
    console.log("remote attested:", fmt(attestedRemote));
  } catch {}

  console.log("\n═══ Summary ═══");
  const totalPoolReachable = poolUSDC + sweepIdleUSDC;
  console.log("directly drainable (pool+sweep idle):", fmt(totalPoolReachable), "USDC");
}

main().catch(e => { console.error(e); process.exit(1); });
