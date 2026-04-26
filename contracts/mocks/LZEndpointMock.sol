// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Re-export the official LayerZero v2 EndpointV2Mock so hardhat compiles it
// into artifacts/ and our tests can deploy it via getContractFactory("EndpointV2Mock").
import "@layerzerolabs/test-devtools-evm-hardhat/contracts/mocks/EndpointV2Mock.sol";
