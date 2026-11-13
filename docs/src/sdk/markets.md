# Markets

This page covers reading markets: discovering them and their labels, a market's whole live state at
one block (its snapshot), the status and flags a UI gates its buttons on, funding for display, and the
order book aggregated into price levels.

The samples assume `bz` connected as in [Connecting](connecting.md), with a price source.

## Listing Markets

```ts
{{#include ../../examples/reads/markets.ts:list}}
```

`bz.markets.listMarkets(options?)` returns every market the factory has deployed, in the factory's
order (`factory.getAllPairs`), each with the facts that never change about it. The first call reads
the pair list, describes each pair (its pair id, feeds and trading calendar: two batched reads), takes
the listing descriptions from the subgraph when the connection has one, and fetches the feeds' Pyth
symbols for the labels. The list is then cached on the connection: later calls make no request.

| Option | Default | Meaning |
|---|---|---|
| `refresh` | `false` | Read the factory's pair list again. Markets already known keep their facts; only new ones are described. |
| `metadata` | the registry of the connection's Pyth Pro client when it has one, else Pyth's (`PYTH_PRO.symbolsUrl`) | Where feed symbols come from: a symbols registry's base URL, or an object with `symbols()` (a `ProClient` is one). A connection's own registry is the only one asked, so a local mock's feed numbers never get Pyth's symbols. `null` skips symbols, and labels are then short addresses. A listing is kept for 10 minutes; an empty or failed one is not kept. |

Each entry is a `MarketInfo`:

| Field | Type | Meaning |
|---|---|---|
| `address` | `Address` | The pair contract: what every other function takes. |
| `label` | `string` | For display: "BTC/USD", "AAPL/USD", from the feed's Pyth symbol. A composite (an asset priced through an FX leg) is labelled in USD. A market whose symbols cannot be fetched is labelled with the start of its address. |
| `pairId` | `Hex` | The pair's id in the factory. |
| `baseFeedId` | `Hex` | The pair's price id: a Pyth feed id, or a composite's id. |
| `legs` | `Hex[]` | The raw Pyth feeds: one, or base then quote for a composite. |
| `legSymbols` | `string[]` | Each leg's Pyth symbol ("Crypto.BTC/USD", "Equity.US.AAPL/USD"); `""` where the registry has none. |
| `legFeeds` | `(ProSymbol \| null)[]` | Each leg's entry in Pyth Pro's symbols registry: `id`, `symbol`, `assetType`, `minChannel` (the fastest channel it is served on), `state`, `schedule` (the regular session's), `sessions` (every session Pyth publishes the feed in: a US stock with extended hours has `regular`, `pre_market`, `post_market` and `over_night`, which together run Sunday evening to Friday evening in New York). `null` where the registry has none or was not read. |
| `composite` | `boolean` | Priced from two feeds composed by the oracle. |
| `invertQuote` | `boolean` | A composite's quote leg is inverted. |
| `continuous` | `boolean` | Traded 24/7. |
| `hours` | `"24/7" \| "trading-hours"` | The same, as text. A trading-hours market (stocks, FX) keeps running on its last price while its venue is closed, with fills held within 10% of that price, market orders refused and position collateral locked until the first fresh price at the reopen. |
| `description` | `string` | The listing's description from the subgraph, or `""`. It is unverified text: show it as text, never as HTML. A description that fails the factory's own character and length rule is dropped. |
| `index` | `number` | The market's position in the factory's list. |

**Labels are never taken from descriptions**, which anyone listing a market writes and which could name
another market.

### Finding One Market

`bz.markets.getMarket(ref)` takes a market's label (any case), its pair address, its pair id, or a
`MarketInfo` (returned as is). A name the cached list does not know makes one refresh of the pair
list, so a market listed since the page loaded is found. It throws an `InputError` on `market` for a
name that matches nothing ("There is no market called "XYZ/USD". Markets: BTC/USD, ETH/USD.") or
several markets ("... matches several markets (...); choose one by its address."). Every function
that takes a market accepts any of these forms.

## Market Snapshots

```ts
{{#include ../../examples/reads/markets.ts:snapshot}}
```

`bz.markets.marketSnapshot(market, options?)` reads a market's live state at one block: the keeper's
own state read and the snapshot's extra reads (mark price, funding rates, the stored price's band, ADL
clocks, termination figures, the vault's ledger, the book's heads), in two batched calls sent
together. `marketSnapshots(markets, options?)` does the same for many markets at once, in the same two
calls, and returns a `Map` from address to snapshot; a market whose core reads fail is left out of the
map, where `marketSnapshot` throws instead.

