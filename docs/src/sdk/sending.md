# Sending Transactions

Every write the SDK builds, on any Bazaar contract, comes back as one shape: a `PreparedCall`. The SDK
never holds a user's key and never sends anything by itself. You inspect the call, simulate it as the
user, show its summary, and hand it to whatever signs: a browser wallet, a viem or wagmi client, or a
bot's local key.

This page covers that path end to end. The builders themselves (`createOrder`, `depositCollateral`,
...) are on their own pages: [Collateral](collateral.md), [Placing Orders](orders.md),
[Managing Orders](managing-orders.md). The gasless path, where the user signs and a relayer sends, is
in [Gasless Trading & Relayers](gasless.md).

The samples assume `bz` connected as in [Connecting](connecting.md), `user` the wallet's address, and
`eth` a market from [Markets](markets.md).

## The Flow

1. **Build** the call with a builder. It checks its inputs against what it can read (the account's
   orders, the book, the live price) and throws an [`InputError`](errors.md#inputerror) naming the
   field for anything it would refuse.
2. **Simulate** it as the user (`bz.simulate`). A revert comes back decoded, with a sentence for the
   user, before anything is signed.
3. **Show** `call.summary` (and, for a call that takes USDC, `call.pullsUsdc`) on the confirmation
   screen.
4. **Send** it with the user's wallet (`bz.send`, `toTransactionRequest` for viem and wagmi, or a local
   key in a bot).
5. **Wait** for the receipt (`bz.waitForReceipt`).

