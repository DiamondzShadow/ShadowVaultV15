#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  generate-abi-bundle-hyperevm.js — emit abi/v15-hyperevm.ts
//
//  Sibling to generate-abi-bundle.js. Emits a single-file TS bundle for the
//  HyperEVM (chain 999) Pool E+ product line (HyperSkin / HyperCash /
//  HyperCore / HyperAlpha / HyperShield).
//
//  The Lovable/bridge UI imports this alongside v15.ts:
//    import { HYPEREVM_ADDRESSES, HLP_ADAPTER_ABI, HYPER_SKIN_ABI,
//             SHADOW_VAULT_V15_ABI } from "./v15-hyperevm";
//
//  Re-run after any HyperEVM-side deploy change:
//    node scripts/generate-abi-bundle-hyperevm.js
// ═══════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ART = path.join(ROOT, "artifacts", "contracts");
const OUT_DIR = path.join(ROOT, "abi");
const OUT = path.join(OUT_DIR, "v15-hyperevm.ts");
const DEPLOYED = path.join(ROOT, "config", "deployed.json");
const POOL_E  = path.join(ROOT, "config", "deployed-pool-e-hc.json");

function loadAbi(rel, name) {
  return JSON.parse(fs.readFileSync(path.join(ART, rel, name + ".json"), "utf8")).abi;
}
function ts(label, value, isAbi = false) {
  const json = isAbi ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  return `export const ${label} = ${json} as const;\n\n`;
}

const POOL_F = path.join(ROOT, "config", "deployed-pool-f-hc.json");
const SHADOWPASS = path.join(ROOT, "config", "deployed-shadowpass-hc.json");

const deployed = JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));
const poolE    = JSON.parse(fs.readFileSync(POOL_E, "utf8"));
const poolF    = fs.existsSync(POOL_F) ? JSON.parse(fs.readFileSync(POOL_F, "utf8")) : null;
const sp       = fs.existsSync(SHADOWPASS) ? JSON.parse(fs.readFileSync(SHADOWPASS, "utf8")) : null;
const chainInfo = deployed.chains?.["999"] ?? {
  name: "hyperliquid",
  rpc: "https://rpc.hyperliquid.xyz/evm",
  explorer: "https://hyperevmscan.io",
};

// ─────────── Flattened addresses for Lovable ───────────
const HYPEREVM_ADDRESSES = {
  chainId: 999,
  network: chainInfo.name,
  rpc: chainInfo.rpc,
  explorer: chainInfo.explorer,
  deployer: poolE.deployer,
  treasury: poolE.treasury,               // Gnosis Safe on HyperEVM
  keeper:   poolE.keeper,
  usdc:     poolE.usdc,
  hlpVault: poolE.hlpVault,
  core: {
    revenueRouter: poolE.revenueRouter,
  },
  adapters: {
    hlp: poolE.adapter,
  },
  pools: {
    E: {
      label: "HyperCash",
      brand: "ShadowPass",
      vault:         poolE.vault,
      positionNFT:   poolE.skin,
      adapter:       poolE.adapter,
      yieldSource:   "hyperliquid-hlp",
      version:       "v15-hyperevm-e",
      nftVersion:    "hyperskin-v1",
      basket:        "100% USDC → HLP",
      allocation:    "0/100 (yield-only)",
      apyRange:      "~20%",
      risk:          "Yield",
      whitelist:     true,
      caps:          poolE.caps,
      deployedAt:    poolE.deployedAt,
    },
    ...(poolF ? {
      F: {
        label: "HyperCore",
        brand: "ShadowPass",
        vault:         poolF.vault,
        basketAdapter: poolF.basketAdapter,
        yieldAdapter:  poolF.yieldAdapter,
        yieldReceipt:  poolF.yieldReceipt,
        basketReceipt: poolF.basketReceipt,
        shadowPass:    poolF.shadowPass,
        navOracle:     poolF.navOracle,
        basketId:      poolF.basketId,
        basketName:    poolF.basketName,
        yieldSource:   "hyperliquid-hlp",
        version:       "v15-hyperevm-f",
        nftVersion:    "shadowpass-v1",
        basket:        "HYPE 40 / BTC 30 / ETH 20 / USDC 10 (target — basket trading pending)",
        allocation:    `${poolF.allocation.basketBps/100}/${poolF.allocation.yieldBps/100} (basket/yield)`,
        apyRange:      "~20% yield + basket beta",
        risk:          "Moderate",
        whitelist:     true,
        deployedAt:    poolF.deployedAt,
      },
    } : {}),
  },
  ...(sp ? {
    shadowpass: {
      yieldReceipt:  sp.yieldReceipt,
      basketReceipt: sp.basketReceipt,
      shadowPass:    sp.shadowPass,
      navOracle:     sp.oracle,
      baskets:       sp.baskets,
    },
  } : {}),
};

