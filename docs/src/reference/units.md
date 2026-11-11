# Units & Constants

This page is the reference for the SDK's units: which type and scale each kind of quantity uses, the
functions that convert between them, the constants a frontend or a bot needs (with their values), and
the values of order types, time in force and market status.

## The Rule

| Quantity | Type | Scale |
|---|---|---|
| Prices, sizes, notionals, collateral, PnL, fees, rewards, bounties, funding indices | `bigint` | 18 decimals ("BAZAAR precision"): `1e18` is $1, or one unit of the traded asset |
| USDC as the token counts it: wallet balances, allowances, approvals, permits, bonds named `..._USDC` | `bigint` | 6 decimals: `1_000_000n` is 1 USDC |
| Rates and fees in basis points (`imrBp`, `maxSlippageBp`) | `bigint` | `10_000n` is 100% |
| Rates in "extended" basis points (`..._EBP`) | `bigint` | `1_000_000n` is 100% |
| Funding rates per hour, terminal payout ratios | `bigint` | 18 decimals: `1e18` is 100% |
| Times (Unix seconds), durations (seconds), block numbers, counts, enum values | `number` | |
| An order spec's `expirationBlock` | `bigint` | A block number, but a `bigint`: take-profit and stop-loss orders carry 2^64 − 1 ("never"), which a `number` cannot hold |
| Display ratios: margin ratio, leverage, confidence in bp | `number` | |

The pair takes and reports amounts in 18 decimals and floors what it moves to whole micro-USDC
(multiples of `1e12`). A name says USDC when an amount is in 6 decimals; any other amount is in 18.
`bigint` values do not survive `JSON.stringify`: convert them to decimal strings first.

## Parsing and Formatting

```ts
{{#include ../../examples/reads/units.ts:parse}}
```

```ts
{{#include ../../examples/reads/units.ts:format}}
```

| Function | Does |
|---|---|
| `parseUnits18(text)` | A decimal string ("12.5", "-0.75", ".5") to 18 decimals. Throws `UnitError` on anything else: an exponent, a `+`, a thousands separator, more than 18 decimals. Surrounding spaces are ignored. |
| `formatUnits18(value, maxDecimals?)` | 18 decimals to a decimal string, trailing zeros trimmed; `maxDecimals` cuts toward zero (never rounds up). |
| `parseDecimal(text, decimals = 18)`, `formatDecimal(value, decimals = 18, maxDecimals?)` | The same at any number of decimals. |
| `toNumber18(value)` | A JavaScript `number`, for display and charts only (loses precision past 2^53 / 1e18). |
| `bpToFraction(bp)` | Basis points as a fraction (`250n` is `0.025`), for display. |

The `format` namespace has the formatters the SDK's own messages use:

| Function | Example |
|---|---|
| `format.formatUsd(amount)` | "$1,234.50"; amounts under a cent keep six decimals |
| `format.formatPrice(price)` | "$3,012.50", "$1.08765", "$0.00001234": decimals by magnitude |
| `format.formatAmount(quantity, maxDecimals = 6)` | "1.25", "12,000" |
| `format.formatBp(bp)` | "2.5%" |
| `format.formatEth(wei)` | "0.0001 ETH" |
| `format.formatDuration(seconds)` | "45 s", "50 min", "3 h", "13 days" |
| `format.formatTime(unixSeconds, now?)` | "2026-11-08 14:00 UTC (in 3 h)" |

## USDC Conversions

```ts
{{#include ../../examples/reads/units.ts:usdc}}
```

| Function | Does |
|---|---|
| `toUsdcUnits(amount)` | 18 decimals to USDC units, floored as the pair floors it. |
| `toUsdcUnitsCeil(amount)` | 18 decimals to USDC units, rounded up: for an allowance or a permit that must cover a pull. |
| `fromUsdcUnits(units)` | USDC units to 18 decimals. |
| `floorToUsdc(amount)` | 18 decimals floored to a multiple of `1e12`: what the pair actually moves. |
| `allowance.formatUsdcUnits(units)` | USDC units as a decimal string ("12.5"). |

`PreparedCall.pullsUsdc` is in 18 decimals; `allowance.usdcFunding(owner, pair, pull)` converts it and
compares it with the wallet's balance and allowance.

## Constants

Exported from the package, each named after the Bazaar constant it copies. The SDK reads a value from
the chain wherever the lens exposes it; these are for planning, validation and display.

### Scales

