#!/usr/bin/env bash
# V16-lite on Robinhood Chain (4663): one USDG vault, no basket leg, no keeper.
#
# Deployed entirely from Morpho's audited Vault V2 stack — no custom Solidity:
#   our VaultV2 (ERC-4626, shares = position)
#     └─ liquidity adapter: MorphoVaultV1Adapter → Steakhouse steakUSDG
#        (0xBeEff033F34C046626B8D0A041844C5d1A5409dd, $537M, ungated)
# Deposits flow straight into steakUSDG and withdrawals pull straight out,
# in the same tx. Nothing for a keeper to do.
#
#   (no flag)  read-only: verify every address/assumption on live RH. Sends nothing.
#   --fork     full deploy + deposit/accrue/withdraw rehearsal on a local anvil fork.
#   --execute  deploy for real from the deployer, then hand ownership to the Safe.
#
# Yield note (2026-11-16): steakUSDG base ~3.8%. The extra 3.15% Merkl campaign
# is "[Robinhood Users Only]" and a contract holder will NOT qualify.
set -euo pipefail
MODE="${1:-}"
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

LIVE_RPC="${RH_RPC:-https://rpc.mainnet.chain.robinhood.com}"
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
STEAK=0xBeEff033F34C046626B8D0A041844C5d1A5409dd
VAULT_FACTORY=0x0FBad98595b0186dA120E41f77C102beb49f803c
ADAPTER_FACTORY=0x7a91222F3f7B927bB8fb624593Ca86e111C2F85e
REGISTRY=0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f
MORPHO_BLUE=0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010
DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
SAFE=0x6A9edB61177cD3fEc4D7Ff4FA096527C6f168f35   # RH Safe; final owner + fee recipient
NAME="Diamondz Shadow USDG"
SYMBOL="dsUSDG"
SALT=$(cast keccak "diamondz-v16-lite-rh-usdg-v1")
PERF_FEE=100000000000000000          # 10% of yield → Safe (WAD)
MAX_RATE=63419583967                 # 200% APR / 365d — Morpho's MAX_MAX_RATE; caps donation-driven jumps only
ABS_CAP=1000000000000                # 1,000,000 USDG (6 dec) — raise later via submit()
REL_CAP=1000000000000000000          # 100% (WAD)

RPC="$LIVE_RPC"
if [ "$MODE" = "--fork" ]; then
  PORT=8546
  anvil --fork-url "$LIVE_RPC" --port $PORT --auto-impersonate --disable-code-size-limit --silent &
  ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
  RPC="http://127.0.0.1:$PORT"
  for _ in $(seq 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  # anvil's default basefee (~1 gwei) is ~50x RH's real 0.02 gwei; fund the fork deployer so the
  # rehearsal isn't blocked by fork-only gas pricing. Real gas use is summed below.
  cast rpc anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
fi

c() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }
tx() { # tx <from> <to> <sig> [args...]
  local from=$1; shift
  if [ "$MODE" = "--fork" ]; then
    local out; out=$(cast send --unlocked --from "$from" "$@" --rpc-url "$RPC")
    echo "$out" | grep -E '^status' | sed "s/^/    $2 /"
    [ "$from" = "$DEPLOYER" ] && GAS_USED=$(( ${GAS_USED:-0} + $(echo "$out" | awk '/^gasUsed/{print $2}') ))
    return 0
  else
    cast send --private-key "$DEPLOYER_KEY" "$@" --rpc-url "$RPC" | grep -E '^(status|transactionHash)' | sed 's/^/    /'
  fi
}
die() { echo "!! $*"; exit 1; }

echo "== checks (chain $(cast chain-id --rpc-url "$RPC"))"
[ "$(cast chain-id --rpc-url "$RPC")" = 4663 ] || die "not Robinhood Chain"
[ "$(c "$STEAK" 'asset()(address)')" = "$USDG" ] || die "steakUSDG asset != USDG"
for g in sendSharesGate receiveSharesGate sendAssetsGate receiveAssetsGate; do
  [ "$(c "$STEAK" "$g()(address)")" = 0x0000000000000000000000000000000000000000 ] || die "steakUSDG has $g set"
