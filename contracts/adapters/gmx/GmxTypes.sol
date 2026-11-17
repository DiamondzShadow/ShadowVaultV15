// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Minimal GMX V2 (gmx-synthetics) types the GM adapter needs. ABI-compatible re-declarations, checked 2026-11-17
// against gmx-synthetics main (event/EventUtils.sol, callback/I*CallbackReceiver.sol, deposit/IDepositUtils.sol,
// withdrawal/IWithdrawalUtils.sol) and the ExchangeRouter ABI shipped in @gmx-io/sdk 2.9.1.

library GmxEventUtils {
    struct EventLogData {
        AddressItems addressItems;
        UintItems uintItems;
        IntItems intItems;
        BoolItems boolItems;
        Bytes32Items bytes32Items;
        BytesItems bytesItems;
        StringItems stringItems;
    }

    struct AddressItems { AddressKeyValue[] items; AddressArrayKeyValue[] arrayItems; }
    struct UintItems { UintKeyValue[] items; UintArrayKeyValue[] arrayItems; }
    struct IntItems { IntKeyValue[] items; IntArrayKeyValue[] arrayItems; }
    struct BoolItems { BoolKeyValue[] items; BoolArrayKeyValue[] arrayItems; }
    struct Bytes32Items { Bytes32KeyValue[] items; Bytes32ArrayKeyValue[] arrayItems; }
    struct BytesItems { BytesKeyValue[] items; BytesArrayKeyValue[] arrayItems; }
    struct StringItems { StringKeyValue[] items; StringArrayKeyValue[] arrayItems; }

    struct AddressKeyValue { string key; address value; }
    struct AddressArrayKeyValue { string key; address[] value; }
    struct UintKeyValue { string key; uint256 value; }
    struct UintArrayKeyValue { string key; uint256[] value; }
    struct IntKeyValue { string key; int256 value; }
    struct IntArrayKeyValue { string key; int256[] value; }
    struct BoolKeyValue { string key; bool value; }
    struct BoolArrayKeyValue { string key; bool[] value; }
    struct Bytes32KeyValue { string key; bytes32 value; }
    struct Bytes32ArrayKeyValue { string key; bytes32[] value; }
    struct BytesKeyValue { string key; bytes value; }
    struct BytesArrayKeyValue { string key; bytes[] value; }
    struct StringKeyValue { string key; string value; }
    struct StringArrayKeyValue { string key; string[] value; }
}

struct CreateDepositParamsAddresses {
    address receiver;
    address callbackContract;
    address uiFeeReceiver;
    address market;
    address initialLongToken;
    address initialShortToken;
    address[] longTokenSwapPath;
    address[] shortTokenSwapPath;
}

struct CreateDepositParams {
    CreateDepositParamsAddresses addresses;
    uint256 minMarketTokens;
    bool shouldUnwrapNativeToken;
    uint256 executionFee;
    uint256 callbackGasLimit;
    bytes32[] dataList;
}

struct CreateWithdrawalParamsAddresses {
    address receiver;
    address callbackContract;
    address uiFeeReceiver;
    address market;
    address[] longTokenSwapPath;
    address[] shortTokenSwapPath;
}

struct CreateWithdrawalParams {
    CreateWithdrawalParamsAddresses addresses;
    uint256 minLongTokenAmount;
    uint256 minShortTokenAmount;
    bool shouldUnwrapNativeToken;
    uint256 executionFee;
    uint256 callbackGasLimit;
    bytes32[] dataList;
}

interface IGmxExchangeRouter {
    function router() external view returns (address);
    function roleStore() external view returns (address);
    function dataStore() external view returns (address);
    function sendWnt(address receiver, uint256 amount) external payable;
    function sendTokens(address token, address receiver, uint256 amount) external payable;
    function createDeposit(CreateDepositParams calldata params) external payable returns (bytes32);
    function createWithdrawal(CreateWithdrawalParams calldata params) external payable returns (bytes32);
    function cancelDeposit(bytes32 key) external payable;
    function cancelWithdrawal(bytes32 key) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

interface IGmxRoleStore {
    function hasRole(address account, bytes32 roleKey) external view returns (bool);
}

interface IGmxDataStore {
    function containsBytes32(bytes32 setKey, bytes32 value) external view returns (bool);
}