| Option | Default | Meaning |
|---|---|---|
| `block` | the latest | `{ number, timestamp }` to read at (a watcher passes its head). |
| `prices` | none | A [`LivePrices`](live-prices.md) stream (or anything with `price` and `venueClosed`), to judge trading-hours venues without a request. |
| `fetchPrices` | `true` | Without live prices, ask the connection's Pyth Pro source for the legs of trading-hours markets, in parallel with the chain read, to judge their venue. |

A snapshot is a plain object: keep it in state and re-render from it. Its time-dependent fields can be
re-derived without a read (see [Status](#status)).

### Snapshot Fields

| Field | Meaning |
|---|---|
| `market` | The `MarketInfo`. |
| `block`, `timestamp` | The block read, and its timestamp: what the status, the clocks and the flags are judged at. |
| `status` | `live`, `adl`, `limbo`, `settling` or `terminated`. See [Status](#status). |
| `venueClosed`, `marketOrdersDisabled`, `positionWithdrawalsFrozen`, `allWithdrawalsPaused`, `reasons` | The flags. See [Flags](#flags). |
| `price` | The pair's stored oracle price: what its next call falls back to without a fresh one. |
| `markPrice` | The mark at this block (the lens's `markPrice`); 0 before any qualifying print formed one. |
| `funding` | Funding rates and the index. See [Funding](#funding). |
| `margin` | The margin rates. |
| `openInterest` | Open interest and the vault's inventory. |
| `insurance` | The insurance fund and the vault's ledger. |
| `deficit` | Realized bad debt beyond the insurance fund: non-zero means the pair is insolvent and settles. |
| `adl` | The ADL window and auction. |
| `termination` | A scheduled cutoff, the settlement price, the terminal payout ratios. |
| `book` | The book's heads and order counts. |
| `state` | The raw state read (`MarketState`), which `account` functions reuse. |

`price` (`StoredPrice`):

| Field | Meaning |
|---|---|
| `spot` | The stored spot (18 decimals). |
| `low`, `high` | Spot less and plus the Pyth confidence. |
| `updateTs` | The stored print's publish time (Unix seconds). |
| `age` | Seconds between the stored print and the snapshot's block. |
| `emaVarianceBp` | The variance EMA the margin curve reads, in basis points. |
| `updateCount` | Prices the pair has stored since it was created. |

`margin` (`MarginView`), all in basis points of notional:

| Field | Meaning |
|---|---|
| `imrBp` | Initial margin: what opening, adding and withdrawing must keep. |
| `mmrBp` | Maintenance margin now. |
| `laggedMmrBp` | The 24-hour-lagged maintenance rate (0 before any sample). |
| `effectiveMmrBp` | What liquidation judges by: the lower of the current rate and a non-zero lagged one. |
| `maxLeverage` | `10,000 / imrBp`, a `number` (null while `imrBp` is 0). |
| `withdrawalFloorBp` | The rate a position must keep as cash collateral when withdrawing: `mmrBp` on 24/7 markets, `imrBp` on trading-hours ones. |

How these rates are set is in [Margin](https://docs.bazaar.finance/protocol/margin.html).

`openInterest` (`OpenInterestView`): `long` and `short` (sizes), `longNotional` and `shortNotional`
(at the stored spot), and `longInventory` and `shortInventory` (liquidated positions the vault holds,
by the side they came from).

`insurance` (`InsuranceView`):

| Field | Meaning |
|---|---|
| `fund` | The insurance fund's balance. |
| `seized` | The part earmarked against inventory the vault holds. |
| `freeCapital` | `fund` less `seized`. |
| `targetRatioBp` | The target the margin curve last computed, in basis points of open interest. |
| `depositsLedger` | Every account's collateral the pair holds. |
| `ledgerArrears` | What the deposits ledger owes the fund (cash winners already withdrew). |

See [Insurance](https://docs.bazaar.finance/protocol/insurance.html).

`adl` (`AdlView`):

| Field | Meaning |
|---|---|
| `pending` | An ADL window is open. |
| `epoch` | Advanced each time a window opens. |
| `pendingSince` | When the open window opened (0 when none). |
| `auctionStart` | When the score threshold started decaying (restarts after a market closure). |
| `auctionEndsAt` | When the threshold reaches its floor: `auctionStart` + 10 minutes (0 when none). |
| `timeoutAt` | `pendingSince` + 24 hours: the timeout then arms termination. |
| `terminationTs` | When an armed timeout may terminate the pair (0 while unarmed). |
| `scoreThreshold` | The score a winner must exceed at the snapshot's block (`MAX_UINT256` while no auction runs). |

`termination` (`TerminationView`):

| Field | Meaning |
|---|---|
| `scheduledTs` | A scheduled cutoff (0 when none). |
| `haltsAt` | When trading halts ahead of it: the cutoff less `LIMBO_LEAD` (6 s). |
| `settlementFixedTs` | When the settlement price was fixed (0 while not). |
| `settlementPrice` | The fixed settlement price (0 while live). |
| `finalizeBy` | The latest `finalizeTermination` can wait: `settlementFixedTs` + 14 days. |
| `terminated` | The termination is finalized. |
| `principalRatio`, `profitRatio` | Cash paid per unit of collateral and per unit of profit claim after finalize (1e18 = 100%). |
| `profitClaims` | Registered winner profit not yet paid out. |
| `badDebt` | Settled losses beyond collateral, tallied in the settlement window. |

See [Termination & Settlement](termination.md) and
[Termination](https://docs.bazaar.finance/protocol/termination.html).

`book` (`BookSummary`): `bidHead` and `askHead` (the best orders' ids, 0 for an empty side), and
`bidCount` and `askCount` (orders resting on each side). For price levels, see [The Book](#the-book).

## Status

`snapshot.status` is one value, judged at the snapshot's block, in this order of precedence:

| Status | Meaning |
|---|---|
| `terminated` | The termination is finalized. Nothing trades; collateral and settled profits can be withdrawn. |
| `settling` | The settlement price is fixed and positions are being settled at it (at most 14 days). |
| `limbo` | From `LIMBO_LEAD` (6 seconds) before a scheduled cutoff until its settlement price is fixed: trading has stopped. |
| `adl` | An ADL window is open: matching halts while liquidation and ADL run. |
| `live` | Trading normally. |

The `Status` constant names them (`Status.Live`, ...). In every status but `live`, every new order is
refused, not only market orders. `markets.marketStatusAt(snapshot, time)` gives the status at another
time without a read (for a countdown to a cutoff), and `markets.adlScoreThresholdAt(snapshot, time)`
the ADL threshold.

## Flags

The flags say what the pair refuses right now, each with the reason a UI can show next to a disabled
button:

```ts
{{#include ../../examples/reads/markets.ts:flags}}
```

| Flag | True when | Reason shown |
|---|---|---|
| `venueClosed` | A trading-hours market's feed has generated no price for 15 seconds (`VENUE_CLOSED_AFTER`), judged from the live prices passed in or from one Pyth Pro request. `null` when nothing could judge it (no live prices, a price source that is not a `proPriceSource`, or a request that failed); always `false` on a 24/7 market. | "The venue is closed: this market runs on its last price, with fills held within 10% of it, until the first fresh price at the reopen." |
| `marketOrdersDisabled` | The market is terminated, settling, in limbo or in ADL, or its venue is closed. | One of: terminated, settling, limbo, ADL ("Trading is paused while the market auto-deleverages."), or "The venue is closed: market orders need a live price and resume at the reopen. Limit orders still work." |
| `positionWithdrawalsFrozen` | An account holding a position cannot withdraw collateral: in ADL, while the venue is closed, and whenever all withdrawals are paused. Flat accounts are unaffected by the first two. | The ADL, closed-venue or pause reason. |
| `allWithdrawalsPaused` | No account can withdraw: in limbo, and while settling. | "Withdrawals are paused while every position is settled at the fixed price: ...", or the limbo text. |

`snapshot.reasons` has one entry per flag, `null` where the flag is off. An
[account snapshot](accounts.md) applies the flags to the account (`withdrawalBlocked`).
`markets.marketFlags(market, state, time, venueClosed)` computes them from a state read yourself.

The pair's rules behind each flag are in Bazaar's
[Oracle](https://docs.bazaar.finance/protocol/oracle.html) (closed venues),
[ADL](https://docs.bazaar.finance/protocol/adl.html) and
[Termination](https://docs.bazaar.finance/protocol/termination.html) chapters.

## Funding

```ts
{{#include ../../examples/reads/markets.ts:funding}}
```

`snapshot.funding` (`FundingView`):

| Field | Meaning |
|---|---|
| `currentRatePerHour` | The rate the mark's premium implies now, per hour, 18 decimals (1e18 = 100%): positive when longs pay shorts. |
| `accruingRatePerHour` | The rate the next stored price charges for the window since the index last accrued. |
| `index` | The stored cumulative funding index, in price units. |
| `projectedIndex` | The index a price stored at this block would leave. Account health uses it. |
| `lastAccrualTs` | When the index last accrued (Unix seconds). |
| `maxRatePerHour` | The cap: 0.1% an hour on 24/7 markets (`MAX_FUNDING_RATE_CONTINUOUS`), 0.5% on trading-hours ones (`MAX_FUNDING_RATE_SESSION`). |

`markets.annualizedFunding(ratePerHour, hoursPerYear?)` gives a yearly fraction for display (0.0876
is 8.76% a year). A trading-hours market accrues funding only while its venue is open, so pass the
hours it actually trades in a year (about 1,700 for a US equity) rather than the default 8,760. See
[Funding](https://docs.bazaar.finance/protocol/funding.html).

## The Book

```ts
{{#include ../../examples/reads/markets.ts:book}}
```

`bz.markets.getBook(market, levels?, options?)` returns `{ bids, asks }`, both sides read at one block.
`getBookDepth(market, side, levels?, options?)` reads one side, `"bids"` or `"asks"`. Each walks the
side from its best order with the lens's `getBookDepth` until it has seen enough distinct prices, reads
the orders' sizes in one batch, drops what is no longer live (filled, canceled, or past its expiry
block but not yet swept), and sums each price level. Every read is pinned to one block.

| Argument / option | Default | Meaning |
|---|---|---|
| `levels` | 20 | Price levels wanted, 1 to 1,000 (an `InputError` otherwise). |
| `pageSize` | `levels × 4`, between 32 and 200 | Orders per lens page. |
| `maxOrders` | 2,000 | Stop after this many orders even with fewer levels (the last level may then be partial). |
| `block` | the latest | `{ number }` to read at. |

A `BookDepth` has `market`, `side`, `block`, `levels` (best first: bids from the highest price down,
asks from the lowest up) and `complete` (every level the side has is there). Each `DepthLevel` has
`price`, `size` (remaining, 18 decimals), `notional` (`size × price`), `orders` (resting orders at the
level) and `cumulative` (size from the best level through this one).

To keep a book current, re-read it when [`watchMarket`](live-updates.md) reports `bookChanged`.

## What Can Go Wrong

| Error | Why |
|---|---|
| `InputError` on `market`: `There is no market called "..."` | No label, address or pair id matches, even after a refresh. |
| `InputError` on `market`: `"..." matches several markets` | Two markets share a label; pass the address. |
| `Error`: `could not read the state of market ...: its price, margin or vault read failed` | `marketSnapshot` (and `accountSnapshot`) could not read the market's core state at that block. |
| `InputError` on `side` or `levels` | `getBookDepth` was given another side or a level count outside 1 to 1,000. |
| Labels are short addresses | The feed metadata could not be fetched (the list itself still loads). |
| `venueClosed` is `null` | Nothing could judge the venue: pass live prices, or connect with a Pyth Pro source. |

## Related Pages

- [Accounts & Portfolios](accounts.md)
- [Live Prices](live-prices.md), [Live Updates](live-updates.md)
- [Previews](previews.md)
- [History](history.md), for candles and trades
- [Units & Constants](../reference/units.md)
