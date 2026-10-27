#!/usr/bin/env bash
# Trust 0x AllowanceHolder as a swap target on the Arbitrum V15 pools (A–D).
# The keeper quotes via /swap/allowance-holder/quote (PR #1): the vault
# approves swapTarget then calls it, and transaction.to is always this fixed
# AllowanceHolder address. Run by the deployer (DEFAULT_ADMIN_ROLE).
#   --check   read-only: show current trust per vault, send nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

AH=0x0000000000001fF3684f28c67538d4D072C22734
VAULTS=(
  0xBCEfabd6948d99d9E98Ae8910431D239B15759Aa  # A
  0xDFCb998A7EBFA5B85a32c0Db16b2AbB85a1c25ce  # B
  0xabBD8748ACC1ca2abc3fA5933EfE2CB1cdf7B8f1  # C
  0xF16b728c0973C742a4c769B3217843707Ce4f09d  # D
)

for v in "${VAULTS[@]}"; do
  cur=$(cast call "$v" "trustedSwapTargets(address)(bool)" "$AH" --rpc-url "$ARB_RPC")
  echo "$v trusted=$cur"
  [ "${1:-}" = "--check" ] && continue
  [ "$cur" = "true" ] && continue
  cast send "$v" "setTrustedSwapTarget(address,bool)" "$AH" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$ARB_RPC" | grep -E "^(status|transactionHash)"
  echo "  now trusted=$(cast call "$v" "trustedSwapTargets(address)(bool)" "$AH" --rpc-url "$ARB_RPC")"
done
