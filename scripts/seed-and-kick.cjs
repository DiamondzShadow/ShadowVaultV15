// Step 1: fund keeper EOA with HYPE
// Step 2: bridge 5 USDC from deployer HC spot back to deployer EVM (sendAsset)
// Step 3: vault.deposit(5_000_000, Tier.FLEX) — seed first ShadowPass NFT

const { ethers } = require("ethers");
const hl = require("@nktkas/hyperliquid");
require("dotenv").config({ path: ".env.pool-e" });
require("dotenv").config();

const cfg = require("../config/deployed-pool-e-hc.json");
const USDC_SYS_ADDR = "0x2000000000000000000000000000000000000000";
const KEEPER_FUND  = ethers.parseEther("0.05");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.HYPEREVM_RPC);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  console.log("Deployer:", wallet.address);
  console.log("Config  :", cfg.vault);

  // ─── 1. Fund keeper (skip if already funded) ───
  const keeperBal = await provider.getBalance(cfg.keeper);
  if (keeperBal >= KEEPER_FUND) {
    console.log("\n[1] keeper already funded:", ethers.formatEther(keeperBal), "HYPE");
  } else {
    console.log("\n[1] Fund keeper", cfg.keeper, "with", ethers.formatEther(KEEPER_FUND), "HYPE");
    const f = await wallet.sendTransaction({ to: cfg.keeper, value: KEEPER_FUND });
    await f.wait();
    console.log("  tx:", f.hash);
  }

  // ─── 2. Bridge 5 USDC HC → EVM via sendAsset ───
  console.log("\n[2] sendAsset: HC spot USDC → EVM (deployer)");
  const info = new hl.InfoClient({ transport: new hl.HttpTransport() });
  const before = await info.spotClearinghouseState({ user: wallet.address });
  const usdcHC = before.balances?.find(b => b.coin === "USDC");
  console.log("  deployer HC USDC before:", usdcHC?.total ?? "0");

  const exchange = new hl.ExchangeClient({ wallet, transport: new hl.HttpTransport() });
  const sendRes = await exchange.sendAsset({
    destination: USDC_SYS_ADDR,
    sourceDex: "spot",
    destinationDex: "spot",
    token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
    amount: "3",
  });
  console.log("  sendAsset:", JSON.stringify(sendRes));

  // Wait for USDC on EVM
  const usdc = new ethers.Contract(cfg.usdc, ["function balanceOf(address) view returns (uint256)"], provider);
  console.log("  waiting for EVM arrival...");
  let evmBal = 0n;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    evmBal = await usdc.balanceOf(wallet.address);
    console.log(`    [${i*4}s] deployer EVM USDC:`, ethers.formatUnits(evmBal, 6));
    if (evmBal >= 5_000_000n) break;
  }
  if (evmBal < 5_000_000n) throw new Error("USDC did not arrive on EVM");

  // ─── 3. Seed deposit ───
  console.log("\n[3] vault.deposit(5 USDC, Tier.FLEX)");
  const usdcW = new ethers.Contract(cfg.usdc, ["function approve(address,uint256) returns (bool)"], wallet);
  await (await usdcW.approve(cfg.vault, 5_000_000n)).wait();
  console.log("  approved vault for 5 USDC");

  const vault = new ethers.Contract(cfg.vault, [
    "function deposit(uint256,uint8) returns (uint256)",
    "function totalAssets() view returns (uint256)"
  ], wallet);
  const dtx = await vault.deposit(5_000_000n, 0);  // FLEX = 0
  console.log("  tx:", dtx.hash);
  const rc = await dtx.wait();
  console.log("  mined block", rc.blockNumber);

  const ta = await vault.totalAssets();
  console.log("  vault.totalAssets:", ethers.formatUnits(ta, 6), "USDC");

  console.log("\n✓ Pool E is LIVE with a $5 seed position");
})().catch(e => { console.error(e); process.exit(1); });
