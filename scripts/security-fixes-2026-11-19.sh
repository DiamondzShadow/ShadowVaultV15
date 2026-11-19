#!/usr/bin/env bash
# Quick security fixes (2026-11-19):
#   Arbitrum: DiggerRegistry + RoyaltyRouter admin (and SLASHER) → Arb Safe, deployer renounced
#   Arbitrum Safe copy 0x6052…  and HyperEVM treasury Safe 0xA7A0…: add the owner's Trezor (threshold stays 1)
#   security-fixes-2026-11-19.sh                       read-only
#   security-fixes-2026-11-19.sh <env-file> --fork     rehearse both chains on anvil
#   security-fixes-2026-11-19.sh <env-file> --execute  send from the deployer
set -euo pipefail
ENV_FILE="${1:-}"; MODE="${2:-}"
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
TREZOR=0x535Bf1Ba9f8d42f349589db9625D89873A32F60b
ARB_SAFE=0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363
REGISTRY=0x090275f1ddae9e37C28D495AD9f9044723D787c9
ROUTER=0xb9c6edfcd6fBd861ba8b92c3eDddbf5babED1be4
SAFE_ARB_6052=0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43
SAFE_HYPER_TREASURY=0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E
ADM=0x0000000000000000000000000000000000000000000000000000000000000000
SLASH=$(cast keccak SLASHER_ROLE)
ZERO=0x0000000000000000000000000000000000000000
lc() { echo "$1" | tr A-F a-f; }
ARB="${ARB_RPC:-https://arb1.arbitrum.io/rpc}"; HYP="${HYPER_RPC:-https://rpc.hyperliquid.xyz/evm}"

if [ "$MODE" = "--fork" ]; then
  anvil --fork-url "$ARB" --port 8571 --auto-impersonate --silent & A1=$!
  anvil --fork-url "$HYP" --port 8572 --auto-impersonate --silent & A2=$!
  trap 'kill $A1 $A2 2>/dev/null' EXIT
  ARB=http://127.0.0.1:8571; HYP=http://127.0.0.1:8572
  for r in $ARB $HYP; do for _ in $(seq 60); do cast chain-id -r $r >/dev/null 2>&1 && break; sleep 0.5; done; done
elif [ "$MODE" = "--execute" ]; then
  [ -f "$ENV_FILE" ] || { echo "usage: $0 <env-file> --execute"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$KEY" ] || { echo "no key in $ENV_FILE"; exit 1; }
  [ "$(lc "$(cast wallet address --private-key "$KEY")")" = "$(lc $DEPLOYER)" ] || { echo "key is not the deployer — stopping"; exit 1; }
elif [ -n "$MODE" ]; then echo "unknown mode $MODE"; exit 1; fi

has() { cast call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3" -r "$4"; }
send() { # send <rpc> <to> <sig> [args...]
  local rpc=$1; shift; local out
  if [ "$MODE" = "--fork" ]; then out=$(cast send --gas-limit 1000000 --unlocked --from $DEPLOYER "$@" -r "$rpc")
  else out=$(cast send --private-key "$KEY" "$@" -r "$rpc"); fi
  local st; st=$(echo "$out" | awk '/^status/{print $2}')
  echo "    $(echo "$out" | awk '/^transactionHash/{print $2}') status=$st"
  [ "$st" = "1" ] || { echo "tx failed — stopping"; exit 1; }
}
addOwner() { # addOwner <rpc> <safe>
  local inner sig
  inner=$(cast calldata 'addOwnerWithThreshold(address,uint256)' $TREZOR 1)
  sig="0x000000000000000000000000${DEPLOYER:2}$(printf '%064x' 0)01"
  send "$1" "$2" 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' "$2" 0 "$inner" 0 0 0 0 $ZERO $ZERO "$sig"
}
state() {
  echo "  registry admin: safe=$(has $REGISTRY $ADM $ARB_SAFE $ARB) deployer=$(has $REGISTRY $ADM $DEPLOYER $ARB) | slasher: safe=$(has $REGISTRY $SLASH $ARB_SAFE $ARB) deployer=$(has $REGISTRY $SLASH $DEPLOYER $ARB)"
  echo "  router admin:   safe=$(has $ROUTER $ADM $ARB_SAFE $ARB) deployer=$(has $ROUTER $ADM $DEPLOYER $ARB)"
  echo "  Arb 0x6052 owners $(cast call $SAFE_ARB_6052 'getOwners()(address[])' -r $ARB)"
  echo "  Hyper treasury owners $(cast call $SAFE_HYPER_TREASURY 'getOwners()(address[])' -r $HYP)"
}
echo "== before"; state
[ -z "$MODE" ] && { echo "plan: grant Safe admin+slasher on registry, admin on router, renounce deployer; add Trezor to both Safes. Nothing sent."; exit 0; }

echo "== registry"
[ "$(has $REGISTRY $ADM $ARB_SAFE $ARB)" = true ] || send $ARB $REGISTRY 'grantRole(bytes32,address)' $ADM $ARB_SAFE
[ "$(has $REGISTRY $SLASH $ARB_SAFE $ARB)" = true ] || send $ARB $REGISTRY 'grantRole(bytes32,address)' $SLASH $ARB_SAFE
[ "$(has $REGISTRY $ADM $ARB_SAFE $ARB)" = true ] || { echo "Safe lacks registry admin — not renouncing"; exit 1; }
[ "$(has $REGISTRY $SLASH $DEPLOYER $ARB)" = false ] || send $ARB $REGISTRY 'renounceRole(bytes32,address)' $SLASH $DEPLOYER
[ "$(has $REGISTRY $ADM $DEPLOYER $ARB)" = false ] || send $ARB $REGISTRY 'renounceRole(bytes32,address)' $ADM $DEPLOYER
echo "== router"
[ "$(has $ROUTER $ADM $ARB_SAFE $ARB)" = true ] || send $ARB $ROUTER 'grantRole(bytes32,address)' $ADM $ARB_SAFE
[ "$(has $ROUTER $ADM $ARB_SAFE $ARB)" = true ] || { echo "Safe lacks router admin — not renouncing"; exit 1; }
[ "$(has $ROUTER $ADM $DEPLOYER $ARB)" = false ] || send $ARB $ROUTER 'renounceRole(bytes32,address)' $ADM $DEPLOYER
echo "== Safes"
case "$(lc "$(cast call $SAFE_ARB_6052 'getOwners()(address[])' -r $ARB)")" in *"$(lc $TREZOR)"*) echo "  Arb 0x6052 has Trezor";; *) addOwner $ARB $SAFE_ARB_6052;; esac
case "$(lc "$(cast call $SAFE_HYPER_TREASURY 'getOwners()(address[])' -r $HYP)")" in *"$(lc $TREZOR)"*) echo "  Hyper treasury has Trezor";; *) addOwner $HYP $SAFE_HYPER_TREASURY;; esac
echo "== after"; state
