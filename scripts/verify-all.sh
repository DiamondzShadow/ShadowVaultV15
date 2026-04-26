#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  verify-all.sh — Verify every deployed V15 contract on Arbiscan
#                  via Etherscan V2 multichain API
#
#  The Arbiscan-specific API key path was deprecated. Etherscan V2 uses
#  a single API key across every supported chain (Arbitrum One, Base,
#  Optimism, Polygon, etc.) — grab yours from etherscan.io/myapikey.
#
#  Prereqs (one-time):
#    1. npm install --save-dev @nomicfoundation/hardhat-verify@latest
#    2. Add ETHERSCAN_API_KEY=... to .env  (get from etherscan.io/myapikey)
#    3. Add this to hardhat.config.cjs at the top of the imports:
#         require("@nomicfoundation/hardhat-verify");
#       And inside module.exports:
#         etherscan: {
#           apiKey: process.env.ETHERSCAN_API_KEY,
#         },
#       A single string (not an object) is enough — hardhat-verify
#       routes to the right chain via the --network flag.
#
#  Run:
#    chmod +x scripts/verify-all.sh
#    ./scripts/verify-all.sh
# ═══════════════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/.."

DEPLOYER=0xC5D133296E17BA25DF0409a6C31607bf3B78e3e3
TREASURY=0x6052C6559eD5e5CbE74Ac0D42205Ad4A1CFBEd43
SDM=0x602b869eEf1C9F0487F31776bad8Af3C4A173394
PYTH=0xff1a0f4744e8582DF1aE09D5611b887B6a12925C
PEPE_ID=0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4
XAU_ID=0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2

# v15.1 (original) yield adapter instances
AAVE=0x10A65B5495118E63229E96D6be314C76f1505B9E
FLUID=0xF11043AF4cb0476A52E0A1A6385D9219e1783d77
SILO_V1=0x9d6A28ab668abE25B9dD6Bc3a9D202Db558E9858       # deprecated v15.1 SiloAdapter
SILO_V2=0x2B85eF85585E54aA1Cc5571cd3c900BABdF66334       # live v15.2 SiloAdapter

# v15.1 Pool B vault + NFT (deprecated, kept for orphaned-$3 rescue)
VAULT_B_V1=0x68033705605B695484b170420A832f0c90C7E0a9
NFT_B_V1=0x8e3Ca0a9F320ae43dA8150a48b561645584Ef66e

# v15.2 Pool B vault + NFT (live)
VAULT_B_V2=0x0D32FA2788Ee6D19ae6ccc5BDB657C7321Ce8C90
NFT_B_V2=0xc3Bd5C51f2Aeb07fA0B933b42F796bdF943a18C5

# Pool A + Pool C vaults + NFTs
VAULT_A=0x3EABca4E9F1dA0CA6b61a3CC942c09Dd51D77E32
VAULT_C=0x2Ddd79fFdE4d382A40267E5D533F761d86365D64
NFT_A=0x6F0C3e2cDeCb6D54ff3CA4e4346351BB273a99DF
NFT_C=0x9afA017A457682F3b7cb226Be205df7CCa467FdC

echo "═══ 1/17  SDMDiscountOracle ═══"
npx hardhat verify --network arbitrum 0xfC18918f2A980665bC596c7af787bC30D8bdd7Ec $DEPLOYER 10000000000000000000000

echo "═══ 2/17  RevenueRouter ═══"
npx hardhat verify --network arbitrum 0x13606740f02a7e96cFCD602E4ecBA4c5e56E3363 $DEPLOYER $TREASURY $TREASURY

echo "═══ 3/17  BonusAccumulator ═══"
npx hardhat verify --network arbitrum 0x5Fe2C414433D3CB8B6e656a7D8951D73cE7fbdb2 $DEPLOYER

echo "═══ 4/17  AaveAdapterV5 ═══"
npx hardhat verify --network arbitrum $AAVE $DEPLOYER

echo "═══ 5/17  FluidAdapter ═══"
npx hardhat verify --network arbitrum $FLUID $DEPLOYER

echo "═══ 6/17  SiloAdapter (v15.2 live) ═══"
npx hardhat verify --network arbitrum $SILO_V2 $DEPLOYER

echo "═══ 7/17  SiloAdapter (v15.1 deprecated) ═══"
npx hardhat verify --network arbitrum $SILO_V1 $DEPLOYER

echo "═══ 8/17  PythFeed PEPE/USD ═══"
npx hardhat verify --network arbitrum 0x4153629e7cc3Cb7EcB3624F3B863822ffd004707 $PYTH $PEPE_ID

echo "═══ 9/17  PythFeed XAU/USD ═══"
npx hardhat verify --network arbitrum 0x587b3499d3234a93CCC411e945295e3735BBb6a4 $PYTH $XAU_ID

echo "═══ 10/17  ShadowPositionNFTV15 (A — Blue Chip) ═══"
npx hardhat verify --network arbitrum $NFT_A "Blue Chip" $DEPLOYER

echo "═══ 11/17  ShadowPositionNFTV15 (B v15.2 — DeFi + RWA) ═══"
npx hardhat verify --network arbitrum $NFT_B_V2 "DeFi + RWA" $DEPLOYER

echo "═══ 12/17  ShadowPositionNFTV15 (B v15.1 — DeFi + RWA deprecated) ═══"
npx hardhat verify --network arbitrum $NFT_B_V1 "DeFi + RWA" $DEPLOYER

echo "═══ 13/17  ShadowPositionNFTV15 (C — Full Spectrum) ═══"
npx hardhat verify --network arbitrum $NFT_C "Full Spectrum" $DEPLOYER

echo "═══ 14/17  ShadowVaultV15 (A — Blue Chip) ═══"
npx hardhat verify --network arbitrum $VAULT_A $DEPLOYER $AAVE $TREASURY $SDM

echo "═══ 15/17  ShadowVaultV15 (B v15.2 — DeFi + RWA live) ═══"
npx hardhat verify --network arbitrum $VAULT_B_V2 $DEPLOYER $SILO_V2 $TREASURY $SDM

echo "═══ 16/17  ShadowVaultV15 (B v15.1 — DeFi + RWA deprecated) ═══"
npx hardhat verify --network arbitrum $VAULT_B_V1 $DEPLOYER $SILO_V1 $TREASURY $SDM

echo "═══ 17/17  ShadowVaultV15 (C — Full Spectrum) ═══"
npx hardhat verify --network arbitrum $VAULT_C $DEPLOYER $FLUID $TREASURY $SDM

echo ""
echo "✅ All 17 contracts submitted to Etherscan V2 for verification."
echo "   Note: v15.1 Pool B entries are deprecated but verified for audit trail."
