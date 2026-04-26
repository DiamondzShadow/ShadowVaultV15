// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only stand-in for ShadowVaultV15.estimatePositionValue +
///      requestWithdraw / completeWithdraw. Each tokenId has a settable
///      "live value" so tests can simulate value changes, AND a settable
///      "next payout" that completeWithdraw delivers to the requestor on
///      the same call.
contract MockPositionVault {
    mapping(uint256 => uint256) public valueOf;          // total USD (6-dec)
    mapping(uint256 => uint256) public nextPayoutOf;     // USDC delivered on completeWithdraw

    enum Status { NONE, REQUESTED, COMPLETED }
    mapping(uint256 => Status)  public status;
    mapping(uint256 => address) public withdrawRecipient;

    address public usdc;

    constructor(address _usdc) { usdc = _usdc; }

    function setValue(uint256 tokenId, uint256 newValue) external { valueOf[tokenId] = newValue; }
    function setNextPayout(uint256 tokenId, uint256 amount) external { nextPayoutOf[tokenId] = amount; }

    /// @notice Mock claimYield — sends `nextYield[tokenId]` USDC to msg.sender.
    ///         Mirrors the V15 vault behavior: the position owner (= caller)
    ///         receives the harvest. Tests pre-fund this contract + setNextYield.
    mapping(uint256 => uint256) public nextYieldOf;
    function setNextYield(uint256 tokenId, uint256 amount) external { nextYieldOf[tokenId] = amount; }
    function claimYield(uint256 posId) external {
        uint256 amt = nextYieldOf[posId];
        nextYieldOf[posId] = 0;
        if (amt > 0) {
            (bool ok, ) = usdc.call(
                abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amt)
            );
            require(ok, "claimYield transfer failed");
        }
    }

    function estimatePositionValue(uint256 posId)
        external view returns (uint256 basketVal, uint256 yieldVal, uint256 total)
    {
        return (0, 0, valueOf[posId]);
    }

    function requestWithdraw(uint256 posId) external {
        status[posId] = Status.REQUESTED;
        withdrawRecipient[posId] = msg.sender;
    }

    /// @dev Production V15 vault calls completeWithdraw(uint256) and pays
    ///      out from its own USDC balance. Mock mirrors that 1-arg signature
    ///      and pulls the configured payout from pre-funded mock balance.
    function completeWithdraw(uint256 posId) external {
        status[posId] = Status.COMPLETED;
        uint256 amt = nextPayoutOf[posId];
        if (amt > 0) {
            (bool ok, ) = usdc.call(
                abi.encodeWithSignature("transfer(address,uint256)", withdrawRecipient[posId], amt)
            );
            require(ok, "transfer failed");
        }
    }
}
