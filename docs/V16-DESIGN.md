# V16 design — moved

The V16 design, code and rollout now live in the private repo
**[DiamondzShadow/shadowvault-v16](https://github.com/DiamondzShadow/shadowvault-v16)**
(`docs/V16-DESIGN.md`, `deploy/README.md`).

This repo keeps the V15 wind-down tooling:
- `scripts/wind-down-baskets.sh` — read-only by default; `--execute` pauses Arbitrum pools A–D
  (refuses any pool with open positions) and retires the 12 basket/lending pm2 jobs, writing a
  no-secrets manifest to `logs/` so any job can be restored.
- `scripts/v16-lite-rh.sh` — Robinhood Chain Morpho Vault V2 (dsUSDG → steakUSDG) deploy, fork-tested;
  read-only by default, `--fork` rehearsal, `--execute` deploy.
