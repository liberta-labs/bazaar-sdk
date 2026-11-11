# Accounts & Portfolios

This page covers reading a trader's state: on one market (`accountSnapshot`) and across every market
where the account holds anything (`portfolio`). A snapshot has the position and its health at the
live price, the live orders, what can be withdrawn now, claimable fees, the meta-transaction nonce,
the terminal payout of a market that is winding down, and the wallet's USDC balance and allowance.

The samples assume `bz` connected as in [Connecting](connecting.md) with a price source, `user` the
trader's address and `eth` a market from [Markets](markets.md).

## One Market

```ts
{{#include ../../examples/reads/accounts.ts:snapshot}}
```

`bz.account.accountSnapshot(market, user, options?)` reads the account in two batched calls: first
the position, its live order ids, the pair's stored price, the claimable fees and the wallet's USDC
balance; then everything that depends on those (the lens's solvency and withdrawal figures at the
account's price, the order exposure, the nonce, the terminal entitlement, the allowance, and the
orders themselves), sent together with the market's state read.

The position is valued at the first price available, in this order:

1. `options.price`, a price you already hold (`{ spot, low?, high?, publishTime? }`);
2. the live price from `options.prices`, a [`LivePrices`](live-prices.md) stream;
3. one Pyth Pro request for the market's feeds, when the connection's price source is a
   `proPriceSource` (and `fetchPrices` is not `false`);
4. the pair's stored price.

`snapshot.price.source` says which: `"given"`, `"live"`, `"pro"` or `"stored"`.

| Option | Default | Meaning |
|---|---|---|
| `block` | the latest | `{ number, timestamp }` to read at. |
| `prices` | none | Live prices to value the position at and to judge the venue with. |
| `fetchPrices` | `true` | Without live prices, ask the connection's Pyth Pro source for the feeds, in parallel with the first read. |
| `price` | none | A price you hold, used instead of a live one. |
| `market` | none | The market's snapshot (or state read) at the same block, to skip reading it again. Its block is then the snapshot's. |

### Snapshot Fields

