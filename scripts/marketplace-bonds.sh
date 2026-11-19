#!/usr/bin/env bash
# Open the non-custodial MarketplaceV3.1 (Arbitrum) to V16 bonds.
#   1. DiggerRegistry.registerInHouseCollection(bond, bond, 0) for each Arbitrum ShadowBond
#      (value source = the bond itself: preview(id); LTV 0 = no lending against bonds)
#   2. RoyaltyRouter: sale fees go to the Arbitrum Safe (Trezor co-owned) instead of the
#      $1 test LendingPool (90% "supplier" cut) and the deployer-only 0x6052 Safe (10%).
#
#   marketplace-bonds.sh                        read-only: state + plan
#   marketplace-bonds.sh <env-file> --fork      rehearse incl. issue → list → buy → early redeem by the buyer
#   marketplace-bonds.sh <env-file> --execute   send for real from the deployer (registry + router admin)
set -euo pipefail
ENV_FILE="${1:-}"; MODE="${2:-}"
LIVE_RPC="${ARB_RPC:-https://arbitrum-one-rpc.publicnode.com}"
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
REGISTRY=0x090275f1ddae9e37C28D495AD9f9044723D787c9
ROUTER=0xb9c6edfcd6fBd861ba8b92c3eDddbf5babED1be4
MKT=0x749735623C5f9304E6a6715b066C9FBa7b9F30DB
ARB_SAFE=0x18b2b2ce7d05Bfe0883Ff874ba0C536A89D07363
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
BONDS=(0xd2F63C8ce8c368E771FEC8aCDf5F9C3a82F6525C 0xaa0Fb7De8a0f199fb7c4B3d420C531d7918CF0b2 0xF58c21729397268cFc4308652521ab139885fb34)
lc() { echo "$1" | tr A-F a-f; }

RPC="$LIVE_RPC"
if [ "$MODE" = "--fork" ]; then
  PORT=8560
  anvil --fork-url "$LIVE_RPC" --port $PORT --auto-impersonate --silent & ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
  RPC="http://127.0.0.1:$PORT"
  for _ in $(seq 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  cast rpc anvil_setBalance $DEPLOYER 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
elif [ "$MODE" = "--execute" ]; then
  [ -f "$ENV_FILE" ] || { echo "usage: $0 <env-file> --execute"; exit 1; }
  set -a; . "$ENV_FILE"; set +a
  KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$KEY" ] || { echo "no key in $ENV_FILE"; exit 1; }
  [ "$(lc "$(cast wallet address --private-key "$KEY")")" = "$(lc $DEPLOYER)" ] || { echo "key is not the deployer — stopping"; exit 1; }
elif [ -n "$MODE" ]; then echo "unknown mode $MODE"; exit 1; fi

c() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }
send() { # send <from> <to> <sig> [args...]
  local from=$1; shift; local out
  if [ "$MODE" = "--fork" ]; then out=$(cast send --unlocked --from "$from" "$@" --rpc-url "$RPC")
  else out=$(cast send --private-key "$KEY" "$@" --rpc-url "$RPC"); fi
  local st; st=$(echo "$out" | awk '/^status/{print $2}')
  echo "    $(echo "$out" | awk '/^transactionHash/{print $2}') status=$st"
  [ "$st" = "1" ] || { echo "tx failed — stopping"; exit 1; }
}

echo "== state (chain $(cast chain-id --rpc-url "$RPC"))"
echo "  router treasury=$(c $ROUTER 'treasury()(address)') lendingPool=$(c $ROUTER 'lendingPool()(address)')"
echo "  marketplace paused=$(c $MKT 'paused()(bool)') fee=$(c $MKT 'protocolFeeBps()(uint16)') bps"
for b in "${BONDS[@]}"; do echo "  $b $(cast call $b 'symbol()(string)' --rpc-url "$RPC") listable=$(c $REGISTRY 'isListable(address)(bool)' $b)"; done
if [ -z "$MODE" ]; then echo "== plan: register ${#BONDS[@]} bonds in-house (LTV 0); router lendingPool→0, treasury→$ARB_SAFE. Nothing sent."; exit 0; fi

echo "== 1. register bonds"
for b in "${BONDS[@]}"; do
  if [ "$(c $REGISTRY 'isListable(address)(bool)' $b)" = "true" ]; then echo "  $b already listable"; continue; fi
  echo "  $b"; send $DEPLOYER $REGISTRY 'registerInHouseCollection(address,address,uint16)' $b $b 0
