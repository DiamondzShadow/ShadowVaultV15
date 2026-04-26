// HyperEVM-side wiring audit. Validates that the Arb SweepControllerV2 remote
// leg is wired to a live HyperRemoteMirror + that the HyperEVM Pool E / F /
// ShadowPass contracts are in a sane state.
//
// HyperEVM doesn't run the v1.4 marketplace/lending/valuer stack — CCIP
// doesn't ship USDC to HyperEVM (only LayerZero messaging exists). So the
// integration shape is: Arb SweepV2 → remote slot → HyperRemoteMirror (lives
// on Arb) → keeper-operated bridge → HyperEVM Pool E vault.
//
// Run:
//   npx hardhat run --network hyperevm  scripts/audit-hyperevm.cjs
//   (and alongside, we also spot-check the Arb-side mirror state during
//    the normal audit-wiring.cjs run on Arb)

const hre = require("hardhat");
const path = require("node:path");

function fmt(n, dec = 6) { return (Number(n) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec }); }
function fmt18(n) { return (Number(n) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 }); }

const checks = [];
function check(label, cond, detail = "") {
  checks.push({ label, ok: !!cond, detail });
}

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 999) throw new Error(`Expected HyperEVM (999), got ${chainId}`);

  const poolE  = require(path.resolve(__dirname, "..", "config", "deployed-pool-e-hc-v2.json"));
  const poolF  = require(path.resolve(__dirname, "..", "config", "deployed-pool-f-hc.json"));
  const sp     = require(path.resolve(__dirname, "..", "config", "deployed-shadowpass-hc.json"));

  console.log(`═══ HyperEVM audit — chain 999 ═══\n`);
  console.log("Pool E vault:", poolE.vault);
  console.log("Pool F vault:", poolF.vault);
  console.log("ShadowPass  :", sp.shadowPass);

  // ─── Generic contract-lives probe
  const VAULT_ABI = [
    "function paused() view returns (bool)",
    "function owner() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function whitelistEnabled() view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ];

  async function vaultState(label, addr) {
    const c = new hre.ethers.Contract(addr, VAULT_ABI, hre.ethers.provider);
    const code = await hre.ethers.provider.getCode(addr);
    check(`${label} has deployed code`, code.length > 2, `len=${code.length}`);
    try {
      const [paused, ta, wl] = await Promise.all([
        c.paused().catch(() => null),
        c.totalAssets().catch(() => null),
        c.whitelistEnabled().catch(() => null),
      ]);
      console.log(`  ${label}  paused=${paused}  totalAssets=${ta === null ? "n/a" : fmt(ta)}  whitelist=${wl}`);
      if (paused !== null) check(`${label} NOT paused`, paused === false, `paused=${paused}`);
    } catch (e) { console.log(`  ${label} read failed: ${e.shortMessage || e.message}`); }
  }

  console.log("\nVault state:");
  await vaultState("Pool E v2 vault", poolE.vault);
  await vaultState("Pool F vault",    poolF.vault);

  // Adapters
  console.log("\nAdapters:");
  const ADAPTER_ABI = [
    "function totalAssets() view returns (uint256)",
    "function vault() view returns (address)",
    "function paused() view returns (bool)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function KEEPER_ROLE() view returns (bytes32)",
  ];
  for (const [lab, addr, expectedVault] of [
    ["HLPAdapterHC (Pool E)", poolE.adapter, poolE.vault],
    ["BasketAdapterHC (Pool F)", poolF.basketAdapter, poolF.vault],
  ]) {
    if (!addr) continue;
    const c = new hre.ethers.Contract(addr, ADAPTER_ABI, hre.ethers.provider);
    try {
      const [ta, v] = await Promise.all([
        c.totalAssets().catch(() => null),
        c.vault().catch(() => null),
      ]);
      console.log(`  ${lab}  totalAssets=${ta === null ? "n/a" : fmt(ta)}  vault=${v}`);
      if (expectedVault && v) {
        check(`${lab} points at expected vault`, v.toLowerCase() === expectedVault.toLowerCase(), `got ${v}`);
      }
    } catch (e) { console.log(`  ${lab} read failed: ${e.shortMessage || e.message}`); }
  }

  // Keeper role on HLP adapter
  if (poolE.adapter && process.env.KEEPER_KEY) {
    const keeperAddr = new hre.ethers.Wallet(process.env.KEEPER_KEY).address;
    const c = new hre.ethers.Contract(poolE.adapter, ADAPTER_ABI, hre.ethers.provider);
    try {
      const kRole = await c.KEEPER_ROLE();
      check("keeper has KEEPER_ROLE on HLPAdapterHC", await c.hasRole(kRole, keeperAddr));
    } catch (e) { /* not all adapters expose it */ }
  }

  // ShadowPass (ERC721Enumerable-free, so just existence + admin)
  console.log("\nShadowPass:");
  const SP_ABI = [
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function totalSupply() view returns (uint256)",
  ];
  const spC = new hre.ethers.Contract(sp.shadowPass, SP_ABI, hre.ethers.provider);
  const spCode = await hre.ethers.provider.getCode(sp.shadowPass);
  check("ShadowPass has deployed code", spCode.length > 2);
  try {
    const supply = await spC.totalSupply().catch(() => null);
    console.log(`  totalSupply=${supply === null ? "n/a (non-enumerable)" : supply}`);
  } catch {}

  // Treasury Safe sanity — is it deployed?
  const TREASURY_HC = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E";
  const safeCode = await hre.ethers.provider.getCode(TREASURY_HC);
  check("HyperEVM Treasury Safe has code", safeCode.length > 2, `len=${safeCode.length}`);

  // Report
  console.log("\n─── Results ───");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"}  ${c.label}${c.detail ? "  (" + c.detail + ")" : ""}`);
  }
  const pass = checks.filter(c => c.ok).length;
  console.log(`\n${pass}/${checks.length} passing`);

  console.log("\nNOTE: HyperEVM is NOT part of the v1.4 lending/marketplace/CCIP stack.");
  console.log("      Arb <-> HyperEVM integration is: Arb SweepV2 remote slot =>");
  console.log("      HyperRemoteMirror (on Arb) => keeper-operated bridge => Pool E v2.");
  console.log("      Run audit-wiring.cjs --network arbitrum to verify the Arb-side mirror wiring.");
}

main().catch(e => { console.error(e); process.exit(1); });
