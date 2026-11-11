# History

`bz.history` reads Bazaar's subgraph: the trade tape and candles, an account's orders, positions and
cash movements, fees and keeper rewards, liquidations and ADL, insurance, terminations, governance and
listings. Use it for everything a UI shows about the past: a trade list, a chart, an order history with
the reason each order was canceled, a portfolio's realized PnL, an integrator's revenue.

Use the chain, not the subgraph, for anything you act on. The subgraph lags the chain by a few blocks
(more when its indexer is behind), and it does not index values the contracts do not emit: the mark
price, the insurance share price, the vault's inventory and an account's health at the live price come
from [Markets](markets.md) and [Accounts & Portfolios](accounts.md). For live events as they happen,
see [Live Updates](live-updates.md).

## Connecting a Subgraph

History needs a subgraph source on the connection. Pass a URL, `{ url, apiKey }`, or any object with a
`query(query, variables)` method:

```ts
{{#include ../../examples/advanced/history.ts:connect}}
```

Every function below is on `bz.history` with the connection bound, and on the `history` namespace with
the context as its first argument (`history.trades(bz.ctx, filter)`). Calling one on a connection made
without a subgraph throws `ConnectError` ("history comes from Bazaar's subgraph: connect with a subgraph
source").

With `{ url, apiKey }` the key is sent as `Authorization: Bearer <key>`. A key in a browser bundle is
visible to every user: in a frontend, point `subgraph` at a proxy that adds the key on your server (see
[Security Notes](../reference/security.md)).

### httpSubgraph

The URL forms build their source with `history.httpSubgraph(url, apiKey?, options?)`. Call it yourself
to set its options, then pass the result as `subgraph`:

```ts
{{#include ../../examples/advanced/history.ts:http-subgraph}}
```

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Per-request timeout in milliseconds. |
| `headers` | none | Extra request headers. |
| `fetch` | `globalThis.fetch` | The fetch to use (a test double, or one with a custom agent). |

Each query is a JSON POST of `{query, variables}`. The source works in browsers and in Node 20+. Its
errors never carry the raw URL: The Graph's gateway accepts the key in the URL path, so the URL is
redacted (see `redactUrl` in [Low-Level Building Blocks](low-level.md#urls)) in every message.

## Units

Results are converted to SDK units on the way out:

| Kind | Type | Notes |
|---|---|---|
| Prices, sizes, notionals, collateral, fees, PnL, shares, funding indices, bounties | `bigint` | BAZAAR precision: `1e18` is $1 or one unit. Format with `formatUnits18`. |
| Fields whose names end in `Usdc` (`seedRefundUsdc`, `seedRefundOwedUsdc`) | `bigint` | USDC units (6 decimals), as the subgraph stores them. |
| Rates whose names end in `Bp` (`imrBp`, `mmrBp`, `maxSlippageBp`, `levyBp`) | `bigint` | Basis points. |
| Payout ratios (`principalRatio`, `profitRatio`) | `bigint` | `1e18` is 100%. |
| Timestamps | `number` | Unix seconds. |
| Block numbers | `number` | Arbitrum L2 blocks: the numbers order expiry uses. |
| Counts | `number` | |
| Enums (order type, status, cancel reason, ...) | `string` | The contract enum's name, e.g. `"StopLoss"`, `"Canceled"`, `"Margin"`. |
| Addresses | `Address` | Checksummed. |
| Other bytes (ids, hashes, feed ids) | `Hex` | Lowercase. |

An order's `triggerPrice` is the trigger price alone: the contract stores the keeper bounty in the same
word, and the SDK masks it off (the bounty is reported in `bountyEscrowed`, `bountyHeld`,
`bountyPaidToKeepers` and `bountyRefunded`).

A field the subgraph returns empty where the type does not allow it throws `SubgraphError` ("the
subgraph returned no ..."); fields typed `| null` are null when the subgraph has no value.

## Pages

Every list returns a `Page<T>`:

```ts
interface Page<T> {
  readonly items: T[];
  readonly next: string | null; // the cursor for the following page; null at the end
}
```

Pass `page.next` back as `after`, with the same filters, to read the next page:

```ts
{{#include ../../examples/advanced/history.ts:tape}}
```

Every list takes these options:

| Option | Default | Meaning |
|---|---|---|
| `first` | `100` | Rows per page, 1 to 1000. Anything else throws `InputError`. |
| `after` | none | The `next` cursor of the previous page. A cursor from another list throws `InputError` ("is not a cursor this list returned"). |
| `atBlock` | the subgraph's head | Read the subgraph as of this block. Pin every page of a multi-page read to one block for a consistent snapshot. |

Lists ordered by time also take:

| Option | Default | Meaning |
|---|---|---|
| `from` | none | Inclusive lower bound on the list's time field, in Unix seconds. |
| `to` | none | Exclusive upper bound on the list's time field. |
| `order` | `"desc"` for event lists, `"asc"` for candles and day data | `"asc"` (oldest first) or `"desc"` (newest first). |

The time field is the list's order field: the event's `timestamp` for most lists, the period start for
candles, the day for day data, and the creation, submission or opening time where the table below says
so.

A cursor is the value of the order field on the page's last row. Lists ordered by `id` page with an
`id_gt` (or `id_lt`) filter; lists ordered by time page with a bound on the time and skip only the rows
that share the last time of the previous page, so a page never repeats or drops a row while new history
is appended at the head. Treat a cursor as opaque, and use it only with the list, filters and order that
produced it.

To read a whole range, follow `next` until it is null:

```ts
{{#include ../../examples/advanced/history.ts:all-pages}}
```

For a list that keeps growing while you page through it (open positions, say), pin every page to one
block. `subgraphLag().indexedBlock` is a block the subgraph has indexed:

```ts
{{#include ../../examples/advanced/history.ts:snapshot}}
```

An `atBlock` the subgraph has not indexed yet, or has pruned, is refused by the subgraph: that comes
back as `SubgraphError` ("the subgraph refused the query: ...").

## Market Data

| Function | Filters | Order | Returns |
|---|---|---|---|
| `trades(filter?)` | `pair`, `account` (as maker or taker), `maker`, `taker`, time options | newest first by `timestamp` | `Page<Trade>` |
| `candles(pair, interval, opts?)` | time options (bound the period start) | oldest first by `periodStart` | `Page<Candle>` |
| `pairDayData(pair, opts?)` | time options (bound the day) | oldest first by `date` | `Page<PairDayData>` |
| `protocolDayData(opts?)` | time options | oldest first by `date` | `Page<ProtocolDayData>` |
| `bookLevels(pair, { side, ...page })` | `side`: `"bid"` or `"ask"` | best price first | `Page<BookLevel>` |

**Trades.** One `Trade` per fill: `maker`, `taker`, `makerOrderId`, `takerOrderId`, `takerIsLong`,
`size`, `price` (the maker's limit price), `notional`, each side's fee (integrator and insurance legs
together), what each order had left after the fill, each side's integrator, and `txFrom` (the
transaction's sender). When the vault unloads liquidated inventory into a resting order, the fill names
the pair itself as `taker`, `isVaultFill` is true and `takerOrderId` is null; `txFrom` is then the
keeper that ran the unload. The `account` filter uses the subgraph's `or` filter, which needs
graph-node 0.30 or later.

**Candles.** `interval` is one of `history.CANDLE_INTERVALS`: `60`, `300`, `900`, `3600`, `14400` or
`86400` seconds. Any other value throws `InputError`. Each `Candle` has `open`, `high`, `low`, `close`,
`volumeSize`, `volumeNotional` and `tradeCount`. A period without fills has no candle; a chart expects
one, so pass the rows through `history.fillCandleGaps`:

```ts
{{#include ../../examples/advanced/history.ts:candles}}
```

`fillCandleGaps(rows, interval, from?, to?)` returns the candles from `from` (rounded down to the
period) to `to` (exclusive; by default the period after the last row), with each missing period filled
by a flat candle at the previous close and zero volume. It is a pure function: it needs no connection.
Periods before the first known candle stay empty, which is why the sample also reads the last candle
before the range. It throws `InputError` when `interval` is not a candle interval, when `from` or `to`
is not a whole non-negative number of seconds, when a row does not start on the interval's grid, or
when the span would take more than `history.MAX_FILLED_CANDLES` (100,000) candles: ask for a shorter
range or a longer interval.

**Day data.** `PairDayData` holds one UTC day of a pair: volume, trade count, maker and taker fees, the
day's open, high, low and close (null on a day without fills), liquidations, and, as of the day's last
update, open interest on each side, the funding index and insurance deposited and withdrawn.
`ProtocolDayData` holds the protocol's totals for the day, including `uniqueTraders`.

```ts
{{#include ../../examples/advanced/history.ts:day-data}}
```

**Book levels.** Aggregated resting size and order count per price on one side, bids high to low and
asks low to high. The subgraph counts resting orders whose expiry block has passed until a transaction
removes them, and it lags: for what an order would fill against now, read the book from the chain
(`bz.markets.getBook`, see [Markets](markets.md)). `side` must be `"bid"` or `"ask"`; anything else
throws `InputError`. Book levels take the page options only.

## Orders

| Function | Filters | Order | Returns |
|---|---|---|---|
| `orders(filter?)` | `account`, `pair`, `status`, `openOnly`, `orderType`, `integrator`, time options (bound the creation time) | newest first by `createdTimestamp` | `Page<HistoryOrder>` |
| `order(pair, orderId, atBlock?)` | | | `HistoryOrder \| null` |
| `orderEvents(filter?)` | `account`, `pair`, `orderId` (needs `pair`), `action`, time options | newest first by `timestamp` | `Page<OrderEvent>` |

`status` is a list of `history.ORDER_STATUSES` names: `Waiting` (a trigger order not yet fired),
`Pending`, `Resting`, `Fired`, `Filled`, `Canceled`. `openOnly` keeps the orders that can still trade
(`Waiting`, `Resting`, `Fired`, which is `history.OPEN_ORDER_STATUSES`); with `status` as well it keeps
the open statuses among those you named. `orderType` is a list of `Market`, `Limit`, `StopLimit`,
`TakeProfit`, `StopLoss`. An unknown name, or an empty list, throws `InputError`; so does `openOnly`
with a `status` list that names no open status.

```ts
{{#include ../../examples/advanced/history.ts:orders}}
```

A `HistoryOrder` holds the order as created (`orderType`, `isLong`, `isPostOnly`, `timeInForce`,
`integrator`, `triggerPrice`, `limitPrice`, `maxSlippageBp`, `expiryBlock`), its progress (`size`,
`filledSize`, `remaining`, `status`, `inBook`, `fillCount`, `amendCount`, `triggerCount`), its times
(`createdTimestamp`, `lastTriggeredTimestamp`, `canceledTimestamp`, `filledTimestamp`,
`updatedTimestamp`, and the matching blocks), its trigger bounty (`bountyEscrowed`, `bountyHeld`,
`bountyPaidToKeepers`, `bountyRefunded`), and `cancelReason`. A TakeProfit or StopLoss reports the size
its owner set at creation, and the size capped at the position once it fires. A resting order past its
`expiryBlock` stays in the book until a transaction removes it.

### Cancel Reasons

`cancelReason` is one of `history.CANCEL_REASONS`, and `history.CANCEL_REASON_TEXT` has a sentence for
the owner for each:

| Reason | Meaning |
|---|---|
| `None` | Not canceled. |
| `Owner` | The owner canceled it. |
| `Expired` | It reached its expiry block. |
| `Unfilled` | The book could not fill all of it on arrival; a market or immediate-or-cancel order cancels what is left. |
| `BelowMinimum` | What was left was worth less than the $5 order minimum, so it could not rest. |
| `PostOnly` | It was post-only and would have filled on arrival. |
| `SelfMatch` | It would have traded against another order of the same owner. |
| `StepLimit` | It crossed more resting orders than one transaction may walk; the rest was canceled. |
| `Margin` | The owner's collateral could not cover the fill (its margin or its fee) when it was reached. |
| `PriceBand` | While the market was closed it would have filled more than 10% away from the last price. |
| `PositionClosed` | The position it protected was closed or flipped. |
| `Liquidated` | The position was liquidated. |
| `Deleveraged` | The position was closed in full by auto-deleveraging. |

`history.cancelReasonName(code)` turns the numeric code an `OrderUpdated` log carries into its name (a
code outside the list throws `RangeError`); use it for the numeric `cancelReason` of the order updates
[Live Updates](live-updates.md) delivers, or when you decode logs yourself. The protocol's rules behind each reason are in Bazaar's
[Orders](https://docs.bazaar.finance/protocol/orders.html).

### Order Events

`orderEvents` lists one `OrderEvent` per `OrderUpdated`, `OrderAmended` or `OrderAmendSkipped` log. Its
`action` is one of `Created`, `Triggered`, `Canceled`, `Amended`, `AmendSkipped`; a `Canceled` event
carries the `cancelReason`, and an `AmendSkipped` event the `amendSkipReason` (`Inactive`, `Expired`,
`SizeFilled`, `BelowMinimum`, `WouldCross`: why a best-effort amendment left its order as it was). Each
event also has the order's `size`, `filledSize`, `limitPrice`, `triggerPrice` and `prioritySeq` as the
log reported them. For one order's lifecycle pass `pair` and `orderId` (without `pair`, `orderId` throws
`InputError`):

```ts
{{#include ../../examples/advanced/history.ts:order-events}}
```

## Positions and Collateral

| Function | Filters | Order | Returns |
|---|---|---|---|
| `positions(filter?)` | `account`, `pair`, `openOnly` | by `id` | `Page<HistoryPosition>` |
| `positionChanges(filter?)` | `account`, `pair`, time options | newest first | `Page<PositionChange>` |
| `positionSnapshots(filter?)` | `account`, `pair`, time options | newest first | `Page<PositionSnapshot>` |
| `collateralTransfers(filter?)` | `account`, `pair`, time options | newest first | `Page<CollateralTransfer>` |

`positions` returns one `HistoryPosition` per account and pair, open or closed: the stored position
(`isLong`, `size`, `entryValue`, `entryPrice`, `collateral`, `entryFundingIndex`, `imrBp`, `mmrBp`,
`takeProfitOrderId`, `stopLossOrderId`) and lifetime figures (`realizedPnl`, `feesPaid`, `tradeCount`,
`volumeSize`, `volumeNotional`, `collateralDeposited`, `collateralWithdrawn`, `liquidationCount`,
`adlCount`, `openedAtTimestamp`, `closedAtTimestamp`). `realizedPnl` is the price PnL realized by fills
plus ADL credits; funding settles into collateral and is not counted in it. `entryPrice` is
`entryValue / size`, and 0 when flat. `positions` takes the page options only.

`positionChanges` lists each trade's effect on a position: the maker's once per fill, the taker's once
per order walk at its volume-weighted price. `sizeDelta` is the new size less the old (both unsigned),
so a flip reports less than it traded. `positionSnapshots` lists the full stored position after every
change (each `PositionBucketUpdated` log), including liquidations, ADL and terminal settlement;
`imrBp` and `mmrBp` are 0 when the log reported no margin rates (terminal settlement).

```ts
{{#include ../../examples/advanced/history.ts:positions}}
```

## Fees, Rewards and Relaying

| Function | Filters | Order | Returns |
|---|---|---|---|
| `feeBalances(filter?)` | `recipient`, `pair`, `claimableOnly` | by `id` | `Page<FeeBalance>` |
| `feeAccruals(filter?)` | `recipient`, `pair`, time options | newest first | `Page<FeeMovement>` |
| `feeClaims(filter?)` | `recipient`, `pair`, time options | newest first | `Page<FeeMovement>` |
| `integratorStats(integrator, atBlock?)` | | | `IntegratorStats \| null` |
| `accountStats(account, atBlock?)` | | | `AccountStats \| null` |
| `accountDayData(account, opts?)` | time options | oldest first by `date` | `Page<AccountDayData>` |
| `metaTransactions(filter?)` | `user`, `relayer`, `pair`, time options | newest first | `Page<MetaTransaction>` |
| `permitFailures(filter?)` | `owner`, `pair`, time options | newest first | `Page<PermitFailure>` |

A claimable balance on a pair belongs to a recipient: an integrator's fees, a relayer's fees, a keeper's
rewards, a refunded trigger bounty. `feeBalances` reports each one's `accrued`, `claimed` and
`claimable`; `claimableOnly` keeps those with something to claim. It takes the page options only: its
type accepts `from`, `to` and `order`, but they are ignored. `feeAccruals` lists each credit
(`FeeAccrued`) and `feeClaims` each claim (`FeesClaimed`).

`integratorStats` reports what one integrator address has routed: `orderCount`, `fillCount` (fill
sides that carried it: a fill with it on both sides counts twice), maker and taker volume,
`firstOrderTimestamp` and `lastFillTimestamp`. Its revenue is its `feeBalances`. It is null when the
address has carried no order.

```ts
{{#include ../../examples/advanced/history.ts:integrator}}
```

`accountStats` reports an account's lifetime totals across every pair: trades, maker and taker volume,
fees paid, realized PnL, liquidations suffered and executed, trigger bounties earned and executions,
ADL batches executed, every credit and claim of a claimable balance, and `seedRefundOwedUsdc` (a listing
seed owed back, in USDC units). It is null when the subgraph has not seen the account.
`accountDayData` gives the same account's figures per UTC day.

`metaTransactions` lists relayed (gasless) actions: the `user`, the `relayer`, the action's EIP-712
typehash as `functionId`, the `nonce` and the `relayerFee`. `permitFailures` lists the ERC-2612 permits
a pair could not execute (the call went on with the existing allowance). See
[Gasless Trading & Relayers](gasless.md) and [Collateral, Approvals & Permits](collateral.md).

## Liquidation and ADL

| Function | Filters | Order | Returns |
|---|---|---|---|
| `liquidations(filter?)` | `account` (the liquidated trader), `liquidator`, `pair`, time options | newest first | `Page<Liquidation>` |
| `adlWindows(filter?)` | `pair`, time options (bound the opening time) | newest first by `openedAt` | `Page<AdlWindow>` |
| `adlBatches(filter?)` | `pair`, `window`, `transactionHash`, time options | newest first | `Page<AdlBatch>` |
| `adlFills(filter?)` | `account`, `pair`, `transactionHash`, time options | newest first | `Page<AdlFill>` |

A `Liquidation` has the seized `size`, side, `bankruptcyPrice`, the `price` it ran at, `notional` and
`collateralSeized`. An `AdlWindow` (id `"<pair>-<epoch>"`) runs from the `AdlTriggered` that opened it
to `AdlResolved` or the pair's termination (`endedByTermination`). An `AdlBatch` is one `executeAdl`
call: the bucket each leg closed, its settlement price (0 when that leg did not run) and what it
`netted`. Join `adlFills` on the batch's `transactionHash` for the winners it closed: each `AdlFill` has
the `closedSize`, the `credit` to the winner's collateral (PnL at the settlement price less withheld
funding), `adlScore` and `withheldFunding`. `window` must be a window id; `transactionHash` must be 32
bytes of hex; anything else throws `InputError`.

## Insurance

| Function | Filters | Order | Returns |
|---|---|---|---|
| `insuranceProviders(filter?)` | `pair`, `account`, `activeOnly` | by `id` | `Page<InsuranceProvider>` |
| `insuranceEvents(filter?)` | `account`, `pair`, `kind`, time options | newest first | `Page<InsuranceEvent>` |

An `InsuranceProvider` is one LP on one pair: live `shares` (a dead-pool reset sets every balance to
0), `deposited`, `withdrawn`, the withdrawal request in force (`requestedShares`, `requestedAt`), what
the first execute call `lockedAmount` the shares at, when the paying call opens (`claimOpensTs`), and
levies charged and received. `activeOnly` keeps providers holding shares. `kind` is a list of
`Deposit`, `WithdrawalRequested`, `WithdrawalLocked`, `WithdrawalExecuted`, `LevyCharged`,
`LevyReceived`; an event's `amount` is 0 for requests and levies. The share price and what a withdrawal
would pay now come from the chain: see [Insurance](insurance.md).

## Termination

| Function | Filters | Order | Returns |
|---|---|---|---|
| `pairTerminations(filter?)` | `pair`, time options | newest first | `Page<PairTermination>` |
| `terminalRatioUpdates(filter?)` | `pair`, time options | newest first | `Page<TerminalRatioUpdate>` |
| `terminationProposals(filter?)` | `pair`, `proposer`, `status`, time options (bound submission) | newest first by `submittedAt` | `Page<TerminationProposal>` |
| `insurerProposals(filter?)` | `pair`, `proposer`, `status`, time options (bound creation) | newest first by `createdAt` | `Page<InsurerProposal>` |
| `insurerVotes(filter?)` | `proposal`, `pair`, `voter`, time options | newest first | `Page<InsurerVote>` |
| `insurerLevies(filter?)` | `proposal`, `pair`, `voter`, time options | newest first | `Page<InsurerLevy>` |

A `PairTermination` is a finalized termination with its payout figures: `settlementPrice`,
`owedToTraders`, `registeredClaims`, `badDebt`, `estateValue`, `pot`, the `principalRatio` and
`profitRatio` (1e18 = 100%), the insurance fund after, and `sweepComplete` (false when finalize ran
through the escape hatch with positions still open). A `TerminalRatioUpdate` records a post-finalize
settlement that re-derived the ratios on the entitlements still unpaid.

A `TerminationProposal` is a UMA termination claim (its id is the UMA assertion id): `category`,
`lastTradingTs` (the cutoff it proposed), `reason`, `disputed`, `acceptedCutoffTs`, `submittedAt`,
`livenessEndsAt` (from when an undisputed claim can be settled) and `status`: `Pending`, `Disputed`,
`Accepted`, `ScheduleRefused`, `Superseded` or `Rejected`. Every claim also opens an insurer vote under
the same id. An `InsurerProposal` has `status` `Open`, `Scheduled`, `Failed`, `Preempted`, `Voided` or
`Rejected`, its `cutoffTs`, `yesShares` against `snapshotTotalShares`, `thresholdMet`, `outcome` (1
TRUE, 2 FALSE, 3 UNJUDGED), `levyBp` and `bondRefundFailed`. `proposal` filters must be 32 bytes of hex.
Render `reason` as text, never as HTML. How to act on any of these: [Termination & Settlement](termination.md).

## Listings and Governance

| Function | Filters | Order | Returns |
|---|---|---|---|
| `listingProposals(filter?)` | `deployer`, `status`, time options (bound the proposal time) | newest first by `proposedAt` | `Page<ListingProposal>` |
| `identifierUpgradeProposals(filter?)` | `proposer`, `status`, time options | newest first by `proposedAt` | `Page<IdentifierUpgradeProposal>` |

A `ListingProposal` (id: the UMA assertion id) has the proposed `pairId`, `baseFeedId`, `description`,
`seedAmount`, `status` (`Pending`, `Disputed`, `Deployed`, `Rejected`, `Expired`, `Voided`), the
deployed `pair` once deployed, and `seedRefundUsdc` (USDC units). An `IdentifierUpgradeProposal` has
the `newIdentifier`, `status` (`Pending`, `Disputed`, `Queued`, `Upgraded`, `Canceled`, `Expired`,
`Rejected`), and `effectiveTs` (when a queued upgrade's timelock ends). A listing's `description` is
written by whoever proposed it: render it as text. See [Listing Markets](listings.md) and
[UMA Disputes & Governance](governance.md).

## How Current Is It

`subgraphLag()` compares the subgraph's `_meta.block` with the chain's head:

| Field | Meaning |
|---|---|
| `indexedBlock` | The last block the subgraph has indexed. |
| `indexedTimestamp` | Its timestamp, or null when the indexer does not report one. |
| `chainBlock`, `chainTimestamp` | The head as the connection's RPC sees it. |
| `blocksBehind` | Blocks the subgraph trails the head (0 when level, or ahead of this RPC). |
| `secondsBehind` | Seconds behind, or null without `indexedTimestamp`. |
| `hasIndexingErrors` | The indexer hit an error: its history may stop advancing. |

Show the user that recent trades may be missing when it falls behind:

```ts
{{#include ../../examples/advanced/history.ts:lag}}
```

## What Can Go Wrong

| Error | When |
|---|---|
| `ConnectError` | The connection has no subgraph source. |
| `InputError` | An argument was refused before any query was sent: an address that is not one, `first` outside 1 to 1000, an unknown enum name, a cursor from another list, a candle interval that is not one of the six, `orderId` without `pair`, a window id or hash of the wrong shape. Its `field` names the argument, and `errorMessage(e)` shows its message. |
| `history.SubgraphError` | The subgraph is unreachable, answered with an HTTP error (`status` holds it; 401 and 403 add "check the API key"), refused the query (GraphQL errors, such as an `atBlock` it has not indexed), did not answer with JSON, or returned no data or a row without a required field. The message never carries the raw URL. |

```ts
{{#include ../../examples/advanced/history.ts:errors}}
```

`errorMessage(e)` is written for contract and wallet failures; for a `SubgraphError` or `ConnectError`
it returns its generic sentence, so show your own text ("History is unavailable right now") and log
`e.message`.

Every value is validated and written into the query as a literal, so nothing a user typed can change
the query's text.

## Related

- [Live Updates](live-updates.md): the same events as they happen, from the chain.
- [Accounts & Portfolios](accounts.md): an account's state now, at the live price.
- [Low-Level Building Blocks](low-level.md#subgraphclient): `SubgraphClient`, for queries of your own and
  whole-entity snapshots.
- Bazaar's [integrator guide](https://docs.bazaar.finance/guide/integrators.html): which events each
  piece of history comes from.
