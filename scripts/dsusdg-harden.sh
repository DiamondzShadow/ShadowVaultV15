#!/usr/bin/env bash
# dsUSDG (Morpho Vault V2, Robinhood Chain) hardening:
#   1. put a 3-day timelock on every curator action that could move or redirect depositor money
#      (done by the deployer while it is still curator and timelocks are 0 ⇒ submit + execute at once;
#      increaseTimelock itself is timelocked LAST so the earlier steps don't have to wait)
#   2. RH Safe (vault owner) hands the curator role to the owner's Trezor address
#   Deployer stays allocator (keeper: routes deposits/withdrawals between already-approved adapters, within caps).
#
#   dsusdg-harden.sh                        read-only: show current state and the plan (sends nothing)
#   dsusdg-harden.sh <env-file> --fork      rehearse on an anvil fork of RH Chain (sends nothing real)
#   dsusdg-harden.sh <env-file> --execute   send for real from the deployer
# Env file must set PRIVATE_KEY / DEPLOYER_KEY / DEPLOYER_PK (never printed; checked to be the deployer).
set -euo pipefail

ENV_FILE="${1:-}"; MODE="${2:-}"
LIVE_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
VAULT=0xceE31849648C23D1e0Db9Dda29303af0Fa3B9175
SAFE=0x6A9edB61177cD3fEc4D7Ff4FA096527C6f168f35
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
NEW_CURATOR=0x535Bf1Ba9f8d42f349589db9625D89873A32F60b   # owner's Trezor
DELAY=$((3 * 24 * 3600))

SIGS=(
  "setIsAllocator(address,bool)"
  "setReceiveSharesGate(address)"
  "setSendSharesGate(address)"
  "setReceiveAssetsGate(address)"
  "setSendAssetsGate(address)"
  "setAdapterRegistry(address)"
  "addAdapter(address)"
  "abdicate(bytes4)"
  "setPerformanceFee(uint256)"
  "setManagementFee(uint256)"
  "setPerformanceFeeRecipient(address)"
  "setManagementFeeRecipient(address)"
  "increaseAbsoluteCap(bytes,uint256)"
  "increaseRelativeCap(bytes,uint256)"
  "setForceDeallocatePenalty(address,uint256)"
  "increaseTimelock(bytes4,uint256)"   # MUST stay last
)

