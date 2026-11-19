#!/usr/bin/env bash
# Set MarketplaceV3.1 (Arbitrum) protocol fee via the Arbitrum Safe (marketplace admin).
#   marketplace-fee.sh [bps]                          read-only: current fee + plan (default 50 = 0.5%)
#   marketplace-fee.sh <bps> <env-file> --fork        rehearse on an anvil fork
#   marketplace-fee.sh <bps> <env-file> --execute     deployer signs as a Safe owner (threshold 1)
set -euo pipefail
BPS="${1:-50}"; ENV_FILE="${2:-}"; MODE="${3:-}"
LIVE_RPC="${ARB_RPC:-https://arb1.arbitrum.io/rpc}"
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
SAFE=0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363
MKT=0x749735623C5f9304E6a6715b066C9FBa7b9F30DB
ZERO=0x0000000000000000000000000000000000000000
lc() { echo "$1" | tr A-F a-f; }
[[ "$BPS" =~ ^[0-9]+$ ]] && [ "$BPS" -le 1000 ] || { echo "bps must be 0..1000"; exit 1; }

RPC="$LIVE_RPC"
if [ "$MODE" = "--fork" ]; then
  anvil --fork-url "$LIVE_RPC" --port 8563 --auto-impersonate --silent & ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
  RPC=http://127.0.0.1:8563; for _ in $(seq 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
elif [ "$MODE" = "--execute" ]; then
  [ -f "$ENV_FILE" ] || { echo "usage: $0 <bps> <env-file> --execute"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$KEY" ] || { echo "no key in $ENV_FILE"; exit 1; }
  [ "$(lc "$(cast wallet address --private-key "$KEY")")" = "$(lc $DEPLOYER)" ] || { echo "key is not the deployer — stopping"; exit 1; }
elif [ -n "$MODE" ]; then echo "unknown mode $MODE"; exit 1; fi

cur=$(cast call $MKT 'protocolFeeBps()(uint16)' --rpc-url $RPC)
echo "marketplace fee now $cur bps; Safe owners $(cast call $SAFE 'getOwners()(address[])' --rpc-url $RPC) threshold $(cast call $SAFE 'getThreshold()(uint256)' --rpc-url $RPC)"
echo "Safe is admin: $(cast call $MKT 'hasRole(bytes32,address)(bool)' 0x0000000000000000000000000000000000000000000000000000000000000000 $SAFE --rpc-url $RPC)"
[ -z "$MODE" ] && { echo "plan: Safe → setProtocolFeeBps($BPS). Nothing sent."; exit 0; }
[ "$cur" = "$BPS" ] && { echo "already $BPS"; exit 0; }

inner=$(cast calldata 'setProtocolFeeBps(uint16)' $BPS)
sig="0x000000000000000000000000${DEPLOYER:2}$(printf '%064x' 0)01"
args=($SAFE 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' $MKT 0 "$inner" 0 0 0 0 $ZERO $ZERO "$sig")
if [ "$MODE" = "--fork" ]; then out=$(cast send --unlocked --from $DEPLOYER "${args[@]}" --rpc-url $RPC)
else out=$(cast send --private-key "$KEY" "${args[@]}" --rpc-url $RPC); fi
echo "tx $(echo "$out" | awk '/^transactionHash/{print $2}') status $(echo "$out" | awk '/^status/{print $2}')"
new=$(cast call $MKT 'protocolFeeBps()(uint16)' --rpc-url $RPC); echo "fee now $new bps"
[ "$new" = "$BPS" ]
