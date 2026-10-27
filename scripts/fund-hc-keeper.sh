#!/usr/bin/env bash
# Top up the HyperEVM (chain 999) keeper with HYPE gas from the deployer.
# The keeper runs the Pool E/F NAV + HLP cycles on Temporal schedules.
#   usage: fund-hc-keeper.sh [amount-in-HYPE]   (default 0.0015)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

RPC=https://rpc.hyperliquid.xyz/evm
KEEPER=0x506cB442df1B58ae4F654753BEf9E531088ca0eB
AMT=${1:-0.0015}

echo "deployer HYPE: $(cast balance 0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3 --ether --rpc-url $RPC)"
echo "keeper   HYPE: $(cast balance $KEEPER --ether --rpc-url $RPC)"
echo "▸ sending $AMT HYPE to keeper…"
# HyperEVM: priority fee 0.
cast send $KEEPER --value "${AMT}ether" --private-key "$DEPLOYER_KEY" \
  --rpc-url $RPC --priority-gas-price 0 | grep -E "^(status|transactionHash)"
echo "keeper   HYPE: $(cast balance $KEEPER --ether --rpc-url $RPC)"