done
for a in $VAULT_FACTORY $ADAPTER_FACTORY $REGISTRY $SAFE; do
  [ "$(cast code "$a" --rpc-url "$RPC" | wc -c)" -gt 3 ] || die "no code at $a"
done
[ "$(c "$VAULT_FACTORY" 'isVaultV2(address)(bool)' "$STEAK")" = true ] || die "steakUSDG not a factory VaultV2"
echo "  steakUSDG ok: asset USDG, no gates, totalAssets $(c "$STEAK" 'totalAssets()(uint256)') (6dec)"
echo "  Safe $SAFE threshold $(c "$SAFE" 'getThreshold()(uint256)') owners $(cast call "$SAFE" 'getOwners()(address[])' --rpc-url "$RPC")"
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "  deployer ETH $(cast from-wei "$BAL")  gasPrice $(cast gas-price --rpc-url "$RPC") wei"

VAULT=$(c "$VAULT_FACTORY" 'vaultV2(address,address,bytes32)(address)' "$DEPLOYER" "$USDG" "$SALT")
echo "  vault (predicted/existing) $VAULT"
if [ "$VAULT" != 0x0000000000000000000000000000000000000000 ]; then
  echo "  already deployed — nothing to do. owner=$(c "$VAULT" 'owner()(address)')"; exit 0
fi
VAULT=$(cast call "$VAULT_FACTORY" 'createVaultV2(address,address,bytes32)(address)' "$DEPLOYER" "$USDG" "$SALT" --from "$DEPLOYER" --rpc-url "$RPC")
echo "  vault will deploy to $VAULT"

case "$MODE" in --fork|--execute) ;; *) echo "read-only run — nothing sent. --fork to rehearse, --execute to deploy."; exit 0;; esac

if [ "$MODE" = "--execute" ]; then
  DEPLOYER_KEY="${DEPLOYER_KEY:-${PRIVATE_KEY:-${DEPLOYER_PK:-}}}"
  [ -n "$DEPLOYER_KEY" ] || die "no deployer key in env (DEPLOYER_KEY / PRIVATE_KEY / DEPLOYER_PK)"
  KADDR=$(cast wallet address --private-key "$DEPLOYER_KEY")
  [ "$(echo "$KADDR" | tr A-F a-f)" = "$(echo "$DEPLOYER" | tr A-F a-f)" ] || die "key resolves to $KADDR, not the deployer"
fi

echo "== deploy"
tx $DEPLOYER $VAULT_FACTORY 'createVaultV2(address,address,bytes32)' $DEPLOYER $USDG $SALT
[ "$(cast code "$VAULT" --rpc-url "$RPC" | wc -c)" -gt 3 ] || die "vault not at predicted address"
ADAPTER=$(cast call "$ADAPTER_FACTORY" 'createMorphoVaultV1Adapter(address,address)(address)' "$VAULT" "$STEAK" --from "$DEPLOYER" --rpc-url "$RPC")
tx $DEPLOYER $ADAPTER_FACTORY 'createMorphoVaultV1Adapter(address,address)' $VAULT $STEAK
echo "  vault   $VAULT"
echo "  adapter $ADAPTER (inRegistry=$(c "$REGISTRY" 'isInRegistry(address)(bool)' "$ADAPTER"))"

echo "== owner: name/symbol/curator"
tx $DEPLOYER $VAULT 'setName(string)' "$NAME"
tx $DEPLOYER $VAULT 'setSymbol(string)' "$SYMBOL"
tx $DEPLOYER $VAULT 'setCurator(address)' $DEPLOYER

