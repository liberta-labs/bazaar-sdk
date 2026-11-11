# Core Concepts

The SDK is built around a handful of ideas that every page after this one assumes: a connection
bound to one deployment, functions grouped by area, writes returned as prepared calls, one rule for
units, a price window, errors written for users, and a short list of things it caches. This page
explains each.

## The Connection

A connection is a `BazaarContext`: one chain, one Bazaar deployment, and the optional services some
functions need. `Bazaar.connect(options)` creates one (see [Connecting](../sdk/connecting.md)); it is
`bz.ctx`.

| Field | What it is |
|---|---|
| `chain` | The SDK's `Chain` over your transport: reads, batched reads, simulations, logs, receipts. |
| `chainId` | The chain the transport is on, read at connect. |
| `factory` | The deployment's `BazaarFactory`, as you gave it. |
| `lens`, `terminator`, `oracle`, `usdc` | The deployment's other contracts, read from the factory at connect. |
| `prices` | Where signed Pyth updates come from, or `null` for a read-only connection. Every call that carries a price needs it. |
| `subgraph` | Bazaar's subgraph, or `null`. Only history needs it. |
| `integrator` | The address every order this connection creates names as its integrator (the zero address for none). |

Nothing in a context changes after it is made. A connection is bound to a chain, not to a user:
every function takes the user's address as an argument, so one connection serves any number of
accounts. When the wallet switches chain, connect again.

## The Facade and the Namespaces

Each area of the SDK is a module of plain functions that take the context first:
`markets.getMarket(ctx, "ETH/USD")`, `trade.createOrder(ctx, pair, user, order)`. The `Bazaar` object
binds the context into every one of them, so the same calls read `bz.markets.getMarket("ETH/USD")`
and `bz.trade.createOrder(pair, user, order)`.

```ts
{{#include ../../examples/getting-started/concepts.ts:facade}}
```

| Area | On `bz` | What it covers |
|---|---|---|
| `markets` | `bz.markets` | The market list, snapshots, the book |
| `account` | `bz.account` | Account snapshots and portfolios |
| `live` | `bz.live` | Watching a market or an account |
| `trade` | `bz.trade` | Collateral, orders, fees, trigger execution |
| `orders` | `bz.orders` | Order specs and their checks (mostly pure helpers) |
| `allowance`, `permits` | `bz.allowance`, `bz.permits` | USDC balance, approvals, permits |
| `signing`, `relay` | `bz.signing`, `bz.relay` | Gasless requests: signing, verifying, relaying |
| `batching` | `bz.batching` | Smart accounts and EIP-5792 batches |
| `previews` | `bz.previews` | What an order or a withdrawal would do |
| `history` | `bz.history` | The subgraph's records |
| `insurance` | `bz.insurance` | The insurance fund |
| `termination`, `listings`, `governance`, `uma` | same | Winding markets down, listing them, UMA |
| `priceFeeds` | (`bz.livePrices()`) | Pyth Pro sources and live prices |
| `format` | none | Formatting amounts, prices, times |

Use the facade in an application: it is shorter and cannot pass the wrong context. Use the
namespaces in a library that takes a context from its caller, and for the pure helpers (packing,
validation, formatting, type strings), which need no connection and are therefore not on `bz`:
`orders.blocksIn`, `orders.buildOrderSpec`, `format.formatUsd`. Importing `Bazaar` brings every area
into the bundle; an app that imports only a few namespace functions lets the bundler drop the rest.
The facade also has `bz.simulate`, `bz.send`, `bz.waitForReceipt`,
`bz.livePrices`, `bz.chainId` and `bz.deployment`.

The most used names (`Bazaar`, `connect`, `errorMessage`, the unit helpers, the constants, the error
classes, the low-level chain and price clients) are exported flat from the package. The full list is in
the [API Index](../reference/api.md).

## Prepared Calls: Simulate, Then Send

The SDK never sends anything and never holds a key. Every builder (`trade.createOrder`,
`trade.depositCollateral`, `allowance.approveUsdc`, `insurance.depositToInsurance`, ...) returns a
`PreparedCall`, for any contract:

```ts
{{#include ../../examples/getting-started/concepts.ts:prepared}}
```

| Field | Meaning |
|---|---|
| `action` | The contract function, such as `"createOrder"`. |
| `to`, `data` | The contract and the calldata. |
| `value` | ETH to send, in wei: the Pyth update fee when the call carries a price, else 0. |
| `from` | The account the call acts for (the sender of a direct call), or `null` when unknown. |
| `summary` | One line for a confirmation screen, with every amount printed exactly. |
| `priceTime` | Present when the call carries a Pyth update: the update's publish time, in Unix seconds. |
| `pullsUsdc` | Present when known: the USDC the call takes from the wallet, in 18 decimals. |