done
echo "== 2. fee routing"
[ "$(lc "$(c $ROUTER 'lendingPool()(address)')")" = "0x0000000000000000000000000000000000000000" ] || { echo "  lendingPool → 0"; send $DEPLOYER $ROUTER 'setLendingPool(address)' 0x0000000000000000000000000000000000000000; }
[ "$(lc "$(c $ROUTER 'treasury()(address)')")" = "$(lc $ARB_SAFE)" ] || { echo "  treasury → Arb Safe"; send $DEPLOYER $ROUTER 'setTreasury(address)' $ARB_SAFE; }

bad=0
echo "== verify"
for b in "${BONDS[@]}"; do [ "$(c $REGISTRY 'isListable(address)(bool)' $b)" = "true" ] && echo "  ✓ $b listable" || { echo "  ✗ $b"; bad=1; }; done
echo "  router treasury=$(c $ROUTER 'treasury()(address)') lendingPool=$(c $ROUTER 'lendingPool()(address)')"

if [ "$MODE" = "--fork" ]; then
  echo "== fork: issue → list → buy → buyer redeems"
  SELLER=0x00000000000000000000000000000000005e11e7; BUYER=0x00000000000000000000000000000000000b0b0b
  for a in $SELLER $BUYER; do
    cast rpc anvil_setBalance $a 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
    slot=$(cast index address $a 9)   # FiatToken balances mapping is slot 9
    cast rpc anvil_setStorageAt $USDC $slot $(printf '0x%064x' 1000000000) --rpc-url "$RPC" >/dev/null
  done
  BOND=${BONDS[0]}
  cast send --gas-limit 3000000 --unlocked --from $SELLER $USDC 'approve(address,uint256)' $BOND 100000000 --rpc-url "$RPC" >/dev/null
  cast send --gas-limit 3000000 --unlocked --from $SELLER $BOND 'issue(uint256,uint64,address)' 100000000 2592000 $SELLER --rpc-url "$RPC" >/dev/null
  ID=$(( $(c $BOND 'nextId()(uint256)') - 1 )); echo "  seller bond #$ID owner=$(c $BOND 'ownerOf(uint256)(address)' $ID) preview=$(cast call $BOND 'preview(uint256)(uint256,uint256,bool)' $ID --rpc-url "$RPC" | head -1)"
  cast send --gas-limit 3000000 --unlocked --from $SELLER $BOND 'setApprovalForAll(address,bool)' $MKT true --rpc-url "$RPC" >/dev/null
  cast send --gas-limit 3000000 --unlocked --from $SELLER $MKT 'list(address,uint256,uint256,uint64)' $BOND $ID 99500000 0 --rpc-url "$RPC" >/dev/null
  OID=$(c $MKT 'activeOrderOf(address,uint256)(uint256)' $BOND $ID); echo "  order #$OID fillable=$(c $MKT 'isFillable(uint256)(bool)' $OID)"
  s0=$(c $USDC 'balanceOf(address)(uint256)' $SELLER); t0=$(c $USDC 'balanceOf(address)(uint256)' $ARB_SAFE)
  cast send --gas-limit 3000000 --unlocked --from $BUYER $USDC 'approve(address,uint256)' $MKT 99500000 --rpc-url "$RPC" >/dev/null
  cast send --gas-limit 3000000 --unlocked --from $BUYER $MKT 'fill(uint256)' $OID --rpc-url "$RPC" >/dev/null
  own=$(c $BOND 'ownerOf(uint256)(address)' $ID)
  echo "  owner now $own  seller +$(( $(c $USDC 'balanceOf(address)(uint256)' $SELLER) - s0 ))  Arb Safe fee +$(( $(c $USDC 'balanceOf(address)(uint256)' $ARB_SAFE) - t0 ))"
  [ "$(lc $own)" = "$(lc $BUYER)" ] || { echo "  ✗ buyer didn't get the bond"; bad=1; }
  b0=$(c $USDC 'balanceOf(address)(uint256)' $BUYER)
  cast send --gas-limit 3000000 --unlocked --from $BUYER $BOND 'redeem(uint256,address,uint256)' $ID $BUYER 0 --rpc-url "$RPC" >/dev/null
  echo "  buyer early-redeemed: +$(( $(c $USDC 'balanceOf(address)(uint256)' $BUYER) - b0 )) USDC (6 dp)"
  st=$(cast send --gas-limit 3000000 --unlocked --from $SELLER $BOND 'redeem(uint256,address,uint256)' $ID $SELLER 0 --rpc-url "$RPC" 2>/dev/null | awk '/^status/{print $2}' || true)
  if [ "$st" = "1" ]; then echo "  ✗ seller could redeem a sold bond"; bad=1; else echo "  ✓ seller can't redeem the sold bond (status ${st:-reverted})"; fi
fi
exit $bad