A call that carries a Pyth price update has to land within 3 seconds of that update's publish time,
so for those calls steps 1 to 4 must happen in quick succession. See
[The 3-Second Price Window](#the-3-second-price-window).

## PreparedCall

```ts
{{#include ../../examples/trading/sending.ts:prepared}}
```

| Field | Type | Meaning |
|---|---|---|
| `action` | `string` | The contract function: `"createOrder"`, `"depositCollateral"`, `"approve"`, `"execute"`, `"proposeTermination"`, ... |
| `to` | `Address` | The contract to call: the pair, USDC for an approval, the terminator or factory for governance calls. |
| `data` | `Hex` | The calldata. |
| `value` | `bigint` | ETH to send, in wei: the Pyth update fee when the call carries a price update, otherwise `0n`. |
| `from` | `Address \| null` | The account the call acts for: the sender of a direct call. `null` when the builder does not know it (a relayed call encoded without `relayer`). |
| `summary` | `string` | One line for a confirmation screen, such as `Deposit 100 USDC as collateral` or `Buy 0.5 at 3000 (limit, GTC)`. Amounts print exactly. |
| `priceTime` | `number \| undefined` | Present when the call carries a Pyth update: the update's publish time in unix seconds (the oldest leg's, for a composite market). |
| `noFreshPrice` | `string \| undefined` | Present when the call takes a Pyth update but carries none because the price source had none the oracle would accept: why. The pair then judges the call on its stored price. |
| `pullsUsdc` | `bigint \| undefined` | USDC the call takes from the wallet, in BAZAAR precision (18 decimals): a deposit's amount, a trigger order's keeper bounty, `0n` for calls that pull nothing. Check the wallet against it with [`usdcFunding`](collateral.md#checking-balance-and-allowance). |

The builders that read a price fetch the update from the connection's `prices` source; a connection
without one fails with `ConnectError` ("this call needs a fresh Pyth price") on those builders. They
attach it only when the oracle would accept it (`priceUpdateFor`, `updateProblem`): an update that
fails verification reverts the whole call, while a call with none runs on the pair's stored price. So
when the source's price is one Pyth carries forward from a closed venue, wider than the 2% confidence
cap, or not a usable live price, a market with trading hours gets no update (the call's
`noFreshPrice` says why), and a continuously traded market, which has no stale fallback, fails with
`NoFreshPriceError` instead of building a call that must revert.

| Builder | Carries a price update |
|---|---|
| `createOrder`, `amendOrders`, `executeTriggeredOrders` | Whenever the oracle would accept one (above). |
| `withdrawCollateral` | When a price source is connected and has one the oracle would accept (the pair refunds the fee when it does not read the price), or `withPrice: true`. A flat account's withdrawal goes without one when there is none. |
| `depositCollateral`, `cancelOrders`, `claimFees`, `approveUsdc` | Never. |

The insurance and termination builders that read a price are described on [Insurance](insurance.md)
and [Termination & Settlement](termination.md).

## Simulating

```ts
{{#include ../../examples/trading/sending.ts:simulate}}
```

`bz.simulate(call, opts?)` runs the call with `eth_call` as `opts.from`, else `call.from`, sending
`call.value`, and nothing is signed or broadcast. It is `simulate(bz.ctx, call, opts)` with the context
bound.

| Option | Default | Meaning |
|---|---|---|
| `from` | `call.from` | The account to simulate as. |
| `estimateGas` | `true` | Also run `eth_estimateGas`. Skipped when there is no `from`; a failed estimate leaves `gas` null rather than failing the simulation. |

The result is a `Simulation`:

| Field | Type | Meaning |
|---|---|---|
| `ok` | `boolean` | The call would succeed against the current state. |
| `returnData` | `Hex` | The call's return data, or the revert data when `ok` is false (`"0x"` when the node returned none). |
| `error` | `DecodedError \| null` | Why it would revert: the custom error's `name`, its decoded `args`, and `message`, a sentence for the user. Null when `ok`. See [Errors & Messages](errors.md). |
| `gas` | `bigint \| null` | The `eth_estimateGas` answer, when it was asked for and succeeded. |

A JSON-RPC error answer counts as a revert (`ok: false`). A transport failure (the RPC is down, an
HTTP error, a timeout) is not a revert: `simulate` throws it.

A simulation is against the state at the latest block. The transaction lands later, after other
transactions, so a successful simulation is a strong hint, not a guarantee. It also stores no price:
the simulated call reads the update it carries exactly as the real one will.

## Sending Through an EIP-1193 Wallet

```ts
{{#include ../../examples/trading/sending.ts:send}}
```

`bz.send(wallet, call, opts?)` (the standalone `sendCall`) asks any EIP-1193 provider, such as
`window.ethereum`, to `eth_sendTransaction` the call, and returns the transaction hash once the wallet
has accepted it. The wallet estimates gas and fees itself.

| Option | Default | Meaning |
|---|---|---|
| `from` | `call.from` | The sending account. A call with neither fails with `CallError("sending needs the user's address (from)")`. |
| `gas` | none | A gas limit to send instead of the wallet's own estimate. |

Every failure is thrown as a [`CallError`](#callerror): the user rejecting the prompt, the wallet
refusing, or the wallet's gas estimate reverting (in which case `decoded` holds the reason).

## Sending With viem or wagmi

`toTransactionRequest(call)` returns `{ to, data, value, account }` (without `account` when
`call.from` is null), the shape viem's `sendTransaction` takes:

```ts
{{#include ../../examples/trading/sending.ts:viem}}
```

wagmi's `sendTransaction` action and `useSendTransaction` hook take the same fields, so
`sendTransaction(config, toTransactionRequest(call))` works there unchanged. Wait for the receipt with
`bz.waitForReceipt(hash)` or with your library's own receipt helper.

## Sending From a Bot With a Local Key

A bot or a service signs with its own key. Connect `bz` with an RPC URL for reads and send with a viem
wallet client that holds a local account:

```ts
{{#include ../../examples/trading/send-local-key.ts:local-key}}
```

Two details matter here:

- Do not spread `toTransactionRequest(call)` into a local-account client: its `account` is the bare
  address, and viem then asks the node to sign with `eth_sendTransaction`, which a public RPC refuses.
  Pass `to`, `data` and `value` and let the client's account sign.
- `nonceManager` (from viem) hands out nonces locally, so two sends in quick succession do not reuse
  one. A bot that sends one transaction at a time and waits for each receipt does not need it, but it
  costs nothing.

[Building a Bot](bots.md) puts this together with live prices, a quoting loop and error handling.

## The 3-Second Price Window

The pair accepts a Pyth price only when it was generated at most 3 seconds from the block's timestamp
(`MAX_PRICE_STALENESS`). A call that carries an update is judged on it: the pair has it verified, and
an update whose price is older than that reverts the call. A call that carries none runs on the pair's
own stored price while that is at most 3 seconds old, which it is only when another call stored one
that recently. Pyth Pro keeps no price on chain, so nothing else stands in. See
[Oracle](https://docs.bazaar.finance/protocol/oracle.html) for the full rule, including the stale-price
regime of markets with trading hours.

The update is fetched when the call is built, so the clock starts then: the time to simulate, to show a
confirmation screen, for the user to approve in the wallet, and for the transaction to be included all
count against those 3 seconds. In practice:

- **Build as late as possible.** `buildAndSend(wallet, build, opts?)` takes a function that builds the
  call, calls it, and immediately sends the result through the wallet, returning `{ call, hash }`.
  Simulate on the same build (as in [Rebuilding](#rebuilding-a-call)) or accept that the wallet's own
  gas estimate is the only check.

```ts
{{#include ../../examples/trading/sending.ts:build-and-send}}
```

- **Rebuild a call whose `priceTime` is more than a second or two old** before it reaches the wallet.
  The keeper does the same: its price service sends a print only while it is at least 1 second younger
  than the limit (`sendMargin`).

- **Expect direct sends from a slow wallet to revert.** A browser wallet's prompt can take longer than
  3 seconds to approve, and the update was fixed when the call was built: once its price is older than
  the window, the call reverts on chain (`BazaarOracle__StalePrice`), whatever other traders did
  meanwhile. The wallet's estimate was made when the prompt opened, so it does not catch this. A
  reverted receipt makes `waitForReceipt` throw; offer to try again with a freshly built call.

- **Gasless calls do not have the problem.** The price update is outside the signed request, so the
  relayer attaches a fresh one when it submits. See [Gasless Trading & Relayers](gasless.md).

- **Bots sign locally and send in milliseconds**, so build, simulate and send in one go and they land
  well inside the window.

### Rebuilding a Call

```ts
{{#include ../../examples/trading/sending.ts:fresh}}
```

A stale print fails inside Pyth's contract with Pyth's own `StalePrice` error (selector `0x19abf40e`).
The SDK's ABIs do not declare it, so it decodes as `Unknown(0x19abf40e)`; when you see that name on a
price-carrying call, rebuild it. [Errors & Messages](errors.md#errors-the-sdk-does-not-name) shows how to
give it a message.

## Waiting for the Receipt

`bz.waitForReceipt(hash, opts?)` polls `eth_getTransactionReceipt` until the transaction is mined.

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | `120000` | How long to wait before giving up. |
| `pollMs` | `500` | Time between polls. |

It returns a `Receipt` (`transactionHash`, `blockNumber`, `status`, `gasUsed`, `effectiveGasPrice`,
`from`, `to`, `logs`), and throws `CallError` when the transaction reverted ("transaction 0x...
reverted") or has no receipt by the timeout ("... has no receipt after 120 s"). A revert seen in a
receipt carries no reason: the node does not return it. To learn why, simulate the same call again, or
read the events with [Live Updates](live-updates.md). A timeout does not mean the transaction failed:
it may still be mined, so look it up by hash before sending it again.

## CallError

```ts
{{#include ../../examples/trading/sending.ts:call-error}}
```

`CallError` is what `sendCall`, `buildAndSend`, `waitForReceipt` and the batching senders throw:

| Field | Meaning |
|---|---|
| `message` | The decoded revert's user message when there is one, else the wallet's or node's own message. |
| `decoded` | The `DecodedError` when the wallet's error carried revert data (its gas estimate reverted), else `null`. |
| `cause` | The original error from the wallet or library, for logging. |

Show `errorMessage(e)` to the user: it handles a `CallError`, a wallet rejection, a decoded revert and
an `InputError` alike. [Errors & Messages](errors.md) has the details, and the cases it does not cover.

## Related Pages

- [Collateral, Approvals & Permits](collateral.md): the USDC a call pulls, and how to allow it.
- [Errors & Messages](errors.md): everything a call can throw and what to show.
- [Gasless Trading & Relayers](gasless.md): the path where the user signs and someone else sends.
- [Smart Accounts & Batching](batching.md): several prepared calls in one transaction.
