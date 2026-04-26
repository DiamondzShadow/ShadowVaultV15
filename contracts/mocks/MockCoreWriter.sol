// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only stand-in for the HyperEVM CoreWriter system contract at
///      0x3333333333333333333333333333333333333333. Captures every sendRawAction
///      call so tests can assert on the action encoding and ordering.
contract MockCoreWriter {
    bytes[] public actions;

    event ActionReceived(bytes data);

    function sendRawAction(bytes calldata data) external {
        actions.push(data);
        emit ActionReceived(data);
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function getAction(uint256 i) external view returns (bytes memory) {
        return actions[i];
    }

    function reset() external {
        delete actions;
    }
}
