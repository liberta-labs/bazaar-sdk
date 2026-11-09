// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IClaimableLens {
    function claimableFees(address pair, address recipient) external view returns (uint256 owed, uint256 total);
}

interface IPairState {
    function isAdlPending() external view returns (bool);
    function settlementPriceFixedTs() external view returns (uint256);
}

/// @title KeeperProbe
/// @notice Simulation helper for the Bazaar keeper. It is never deployed: the keeper places its
///         runtime code at a fixed address through an eth_call state override, so every call to it
///         is a simulation that costs nothing.
/// @dev Keeper rewards accrue to msg.sender's claimable balance on the pair, and inside a probe
///      call msg.sender is this contract. Reading its own balance before and after the call
///      therefore gives the exact reward the call earns, with every cap the contracts apply.
contract KeeperProbe {
    struct Call {
        address target;
        bytes data;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    /// @notice Runs one call and reports what it earned this contract on `pair`, and the pair
    ///         state the health-related jobs act on.
    /// @param target The contract to call
    /// @param data The calldata
    /// @param value The ETH to send with it (the Pyth fee); the state override funds this contract
    /// @param lens The BazaarPairLens that reads claimable balances
    /// @param pair The pair whose claimable balance and state to read; zero to skip those reads
    /// @return ok Whether the call succeeded
    /// @return ret The call's return data, or its revert data
    /// @return claimBefore This contract's claimable balance on `pair` before the call
    /// @return claimAfter The same balance after the call
    /// @return gasUsed Gas the call consumed, excluding the transaction's intrinsic cost
    /// @return adlPendingAfter `pair.isAdlPending()` after the call
    /// @return settlementFixedAfter `pair.settlementPriceFixedTs()` after the call
    function execute(address target, bytes calldata data, uint256 value, address lens, address pair)
        external
        returns (
            bool ok,
            bytes memory ret,
            uint256 claimBefore,
            uint256 claimAfter,
            uint256 gasUsed,
            bool adlPendingAfter,
            uint256 settlementFixedAfter
        )
    {
        if (pair != address(0)) (claimBefore,) = IClaimableLens(lens).claimableFees(pair, address(this));
        uint256 start = gasleft();
        (ok, ret) = target.call{value: value}(data);
        gasUsed = start - gasleft();
        if (pair != address(0)) {
            (claimAfter,) = IClaimableLens(lens).claimableFees(pair, address(this));
            adlPendingAfter = IPairState(pair).isAdlPending();
            settlementFixedAfter = IPairState(pair).settlementPriceFixedTs();
        }
    }

    /// @notice Batch read. A failing call is reported in its result rather than reverting the batch.
    /// @param calls The reads to run, in order
    /// @return results One result per call, in the same order
    function aggregate(Call[] calldata calls) external view returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (results[i].success, results[i].returnData) = calls[i].target.staticcall(calls[i].data);
        }
    }

    /// @notice Accepts the ETH the pair refunds when a call does not spend its whole Pyth fee.
    receive() external payable {}
}
