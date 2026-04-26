// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal slice of Chainlink CCIP router + client types.
/// @dev Kept as an inline interface file to avoid pulling in the full
///      Chainlink CCIP package; the struct layouts and function selectors
///      match the canonical upstream definitions.
library CCIPClient {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64  sourceChainSelector;
        bytes   sender;     // abi.encode(address)
        bytes   data;
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVM2AnyMessage {
        bytes receiver;     // abi.encode(address)
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;   // address(0) = pay in native
        bytes extraArgs;    // encoded EVMExtraArgsV2 / V1
    }

    /// @notice Helper to build v2 extraArgs (gas limit + ooo execution flag).
    ///         Selector: bytes4(keccak256("CCIP EVMExtraArgsV2"))
    function _argsV2(uint256 gasLimit, bool allowOutOfOrderExecution) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0x181dcf10, gasLimit, allowOutOfOrderExecution);
    }
}

interface ICCIPRouter {
    function getFee(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external view returns (uint256 fee);

    function ccipSend(uint64 destinationChainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external payable returns (bytes32);
}

/// @notice Receiver interface — CCIP router calls this on the destination
///         contract when a message arrives.
interface ICCIPReceiver {
    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external;
}
