# Previews

A preview tells a user what an order or a withdrawal will do before they sign it: the fills it meets,
each fill's fee, the collateral it needs, the position it leaves and that position's liquidation price,
the most they can withdraw, and every reason the pair would refuse. Nothing is sent.

`bz.previews.previewOrder` and `bz.previews.previewWithdrawal` read the pair (two batched reads each),
then run the inputs through TypeScript ports of the pair's own arithmetic: the matching walk, the fee
schedule, the per-fill margin gate, the position transition and the creation margin check. The pure
functions underneath (`previews.simulateOrder` and the fee and margin helpers) take every input
explicitly, for a UI that already holds the pair's state and wants to re-run them on every keystroke.

The samples assume `bz` connected as in [Connecting](connecting.md), `user` the wallet's address and
`eth` a market. For the mechanics behind the numbers see
[Margin](https://docs.bazaar.finance/protocol/margin.html),
[Fees](https://docs.bazaar.finance/protocol/fees.html) and
[Matching](https://docs.bazaar.finance/protocol/matching.html).

## Exact and Estimated

The integer math is the contract's, so a preview matches the transaction whenever its inputs still hold
when the transaction lands. They may not: the call stores a fresh price first, which can move the
funding index, the fee rates and (at most once a minute) the margin rates, and other transactions can
change the book in between.

| Exact for the inputs read | Estimates |
|---|---|
| The fee of each fill. | Which makers an order meets: a maker's own margin gate can cancel it mid-walk. |
| What the creation check requires of collateral. | When a resting remainder fills: assumed later, at its limit price, as maker. |
| Each fill's margin verdict. | What a trigger order meets when it fires: assumed at its trigger price. |
| The resulting position. | The liquidation price: funding is held where it is now. |
| The account's current state (`BazaarPairLens.checkBucketSolvency`). | |
| The withdrawal ceiling (`BazaarPairLens.getMaxWithdrawable`). | |

One more difference: a fill whose fees exceed what the pair's deposits ledger can fund has its fees
waived on chain; previews always charge them.

Previews value everything at the pair's last stored price unless you pass the live one. Pass it: the
call will carry a fresh print, and the stored price may be seconds or (on a quiet market) minutes old.

## previewOrder

`bz.previews.previewOrder(pair, account, order, opts?)`:

```ts
{{#include ../../examples/trading/previews.ts:preview-order}}
```

`order` is the preview's `OrderInput`, the same fields as an order for `createOrder` with a few
differences: `orderType` defaults to Market, `tif` is a number (0 GTC, 1 IOC, 2 FOK), a bounty packed
into `triggerPrice` is ignored, there is no expiry, and `integrator` (default: the connection's) can be
set to see the fees with or without one.

| Option | Default | Meaning |
|---|---|---|
| `price` | the pair's stored price | The price the call will carry: `{ spot, low?, high?, publishTime? }`. `publishTime` lets the preview tell whether a market with trading hours has its venue closed. |
| `walkBook` | `true` | Walk the current book (up to 33 orders on the opposite side). `false` assumes one fill at `fillPrice`. |
| `fillPrice` | the mark | The assumed fill price when the book is not walked. |

The preview throws `InputError` on `price` when the pair has no stored price yet and none was given.

### The Result

`previewOrder` returns an `OrderPreviewResult`:

| Field | Meaning |
|---|---|
| `blockers` | Every reason the pair would refuse the order outright: trading halted, validation, margin. Empty when it would go through. Each is a `PreviewIssue` (below). |
| `before`, `after`, `afterArrival` | The position before; after everything fills (what fills now plus a resting remainder assumed filled later at its limit); and after what fills in this transaction only. Each is a `PositionView`. |
| `fills` | Each fill: `price`, `size`, `notional`, `role` (`"taker"` or `"maker"`), `fee` (`{ insurance, integrator, total }`), `later` (a resting remainder's assumed fill), `assumed` (not met in the book read). |
| `triggersNow` | A trigger order's trigger is already met at the mark, so it fires on arrival. |
| `takerSize`, `takerAvgPrice` | Size that fills in this transaction, and its average price (`null` when nothing fills). |
| `restingSize` | Size left resting in the book, or waiting outside it for a trigger order. |
| `laterFillOk` | Whether the resting remainder would pass its margin gate if it filled at today's mark; `null` when nothing rests. It is reserved in full at creation, so only a moved price, rate or funding can fail it. |
| `canceledSize`, `cancelReason` | Size canceled at the end of the walk, and why: `Unfilled`, `BelowMinimum`, `PostOnly`, `SelfMatch`, `StepLimit`, `Margin`, `PriceBand` or `PositionClosed`. |
| `realizedPnl`, `settledFunding` | Price PnL and funding realized on the size the order closes. |
| `fees` | The sum over every fill, with where it goes: `insurance`, `integrator`, `total`, and after the 1% bug-bounty skim `toInsuranceFund`, `toIntegrator`, `toBugBounty`. |
| `opens`, `reduces`, `closes`, `flips` | The order adds exposure; trades against the held position; leaves it flat; leaves it on the other side. |
| `margin` | The margin view (below). |
| `maxLeverage` | The most leverage a new position can take now: `10000 / imrBp`. |
| `mark` | The price the preview judged at. |
| `venueClosed` | A market with trading hours whose venue is closed; `null` when it cannot be told (no `publishTime` given). |
| `feeRates` | The taker rates used: `takerEbp` and `closingEbp` (1/100 bp), and the insurance fund's `coverageRatioBp` and `targetRatioBp` they come from. |

`margin`:

| Field | Meaning |
|---|---|
| `imrBp`, `mmrBp`, `effectiveMmrBp` | Initial and maintenance margin rates, and the maintenance rate liquidation judges by (the lower of the current one and a non-zero 24-hour lagged one). |
| `initialMargin` | Initial margin on the resulting position. |
| `requiredCollateral` | What `createOrder` requires of collateral; 0 when it does not judge this order (a TP/SL, or an order that adds no exposure beyond the held position). |
| `collateral` | The account's collateral now. |
| `ok`, `shortfall` | Whether the collateral covers the requirement, and by how much it falls short. |
| `retainedFloorBp`, `retainedFloor` | The collateral the resulting position must keep as cash (unrealized profit does not count): the maintenance rate on 24/7 markets, the initial rate on markets with trading hours. Withdrawals stop there. |

A `PositionView` (`before`, `after`, `afterArrival`):

| Field | Meaning |
|---|---|
| `isLong`, `size`, `entryValue`, `entryPrice` | The position; `entryPrice` is `entryValue / size`, 0 when flat. |
| `collateral`, `entryFundingIndex` | As the pair would store them. |
| `notional`, `unrealizedPnl`, `fundingPnl`, `equity` | Valued at the mark. |
| `maintenanceRequired`, `isSolvent` | The maintenance requirement at the effective rate, and whether equity covers it. |
| `liquidationPrice` | Estimated (see [liquidationPrice](#fees-margin-and-liquidation)). |
| `leverage` | Notional over equity; `null` when flat or without positive equity. |

A `PreviewIssue` names the custom error the pair would revert with (`error`, its ABI name), its `args`,
and `message`, the same user message a decoded revert shows ([Errors & Messages](errors.md)). For a
freeze, `until` is when it lifts at the latest (unix seconds) when known.

### Orders That Rest

```ts
{{#include ../../examples/trading/previews.ts:preview-limit}}
```

For a Limit order the preview walks what crosses now, then treats the remainder: it rests (and is
assumed to fill later at its limit, as maker, which `after` includes), or is canceled (IOC, post-only,
a remainder under $5). A trigger order that has not fired is previewed at its trigger price, with
`assumed` fills.

## previewWithdrawal

`bz.previews.previewWithdrawal(pair, account, amountBazaar?, opts?)` gives the most the account can
withdraw now and every freeze that applies, and, given an amount (BAZAAR precision), whether it goes
through:

```ts
{{#include ../../examples/trading/previews.ts:preview-withdrawal}}
```

`opts.price` is the price the call will carry (`{ spot, low?, high?, publishTime? }`); a position is
valued at the conservative edge of it, a long at `low` and a short at `high`, as the pair values a
withdrawal. A negative amount throws `InputError`.

| Field | Meaning |
|---|---|
| `maxWithdrawable` | The largest amount `withdrawCollateral` accepts now, from `BazaarPairLens.getMaxWithdrawable` at the conservative price. Exact for that price. 0 while a freeze applies. |
| `collateral` | The account's collateral on the pair. |
| `ledgerAvailable` | The pair's deposits ledger: no withdrawal may exceed it. |
| `hasPosition`, `activeOrders` | Whether the account holds a position, and how many live orders it has. |
| `priceUsed` | The price the ceiling was computed at; `null` for an account the pair does not price (flat with no orders, or a terminated pair). |
| `venueClosed` | As in `previewOrder`. |
| `freezes` | What stops withdrawals now, each a `PreviewIssue` with `until` when known. See [Withdrawal Freezes](collateral.md#withdrawal-freezes). |
| `amount` | The amount asked about, or `null`. |
| `ok` | Whether that amount goes through; `null` without an amount. |
| `blocker` | The `PreviewIssue` the pair would raise for it, or `null`: the first freeze, else the ceiling it runs into, in the order the pair checks them (insolvency, the collateral itself, the retained floor, initial margin after the withdrawal, the ledger). Which ceiling binds is re-derived with the pair's arithmetic, so it is an estimate when the price moves before the call lands. |
| `terminal` | On a terminated market, the lens's terminal entitlement: `collateral`, `registeredClaim`, `principalRatio`, `profitRatio`, `payout`. `null` otherwise. |

## Running the Arithmetic Yourself

`previews.simulateOrder(input)` is `previewOrder` without the reads: it applies `createOrder`'s
validation, its margin check, the arrival walk against `book` (per-fill fees, margin gates and the
position after each fill), and the remainder's disposal, and returns an `OrderPreview` (the result above
without `mark`, `venueClosed` and `feeRates`). Read the state once, then call it as often as a slider
moves:

```ts
{{#include ../../examples/trading/previews.ts:simulate-order}}
```

| `SimulateInput` field | Meaning |
|---|---|
| `order` | The order, as for `previewOrder`. |
| `account`, `integrator` | The trader (to detect self-matches) and the default integrator for the fees. |
| `bucket` | The position as the pair stores it: `isLong`, `size`, `entryValue`, `collateral`, `entryFundingIndex`, optionally the TP and SL ids. An account snapshot's `position` fits. |
| `mark` | The price the call resolves. |
| `fundingIndex` | The funding index the call will see. A market snapshot's `funding.projectedIndex` is the index a price stored now would leave. |
| `rates` | `MarginRates`: `imrBp`, `mmrBp`, `laggedMmrBp`. |
| `fees` | `TakerFeeRates`: `takerEbp`, `closingEbp` (from `takerInsuranceFeeRates`, or a full preview's `feeRates`). |
| `continuous` | A 24/7 market (`true`) or one with trading hours. |
| `stale` | The call would run on the stale fallback (venue closed). |
| `book` | The opposite side of the book, best first, as `BookMaker`s (`orderId`, `owner`, `price`, `remaining`, `expiryBlock`). Without it, fills are assumed at `fillPrice`. |
| `currentBlock` | The block the book's expiries are judged at. |
| `resting`, `activeOrders` | The account's resting orders reserved at the mark (`restingReserve`), and how many it has (for the 32-order cap). |
| `fillPrice` | The assumed fill price without a book, or for a trigger order that has not fired. |
| `beforeState` | The account's current state from the lens, for `before`. |

### Fees, Margin and Liquidation

```ts
{{#include ../../examples/trading/previews.ts:helpers}}
```

| Helper | What it computes |
|---|---|
| `liquidationPrice(pos, fundingIndex, rates)` | Where the position's equity meets its maintenance requirement at the effective rate. A long is liquidatable below it, a short above. `null` for a flat position or a long whose collateral covers its whole entry value; 0 for a short insolvent at any price. An estimate: funding accrues and rates move. |
| `maxLeverage(imrBp)` | `10000 / imrBp`, or `null` when `imrBp` is 0. |
| `takerFillFee(size, price, orderIsLong, position, rates, hasIntegrator)` | One taker fill's fee: the insurance leg at the dynamic rate (the closing rate on the part that reduces the position) and the integrator leg at 0.25 bp. |
| `makerFillFee(size, price, hasIntegrator)` | One maker fill's fee: 0.25 bp insurance, plus 0.25 bp integrator when the order carries one. |
| `feeBreakdown(fee)` | Where a fee goes: 1% of each leg to the bug bounty, the rest to the insurance fund and the integrator. |
| `takerInsuranceFeeRates(coverageRatioBp, targetRatioBp)` | The taker's insurance rates from the fund's coverage: the base rate at or above target, rising as `1 + 49 × shortfall²` below it, capped at 50 bp. |
| `takerInsuranceFeeBase(targetRatioBp)` | The base rate: 0.75 bp at a 2% target, rising linearly to 4.25 bp at 10%. |
| `positionState(pos, price, fundingIndex, rates)` | The pair's own valuation of a position (`BucketLib.calculateState`). |
| `applyFill(pos, orderIsLong, size, price, fee, fundingIndex)` | One fill's effect on a position: realized PnL, settled funding, a flip. |
| `fillMarginOk(...)` | The per-fill margin gate (`_checkMargin`). A refused fill auto-cancels the order (cancel reason `Margin`). |
| `creationGate(order, pos, state, mark, imrBp, resting)` | What `createOrder` requires of collateral, and whether the account has it. |
| `restingReserve(orders, mark)`, `fillDebit(...)`, `worstCaseNotional(...)` | How the pair reserves an account's resting orders. |

Rates are in EBP, 1/100 of a basis point (`EBP_SCALE` = 1,000,000). The constants they use are exported
too (`MAKER_INSURANCE_FEE_EBP`, `TAKER_INSURANCE_FEE_MIN_EBP`, `BUG_BOUNTY_TAX_BP`, ...).

## Related Pages

- [Placing Orders](orders.md) and [Collateral](collateral.md): the calls these preview.
- [Accounts & Portfolios](accounts.md): the account's live health between previews.
- [Markets](markets.md): margin rates, funding and the insurance fund on a market snapshot.
