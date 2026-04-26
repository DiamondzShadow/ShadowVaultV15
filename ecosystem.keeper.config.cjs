// ═══════════════════════════════════════════════════════════════════════
//  PM2 ecosystem config for the ShadowVaultV15 keeper
//
//  Runs the keeper on a 3-hour cron via PM2's cron_restart so each
//  invocation is a fresh process — no long-running state.
//
//  Start:    pm2 start ecosystem.keeper.config.cjs
//  Logs:     pm2 logs v15-keeper
//  Stop:     pm2 stop v15-keeper
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: "v15-keeper",
      script: "./keeper/keeper.js",
      autorestart: false,
      // Fire the keeper every 3 hours on the hour.
      cron_restart: "0 */3 * * *",
      env: {
        ARB_RPC: process.env.ARB_RPC,
        KEEPER_KEY: process.env.KEEPER_KEY,
        ZEROEX_API_KEY: process.env.ZEROEX_API_KEY || "",
        DEPLOYED_PATH: "./config/deployed.json",
      },
      out_file: "./logs/keeper.out.log",
      error_file: "./logs/keeper.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
