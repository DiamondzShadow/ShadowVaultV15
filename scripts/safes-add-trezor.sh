#!/usr/bin/env bash
# Step 1 of "Trezor becomes the only signer" on the Arbitrum, Robinhood Chain and HyperEVM Safes.
#   - deployer (current sole owner) adds the Trezor as a second owner, threshold stays 1 (nothing removed yet)
#   - tops up the Trezor with a little gas on chains where it has none, so it can sign step 2 itself
# Step 2 is done BY THE TREZOR in app.safe.global: Settings → Signers → remove the deployer.
# That proves the Trezor can sign on each chain before the deployer loses access (no lockout risk).
#
#   safes-add-trezor.sh                         read-only: show state + plan
#   safes-add-trezor.sh <env-file> --fork       rehearse each chain on an anvil fork
#   safes-add-trezor.sh <env-file> --execute    send for real from the deployer
set -euo pipefail
ENV_FILE="${1:-}"; MODE="${2:-}"
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
TREZOR=0x535Bf1Ba9f8d42f349589db9625D89873A32F60b
ZERO=0x0000000000000000000000000000000000000000
# name safe rpc gas-for-trezor(ether)
CHAINS=(
  "arbitrum 0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363 https://arb1.arbitrum.io/rpc 0"
  "robinhood 0x6A9edB61177cD3fEc4D7Ff4FA096527C6f168f35 https://rpc.mainnet.chain.robinhood.com 0.0002"
  "hyperevm 0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43 https://rpc.hyperliquid.xyz/evm 0.003"
)
lc() { echo "$1" | tr A-F a-f; }

if [ "$MODE" = "--execute" ]; then
  [ -f "$ENV_FILE" ] || { echo "usage: $0 <env-file> --execute"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$KEY" ] || { echo "no key in $ENV_FILE"; exit 1; }
  [ "$(lc "$(cast wallet address --private-key "$KEY")")" = "$(lc $DEPLOYER)" ] || { echo "key is not the deployer — stopping"; exit 1; }
elif [ -n "$MODE" ] && [ "$MODE" != "--fork" ]; then echo "unknown mode $MODE"; exit 1; fi

send() { # send <rpc> <cast send args...>
  local rpc=$1; shift; local out
  if [ "$MODE" = "--fork" ]; then out=$(cast send --unlocked --from $DEPLOYER "$@" --rpc-url "$rpc")
  else out=$(cast send --private-key "$KEY" "$@" --rpc-url "$rpc"); fi
  local st; st=$(echo "$out" | awk '/^status/{print $2}')
  echo "    $(echo "$out" | awk '/^transactionHash/{print $2}') status=$st"
  [ "$st" = "1" ] || { echo "tx failed — stopping"; exit 1; }
}

bad=0; port=8550
for row in "${CHAINS[@]}"; do
  set -- $row; name=$1; safe=$2; rpc=$3; gas=$4
  if [ "$MODE" = "--fork" ]; then
    port=$((port+1)); anvil --fork-url "$rpc" --port $port --auto-impersonate --silent & AP=$!
    rpc="http://127.0.0.1:$port"
    for _ in $(seq 60); do cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break; sleep 0.5; done
  fi
  owners=$(cast call $safe 'getOwners()(address[])' --rpc-url "$rpc"); th=$(cast call $safe 'getThreshold()(uint256)' --rpc-url "$rpc")
  echo "== $name Safe $safe owners=$owners threshold=$th  trezor gas=$(cast balance $TREZOR --ether --rpc-url "$rpc")"
  case "$(lc "$owners")" in *"$(lc $DEPLOYER)"*) ;; *) echo "  deployer is not an owner — skipping"; [ -n "${AP:-}" ] && kill $AP; continue;; esac
  if [ -z "$MODE" ]; then echo "  plan: addOwnerWithThreshold($TREZOR, 1); send $gas native gas to Trezor"; continue; fi
  if case "$(lc "$owners")" in *"$(lc $TREZOR)"*) true;; *) false;; esac; then echo "  Trezor already an owner"
  else
    inner=$(cast calldata 'addOwnerWithThreshold(address,uint256)' $TREZOR 1)
    sig="0x000000000000000000000000${DEPLOYER:2}$(printf '%064x' 0)01"   # pre-validated: sender is the owner
    echo "  add Trezor as owner"
    send "$rpc" $safe 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
      $safe 0 "$inner" 0 0 0 0 $ZERO $ZERO "$sig"
  fi
  if [ "$gas" != "0" ] && [ "$(cast balance $TREZOR --rpc-url "$rpc")" = "0" ]; then
    echo "  send $gas gas to Trezor"; send "$rpc" $TREZOR --value "${gas}ether"
  fi
  owners=$(cast call $safe 'getOwners()(address[])' --rpc-url "$rpc"); th=$(cast call $safe 'getThreshold()(uint256)' --rpc-url "$rpc")
  echo "  now owners=$owners threshold=$th"
  case "$(lc "$owners")" in *"$(lc $TREZOR)"*) ;; *) echo "  ✗ Trezor not added"; bad=1;; esac
  if [ "$MODE" = "--fork" ]; then   # prove step 2 works: Trezor alone removes the deployer
    prev=$(echo "$owners" | tr -d '[] ' | tr ',' '\n' | grep -i -B1 "$DEPLOYER" | head -1)
    [ "$(lc "$prev")" = "$(lc $DEPLOYER)" ] && prev=0x0000000000000000000000000000000000000001
    inner=$(cast calldata 'removeOwner(address,address,uint256)' $prev $DEPLOYER 1)
    tsig="0x000000000000000000000000${TREZOR:2}$(printf '%064x' 0)01"
    cast rpc anvil_setBalance $TREZOR 0xDE0B6B3A7640000 --rpc-url "$rpc" >/dev/null
    cast send --unlocked --from $TREZOR $safe 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
      $safe 0 "$inner" 0 0 0 0 $ZERO $ZERO "$tsig" --rpc-url "$rpc" >/dev/null
    fin=$(cast call $safe 'getOwners()(address[])' --rpc-url "$rpc")
    [ "$(lc "$fin")" = "[$(lc $TREZOR)]" ] && echo "  ✓ step 2 rehearsal: Trezor alone removed the deployer → owners=$fin" || { echo "  ✗ step 2 rehearsal: $fin"; bad=1; }
    kill $AP 2>/dev/null; unset AP
  fi
done
exit $bad