lc() { echo "$1" | tr A-F a-f; }
RPC="$LIVE_RPC"
if [ "$MODE" = "--fork" ]; then
  PORT=8547
  anvil --fork-url "$LIVE_RPC" --port $PORT --auto-impersonate --silent &
  ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
  RPC="http://127.0.0.1:$PORT"
  for _ in $(seq 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  for a in $DEPLOYER $NEW_CURATOR; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null; done
elif [ "$MODE" = "--execute" ]; then
  [ -f "$ENV_FILE" ] || { echo "usage: $0 <env-file> --execute"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$KEY" ] || { echo "no key in $ENV_FILE"; exit 1; }
  [ "$(lc "$(cast wallet address --private-key "$KEY")")" = "$(lc $DEPLOYER)" ] || { echo "key is not the deployer — stopping"; exit 1; }
elif [ -n "$MODE" ]; then echo "unknown mode $MODE"; exit 1; fi

c() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }
send() { # send <from> <to> <sig> [args...]
  local from=$1; shift
  local out
  if [ "$MODE" = "--fork" ]; then out=$(cast send --unlocked --from "$from" "$@" --rpc-url "$RPC")
  else out=$(cast send --private-key "$KEY" "$@" --rpc-url "$RPC"); fi
  local st; st=$(echo "$out" | awk '/^status/{print $2}')
  echo "    $(echo "$out" | awk '/^transactionHash/{print $2}') status=$st"
  [ "$st" = "1" ] || { echo "tx failed — stopping"; exit 1; }
}

echo "== state (chain $(cast chain-id --rpc-url "$RPC"))"
OWNER=$(c $VAULT 'owner()(address)'); CUR=$(c $VAULT 'curator()(address)')
echo "  owner=$OWNER curator=$CUR"
echo "  Safe threshold=$(c $SAFE 'getThreshold()(uint256)') owners=$(cast call $SAFE 'getOwners()(address[])' --rpc-url "$RPC")"
echo "  deployer allocator=$(c $VAULT 'isAllocator(address)(bool)' $DEPLOYER)  new curator code bytes=$(( ($(cast code $NEW_CURATOR --rpc-url "$RPC" | wc -c) - 3) / 2 ))"
echo "  deployer ETH $(cast balance $DEPLOYER --ether --rpc-url "$RPC")"
[ "$(lc "$OWNER")" = "$(lc $SAFE)" ] || { echo "vault owner is not the RH Safe — stopping"; exit 1; }
echo "  timelocks now:"
for s in "${SIGS[@]}"; do printf "    %-44s %s\n" "$s" "$(c $VAULT 'timelock(bytes4)(uint256)' "$(cast sig "$s")")"; done

if [ -z "$MODE" ]; then
  echo "== plan: timelock each selector above to $DELAY s (3 days), then Safe.setCurator($NEW_CURATOR). Nothing sent."
  exit 0
fi

if [ "$(lc "$CUR")" = "$(lc $DEPLOYER)" ]; then
  echo "== 1. timelocks → $DELAY s (submit + execute, deployer is curator)"
  for s in "${SIGS[@]}"; do
    sel=$(cast sig "$s")
    now=$(c $VAULT 'timelock(bytes4)(uint256)' "$sel")
    if [ "$now" -ge "$DELAY" ]; then echo "  $s already $now"; continue; fi
    data=$(cast calldata 'increaseTimelock(bytes4,uint256)' "$sel" $DELAY)
    echo "  $s"
    if [ "$(c $VAULT 'executableAt(bytes)(uint256)' "$data")" = "0" ]; then send $DEPLOYER $VAULT 'submit(bytes)' "$data"; fi
    send $DEPLOYER $VAULT 'increaseTimelock(bytes4,uint256)' "$sel" $DELAY
  done
else
  echo "== 1. skipped: curator is already $CUR"
fi

if [ "$(lc "$(c $VAULT 'curator()(address)')")" != "$(lc $NEW_CURATOR)" ]; then
  echo "== 2. Safe → vault.setCurator($NEW_CURATOR)"
  inner=$(cast calldata 'setCurator(address)' $NEW_CURATOR)
  # 1-of-1 Safe, sender is the owner ⇒ pre-validated signature (r = owner, s = 0, v = 1)
  sig="0x000000000000000000000000${DEPLOYER:2}$(printf '%064x' 0)01"
  send $DEPLOYER $SAFE 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
    $VAULT 0 "$inner" 0 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 "$sig"
fi

echo "== verify"
CUR=$(c $VAULT 'curator()(address)'); echo "  curator=$CUR allocator(deployer)=$(c $VAULT 'isAllocator(address)(bool)' $DEPLOYER)"
[ "$(lc "$CUR")" = "$(lc $NEW_CURATOR)" ] || { echo "curator not moved"; exit 1; }
bad=0
for s in "${SIGS[@]}"; do t=$(c $VAULT 'timelock(bytes4)(uint256)' "$(cast sig "$s")"); [ "$t" -ge "$DELAY" ] || { echo "  ✗ $s = $t"; bad=1; }; done
[ $bad = 0 ] && echo "  ✓ all ${#SIGS[@]} selectors at ≥ $DELAY s"
if [ "$MODE" = "--fork" ]; then
  echo "== fork-only attack checks"
  if cast send --unlocked --from $DEPLOYER $VAULT 'submit(bytes)' "$(cast calldata 'addAdapter(address)' $DEPLOYER)" --rpc-url "$RPC" >/dev/null 2>&1
    then echo "  ✗ deployer could still submit"; bad=1; else echo "  ✓ deployer can no longer submit curator actions"; fi
  d=$(cast calldata 'addAdapter(address)' $DEPLOYER)
  cast send --unlocked --from $NEW_CURATOR $VAULT 'submit(bytes)' "$d" --rpc-url "$RPC" >/dev/null
  if cast send --unlocked --from $NEW_CURATOR $VAULT "$d" --rpc-url "$RPC" >/dev/null 2>&1
    then echo "  ✗ new curator added an adapter instantly"; bad=1; else echo "  ✓ new curator's addAdapter is locked until $(c $VAULT 'executableAt(bytes)(uint256)' "$d") (now $(cast block latest -f timestamp --rpc-url "$RPC"))"; fi
  if cast send --unlocked --from $DEPLOYER $VAULT 'setLiquidityAdapterAndData(address,bytes)' 0x5f6824f5832DFA6B30cEab41d01974beD1077238 0x --rpc-url "$RPC" >/dev/null 2>&1
    then echo "  ✓ deployer still works as allocator"; else echo "  ✗ deployer allocator call failed"; bad=1; fi
fi
exit $bad
