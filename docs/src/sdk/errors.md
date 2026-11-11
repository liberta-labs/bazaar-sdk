# Errors & Messages

Every failure a Bazaar call can raise has a sentence a user can act on. The SDK ships one message for
every custom error the five Bazaar contracts declare, explains the failures wallets raise before
anything reaches the chain, and refuses bad inputs with errors that name the field. This page covers
what can be thrown, how to turn it into text, and the few cases you still have to handle yourself.

The samples assume `bz` connected as in [Connecting](connecting.md), `user` the wallet's address and
`eth` a market.

## The Short Version

```ts
{{#include ../../examples/trading/errors.ts:error-message}}
```

`errorMessage(e)` takes anything a call threw (or a simulation's `error`) and returns one sentence. It
never returns a raw URL or a stack trace. Use it as the default, and add the cases in
[A Complete Handler](#a-complete-handler) for the errors it does not explain.

## What Can Be Thrown

| Error | From | Means |
|---|---|---|
| `InputError` | Every builder, `buildOrderSpec`, `parseRelayed`; `ProClient`, `proPriceSource` and `Bazaar.connect` for Pyth's own endpoints without a token | An argument the SDK refused before building or signing anything. `field` names it (`prices.token` for a missing Pyth Pro API key). |
| `DecodedError` | `Simulation.error`, `CallError.decoded`, `decodeError(data)` | A revert, decoded: the custom error's name, arguments and user message. Not thrown by the SDK itself; a simulation returns it. |
| `CallError` | `sendCall` (`bz.send`), `buildAndSend`, `waitForReceipt`, `batching.sendCalls` | A send the wallet refused or that reverted, with `decoded` when the revert data came back. |
| `SigningError` | `signTypedDataV4`, `signPermit`, `signRelayed` | The wallet declined to sign, or returned a signature Bazaar cannot verify (a smart-contract wallet's, a high-s one). |
| `ClockSkewError` | `signPermit`, `signRelayed`, `chainDeadline`, `checkClockSkew` | The chain time the RPC reports and the device's clock disagree by more than 2 minutes, so nothing was signed. A `SigningError`. |
| `ConnectError` | `Bazaar.connect`, builders that need a price or the subgraph | Wrong chain, an address that is not a factory, or a connection without the `prices` or `subgraph` source the call needs. |
| `UnitError` | `parseUnits18`, `parseDecimal` | Text that is not a decimal number, or has too many decimals. |
| `PriceUpdateError` | `trade.parsePriceUpdate`, `livePairPrice` | A price update that is not a Pyth Pro update, or one missing a leg of the market. |
| `ProError` | The Pyth Pro client, price sources, `livePrices` | Pyth Pro could not be reached or refused the request (`status` holds the HTTP status), sent an update that cannot be read or is not signed by a trusted signer, or has no usable live price for a feed. The message never holds a token, and every URL in it is redacted. |
| `NoLivePriceError` | `proPriceSource().latest`, `LivePrices.latest` | A `ProError`: the endpoint answered, but has no usable live price for a feed asked for (the message says why). |
| `NoFreshPriceError` | Builders that need a price (`createOrder`, a withdrawal with exposure, ...), and `liquidationUpdateFor` on a continuously traded market | A `ProError`: no update the oracle would accept is available for a continuously traded market, so the call would revert. `reason` says why; `errorMessage` gives a sentence for users. |
| `NoLiquidationPriceError` | `liquidationUpdateFor` | A `ProError`: on a market with trading hours there is no fresh price, and Pyth's latest one is more than a minute old (or the oracle would refuse it), so no liquidation is possible until the market prices again. `pair` and `reason` say which and why. |
| `LazerError` | `lazer.parseUpdate` and the other codec functions, `feedIdHex`, `proFeedId` | Bytes that are not a valid Pyth Pro update, or a value that is not a Pyth Pro feed ID. |
| `RpcError`, `HttpError`, `SendError` | The JSON-RPC client | The node's error, an HTTP failure, or a send whose outcome is unknown. See [Low-Level Building Blocks](low-level.md). |

## errorMessage

`errorMessage(e)` checks, in order:

1. A `DecodedError`: its `message`.
2. An `InputError`: its `message` (which starts with the field: `"amount: The minimum deposit is 5 USDC."`).
3. A `NoFreshPriceError`: "No fresh price is available for this market right now, and this action
   needs one. Try again in a moment."
4. A `NoLiquidationPriceError`: "This market has no price that can decide a liquidation right now.
   Liquidations wait for its next price."
5. An error carrying a `decoded` `DecodedError` (a `CallError`): that error's message.
6. A wallet-side failure (`walletErrorMessage`, below).
7. An RPC error carrying revert data: the decoded revert's message; with empty revert data, "The call
   reverted without a reason (often out of gas)."
8. Anything else: "Something went wrong. Please try again."

Step 8 catches more than it should: a `SigningError` or `ClockSkewError` (including "You declined the
signature."), a `ConnectError`, and a `CallError` without decoded data (a reverted receipt, a timeout)
all come out as the generic sentence, although each carries a good message of its own. Handle them
before calling `errorMessage`, as the handler below does.

## Decoded Reverts

A simulation that fails returns a `DecodedError`:

```ts
{{#include ../../examples/trading/errors.ts:decoded}}
```

| Member | Meaning |
|---|---|
| `name` | The custom error's name in the ABI, such as `"OrderManagementLib__InsufficientMarginAfterOrder"`. |
| `args` | Its decoded arguments by name (`bigint` for numbers). |
| `message` | The user message (with the arguments formatted), else the operator hint, else the name. |
| `hint` | The operator-facing hint from `KEEPER_HINTS`, written for someone running the keeper, or `""`. |
| `data` | The raw revert data. |
| `opensAt()` | For a "too early" error, the time the call opens (from an argument named `deadline`, `effectiveTs`, `expiryTs`, `opensAt` or `scheduledTs`), else `null`. |
| `toString()` | `Name(arg=value, ...)` and the hint: for logs. |

`decodeError(data)` decodes any revert data:

| Data | `name` | `message` |
|---|---|---|
| A custom error one of the five ABIs declares | Its name | Its user message. |
| `Error(string)` (a `require` message, such as USDC's `ERC20: transfer amount exceeds allowance`) | `"Error"` | The string itself, except the reasons Pyth's verifier reverts with (`invalid signer`, `invalid signature`, `Insufficient fee provided`, `input too short`, `invalid evm magic`), which get a sentence from `REASON_MESSAGES`. |
| `Panic(uint256)` | `"Panic"` | `Solidity panic 0x11.` (the code in hex) |
| Empty, or shorter than a selector | `"Reverted"` | "The call reverted without a reason (often out of gas)." |
| Any other selector | `"Unknown(0x...)"` | "An error this package's ABIs do not declare." |

## User Messages

`USER_MESSAGES` holds one message for every custom error the five contracts declare (`BazaarPair`, and
the libraries it links whose errors surface at its address, `BazaarFactory`, `BazaarPairLens`,
`BazaarPairTerminator` and `BazaarOracle`): 187 errors, the Bazaar ones from
`BazaarPair__TradingHalted` to `Factory__ProposalNotFound` and the OpenZeppelin ones the contracts
inherit (`SafeERC20FailedOperation`, `ECDSAInvalidSignature`, `ReentrancyGuardReentrantCall`, the
`SafeCast` overflows, ...). The SDK's test suite fails when an error in the ABIs has no message. Each
says what happened and what to do, with the error's arguments formatted: BAZAAR-precision amounts as
dollars, prices with their decimals, basis points as percents, times as dates with a relative hint.

```ts
{{#include ../../examples/trading/errors.ts:by-name}}
```

`userMessage(name, args?)` returns the message for an error name (the name itself when unknown).
`Bazaar.connect` registers the messages with the decoder, so `DecodedError.message` returns them;
`installUserMessages()` does the same explicitly, for code that decodes without connecting (it is
idempotent).

The formatters the messages use are exported in the `format` namespace, for showing amounts the same
way: `formatUsd` ("$1,234.56"; amounts under a cent keep six decimals), `formatPrice` ("$3,012.5"),
`formatAmount` ("1.25"), `formatBp` (250 to "2.5%"), `formatEth` ("0.0001 ETH"), `formatDuration`
("12 min") and `formatTime` ("2026-11-08 14:00 UTC (in 3 h)").

## Wallet Errors

`walletErrorMessage(e)` explains failures the wallet raised rather than the contract, and returns `null`
for anything else. It walks `cause` chains, so it reads errors from viem, ethers and raw providers.

| Failure | Message |
|---|---|
| 4001, `ACTION_REJECTED`, `UserRejectedRequestError`, "user rejected" | You rejected the request in your wallet. |
| 4100 | Your wallet has not authorized this site for that account. ... |
| 4200 | Your wallet does not support this request. |
| 4900 | Your wallet is disconnected. ... |
| 4901, `ChainDisconnectedError` | Your wallet is not connected to this network. ... |
| 4902 | This network has not been added to your wallet yet. ... |
| -32002 | Your wallet already has a request waiting. ... |
| Insufficient funds | Your wallet does not have enough ETH for gas (plus any ETH the call sends). ... |
| Nonce too low | Your wallet's transaction count is out of date: another transaction already used it. ... |
| Chain mismatch | Your wallet is on a different network than this app. ... |

```ts
{{#include ../../examples/trading/errors.ts:wallet}}
```

## InputError

Builders check their arguments before reading the chain or asking for a signature, and throw
`InputError` with `field`, the argument at fault (`"amount"`, `"limitPrice"`, `"orderIds"`, `"pair"`,
...). The message is prefixed with the field; strip it to show the sentence next to that input:

```ts
{{#include ../../examples/trading/errors.ts:input-error}}
```

The order form on [Placing Orders](orders.md#validating-as-the-user-types) does this on every keystroke
with `buildOrderSpec`, which throws the same errors without any read.

## CallError and ClockSkewError

`CallError` (see [Sending Transactions](sending.md#callerror)) has `message`, `decoded` (the
`DecodedError` when the wallet's error carried revert data) and `cause`.

`ClockSkewError` has `chainTime` (the latest block's timestamp as the RPC reported it) and `localTime`
(the device's clock), both unix seconds, and a message telling the user to set the device's clock to
update automatically or to connect through another RPC.

## Errors the SDK Does Not Name

A few reverts come from contracts outside the five ABIs:

- **Pyth's verifier** (`Error`): a plain reason string, such as `invalid signature` or
  `Insufficient fee provided`. The ones listed under [Decoded Reverts](#decoded-reverts) get a sentence
  from `REASON_MESSAGES`; any other is shown as the string itself.
- **USDC's `require` messages** (`Error`): "ERC20: transfer amount exceeds allowance" or "... balance".
  Check funding first with `usdcFunding` ([Collateral](collateral.md#checking-balance-and-allowance)).
- **The example trading account's** `BazaarTradingAccount__NotOwner` (an `Unknown(...)` selector): the
  sender is not the account's owner ([Smart Accounts & Batching](batching.md)).

## A Complete Handler

```ts
{{#include ../../examples/trading/errors.ts:show-error}}
```

## Showing Errors in a UI

- **Simulate before you ask for a signature**, and show `sim.error.message` instead of opening the
  wallet. A user who never signs a doomed transaction never pays for one.
- **Put input errors next to their field**, using `InputError.field`, and keep the submit button
  disabled while there is one.
- **Gate buttons on the market's flags** (`marketOrdersDisabled`, `positionWithdrawalsFrozen`, ...,
  with `reasons`) rather than waiting for a revert ([Markets](markets.md)).
- **Show the sentence, log the detail.** Show `explain(e)`; log `String(decoded)` or `e.cause` for
  support.
- **Treat a rejection as a choice, not an error.** "You rejected the request in your wallet." needs no
  red banner.
- **Offer a retry where a retry helps**: a stale price, an expired gasless signature
  (`MetaTx__ExpiredDeadline`), a nonce that moved (`MetaTx__InvalidNonce`). Rebuild or re-sign; do not
  resend the same call.
- **Render on-chain strings as text**, never as HTML ([Security Notes](../reference/security.md)).

## Related Pages

- [Sending Transactions](sending.md): simulate, send, `CallError`.
- [Previews](previews.md): the same messages, before a call is even built.
- [Gasless Trading & Relayers](gasless.md): the `MetaTx__` errors and the relayer's checks.
