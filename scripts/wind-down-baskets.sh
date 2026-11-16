#!/usr/bin/env bash
# Wind down the Arbitrum V15 basket pools (A–D) and retire the keepers that
# only serve them. Decided 2026-11-16: every pool holds $0 and every position
# is COMPLETED, so pausing traps nobody.
#
#   (no flag)   read-only: print pool state + which pm2 jobs would go. Sends nothing.
#   --execute   pause A–D from the deployer (PAUSER_ROLE) and delete the pm2 jobs.
#
# Pausing blocks deposit/requestWithdraw/keeper swaps. completeWithdraw is not
# pause-gated. Undo: `cast send <vault> "unpause()"` from the deployer, and
# re-add the jobs from the manifest this script writes to logs/.
set -euo pipefail
MODE="${1:-}"
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

VAULTS=(
  A:0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa
  B:0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce
  C:0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1
  D:0xF16b728c0973C742a4c769B3217843707Ce4f09d
)
# Basket keepers + the idle lending layer that takes basket NFTs as collateral.
# sdm-mirror-sync is SDM, not baskets — deliberately NOT here.
JOBS=(
  v15-keeper polygon-v15-keeper polygon-keeper
  lending-bridge lending-sweep lending-liquidation
  sweep-v2-arb sweep-v2-poly ccip-value-push lz-value-push
  vault-rebalancer withdraw-keeper
)
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
PAUSER=$(cast keccak "PAUSER_ROLE")
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
POS_SIG="positions(uint256)(address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8)"

echo "== pools (Arbitrum)"
for entry in "${VAULTS[@]}"; do
  name=${entry%%:*}; v=${entry#*:}
  paused=$(cast call "$v" "paused()(bool)" --rpc-url "$ARB_RPC")
  role=$(cast call "$v" "hasRole(bytes32,address)(bool)" "$PAUSER" "$DEPLOYER" --rpc-url "$ARB_RPC")
  idle=$(cast call "$USDC" "balanceOf(address)(uint256)" "$v" --rpc-url "$ARB_RPC" | awk '{print $1}')
  next=$(cast call "$v" "nextPosId()(uint256)" --rpc-url "$ARB_RPC" | awk '{print $1}')
  open=0
  for ((i=1; i<next; i++)); do
    st=$(cast call "$v" "$POS_SIG" "$i" --rpc-url "$ARB_RPC" | tail -1)
    [ "$st" = "2" ] || open=$((open+1))
  done
  echo "$name $v paused=$paused deployerPauser=$role idleUSDC=$idle openPositions=$open"
  if [ "$open" -ne 0 ]; then echo "  !! $name has open positions — refusing to pause it"; continue; fi
  [ "$MODE" = "--execute" ] || continue
  [ "$paused" = "true" ] && continue
  cast send "$v" "pause()" --private-key "$DEPLOYER_KEY" --rpc-url "$ARB_RPC" | grep -E "^(status|transactionHash)"
  echo "  now paused=$(cast call "$v" "paused()(bool)" --rpc-url "$ARB_RPC")"
done

echo "== pm2 jobs to retire"
manifest="logs/pm2-retired-$(date -u +%Y%m%dT%H%M%SZ).json"
present=()
for j in "${JOBS[@]}"; do
  if pm2 describe "$j" >/dev/null 2>&1; then present+=("$j"); echo "  $j"; else echo "  $j (not in pm2)"; fi
done
[ "$MODE" = "--execute" ] || { echo "read-only run — nothing sent. Re-run with --execute."; exit 0; }

# Manifest keeps name/script/cwd/cron/args only — no env values (secrets).
pm2 jlist | python3 -c '
import json, sys
keep = set(sys.argv[1:])
out = [{"name": p["name"], "script": p["pm2_env"].get("pm_exec_path"),
        "cwd": p["pm2_env"].get("pm_cwd"), "cron_restart": p["pm2_env"].get("cron_restart"),
        "args": p["pm2_env"].get("args"), "autorestart": p["pm2_env"].get("autorestart")}
       for p in json.load(sys.stdin) if p["name"] in keep]
print(json.dumps(out, indent=2))' "${present[@]}" > "$manifest"
echo "manifest -> $manifest"
for j in "${present[@]}"; do pm2 delete "$j" >/dev/null && echo "  deleted $j"; done
pm2 save
