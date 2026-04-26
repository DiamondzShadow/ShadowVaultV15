// pm2 ecosystem config for the HLP HyperCore keeper. Runs every 3 hours.
// Uses cron_restart so each invocation is a fresh one-shot (the keeper script
// exits after one pass by design).
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env.pool-e") });

module.exports = {
  apps: [
    {
      name: "hlp-hc-keeper",
      script: "./keeper/hlp-hc-keeper.js",
      cron_restart: "0 */3 * * *",
      autorestart: false,
      env: {
        HYPEREVM_RPC:     process.env.HYPEREVM_RPC,
        HC_KEEPER_KEY:    process.env.HC_KEEPER_KEY,
        HLP_ADAPTER_ADDR: process.env.HLP_ADAPTER_ADDR,
      },
    },
  ],
};