| Field | Meaning |
|---|---|
| `market`, `user` | The market's `MarketInfo`, and the account (checksummed). |
| `block`, `timestamp` | The block read and its time. |
| `status`, `flags` | The market's [status and flags](markets.md#status) at that block. |
| `state` | The market's state read, kept for `accountHealth`. |
| `position` | The position bucket. See below. |
| `hasPosition` | `position.size > 0`. |
| `price` | What the health and the withdrawal figure were valued at, with its `source`; `null` when no price was known at all. |
| `health` | The position's [health](#health) at `price.spot`; `null` while flat or without a price. |
| `solvency` | The lens's own view (`checkBucketSolvency`) at `price.spot` and the stored funding index; `null` without a price. |
| `orders` | Every live order: the Limit and StopLimit orders in the account's active set, then the attached take-profit and stop-loss. |
| `takeProfit`, `stopLoss` | The position's attached TP and SL among `orders`, or `null`. |
| `exposure` | Resting orders' remaining notional (at their limits) and size, per side. |
| `maxWithdrawable` | The most `withdrawCollateral` accepts now, per the lens. See [Withdrawals and Fees](#withdrawals-and-fees). |
| `withdrawalBlocked` | Why this account cannot withdraw right now, or `null`. |
| `claimableFees` | What `claimFees` would pay this account on this market: refunded bounties, keeper rewards, relayer and integrator fees. |
| `nonce` | The account's next meta-transaction nonce on this pair (gasless requests sign it). |
| `terminal` | What a withdrawal pays while the market settles or after it terminated; `null` on a live market. |
| `wallet` | `{ usdcBalance, usdcAllowance }`, in USDC's own units (6 decimals): the wallet's USDC and what this pair may pull. |

`position` (`AccountPosition`), 18 decimals:

| Field | Meaning |
|---|---|
| `isLong`, `size` | The net position: one per market, `size` 0 when flat. |
| `entryValue` | The entry notional. |
| `entryPrice` | `entryValue / size`, the average entry price (0 while flat). |
| `collateral` | Raw collateral: deposits plus realized PnL, less fees. |
| `entryFundingIndex` | The funding index at entry. |
| `takeProfitOrderId`, `stopLossOrderId` | The attached TP and SL (0 for none). |

`terminal` (`TerminalPayout`): `collateral`, `registeredClaim`, `principalRatio` and `profitRatio`
(1e18 = 100%, 0 before finalize), and `payout`, what a withdrawal pays:
`collateral × principalRatio + registeredClaim × profitRatio`. See
[Termination & Settlement](termination.md).

`solvency` (`LensBucketState`) is the lens's figures as the contract computes them: `unrealizedPnl`,
`fundingPnl`, `totalPnl`, `adjustedSize`, `currentNotional`, `entryValue`, `minRequiredCollateral`,
`availableEquity`, `effectiveCollateral`, `adjustedEntryFundingIndex`, `isSolvent`.

## Health

`snapshot.health` (`PositionHealth`) values the position at a price by the pair's own formula, at the
projected funding index (what a price stored now would accrue to) and the effective maintenance rate:

| Field | Type | Meaning |
|---|---|---|
| `price` | `bigint` | The spot it was valued at. |
| `notional` | `bigint` | Size × price. |
| `unrealizedPnl` | `bigint` | Price PnL since entry. |
| `fundingPnl` | `bigint` | Funding earned (positive) or owed (negative) since entry. |
| `totalPnl` | `bigint` | The two together. |
| `equity` | `bigint` | Collateral plus total PnL (signed). |
| `availableEquity` | `bigint` | Equity floored at zero. |
| `maintenanceRequired` | `bigint` | What maintenance margin requires at this price. |
| `marginRatio` | `number` | `equity / maintenanceRequired`. Below 1, anyone may liquidate the position. |
| `leverage` | `number \| null` | Notional over equity (`null` when equity is not positive). |
| `isSolvent` | `boolean` | The pair's own solvency verdict. |

A margin ratio of 2 means equity is twice what maintenance requires. How maintenance margin and
liquidation work is in [Margin](https://docs.bazaar.finance/protocol/margin.html) and
[Liquidations](https://docs.bazaar.finance/protocol/liquidations.html).

### Following the Price

```ts
{{#include ../../examples/reads/accounts.ts:health}}
```

`account.accountHealth(snapshot, price)` revalues a snapshot's position at a new spot (a `bigint`, or
anything with `spot`, such as a live `MarketPrice`) without any read: a display that follows the price
between snapshots calls it on every tick. It returns `null` while flat.
`account.positionHealth(position, state, spot)` is the same computation from a position and a market
state, for "what if the price were ..." figures.

The estimated liquidation price of a new or changed position is in
[Previews](previews.md).

## Orders

```ts
{{#include ../../examples/reads/accounts.ts:orders}}
```

Each entry of `snapshot.orders` is an `AccountOrder`:

| Field | Meaning |
|---|---|
| `orderId` | The pair's id for the order. |
| `orderType`, `typeName` | The type (`OrderType`), and its name: "Market", "Limit", "StopLimit", "TakeProfit", "StopLoss". |
| `isLong` | A buy. |
| `isPostOnly`, `tif` | Post-only, and the time in force (0 GTC, 1 IOC, 2 FOK). |
| `size`, `filled` | The order's size and what has filled. |
| `remaining` | What is left to fill; for a TP or SL, capped at the position it closes. |
| `limitPrice`, `triggerPrice` | The limit, and the trigger (StopLimit, TakeProfit, StopLoss; 0 otherwise). |
| `bounty` | The keeper bounty the order still holds in escrow. |
| `maxSlippageBp` | The slippage cap of a TP or SL. |
| `expiryBlock`, `neverExpires`, `blocksLeft` | The expiry (an Arbitrum block), whether it never expires (TP and SL), and blocks until it does (`null` when never). |
| `inBook` | Resting in the book: a Limit, or a StopLimit that has armed. |
| `closesWholePosition` | A TP or SL sized to close the whole position, whatever it is when it fires. |
| `attached` | `"takeProfit"`, `"stopLoss"`, or `null`. |
| `integrator` | The integrator the order names. |
| `record` | The order as stored, every field. |

Only live orders are listed: filled, canceled and expired ones are left out, even before a sweep has
unlinked them. `exposure` (`OrderExposure`) has `longNotional`, `shortNotional`, `longSize` and
`shortSize`: what the account's resting orders would add. To amend or cancel, see
[Managing Orders](managing-orders.md); for the account's past orders, [History](history.md).

## Withdrawals and Fees

```ts
{{#include ../../examples/reads/accounts.ts:withdraw}}
```

`maxWithdrawable` is the lens's `getMaxWithdrawable`, valued at the conservative side of the price for
a position (spot less the confidence for a long, plus it for a short): the most the pair would accept
now. The lens cannot see a closed venue or a paused market, so check `withdrawalBlocked` too: when it
is set, a withdrawal reverts whatever `maxWithdrawable` says. `withdrawalBlocked` is the market's
`allWithdrawalsPaused` reason, or, for an account holding a position, its `positionWithdrawalsFrozen`
reason. A flat account can withdraw during ADL and while the venue is closed.

`claimableFees` is what `bz.trade.claimFees(market, user)` would pay. The withdrawal and claim calls
are on [Collateral, Approvals & Permits](collateral.md); the exact limits and freezes of a withdrawal
are in [Previews](previews.md) (`previewWithdrawal`).

## Portfolios

```ts
{{#include ../../examples/reads/accounts.ts:portfolio}}
```

`bz.account.portfolio(user, markets?, options?)` returns a snapshot for every market where the
account has collateral, a position, live orders or claimable fees, in the factory's order, with
totals. Without `markets` it covers the factory's whole list, and takes the claimable fees from one
`getClaimableFeesAll` read, which also catches a market listed since the list was cached. It costs
about four calls whatever the number of markets: the head, one batch over every market, then one batch
for the markets the account uses, sent with their state read. Its options are `block`, `prices` and
`fetchPrices`, as for `accountSnapshot`.

| Field | Meaning |
|---|---|
| `user`, `block`, `timestamp` | The account and the block read. |
| `accounts` | One `AccountSnapshot` per market the account uses. |
| `walletUsdc` | The wallet's USDC, in USDC units (6 decimals). |
| `totals` | Summed across `accounts`, 18 decimals: `collateral`, `equity` (collateral plus PnL where there is a position), `unrealizedPnl`, `fundingPnl`, `claimableFees`, and `maxWithdrawable` (0 for a market whose withdrawals are blocked). |

## Keeping It Current

`bz.live.watchAccount(user, markets, onUpdate)` delivers a fresh snapshot for each market an event
touches (a fill, an order, a deposit, a liquidation) and for every market every 15 seconds. See
[Live Updates](live-updates.md).

## What Can Go Wrong

| What | Why |
|---|---|
| `Error`: `could not read the state of market ...` | The market's own state read failed at that block. |
| `price` is `null`, `health` is `null` with a position | No price at all: no live prices, no Pyth Pro source (or it failed), and the pair has never stored one. |
| `price.source` is `"stored"` | No fresher price could be had; the stored price may be minutes old. Show `price.publishTime`. |
| `maxWithdrawable` is positive but a withdrawal reverts | `withdrawalBlocked` is set (a closed venue, ADL, a pause), or the price moved. Simulate first. |
| An address error | `user` is not an address (viem's `InvalidAddressError`). |

## Related Pages

- [Markets](markets.md)
- [Collateral, Approvals & Permits](collateral.md)
- [Managing Orders](managing-orders.md)
- [Previews](previews.md)
- [Live Prices](live-prices.md), [Live Updates](live-updates.md)
