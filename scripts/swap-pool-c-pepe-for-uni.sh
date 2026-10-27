#!/usr/bin/env bash
# Arb Pool C ("Full Spectrum"): replace PEPE (5%) with UNI (5%).
#
# PEPE's feed is a Pyth price that only stays fresh if someone pushes it, and
# Hermes now needs a paid key. The vault has no removeBasketToken, so PEPE is
# zero-weighted (0 weight + 0 balance ⇒ never priced) and UNI is added with its
# Chainlink feed. Run by the deployer (DEFAULT_ADMIN_ROLE). Idempotent.
#
#   (no args)      read-only: print current state and what would change.
#   --execute      send the transactions.
#   RPC=<url>      override the RPC (e.g. an anvil fork for rehearsal).
set -euo pipefail
# Capture the mode FIRST: the loop below uses `set --`, which overwrites $1.
# (The first version read $1 after that and executed when asked to --check.)
MODE=${1:-check}
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

RPC=${RPC:-$ARB_RPC}
VAULT=0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1
PEPE=0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00
UNI=0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0
UNI_FEED=0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720   # Chainlink UNI / USD, 8 dec, 24h heartbeat
UNI_WEIGHT=500
UNI_STALENESS=90000                                      # 25h: heartbeat + 1h margin

cfg() { cast call $VAULT "basketTokens(uint256)(address,uint256,address,uint8,uint8,uint32)" "$1" --rpc-url "$RPC" | tr '\n' ' '; }

n=$(cast call $VAULT "basketLength()(uint256)" --rpc-url "$RPC")
pepe_idx=""; uni_idx=""
for i in $(seq 0 $((n - 1))); do
  set -- $(cfg "$i")
  [ "${1,,}" = "${PEPE,,}" ] && { pepe_idx=$i; pepe_w=$2; }
  [ "${1,,}" = "${UNI,,}" ] && { uni_idx=$i; uni_w=$2; }
done
echo "PEPE: index=${pepe_idx:-none} weight=${pepe_w:-}  balance=$(cast call $PEPE 'balanceOf(address)(uint256)' $VAULT --rpc-url "$RPC")"
echo "UNI : index=${uni_idx:-none} weight=${uni_w:-}"
echo "UNI feed: $(cast call $UNI_FEED 'description()(string)' --rpc-url "$RPC")  answer=$(cast call $UNI_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC" | sed -n 2p)"

need_pepe=$([ -n "$pepe_idx" ] && [ "$pepe_w" != "0" ] && echo 1 || echo 0)
need_uni=$([ -z "$uni_idx" ] && echo 1 || echo 0)
if [ "$need_pepe" = 0 ] && [ "$need_uni" = 0 ]; then echo "✓ already done"; exit 0; fi
if [ "$MODE" != "--execute" ]; then
  [ "$need_pepe" = 1 ] && echo "would: updateBasketWeight($pepe_idx, 0)"
  [ "$need_uni" = 1 ] && echo "would: addBasketToken($UNI, $UNI_WEIGHT, $UNI_FEED, 8, 18, $UNI_STALENESS)"
  echo "(read-only — pass --execute to send)"
  exit 0
fi

if [ "$need_pepe" = 1 ]; then
  echo "▸ zero-weighting PEPE (index $pepe_idx)…"
  cast send $VAULT "updateBasketWeight(uint256,uint256)" "$pepe_idx" 0 \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" | grep -E "^(status|transactionHash)"
fi
if [ "$need_uni" = 1 ]; then
  echo "▸ adding UNI at ${UNI_WEIGHT} bps…"
  cast send $VAULT "addBasketToken(address,uint256,address,uint8,uint8,uint32)" \
    $UNI $UNI_WEIGHT $UNI_FEED 8 18 $UNI_STALENESS \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC" | grep -E "^(status|transactionHash)"
fi

echo "basket now:"
n=$(cast call $VAULT "basketLength()(uint256)" --rpc-url "$RPC")
for i in $(seq 0 $((n - 1))); do set -- $(cfg "$i"); echo "  [$i] $1 weight=$2"; done
