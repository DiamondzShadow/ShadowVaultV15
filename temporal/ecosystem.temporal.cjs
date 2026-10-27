// pm2 ecosystem for the Temporal worker that runs the HyperEVM keepers.
//
// This process is a PERSISTENT Temporal worker (autorestart: true) — NOT a cron
// one-shot. Scheduling now lives in Temporal Cloud (two Schedules created via
// `keepers_temporal.py schedule`), which replaces the old pm2 cron_restart of
// hlp-hc-keeper-v2 + nav-from-hc. The worker just polls the task queue and runs
// each keeper (unchanged Node script) as a subprocess activity, with durable
// retries + history + heartbeats.
//
// Temporal creds load from ~/.temporal-cloud.env inside keepers_temporal.py.
const HOME = process.env.HOME;
const VENV = HOME + "/story-mcp-hub/.venv/bin/python";
const CWD = HOME + "/ShadowVaultV15/temporal";

module.exports = {
  apps: [
    {
      name: "shadowvault-hc-keepers-temporal",
      script: VENV,
      args: "keepers_temporal.py worker",
      cwd: CWD,
      interpreter: "none",
      autorestart: true,
      max_restarts: 30,
      max_memory_restart: "450M",
      env: { PYTHONUNBUFFERED: "1" },
    },
  ],
};