The flow is the same for every write:

1. **Build.** The builder checks its inputs against what it can read (the account's orders and
   position, the book, the live price) and throws an `InputError` naming the field for anything the
   contract would refuse. Before naming a market it asks the factory whether that address is one of
   its pairs (`requirePair`), so an address from a link cannot pass off another contract as a market.
2. **Simulate**, as the user: `bz.simulate(call)` runs it with `eth_call` and estimates its gas. A
   revert comes back decoded, with a sentence for the user, before the wallet is asked anything.
3. **Show** the `summary`, and what the call costs: `value`, `pullsUsdc`.
4. **Send** with the user's wallet: `bz.send(wallet, call)` over any EIP-1193 provider, or
   `toTransactionRequest(call)` for a viem or wagmi client, or a bot's own key.
5. **Wait**: `bz.waitForReceipt(hash)` throws a `CallError` if the transaction reverted.

Signatures follow the same principle: gasless requests and USDC permits are typed data the SDK asks
the wallet to sign with `eth_signTypedData_v4`, so the wallet shows the user every field, and the
SDK checks that the signature recovers to the signer before it uses it. See
[Sending Transactions](../sdk/sending.md) and [Gasless Trading & Relayers](../sdk/gasless.md).

## Units

One rule covers the whole SDK:

- **Protocol quantities are `bigint`**: prices, sizes, notionals, collateral, fees, rewards, funding
  indices and rates, scores, basis-point rates.
- **Amounts are in 18 decimals** ("BAZAAR precision"): `1e18` is $1, or one unit of the traded asset.
  `parseUnits18("12.5")` and `formatUnits18(x, 2)` convert to and from text.
- **USDC's own calls are in 6 decimals**, as the token counts: wallet balances and allowances
  (`wallet.usdcBalance`, `usdcFunding`, `approveUsdc`) and permits. The pair floors what it moves to
  whole micro-USDC. Convert with `toUsdcUnits`, `toUsdcUnitsCeil` (for an allowance that must cover a
  pull) and `fromUsdcUnits`. A name says USDC when it is in 6 decimals.
- **Times, blocks, counts and enum values are `number`**: Unix seconds, block numbers, order types.
  The one exception is an order spec's `expirationBlock`, a `bigint` because a take-profit or
  stop-loss carries 2^64 − 1 ("never"), which a `number` cannot hold. Order inputs accept either.
- **Ratios for display are `number`**: a margin ratio, a leverage, a confidence in basis points.

```ts
{{#include ../../examples/getting-started/concepts.ts:units}}
```

Every conversion and constant is on [Units & Constants](../reference/units.md).

## Price Updates and the 3-Second Window

