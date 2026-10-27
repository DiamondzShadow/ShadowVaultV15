#!/usr/bin/env bash
# One-off: pay out stuck Pool B withdrawal posId 4 (requested 2026-05-17).
# completeWithdraw transfers usdcGathered + yieldUSDC + basketUSDC (fee to
# treasury, rest to the user); the vault held less than that. This tops the
# vault up by exactly the live shortfall from the deployer, then has the
# keeper complete the withdrawal. Safe to re-run: it stops if already done.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

R="$ARB_RPC"
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
VAULT=0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce
POS=4

status=$(cast call $VAULT "positions(uint256)(address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8)" $POS --rpc-url "$R" | tail -1)
if [ "$status" != "1" ]; then echo "posId $POS is not pending (status $status) — nothing to do."; exit 0; fi

# mapfile, not read: read returns 1 on input without a trailing newline,
# which under set -e killed the first version silently before any output.
mapfile -t pw < <(cast call $VAULT "pendingWithdraws(uint256)(address,uint256,uint256,uint256,uint256,uint256)" $POS --rpc-url "$R" | awk '{print $1}')
user=${pw[0]}; gathered=${pw[1]}; yieldU=${pw[2]}; basketU=${pw[3]}; feeBps=${pw[4]}
total=$(( gathered + yieldU + basketU ))
bal=$(cast call $USDC "balanceOf(address)(uint256)" $VAULT --rpc-url "$R" | awk '{print $1}')
short=$(( total > bal ? total - bal : 0 ))
fee=$(( total * feeBps / 10000 ))

echo "owed total : $total (payout $(( total - fee )) to $user, fee $fee to treasury)"
echo "vault USDC : $bal"
echo "shortfall  : $short"

if [ "${1:-}" = "--check" ]; then echo "(--check: read-only, nothing sent)"; exit 0; fi

if [ "$short" -gt 0 ]; then
  echo "▸ topping up vault with $short raw USDC from deployer…"
  cast send $USDC "transfer(address,uint256)" $VAULT $short --private-key "$DEPLOYER_KEY" --rpc-url "$R" | grep -E "^(status|transactionHash)"
fi

echo "▸ keeper completing withdraw $POS…"
cast send $VAULT "completeWithdraw(uint256)" $POS --private-key "$KEEPER_KEY" --rpc-url "$R" | grep -E "^(status|transactionHash)"

echo "vault USDC after: $(cast call $USDC 'balanceOf(address)(uint256)' $VAULT --rpc-url "$R")"
echo "✓ done"
