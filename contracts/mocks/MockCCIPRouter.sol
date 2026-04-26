// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CCIPClient, ICCIPReceiver} from "../ccip/ICCIPRouter.sol";

/// @dev Test-only CCIP router. `ccipSend` just delivers the message to the
///      paired mock router on the "other chain" by calling the receiver's
///      `ccipReceive` directly (same-tx cross-call).
contract MockCCIPRouter {
    address public paired;       // paired router on the "other chain"
    uint64  public selfSelector; // this chain's CCIP selector
    uint256 public feeWei = 0;   // configurable mock fee

    event RelayedTo(address receiver, bytes32 messageId);

    function setPaired(address _p, uint64 _s) external { paired = _p; selfSelector = _s; }
    function setFee(uint256 f) external { feeWei = f; }

    function getFee(uint64 /*dst*/, CCIPClient.EVM2AnyMessage calldata /*msg*/) external view returns (uint256) {
        return feeWei;
    }

    function ccipSend(uint64 dst, CCIPClient.EVM2AnyMessage calldata m) external payable returns (bytes32) {
        // The mock just forwards to the paired router which knows how to
        // reach the receiver (encoded in m.receiver).
        require(paired != address(0), "no paired");
        bytes32 mid = keccak256(abi.encode(dst, m.receiver, m.data, block.number));
        MockCCIPRouter(payable(paired)).deliver(selfSelector, msg.sender, m.receiver, m.data, mid);
        emit RelayedTo(abi.decode(m.receiver, (address)), mid);
        return mid;
    }

    /// @notice Called by the sibling mock router to actually invoke the
    ///         receiver's ccipReceive handler. `sourceSelector` is the sibling's
    ///         self-selector, and `sender` is the original sender on that chain.
    function deliver(uint64 sourceSelector, address sender, bytes calldata receiverBytes, bytes calldata data, bytes32 mid) external {
        address recv = abi.decode(receiverBytes, (address));
        CCIPClient.EVMTokenAmount[] memory empty = new CCIPClient.EVMTokenAmount[](0);
        ICCIPReceiver(recv).ccipReceive(CCIPClient.Any2EVMMessage({
            messageId:            mid,
            sourceChainSelector:  sourceSelector,
            sender:               abi.encode(sender),
            data:                 data,
            destTokenAmounts:     empty
        }));
    }

    receive() external payable {}
}