Bazaar prices every market from Pyth. A call that needs the price (creating or amending an order,
firing a trigger, a withdrawal with a position, an insurance exit, liquidations) carries a signed
Pyth Pro update in its calldata, and the pair accepts a price generated at most 3 seconds from the
block's time (`MAX_PRICE_STALENESS`). The pair has the attached update verified and uses its price; a
call that carries none runs on the pair's own stored price while that is at most 3 seconds old, and
otherwise reverts (or, on a market with trading hours, runs on its stored price where that call allows
it). A liquidation without an update never runs on a stored price older than 3 seconds: on a market with trading hours it
carries Pyth's latest update instead, issued within 3 seconds of the block, whose price may be up to a
minute old ([Sending Transactions](../sdk/sending.md#preparedcall)). See
[Oracle](https://docs.bazaar.finance/protocol/oracle.html).

What this means in code:

- Builders that attach a price need a price source on the connection (`prices`); without one they
  throw a `ConnectError`.
- `call.value` is the fee Pyth charges to verify the update; the pair refunds what it does not spend.
- `call.priceTime` is the print's publish time. The clock starts when the call is built: build right
  before sending, and rebuild a call whose print is more than a second or two old.
- A human approving in a wallet can be slower than 3 seconds; on a quiet market such a call may revert
  on chain. Gasless calls avoid this: the relayer attaches the price when it submits.

Reads are different: they never need a print to be fresh. A market snapshot reports the pair's stored
price and its age; an account snapshot values the position at the freshest price it can get (the
caller's, a live stream's, one Pyth Pro request, or the stored one) and says which (`price.source`).
[Live Prices](../sdk/live-prices.md) streams the composed price of every market with a `fresh` flag.

## User-Facing Errors

Failures come in a few shapes, and `errorMessage(e)` turns any of them into one sentence for the
user:

| Error | When | What it carries |
|---|---|---|
| `InputError` | A builder refused an input before building anything. | `field`, and a message prefixed with it ("size: Enter a size greater than zero."). |
| `DecodedError` | `simulate()` found a revert: `sim.error`. | The custom error's `name` and `args`, and `message`, a sentence for the user. Every custom error the contracts declare has one. |
| `CallError` | A send was rejected or the transaction reverted. | `message`, and `decoded` when the revert could be decoded. |
| wallet errors | The user declined, the wallet is on another network, has no ETH for gas, ... | `errorMessage` recognizes the EIP-1193 codes and viem's and ethers' error shapes. |
| `ConnectError` | A connection problem: the wrong chain, not a factory, a missing price source or subgraph. | A message for the developer. |
| `ProError`, `SubgraphError`, `HttpError`, `RpcError` | An endpoint failed. | A message with any token, and any URL's key, masked. |

```ts
{{#include ../../examples/getting-started/concepts.ts:errors}}
```

`errorMessage` falls back to "Something went wrong. Please try again." for anything it does not
recognize (a `ConnectError`, an endpoint failure, a `UnitError` from parsing a number), and never
shows a raw URL. Log the error itself for the detail. See [Errors & Messages](../sdk/errors.md).

## Browser Safety

The SDK is written to run in a page an attacker can link to and feed data:

- **No secrets in the bundle.** A Pyth Pro API key or a subgraph key in browser code is public. Give
  `prices` short-lived tokens your backend mints from the key (see
  [Connecting](../sdk/connecting.md#tokens-for-a-browser)), or leave prices to a relayer.
- **Only Pyth's signature counts.** Prices are read from the signed update itself, and a connection
  refuses updates not signed by a signer the deployment's Pyth verifier trusts.
- **Keys are masked.** Every error and display string built from an RPC, price or subgraph URL masks
  the parts that may be a key (`redactUrl`), and a Pyth Pro token never appears in one.
- **Untrusted addresses are checked.** Every builder confirms a pair with the factory
  (`requirePair`) before building a call, an approval, a permit or a gasless request for it.
- **Untrusted text stays text.** Market descriptions and proposal texts come from the chain or the
  subgraph: render them as text, never as HTML. Market labels come from Pyth's feed symbols, never
  from a description.
- **Approvals are exact** unless you ask for unlimited ones explicitly.
- **Signatures are checked.** A signature that does not recover to the signer (a smart-contract
  wallet signing through ERC-1271, say) is refused before use, since the pair would act for whatever
  address it recovers.
- **Clocks are checked.** Deadlines for permits and gasless requests are counted from the lower of
  the latest block's time and this device's clock, and the SDK refuses to ask for a signature
  (`ClockSkewError`) when the two differ by more than two minutes (local development chains excepted).

More in [Security Notes for Integrators](../reference/security.md).

## What Is Cached

The SDK reads the chain when you ask and keeps very little. What it keeps, it keeps per connection
(per context object), except where noted:

| What | Kept | Refreshed |
|---|---|---|
| The market list and each market's static facts (pair id, feeds, calendar, label) | Per connection, after the first `listMarkets` | `listMarkets({ refresh: true })`; `getMarket` refreshes once by itself for a name it does not know. Static facts never change. |
| A pair's Pyth feeds | Per connection | Never (they cannot change); a failed read is not kept. |
| "This address is one of the factory's pairs" | Per connection | A refusal or a failed read is not kept, so a pair listed later is asked again. |
| Pyth feed metadata (symbols, about 1 MB) | Per endpoint, for the whole page or process | A failed fetch is not kept. |
| Whether the node supports state overrides, and whether Multicall3 exists | Per `Chain` | Re-detected if a node behind a load balancer stops honoring overrides. |

Nothing else is cached. Snapshots, books, portfolios, nonces, balances and allowances are read fresh
on every call, at one block, and returned as plain objects your UI can keep. A `LivePrices` stream
holds the latest print per feed in memory, and a watcher holds the last snapshots it delivered; both
are released when you stop them.

## Next

- [Connecting](../sdk/connecting.md): every connection option.
- [Markets](../sdk/markets.md) and [Accounts & Portfolios](../sdk/accounts.md): what reads return.
- [Sending Transactions](../sdk/sending.md): the write path in depth.