| Constant | Value |
|---|---|
| `BAZAAR_SCALE` | `10n ** 18n` |
| `BP_SCALE` | `10_000n` |
| `EBP_SCALE` | `1_000_000n` |
| `USDC_DECIMALS` | `6` |
| `USDC_TO_BAZAAR` | `10n ** 12n`: 18 decimals carry twelve more than USDC |
| `BAZAAR_EXPONENT` | `-18`: the oracle's price exponent |
| `MAX_UINT256` | `2n ** 256n - 1n` |
| `ZERO_ADDRESS` | `0x0000000000000000000000000000000000000000` |

### Trading

| Constant | Value | Meaning |
|---|---|---|
| `MAX_PRICE_STALENESS` | `3` | Seconds a Pyth print may sit from the block's timestamp. |
| `LIMBO_LEAD` | `6` | Seconds before a scheduled cutoff at which trading halts. |
| `MIN_ORDER_AMOUNT` | `5n * BAZAAR_SCALE` | $5: the smallest order notional (a full close is exempt). |
| `MIN_COLLATERAL_DEPOSIT` | `5n * BAZAAR_SCALE` | 5 USDC: the smallest deposit. |
| `MAX_WALK_STEPS` | `32` | Resting orders an arriving order's walk visits at most (the default budget). |
| `MAX_TRIGGER_EXECS_PER_CALL` | `20` | Trigger orders one `executeTriggeredOrders` fires. |
| `MAX_CONFIDENCE_BP` | `200n` | 2%: the widest Pyth confidence the oracle accepts. |
| `TRIGGER_PRICE_MASK` | `2n ** 128n - 1n` | A trigger order's price sits in the low 128 bits of its `triggerPrice` word, its keeper bounty in the high 128. |
| `ETH_USD_FEED` | `0x0000...0002` | Pyth Pro's ETH/USD feed (feed 2, as a `bytes32`), used to price gas. |

On the `orders` namespace:

| Constant | Value | Meaning |
|---|---|---|
| `orders.MAX_SLIPPAGE_BP` | `1000n` | 10%: the widest slippage cap of a Market, TakeProfit or StopLoss order. |
| `orders.MAX_PLACEMENT_DEVIATION_BP` | `5000n` | A limit price must sit within ±50% of the oracle price. |
| `orders.MIN_ORDER_LIFETIME_BLOCKS` | `240` | About a minute of Arbitrum blocks: the shortest life of an order that rests. |
| `orders.EXPIRY_LANDING_MARGIN_BLOCKS` | `40` | Slack the SDK adds to the minimum when it checks an expiry. |
| `orders.MAX_ORDER_LIFETIME_BLOCKS` | `126_144_000` | About a year; a later expiry is clamped by the pair. |
| `orders.NEVER_EXPIRE_BLOCK` | `2n ** 64n - 1n` | The expiry the pair stamps on TP and SL orders. |
| `orders.L2_BLOCKS_PER_SECOND` | `4` | Arbitrum's block rate, for `orders.blocksIn(seconds)`. |
| `orders.MAX_ACTIVE_LIMIT_ORDERS_PER_USER` | `32` | Live Limit (GTC) and StopLimit orders per account per market. |
| `orders.MAX_AMENDS_PER_CALL` | `32` | Amendments per `amendOrders`. |
| `orders.MAX_CANCELS_PER_CALL` | `200` | Order ids per `cancelOrders`. |
| `orders.CLOSE_POSITION` | `MAX_UINT256` | The size of a TP or SL that closes the whole position. |
| `orders.AMEND_BEST_EFFORT_BIT` | `2n ** 192n` | The flag in an amendment's id word that skips rather than reverts. |

### Gasless Calls and Permits

| Constant | Value | Meaning |
|---|---|---|
| `signing.MAX_RELAYER_FEE` | `BAZAAR_SCALE` | $1: the most a relayer may charge per action. |
| `signing.MAX_DEADLINE_WINDOW` | `10` | Seconds a gasless signature may be valid past chain time. |
| `signing.MAX_CLOCK_SKEW` | `120` | Seconds this device's clock may differ from the chain's before signing is refused. |
| `permits.DEFAULT_PERMIT_WINDOW` | `1800` | Seconds a USDC permit is valid by default. |

### Markets and Prices

