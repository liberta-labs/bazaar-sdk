# Smart Accounts & Batching

Bazaar has no batch form of `createOrder`: each order is one call. (Canceling and amending are
batched already: `cancelOrders` takes up to 200 ids and `amendOrders` up to 32 amendments.) To place
several orders at once, or to approve, deposit and trade in one step, trade from a **contract account**
that calls the pair several times in one transaction. That gets most of what a batch entry point would:
one transaction's overhead, warm storage for the later calls, and one price update for all of them.

The SDK supports two ways to submit such a batch:

- a wallet that batches natively through **EIP-5792** `wallet_sendCalls` (many smart wallets, ERC-4337
  accounts and Safes speak it), with `batching.sendCalls`;
- the example **BazaarTradingAccount** contract from Bazaar's repository
  (`examples/BazaarTradingAccount.sol`), with `batching.tradingAccountExecute`.

Read [Batching Orders](https://docs.bazaar.finance/guide/batching.html) in Bazaar's docs for the
pattern and its costs. The samples assume `bz` connected as in [Connecting](connecting.md) and `eth` a
market.

## The Account Is the Trader

The pair sees ordinary calls from the account's address, so the account, not its owner, holds
everything: collateral, positions, resting orders and claimable fees. That means:

- **Build every call with `from` = the account.** With a smart wallet, the address the wallet connects
  as is the account.
- **Approve USDC to the pair from the account** (`approveUsdc(account, pair, ...)`), in the same batch
  or before. A deposit or a bounty pulls from the account's USDC.
- **Claim through the account**, and move withdrawn USDC on to the owner inside the batch:
  `withdrawCollateral` and `claimFees` pay the caller.
- **The account is one trader**: one net position per market, 32 active Limit + StopLimit orders, one
  TakeProfit and one StopLoss, shared by everything it does.
- **Its own orders never fill each other.** A later order that crosses an earlier one is a self-match
  and is canceled. Quote both sides at prices that do not cross.
- **An auto-cancel does not stop the batch** (margin, self-match, post-only): the call returns normally
  and the batch goes on. A fill-or-kill that cannot fill, a bad hint, or a margin failure at creation
  reverts that call, and with it the whole batch.
- **Gas per order is unchanged.** A crossing order can walk 32 makers at roughly 90k gas each, so keep
  batches of taking orders short: about nine full walks reach Arbitrum's 32M gas per-transaction limit.
- **Hints are computed per order**, against the live book, when each call is built.
- **No gasless path.** The relayed path checks a plain ECDSA signature, which a smart account cannot
  produce; it sends its calls directly ([Gasless Trading & Relayers](gasless.md#smart-contract-wallets-cannot-sign)).

## Building the Batch

```ts
{{#include ../../examples/trading/batching.ts:build}}
```

`batching.toBatchCalls(calls)` turns prepared calls into the generic `{ to, data, value }` shape smart
wallets take, in order; `batching.batchValue(calls)` sums their ETH.

### shareOnePriceUpdate

Every price-carrying builder attaches its own Pyth update and pays its own fee. In one transaction only
the first is needed: the pair reads Pyth's on-chain price first and parses an update only when that
price is more than 3 seconds old, so once one call has stored a fresh price, the later calls find it.

`batching.shareOnePriceUpdate(calls)` keeps the update and fee on the first call to each pair that
always stores a price (`createOrder`, `amendOrders`, `executeTriggeredOrders`, `refreshPrice`), and
re-encodes the later calls to the same pair with an empty `priceUpdate`, `value` 0 and no `priceTime`.
Calls to other contracts (an approval, say) and calls with no price update are left as they are. The
result must run in one transaction, in this order.

## EIP-5792 Wallets

```ts
{{#include ../../examples/trading/batching.ts:eip5792}}
```

`batching.sendCalls(wallet, ctx, from, calls, opts?)` sends `wallet_sendCalls` and returns the wallet's
batch id. Track it with `batching.getCallsStatus(wallet, id)`, which returns the wallet's
`wallet_getCallsStatus` answer as it gave it (in EIP-5792 2.0, `status` 100 is pending, 200 confirmed,
400 and above failed). Every failure, including a wallet that does not support the method, is thrown as
a `CallError`. Build price-carrying calls right before sending.

`bz.batching.walletSendCallsRequest(from, calls, opts?)` returns the request itself, for a library that
sends it (wagmi's `sendCalls`, say):

```ts
{{#include ../../examples/trading/batching.ts:request}}
```

| Option | Default | Meaning |
|---|---|---|
| `atomicRequired` | `true` | Require the wallet to run the calls atomically: a Bazaar batch is meant as one. |
| `capabilities` | none | Wallet capabilities (a paymaster service and the like), passed through as given. |
| `version` | `"2.0.0"` | The EIP-5792 request version. |

A batch from a smart wallet cannot be simulated with `bz.simulate`, which runs one call. Simulate each
call that does not depend on an earlier one in the batch, or rely on the wallet's own simulation.

## BazaarTradingAccount

The example account is the smallest contract that does the job: an owner, and one function,
`execute(Call[] calls)`, which runs the calls in order as the account and returns each call's return
data. The first call that fails reverts the whole batch with that call's own revert data, so a failure
decodes like a direct call's. It is yours to deploy, one per trader; it is not part of the protocol and
has not been audited with it. Only its owner may call `execute`.

```ts
{{#include ../../examples/trading/batching.ts:trading-account}}
```

`batching.tradingAccountExecute(account, owner, calls)` returns one `PreparedCall` to the account:

| Field | Value |
|---|---|
| `action` | `"execute"` |
| `to` | The account. |
| `from` | The owner, who sends it. |
| `value` | The sum of the inner calls' values (their Pyth fees). The account forwards each call's own; the pair refunds any unspent fee to the account. |
| `summary` | The inner call's summary for one call, else `"3 calls: ...; ...; ..."`. |
| `priceTime` | The earliest of the inner calls' price times. |
| `pullsUsdc` | The sum of what the inner calls pull, which comes from the **account's** USDC and its allowance to each pair, not the owner's wallet. |

Simulate it as the owner (`bz.simulate(exec)` does, since `from` is the owner) and
`batching.decodeTradingAccountResults(sim.returnData)` gives one `Hex` return value per inner call.
`bz.batching.readTradingAccountOwner(account)` reads the owner. The lower-level pieces are
`batching.TRADING_ACCOUNT_ABI` and `batching.encodeTradingAccountExecute(batchCalls)`.

### Getting Money Out

`withdrawCollateral` pays the account. To reach the owner, add a USDC transfer to the same batch. The
SDK has no builder for a plain transfer, so encode it with viem:

```ts
{{#include ../../examples/trading/batching.ts:withdraw-to-owner}}
```

## What Can Go Wrong

| You see | It means |
|---|---|
| `CallError` from `sendCalls` | The wallet refused, or does not support `wallet_sendCalls` (fall back to sending the calls one by one). |
| `InputError` on `calls`: "Nothing to send." | An empty batch. |
| `Unknown(0x...)` from `execute` | Most often `BazaarTradingAccount__NotOwner`: the sender is not the account's owner. The SDK's decoder does not know the example contract's errors. |
| `Error`: "ERC20: transfer amount exceeds allowance" | The account (not the owner) lacks USDC or an allowance to the pair. |
| `OrderManagementLib__InsufficientMarginAfterOrder` | The account's collateral, after the batch's earlier deposits, does not cover the order. |
| `MatchingEngineLib__FillOrKillUnfilled` | A fill-or-kill order in the batch could not fill, and the whole batch reverted. |

## Related Pages

- [Building a Bot](bots.md): a quoting loop from an EOA.
- [Placing Orders](orders.md) and [Collateral](collateral.md): the calls in a batch.
- [Sending Transactions](sending.md): one call at a time.
