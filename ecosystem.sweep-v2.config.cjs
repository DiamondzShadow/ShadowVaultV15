// ═══════════════════════════════════════════════════════════════════════
//  PM2 ecosystem — SweepV2 rebalance + CCIP value-push keepers
//
//  Starts three cron-invoked processes:
//    sweep-v2-arb     → rebalance SweepControllerV2 on Arbitrum every 30 min
//    sweep-v2-poly    → rebalance SweepControllerV2 on Polygon every 30 min
//    ccip-value-push  → push fresh values for all locked Polygon positions
//                       every 60 min (CCIP fee-sensitive — hourly is enough
//                       for lending health checks)
//
//  Each entry uses autorestart=false + cron_restart so every firing is a
//  fresh process. No long-running state, no drift on failure.
//
//  Environment variables are picked up from the process shell (.env, etc).
//  Required:
//    ARB_RPC, POLYGON_RPC          — RPC endpoints
//    KEEPER_KEY                    — keeper signer (must have KEEPER_ROLE
//                                    on both SweepControllerV2s + on the
//                                    PolygonNFTLocker; must have LINK on
//                                    Polygon for the value-push)
//
//  Start:  pm2 start ecosystem.sweep-v2.config.cjs && pm2 save
//  Logs:   pm2 logs sweep-v2-arb / sweep-v2-poly / ccip-value-push
//  Stop:   pm2 stop sweep-v2-arb && pm2 stop sweep-v2-poly && pm2 stop ccip-value-push
// ═══════════════════════════════════════════════════════════════════════

const common = {
  autorestart: false,
  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "sweep-v2-arb",
      script: "./keeper/sweep-v2.js",
      cron_restart: "*/30 * * * *",
      env: {
        CHAIN_ID: "42161",
        ARB_RPC:     process.env.ARB_RPC,
        KEEPER_KEY:  process.env.KEEPER_KEY,
      },
      out_file:   "./logs/sweep-v2-arb.out.log",
      error_file: "./logs/sweep-v2-arb.err.log",
    },
    {
      ...common,
      name: "sweep-v2-poly",
      script: "./keeper/sweep-v2.js",
      cron_restart: "*/30 * * * *",
      env: {
        CHAIN_ID: "137",
        POLYGON_RPC: process.env.POLYGON_RPC,
        KEEPER_KEY:  process.env.KEEPER_KEY,
      },
      out_file:   "./logs/sweep-v2-poly.out.log",
      error_file: "./logs/sweep-v2-poly.err.log",
    },
    {
      ...common,
      name: "ccip-value-push",
      script: "./keeper/ccip-value-push.js",
      // Hourly — CCIP fees add up, and Arb-side health checks don't need
      // minute-level freshness for the vault-backed value that only moves
      // a few bps per minute anyway.
      cron_restart: "5 * * * *",
      env: {
        POLYGON_RPC: process.env.POLYGON_RPC,
        KEEPER_KEY:  process.env.KEEPER_KEY,
        LOOKBACK:    "200000",
        MIN_LINK_WEI: String(10n ** 18n),
      },
      out_file:   "./logs/ccip-value-push.out.log",
      error_file: "./logs/ccip-value-push.err.log",
    },
    {
      ...common,
      name: "lz-value-push",
      script: "./keeper/lz-value-push.js",
      // Hourly — mirror of ccip-value-push, but for HyperEVM positions
      // bridged via LayerZero. Keeper pays fees in native HYPE on HyperEVM.
      cron_restart: "10 * * * *",
      env: {
        HYPEREVM_RPC: process.env.HYPEREVM_RPC,
        KEEPER_KEY:   process.env.KEEPER_KEY,
        LOOKBACK:     "100000",
        LOG_CHUNK:    "2000",   // HyperEVM RPCs cap getLogs at ~2k blocks
        MIN_HYPE_WEI: String(5n * 10n ** 16n), // 0.05 HYPE
      },
      out_file:   "./logs/lz-value-push.out.log",
      error_file: "./logs/lz-value-push.err.log",
    },
  ],
};