echo "== curator: timelock is 0 on a fresh vault ⇒ submit then execute"
IDDATA=$(cast abi-encode 'f(string,address)' this "$ADAPTER")
curate() { # curate <sig> [args...]
  local data; data=$(cast calldata "$@")
  tx $DEPLOYER $VAULT 'submit(bytes)' "$data"
  tx $DEPLOYER $VAULT "$@"
}
# NOT setting adapterRegistry: Morpho's RH registry doesn't list MorphoVaultV1Adapter (no V1 vaults
# on RH), so it reverts NotInAdapterRegistry. Only matters for Morpho-app listing. To get listed later,
# switch to MorphoMarketV1AdapterV2 over steakUSDG's Blue markets (registry-approved) and curate those.
curate 'addAdapter(address)' $ADAPTER
curate 'setIsAllocator(address,bool)' $DEPLOYER true
curate 'increaseAbsoluteCap(bytes,uint256)' "$IDDATA" $ABS_CAP
curate 'increaseRelativeCap(bytes,uint256)' "$IDDATA" $REL_CAP
curate 'setPerformanceFeeRecipient(address)' $SAFE
curate 'setPerformanceFee(uint256)' $PERF_FEE

echo "== allocator: auto-route deposits/withdrawals to steakUSDG"
tx $DEPLOYER $VAULT 'setLiquidityAdapterAndData(address,bytes)' $ADAPTER 0x
tx $DEPLOYER $VAULT 'setMaxRate(uint256)' $MAX_RATE

if [ "$MODE" = "--fork" ]; then
  echo "== rehearsal: deposit 100 USDG, accrue 30d, withdraw all"
  U=0x00000000000000000000000000000000000B0b16   # fresh address, starts with 0 USDG
  for a in $U $MORPHO_BLUE; do cast rpc anvil_setBalance $a 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null; done
  tx $MORPHO_BLUE $USDG 'transfer(address,uint256)' $U 100000000
  tx $U $USDG 'approve(address,uint256)' $VAULT 100000000
  tx $U $VAULT 'deposit(uint256,address)' 100000000 $U
  echo "    shares $(c "$VAULT" 'balanceOf(address)(uint256)' $U)  vault totalAssets $(c "$VAULT" 'totalAssets()(uint256)')  adapter steak shares $(c "$STEAK" 'balanceOf(address)(uint256)' "$ADAPTER")  idle USDG $(c "$USDG" 'balanceOf(address)(uint256)' "$VAULT")"
  cast rpc evm_increaseTime 2592000 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
  echo "    after 30d: maxWithdraw $(c "$VAULT" 'previewRedeem(uint256)(uint256)' "$(c "$VAULT" 'balanceOf(address)(uint256)' $U)")"
  tx $U $VAULT 'redeem(uint256,address,address)' "$(c "$VAULT" 'balanceOf(address)(uint256)' $U)" $U $U
  echo "    user USDG back $(c "$USDG" 'balanceOf(address)(uint256)' $U)  Safe fee shares $(c "$VAULT" 'balanceOf(address)(uint256)' $SAFE)"
fi

echo "== hand ownership to Safe (curator + allocator stay deployer for ops)"
tx $DEPLOYER $VAULT 'setOwner(address)' $SAFE
echo "  owner=$(c "$VAULT" 'owner()(address)') curator=$(c "$VAULT" 'curator()(address)') liquidityAdapter=$(c "$VAULT" 'liquidityAdapter()(address)') perfFee=$(c "$VAULT" 'performanceFee()(uint96)')"
if [ "$MODE" = "--fork" ]; then
  LIVE_GP=$(cast gas-price --rpc-url "$LIVE_RPC")
  echo "deployer gas used: $GAS_USED  ≈ $(cast from-wei $((GAS_USED * LIVE_GP))) ETH at live RH gas price ($LIVE_GP wei)"
  echo "fork rehearsal done — nothing touched mainnet."
fi
