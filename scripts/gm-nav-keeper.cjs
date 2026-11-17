#!/usr/bin/env node
// GM NAV keeper for GmNavOracle (pairs with contracts/adapters/GmGmxAdapterV1.sol).
//
// NAV pushed = GM balance × GM price + un-swept index-token balance × Chainlink price, in USDC 6-dec.
// (USDC buffer + in-flight deposits are counted by the adapter itself, so they are NOT in the push.)
// GM price = GMX poolValueMin / GM totalSupply — the conservative (lower) side of GMX's pool valuation,
// from @gmx-io/sdk v2 (GmxApiSdk.fetchMarketsValues, HTTP; no RPC/oracle wiring needed).
//
//   node scripts/gm-nav-keeper.cjs --adapter 0x… --oracle 0x…            read-only: prints the NAV it would push
//   node scripts/gm-nav-keeper.cjs --adapter 0x… --oracle 0x… --execute  pushes it (KEEPER_ROLE on the oracle)
// Env (names only): ARB_RPC, GM_NAV_KEEPER_KEY (only for --execute).
// Fail-safe: refuses to push if the move would exceed the oracle's drift cap (that needs a human), and
// never pushes when GMX's API or Chainlink data is missing.

const { ethers } = require("ethers");
const { GmxApiSdk } = require("@gmx-io/sdk/v2");

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EXECUTE = args.includes("--execute");
const ADAPTER = arg("--adapter");
const ORACLE = arg("--oracle");
const RPC = process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc";
if (!ADAPTER || !ethers.isAddress(ADAPTER)) { console.error("--adapter <address> required"); process.exit(2); }
if (!ORACLE || !ethers.isAddress(ORACLE)) { console.error("--oracle <address> required"); process.exit(2); }

const ADAPTER_ABI = [
  "function market() view returns (address)",
  "function indexToken() view returns (address)",
  "function indexDecimals() view returns (uint8)",
  "function INDEX_USD_FEED() view returns (address)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"];
const FEED = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ORACLE_ABI = [
  "function navs(address) view returns (bool registered, uint256 lastNavUsd6, uint64 lastNavAt, uint32 maxStalenessSecs, uint16 maxDriftBps, bool paused)",
  "function pushNav(address market, uint256 navUsd6)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const ad = new ethers.Contract(ADAPTER, ADAPTER_ABI, provider);
  const [market, indexToken, indexDec, feedAddr] = await Promise.all([ad.market(), ad.indexToken(), ad.indexDecimals(), ad.INDEX_USD_FEED()]);
  const gm = new ethers.Contract(market, ERC20, provider);
  const idx = new ethers.Contract(indexToken, ERC20, provider);
  const feed = new ethers.Contract(feedAddr, FEED, provider);
  const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, provider);

  const sdk = new GmxApiSdk({ chainId: 42161 });
  const values = await sdk.fetchMarketsValues();
  const list = Array.isArray(values) ? values : Object.values(values);
  const mv = list.find((v) => v.marketTokenAddress && v.marketTokenAddress.toLowerCase() === market.toLowerCase());
  if (!mv || mv.poolValueMin === undefined) throw new Error(`GMX API has no pool value for ${market}`);
  const poolValueMin = BigInt(mv.poolValueMin); // USD, 30 decimals

  const [gmBal, gmSupply, idxBal, round, feedDec, nav] = await Promise.all([
    gm.balanceOf(ADAPTER), gm.totalSupply(), idx.balanceOf(ADAPTER), feed.latestRoundData(), feed.decimals(), oracle.navs(market),
  ]);
  if (gmSupply === 0n) throw new Error("GM totalSupply is 0");
  const [, answer, , updatedAt] = round;
  if (answer <= 0n) throw new Error("Chainlink index price <= 0");
  const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
  if (age > 3600) throw new Error(`Chainlink index price is ${age}s old`);

  // GM value (USDC 6-dec) = gmBal × poolValueMin / supply, scaled 1e30 → 1e6
  const gmUsd6 = (gmBal * poolValueMin) / gmSupply / 10n ** 24n;
  // index value (USDC 6-dec) = idxBal × price / 10^(indexDec + feedDec − 6)
  const idxUsd6 = (idxBal * BigInt(answer)) / 10n ** BigInt(Number(indexDec) + Number(feedDec) - 6);
  const navUsd6 = gmUsd6 + idxUsd6;

  const gmPrice = Number((poolValueMin * 10n ** 18n) / gmSupply / 10n ** 24n) / 1e6;
  const prev = nav.lastNavUsd6;
  const driftBps = prev === 0n ? 0n : ((navUsd6 > prev ? navUsd6 - prev : prev - navUsd6) * 10_000n) / prev;
  const report = {
    market, gmBalance: ethers.formatUnits(gmBal, 18), gmPriceUsd: gmPrice,
    indexBalance: ethers.formatUnits(idxBal, indexDec), indexPriceUsd: Number(answer) / 10 ** Number(feedDec),
    navUsd: Number(navUsd6) / 1e6, prevNavUsd: Number(prev) / 1e6, driftBps: Number(driftBps),
    maxDriftBps: Number(nav.maxDriftBps), registered: nav.registered, paused: nav.paused,
  };
  console.log(JSON.stringify(report));

  if (!nav.registered) throw new Error("market not registered on the oracle");
  if (prev !== 0n && driftBps > BigInt(nav.maxDriftBps)) {
    throw new Error(`move of ${driftBps} bps exceeds the oracle drift cap ${nav.maxDriftBps} — needs a human (raise cap or step it)`);
  }
  if (!EXECUTE) { console.log("read-only — nothing sent. Re-run with --execute to push."); return; }
  const key = process.env.GM_NAV_KEEPER_KEY;
  if (!key) throw new Error("GM_NAV_KEEPER_KEY not set");
  const signer = new ethers.Wallet(key, provider);
  const tx = await oracle.connect(signer).pushNav(market, navUsd6);
  const rc = await tx.wait();
  console.log(JSON.stringify({ pushed: true, tx: rc.hash, navUsd: Number(navUsd6) / 1e6 }));
}

main().catch((e) => { console.error("gm-nav-keeper:", e.message); process.exit(1); });