// ─────────── Minimal external ABIs (reused) ───────────
const ERC20_ABI = [
  { type:"function", name:"balanceOf", stateMutability:"view", inputs:[{type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"decimals",  stateMutability:"view", inputs:[], outputs:[{type:"uint8"}] },
  { type:"function", name:"symbol",    stateMutability:"view", inputs:[], outputs:[{type:"string"}] },
  { type:"function", name:"approve",   stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[{type:"bool"}] },
  { type:"function", name:"allowance", stateMutability:"view", inputs:[{type:"address"},{type:"address"}], outputs:[{type:"uint256"}] },
];

// ─────────── Tier enum (shared with V15) ───────────
const TIER = {
  FLEX:    { id: 0, label: "FLEX",  lockSeconds: 0,              multiplierBps: 10_000 },
  THIRTY:  { id: 1, label: "30D",   lockSeconds: 30 * 24 * 3600, multiplierBps: 12_000 },
  NINETY:  { id: 2, label: "90D",   lockSeconds: 90 * 24 * 3600, multiplierBps: 15_000 },
  ONEIGHTY:{ id: 3, label: "180D",  lockSeconds: 180 * 24 * 3600,multiplierBps: 20_000 },
  YEAR:    { id: 4, label: "365D",  lockSeconds: 365 * 24 * 3600,multiplierBps: 30_000 },
};

// ─────────── Per-contract ABIs (HyperEVM) ───────────
const ABIS = {
  SHADOW_VAULT_V15_ABI:          loadAbi("ShadowVaultV15.sol",         "ShadowVaultV15"),
  HYPER_SKIN_ABI:                loadAbi("HyperSkin.sol",              "HyperSkin"),
  HLP_ADAPTER_ABI:               loadAbi("adapters/HLPAdapterHC.sol",  "HLPAdapterHC"),
  REVENUE_ROUTER_HC_ABI:         loadAbi("RevenueRouterHC.sol",        "RevenueRouterHC"),
  BASKET_NAV_ORACLE_ABI:         loadAbi("shadowpass/BasketNavOracle.sol", "BasketNavOracle"),
  YIELD_RECEIPT_ABI:             loadAbi("shadowpass/YieldReceipt.sol",    "YieldReceipt"),
  BASKET_RECEIPT_ABI:            loadAbi("shadowpass/BasketReceipt.sol",   "BasketReceipt"),
  SHADOW_PASS_ABI:               loadAbi("shadowpass/ShadowPass.sol",      "ShadowPass"),
  BASKET_ADAPTER_HC_ABI:         loadAbi("adapters/BasketAdapterHC.sol",   "BasketAdapterHC"),
  SHADOW_VAULT_HYPERBASKET_ABI:  loadAbi("ShadowVaultHyperBasket.sol", "ShadowVaultHyperBasket"),
};

// ─────────── Emit ───────────
let out = "";
out += "// ═══════════════════════════════════════════════════════════════════════\n";
out += "//  ShadowVault Pool E+ (HyperEVM) — frontend bundle (auto-generated)\n";
out += "//\n";
out += "//  Generator:  scripts/generate-abi-bundle-hyperevm.js\n";
out += `//  Generated:  ${new Date().toISOString()}\n`;
out += `//  Network:    hyperliquid (chainId 999)\n`;
out += "//\n";
out += "//  Import:     import { HYPEREVM_ADDRESSES, HLP_ADAPTER_ABI,\n";
out += "//                       HYPER_SKIN_ABI, SHADOW_VAULT_V15_ABI,\n";
out += "//                       REVENUE_ROUTER_HC_ABI, TIER }\n";
out += "//                from \"./v15-hyperevm\";\n";
out += "// ═══════════════════════════════════════════════════════════════════════\n\n";

out += "export const HYPEREVM_CHAIN_ID = 999;\n\n";
out += ts("HYPEREVM_ADDRESSES", HYPEREVM_ADDRESSES);
out += ts("TIER", TIER);
out += ts("ERC20_ABI", ERC20_ABI, true);
for (const [name, abi] of Object.entries(ABIS)) {
  out += ts(name, abi, true);
}

out += `
// ─────────── TypeScript helper types ───────────
export type HyperEvmPoolId = "E" | "F";  // extend when G/H land

export interface HyperEvmPoolConfig {
  label: string;
  brand: string;
  vault: \`0x\${string}\`;
  positionNFT: \`0x\${string}\`;
  adapter: \`0x\${string}\`;
  yieldSource: "hyperliquid-hlp";
  version?: string;
  caps: { perTx: string; daily: string };
}
`;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`✓ Wrote ${OUT}`);
console.log(`  ${out.length} bytes, ${Object.keys(ABIS).length} ABIs`);
