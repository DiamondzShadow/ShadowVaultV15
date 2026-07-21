// pm2 ecosystem for the LIVE v2 Pool E keepers (HyperEVM 999).
//
// Supersedes ecosystem.hlp-hc.cjs, which points at the retired v1 script/adapter
// (v1 adapter 0x5c45a7a4… — see config/deployed-pool-e-hc-v2.json).
//
// Both apps were previously started ad-hoc via `pm2 start`, so pm2 held a stale
// copy of HYPEREVM_RPC in its saved process env. That stale value won over
// dotenv and kept the keepers pointed at a QuickNode endpoint whose whole tenant
// is now disabled — which is why they were dead for ~3 months. Declaring the env
// here explicitly, and recreating the apps (delete + start, NOT restart), is what
// actually clears it.
//
// RPC is Uniblock JSON-RPC (auto-routing, one provider for 999/137/42161/8453/4663)
// rather than a public endpoint.
//
// NOTE: these are one-shot scripts driven by cron_restart; each invocation exits
// after a single pass by design, so autorestart must stay false.
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env.pool-e") });
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const shared = {
  HYPEREVM_RPC: process.env.HYPEREVM_RPC,
  HC_KEEPER_KEY: process.env.HC_KEEPER_KEY,
};

module.exports = {
  apps: [
    {
      name: "hlp-hc-keeper-v2",
      script: "./keeper/hlp-hc-keeper-v2.js",
      cwd: __dirname,
      cron_restart: "0 */3 * * *",
      autorestart: false,
      max_memory_restart: "300M",
      env: {
        ...shared,
        HLP_ADAPTER_ADDR: process.env.HLP_ADAPTER_ADDR,
      },
    },
    {
      name: "nav-from-hc",
      script: "./keeper/nav-from-hc.js",
      cwd: __dirname,
      cron_restart: "*/10 * * * *",
      autorestart: false,
      max_memory_restart: "300M",
      env: {
        ...shared,
        NAV_ORACLE_ADDR: process.env.NAV_ORACLE_ADDR,
        TRADER_HC_ADDR: process.env.TRADER_HC_ADDR,
      },
    },
  ],
};
