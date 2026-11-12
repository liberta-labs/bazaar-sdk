# Live Prices

This page covers showing prices that move: `LivePrices`, a stream of every market's composed Pyth
price with freshness and venue flags; reading Pyth Pro directly; and `PriceService`, the engine under
both the stream and the keeper.

Prices on the chain and prices on screen differ. A snapshot reports the pair's *stored* price, which
moves only when a transaction stores a new one; a live price is Pyth's newest print, composed the way
the pair's oracle would compose it. Every on-chain price check uses the print a call carries (see
[The 3-Second Price Window](sending.md#the-3-second-price-window)).

The samples assume `bz` connected as in [Connecting](connecting.md) with a Pyth Pro price source, and
`eth` a market. `PRICES` are the client options: the API key on a server, or a proxy of your own that
adds it. A web page holds no key: it shows the prices a server of yours publishes from a stream like
this one.

## LivePrices

```ts
{{#include ../../examples/reads/live-prices.ts:stream}}
```

`bz.livePrices(options?)` lists the connection's markets and streams them through the connection's
Pyth Pro client: one subscription per market, on every stream endpoint at once, so each market's
signed update carries exactly its own feeds (both legs of a composite in one update) and a dropped
endpoint interrupts nothing. Before the stream it makes one request for every feed's latest print, so
every market shows a price at once; `ready` settles when that request has answered or failed. When
the stream fails three times in a row, it polls for a minute, then tries the stream again.

The stream runs over a WebSocket. Browsers and Node 22 and later have one; on Node 20 give the client
a constructor (`new ProClient({ token, WebSocket })`, with the `ws` package's, say).

Everything a render needs is read from memory:

| Method | Returns |
|---|---|
| `price(market)` | The market's `MarketPrice`, or `null` while a feed has no print yet (or the market is not watched). |
| `all()` | A `Map` from address to `MarketPrice`, for every market with one. |
| `fresh(market)` | Whether the price is inside the pair's 3-second window and its confidence clears the 2% cap. |
| `venueClosed(market)` | Whether a trading-hours market's venue is closed. Always `false` for a 24/7 market. |
| `subscribe(listener, markets?)` | Calls `listener` with a `Map` of the markets whose price changed after each batch of prints, and of those whose `fresh` or `venueClosed` flipped as time passed (checked every `tickMs`). Only `markets` when given. Returns the function that unsubscribes. |
| `add(markets)` | Streams these markets too (already watched ones are ignored). |
| `markets()` | The markets being streamed. |
| `stop()` | Ends the stream, the ticker and every subscription, for good. |
| `service` | The `PriceService` underneath: its `healthy`, `lastError` and raw `latest` prints are public. |

A listener is called synchronously, with a map it must not keep; a listener that throws does not stop
the others or the stream. Call `stop()` when the view unmounts (in a React effect's cleanup, say).

Each `MarketPrice` (18 decimals):

| Field | Meaning |
|---|---|
| `market` | The pair's address. |
| `spot` | The composed price. |
| `low`, `high` | Spot less and plus the confidence: what a long and a short are valued at when they withdraw. |
| `confidence` | The band's wider half: `max(high − spot, spot − low)`. |
| `confidenceBp` | `confidence / spot` in basis points, a `number` for display. |
| `confidenceOk` | Every leg, and the composed band, sit inside the oracle's 2% confidence cap. |
| `publishTime` | The second the older leg's price was generated in (Unix seconds): what the pair's window judges. |
| `age` | Seconds since `publishTime`, at the service's clock. |
| `fresh` | Every leg's price was generated at most 3 seconds from now, and `confidenceOk`: a call carrying this print would be accepted if it landed now. |
| `venueClosed` | A trading-hours market whose feed has generated no price for `closedAfter` seconds while the endpoint delivers. |
| `legs` | The feeds' prints (base first for a composite). |

**A price's age is when it was generated.** While a venue is shut Pyth keeps sending updates, each
stamped with the current time and carrying the last price forward. The update's own timestamp says
nothing about the price: `publishTime` is the second the price was *generated* in (Pyth's feed update
timestamp), which is what the pair's 3-second window judges and what `fresh`, `age` and `venueClosed`
use. A carried-forward price reads as old, as it should.

How the oracle composes a price, and why a closed venue matters, is in
[Oracle](https://docs.bazaar.finance/protocol/oracle.html).

### Options

```ts
{{#include ../../examples/reads/live-prices.ts:options}}
```

| Option | Default | Meaning |
|---|---|---|
| `closedAfter` | 15 | Seconds without a newly generated price after which a trading-hours market reads closed. |
| `tickMs` | 1000 | Milliseconds between re-checks of `fresh` and `venueClosed` for subscribers (0: never). |
| `reuseAge` | 1 | A stream update whose price was generated at most this many seconds ago is reused for a call (see [Prices for Calls](#prices-for-calls)). |
| `start` | `true` | Start streaming at once; with `false`, call `start()`. |
| `stream` | `true` | Follow the stream, falling back to polling when it fails. `false` polls only. |
| `streamIdleTimeout` | 10 | Seconds the stream may bring no new update before it is dropped and reconnected. `null` or 0 waits forever. |
| `pollInterval` | 1 | Seconds between polls when not streaming. |
| `maxFutureSkew` | 120 | Seconds a print may be dated ahead of this device's clock before it is ignored. See below. |
| `clock` | the system clock | The time freshness is judged at (Unix seconds). |
| `logger` | `console` | Where endpoint failures are reported (`warn`); `null` for silence. |
| `pro` | the connection's | Options for a `ProClient` of the stream's own (another token, another channel). |
| `client` | the connection's | A `ProClient` (or any `PriceSource`) to share. |

`PriceService`'s `sendMargin`, `ethUsdMaxAge` and `ethUsdBounds` are accepted too; they do not change
what `LivePrices` reports.

**The channel.** A client streams on one channel (default `fixed_rate@200ms`: an update every 200 ms
per subscription and endpoint). A page that only shows prices can stream `fixed_rate@1000ms` and still
fetch a fresh update when it builds a call. When the connection checks signers (the default), each
new update costs one signature recovery, so a slower channel is also lighter on a phone.

**The future-print skew.** A print dated far ahead of this device's clock would hold its feed until a
newer print arrived, so prints dated more than `maxFutureSkew` seconds ahead are ignored, with a
warning once per feed. The keeper's bound is 5 seconds; a browser's clock can run a minute slow, so
`LivePrices` allows 120 seconds (`BROWSER_FUTURE_SKEW`). A device clock that is far off also makes
`age` and `fresh` wrong: `fresh` judges against this device's clock, the pair against the block's.

### Without a Connection

`livePrices(markets, options)` streams the given markets (`MarketInfo`s, from a market list you
already have) through `client`, or through a client it makes from `pro`; with a context instead of
markets it lists them first, as `bz.livePrices` does. `new LivePrices(markets, source, options)` is
the constructor underneath. A connection whose price source is not a Pyth Pro source has no client to
stream from: pass `pro` or `client`, or `livePrices` throws a `ConnectError`.

### Prices for Snapshots

Pass a `LivePrices` as the `prices` option of `marketSnapshot`, `accountSnapshot`, `portfolio`,
`watchMarket` and `watchAccount`: they then value positions at the live price and judge venues from
the stream, with no request of their own.

### Prices for Calls

A `LivePrices` is also a `PriceUpdateSource`. Its `latest(feeds)` returns the stream's own update for
those feeds when every price in it was generated at most `reuseAge` seconds ago (no request), and
fetches one otherwise. Give it to a facade over the same context, and that facade's builders attach
the stream's updates:

```ts
{{#include ../../examples/reads/live-prices.ts:for-calls}}
```

The copied context has its own caches (it lists the markets again once), and its price source is not
a `proPriceSource`: keep the original `bz` for reads, which then still get the symbols registry and
venue checks from the connection's client. `updateFor(market)` returns the stream's current update
for one market, for code that encodes calls itself.

## Pyth Pro Directly

```ts
{{#include ../../examples/reads/live-prices.ts:pro}}
```

`proPriceSource(options | client)` is the connection's price source (see
[Connecting](connecting.md#prices)); its `prints(feedIds)` returns the parsed prints, for showing a
price without a stream. `ProClient` is the client underneath:

| Member | What it does |
|---|---|
| `new ProClient(options)` | The options of [Connecting](connecting.md#prices): `token`, `channel`, the URLs, `WebSocket`, `isTrustedSigner`. A token or header with a line break is refused at once. |
| `latest(ids)` | The latest prints for these feeds, all from one signed update (a feed without a usable live price is left out). |
| `latestUpdate(ids)` | The same update whole, as a `ProUpdate`: `blob`, `signer`, `timestampUs`, `channel`, every feed's entry (`feeds`), and its `prints`. |
| `atTick(ids, second)` | The one-second channel's update stamped exactly `second`, or `null` when there is none: what settlement proofs are made of. |
| `symbols({ query?, assetType? })` | Pyth Pro's symbols registry: each feed's number, symbol, asset type, fastest channel, state and schedule. Needs no token. |
| `stream(feeds, signal?, { idleTimeout?, onNotice? })` | An async iterator of print batches from every stream endpoint, each update yielded once. `feeds` is one set of feeds or a list of sets; each set is its own subscription. Aborting `signal`, `break`ing out of the loop or `close()` ends it. It throws a `ProError` when no endpoint can be reached, and when no new update arrives for `idleTimeout` seconds (default 10). |
| `close()` | Ends every open stream. |
| `displayUrl` | The request API's base URL with any key masked. |

A `Print` has `feedId` (the bytes32 form), `price`, `conf`, `expo`, `publishTime` (the second the price
was generated in), `generatedUs` (the same instant in microseconds), `timestampUs` and `channel` (the
carrying update's), `signer` (when signers are checked), `blob` (the signed update that carries it)
and `received`. Every field but `received` and `signer` is read from the update's signed payload,
never from the JSON an endpoint sends beside it; `signer` is recovered from its signature.

A feed gets a print only when its entry holds a usable live price: a price, an exponent, a confidence
above zero and a generation time. The oracle refuses a live update without any of them, so the SDK
never offers one to a call; `whyNotLive(entry)` says which is missing.

A response over 16 MiB, or a stream message over 1 MiB, is refused. Errors mask the token, header
secrets and any key in a URL.

## PriceService

```ts
{{#include ../../examples/reads/live-prices.ts:service}}
```

`PriceService` is the engine under `LivePrices` and the keeper's price loop: it holds the newest
print per feed and the newest update per watched set of feeds, and builds per-market prices and
updates from them. Use it when `LivePrices` is too much (a server that tracks a few feeds) or too
little (custom freshness margins).

| Member | What it does |
|---|---|
| `new PriceService(source, options?)` | `source` is a `ProClient` or any `PriceSource` (`latest` and `stream`). Options as in the table above, plus `sendMargin` (default 1). The default `maxFutureSkew` here is 5 seconds. |
| `watchMarkets(markets)`, `watchSets(sets)`, `watch(feeds)` | Watch each market's legs (or each set) as one subscription, or each feed on its own; the stream resubscribes at once. ETH/USD is always watched (the keeper prices gas with it). |
| `run()` | Follow the stream (or poll) until `stop()`, through any failure: three in a row mark it unhealthy and switch to polling for a minute. Never rejects. |
| `fetch(feeds?)` | The latest prints, outside the loop: one request per 255 feeds, and a request the endpoint refuses (HTTP 403) asked again in parts, so a feed the token does not cover fails only the markets on it. |
| `ingest(prints)` | Take in prints from anywhere. |
| `onPrints(listener)` | Called after each batch with the feeds that got a newly generated price; returns the remover. |
| `nextPrints()` | Waits for the next newly generated price (one consumer only). |
| `price(market)`, `legs(market)` | The composed `PairPrice` (`spot`, `low`, `high`, `publishTime`, `confidenceOk`) and the prints, or `null`. |
| `fresh(market, now?, margin?)` | Every leg's price generated within `3 − margin` seconds of `now` (default margin: `sendMargin`), and the confidence clears the cap. |
| `closed(market, now?, after?)` | No price generated for `after` seconds (default 15) while the service is healthy. |
| `updateFor(market)` | The signed update a call on the market attaches: the one update that carries its legs. |
| `printsFor(feeds)` | The prints a call reading these feeds together would attach. |
| `latestFor(market)` | The prints of the most recently issued update the service holds for the market's legs, however old their prices (each print's `timestampUs` is when its update was issued), or `null`. |
| `liquidationUpdate(market, now?, margin?)` | What a liquidation on the market attaches now: a fresh price's update (`kind: "fresh"`), else on a market with trading hours Pyth's latest one when it was issued within `3 − margin` seconds of `now` and its price at most 57 seconds before that (`kind: "latest"`), else nothing (`kind: null`) and `reason`. See [Low-Level Building Blocks](low-level.md#priceservice). |
| `ethUsd(now?)` | USD per ETH from the newest ETH/USD print, or `null` when stale or out of bounds. |
| `missing()` | Watched feeds with no print yet. |
| `healthy`, `lastError`, `lastUpdate`, `latest` | State, readable. |
| `stop()` | Ends `run` and its stream. |

A market prices from its own set's update, so a call attaches one update and pays one verification
fee. Only while its set has none, or lags another update's price for one of its legs by a second or
more, does it fall back to each leg's newest print (one update per leg).

The per-market methods take the SDK's `Market` model: `marketFromStatic(info)` makes one from a
`MarketInfo`.

## What Can Go Wrong

| What | Why |
|---|---|
| `ConnectError`: `live prices need a Pyth Pro source: ...` | The connection's price source is not a Pyth Pro source and no `pro` or `client` was given. |
| `ProError`: `this runtime has no WebSocket ...` | Node before 22: give the client a WebSocket constructor. |
| `price()` stays `null` | A feed has no print: Pyth has no usable price for it (a warning names the feed), or `ready` has not settled. |
| Warning: `price endpoint sent no print for feed 0x...` | The feed ID is wrong, the token does not cover the feed, the feed is not served on the channel, or Pyth has no price or no confidence for it. Other feeds are unaffected. |
| Warning: `price endpoint refused feed N while serving the others: left out of its requests for 5 min (...)` | Pyth's request API refuses a whole request that names a feed it does not know or the token does not cover. The service asked again in parts and leaves that feed out of its requests for 5 minutes; markets on it get no price meanwhile, and the others are unaffected. |
| Warning: `price stream refused the subscription for feed(s) ...` | What Pyth answered to a subscription, passed on once. |
| Warning: `price stream endpoint ... dropped (...): reconnecting` | One endpoint went away; the others keep delivering. |
| Warning: `ignored a print for feed 0x... dated N s ahead of the clock` | This device's clock is behind, or the endpoint is wrong. |
| `fresh` is `false` while prices move | This device's clock is off, or the confidence is above 2% (`confidenceOk`). |
| `ProError`: `price endpoint refused the request (HTTP 401); check the token (prices.token) ...` | The token is wrong, expired, or not entitled to these feeds or this channel. |
| `ProError`: `a price update is signed by 0x..., which is not a signer Pyth's verifier trusts: refusing it` | The update did not come from Pyth, or the deployment's verifier no longer trusts that signer. |
| `service.healthy` is `false` | Three failures in a row; `service.lastError` says why. It keeps retrying. |

## Related Pages

- [Connecting](connecting.md#prices)
- [Markets](markets.md), [Accounts & Portfolios](accounts.md)
- [Live Updates](live-updates.md)
- [Sending Transactions](sending.md#the-3-second-price-window)
- [Low-Level Building Blocks](low-level.md)