| Constant | Value | Meaning |
|---|---|---|
| `markets.VENUE_CLOSED_AFTER` | `15` | Seconds without a print before a trading-hours venue counts as closed. |
| `markets.MAX_FUNDING_RATE_CONTINUOUS` | `BAZAAR_SCALE / 1000n` | 0.1% an hour: the funding cap on 24/7 markets. |
| `markets.MAX_FUNDING_RATE_SESSION` | `BAZAAR_SCALE / 200n` | 0.5% an hour: the cap on trading-hours markets. |
| `priceFeeds.BROWSER_FUTURE_SKEW` | `120` | Seconds a live print may be dated ahead of this device's clock. |
| `MAX_FUTURE_SKEW` | `5` | The same, for `PriceService` (the keeper's default). |

### Liquidation, ADL, Settlement

Mostly the keeper's concern, exported for completeness:

| Constant | Value | Meaning |
|---|---|---|
| `LIQUIDATION_FEE_EBP` | `200n` | 2 bp. |
| `MIN_LIQUIDATOR_REWARD` | `BAZAAR_SCALE / 20n` | $0.05. |
| `MAX_LIQUIDATION_PRICE_AGE` | `600` | Seconds a stored price may be old and still seize collateral. |
| `UNLOAD_BOUNTY_MIN` | `BAZAAR_SCALE / 4n` | $0.25. |
| `UNLOAD_BOUNTY_MIN_NOTIONAL` | `1_250n * BAZAAR_SCALE` | $1,250. |
| `UNLOAD_FLOOR_DECAY` | `180` | Seconds. |
| `ADL_AUCTION_DURATION` | `600` | Seconds the ADL score threshold takes to decay to its floor. |
| `ADL_MAX_SCORE` | `25n * BAZAAR_SCALE` | |
| `ADL_TIMEOUT_DURATION` | `86_400` | Seconds an ADL window may stay open. |
| `ADL_TERMINATION_GRACE` | `1_800` | Seconds after an ADL timeout before it may terminate the pair. |
| `MAX_ADL_WINNERS_PER_BATCH` | `25` | |
| `REFRESH_BOUNTY` | `BAZAAR_SCALE / 10n` | $0.10. |
| `REFRESH_BOUNTY_MIN_GAP` | `300` | Seconds. |
| `REFRESH_BOUNTY_HEARTBEAT` | `86_400` | Seconds. |
| `REFRESH_BOUNTY_FAST_MIN_INSURANCE` | `5_000n * BAZAAR_SCALE` | $5,000. |
| `REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE` | `1_000n * BAZAAR_SCALE` | $1,000. |
| `TERMINAL_SETTLEMENT_TIP` | `BAZAAR_SCALE / 20n` | $0.05 per position settled. |
| `TERMINAL_SETTLEMENT_ESCAPE` | `14 * 86_400` | Seconds: the longest a settlement window lasts. |
| `ORACLE_DEAD_THRESHOLD` | `21 * 86_400` | Seconds without a stored price before a pair counts as stale. |
| `SETTLEMENT_SAMPLE_COUNT`, `SETTLEMENT_SAMPLE_SPACING` | `5`, `600` | The chain rule's samples and their spacing (seconds). |
| `SETTLE_NOTHING`, `SETTLE_TICK`, `SETTLE_CHAIN`, `SETTLE_AWAIT_VERDICT` | `0` to `3` | Settlement rules. |

What each of these governs is in Bazaar's [Parameters](https://docs.bazaar.finance/reference/parameters.html).

## Order Types, Time in Force, Status

```ts
{{#include ../../examples/reads/units.ts:orders}}
```

| `OrderType` | Value | Also exported as |
|---|---|---|
| `Market` | `0` | `MARKET` |
| `Limit` | `1` | `LIMIT` |
| `StopLimit` | `2` | `STOP_LIMIT` |
| `TakeProfit` | `3` | `TAKE_PROFIT` |
| `StopLoss` | `4` | `STOP_LOSS` |

`ORDER_TYPE_NAMES[type]` gives the name; `TRIGGER_TYPES` lists the three trigger types.

| `orders.TimeInForce` | Value | Meaning |
|---|---|---|
| `GTC` | `0` | Rest the remainder in the book (only Limit and StopLimit rest). The default. |
| `IOC` | `1` | Fill what crosses on arrival, cancel the rest. Limit only. |
| `FOK` | `2` | Fill the whole size on arrival or revert. Limit and Market only. |

`orders.TIF_NAMES[tif]` gives the name. The rules for each are in
[Orders](https://docs.bazaar.finance/protocol/orders.html).

| `Status` | Value |
|---|---|
| `Status.Live` | `"live"` |
| `Status.Adl` | `"adl"` |
| `Status.Limbo` | `"limbo"` |
| `Status.Settling` | `"settling"` |
| `Status.Terminated` | `"terminated"` |

What each status means is on [Markets](../sdk/markets.md#status).

## Related Pages

- [Core Concepts](../getting-started/concepts.md#units)
- [Placing Orders](../sdk/orders.md)
- [Collateral, Approvals & Permits](../sdk/collateral.md)
- [API Index](api.md)
