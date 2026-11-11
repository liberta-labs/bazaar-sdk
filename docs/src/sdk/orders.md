# Placing Orders

`bz.trade.createOrder` builds every kind of order Bazaar has: Market, Limit, StopLimit, TakeProfit and
StopLoss. It checks the order the way the pair will (so the user sees a clear error before signing),
finds the order's place in the book, attaches a fresh Pyth price, and returns a
[`PreparedCall`](sending.md#preparedcall) to simulate and send.

This page shows each order type with a sample, then every option: time in force, post-only, slippage,
expiry, keeper bounties, the integrator fee and book hints, and the pure helpers a form uses to
validate as the user types. The rules themselves are the protocol's; this page states what the SDK
checks and links [Orders](https://docs.bazaar.finance/protocol/orders.html) for the full rules.

The samples assume `bz` connected as in [Connecting](connecting.md) with a price source, `user` the
wallet's address, `eth` a market, `block` the current block number, and
`const { TimeInForce, blocksIn, CLOSE_POSITION } = orders` (the `orders` namespace of
`@liberta-labs/bazaar-sdk`). Sending is as on [Sending Transactions](sending.md).

## How createOrder Works

`bz.trade.createOrder(pair, from, order, opts?)`:

1. Checks the order's shape (`buildOrderSpec` without any reads) and that `pair` is one of the
   deployment's pairs. Either failure throws `InputError` naming the field.
2. In parallel: fetches a fresh price update for the pair, reads the current block, the account's
   position and order slots (`readOrderState`), and, for an order that can rest, the order it should
   rest behind (its hint).
3. Checks the order again against what it read: the Limit placement band around the price, the $5
   minimum, the expiry against the current block, the TP/SL rules and the per-account caps.
4. Returns the call: `summary` is `describeOrder(spec)`, `priceTime` the update's publish time,
   `value` its Pyth fee, and `pullsUsdc` the keeper bounty a trigger order takes from the wallet (`0n`
   for the other types).

On chain the order is matched against the book in the same transaction: it fills whatever crosses, at
each resting maker's price, then rests the remainder (a Limit GTC, or an armed StopLimit) or cancels it
(Market, IOC, a post-only order that would cross, a self-match, the walk budget, a dust remainder). A
fill-or-kill order reverts unless it fills completely. A trigger order waits outside the book for its
trigger, or arms in the same transaction if the price already meets it.

`createOrder` needs a price source on the connection: without one it throws `ConnectError` ("this call
needs a fresh Pyth price"). Because the call carries a price update, send it within seconds of building
it; see [The 3-Second Price Window](sending.md#the-3-second-price-window).

| Option (`opts`) | Meaning |
|---|---|
| `hints` | `MatchHints` to use instead of the ones the SDK finds. See [Book Hints](#book-hints). |
| `maxSteps` | The arrival walk's budget: how many resting orders it may visit (1 to 32; 0, the default, is the protocol default of 32). Ignored when `hints` is given (hints carry their own `maxSteps`). |
| `permitData` | A USDC permit covering the trigger bounty, executed before the pull. See [Keeper Bounties](#keeper-bounties). |

## The Order

`order` is an `OrderInput`. Fields a type does not use are ignored for it, and written as zero in the
signed spec.

| Field | Types | Meaning |
|---|---|---|
| `orderType` | all | `OrderType.Market`, `.Limit`, `.StopLimit`, `.TakeProfit` or `.StopLoss` (0 to 4). |
| `isLong` | all | `true` buys (goes long or reduces a short), `false` sells. |
| `size` | all | Base units, BAZAAR precision (`parseUnits18("0.5")` is half a unit). For a TakeProfit or StopLoss, `CLOSE_POSITION` closes the whole position. |
| `limitPrice` | Limit, StopLimit | The price the order fills at or better, BAZAAR precision. |
| `triggerPrice` | StopLimit, TakeProfit, StopLoss | The oracle price that fires the order (the price alone; the bounty is its own field). |
| `bounty` | StopLimit, TakeProfit, StopLoss | What the order pays whoever fires it, BAZAAR precision, a whole number of micro-USDC. Default 0. |
| `maxSlippageBp` | Market, TakeProfit, StopLoss | The worst fill allowed, in basis points of the oracle price: 1 to 1000 (0.01% to 10%). Required for these types. |
| `tif` | Limit, Market | `TimeInForce.GTC` (default), `.IOC` or `.FOK`. |
| `isPostOnly` | Limit GTC | Cancel instead of taking liquidity. Default false. |
| `expirationBlock` | Limit GTC, StopLimit | The absolute L2 block the order expires after. Required for these. |

Prices and sizes are BAZAAR precision: `1e18` is one unit of the base asset, or $1. See
[Units & Constants](../reference/units.md).

## Market Orders

A Market order fills immediately against the book, at each maker's price, within `maxSlippageBp` of
the oracle price; what cannot fill within that bound is canceled. It never rests.

```ts
{{#include ../../examples/trading/orders.ts:market}}
```

With `tif: TimeInForce.FOK` it is all or nothing: the transaction reverts
(`MatchingEngineLib__FillOrKillUnfilled`) unless the whole size fills, and the gas is spent either way.

```ts
{{#include ../../examples/trading/orders.ts:market-fok}}
```

The pair refuses Market orders while a market with trading hours has its venue closed (it would have
only a stale price to bound them by); Limit orders still work then. The market snapshot's
`marketOrdersDisabled` flag says so, with a reason ([Markets](markets.md)).

## Limit Orders

A Limit order fills what crosses at its limit price or better, then rests the remainder in the book
until it fills, is canceled, or expires.

```ts
{{#include ../../examples/trading/orders.ts:limit}}
```

Its limit price must sit within ±50% of the oracle price (`MAX_PLACEMENT_DEVIATION_BP`): the builder
checks it against the live price and names the allowed range. A resting Limit takes one of the
account's 32 order slots.

With `tif: TimeInForce.IOC` it takes what is available now and cancels the rest; it never rests, needs
no expiry, and takes no slot:

```ts
{{#include ../../examples/trading/orders.ts:limit-ioc}}
```

`TimeInForce.FOK` on a Limit fills the whole size at the limit or better, or reverts.

### Post-Only

`isPostOnly: true` makes a Limit GTC a maker-only order: if any part of it would cross the book on
arrival, it is canceled (cancel reason `PostOnly`) instead of filling. Only Limit orders take it, and
only with GTC.

```ts
{{#include ../../examples/trading/orders.ts:post-only}}
```

## Stop-Limit Orders

A StopLimit waits outside the book until the oracle price reaches `triggerPrice`, then becomes a Limit
order at `limitPrice`: it fills what crosses and rests the remainder. A buy's limit must be at or above
its trigger, a sell's at or below (otherwise it could never fill there). It carries an expiry and takes
an order slot from creation, and may carry a keeper bounty.

```ts
{{#include ../../examples/trading/orders.ts:stop-limit}}
```

A StopLimit that fires with less than the minimum lifetime left does not rest; give it a long enough
expiry to rest when it fires.

## Take-Profit and Stop-Loss Orders

A TakeProfit fires when the price moves in the position's favor, a StopLoss when it moves against it.
On firing either executes market-style within `maxSlippageBp` of the oracle price; it never rests in
the book, and a part the book cannot fill stays live outside the book for the next execution.

| Position | Order side | StopLoss fires when | TakeProfit fires when |
|---|---|---|---|
| Long | sell (`isLong: false`) | price ≤ trigger | price ≥ trigger |
| Short | buy (`isLong: true`) | price ≥ trigger | price ≤ trigger |

```ts
{{#include ../../examples/trading/orders.ts:take-profit}}
```

```ts
{{#include ../../examples/trading/orders.ts:stop-loss}}
```

What the SDK checks for them:

- **They need an open position, and must be on its opposite side.** Otherwise `InputError` on
  `orderType` ("... need an open position") or on `isLong`.
- **One of each per position.** A second TakeProfit or StopLoss is refused (`checkOrderCaps`); cancel
  the existing one first.
- **`CLOSE_POSITION` closes the whole position, whatever it is when the order fires.** The size is
  capped at the live position when the order fires, so any size at or above it closes exactly the
  position and never opens the other side. A position that later shrinks leaves the order armed for
  what remains; one that goes flat or flips cancels it (cancel reason `PositionClosed`). The $5 minimum
  is measured on what the order could close, so a full close is always allowed.
- **They never expire** (`expirationBlock` is ignored and stamped `NEVER_EXPIRE_BLOCK`), take no order
  slot, and skip the creation margin check: a protective order is never refused for margin.

`describeOrder` prints a `CLOSE_POSITION` size as "the whole position".

## Time in Force

| `tif` | What happens to the size the book cannot fill on arrival | Accepted on |
|---|---|---|
| `TimeInForce.GTC` (0, default) | Rests in the book. | Every type; the types that never rest ignore it. |
| `TimeInForce.IOC` (1) | Canceled; the partial fill stands. | Limit. |
| `TimeInForce.FOK` (2) | The transaction reverts: no fill, no order. | Limit and Market. |

Post-only cannot be combined with IOC or FOK. `orders.TIF_NAMES` maps the values to "GTC", "IOC" and
"FOK".

## Slippage

`maxSlippageBp` bounds how far from the oracle price a Market, TakeProfit or StopLoss may fill: a buy
fills at most at `oracle × (1 + bp/10000)`, a sell at least at `oracle × (1 − bp/10000)`. It must be 1
to 1000 (`orders.MAX_SLIPPAGE_BP`, 10%); anything else is `InputError` on `maxSlippageBp` ("Set a
slippage limit between 0.01% and 10%."). Limit and StopLimit orders are bounded by their limit price
instead and ignore it.

## Expiry Blocks

Orders that can rest (Limit GTC and StopLimit) expire after an absolute Arbitrum L2 block. Arbitrum
produces about four L2 blocks a second (`orders.L2_BLOCKS_PER_SECOND`), and `orders.blocksIn(seconds)`
converts a duration:

```ts
const expirationBlock = (await bz.ctx.chain.blockNumber()) + orders.blocksIn(24 * 60 * 60); // about a day
```

| Constant | Value | Meaning |
|---|---|---|
| `MIN_ORDER_LIFETIME_BLOCKS` | 240 | The shortest life the pair accepts (~1 minute). |
| `EXPIRY_LANDING_MARGIN_BLOCKS` | 40 | Slack the SDK adds on top: the pair measures the lifetime from the block the transaction lands in. |
| `MAX_ORDER_LIFETIME_BLOCKS` | 126,144,000 | ~1 year. A later expiry is clamped to it by the pair. |
| `NEVER_EXPIRE_BLOCK` | `2^64 − 1` | What the pair stamps on TakeProfit and StopLoss orders. |

So the builder refuses an expiry before `currentBlock + 280` ("An order must stay open for at least
about a minute."). Market, IOC and FOK orders end within their own transaction and get expiry 0.
`bz.orders.readOrderLifetimeConstants()` reads the lifetime constants from the lens, to confirm the
SDK's copies. Amending an order keeps its expiry, and an order with less than about a minute left
cannot be moved ([Managing Orders](managing-orders.md#amending)).

## Keeper Bounties

A trigger order (StopLimit, TakeProfit, StopLoss) waits until someone fires it with a fresh price
through `executeTriggeredOrders`. Keepers do that for the bounty the order carries.

- **Funding.** The bounty is pulled from the **wallet** (not collateral) when the order is created, so
  `createOrder` reports it in `pullsUsdc`, and the wallet needs that much USDC allowed to the pair, or a
  permit in `opts.permitData`:

```ts
{{#include ../../examples/trading/orders.ts:bounty-funding}}
```

- **Units.** BAZAAR precision and a whole number of micro-USDC (a multiple of `1e12`); otherwise
  `InputError` on `bounty` ("The bounty must be a whole amount of USDC (at most 6 decimals)."). Only
  trigger types may carry one.
- **Packing.** In the signed spec the bounty rides in the high 128 bits of `triggerPrice`:
  `orders.packTriggerPrice(price, bounty)` is `(bounty << 128) | price`, `orders.unpackTriggerPrice(word)`
  splits it, and `orders.specBounty(spec)` reads it from a spec. `buildOrderSpec` packs it for you.
- **Escrow.** Once created, the bounty sits in the pair's fee escrow, not in the order: an order read
  back from the pair (`orders(id)`, `OrderUpdated`) carries only the trigger price.
  `bz.orders.readTriggerBounty(pair, orderId)` returns what the escrow still holds. Each execution pays
  its executor the share of the bounty it filled; what is left when the order is canceled, expires or is
  auto-canceled returns to the owner's claimable balance, collected with
  [`claimFees`](managing-orders.md#claiming-fees).
- **Firing your own.** A bounty of 0 means the owner fires the order: build
  [`executeTriggeredOrders`](managing-orders.md#firing-your-own-trigger-orders) when the price reaches
  the trigger. An execution of your own order pays its bounty share to you, and so does the creation
  itself when a fresh price already meets the trigger.

How keepers choose which orders to fire is on [The Jobs](../keeper/jobs.md).

## The Integrator Fee

An order can name an integrator address, which earns a referral fee of 0.25 bp of each fill's notional
from the side that carries it (both sides when both orders carry it), less the 1% bug-bounty skim. The
SDK writes the connection's `integrator` into every order it builds:

```ts
{{#include ../../examples/trading/orders.ts:integrator}}
```

It is part of the signed spec and cannot change after creation. The fees accrue to the integrator's
claimable balance on each pair, withdrawn with `claimFees` from the integrator's address. Without an
`integrator` on the connection, orders carry the zero address and pay no integrator fee. The fee is a
surcharge on your users' fills, so it is your decision; see
[Integrators](https://docs.bazaar.finance/guide/integrators.html) and
[Fees](https://docs.bazaar.finance/protocol/fees.html).

## Book Hints

A resting order is inserted into a sorted book. Rather than walk the book on chain, the call carries
`MatchHints`: `pred`, the order the new one should rest directly behind (0 = the head of its side), and
fallbacks `pred2` to `pred4` tried when earlier ones have left the book, plus `maxSteps`, the arrival
walk's budget. Every hint is verified against the real neighbors, so a wrong one can fail a placement
but never misplace an order. Hints are outside every signature.

`createOrder` finds them for you (`bz.trade.matchHintsFor(pair, order, maxSteps?)`): for an order that
can rest, the predecessor at its limit price on its side (`bz.trade.findPredecessor(pair, isLong,
limitPrice)`, which follows the lens's `findPredecessor` through up to 8 pages of 64 orders); for one
that cannot, `NO_HINTS`. Pass your own when you have them:

```ts
{{#include ../../examples/trading/orders.ts:hints}}
```

Hints go stale as the book changes, so compute them right before sending, as `createOrder` does. A
relayed order always walks the protocol default, since only its signer may bound how much of it
executes.

## Validating as the User Types

`orders.buildOrderSpec(input, integrator, env?)` is pure: it checks an `OrderInput` the way the pair's
`createOrder` will and returns the `OrderSpec` to send or sign, or throws `InputError` naming the field.
Run it on every change in an order form:

```ts
{{#include ../../examples/trading/orders.ts:validate}}
```

`InputError.message` is prefixed with the field (`"size: Enter a size greater than zero."`); the sample
strips the prefix to show the sentence next to the field.

`env` is an `OrderEnvironment`; every field is optional, and a check that needs a missing one is
skipped:

| Field | Used for |
|---|---|
| `currentBlock` | The expiry against the minimum lifetime. |
| `price` | The Limit placement band, and a Market order's notional. Take it from live prices ([Live Prices](live-prices.md)) or `bz.trade.livePairPrice(pair)`. |
| `account` | The TP/SL rules and the caps. `bz.orders.readOrderState(pair, user)` reads it in one batch: the position, the live Limit + StopLimit order ids, and the attached TP and SL ids. |

What it refuses, with the field named:

- a missing or zero size or price, or one too large for the order's 128-bit fields;
- a time in force or post-only flag the type does not take (IOC on a non-Limit, FOK on a trigger type,
  post-only with IOC or FOK or on a non-Limit);
- a StopLimit's limit on the wrong side of its trigger;
- a slippage outside 1 to 1000 bp on a Market, TakeProfit or StopLoss;
- a bounty on a type that cannot carry one, a negative one, or one that is not whole micro-USDC;
- a Limit price outside ±50% of `env.price`;
- a notional under $5 that is not a full close (measured at the limit price, else the trigger price,
  else `env.price` for a Market; for a TP/SL on what it could close);
- a missing expiry on a Limit GTC or StopLimit, or one under the minimum lifetime from `env.currentBlock`;
- a TP/SL with no position, or on the position's own side;
- the caps below.

The chain still decides: the creation margin check, the book and the price at landing are not in
`buildOrderSpec`. Simulate, or preview with [`previewOrder`](previews.md), for those.

Two related helpers: `orders.validateOrderSpec(spec, env?)` checks a spec built elsewhere (a relayer
uses it on a signed order) and also refuses bounty bits on a non-trigger type, and
`orders.orderInputFromSpec(spec)` turns a spec back into an `OrderInput`. `bz.trade.prepareOrder(pair,
owner, order, opts?)` runs the full check against the chain without building a call, for the gasless
path ([Gasless Trading & Relayers](gasless.md)); its `opts.integrator` overrides the connection's.

## Order Caps

`orders.checkOrderCaps(order, account)` throws `InputError` on `orderType` when the account is at a
per-account cap on the pair:

```ts
{{#include ../../examples/trading/orders.ts:caps}}
```

| Cap | Limit | Counts |
|---|---|---|
| Active orders | 32 per account per pair (`MAX_ACTIVE_LIMIT_ORDERS_PER_USER`) | Live Limit GTC and StopLimit orders. IOC and FOK limits and Market orders never rest, so they take no slot. |
| TakeProfit | 1 per position | |
| StopLoss | 1 per position | |

`buildOrderSpec` applies it whenever `env.account` is given. Disable the order types a user cannot
place rather than letting them fill in a form that will be refused.

## Describing an Order

`orders.describeOrder(spec)` is one line for a confirmation screen, and what `createOrder` puts in
`summary`. Every amount prints exactly (trailing zeros trimmed), never rounded: the size, the prices
and the bounty the user signs.

```ts
{{#include ../../examples/trading/orders.ts:describe}}
```

| Type | Example |
|---|---|
| Market | `Buy 0.5 at market (0.5% max slippage)`, with `, fill-or-kill` for FOK |
| Limit | `Buy 1 at 2950 (limit, GTC, post-only)` |
| StopLimit | `Buy 1 at 3210 once the price reaches 3200 (stop-limit, $0.25 keeper bounty)` |
| TakeProfit | `Take profit: sell the whole position when the price reaches 3600 (1% max slippage, $0.5 keeper bounty)` |
| StopLoss | `Stop loss: sell 0.5 when the price reaches 2700 (2% max slippage)` |

## What Can Go Wrong

| You see | It means |
|---|---|
| `InputError` on `limitPrice`: "A limit price must be within 50% of the market price: between ... and ..." | The Limit is outside the placement band around the live price. |
| `InputError` on `size`: "This order is worth $3; the minimum is $5 ..." | The notional is under $5 and the order is not a full close. |
| `InputError` on `expirationBlock`: "Choose when the order expires." / "... at least about a minute." | A resting order needs an expiry at least 280 blocks ahead. |
| `InputError` on `orderType`: "You already have 32 open limit and stop-limit orders ..." | The active-order cap. Cancel one first. |
| `ConnectError`: "this call needs a fresh Pyth price ..." | The connection has no `prices` source. |
| `OrderManagementLib__InsufficientMarginAfterOrder` (simulation) | The account's collateral does not cover the order's worst-case exposure. Deposit, or reduce the size. Preview the requirement with [`previewOrder`](previews.md). |
| `MatchingEngineLib__FillOrKillUnfilled` | A FOK order could not fill completely; nothing happened. |
| `MatchingEngineLib__BlockedOracleStale` | A Market order on a market whose venue is closed. Use a Limit order. |
| `BazaarPair__TradingHalted` | ADL, the settlement window or termination: nothing trades. |
| `Unknown(0x19abf40e)` | Pyth's `StalePrice`: the price update aged past 3 seconds before landing. Rebuild and send again. |
| An order that was placed but shows canceled | An auto-cancel: post-only, self-match, margin, walk budget or dust. The `OrderUpdated` event's `cancelReason` says which ([Live Updates](live-updates.md)). |

[Errors & Messages](errors.md) explains how to show all of these.

## Related Pages

- [Managing Orders](managing-orders.md): amend, cancel, fire your own triggers, claim fees.
- [Previews](previews.md): fills, fees, margin and the resulting position before sending.
- [Collateral, Approvals & Permits](collateral.md): funding the account and the bounty.
- [Orders](https://docs.bazaar.finance/protocol/orders.html) and
  [Matching](https://docs.bazaar.finance/protocol/matching.html) in Bazaar's docs: the rules.
