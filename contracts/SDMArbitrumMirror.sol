// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SDMArbitrumMirror
/// @notice Cross-chain SDM balance mirror: keeper-pushed Arb SDM holdings,
///         exposed through the IERC20 `balanceOf(address)` shape so the
///         existing `ShadowVaultV15.setSDMToken(...)` lever just works.
///
///         Why a mirror, not a bridge: SDM has no canonical bridge to
///         HyperEVM. Mirroring read-only balances avoids splitting SDM
///         liquidity, requires no user action, and keeps the vault contract
///         unchanged. The trust assumption is the keeper EOA + this contract;
///         worst case (keeper goes silent) is stale balances, not lost funds.
///
///         Surface used by ShadowVaultV15:
///           - balanceOf(address) view returns (uint256)
///         Vault calls `IERC20(sdmToken).balanceOf(user)` only — never
///         transfer / approve / totalSupply. The other ERC20 methods are
///         intentionally omitted to make accidental "transfer my mirror SDM"
///         attempts revert at the ABI level.
///
///         Staleness:
///           - Each user balance carries `lastUpdate` (uint64 unix seconds).
///           - `globalLastSync` is bumped on every push.
///           - The vault doesn't enforce staleness today; if needed later,
///             swap `setSDMToken` to a wrapper that gates on `lastUpdate`.
contract SDMArbitrumMirror is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Source SDM token on Arbitrum, for off-chain reference.
    address public constant SOURCE_TOKEN = 0x602b869eEf1C9F0487F31776bad8Af3C4A173394;
    uint256 public constant SOURCE_CHAIN_ID = 42161;

    string  public constant name     = "Arbitrum SDM Mirror";
    string  public constant symbol   = "mSDM-arb";
    uint8   public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint64)  public lastUpdate;
    uint64 public globalLastSync;

    event BalanceMirrored(address indexed user, uint256 oldAmount, uint256 newAmount, uint64 ts);
    event BatchMirrored(uint256 count, uint64 ts);

    error LengthMismatch(uint256 users, uint256 amounts);
    error EmptyBatch();
    error TooManyEntries(uint256 count, uint256 max);

    /// @notice Hard cap on a batch push to bound gas and bound the cost of an
    ///         attacker-controlled-keeper griefing.
    uint256 public constant MAX_BATCH = 200;

    constructor(address admin, address keeper) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    function setBalance(address user, uint256 amount) external onlyRole(KEEPER_ROLE) {
        uint256 prev = balanceOf[user];
        balanceOf[user] = amount;
        uint64 ts = uint64(block.timestamp);
        lastUpdate[user] = ts;
        globalLastSync = ts;
        emit BalanceMirrored(user, prev, amount, ts);
    }

    function setBatch(address[] calldata users, uint256[] calldata amounts)
        external
        onlyRole(KEEPER_ROLE)
    {
        uint256 n = users.length;
        if (n == 0) revert EmptyBatch();
        if (n != amounts.length) revert LengthMismatch(n, amounts.length);
        if (n > MAX_BATCH) revert TooManyEntries(n, MAX_BATCH);
        uint64 ts = uint64(block.timestamp);
        for (uint256 i = 0; i < n; ++i) {
            address u = users[i];
            uint256 a = amounts[i];
            uint256 prev = balanceOf[u];
            balanceOf[u] = a;
            lastUpdate[u] = ts;
            emit BalanceMirrored(u, prev, a, ts);
        }
        globalLastSync = ts;
        emit BatchMirrored(n, ts);
    }

    function addKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(KEEPER_ROLE, keeper);
    }

    function removeKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(KEEPER_ROLE, keeper);
    }
}
