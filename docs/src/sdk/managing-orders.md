# Managing Orders

Once an order is placed, a trader can read it back, amend it in place, cancel it, fire it themselves if
it is a trigger order, and collect what the pair owes them. Each of these is a builder on `bz.trade`
that returns a [`PreparedCall`](sending.md#preparedcall).

The samples assume `bz` connected as in [Connecting](connecting.md) with a price source, `user` the
wallet's address, `eth` a market, and a `run(call)` helper that simulates, sends and waits as on
[Sending Transactions](sending.md). The protocol's rules are in
[Orders](https://docs.bazaar.finance/protocol/orders.html) (Amending, Cancellation & cleanup).

## Reading an Account's Orders

`bz.account.accountSnapshot(market, user)` returns the account on one market, including every live
order, decoded ([Accounts & Portfolios](accounts.md) has the whole snapshot):

```ts
{{#include ../../examples/trading/managing-orders.ts:read}}
```

`snap.orders` lists the live orders in the account's active set (Limit GTC and StopLimit), then the
attached TakeProfit and StopLoss. Each is an `AccountOrder`:

| Field | Meaning |
|---|---|
| `orderId` | The order's id on the pair (`bigint`). |
| `orderType`, `typeName` | `0` to `4`, and `"Market"`, `"Limit"`, `"StopLimit"`, `"TakeProfit"` or `"StopLoss"`. |
| `isLong`, `isPostOnly`, `tif` | As created (`tif`: 0 GTC, 1 IOC, 2 FOK). |
| `size`, `filled`, `remaining` | Total size, the part filled, and what is left (for a TP/SL, capped at the position it closes). |
| `limitPrice`, `triggerPrice` | The limit, and the trigger price for trigger types (0 for the others). |
| `bounty` | What the keeper bounty escrow still holds for the order. |
| `maxSlippageBp` | As created. |
| `expiryBlock`, `neverExpires`, `blocksLeft` | The expiry block, whether it never expires (TP/SL), and blocks until it expires (`null` when it never does). |
| `inBook` | Resting in the book: a Limit, or a StopLimit that has armed. A trigger order still waiting is `false`. |
| `closesWholePosition` | A TP/SL sized to close whatever the position is when it fires. |
| `attached` | `"takeProfit"` or `"stopLoss"` for the position's attached orders, else `null`. |
| `integrator` | The integrator the order names. |
| `record` | The order as the pair stores it (`pair.orders(id)`, decoded). |

Other reads:

- `bz.orders.readOrderState(pair, user)`: just the position and the order slots (the live Limit +
  StopLimit ids and the attached TP and SL ids), in one batched read. The order form's checks use it
  ([Placing Orders](orders.md#validating-as-the-user-types)).
- `bz.orders.readTriggerBounty(pair, orderId)`: what one order's bounty escrow holds.
- `bz.live.watchAccount(user, markets, onUpdate)`: a snapshot after every event that touches the
  account, plus the events themselves (`OrderUpdated`, `OrderAmended`, `OrderAmendSkipped`, `Trade`,
  ...). See [Live Updates](live-updates.md).
- `bz.history.orders({ account })` and `bz.history.orderEvents(...)`: past orders and their lifecycle
  from the subgraph. See [History](history.md).

## Amending

`bz.trade.amendOrders(pair, from, amends)` changes resting Limit (GTC) orders in place: each gets a new
price and a new total size, and keeps its id, expiry and integrator.

```ts
{{#include ../../examples/trading/managing-orders.ts:amend-one}}
```

Each amendment is an `AmendInput`:

| Field | Meaning |
|---|---|
| `orderId` | One of `from`'s resting Limit GTC orders. |
| `limitPrice` | The new limit price, BAZAAR precision. |
| `size` | The new **total** size, the filled part included: it must exceed what has filled. |
| `pred` | Optional: the order to rest directly behind at the new price (0 = none). Found for you when both hints are omitted. |
| `pred2` | Optional: a second candidate, tried when the first has left the book. |
| `bestEffort` | Skip this amendment instead of reverting the whole batch when the order has filled, been canceled or expired, the size is at or below what filled or leaves under $5, or the new price would cross. Default false. |

How an amendment moves the order: a new price, or a larger size, sends it to the back of its new price
level; a smaller size at the same price keeps its place. Up to 32 amendments per call
(`MAX_AMENDS_PER_CALL`, the same as the active-order cap, so one call can requote every order). The
same order may appear more than once; each amendment applies in turn. Margin is judged once, on the set
of orders the batch leaves. A batch is all or nothing, except for best-effort amendments, which the
pair skips and reports with `OrderAmendSkipped` (reason `Inactive`, `Expired`, `SizeFilled`,
`BelowMinimum` or `WouldCross`).

```ts
{{#include ../../examples/trading/managing-orders.ts:amend-batch}}
```

What the builder checks first, as the pair's `_amendOne` will, throwing `InputError`:

- the order exists, is `from`'s, and is a Limit GTC ("only those can be amended. Cancel it and place a
  new one.");
- it is still open and unexpired (not raised for a best-effort amendment);
- the new price is within ±50% of the oracle price;
- the new size exceeds what has filled, and what is left to fill is worth at least $5 (or is the whole
  position) (not raised for best effort);
- the new price does not cross the best order on the other side ("Place a new order to trade now."),
  unless that order is itself moved earlier in the same batch (not raised for best effort);
- a move (new price or larger size) needs about a minute of life left (the minimum lifetime plus the
  SDK's 40-block margin): "expires too soon to be moved. Cancel it and place a new one."

Amendments are checked in order, each against the order as the earlier ones left it, so order them so
no step crosses: when requoting upward, move the asks before the bids, as the sample does.

**Hints are part of the amendment.** Unlike an order's `MatchHints`, an amendment's hints are packed
into its id word (`orders.amendIdWord(orderId, pred, pred2, bestEffort)`: the id in bits 0 to 63, the
hints in bits 64 to 191, the best-effort flag in bit 192), and the flat word array is what a gasless
`AmendOrders` request signs. For a gasless amendment the hints are fixed when the user signs; a relayer
cannot refresh them. `orders.encodeAmends(amends)` and `orders.decodeAmends(words)` convert between
`AmendInput[]` and the flat array (one triple of id word, price and size per amendment).

`amendOrders` always carries a price update (the placement band and margin are judged at a fresh
price), so it needs a price source and should be sent promptly.

`bz.trade.prepareAmends(pair, owner, amends)` runs the same checks and fills in hints without building
a call:

```ts
{{#include ../../examples/trading/managing-orders.ts:prepare-amends}}
```

It returns `{ amends, words, price, currentBlock }`: the amendments with hints, the flat words, and the
price and block they were checked at.

## Canceling

`bz.trade.cancelOrders(pair, from, orderIds)` cancels up to 200 of `from`'s orders in one call
(`MAX_CANCELS_PER_CALL`). Each is unlinked from the book in the same transaction, and any keeper bounty
it still holds returns to `from`'s claimable balance. There is no margin check and no price update.

```ts
{{#include ../../examples/trading/managing-orders.ts:cancel}}
```

The builder refuses the following (`trade.checkCancelIds(ids)` runs the list checks alone, with no
reads):

- an empty list, more than 200 ids, a duplicate, or a non-positive id;
- an order that does not exist or is not `from`'s;
- an order that has already ended (filled, expired, auto-canceled) and holds no bounty: "Order #12 is
  already closed." or "... has already expired.".

An order that has ended but still holds a bounty in escrow can be "canceled" to reclaim it; the summary
then says so (`Cancel order #12 (reclaiming its bounty)`).

## Firing Your Own Trigger Orders

A trigger order with no bounty attracts no keeper, so its owner fires it.
`bz.trade.executeTriggeredOrders(pair, from, orderIds)` executes up to 20 of `from`'s own StopLimit,
TakeProfit and StopLoss orders (`MAX_TRIGGER_EXECS_PER_CALL`) against a fresh price:

```ts
{{#include ../../examples/trading/managing-orders.ts:execute}}
```

Each order must be `from`'s, a trigger type, live, and still waiting outside the book (a StopLimit
that has already armed is resting and refused). The builder reads the price the call will carry and
refuses an order whose trigger it has not reached ("Order #7's trigger (2700) has not been reached; the
price is 2750."); `triggerReached(orderType, isLong, triggerPrice, price)` is the same test, exported
for a UI. A StopLimit gets a hint for the slot it will rest in. On chain the pair evaluates each trigger
against the price the call carries and skips, without reverting, any that is not eligible then. An
execution of your own order pays its bounty share to you.

Watching for the moment a trigger is reached is a job for live prices: subscribe to the market
([Live Prices](live-prices.md)) and build the call when `triggerReached` turns true.

## Claiming Fees

`bz.trade.claimFees(pair, from)` pays `from` everything the pair owes it: refunded trigger bounties,
keeper rewards, relayer fees and integrator fees. It works in any pair state and has no gasless form:
the caller pays the gas.

```ts
{{#include ../../examples/trading/managing-orders.ts:claim}}
```

The builder reads the claimable amount from the lens first and refuses when it is zero (`InputError`
on `pair`: "You have nothing to claim on this market."); the summary names the amount. Balances are per
pair: `snap.claimableFees` for one market, `bz.account.portfolio(user)` totals them across markets.
`CollateralLib__ClaimTransferFailed` means USDC refused the transfer (the address cannot receive USDC).

## What Can Go Wrong

| You see | It means |
|---|---|
| `InputError` on `orderId`: "Order #42 is not a resting limit order ..." | Only Limit GTC orders can be amended. Cancel and place a new one. |
| `InputError` on `limitPrice`: "... would cross the book (best ask 3001.5). Place a new order to trade now." | An amendment cannot take liquidity. |
| `InputError` on `orderId`: "Order #42 expires too soon to be moved." | Less than about a minute of life left. |
| `InputError` on `amends`: "At most 32 orders can be amended at once." | Split the batch. |
| `InputError` on `orderIds`: "Order #12 is already closed." | Nothing left to cancel or reclaim. |
| `InputError` on `orderIds`: "Order #7's trigger ... has not been reached" | The price has not met the trigger yet. |
| `OrderManagementLib__...` from the simulation | The pair's own refusal; the message says what to change. |

## Related Pages

- [Placing Orders](orders.md): the order types and their options.
- [Previews](previews.md): what an order will do before it is placed.
- [Live Updates](live-updates.md): order events as they happen.
- [Gasless Trading & Relayers](gasless.md): cancel and amend without ETH.
