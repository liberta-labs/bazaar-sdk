# API Index

Every public export of the two packages, one line each, with a link to the page that covers it. The
index is built from the packages' sources (`packages/sdk/src/index.ts`, `packages/keeper/src/index.ts`
and every module they re-export), so it lists exactly what an `import` can reach. The descriptions come
from each export's own documentation comment; the TSDoc in the source, which your editor shows on
hover, has the full text.

## How to Read This Index

- **Export** is the name as you import it. A dotted name lives in a namespace:
  `history.trades` is `import { history } from "@liberta-labs/bazaar-sdk"`, then `history.trades(ctx, ...)`.
  The link goes to the page that explains it.
- **Kind** is what the export is. `const + type` is a value and a type of the same name (`OrderType`,
  `Status`, the keeper's zod schemas). **bz** marks a function that is also on the `Bazaar` object
  with the connection bound: `bz.history.trades(...)` is `history.trades(bz.ctx, ...)`.
- Amounts are `bigint` in 18 decimals (BAZAAR precision) unless a name says USDC (6 decimals); times,
  blocks and counts are `number`. See [Units & Constants](units.md).

A namespace keeps the area's names from colliding: `orders.OrderInput` and `previews.OrderInput` are two
different types, and so are `SubgraphError` (the low-level client's) and `history.SubgraphError` (the
history queries').

## `@liberta-labs/bazaar-sdk`

```ts
import { Bazaar, OrderType, parseUnits18, errorMessage } from "@liberta-labs/bazaar-sdk"; // flat exports
import { history, termination } from "@liberta-labs/bazaar-sdk";                          // namespaces
```

### The `Bazaar` Object

`Bazaar.connect(options)` returns one object with the connection bound to every context-first function
of every area. Its members:

| Member | What it is |
|---|---|
| [`Bazaar.connect(options)`](../sdk/connecting.md) | Connect to a deployment: reads its wiring from the factory and checks the chain. `options` is `BazaarOptions`. |
| [`Bazaar.from(ctx)`](../sdk/connecting.md) | Wrap a context you already have (from `connect`). |
| [`bz.ctx`](../sdk/connecting.md) | The `BazaarContext`: chain, chain id, deployment addresses, price source, subgraph, integrator. |
| [`bz.chainId`](../sdk/connecting.md) | The connected chain's id. |
| [`bz.deployment`](../sdk/connecting.md) | `{ factory, lens, terminator, oracle, usdc }`. |
| [`bz.simulate(call, opts?)`](../sdk/sending.md) | Run a prepared call as the user without sending it (`simulate`); `opts.from`, `opts.estimateGas`. |
| [`bz.send(wallet, call, opts?)`](../sdk/sending.md) | Send through an EIP-1193 wallet (`sendCall`); returns the transaction hash. |
| [`bz.waitForReceipt(hash, opts?)`](../sdk/sending.md) | Poll for the receipt (`waitForReceipt`); throws `CallError` if it reverted. |
| [`bz.livePrices(opts?)`](../sdk/live-prices.md) | Live prices for the listed markets (`livePrices`). |
| `bz.markets`, `bz.account`, `bz.live`, `bz.orders`, `bz.trade`, `bz.insurance`, `bz.signing`, `bz.permits`, `bz.allowance`, `bz.relay`, `bz.batching`, `bz.history`, `bz.previews`, `bz.termination`, `bz.listings`, `bz.governance`, `bz.uma` | Each area's context-first functions, bound: the rows marked **bz** below. The pure helpers stay on the namespaces. |

The list of bound functions is generated from the modules (`npm run gen-bindings`, see
[Development](development.md)), so a new context-first function appears on `bz` once the bindings are
regenerated.

### The Facade and the Connection

| Export | Kind | What it is |
|---|---|---|
| [`Bazaar`](../sdk/connecting.md) | class | The SDK bound to one connection: `Bazaar.connect(options)`, then `bz.<area>.<function>(...)` with the context already passed. |
| [`BazaarOptions`](../sdk/connecting.md) | interface | What `Bazaar.connect` takes: `ConnectOptions`, with `prices` also accepted as Pyth Pro client options or a `ProClient`, and `subgraph` as a URL or `{ url, apiKey }`. |
| [`requirePair`](security.md) | function | `pair`, checksummed, once the context's factory confirms it is one of its pairs (`factory.isPair`); an `InputError` on `pair` otherwise. |
| [`NetworkPreset`](../sdk/connecting.md) | interface | A built-in network: name, chain id, factory (null until launch), start block, subgraph URL, whether official, and the sequencer URL. |
| [`NETWORKS`](../sdk/connecting.md) | const | The built-in networks: `arbitrum-one`, `arbitrum-sepolia` and `anvil`. |
| [`officialNetwork`](../sdk/connecting.md) | function | The network whose official deployment runs on a chain id, or null when that chain has none yet; what `connect` uses when no factory is given. |
| [`OfficialNetwork`](../sdk/connecting.md) | type | A `NetworkPreset` whose official deployment is live, so its `factory` is an address. |
| [`PRICE_ENDPOINTS`](../sdk/connecting.md) | const | `prices.endpoint` shortcuts, each a set of Pyth Pro endpoints: `pyth`, Pyth's own, which need a Pyth Pro API key. |
| [`ProEndpoints`](../sdk/connecting.md) | interface | Where Pyth Pro is served: its stream endpoints, its request API, and its symbols registry. |
| [`PYTH_PRO`](../sdk/connecting.md) | const | Pyth's own Pyth Pro endpoints: their request API and stream serve only the holder of a Pyth Pro API key. |
| [`isPythProPriceEndpoint`](../sdk/connecting.md) | function | Whether a URL is one of Pyth's own price endpoints (the host of `PYTH_PRO`'s request API or of one of its stream endpoints), which a `ProClient` serves only with a token. |
| [`connect`](../sdk/connecting.md) | function | Read the deployment's wiring from its factory (the chain's official one when none is given) and return a context bound to it. |
| [`requirePrices`](../sdk/connecting.md) | function | The context's price source; throws `ConnectError` when the context was connected without one. |
| [`requireSubgraph`](../sdk/connecting.md) | function | The context's subgraph source; throws `ConnectError` when the context was connected without one. |
| [`PriceUpdateSource`](../sdk/connecting.md) | interface | Signed Pyth Pro price updates, as the pair's calls carry them: `latest`, and optionally `atTick` and `useSignerCheck`. |
| [`verifierSignerCheck`](../sdk/connecting.md) | function | A `SignerCheck` that asks a deployment's Pyth verifier whether it trusts a signer, keeping each answer briefly. |
| [`VerifierSignerCheckOptions`](../sdk/connecting.md) | interface | Options of `verifierSignerCheck`: `ttl`, `maxAge` and `clock`. |
| [`VERIFIER_SIGNER_ABI`](../sdk/connecting.md) | const | The verifier's `isValidSigner` view. |
| [`SubgraphSource`](../sdk/connecting.md) | interface | A GraphQL endpoint serving Bazaar's subgraph. |
| [`BazaarContext`](../sdk/connecting.md) | interface | A connection: the `Chain`, the chain id, the deployment's addresses (factory, lens, terminator, oracle, USDC), and the optional price source, subgraph and integrator. |
| [`ConnectOptions`](../sdk/connecting.md) | interface | What `connect` takes: `transport`, and the optional `factory` (the chain's official one by default), `prices`, `subgraph` (the official subgraph by default, for the official factory), `integrator`, `chainId` and `checkSigners`. |
| [`ConnectError`](../sdk/connecting.md) | class | Connecting failed, or a call needs a price source or subgraph the context was connected without. |

### Calls, Price Updates and Units

| Export | Kind | What it is |
|---|---|---|
| [`simulate`](../sdk/sending.md) | function | Run the call as `from` (or call.from) without sending it. |
| [`toTransactionRequest`](../sdk/sending.md) | function | The call as a viem / wagmi transaction request. |
| [`sendCall`](../sdk/sending.md) | function | Send through an EIP-1193 wallet (eth_sendTransaction). |
| [`waitForReceipt`](../sdk/sending.md) | function | Poll for the receipt; throws CallError if it reverted or did not land in time. |
| [`buildAndSend`](../sdk/sending.md) | function | Build, then send at once: for calls carrying a price update, build as late as possible so the print is still inside the pair's 3 s window when the transaction lands. |
| [`PreparedCall`](../sdk/sending.md) | interface | A write ready to simulate and send: `action`, `to`, `data`, `value`, `summary`, `pullsUsdc` and the rest. |
| [`Simulation`](../sdk/sending.md) | interface | What `simulate` returns: `ok`, the return data, the decoded `error` (with its user message) and the gas estimate. |
| [`InputError`](../sdk/errors.md) | class | An argument a builder refused before building anything: `field` names it. |
| [`CallError`](../sdk/sending.md) | class | A send that reverted or was rejected, with the decoded reason when there is one. |
| [`pairFeeds`](../sdk/sending.md) | function | The pair's feeds. |
| [`priceUpdateFor`](../sdk/sending.md) | function | The freshest signed update for the pair's feeds, and the ETH fee the oracle charges to verify it. |
| [`updateFee`](../sdk/sending.md) | function | The ETH fee the oracle charges to verify a price update (`getUpdateFee`); 0 for an empty update. |
| [`PairFeeds`](../sdk/sending.md) | interface | A pair's price id and its raw Pyth legs (one, or base then quote for a composite) and whether the quote is inverted. |
| [`FreshUpdate`](../sdk/sending.md) | interface | What `priceUpdateFor` returns: the update bytes, the Pyth fee to send as value, and the oldest publish time among the legs. |
| [`liquidationUpdateFor`](../sdk/sending.md) | function | The update a liquidation attaches and its fee: a fresh price, or on a market with trading hours Pyth's latest one; never an empty update. |
| [`updateProblem`](../sdk/sending.md) | function | Why BazaarOracle would refuse an update for these legs whenever the call carrying it lands, or null when it would accept it in a block close enough to when its prices were generated. |
| [`pairContinuous`](../sdk/sending.md) | function | Whether the pair is continuously traded (`isContinuouslyTraded`), cached per context. |
| [`LiquidationPriceUpdate`](../sdk/sending.md) | interface | What `liquidationUpdateFor` returns: the update, the fee, `kind` (`"fresh"` or `"latest"`), the price's generation second and the second the call must land within 3 s of (`priceTime`). |
| [`NoLiquidationPriceError`](../sdk/errors.md) | class | A `ProError`: no update can decide a liquidation on a market with trading hours now (no fresh price, and Pyth's latest is too old or would be refused). `pair` and `reason` say which and why. |
| [`NoFreshPriceError`](../sdk/errors.md) | class | No update the oracle would accept is available for a continuously traded market, which has no stored-price fallback: a call that needs a price would revert now. |
| [`NoLivePriceError`](../sdk/errors.md) | class | A `ProError`: the endpoint answered, but its update holds no price a live call could use for a feed asked for. |
| [`toUsdcUnits`](units.md) | function | BAZAAR precision -&gt; USDC units, floored as the pair floors it. |
| [`fromUsdcUnits`](units.md) | function | USDC units -&gt; BAZAAR precision. |
| [`toUsdcUnitsCeil`](units.md) | function | BAZAAR precision rounded up to the next whole USDC unit (for allowances and permits that must cover it). |
| [`floorToUsdc`](units.md) | function | Floor to what the pair actually moves: a multiple of 1e12 (one micro-USDC). |
| [`parseDecimal`](units.md) | function | A decimal string ("12.5", "1e-3" is refused) -&gt; fixed point with `decimals` (default 18). |
| [`formatDecimal`](units.md) | function | Fixed point -&gt; decimal string, trimming trailing zeros; `maxDecimals` rounds toward zero. |
| [`UnitError`](units.md) | class | A decimal string or fixed-point value that cannot be converted (bad syntax, too many decimals). |
| [`parseUnits18`](units.md) | const | "12.34" dollars or units -&gt; BAZAAR precision. |
| [`formatUnits18`](units.md) | const | BAZAAR precision -&gt; "12.34". |
| [`bpToFraction`](units.md) | const | Basis points -&gt; a fraction as a number (for display only). |
| [`toNumber18`](units.md) | const | A BAZAAR-precision value as a JS number (display only: loses precision past 2^53 / 1e18). |

### Errors and Messages

Also exported as the `format` namespace below, with the formatters.

| Export | Kind | What it is |
|---|---|---|
| [`errorMessage`](../sdk/errors.md) | function | The text to show a user for any error a Bazaar call can throw. |
| [`installUserMessages`](../sdk/errors.md) | function | Register `USER_MESSAGES` so `DecodedError.message` returns them. |
| [`userMessage`](../sdk/errors.md) | function | The user-facing message for a custom error by name, with its arguments; the name itself when unknown. |
| [`walletErrorMessage`](../sdk/errors.md) | function | A message for a failure the wallet raised rather than the contract. |
| [`USER_MESSAGES`](../sdk/errors.md) | const | Every custom error's user-facing message, by error name. |
| [`REASON_MESSAGES`](../sdk/errors.md) | const | User-facing messages for the plain reason strings Pyth's verifier reverts with, by the string. |

### Live Prices

Also exported in the `priceFeeds` namespace below.

| Export | Kind | What it is |
|---|---|---|
| [`proPriceSource`](../sdk/live-prices.md) | function | The context's price source over Pyth Pro (Pyth's own endpoints, a proxy, or a local mock): `latest`, `atTick`, `prints`, and the client. |
| [`livePrices`](../sdk/live-prices.md) | function | Live prices for every market of a context (`listMarkets`), or for the markets given. |
| [`LivePrices`](../sdk/live-prices.md) | class | Live prices for a set of markets. |

## The Area Namespaces

One namespace per area of `@liberta-labs/bazaar-sdk`. Context-first functions take a `BazaarContext` (from `connect`, or `bz.ctx`) as their first argument.

### `markets`

`import { markets } from "@liberta-labs/bazaar-sdk"`. Market lists, snapshots, flags and the book.

| Export | Kind | What it is |
|---|---|---|
| [`markets.readerFor`](../sdk/markets.md) | function | The keeper's batched `Reader`, wired to the context's deployment (no factory read needed). |
| [`markets.listMarkets`](../sdk/markets.md) | function, bz | Every market the context's factory has deployed, in the factory's order, with its static facts and a label for display ("BTC/USD", "AAPL/USD"; a composite is labelled in USD). |
| [`markets.getMarket`](../sdk/markets.md) | function, bz | One market, by its address, its pair id, or its label (case-insensitive; labels come from the feeds' Pyth symbols, never from the subgraph's description). |
| [`markets.resolvePrices`](../sdk/markets.md) | function | Each market's live price and venue state. |
| [`markets.pastTradingCutoff`](../sdk/markets.md) | function | Whether `now` is in limbo: a cutoff is scheduled and the block is within LIMBO_LEAD of it (BazaarPair._pastTradingCutoff). |
| [`markets.marketFlags`](../sdk/markets.md) | function | The flags for a market state at `now` (a block timestamp), following the pair's own gates. |
| [`markets.annualizedFunding`](../sdk/markets.md) | function | A funding rate per hour (1e18 = 100%, as the lens reports it) as a yearly fraction for display (0.0876 = 8.76% a year). |
| [`markets.marketStatusAt`](../sdk/markets.md) | function | The snapshot's status at another time (seconds), for countdowns without a new read. |
| [`markets.adlScoreThresholdAt`](../sdk/markets.md) | function | The ADL auction's score threshold at another time, for a live display without a new read. |
| [`markets.headFor`](../sdk/markets.md) | function | The block to read at: the caller's, or the latest. |
| [`markets.marketSnapshots`](../sdk/markets.md) | function, bz | Several markets' live state at one block. |
| [`markets.marketSnapshot`](../sdk/markets.md) | function, bz | One market's live state at one block; see `marketSnapshots`. |
| [`markets.getBookDepth`](../sdk/markets.md) | function, bz | The best `levels` price levels of one side of the book. |
| [`markets.getBook`](../sdk/markets.md) | function, bz | Both sides of the book, read together; see `getBookDepth`. |
| [`markets.TradingHours`](../sdk/markets.md) | type | "24/7" for a continuously traded market; "trading-hours" for one that follows its venue's calendar (stocks, FX). |
| [`markets.MarketInfo`](../sdk/markets.md) | interface | What never changes about a market: what a market list and a market header show. |
| [`markets.MarketRef`](../sdk/markets.md) | type | A market as callers name it: its info, its pair address, its pair id, or its label. |
| [`markets.SymbolSource`](../sdk/markets.md) | interface | Where feed symbols come from: a symbols registry's base URL, or anything that lists its entries (`symbols()`). |
| [`markets.ListMarketsOptions`](../sdk/markets.md) | interface | Options of `listMarkets`: `refresh` (read the factory's pair list again) and `metadata` (where feed symbols come from). |
| [`markets.VENUE_CLOSED_AFTER`](../sdk/markets.md) | const | Seconds a trading-hours market's feed may go without a print, while the price endpoint is otherwise delivering, before its venue counts as closed (PriceService.closed's default). |
| [`markets.HeldPrice`](../sdk/markets.md) | interface | A price a caller already holds, in BAZAAR precision. |
| [`markets.LivePriceQuote`](../sdk/markets.md) | interface | A composed live price for one market, as `LivePrices.price` returns it. |
| [`markets.LivePriceView`](../sdk/markets.md) | interface | What snapshots read live prices and the venue from: a `LivePrices`, or anything shaped like it. |
| [`markets.PriceQuote`](../sdk/markets.md) | interface | The price a snapshot valued an account at, and where it came from. |
| [`markets.ResolvedPrice`](../sdk/markets.md) | interface | What `resolvePrices` returns per market: the price quote (or null) and whether the venue is closed (null when unknown). |
| [`markets.ResolveOptions`](../sdk/markets.md) | interface | Options of `resolvePrices`: live prices, a held price, whether to fetch from Pyth Pro, and whether a price is needed. |
| [`markets.MarketFlagReasons`](../sdk/markets.md) | interface | Why something a trader may try is refused right now; null where it is not. |
| [`markets.MarketFlags`](../sdk/markets.md) | interface | What the pair refuses right now, as one set of flags a UI can gate its buttons on. |
| [`markets.StoredPrice`](../sdk/markets.md) | interface | The pair's stored oracle price (lastPairPrice): what its next call falls back to without a fresh one. |
| [`markets.FundingView`](../sdk/markets.md) | interface | A snapshot's funding: the current and accruing rates per hour (1e18 = 100%), the index and projected index, the last accrual and the cap. |
| [`markets.MarginView`](../sdk/markets.md) | interface | A snapshot's margin rates in basis points: initial, maintenance, and the 24 h lagged maintenance rate. |
| [`markets.OpenInterestView`](../sdk/markets.md) | interface | A snapshot's open interest: long and short sizes and notionals, and the liquidated inventory the vault holds. |
| [`markets.InsuranceView`](../sdk/markets.md) | interface | A snapshot's insurance fund: its balance, free capital, the seizure earmarked against inventory, its target ratio and its ledgers. |
| [`markets.AdlView`](../sdk/markets.md) | interface | A snapshot's ADL state: whether a window is pending, its epoch, when it opened, and the auction's score threshold. |
| [`markets.TerminationView`](../sdk/markets.md) | interface | A snapshot's termination state: the scheduled cutoff, when trading halts ahead of it, and when the settlement price was fixed. |
| [`markets.BookSummary`](../sdk/markets.md) | interface | A snapshot's book heads: the best bid and ask order ids and the number of orders resting on each side. |
| [`markets.MarketSnapshot`](../sdk/markets.md) | interface | A market's live state at one block, with the one status and the flags a UI shows. |
| [`markets.SnapshotOptions`](../sdk/markets.md) | interface | Options of `marketSnapshot(s)`: the block to read at, live prices to judge the venue with, and whether to fetch prices. |
| [`markets.MAX_FUNDING_RATE_CONTINUOUS`](../sdk/markets.md) | const | BazaarPairLens.fundingRate's cap per hour, by calendar (FundingLib.MAX_FUNDING_RATE_*). |
| [`markets.MAX_FUNDING_RATE_SESSION`](../sdk/markets.md) | const | The funding-rate cap per hour for a market with trading hours (1e18 = 100%). |
| [`markets.DepthLevel`](../sdk/markets.md) | interface | One price level of the book: every live resting order at that limit price. |
| [`markets.BookSide`](../sdk/markets.md) | type | `"bids"` or `"asks"`. |
| [`markets.BookDepth`](../sdk/markets.md) | interface | What `getBookDepth` returns: the market, side and block, the levels best first, and whether every level is included. |
| [`markets.BookDepthOptions`](../sdk/markets.md) | interface | Options of `getBookDepth`: the lens page size and the most orders to walk. |

### `account`

Accounts and portfolios.

| Export | Kind | What it is |
|---|---|---|
| [`account.positionHealth`](../sdk/accounts.md) | function | The position valued at `spot` with the state's projected funding index and effective maintenance rate. |
| [`account.accountHealth`](../sdk/accounts.md) | function | The snapshot's position revalued at a new spot price (a live print), with no read: for a display that follows the price between snapshots. |
| [`account.accountSnapshot`](../sdk/accounts.md) | function, bz | The account `user` on one market. |
| [`account.portfolio`](../sdk/accounts.md) | function, bz | Every market where `user` has collateral, a position, live orders or claimable fees, as `accountSnapshot`s, with totals. |
| [`account.accountSnapshots`](../sdk/accounts.md) | function | Several accounts' snapshots on chosen markets in one pass (used by watchAccount to refresh the markets an event touched). |
| [`account.AccountPosition`](../sdk/accounts.md) | interface | The account's position bucket on the pair (BazaarPairLens.getPositionBucket), BAZAAR precision. |
| [`account.PositionHealth`](../sdk/accounts.md) | interface | The position valued at a price, by the pair's own formula (BucketLib.calculateState) at the projected funding index (what a price stored now would accrue to) and the effective maintenance rate. |
| [`account.LensBucketState`](../sdk/accounts.md) | interface | BazaarPairLens.checkBucketSolvency at the snapshot's spot: the contract's own view, at the stored funding index. |
| [`account.AccountOrder`](../sdk/accounts.md) | interface | One of the account's live orders, decoded from `pair.orders(id)`. |
| [`account.OrderExposure`](../sdk/accounts.md) | interface | BazaarPairLens.outstandingOrderExposure: the live limit orders' remaining notional (at their limits) and size per side. |
| [`account.TerminalPayout`](../sdk/accounts.md) | interface | BazaarPairLens.getTerminalEntitlement: what a withdrawal pays on a market that is winding down. |
| [`account.WalletState`](../sdk/accounts.md) | interface | The wallet's USDC balance and the allowance the pair may pull, in USDC units (6 decimals). |
| [`account.AccountSnapshot`](../sdk/accounts.md) | interface | One account on one market at one block: position, health, orders, collateral, max withdrawable, fees and wallet state. |
| [`account.AccountOptions`](../sdk/accounts.md) | interface | Options shared by the account reads: the block to read at, live prices to value positions with, and whether to fetch prices. |
| [`account.AccountSnapshotOptions`](../sdk/accounts.md) | interface | Options of `accountSnapshot`: `AccountOptions` plus a held price and a market snapshot at the same block. |
| [`account.PortfolioTotals`](../sdk/accounts.md) | interface | A portfolio's totals across markets: collateral, equity, unrealized and funding PnL, claimable fees and max withdrawable. |
| [`account.Portfolio`](../sdk/accounts.md) | interface | What `portfolio` returns: one `AccountSnapshot` per market the account is active on, and the totals. |

### `live`

Watching markets and accounts through their events.

| Export | Kind | What it is |
|---|---|---|
| [`live.decodeLiveLog`](../sdk/live-updates.md) | function | A pair's or the terminator's log as a typed `LiveEvent`; null for a log that is neither (or a terminator event that names no pair). |
| [`live.watchMarket`](../sdk/live-updates.md) | function, bz | Watch one market: every pair event it emits (and terminator events about it) as typed `LiveEvent`s, and a fresh `MarketSnapshot` at the head after events (at most one per `minSnapshotMs`). |
| [`live.watchAccount`](../sdk/live-updates.md) | function, bz | Watch one account on a set of markets. |
| [`live.OrderUpdatePayload`](../sdk/live-updates.md) | interface | OrderUpdated's payload: the order's stored state at the event. |
| [`live.PairEventArgs`](../sdk/live-updates.md) | interface | Each pair event's arguments, as the pair emits them (BAZAAR precision; timestamps, blocks and enums as numbers). |
| [`live.PairEventName`](../sdk/live-updates.md) | type | The name of a pair event `PairEventArgs` describes. |
| [`live.LogPosition`](../sdk/live-updates.md) | interface | Where a log sits. |
| [`live.PairEvent`](../sdk/live-updates.md) | type | A pair event; narrow on `name` for its typed `args`. |
| [`live.TerminatorEvent`](../sdk/live-updates.md) | interface | A terminator event about one market (proposals, schedules, settlement prices, insurer votes). |
| [`live.LiveEvent`](../sdk/live-updates.md) | type | A `PairEvent` or a `TerminatorEvent`. |
| [`live.FollowOptions`](../sdk/live-updates.md) | interface | Options of `LogFollower` and the watchers: the poll interval, the first block, and the rest. |
| [`live.FollowNotice`](../sdk/live-updates.md) | type | What a follower reports besides logs. |
| [`live.LogFollower`](../sdk/live-updates.md) | class | Follows the logs of a set of contracts from a block cursor. |
| [`live.WatchOptions`](../sdk/live-updates.md) | interface | Options of `watchMarket` and `watchAccount`: `FollowOptions` plus live prices and price fetching for the snapshots. |
| [`live.SnapshotCause`](../sdk/live-updates.md) | type | Why a watcher sent a snapshot: `initial`, `events`, `timer` or `manual`. |
| [`live.UndecodableLog`](../sdk/live-updates.md) | interface | A log from a watched contract that could not be decoded (a malformed or unexpected event): it is reported here and skipped, and the rest of its batch is still delivered. |
| [`live.MarketUpdate`](../sdk/live-updates.md) | type | What `watchMarket` delivers: an event, a snapshot (with whether the book changed), an undecodable log or a follower notice. |
| [`live.AccountUpdate`](../sdk/live-updates.md) | type | What `watchAccount` delivers: an event, an account snapshot, an undecodable log or a follower notice. |
| [`live.WatchHandle`](../sdk/live-updates.md) | interface | What a watcher returns: `ready`, `refresh()` and `stop()`. |

### `priceFeeds`

Streamed prices and the price source over Pyth Pro (`client/prices.ts`).

| Export | Kind | What it is |
|---|---|---|
| [`priceFeeds.updateFromPrints`](../sdk/live-prices.md) | function | The signed updates a call attaches for these prints: each distinct update they came in, once. |
| [`priceFeeds.proPriceSource`](../sdk/live-prices.md) | function | The context's price source over Pyth Pro (Pyth's own endpoints, a proxy, or a local mock): `latest`, `atTick`, `prints`, and the client. |
| [`priceFeeds.isProPriceSource`](../sdk/live-prices.md) | function | Whether a context's price source is a `proPriceSource` (it then exposes its client). |
| [`priceFeeds.livePrices`](../sdk/live-prices.md) | function | Live prices for every market of a context (`listMarkets`), or for the markets given. |
| [`priceFeeds.BROWSER_FUTURE_SKEW`](../sdk/live-prices.md) | const | How far ahead of this device's clock a live print may be dated before it is ignored (seconds). |
| [`priceFeeds.ProPriceSource`](../sdk/live-prices.md) | interface | A `PriceUpdateSource` over Pyth Pro, with the client and parsed prints exposed. |
| [`priceFeeds.MarketPrice`](../sdk/live-prices.md) | interface | One market's live price, composed as BazaarOracle composes it (BAZAAR precision). |
| [`priceFeeds.PriceListener`](../sdk/live-prices.md) | type | Called with the markets whose price or flags changed (one map per batch; do not keep it). |
| [`priceFeeds.LivePricesOptions`](../sdk/live-prices.md) | interface | Options of `livePrices`: the `PriceService` options plus `pro` (options for a client of its own) or `client` when no context source is given. |
| [`priceFeeds.LivePrices`](../sdk/live-prices.md) | class | Live prices for a set of markets. |

### `orders`

Order specs, checks and packing, with no chain read except the `read*` functions.

| Export | Kind | What it is |
|---|---|---|
| [`orders.joinsActiveSet`](../sdk/orders.md) | function | Whether the order joins the account's active set and its 32-order cap (OrderManagementLib._joinsActiveSet). |
| [`orders.canRest`](../sdk/orders.md) | function | Whether the order can rest in the book and so wants an insertion hint: a Limit GTC, or a StopLimit once armed. |
| [`orders.packTriggerPrice`](../sdk/orders.md) | function | `(bounty << 128) \| price`: the OrderSpec.triggerPrice word of a trigger order. |
| [`orders.unpackTriggerPrice`](../sdk/orders.md) | function | Split a triggerPrice word into its price (low 128 bits) and bounty (high 128 bits). |
| [`orders.specBounty`](../sdk/orders.md) | function | The bounty a spec carries: what createOrder pulls from the wallet on top of any relayer fee. |
| [`orders.blocksIn`](../sdk/orders.md) | function | L2 blocks in `seconds` (about four a second), for an expiry `currentBlock + blocksIn(s)`. |
| [`orders.buildOrderSpec`](../sdk/orders.md) | function | Check an order the way `OrderManagementLib.createOrder` will, and return the spec to send or sign. |
| [`orders.checkOrderCaps`](../sdk/orders.md) | function | The per-user caps a UI must respect, against an account's live orders: 32 active Limit (GTC) + StopLimit orders per pair, and one TakeProfit and one StopLoss per position. |
| [`orders.orderInputFromSpec`](../sdk/orders.md) | function | The order a spec describes, for re-validation (a relayer checking a signed spec) or display. |
| [`orders.validateOrderSpec`](../sdk/orders.md) | function | Check a spec built elsewhere (or received for relaying) against the same rules, including the one the builder enforces by construction: a non-trigger type must leave the bounty bits clear. |
| [`orders.describeOrder`](../sdk/orders.md) | function | One line for a confirmation screen: "Buy 1.5 at 2000 (limit, GTC, post-only)". |
| [`orders.amendIdWord`](../sdk/managing-orders.md) | function | An amendment's id word, exactly as BazaarPairLens.amendIdWord / bestEffortAmendIdWord pack it: the order id in bits 0-63, hints in bits 64-127 and 128-191, the best-effort flag in bit 192. |
| [`orders.unpackAmendIdWord`](../sdk/managing-orders.md) | function | The fields of an id word. |
| [`orders.encodeAmends`](../sdk/managing-orders.md) | function | The flat `amends` array amendOrders takes and AmendOrders signs: per amendment its id word, its new price, its new total size. 1 to `MAX_AMENDS_PER_CALL` amendments. |
| [`orders.decodeAmends`](../sdk/managing-orders.md) | function | The amendments a flat `amends` array holds (for a relayer showing or checking a signed batch). |
| [`orders.readOrderState`](../sdk/orders.md) | function, bz | The account facts the creation checks need, in one batched read. |
| [`orders.readTriggerBounty`](../sdk/orders.md) | function, bz | What a trigger order's escrow still holds for whoever fires it (BAZAAR precision): lens.triggerBounty. |
| [`orders.readOrderLifetimeConstants`](../sdk/orders.md) | function, bz | The lifetime constants as the lens reports them (pure there; useful to confirm the SDK's copy). |
| [`orders.TimeInForce`](../sdk/orders.md) | const + type | BazaarTypes.TimeInForce: what an arriving order does with the size the book could not fill. |
| [`orders.TIF_NAMES`](../sdk/orders.md) | const | Time-in-force names by number: 0 `GTC`, 1 `IOC`, 2 `FOK`. |
| [`orders.MAX_SLIPPAGE_BP`](../sdk/orders.md) | const | Slippage cap for Market, TakeProfit and StopLoss orders: 10%. |
| [`orders.MAX_PLACEMENT_DEVIATION_BP`](../sdk/orders.md) | const | A Limit price must sit within ±50% of the oracle price at creation or amendment. |
| [`orders.MIN_ORDER_LIFETIME_BLOCKS`](../sdk/orders.md) | const | Minimum life of an order that can rest, in Arbitrum L2 blocks (~1 minute at 4 blocks a second). |
| [`orders.MAX_ORDER_LIFETIME_BLOCKS`](../sdk/orders.md) | const | Maximum life, in L2 blocks (~1 year); a later expiry is clamped to it by the pair. |
| [`orders.NEVER_EXPIRE_BLOCK`](../sdk/orders.md) | const | The expiry the pair stamps on TakeProfit and StopLoss orders: they never expire. |
| [`orders.MAX_ACTIVE_LIMIT_ORDERS_PER_USER`](../sdk/orders.md) | const | Active Limit + StopLimit orders one account may hold on one pair. |
| [`orders.MAX_AMENDS_PER_CALL`](../sdk/orders.md) | const | Amendments per amendOrders call (the per-user cap, so one batch can requote every order). |
| [`orders.MAX_CANCELS_PER_CALL`](../sdk/managing-orders.md) | const | Order ids per cancelOrders call (BazaarPair.MAX_CANCELS_PER_CALL): every order one account can hold live on a pair, its Limit and StopLimit orders plus a take-profit and a stop-loss. |
| [`orders.AMEND_BEST_EFFORT_BIT`](../sdk/orders.md) | const | Bit 192 of an amendment's id word: skip the amendment instead of reverting the batch. |
| [`orders.CLOSE_POSITION`](../sdk/orders.md) | const | A TakeProfit or StopLoss of this size closes the whole position, whatever it is when it fires. |
| [`orders.L2_BLOCKS_PER_SECOND`](../sdk/orders.md) | const | Arbitrum produces about four L2 blocks a second; expiries are counted in them. |
| [`orders.EXPIRY_LANDING_MARGIN_BLOCKS`](../sdk/orders.md) | const | Blocks of slack the SDK adds on top of the minimum lifetime when it checks an expiry: the pair measures the lifetime from the block the transaction lands in, a few seconds after it is built. |
| [`orders.OrderSpec`](../sdk/orders.md) | interface | BazaarTypes.OrderSpec, field for field: what createOrder takes and the CreateOrder signature covers. |
| [`orders.MatchHints`](../sdk/orders.md) | interface | BazaarTypes.MatchHints: execution aids for the arrival walk and book insertion, outside every signature. |
| [`orders.NO_HINTS`](../sdk/orders.md) | const | Empty `MatchHints`: no predecessors, the default walk budget. |
| [`orders.OrderInput`](../sdk/orders.md) | interface | An order as a trader describes it. |
| [`orders.OrderEnvironment`](../sdk/orders.md) | interface | What the pair knows that an order is judged against. |
| [`orders.AccountOrderState`](../sdk/orders.md) | interface | The account facts the creation checks need: its position and its order slots. |
| [`orders.isTriggerType`](../sdk/orders.md) | const | Whether an order type is a trigger type (StopLimit, TakeProfit, StopLoss). |
| [`orders.AmendInput`](../sdk/managing-orders.md) | interface | One amendment of a resting Limit (GTC) order: its new price and new TOTAL size (filled part included). |
| [`orders.bestEffortAmendIdWord`](../sdk/managing-orders.md) | const | BazaarPairLens.bestEffortAmendIdWord. |

### `trade`

Every trading write, and the price and hint helpers they use.

| Export | Kind | What it is |
|---|---|---|
| [`trade.parsePriceUpdate`](../sdk/sending.md) | function | The live prices a `priceUpdate: bytes[]` carries, read from each Pyth Pro update's signed payload. |
| [`trade.UpdatePrice`](../sdk/sending.md) | interface | One feed's live price as a signed update carries it. |
| [`trade.pairPriceFromUpdate`](../sdk/sending.md) | function, bz | The pair price an update proves, composed from the pair's legs exactly as BazaarOracle composes it (formulas `pairPrice`). |
| [`trade.livePairPrice`](../sdk/sending.md) | function, bz | The live pair price from the context's price source, with the update it came from. |
| [`trade.storedPairPrice`](../sdk/sending.md) | function, bz | The price the pair last stored (`lastPairPrice`): what it falls back to on a closed market. |
| [`trade.findPredecessor`](../sdk/orders.md) | function, bz | The order a new entry at `limitPrice` on its side should rest directly behind (0 = the head). |
| [`trade.matchHintsFor`](../sdk/orders.md) | function, bz | MatchHints for an order: the predecessor on its own side at its limit price when it can rest (a Limit GTC, or a StopLimit that arms on arrival), none otherwise. |
| [`trade.depositCollateral`](../sdk/collateral.md) | function, bz | Deposit collateral: the pair floors `amount` (BAZAAR precision) to whole micro-USDC, adds it to the trader's position bucket and pulls it from the wallet. |
| [`trade.terminalWithdrawal`](../sdk/collateral.md) | function | On a terminated pair, what a withdrawal of `amount` (collateral, BAZAAR precision) pays out. |
| [`trade.withdrawCollateral`](../sdk/collateral.md) | function, bz | Withdraw collateral (BAZAAR precision; the wallet receives it floored to micro-USDC). |
| [`trade.optionalUpdate`](../sdk/sending.md) | function, bz | A price update for a call that reads a price only sometimes: none when `withPrice` is false; attached when a price source is connected (the pair refunds the fee of an update it does not read). |
| [`trade.prepareOrder`](../sdk/orders.md) | function, bz | Check an order against the account's position and order slots, the current L2 block and the oracle price, and build its spec with the context's integrator (orders.ts `buildOrderSpec` has the rules). |
| [`trade.createOrder`](../sdk/orders.md) | function, bz | Create an order, matched against the book in the same transaction. |
| [`trade.prepareAmends`](../sdk/managing-orders.md) | function, bz | Check amendments the way `OrderManagementLib._amendOne` will and fill in hints for the ones that move. |
| [`trade.amendOrders`](../sdk/managing-orders.md) | function, bz | Amend resting Limit (GTC) orders in place: each gets a new price and total size and keeps its id, expiry and integrator. |
| [`trade.checkCancelIds`](../sdk/managing-orders.md) | function | 1 to MAX_CANCELS_PER_CALL (34) distinct order ids, as cancelOrders takes them. |
| [`trade.cancelOrders`](../sdk/managing-orders.md) | function, bz | Cancel the trader's orders (up to 34, every order one account can hold live): each is unlinked from the book in the same write and its remaining keeper bounty returns to the trader's claimable balance (claimFees). |
| [`trade.claimFees`](../sdk/managing-orders.md) | function, bz | Pay the caller everything the pair owes it: refunded trigger bounties, keeper rewards, relayer and integrator fees. |
| [`trade.executeTriggeredOrders`](../sdk/managing-orders.md) | function, bz | Fire the trader's own trigger orders (StopLimit, TakeProfit, StopLoss) whose trigger the live price has reached: how a zero-bounty order is executed, by its owner. |
| [`trade.PriceUpdateError`](../sdk/sending.md) | class | A price update that is not a Pyth Pro update, or does not cover the pair's feeds. |
| [`trade.terminalPayoutNote`](../sdk/collateral.md) | const | What a terminal payout of `payout` reads as on a confirmation screen. |
| [`trade.PreparedOrder`](../sdk/orders.md) | interface | An order checked against the chain: the spec to send or sign, and what it was checked against. |
| [`trade.CreateOrderOptions`](../sdk/orders.md) | interface | Options of `createOrder`: `hints` to use instead of the ones the SDK finds, the walk budget `maxSteps`, and `permitData`. |
| [`trade.PreparedAmends`](../sdk/managing-orders.md) | interface | Amendments checked against the orders, the book and the price, with insertion hints filled in. |
| [`trade.priceFields`](../sdk/sending.md) | function | A call's price fields: when its update's price was generated, or why it carries none for want of a fresh one. |

### `insurance`

Insurance deposits, the exit, quotes, budgets and locks.

| Export | Kind | What it is |
|---|---|---|
| [`insurance.claimOpensAt`](../sdk/insurance.md) | function | BazaarPair.InsuranceVaultLib.claimOpensAt. |
| [`insurance.depositToInsurance`](../sdk/insurance.md) | function, bz | Deposit USDC into the pair's insurance fund for shares priced at the fund's value at the mark. |
| [`insurance.requestInsuranceWithdrawal`](../sdk/insurance.md) | function, bz | Request to withdraw `shareAmount` insurance shares: starts the 13-day cooldown, after which the execution window opens (2 days, or 4 on a pair with trading hours). |
| [`insurance.executeInsuranceWithdrawal`](../sdk/insurance.md) | function, bz | The next step of a requested withdrawal. |
| [`insurance.getInsuranceSharePrice`](../sdk/insurance.md) | function, bz | What one share redeems for at the pair's stored mark (BAZAAR precision; 1.0 while no shares exist). |
| [`insurance.getInsuranceDepositValue`](../sdk/insurance.md) | function, bz | What `user`'s shares redeem for at the pair's stored mark (BAZAAR precision). |
| [`insurance.insuranceShares`](../sdk/insurance.md) | function, bz | `user`'s insurance shares (0 for a balance a fund recap wiped). |
| [`insurance.quoteInsuranceDeposit`](../sdk/insurance.md) | function, bz | Shares a deposit of `amount` (BAZAAR precision, floored to micro-USDC as the pair floors it) would mint at the live price (or `price`): `lens.quoteInsuranceDeposit`, the pair's own arithmetic. |
| [`insurance.quoteInsuranceWithdrawal`](../sdk/insurance.md) | function, bz | USDC (BAZAAR precision) a redemption of `shareAmount` would pay at the live price (or `price`): `lens.quoteInsuranceWithdrawal`. |
| [`insurance.getInsuranceWithdrawalLock`](../sdk/insurance.md) | function, bz | `lens.getInsuranceWithdrawalLock`: where an LP's two execute calls stand. |
| [`insurance.getInsuranceWithdrawalBudget`](../sdk/insurance.md) | function, bz | `lens.getInsuranceWithdrawalBudget` at the live price (or `price`): the number a paying call is checked against, as of now. |
| [`insurance.getInsuranceWithdrawalConstants`](../sdk/insurance.md) | function, bz | `lens.getInsuranceWithdrawalConstants`: durations in seconds, budget terms in bp. |
| [`insurance.insuranceExitPlan`](../sdk/insurance.md) | function, bz | Read where `user`'s insurance exit on `pair` stands and when the next call can land. |
| [`insurance.MIN_INSURANCE_DEPOSIT`](../sdk/insurance.md) | const | The smallest insurance deposit: 5 USDC (BAZAAR precision). |
| [`insurance.MAX_INSURANCE_DEPOSIT`](../sdk/insurance.md) | const | The largest insurance deposit the pair accepts: 2^128 - 1 (BAZAAR precision). |
| [`insurance.INSURANCE_WITHDRAWAL_COOLDOWN`](../sdk/insurance.md) | const | Seconds between a withdrawal request and its execution window: 13 days. |
| [`insurance.INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS`](../sdk/insurance.md) | const | Seconds the execution window stays open on a 24/7 market: 2 days. |
| [`insurance.INSURANCE_WITHDRAWAL_WINDOW_SESSION`](../sdk/insurance.md) | const | Seconds the execution window stays open on a market with trading hours: 4 days. |
| [`insurance.INSURANCE_WITHDRAWAL_CLAIM_DELAY`](../sdk/insurance.md) | const | The paying call opens this long after the lock, and after the last stored 2% price jump. |
| [`insurance.INSURANCE_WITHDRAWAL_REOPEN_CLAIM_DELAY`](../sdk/insurance.md) | const | The paying call also opens this long after the last stored price that ended a gap of an hour or more. |
| [`insurance.REOPEN_GAP_MIN_STALENESS`](../sdk/insurance.md) | const | RiskParamsLib.REOPEN_GAP_MIN_STALENESS: a store after this long without one ends a gap. |
| [`insurance.withdrawalWindowOf`](../sdk/insurance.md) | const | The execution window for a market, by whether it trades continuously. |
| [`insurance.InsuranceQuote`](../sdk/insurance.md) | interface | A deposit or redemption quote: the shares or USDC, the mark it was priced at, and the update's publish time. |
| [`insurance.InsuranceWithdrawalLock`](../sdk/insurance.md) | interface | What `getInsuranceWithdrawalLock` returns: whether the request is locked, the locked amount, the lock time, when the claim opens and when the window ends. |
| [`insurance.InsuranceWithdrawalBudget`](../sdk/insurance.md) | interface | What `getInsuranceWithdrawalBudget` returns: what the shared 6-hour budget still admits, its cap, and when it refills. |
| [`insurance.InsuranceWithdrawalConstants`](../sdk/insurance.md) | interface | What `getInsuranceWithdrawalConstants` returns: the cooldown, the windows and the rate-limit terms. |
| [`insurance.InsuranceExitStep`](../sdk/insurance.md) | type | Where an LP's exit stands: `none`, `request`, `cooldown`, `lock`, `waitClaim`, `claim`, `redeem`, `expired` or `blocked`. |
| [`insurance.InsuranceExitPlan`](../sdk/insurance.md) | interface | What `insuranceExitPlan` returns: the step, a message for the LP, the next action and when it can land. |

### `signing`

EIP-712 signing for gasless calls, deadlines and the clock-skew check.

| Export | Kind | What it is |
|---|---|---|
| [`signing.pairDomain`](../sdk/gasless.md) | function | The pair's EIP-712 domain. |
| [`signing.domainSeparator`](../sdk/gasless.md) | function | What `pair.DOMAIN_SEPARATOR()` should equal. |
| [`signing.typeHash`](../sdk/gasless.md) | function | keccak256 of the primary type's string: what lens.getTypehashes reports for it. |
| [`signing.typedDataFor`](../sdk/gasless.md) | function | The typed data a user signs for `fields` on `pair`. |
| [`signing.relayedDigest`](../sdk/gasless.md) | function | The EIP-712 digest the pair recovers the signer from. |
| [`signing.typedDataJson`](../sdk/gasless.md) | function | The typed data as the JSON string eth_signTypedData_v4 takes (integers as decimal strings). |
| [`signing.floorRelayerFee`](../sdk/gasless.md) | function | Check a relayer fee and floor it to USDC precision, as `_resolveUser` charges it: the signed fee is then exactly the USDC the user pays. |
| [`signing.readMetaTxNonce`](../sdk/gasless.md) | function, bz | The signer's next nonce on the pair (`pair.metaTxNonces(user)`). |
| [`signing.eip712Limits`](../sdk/gasless.md) | function, bz | The fee cap and deadline window the deployment enforces, from `lens.getEip712Constants()` (read once per context). |
| [`signing.chainTime`](../sdk/gasless.md) | function, bz | The latest block's timestamp: the clock deadlines are judged against. |
| [`signing.checkClockSkew`](../sdk/gasless.md) | function | Check the chain time an RPC reported against this device's clock and return the lower of the two: the time every deadline the SDK signs is counted from. |
| [`signing.deadlineBase`](../sdk/gasless.md) | function | The time a deadline is counted from: min(latest block's timestamp, this device's clock), checked by `checkClockSkew`. |
| [`signing.chainDeadline`](../sdk/gasless.md) | function, bz | A deadline `windowSeconds` (default: the whole window) past the lower of the latest block's timestamp and this device's clock, never more than the deployment's `maxDeadlineWindow` (10 s). |
| [`signing.normalizeSignature`](../sdk/gasless.md) | function | A wallet's signature in the 65-byte r ‖ s ‖ v form OpenZeppelin's ECDSA accepts: v as 27/28 (some wallets return 0/1), an EIP-2098 64-byte signature expanded, and a high-s signature refused. |
| [`signing.signTypedDataV4`](../sdk/gasless.md) | function | Ask an EIP-1193 wallet to sign typed data with eth_signTypedData_v4, so it shows the user every field it signs. |
| [`signing.takesPriceUpdate`](../sdk/gasless.md) | function | The actions whose call takes `priceUpdate`: a relayer attaches a fresh one at submission. |
| [`signing.encodePairWrite`](../sdk/gasless.md) | function | Calldata for one of the eight actions, direct (`DIRECT_META`) or relayed. |
| [`signing.verifyTypehashes`](../sdk/gasless.md) | function, bz | Confirm that what the SDK signs is what the deployment verifies. |
| [`signing.BAZAAR_DOMAIN_NAME`](../sdk/gasless.md) | const | The pair's EIP-712 domain name: `"BazaarPair"`. |
| [`signing.BAZAAR_DOMAIN_VERSION`](../sdk/gasless.md) | const | The pair's EIP-712 domain version: `"1"`. |
| [`signing.MAX_RELAYER_FEE`](../sdk/gasless.md) | const | MetaTxLib.MAX_RELAYER_FEE: $1 per action, BAZAAR precision. |
| [`signing.MAX_DEADLINE_WINDOW`](../sdk/gasless.md) | const | MetaTxLib.MAX_DEADLINE_WINDOW: a deadline at most this many seconds past the block's timestamp. |
| [`signing.EIP712_DOMAIN_TYPE_STRING`](../sdk/gasless.md) | const | The EIP-712 domain type string the pair uses (name, version, chainId, verifyingContract). |
| [`signing.TYPE_STRINGS`](../sdk/gasless.md) | const | The primary types, verbatim from MetaTxLib (whose hashes lens.getTypehashes returns). |
| [`signing.PrimaryType`](../sdk/gasless.md) | type | The name of one of the primary types in `TYPE_STRINGS`. |
| [`signing.EIP712_DOMAIN_FIELDS`](../sdk/gasless.md) | const | The EIP-712 domain's field list, as viem and `eth_signTypedData_v4` take it. |
| [`signing.BAZAAR_TYPES`](../sdk/gasless.md) | const | The same types as viem / eth_signTypedData_v4 field lists; they encode to `TYPE_STRINGS`. |
| [`signing.RELAYED_ACTIONS`](../sdk/gasless.md) | const | The pair functions that take a signature. |
| [`signing.RelayedAction`](../sdk/gasless.md) | type | One of the pair functions in `RELAYED_ACTIONS`. |
| [`signing.PRIMARY_TYPE`](../sdk/gasless.md) | const | The primary type each relayed action signs (`depositCollateral` signs `DepositCollateral`, ...). |
| [`signing.SignedFields`](../sdk/gasless.md) | type | What each action signs besides (nonce, deadline, relayerFee): its own arguments. |
| [`signing.MetaFields`](../sdk/gasless.md) | interface | The meta-transaction fields every signature covers: `nonce`, `deadline` and `relayerFee`. |
| [`signing.MetaArgs`](../sdk/gasless.md) | interface | The (nonce, deadline, relayerFee, signature, permitData) tail of a pair call; all zero/empty for a direct call. |
| [`signing.DIRECT_META`](../sdk/gasless.md) | const | The all-zero meta tail of a direct (unsigned) pair call. |
| [`signing.TypedDataDomain`](../sdk/gasless.md) | interface | An EIP-712 domain: name, version, chain id and verifying contract. |
| [`signing.PairTypedData`](../sdk/gasless.md) | interface | Typed data as eth_signTypedData_v4 and viem take it. |
| [`signing.MAX_CLOCK_SKEW`](../sdk/gasless.md) | const | How far, in seconds, the chain time the RPC reports may sit from this device's clock before the SDK refuses to count a deadline from it. |
| [`signing.DEV_CHAIN_IDS`](../sdk/gasless.md) | const | Local development chains (Anvil and Hardhat 31337, Ganache and geth --dev 1337), whose clocks tests move at will: their deadlines are counted from chain time unchecked. |
| [`signing.SigningError`](../sdk/gasless.md) | class | A signing step the wallet refused or could not do in the form Bazaar accepts. |
| [`signing.ClockSkewError`](../sdk/gasless.md) | class | The RPC's chain time and this device's clock disagree too much to stamp a deadline (`checkClockSkew`, `chainDeadline`). |
| [`signing.TypehashReport`](../sdk/gasless.md) | interface | What `verifyTypehashes` returns: `ok`, one line per mismatch, and each type hash as the SDK and the lens compute it. |

### `permits`

USDC (ERC-2612) permits.

| Export | Kind | What it is |
|---|---|---|
| [`permits.usdcPermitDomain`](../sdk/collateral.md) | function, bz | USDC's EIP-712 domain: its `name()`, its `version()` ("2" on native Arbitrum USDC; "1" only when the token has no version()), the chain id, and its address. |
| [`permits.permitNonce`](../sdk/collateral.md) | function, bz | The owner's current permit nonce on USDC. |
| [`permits.permitTypedData`](../sdk/collateral.md) | function | The typed data of a USDC permit. |
| [`permits.encodePermitData`](../sdk/collateral.md) | function | `abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`, as the pair decodes it. |
| [`permits.decodePermitData`](../sdk/collateral.md) | function | Decode a `permitData` blob into its value, deadline, v, r and s. |
| [`permits.permitValueFor`](../sdk/collateral.md) | function | The permit value (USDC units, rounded up) that covers a pull of `pullBazaar` (BAZAAR precision). |
| [`permits.signPermit`](../sdk/collateral.md) | function, bz | Ask the owner's wallet (`eth_signTypedData_v4`) to sign a USDC permit for `spender`, which must be a pair of this deployment; valid 30 minutes by default. |
| [`permits.checkPermit`](../sdk/collateral.md) | function, bz | Check a `permitData` a relayer received: it decodes, it is signed by `owner` for `spender` at the owner's current nonce, it has not expired, and it covers `needUsdc`. |
| [`permits.DEFAULT_PERMIT_WINDOW`](../sdk/collateral.md) | const | How long a permit the SDK signs stays valid by default (seconds past the lower of chain time and the device's clock). |
| [`permits.PERMIT_TYPES`](../sdk/collateral.md) | const | The EIP-712 types of a USDC (ERC-2612) permit. |
| [`permits.PermitMessage`](../sdk/collateral.md) | interface | A permit's message: owner, spender (the pair), value in USDC units, nonce and deadline. |
| [`permits.SignedPermit`](../sdk/collateral.md) | interface | A signed permit: the message, the signature and its parts, and the `permitData` a pair call takes. |

### `allowance`

USDC balance, allowance and approvals.

| Export | Kind | What it is |
|---|---|---|
| [`allowance.erc20Data`](../sdk/collateral.md) | function | Calldata for one of the ERC-20 functions above. |
| [`allowance.usdcBalance`](../sdk/collateral.md) | function, bz | The owner's USDC balance, in USDC units. |
| [`allowance.usdcAllowance`](../sdk/collateral.md) | function, bz | What `spender` (a pair) may pull from `owner`, in USDC units. |
| [`allowance.approveUsdc`](../sdk/collateral.md) | function, bz | Approve `spender` (a pair) to pull `amountUsdc` (USDC units) from `owner`'s wallet. |
| [`allowance.formatUsdcUnits`](../sdk/collateral.md) | function | USDC units -&gt; "12.5". |
| [`allowance.usdcFunding`](../sdk/collateral.md) | function, bz | Whether `owner` can fund a pull of `pullBazaar` (BAZAAR precision, e.g. `PreparedCall.pullsUsdc`) to `spender`: balance and allowance in one read. |
| [`allowance.ERC20_ABI`](../sdk/collateral.md) | const | The ERC-20 / ERC-2612 functions the SDK calls on USDC, hand-written (USDC is not a Bazaar ABI). |
| [`allowance.UsdcFunding`](../sdk/collateral.md) | interface | What `usdcFunding` returns: the USDC a call needs, the balance and allowance, and what to approve. |
| [`allowance.faucetStatus`](../sdk/collateral.md#the-testnet-faucet) | function, bz | Whether `owner` can claim from the testnet USDC faucet now, and when it can next. |
| [`allowance.claimFaucet`](../sdk/collateral.md#the-testnet-faucet) | function, bz | Claim test USDC from the deployment's testnet faucet (a `PreparedCall` sent from the wallet). |
| `allowance.transferUsdc` | function, bz | A plain ERC-20 transfer of the deployment's USDC from one address to another (a `PreparedCall`); a testnet faucet service sends test USDC with it. |
| [`allowance.FaucetStatus`](../sdk/collateral.md#the-testnet-faucet) | interface | What `faucetStatus` returns. |
| [`allowance.FAUCET_ABI`](../sdk/collateral.md#the-testnet-faucet) | const | The testnet USDC's faucet functions. |

### `relay`

Gasless requests: signing, checking, serializing and encoding them.

| Export | Kind | What it is |
|---|---|---|
| [`relay.checkSignedFields`](../sdk/gasless.md) | function | The bounds of each action that need no chain read, as the pair enforces them for a relayed call. |
| [`relay.relayedPull`](../sdk/gasless.md) | function, bz | What a relayed call takes from the signer's wallet, BAZAAR precision: a deposit plus the fee; the fee plus a trigger order's bounty for createOrder. |
| [`relay.signRelayed`](../sdk/gasless.md) | function, bz | Have the user sign a gasless request. |
| [`relay.verifyRelayed`](../sdk/gasless.md) | function, bz | Check a request before relaying it. |
| [`relay.encodeRelayed`](../sdk/gasless.md) | function, bz | The call a relayer sends for a request, from its own account (`relayer`). |
| [`relay.describeRelayed`](../sdk/gasless.md) | function | One line describing what a request does. |
| [`relay.serializeRelayed`](../sdk/gasless.md) | function | The request as JSON for the POST to a relayer: integers as decimal strings. |
| [`relay.parseRelayed`](../sdk/gasless.md) | function | A request from JSON (or an already-parsed body), every field checked for type and shape. |
| [`relay.RelayedRequest`](../sdk/gasless.md) | type | A signed gasless request: every signed field, the signer, the signature and the permit. |
| [`relay.RelayedInput`](../sdk/gasless.md) | type | What `signRelayed` takes: the signed fields themselves, or an order / amendments to check and build first. |
| [`relay.SignRelayedOptions`](../sdk/gasless.md) | interface | Options of `signRelayed`: the wallet, signer and pair, the relayer fee, the deadline window, and an optional nonce and permit. |
| [`relay.RelayCheck`](../sdk/gasless.md) | interface | What `verifyRelayed` returns: `ok`, the recovered signer, and every problem that would make the call revert. |

### `batching`

Several prepared calls in one transaction.

| Export | Kind | What it is |
|---|---|---|
| [`batching.toBatchCalls`](../sdk/batching.md) | function | The calls in the generic shape, in order. |
| [`batching.batchValue`](../sdk/batching.md) | function | ETH the batch needs: the sum of the calls' values (Pyth fees). |
| [`batching.shareOnePriceUpdate`](../sdk/batching.md) | function | Carry the Pyth update once per pair: the first call that always stores a price (createOrder, amendOrders, executeTriggeredOrders, refreshPrice) keeps its update and fee. |
| [`batching.walletSendCallsRequest`](../sdk/batching.md) | function, bz | The `wallet_sendCalls` request for these calls from `from` (the smart account). |
| [`batching.sendCalls`](../sdk/batching.md) | function | Send the calls as one batch through an EIP-5792 wallet. |
| [`batching.getCallsStatus`](../sdk/batching.md) | function | `wallet_getCallsStatus` for a batch id, as the wallet reports it. |
| [`batching.encodeTradingAccountExecute`](../sdk/batching.md) | function | `execute(Call[] calls)` calldata, each call as (target, value, data). |
| [`batching.tradingAccountExecute`](../sdk/batching.md) | function | One transaction through a BazaarTradingAccount: `execute` runs the calls in order as the account, with `value` the sum of their values. |
| [`batching.decodeTradingAccountResults`](../sdk/batching.md) | function | The per-call return data `execute` returns. |
| [`batching.readTradingAccountOwner`](../sdk/batching.md) | function, bz | The account's owner (who alone may call execute). |
| [`batching.BatchCall`](../sdk/batching.md) | interface | The generic call shape smart wallets take (ERC-4337 / Safe / EIP-5792). |
| [`batching.SendCallsOptions`](../sdk/batching.md) | interface | Options of `sendCalls` and `walletSendCallsRequest`: whether the batch must be atomic, and wallet capabilities. |
| [`batching.TRADING_ACCOUNT_ABI`](../sdk/batching.md) | const | The example account's interface, hand-written from examples/BazaarTradingAccount.sol. |

### `history`

Bazaar's subgraph: every history query and its types.

| Export | Kind | What it is |
|---|---|---|
| [`history.httpSubgraph`](../sdk/history.md) | function | A `SubgraphSource` over HTTP. |
| [`history.cancelReasonName`](../sdk/history.md) | function | BazaarTypes.CancelReason's code (as an OrderUpdated payload carries it) -&gt; its name. |
| [`history.trades`](../sdk/history.md) | function, bz | The trade tape: fills, newest first. |
| [`history.candles`](../sdk/history.md) | function, bz | OHLCV candles of one pair at one interval (seconds: 60, 300, 900, 3600, 14400 or 86400), oldest first; `from`/`to` bound the period start. |
| [`history.fillCandleGaps`](../sdk/history.md) | function | Fill the periods between `from` and `to` (exclusive) that had no fills with flat candles at the previous close (zero volume), as a chart expects. |
| [`history.pairDayData`](../sdk/history.md) | function, bz | A pair's daily figures (UTC days), oldest first. |
| [`history.protocolDayData`](../sdk/history.md) | function, bz | Protocol-wide daily figures, oldest first. |
| [`history.bookLevels`](../sdk/history.md) | function, bz | Aggregated resting size per price on one side of a pair's book, best price first (bids high to low, asks low to high). |
| [`history.orders`](../sdk/history.md) | function, bz | Orders, newest first by creation time (`from`/`to` bound the creation time). |
| [`history.order`](../sdk/history.md) | function, bz | One order by pair and order id, or null when the subgraph has not seen it. |
| [`history.orderEvents`](../sdk/history.md) | function, bz | Order lifecycle events (created, triggered, canceled with its reason, amended, amend skipped), newest first. |
| [`history.positions`](../sdk/history.md) | function, bz | Positions (one per account and pair), by id. |
| [`history.positionChanges`](../sdk/history.md) | function, bz | Each trade's effect on a position, newest first. |
| [`history.positionSnapshots`](../sdk/history.md) | function, bz | The full stored position after every change (PositionBucketUpdated), newest first. |
| [`history.collateralTransfers`](../sdk/history.md) | function, bz | Collateral deposits and withdrawals, newest first. |
| [`history.feeBalances`](../sdk/history.md) | function, bz | Claimable balances per pair and recipient: an integrator's or relayer's revenue, a keeper's rewards, refunded bounties. |
| [`history.feeAccruals`](../sdk/history.md) | function, bz | Credits to claimable balances (FeeAccrued), newest first. |
| [`history.feeClaims`](../sdk/history.md) | function, bz | Claims of claimable balances (FeesClaimed), newest first. |
| [`history.integratorStats`](../sdk/history.md) | function, bz | What an integrator address has routed, or null when it has carried no order. |
| [`history.accountStats`](../sdk/history.md) | function, bz | An account's lifetime totals, or null when the subgraph has not seen it. |
| [`history.accountDayData`](../sdk/history.md) | function, bz | An account's daily totals (UTC days), oldest first. |
| [`history.metaTransactions`](../sdk/history.md) | function, bz | Relayed (gasless) actions, newest first. |
| [`history.permitFailures`](../sdk/history.md) | function, bz | Permits the pair could not execute (the call went on with the existing allowance), newest first. |
| [`history.liquidations`](../sdk/history.md) | function, bz | Liquidations, newest first: `account` is the liquidated trader. |
| [`history.adlWindows`](../sdk/history.md) | function, bz | ADL windows, newest first by opening time. |
| [`history.adlBatches`](../sdk/history.md) | function, bz | ADL batches (executeAdl calls), newest first; `window` is an `AdlWindow` id. |
| [`history.adlFills`](../sdk/history.md) | function, bz | Winners ADL closed, newest first. |
| [`history.insuranceProviders`](../sdk/history.md) | function, bz | Insurance LPs per pair, by id; `activeOnly` keeps those holding shares. |
| [`history.insuranceEvents`](../sdk/history.md) | function, bz | Insurance deposits, withdrawal requests, locks, payouts and levies, newest first. |
| [`history.pairTerminations`](../sdk/history.md) | function, bz | Finalized terminations with their payout figures, newest first. |
| [`history.terminalRatioUpdates`](../sdk/history.md) | function, bz | Payout ratios re-derived after finalize, newest first. |
| [`history.terminationProposals`](../sdk/history.md) | function, bz | UMA termination claims, newest first by submission. |
| [`history.insurerProposals`](../sdk/history.md) | function, bz | Insurer termination votes, newest first by creation. |
| [`history.insurerVotes`](../sdk/history.md) | function, bz | Yes-votes cast on insurer proposals, newest first. |
| [`history.insurerLevies`](../sdk/history.md) | function, bz | Levies charged on yes-voters' redemptions after an insurer-vote termination, newest first. |
| [`history.listingProposals`](../sdk/history.md) | function, bz | Listing (pair deployment) proposals, newest first. |
| [`history.identifierUpgradeProposals`](../sdk/history.md) | function, bz | UMA identifier-upgrade proposals, newest first. |
| [`history.subgraphLag`](../sdk/history.md) | function, bz | How far the subgraph's history trails the chain: its `_meta.block` against the chain head, so a UI can say that trades and positions from the last moments may not be listed yet. |
| [`history.SubgraphError`](../sdk/history.md) | class | The subgraph refused or failed a query. |
| [`history.HttpSubgraphOptions`](../sdk/history.md) | interface | Options of `httpSubgraph`: the per-request timeout, extra headers and the `fetch` to use. |
| [`history.ORDER_TYPES`](../sdk/history.md) | const | Order type names as the subgraph stores them: Market, Limit, StopLimit, TakeProfit, StopLoss. |
| [`history.OrderTypeName`](../sdk/history.md) | type | One of `ORDER_TYPES`. |
| [`history.TIME_IN_FORCE`](../sdk/history.md) | const | Time-in-force names: GTC, IOC, FOK. |
| [`history.TimeInForceName`](../sdk/history.md) | type | One of `TIME_IN_FORCE`. |
| [`history.ORDER_STATUSES`](../sdk/history.md) | const | Order statuses: Waiting, Pending, Resting, Fired, Filled, Canceled. |
| [`history.OrderStatus`](../sdk/history.md) | type | One of `ORDER_STATUSES`. |
| [`history.OPEN_ORDER_STATUSES`](../sdk/history.md) | const | Statuses of an order that can still trade. |
| [`history.CANCEL_REASONS`](../sdk/history.md) | const | Cancel reasons, in `BazaarTypes.CancelReason` order (None, Owner, Expired, ... Deleveraged). |
| [`history.CancelReason`](../sdk/history.md) | type | One of `CANCEL_REASONS`. |
| [`history.AMEND_SKIP_REASONS`](../sdk/history.md) | const | Why a best-effort amendment was skipped: Inactive, Expired, SizeFilled, BelowMinimum, WouldCross. |
| [`history.AmendSkipReason`](../sdk/history.md) | type | One of `AMEND_SKIP_REASONS`. |
| [`history.ORDER_EVENT_ACTIONS`](../sdk/history.md) | const | Order event kinds: Created, Triggered, Canceled, Amended, AmendSkipped. |
| [`history.OrderEventAction`](../sdk/history.md) | type | One of `ORDER_EVENT_ACTIONS`. |
| [`history.PAIR_STATUSES`](../sdk/history.md) | const | Pair statuses as the subgraph records them: Active, Scheduled, SettlementFixed, Terminated. |
| [`history.PairStatus`](../sdk/history.md) | type | One of `PAIR_STATUSES`. |
| [`history.SETTLEMENT_SOURCES`](../sdk/history.md) | const | How a settlement price was fixed: Cutoff, Stale, Insolvency. |
| [`history.SettlementSource`](../sdk/history.md) | type | One of `SETTLEMENT_SOURCES`. |
| [`history.INSURANCE_EVENT_KINDS`](../sdk/history.md) | const | Insurance event kinds: Deposit, WithdrawalRequested, WithdrawalLocked, WithdrawalExecuted, LevyCharged, LevyReceived. |
| [`history.InsuranceEventKind`](../sdk/history.md) | type | One of `INSURANCE_EVENT_KINDS`. |
| [`history.LISTING_STATUSES`](../sdk/history.md) | const | Listing statuses: Pending, Disputed, Deployed, Rejected, Expired, Voided. |
| [`history.ListingStatus`](../sdk/history.md) | type | One of `LISTING_STATUSES`. |
| [`history.IDENTIFIER_UPGRADE_STATUSES`](../sdk/history.md) | const | Identifier-upgrade statuses: Pending, Disputed, Queued, Upgraded, Canceled, Expired, Rejected. |
| [`history.IdentifierUpgradeStatus`](../sdk/history.md) | type | One of `IDENTIFIER_UPGRADE_STATUSES`. |
| [`history.TERMINATION_PROPOSAL_STATUSES`](../sdk/history.md) | const | UMA termination claim statuses: Pending, Disputed, Accepted, ScheduleRefused, Superseded, Rejected. |
| [`history.TerminationProposalStatus`](../sdk/history.md) | type | One of `TERMINATION_PROPOSAL_STATUSES`. |
| [`history.INSURER_PROPOSAL_STATUSES`](../sdk/history.md) | const | Insurer vote statuses: Open, Scheduled, Failed, Preempted, Voided, Rejected. |
| [`history.InsurerProposalStatus`](../sdk/history.md) | type | One of `INSURER_PROPOSAL_STATUSES`. |
| [`history.CANCEL_REASON_TEXT`](../sdk/history.md) | const | Why an order was canceled, in a sentence for its owner. |
| [`history.CANDLE_INTERVALS`](../sdk/history.md) | const | The candle intervals the subgraph keeps, in seconds: 1m, 5m, 15m, 1h, 4h, 1d. |
| [`history.CandleInterval`](../sdk/history.md) | type | One of `CANDLE_INTERVALS` (seconds). |
| [`history.Trade`](../sdk/history.md) | interface | One fill. |
| [`history.Candle`](../sdk/history.md) | interface | OHLCV over fills. |
| [`history.PairDayData`](../sdk/history.md) | interface | A pair's figures for one UTC day: volume, trade count, fees and OHLC. |
| [`history.HistoryOrder`](../sdk/history.md) | interface | An order as the subgraph records it: type, side, sizes and prices, status, integrator, cancel reason and times. |
| [`history.OrderEvent`](../sdk/history.md) | interface | One OrderUpdated, OrderAmended or OrderAmendSkipped log. |
| [`history.HistoryPosition`](../sdk/history.md) | interface | A position as the subgraph records it: side, size, entry value and price, collateral, funding index and totals. |
| [`history.PositionSnapshot`](../sdk/history.md) | interface | The full stored position a PositionBucketUpdated log reported. |
| [`history.PositionChange`](../sdk/history.md) | interface | A trade's effect on one position: the maker's per fill, the taker's once per order walk at its VWAP. |
| [`history.CollateralTransfer`](../sdk/history.md) | interface | One collateral deposit or withdrawal. |
| [`history.FeeBalance`](../sdk/history.md) | interface | A recipient's claimable balance on one pair: integrator fees, keeper rewards, relayer fees, refunds. |
| [`history.FeeMovement`](../sdk/history.md) | interface | One credit to a claimable balance (FeeAccrued), or one claim of it (FeesClaimed). |
| [`history.Liquidation`](../sdk/history.md) | interface | One liquidation: the account, the liquidator, size, bankruptcy price, price, notional and collateral seized. |
| [`history.AdlWindow`](../sdk/history.md) | interface | One ADL window, from the AdlTriggered that opened it to AdlResolved or the pair's termination. |
| [`history.AdlBatch`](../sdk/history.md) | interface | One executeAdl call. |
| [`history.AdlFill`](../sdk/history.md) | interface | One winner an ADL batch closed, fully or in part. |
| [`history.InsuranceProvider`](../sdk/history.md) | interface | An insurance LP on one pair: live shares, totals deposited and withdrawn, the pending request and lock, and levies. |
| [`history.InsuranceEvent`](../sdk/history.md) | interface | One insurance event: a deposit, request, lock, payout or levy, with amount and shares. |
| [`history.PairTermination`](../sdk/history.md) | interface | A finalized termination: the settlement price, what is owed, bad debt, the pot and the payout ratios. |
| [`history.TerminalRatioUpdate`](../sdk/history.md) | interface | A post-finalize settlement re-derived the payout ratios on the entitlements still unpaid. |
| [`history.TerminationProposal`](../sdk/history.md) | interface | A UMA termination claim. |
| [`history.InsurerProposal`](../sdk/history.md) | interface | An insurer termination vote: proposer, cutoff, window, whether a UMA claim backs it, the snapshot and the status. |
| [`history.InsurerVote`](../sdk/history.md) | interface | One yes-vote on an insurer proposal: voter, shares and the running total. |
| [`history.InsurerLevy`](../sdk/history.md) | interface | One levy charged on a yes-voter's shares after an insurer-vote termination. |
| [`history.ListingProposal`](../sdk/history.md) | interface | A listing proposal: pair id, deployer, feed, description, seed, status and times. |
| [`history.IdentifierUpgradeProposal`](../sdk/history.md) | interface | An identifier-upgrade proposal: proposer, new identifier, status and times. |
| [`history.IntegratorStats`](../sdk/history.md) | interface | What one integrator address has routed. |
| [`history.AccountStats`](../sdk/history.md) | interface | An account's lifetime totals: trades, volumes, fees paid, realized PnL, liquidations and bounties. |
| [`history.AccountDayData`](../sdk/history.md) | interface | An account's totals for one UTC day. |
| [`history.ProtocolDayData`](../sdk/history.md) | interface | Protocol-wide totals for one UTC day: volume, trades, fees, liquidations and unique traders. |
| [`history.MetaTransaction`](../sdk/history.md) | interface | One relayed (gasless) action: the user, the relayer, the action's type hash, nonce and fee. |
| [`history.PermitFailure`](../sdk/history.md) | interface | An ERC-2612 permit the pair could not execute; the call went on with the existing allowance. |
| [`history.BookLevel`](../sdk/history.md) | interface | Resting size at one price on one side. |
| [`history.Page`](../sdk/history.md) | interface | A page of results; `next` is the cursor for the following page, null at the end. |
| [`history.PageOptions`](../sdk/history.md) | interface | Paging options every query takes: `first` (1 to 1000, default 100), `after` (a cursor) and `atBlock`. |
| [`history.TimeOptions`](../sdk/history.md) | interface | `PageOptions` plus `from`, `to` (seconds) and `order`. |
| [`history.TradeFilter`](../sdk/history.md) | interface | Filters of `trades`: pair, account, maker, taker, plus `TimeOptions`. |
| [`history.MAX_FILLED_CANDLES`](../sdk/history.md) | const | The most candles `fillCandleGaps` returns: about 69 days of 1-minute candles, more than a chart shows. |
| [`history.BookLevelOptions`](../sdk/history.md) | interface | Options of `bookLevels`: the `side` (`"bid"` or `"ask"`) plus `PageOptions`. |
| [`history.OrderFilter`](../sdk/history.md) | interface | Filters of `orders`: account, pair, status, `openOnly`, order type, integrator, plus `TimeOptions`. |
| [`history.OrderEventFilter`](../sdk/history.md) | interface | Filters of `orderEvents`: account, pair, order id (with pair), action, plus `TimeOptions`. |
| [`history.PositionFilter`](../sdk/history.md) | interface | Filters of `positions`: account, pair, `openOnly`, plus `PageOptions`. |
| [`history.AccountPairFilter`](../sdk/history.md) | interface | An account and pair filter plus `TimeOptions`, used by several queries. |
| [`history.RecipientFilter`](../sdk/history.md) | interface | Filters of the fee queries: the recipient and pair, plus `TimeOptions`. |
| [`history.MetaTxFilter`](../sdk/history.md) | interface | Filters of `metaTransactions`: user, relayer, pair, plus `TimeOptions`. |
| [`history.SubgraphLag`](../sdk/history.md) | interface | What `subgraphLag` returns: the indexed block and time, the chain head, and how far behind the index is. |

### `previews`

What an order or a withdrawal would do, computed with the pair's own arithmetic.

| Export | Kind | What it is |
|---|---|---|
| [`previews.takerInsuranceFeeBase`](../sdk/previews.md) | function | RiskParamsLib.getTakerInsuranceFeeBase: the taker's base insurance rate (EBP) at a fund target ratio (bp). |
| [`previews.takerInsuranceFeeRates`](../sdk/previews.md) | function | RiskParamsLib.getInsuranceFeeRates: the taker insurance rates (EBP) from the fund's coverage and its target ratio. |
| [`previews.takerFillFee`](../sdk/previews.md) | function | One taker fill's fee (MatchingEngineLib._computePairFees, taker side). |
| [`previews.makerFillFee`](../sdk/previews.md) | function | One maker fill's fee: a flat 0.25 bp insurance leg, plus 0.25 bp when the order carries an integrator. |
| [`previews.feeBreakdown`](../sdk/previews.md) | function | Where a fee goes (MatchingEngineLib._finalizeTx). |
| [`previews.applyFill`](../sdk/previews.md) | function | MatchingEngineLib._applyFillCore: one fill's effect on a position. |
| [`previews.positionState`](../sdk/previews.md) | function | BucketLib.calculateState for a bucket, at the effective maintenance rate. |
| [`previews.fillMarginOk`](../sdk/previews.md) | function | MatchingEngineLib._checkMargin: whether a fill of `fillSize` at `price` (the maker's limit) passes the account's margin gate at the oracle `mark`. |
| [`previews.liquidationPrice`](../sdk/previews.md) | function | The estimated liquidation price of a position. |
| [`previews.maxLeverage`](../sdk/previews.md) | function | The most leverage the pair allows a new position now: 1 / imrBp (25 at a 4% initial margin). |
| [`previews.worstCaseNotional`](../sdk/previews.md) | function | CollateralLib._worstCaseNotional: the position plus same-side orders, or the opposite orders' overshoot into a flip. |
| [`previews.fillDebit`](../sdk/previews.md) | function | CollateralLib._fillDebitOf. |
| [`previews.restingReserve`](../sdk/previews.md) | function | CollateralLib._sweepRestingReserve: the account's live orders reserved at `mark`. |
| [`previews.creationGate`](../sdk/previews.md) | function | OrderManagementLib._creationShortfall: what createOrder requires of the account's collateral. |
| [`previews.simulateOrder`](../sdk/previews.md) | function | Run an order through the pair's arithmetic with every input given. |
| [`previews.previewOrder`](../sdk/previews.md) | function, bz | Preview an order for `account` on `pair`: the resulting position, the fills it meets in the current book with their fees, the collateral it requires, the liquidation price, the leverage allowed, and every reason the pair would refuse it. |
| [`previews.previewWithdrawal`](../sdk/previews.md) | function, bz | Preview a collateral withdrawal. |
| [`previews.MAKER_INSURANCE_FEE_EBP`](../sdk/previews.md) | const | BazaarTypes.MAKER_INSURANCE_FEE_EBP: 0.25 bp, flat. |
| [`previews.MAKER_INTEGRATOR_FEE_EBP`](../sdk/previews.md) | const | BazaarTypes.MAKER_INTEGRATOR_FEE_EBP: 0.25 bp, only on orders that carry an integrator. |
| [`previews.TAKER_INTEGRATOR_FEE_EBP`](../sdk/previews.md) | const | BazaarTypes.TAKER_INTEGRATOR_FEE_EBP: 0.25 bp, only on orders that carry an integrator. |
| [`previews.TAKER_INSURANCE_FEE_MIN_EBP`](../sdk/previews.md) | const | RiskParamsLib taker insurance curve: 0.75 bp at the 2% target, 4.25 bp at 10%, x(1 + 49 d^2) below target, 50 bp cap. |
| [`previews.TAKER_INSURANCE_FEE_MAX_EBP`](../sdk/previews.md) | const | The taker insurance rate at the 10% target ratio: 4.25 bp (EBP). |
| [`previews.TAKER_INSURANCE_FEE_MULTIPLIER`](../sdk/previews.md) | const | The below-target multiplier of the taker insurance curve: 49. |
| [`previews.TAKER_INSURANCE_FEE_CAP_EBP`](../sdk/previews.md) | const | The taker insurance rate's cap: 50 bp (EBP). |
| [`previews.INSURANCE_TARGET_BASE_BP`](../sdk/previews.md) | const | BazaarTypes.INSURANCE_TARGET_BASE / _MAX, in bp of open-interest notional. |
| [`previews.INSURANCE_TARGET_MAX_BP`](../sdk/previews.md) | const | The insurance fund's largest target ratio: 10% of open-interest notional (bp). |
| [`previews.BUG_BOUNTY_TAX_BP`](../sdk/previews.md) | const | BazaarTypes.BUG_BOUNTY_TAX_BP: 1% of the insurance and integrator fee streams. |
| [`previews.MAX_SLIPPAGE_BP`](../sdk/previews.md) | const | BazaarTypes.MAX_SLIPPAGE_BP: 10%. |
| [`previews.MAX_PLACEMENT_DEVIATION_BP`](../sdk/previews.md) | const | BazaarTypes.MAX_PLACEMENT_DEVIATION_BP: a Limit must sit within 50% of the price. |
| [`previews.MAX_STALE_DEVIATION_BP`](../sdk/previews.md) | const | BazaarTypes.MAX_STALE_DEVIATION_BP: fills under the stale fallback stay within 10% of it. |
| [`previews.MAX_ACTIVE_LIMIT_ORDERS`](../sdk/previews.md) | const | BazaarTypes.MAX_ACTIVE_LIMIT_ORDERS_PER_USER. |
| [`previews.TakerFeeRates`](../sdk/previews.md) | interface | Taker insurance rates (EBP): the dynamic rate for risk-adding notional and the base rate for risk-reducing notional. |
| [`previews.FillFee`](../sdk/previews.md) | interface | One fill's fee: the insurance leg, the integrator leg and the total. |
| [`previews.FeeBreakdown`](../sdk/previews.md) | interface | A fee split into what goes to the insurance fund, the integrator and the bug bounty. |
| [`previews.Bucket`](../sdk/previews.md) | interface | A position bucket as the pair stores it (BAZAAR precision; entryFundingIndex signed). |
| [`previews.MarginRates`](../sdk/previews.md) | interface | Margin rates in bp: initial, maintenance and the lagged maintenance rate. |
| [`previews.FillResult`](../sdk/previews.md) | interface | What `applyFill` returns: the new bucket, the realized price PnL and the funding settled. |
| [`previews.RestingOrder`](../sdk/previews.md) | interface | A live resting order as the reservation reads it. |
| [`previews.RestingReserve`](../sdk/previews.md) | interface | What `restingReserve` returns: the long and short exposure the live orders are reserved at, and the fill debit. |
| [`previews.CreationGate`](../sdk/previews.md) | interface | What `creationGate` returns: the collateral `createOrder` requires and whether the account has it. |
| [`previews.OrderInput`](../sdk/previews.md) | interface | An order as the preview takes it. |
| [`previews.BookMaker`](../sdk/previews.md) | interface | A resting order on the opposite side of the book, in book order. |
| [`previews.SimulateInput`](../sdk/previews.md) | interface | What `simulateOrder` takes: the order, account, bucket, mark, funding index, margin rates, book and the rest. |
| [`previews.PreviewFill`](../sdk/previews.md) | interface | One fill in a preview: price, size, notional, role, fee, and whether it is a resting remainder assumed filled later. |
| [`previews.PositionView`](../sdk/previews.md) | interface | A position in a preview: side, size, entry value and price, collateral, PnL and margin at the mark. |
| [`previews.PreviewIssue`](../sdk/previews.md) | interface | A reason the contract would refuse the call (or the walk would cancel the order), with its user message. |
| [`previews.OrderPreview`](../sdk/previews.md) | interface | A preview's position before, after everything fills and after this transaction, with fills, fees and issues. |
| [`previews.PriceInput`](../sdk/previews.md) | interface | A price to judge at: the spot (and bracket) of the update the call will carry. |
| [`previews.PreviewOptions`](../sdk/previews.md) | interface | Options of `previewOrder`: the `price` the call will carry, `walkBook`, and the `fillPrice` to assume without the book. |
| [`previews.OrderPreviewResult`](../sdk/previews.md) | interface | What `previewOrder` returns: the `OrderPreview` plus the mark, the venue, the fee rates and the margin rates. |
| [`previews.WithdrawalPreview`](../sdk/previews.md) | interface | What `previewWithdrawal` returns: the most that can be withdrawn now, and every freeze that applies. |

### `termination`

Ending a market, fixing its settlement price, finalizing it and withdrawing after.

| Export | Kind | What it is |
|---|---|---|
| [`termination.terminatorConstants`](../sdk/termination.md) | function, bz | The terminator's public constants (categories, outcomes, verdicts, settlement rules, bonds, liveness, reason length, sample count and spacing). |
| [`termination.requiredTerminationBond`](../sdk/termination.md) | function, bz | The USDC bond (6 decimals) a UMA termination claim posts now: max(1,000 USDC, UMA's minimum). |
| [`termination.settlementRule`](../sdk/termination.md) | function, bz | How `terminateScheduledPair` would settle the market if called now, and what it needs. |
| [`termination.terminationProposal`](../sdk/termination.md) | function, bz | A UMA termination claim by its assertion id, or null when the terminator has none. |
| [`termination.insurerProposal`](../sdk/termination.md) | function, bz | An insurer-termination proposal by id (a claim's assertion id, or a bare proposal's id), or null when none exists. |
| [`termination.getInsurerVote`](../sdk/termination.md) | function, bz | Shares `voter` has voted into proposal `id` on `pair` (0 when the record is dead or absent); after the fix, the voted stake the levy still draws on. |
| [`termination.getLockedShares`](../sdk/termination.md) | function, bz | Shares `user` has voted into live proposals on `pair`: what the insurance withdrawal gate refuses to release. |
| [`termination.getTerminalEntitlement`](../sdk/termination.md) | function, bz | The lens's terminal entitlement for `account` on `pair`. |
| [`termination.openProposals`](../sdk/termination.md) | function, bz | The open proposals on `pair`: UMA claims not yet resolved and insurer votes not yet resolved. |
| [`termination.terminationStatus`](../sdk/termination.md) | function, bz | A market's termination status in one call. |
| [`termination.reasonProblem`](../sdk/termination.md) | function | Why a termination `reason` would be refused, or null when the terminator accepts it (1 to 1,000 bytes of a restricted character set). |
| [`termination.unjudgedLevyBp`](../sdk/termination.md) | function | The levy (basis points) an unjudged outcome charges with `yes` of `snapshot` voted: 50% × dissent, at least 10%. |
| [`termination.proposeTermination`](../sdk/termination.md) | function, bz | Propose ending a market through UMA. |
| [`termination.settleTerminationProposal`](../sdk/termination.md) | function, bz | Settle a UMA termination claim once UMA can resolve it. |
| [`termination.insurerProposalId`](../sdk/termination.md) | function | keccak256(abi.encode(pair, proposer, timestamp)): a bare insurer proposal's id, fixed by the second it is filed. |
| [`termination.proposeInsurerTermination`](../sdk/termination.md) | function, bz | Propose that a market stop trading at `cutoffTs` with no UMA claim behind it (a bare insurer proposal). |
| [`termination.voteForInsurerTermination`](../sdk/termination.md) | function, bz | Vote yes on insurer proposal `id` by locking `shares` of your insurance shares. |
| [`termination.executeInsurerTermination`](../sdk/termination.md) | function, bz | Resolve insurer proposal `id` (anyone may). |
| [`termination.terminateStalePair`](../sdk/termination.md) | function, bz | End a market that has stored no price for more than 21 days, at its last stored price (or at a nominal price of 1 when it never stored one, aged from its creation). |
| [`termination.tickFetcher`](../sdk/termination.md) | function | A `TickFetcher` over the context's price source (its `atTick`). |
| [`termination.settlementPrint`](../sdk/termination.md) | function | One feed as a one-second update carries it; throws SettlementPrintError where the oracle would refuse the update for that feed. |
| [`termination.generatedAtOrAfter`](../sdk/termination.md) | function | Whether a settlement print carries a price generated at or after a target second (BazaarOracle._pricedSince). |
| [`termination.tickPrints`](../sdk/termination.md) | function | UMA's rule: Pyth's one-second update stamped at the cutoff for every leg, one update for a composite when its legs can be asked for together. |
| [`termination.chainSample`](../sdk/termination.md) | function | One leg of one chain sample: the earliest one-second update carrying a price generated at or after the target, with the quiet update before it when it is not the target's own. |
| [`termination.chainPrints`](../sdk/termination.md) | function | The chain rule's sample set. |
| [`termination.terminateScheduledPair`](../sdk/termination.md) | function, bz | Build `terminateScheduledPair(pair, priceUpdate)`. |
| [`termination.chainLastResort`](../sdk/termination.md) | function | The chain rule's last resort (BazaarPairTerminator._insurerSettlementBounds): 21 days after the cutoff, or 12 hours after a capping UMA cutoff when sooner. |
| [`termination.finalizeTermination`](../sdk/termination.md) | function, bz | Finalize a terminated market (stage 2, on the pair). |
| [`termination.decodeTerminatorLog`](../sdk/termination.md) | function | Decode a terminator log, or null for another contract's. |
| [`termination.proposalIdsFromReceipt`](../sdk/termination.md) | function, bz | The proposal ids a proposeTermination or proposeInsurerTermination receipt created. |
| [`termination.TERMINATION_PROPOSAL_BOND_USDC`](../sdk/termination.md) | const | The UMA termination bond's floor (USDC units); the bond posted is `requiredTerminationBond()`, which tracks UMA's own minimum upward. |
| [`termination.TERMINATION_PROPOSAL_LIVENESS`](../sdk/termination.md) | const | UMA liveness of a termination claim (seconds). |
| [`termination.MAX_REASON_LENGTH`](../sdk/termination.md) | const | Longest `reason` a termination claim takes, in bytes. |
| [`termination.MIN_CUTOFF_LEAD`](../sdk/termination.md) | const | A cutoff sooner than this after acceptance is moved to this far after it (BazaarTypes.MIN_CUTOFF_LEAD: limbo lead + 1 s). |
| [`termination.INSURER_TERMINATION_MIN_LEAD`](../sdk/termination.md) | const | Earliest a proposed cutoff may sit after the proposal, for a UMA claim and a bare insurer proposal alike (seconds). |
| [`termination.INSURER_TERMINATION_LATCH_LEAD`](../sdk/termination.md) | const | Voting and the latch close this long before a proposal's cutoff (seconds). |
| [`termination.INSURER_TERMINATION_MAX_LEAD`](../sdk/termination.md) | const | Votes open this long before the cutoff (or at filing if later), and a bare cutoff may sit no further out (seconds). |
| [`termination.INSURER_TERMINATION_THRESHOLD_BP`](../sdk/termination.md) | const | Share of the snapshot that must vote yes (basis points). |
| [`termination.INSURER_TERMINATION_BOND_USDC`](../sdk/termination.md) | const | The bond a bare insurer proposal posts (USDC units), a fixed figure. |
| [`termination.INSURER_SHARE_MATURITY_PERIOD`](../sdk/termination.md) | const | Shares must be held this long before the vote window opens to vote (seconds). |
| [`termination.INSURER_MAX_LIVE_VOTES`](../sdk/termination.md) | const | Most live proposals one voter may back on a pair. |
| [`termination.INSURER_LEVY_BP`](../sdk/termination.md) | const | Levy on each yes-voted share when the claim behind the vote is rejected (basis points). |
| [`termination.INSURER_LEVY_FLOOR_BP`](../sdk/termination.md) | const | The least an unjudged outcome levies on each yes-voted share (basis points). |
| [`termination.CLAIM_VERDICT_GRACE`](../sdk/termination.md) | const | How long after a claim is filed its vote-scheduled pair waits for the verdict (seconds). |
| [`termination.INSURER_POST_FIX_LOCK`](../sdk/termination.md) | const | Yes-voters of a costed outcome stay locked this long after the price fix: the insurance withdrawal cooldown (seconds). |
| [`termination.SCHEDULED_TERMINATION_GRACE`](../sdk/termination.md) | const | Under UMA's rule only the precise print settles for this long after the cutoff (or the verdict); then an empty call settles at the stored price (seconds). |
| [`termination.NEVER_PRICED_SETTLEMENT_PRICE`](../sdk/termination.md) | const | The settlement price (BAZAAR precision) a pair that never stored a price settles at under the stored-price paths (NEVER_PRICED_SETTLEMENT_PRICE). |
| [`termination.PAIR_SLOT_SHARE_EPOCH`](../sdk/termination.md) | const | BazaarPair storage slot of `shareEpoch`, which the terminator reads with `extsload` (PAIR_SLOT_SHARE_EPOCH). |
| [`termination.TerminationCategory`](../sdk/termination.md) | const + type | The four grounds a UMA termination claim may declare. |
| [`termination.TERMINATION_CATEGORY_INFO`](../sdk/termination.md) | const | What each category means, condensed from the claim text the terminator writes into UMA's assertion. |
| [`termination.SettlementRuleKey`](../sdk/termination.md) | type | A settlement rule's name: `nothing`, `window`, `chain` or `awaitVerdict`. |
| [`termination.SETTLEMENT_RULE_KEYS`](../sdk/termination.md) | const | settlementRule's answers, by number. |
| [`termination.SETTLEMENT_RULE_TEXT`](../sdk/termination.md) | const | What each settlement rule means. |
| [`termination.VerdictName`](../sdk/termination.md) | type | A UMA verdict's name: `pending`, `true` or `false`. |
| [`termination.VERDICT_NAMES`](../sdk/termination.md) | const | Verdict names by the terminator's number. |
| [`termination.OutcomeName`](../sdk/termination.md) | type | An insurer-vote outcome's name: `none`, `true`, `false` or `unjudged`. |
| [`termination.OUTCOME_NAMES`](../sdk/termination.md) | const | Outcome names by the terminator's number. |
| [`termination.OUTCOME_TEXT`](../sdk/termination.md) | const | What each insurer-vote outcome means for its yes-voters. |
| [`termination.TerminatorConstants`](../sdk/termination.md) | interface | The terminator's public constants, read from the chain, plus the live bond. |
| [`termination.SettlementRuleInfo`](../sdk/termination.md) | interface | settlementRule(pair), decoded. |
| [`termination.TerminationProposalInfo`](../sdk/termination.md) | interface | A UMA termination claim, from `terminationProposals(assertionId)`. |
| [`termination.InsurerProposalState`](../sdk/termination.md) | type | Where an insurer vote stands at the chain's time. |
| [`termination.InsurerProposalInfo`](../sdk/termination.md) | interface | An insurer-termination proposal, from `insurerProposals(id)`. |
| [`termination.TerminalEntitlement`](../sdk/termination.md) | interface | What a terminated market pays an account. |
| [`termination.TerminationPhase`](../sdk/termination.md) | type | Where a market is on its way to termination. |
| [`termination.OpenProposals`](../sdk/termination.md) | interface | Proposals still open on a market, and where their ids came from. |
| [`termination.TerminationStatus`](../sdk/termination.md) | interface | A market's termination state in one call. |
| [`termination.ProposalSearch`](../sdk/termination.md) | interface | Where to look for a market's open proposals. |
| [`termination.MAX_OPEN_PROPOSALS`](../sdk/termination.md) | const | The most open proposals of each kind (UMA claims, insurer votes) `openProposals` takes from the subgraph for one market. |
| [`termination.maturityCutoff`](../sdk/termination.md) | const | The maturity cutoff for a vote whose window opened at `windowOpenTs`: shares deposited at or before it vote. |
| [`termination.voteWindowOpens`](../sdk/termination.md) | const | When a claim's vote window opens: 14 days before its cutoff, or at filing (`now`) when that is later. |
| [`termination.InsurerExecutionOutcome`](../sdk/termination.md) | type | What executing an insurer vote would do now. |
| [`termination.SettlementPrint`](../sdk/termination.md) | interface | One of Pyth's one-second updates, read for one feed, as settlement evidence. |
| [`termination.TickFetcher`](../sdk/termination.md) | type | Pyth's one-second update stamped on a second, carrying the feeds asked for, or null when the archive has none. |
| [`termination.SettlementPrintError`](../sdk/termination.md) | class | A settlement update that could not be fetched, or a sample that cannot be proven. |
| [`termination.SettlementPrintFailure`](../sdk/termination.md) | type | Why a settlement update could not be had: `absent` (the archive answered, and no proven settlement exists now) or `unreachable` (the archive could not be asked, or its answer could not be used, so one may well exist). |
| [`termination.TickProof`](../sdk/termination.md) | interface | What UMA's rule settles a market with: the cutoff's update for every leg. |
| [`termination.ChainProof`](../sdk/termination.md) | interface | What the chain rule settles a market with: the updates in calldata order, the targets and the samples' seconds. |
| [`termination.ChainSearchBounds`](../sdk/termination.md) | interface | How far a chain sample may be searched for: the latest second allowed, and the present. |
| [`termination.SettleUnder`](../sdk/termination.md) | type | Which rule a terminateScheduledPair call settles under: UMA's cutoff update (`tick`), the chain's median, or the stored-price last resort. |
| [`termination.SettlementAttempt`](../sdk/termination.md) | interface | One candidate the builder tried. |
| [`termination.SettlementFailure`](../sdk/termination.md) | type | Why a candidate failed: no usable update exists (`absent`), the archive could not be asked or relied on (`unreachable`), or the oracle or the contract refused the set (`refused`). |
| [`termination.StoredPricePolicy`](../sdk/termination.md) | type | When `terminateScheduledPair` offers the irreversible stored-price call once its last resort is open: `whenAbsent` (every proven set failed as absent and the archive answered a control request), `always`, or `never`. |
| [`termination.ScheduledSettlementPlan`](../sdk/termination.md) | interface | What terminateScheduledPair needs now. |
| [`termination.TERMINATOR_EVENT_TEXT`](../sdk/termination.md) | const | What each terminator event means, for an activity feed. |

### `listings`

Proposing and settling new markets.

| Export | Kind | What it is |
|---|---|---|
| [`listings.descriptionProblem`](../sdk/listings.md) | function | Why a listing `description` would be refused, or null when the factory accepts it: 1 to 200 bytes of letters, digits, space and `. , & / -`. |
| [`listings.compositeId`](../sdk/listings.md) | function | keccak256(baseId ‖ quoteId ‖ invertQuote): the id a composite is registered and listed under (BazaarOracle.getCompositeId). |
| [`listings.asFeedId`](../sdk/listings.md) | function | The bytes32 feed ID for a Pyth Pro feed number, decimal digits, or a bytes32; an `InputError` for anything else. |
| [`listings.FeedIdInput`](../sdk/listings.md) | type | A feed ID as a caller may give it: the Pyth Pro feed number or the bytes32 that holds it. |
| [`listings.getComposite`](../sdk/listings.md) | function, bz | The legs `id` resolves to on the oracle, or null when it is not a registered composite (a plain feed id, or an unregistered one). |
| [`listings.registerComposite`](../sdk/listings.md) | function, bz | Register a composite feed on Bazaar's oracle, so `compositeId(baseId, quoteId, invertQuote)` can be listed. |
| [`listings.deploymentConstants`](../sdk/listings.md) | function, bz | MIN_DEPLOYMENT_AMOUNT, DEPLOYMENT_BOND_USDC, the live requiredDeploymentBond, DEPLOYMENT_LIVENESS and DVM_DISPUTE_GRACE. |
| [`listings.requiredDeploymentBond`](../sdk/listings.md) | function, bz | The USDC bond (6 decimals) a listing posts now: max(1,000 USDC, UMA's minimum). |
| [`listings.deploymentProposal`](../sdk/listings.md) | function, bz | A listing proposal by its UMA assertion id, or null when the factory has none. |
| [`listings.rawBaseFeed`](../sdk/listings.md) | function, bz | The raw Pyth feed a listing prices: the feed itself, or a composite's base leg (the key one-market-per-asset is enforced on). |
| [`listings.pendingDeployment`](../sdk/listings.md) | function, bz | The listing proposal pending for an asset, or null. |
| [`listings.openListings`](../sdk/listings.md) | function, bz | The listing proposals not yet resolved, found through the subgraph, the factory's logs or given ids, each read on chain. |
| [`listings.seedRefundOwed`](../sdk/listings.md) | function, bz | USDC (6 decimals) `account` may collect with claimSeedRefund from listings that did not deploy. |
| [`listings.proposePairDeployment`](../sdk/listings.md) | function, bz | Propose listing a market. |
| [`listings.settleDeploymentProposal`](../sdk/listings.md) | function, bz | Settle a listing once UMA can resolve it. |
| [`listings.expireStuckDeploymentProposal`](../sdk/listings.md) | function, bz | Release an asset's listing slot when its assertion cannot settle on UMA's oracle (a blacklisted payee, a dispute the DVM never resolves). |
| [`listings.claimSeedRefund`](../sdk/listings.md) | function, bz | Withdraw the seed credited back to the caller by listings that did not deploy (rejected, voided or released). |
| [`listings.decodeFactoryLog`](../sdk/listings.md) | function | Decode a factory log, or null for another contract's. |
| [`listings.listingFromReceipt`](../sdk/listings.md) | function, bz | The assertion id and pair id a proposePairDeployment receipt created, or null. |
| [`listings.MIN_DEPLOYMENT_AMOUNT`](../sdk/listings.md) | const | Least `totalAmount` a listing takes (BAZAAR precision): $1,000 bond + $3,000 seed. |
| [`listings.DEPLOYMENT_BOND_USDC`](../sdk/listings.md) | const | The listing bond's floor (USDC units); the bond posted is `requiredDeploymentBond()`, which tracks UMA's minimum upward. |
| [`listings.DEPLOYMENT_LIVENESS`](../sdk/listings.md) | const | UMA liveness of a listing (seconds). |
| [`listings.DVM_DISPUTE_GRACE`](../sdk/listings.md) | const | Extra wait before a disputed listing that cannot settle may be released (seconds). |
| [`listings.MIN_INSURANCE_SEED`](../sdk/listings.md) | const | Least insurance seed a pair is deployed with (BAZAAR precision): what remains of `totalAmount` after the bond. |
| [`listings.MAX_DESCRIPTION_LENGTH`](../sdk/listings.md) | const | Longest listing description, in bytes. |
| [`listings.PAIR_DEPLOYMENT_PROPOSAL_VOIDED`](../sdk/listings.md) | const | What `PairDeploymentProposalVoided` means. |
| [`listings.LISTING_EVENT_TEXT`](../sdk/listings.md) | const | What each factory listing event means, for an activity feed. |
| [`listings.CompositeFeed`](../sdk/listings.md) | interface | A composite feed's legs. |
| [`listings.DeploymentConstants`](../sdk/listings.md) | interface | The factory's listing constants, read from the chain, plus the live bond. |
| [`listings.DeploymentStatus`](../sdk/listings.md) | type | Where a listing stands. |
| [`listings.DeploymentProposalInfo`](../sdk/listings.md) | interface | A listing proposal, from `getDeploymentProposal(assertionId)`. |
| [`listings.ListingSearch`](../sdk/listings.md) | interface | Where `openListings` looks for listing proposals. |
| [`listings.OpenListings`](../sdk/listings.md) | interface | The unresolved listing proposals and where their ids came from. |
| [`listings.MAX_OPEN_LISTINGS`](../sdk/listings.md) | const | The most open listings `openListings` takes from the subgraph. |
| [`listings.MAX_LISTING_IDS`](../sdk/listings.md) | const | The most listing ids `openListings` reads on chain in one call. |

### `governance`

UMA identifier upgrades.

| Export | Kind | What it is |
|---|---|---|
| [`governance.isAssertTruthIdentifier`](../sdk/governance.md) | function | True when `identifier`'s first 12 bytes are ASCII "ASSERT_TRUTH" (the factory's truth-identifier rule). |
| [`governance.parseIdentifier`](../sdk/governance.md) | function | An identifier given as bytes32 hex or as its text ("ASSERT_TRUTH2"). |
| [`governance.identifierUpgradeConstants`](../sdk/governance.md) | function, bz | IDENTIFIER_UPGRADE_BOND_USDC, the live requiredIdentifierUpgradeBond, LIVENESS, TIMELOCK, MIN_NOTICE and DVM_DISPUTE_GRACE. |
| [`governance.requiredIdentifierUpgradeBond`](../sdk/governance.md) | function, bz | The USDC bond (6 decimals) an identifier-upgrade proposal posts now: max(5,000 USDC, UMA's minimum). |
| [`governance.umaIdentifier`](../sdk/governance.md) | function, bz | The identifier Bazaar's assertions are made under, as bytes32. |
| [`governance.umaIdentifierIsLive`](../sdk/governance.md) | function, bz | Whether Bazaar's identifier is on UMA's live whitelist. |
| [`governance.identifierUpgradeProposal`](../sdk/governance.md) | function, bz | An identifier-upgrade proposal by its assertion id, or null when the factory has none. |
| [`governance.identifierGovernance`](../sdk/governance.md) | function, bz | The identifier in force, whether it is live on UMA's whitelist, the pending upgrade (with where its UMA assertion stands) and the queued one (with when it may activate). |
| [`governance.proposeUmaIdentifierUpgrade`](../sdk/governance.md) | function, bz | Propose switching Bazaar to `newIdentifier`. |
| [`governance.settleIdentifierUpgradeProposal`](../sdk/governance.md) | function, bz | Settle an identifier-upgrade proposal once UMA can resolve it: UMA pays the bond to the winning side, and an approved upgrade is queued behind the timelock. |
| [`governance.expireStuckIdentifierUpgradeProposal`](../sdk/governance.md) | function, bz | Release the single pending-upgrade slot when its assertion cannot settle on UMA's oracle. |
| [`governance.activateIdentifierUpgrade`](../sdk/governance.md) | function, bz | Activate the queued identifier upgrade once its timelock has run (or 4 days after approval while the incumbent is off UMA's whitelist). |
| [`governance.IDENTIFIER_UPGRADE_BOND_USDC`](../sdk/governance.md) | const | The identifier-upgrade bond's floor (USDC units); the bond posted is `requiredIdentifierUpgradeBond()`. |
| [`governance.IDENTIFIER_UPGRADE_LIVENESS`](../sdk/governance.md) | const | UMA liveness of an identifier-upgrade proposal (seconds). |
| [`governance.IDENTIFIER_UPGRADE_TIMELOCK`](../sdk/governance.md) | const | Delay between approval and activation (seconds). |
| [`governance.IDENTIFIER_UPGRADE_MIN_NOTICE`](../sdk/governance.md) | const | Delay between approval and activation once the incumbent identifier is off UMA's live whitelist (seconds). |
| [`governance.ASSERT_TRUTH_PREFIX`](../sdk/governance.md) | const | Every adjudication identifier begins with these 12 ASCII bytes. |
| [`governance.IdentifierUpgradeConstants`](../sdk/governance.md) | interface | The governance track's constants, read from the factory, plus the live bond. |
| [`governance.IdentifierUpgradeProposalInfo`](../sdk/governance.md) | interface | An identifier-upgrade proposal. |
| [`governance.QueuedIdentifierUpgrade`](../sdk/governance.md) | interface | An approved upgrade waiting out its timelock. |
| [`governance.IdentifierGovernanceStatus`](../sdk/governance.md) | interface | The governance track in one call. |
| [`governance.IDENTIFIER_UPGRADE_EVENT_TEXT`](../sdk/governance.md) | const | What each governance event means, for an activity feed (decode them with listings' decodeFactoryLog). |

### `uma`

UMA assertions, disputes and settlement, and the shared helpers the costed builders use.

| Export | Kind | What it is |
|---|---|---|
| [`uma.optimisticOracleCodec`](../sdk/governance.md) | function | Codec for the Optimistic Oracle V3 fragment. |
| [`uma.erc20Codec`](../sdk/governance.md) | function | Codec for ERC-20 (USDC's approve, allowance, balanceOf, decimals). |
| [`uma.readMany`](../sdk/governance.md) | function, bz | Several reads in as few eth_calls as the node allows (Chain.batch), decoded. |
| [`uma.readOne`](../sdk/governance.md) | function, bz | One read. |
| [`uma.chainNow`](../sdk/governance.md) | function, bz | The latest block's timestamp: what the contracts' `block.timestamp` checks are judged against. |
| [`uma.usdcText`](../sdk/governance.md) | function | USDC units (6 decimals) as "1,000 USDC", exactly ("1,000.009999 USDC"). |
| [`uma.sharesText`](../sdk/governance.md) | function | Insurance shares (18 decimals) as "1,234.5678 shares", exactly. |
| [`uma.ethText`](../sdk/governance.md) | function | ETH in wei as "0.000001 ETH", exactly (7 wei is "0.000000000000000007 ETH"). |
| [`uma.timeText`](../sdk/governance.md) | function | A unix time (seconds) as "2026-11-08 14:00:00 UTC". |
| [`uma.durationText`](../sdk/governance.md) | function | A duration in seconds as "12 hours", "14 days", "7 seconds". |
| [`uma.asBytes32`](../sdk/governance.md) | function | A bytes32 field the caller typed, checked. |
| [`uma.asAddress`](../sdk/governance.md) | function | An address the caller typed, checked and checksummed. |
| [`uma.requireBondFloor`](../sdk/governance.md) | function | Throws `BondQuoteError` when `quoted` (USDC units) is below `floor`, the contract's own minimum for `what`. |
| [`uma.approveCall`](../sdk/governance.md) | function | An ERC-20 approve as a PreparedCall. |
| [`uma.bondApprovals`](../sdk/governance.md) | function, bz | The approvals `owner` must send before a call that pulls `pulls`, and what to tell them. |
| [`uma.identifierFromText`](../sdk/governance.md) | function | "ASSERT_TRUTH2" -&gt; its bytes32 (ASCII, right-padded with zeros), as UMA stores identifiers. |
| [`uma.identifierText`](../sdk/governance.md) | function | A bytes32 identifier as its ASCII text ("ASSERT_TRUTH2"), or null when it is not printable ASCII. |
| [`uma.optimisticOracle`](../sdk/governance.md) | function, bz | The deployment's Optimistic Oracle: `factory.oo()`, immutable. |
| [`uma.assertionOracle`](../sdk/governance.md) | function, bz | The oracle `assertionId` was made on: `factory.assertionOo(id)` or `terminator.assertionOo(id)`, falling back to `factory.oo()` when the record is empty (an id neither contract made). |
| [`uma.getAssertion`](../sdk/governance.md) | function, bz | The assertion record on `oo`, or null for an unknown id (OOv3 returns an all-zero record). |
| [`uma.assertionPhase`](../sdk/governance.md) | function | The phase of an assertion at chain time `now`. |
| [`uma.statusOf`](../sdk/governance.md) | function | The status of an assertion judged at `now`. |
| [`uma.assertionStatus`](../sdk/governance.md) | function, bz | Where an assertion stands: pending its liveness (with the time it can settle), settleable, disputed (waiting on the DVM), or settled true or false. |
| [`uma.getMinimumBond`](../sdk/governance.md) | function, bz | The smallest bond OOv3 accepts in `currency` (USDC by default), in its units; 0 when OOv3 has never cached it. |
| [`uma.defaultIdentifier`](../sdk/governance.md) | function, bz | OOv3's default identifier. |
| [`uma.burnedBondPercentage`](../sdk/governance.md) | function, bz | The share of a disputed bond UMA burns as its fee, 1e18 = 100% (50% on the live OOv3), or null if the oracle does not report it. |
| [`uma.identifierWhitelisted`](../sdk/governance.md) | function, bz | Whether `identifier` is on UMA's live IdentifierWhitelist, resolved as the factory and OOv3 resolve it: oracle -&gt; finder -&gt; IdentifierWhitelist -&gt; isIdentifierSupported. |
| [`uma.previewSettlement`](../sdk/governance.md) | function, bz | Simulate OOv3's `settleAndGetAssertionResult(assertionId)` without sending it. |
| [`uma.previewSettlementOn`](../sdk/governance.md) | function | `previewSettlement` on an oracle the caller already resolved with `assertionOracle` (no check of `oo`, so never pass one a user gave). |
| [`uma.decodeAssertionLog`](../sdk/governance.md) | function | Decode an OOv3 log (AssertionMade, AssertionDisputed, AssertionSettled), or null for another contract's. |
| [`uma.disputeAssertion`](../sdk/governance.md) | function, bz | Dispute an assertion: you match its bond, and UMA's DVM votes on the claim. |
| [`uma.settleAssertion`](../sdk/governance.md) | function, bz | Settle an assertion on the oracle directly. |
| [`uma.requireSettleable`](../sdk/governance.md) | function | Throws the InputError a settle attempt deserves when the assertion cannot settle yet. |
| [`uma.optimisticOracleV3Abi`](../sdk/governance.md) | const | The slice of UMA's OptimisticOracleV3Interface these flows need. |
| [`uma.isZero32`](../sdk/governance.md) | const | True for the all-zero bytes32 the contracts use as "none". |
| [`uma.ContractRead`](../sdk/governance.md) | interface | One read for `readMany`. |
| [`uma.ReadError`](../sdk/governance.md) | class | A read that reverted, with its decoded reason. |
| [`uma.CostKind`](../sdk/termination.md) | type | What a cost is: a bond (returned or forfeited by a verdict), an insurance seed, an ETH fee, a levy on shares, or shares locked. |
| [`uma.Cost`](../sdk/termination.md) | interface | One thing a call costs or puts at risk, for a confirmation screen. |
| [`uma.CostedCall`](../sdk/termination.md) | interface | A prepared write that posts a bond, moves money or locks shares, with what it costs. |
| [`uma.TokenPull`](../sdk/termination.md) | interface | A bond or seed an ERC-20 `transferFrom` will pull from the caller. |
| [`uma.MIN_ASSERTION_BOND_USDC`](../sdk/governance.md) | const | The least bond any Bazaar assertion posts (USDC units): the listing and termination floors; an identifier upgrade's is 5,000 USDC. |
| [`uma.BondQuoteError`](../sdk/governance.md) | class | A bond quote read from the chain that cannot be right: below the floor the contract itself enforces (an RPC answering 0, say). |
| [`uma.AssertionHome`](../sdk/governance.md) | type | Where an assertion was made: the factory (listings, identifier upgrades) or the terminator (termination claims). |
| [`uma.UmaAssertion`](../sdk/governance.md) | interface | An OOv3 assertion record. |
| [`uma.AssertionPhase`](../sdk/governance.md) | type | Where an assertion stands, for a UI. |
| [`uma.AssertionStatus`](../sdk/governance.md) | interface | What `assertionStatus` returns: the phase, the assertion record, and when it can be settled. |
| [`uma.ASSERTION_PHASE_TEXT`](../sdk/governance.md) | const | Text for each assertion phase. |
| [`uma.SettlementPreview`](../sdk/governance.md) | interface | What settling an assertion would do right now. |
| [`uma.ASSERTION_EVENT_TEXT`](../sdk/governance.md) | const | What each OOv3 event means, for an activity feed. |

### `format`

The error messages and the display formatters (`errors/messages.ts`).

| Export | Kind | What it is |
|---|---|---|
| [`format.formatUsd`](../sdk/errors.md) | function | A BAZAAR-precision amount as dollars: "$1,234.56"; amounts under a cent keep six decimals. |
| [`format.formatPrice`](../sdk/errors.md) | function | A BAZAAR-precision price: "$3,012.5", "$1.08765", "$0.00001234". |
| [`format.formatAmount`](../sdk/errors.md) | function | A BAZAAR-precision quantity (size, shares): "1.25", "12,000". |
| [`format.formatBp`](../sdk/errors.md) | function | Basis points as percent: 250 -&gt; "2.5%". |
| [`format.formatEth`](../sdk/errors.md) | function | Wei as ETH: "0.0001 ETH". |
| [`format.formatDuration`](../sdk/errors.md) | function | A duration in seconds, roughly: "45 s", "12 min", "3 h", "13 days". |
| [`format.formatTime`](../sdk/errors.md) | function | A Unix time (seconds) as "2026-11-08 14:00 UTC (in 3 h)". |
| [`format.formatUtc`](../sdk/errors.md) | function | A Unix time (seconds) as "2026-11-08 14:00:05 UTC", with no hint relative to this machine's clock: for a time judged against the chain's clock. |
| [`format.installUserMessages`](../sdk/errors.md) | function | Register `USER_MESSAGES` so `DecodedError.message` returns them. |
| [`format.userMessage`](../sdk/errors.md) | function | The user-facing message for a custom error by name, with its arguments; the name itself when unknown. |
| [`format.walletErrorMessage`](../sdk/errors.md) | function | A message for a failure the wallet raised rather than the contract. |
| [`format.errorMessage`](../sdk/errors.md) | function | The text to show a user for any error a Bazaar call can throw. |
| [`format.USER_MESSAGES`](../sdk/errors.md) | const | Every custom error's user-facing message, by error name. |

## Low-Level Exports

The chain, ABI, price, formula and market layers the keeper and the areas are built on. See [Low-Level Building Blocks](../sdk/low-level.md).

### Protocol Constants

| Export | Kind | What it is |
|---|---|---|
| [`BAZAAR_SCALE`](units.md) | const | 1e18: BAZAAR precision, $1 or one unit. |
| [`BP_SCALE`](units.md) | const | 10,000: basis points in 100%. |
| [`EBP_SCALE`](units.md) | const | 1,000,000: EBP (1/100 bp) in 100%. |
| [`USDC_DECIMALS`](units.md) | const | 6. |
| [`USDC_TO_BAZAAR`](units.md) | const | BAZAAR precision carries twelve more decimals than USDC. |
| [`MAX_PRICE_STALENESS`](units.md) | const | Seconds a print may sit from the block's timestamp: 3. |
| [`LIMBO_LEAD`](units.md) | const | Seconds before a scheduled cutoff that trading halts: 6. |
| [`MIN_ORDER_AMOUNT`](units.md) | const | The smallest order notional: $5 (BAZAAR precision). |
| [`MIN_COLLATERAL_DEPOSIT`](units.md) | const | The smallest collateral deposit: $5 (BAZAAR precision). |
| [`MAX_WALK_STEPS`](units.md) | const | The default and largest walk budget of an arriving order: 32. |
| [`MAX_TRIGGER_EXECS_PER_CALL`](units.md) | const | Trigger orders one `executeTriggeredOrders` call fires at most: 20. |
| [`LIQUIDATION_FEE_EBP`](units.md) | const | The liquidation fee: 2 bp (EBP). |
| [`MIN_LIQUIDATOR_REWARD`](units.md) | const | The least a liquidation pays its caller: $0.05. |
| [`TERMINAL_SETTLEMENT_TIP`](units.md) | const | The tip for settling someone else's position at the fixed settlement price: up to $0.05. |
| [`TERMINAL_SETTLEMENT_ESCAPE`](units.md) | const | Seconds after the settlement price is fixed before `finalizeTermination` stops waiting for every position to be settled: 14 days. |
| [`UNLOAD_BOUNTY_MIN`](units.md) | const | The floor of an unload's reward: $0.25. |
| [`UNLOAD_BOUNTY_MIN_NOTIONAL`](units.md) | const | The unload size at which the $0.25 floor applies, and the inventory notional for the fast refresh cadence: $1,250. |
| [`UNLOAD_FLOOR_DECAY`](units.md) | const | Seconds over which the unload floor slides from the band edge to the fund-neutral price: 180. |
| [`ADL_AUCTION_DURATION`](units.md) | const | Seconds the ADL score threshold takes to decay: 600. |
| [`ADL_MAX_SCORE`](units.md) | const | The ADL score threshold at the start of the auction: 25 (BAZAAR precision). |
| [`ADL_TERMINATION_GRACE`](units.md) | const | Seconds after the first price stored past an ADL timeout before the market winds down: 1,800. |
| [`MAX_LIQUIDATION_PRICE_AGE`](units.md) | const | Seconds before the block a liquidation's price may have been generated (Pyth's latest price, on a market with trading hours): 60. A call without an update needs a stored price at most 3 s old. |
| [`ADL_TIMEOUT_DURATION`](units.md) | const | Seconds after which an open ADL window times out: 1 day. |
| [`MAX_ADL_WINNERS_PER_BATCH`](units.md) | const | Most entries each winner list of an ADL batch may hold: 25. |
| [`REFRESH_BOUNTY`](units.md) | const | What a paid `refreshPrice` earns: $0.10. |
| [`REFRESH_BOUNTY_MIN_GAP`](units.md) | const | The fast refresh cadence: a paid refresh at most every 300 seconds. |
| [`REFRESH_BOUNTY_HEARTBEAT`](units.md) | const | The slow refresh cadence: a paid refresh at most every day. |
| [`REFRESH_BOUNTY_FAST_MIN_INSURANCE`](units.md) | const | Free capital above which the fast cadence applies: $5,000. |
| [`REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE`](units.md) | const | Free capital the fund must exceed for a refresh to pay: $1,000. |
| [`MAX_CONFIDENCE_BP`](units.md) | const | The widest confidence interval a leg may carry: 2% of its price (bp). |
| [`BAZAAR_EXPONENT`](units.md) | const | -18: the exponent the oracle converts prices to. |
| [`ORACLE_DEAD_THRESHOLD`](units.md) | const | Seconds without a stored price after which a market can be terminated as stale: 21 days. |
| [`SETTLEMENT_SAMPLE_COUNT`](units.md) | const | Samples the chain settlement rule takes: 5. |
| [`SETTLEMENT_SAMPLE_SPACING`](units.md) | const | Seconds between the chain rule's samples: 600. |
| [`SETTLE_NOTHING`](units.md) | const | Settlement rule 0: nothing to settle. |
| [`SETTLE_TICK`](units.md) | const | Settlement rule 1: UMA's rule, the update stamped at the cutoff. |
| [`SETTLE_CHAIN`](units.md) | const | Settlement rule 2: the chain rule's median of samples. |
| [`SETTLE_AWAIT_VERDICT`](units.md) | const | Settlement rule 3: waiting for a UMA verdict. |
| [`OrderType`](units.md) | const + type | Order types by name (`OrderType.Limit` is 1), and the type of their values. |
| [`MARKET`](units.md) | const | Order type 0. |
| [`LIMIT`](units.md) | const | Order type 1. |
| [`STOP_LIMIT`](units.md) | const | Order type 2. |
| [`TAKE_PROFIT`](units.md) | const | Order type 3. |
| [`STOP_LOSS`](units.md) | const | Order type 4. |
| [`TRIGGER_TYPES`](units.md) | const | The trigger order types: StopLimit, TakeProfit, StopLoss. |
| [`ORDER_TYPE_NAMES`](units.md) | const | Order type names by number. |
| [`TRIGGER_PRICE_MASK`](units.md) | const | An order's trigger price sits in the low 128 bits; its keeper bounty in the high 128. |
| [`ETH_USD_FEED`](units.md) | const | Pyth Pro ETH/USD (feed 2) as a bytes32 feed id, used to price gas. |
| [`ZERO_ADDRESS`](units.md) | const | The zero address. |
| [`MAX_UINT256`](units.md) | const | 2^256 - 1. |

### Typed ABIs

| Export | Kind | What it is |
|---|---|---|
| [`bazaarFactoryAbi`](../sdk/low-level.md) | const | BazaarFactory's ABI, typed `as const` for viem. |
| [`bazaarOracleAbi`](../sdk/low-level.md) | const | BazaarOracle's ABI, typed `as const` for viem. |
| [`bazaarPairAbi`](../sdk/low-level.md) | const | BazaarPair's ABI (with the events and errors of the libraries it links), typed `as const` for viem. |
| [`bazaarPairLensAbi`](../sdk/low-level.md) | const | BazaarPairLens's ABI, typed `as const` for viem. |
| [`bazaarPairTerminatorAbi`](../sdk/low-level.md) | const | BazaarPairTerminator's ABI, typed `as const` for viem. |
| [`ABI_SOURCE`](../sdk/low-level.md) | const | The Bazaar commit and date the ABIs were synced from, and whether that tree was dirty. |
| [`ABIS`](../sdk/low-level.md) | const | The five ABIs by contract name. |
| [`ContractName`](../sdk/low-level.md) | type | `"BazaarFactory"`, `"BazaarOracle"`, `"BazaarPair"`, `"BazaarPairLens"` or `"BazaarPairTerminator"`. |
| [`CONTRACT_NAMES`](../sdk/low-level.md) | const | The five contract names. |

### Chain, JSON-RPC and the Probe

| Export | Kind | What it is |
|---|---|---|
| [`readTextCapped`](../sdk/low-level.md) | function | A response's body as text, holding at most `maxBytes` of it. |
| [`toRpcError`](../sdk/low-level.md) | function | Normalize whatever a transport threw into an RpcError when it carries a JSON-RPC error. |
| [`sleep`](../sdk/low-level.md) | function | A promise that resolves after `ms` milliseconds. |
| [`RequestArgs`](../sdk/low-level.md) | interface | A JSON-RPC request: method and params. |
| [`Transport`](../sdk/low-level.md) | interface | EIP-1193's request method: what a browser wallet, a viem client and JsonRpc all provide. |
| [`RpcError`](../sdk/low-level.md) | class | A JSON-RPC error: its code, the node's message and data, and the revert payload when there is one. |
| [`HttpError`](../sdk/low-level.md) | class | A non-2xx HTTP response. |
| [`ResponseTooLargeError`](../sdk/low-level.md) | class | A response body over the reader's byte limit. |
| [`JsonRpcOptions`](../sdk/low-level.md) | interface | Options of `JsonRpc`: requests per second, timeout, retries, headers, response size cap and `fetch`. |
| [`RequestOptions`](../sdk/low-level.md) | interface | Per-request options of `JsonRpc.request`. |
| [`NEVER_RETRIED`](../sdk/low-level.md) | const | Methods JsonRpc sends at most once, whatever `retries` says. |
| [`JsonRpc`](../sdk/low-level.md) | class | A small JSON-RPC client over HTTP(S): rate limited, retried on transient failures except for sends, with response bodies capped. |
| [`SendError`](../sdk/low-level.md) | class | A send whose outcome is unknown: the signed transaction left this process, but nothing settled whether the node took it. |
| [`Block`](../sdk/low-level.md) | interface | A block's number, timestamp, hash, parent hash and base fee. |
| [`ProbeResult`](../sdk/low-level.md) | interface | A probe simulation's result: ok, return data, claimable balance before and after, gas, and the state flags after. |
| [`Read`](../sdk/low-level.md) | interface | One call in a batched read. |
| [`Receipt`](../sdk/low-level.md) | interface | A transaction receipt: hash, block, status, gas, sender, target and logs. |
| [`BlockTag`](../sdk/low-level.md) | type | A block number, or `latest`, `pending`, `safe`, `finalized` or `earliest`. |
| [`ChainOptions`](../sdk/low-level.md) | interface | Options of `Chain`: `send`, a separate transport to submit transactions through. |
| [`Chain`](../sdk/low-level.md) | class | Chain access over any `Transport`: reads, batched reads, probe simulations, gas, logs, receipts and raw sends. |
| [`findDeploymentBlock`](../sdk/low-level.md) | function | The first block whose state holds code at `address`. |
| [`DeploymentBlockError`](../sdk/low-level.md) | class | `findDeploymentBlock` could not find the block (no code at the head, or the node cannot read old state). |
| [`FindDeploymentOptions`](../sdk/low-level.md) | interface | Options of `findDeploymentBlock`: the block range to search. |
| [`probeCodec`](../sdk/low-level.md) | function | The simulation probe's codec (`execute`, `aggregate`). |
| [`stateOverride`](../sdk/low-level.md) | function | The `eth_call` state override that places the probe at `PROBE_ADDRESS`. |
| [`PROBE_ADDRESS`](../sdk/low-level.md) | const | Where the probe's code is placed by state override. |
| [`PROBE_BALANCE`](../sdk/low-level.md) | const | ETH the override gives the probe, to pay Pyth fees inside simulations. |
| [`runtimeCode`](../sdk/low-level.md) | const | `runtimeCode()`: the probe's runtime bytecode. |
| [`StateOverride`](../sdk/low-level.md) | type | The eth_call state override that places the probe. |

### Codecs and Revert Decoding

| Export | Kind | What it is |
|---|---|---|
| [`canonicalType`](../sdk/low-level.md) | function | An ABI parameter's canonical type string (tuples expanded). |
| [`signature`](../sdk/low-level.md) | function | A function or event signature string, as hashed for selectors and topics. |
| [`codec`](../sdk/low-level.md) | function | The cached `ContractCodec` for one of the five contracts. |
| [`allErrors`](../sdk/low-level.md) | function | Every custom error the five contracts declare, by selector. |
| [`FunctionSpec`](../sdk/low-level.md) | interface | A function in a codec: name, inputs, outputs, selector. |
| [`EventSpec`](../sdk/low-level.md) | interface | An event in a codec: name, inputs, topic0. |
| [`ErrorSpec`](../sdk/low-level.md) | interface | A custom error in a codec: name, inputs, selector. |
| [`RawLog`](../sdk/low-level.md) | interface | A log as Chain.logs and Chain.receipt return it. |
| [`DecodedLog`](../sdk/low-level.md) | interface | A decoded log: name, address, args, and where it sits. |
| [`ContractCodec`](../sdk/low-level.md) | class | Encode and decode one contract's calls, return values, logs and errors (`encode`, `decode`, `decodeLog`, ...). |
| [`factory`](../sdk/low-level.md) | const | `factory()`: the BazaarFactory codec. |
| [`pair`](../sdk/low-level.md) | const | `pair()`: the BazaarPair codec. |
| [`lens`](../sdk/low-level.md) | const | `lens()`: the BazaarPairLens codec. |
| [`terminator`](../sdk/low-level.md) | const | `terminator()`: the BazaarPairTerminator codec. |
| [`oracle`](../sdk/low-level.md) | const | `oracle()`: the BazaarOracle codec. |
| [`registerUserMessages`](../sdk/low-level.md) | function | Register user-facing messages by error name for `DecodedError.message` (what `installUserMessages` calls). |
| [`decodeError`](../sdk/low-level.md) | function | Revert data as a `DecodedError`: the error's name, arguments and hint. |
| [`KEEPER_HINTS`](../sdk/low-level.md) | const | What each error means for a keeper, and what to do about it. |
| [`VERIFIER_REASON_HINTS`](../sdk/low-level.md) | const | What each reason string Pyth's verifier reverts with means for a keeper. |
| [`registerReasonMessages`](../sdk/low-level.md) | function | Register user-facing messages for plain revert reasons, by the reason string. |
| [`DecodedError`](../sdk/low-level.md) | class | A decoded revert: `name`, `args`, `hint`, `data`, `message` (the user text), and `opensAt()` for a too-early error. |

### Reader, Models and Formulas

| Export | Kind | What it is |
|---|---|---|
| [`freeCapital`](../sdk/low-level.md) | function | The insurance balance less the seizure earmarked against inventory the vault holds. |
| [`inventorySize`](../sdk/low-level.md) | function | The vault's liquidated inventory size on both sides of a `MarketState`. |
| [`marketStatus`](../sdk/low-level.md) | function | A `MarketState`'s `Status` at a time: terminated, settling, limbo, adl or live. |
| [`marketStatic`](../sdk/low-level.md) | function | The part of a `Market` that never changes. |
| [`marketFromStatic`](../sdk/low-level.md) | function | A `Market` rebuilt from its static part, with no state read yet. |
| [`orderRemaining`](../sdk/low-level.md) | function | An order's unfilled size. |
| [`Status`](../sdk/low-level.md) | const + type | A market's status (`Status.Live` is `"live"`; also `adl`, `limbo`, `settling`, `terminated`), and the type of its values. |
| [`Inventory`](../sdk/low-level.md) | interface | The vault's liquidated inventory on one side: size, entry and bankruptcy notional, seized collateral, funding index. |
| [`emptyInventory`](../sdk/low-level.md) | const | An `Inventory` with every field zero. |
| [`MarketState`](../sdk/low-level.md) | interface | One read of a market's on-chain state (Reader.marketStates). |
| [`Market`](../sdk/low-level.md) | interface | A market as the keeper and `Reader` track it: address, pair id, feeds, calendar, label, and its last state read. |
| [`MarketStatic`](../sdk/low-level.md) | interface | The part of a Market that never changes, as stored in snapshots. |
| [`Position`](../sdk/low-level.md) | interface | An open position as the keeper indexes it. |
| [`Order`](../sdk/low-level.md) | interface | A live order as the keeper indexes it. |
| [`mulDiv`](../sdk/low-level.md) | function | OpenZeppelin Math.mulDiv for non-negative operands: floor(x * y / d). |
| [`signedMulDiv`](../sdk/low-level.md) | function | BazaarMathLib.signedMulDiv: (x * y) / d rounded toward zero. |
| [`effectiveMmrBp`](../sdk/low-level.md) | function | BucketLib.effectiveMmrBp: the lower of the current rate and a non-zero lagged one. |
| [`bucketState`](../sdk/low-level.md) | function | BucketLib.calculateState, with `mmrBp` already the effective rate. |
| [`marginRatio`](../sdk/low-level.md) | function | Equity over the maintenance requirement: below 1 is liquidatable. |
| [`triggerReached`](../sdk/low-level.md) | function | MatchingEngineLib._triggerReached, inclusive at the trigger. |
| [`adlThreshold`](../sdk/low-level.md) | function | AdlLib._getAdlScoreThreshold: quadratic decay from ADL_MAX_SCORE to 1 over the auction. |
| [`adlScore`](../sdk/low-level.md) | function | PnL over the collateral less this window's tagged deposit, floored at 1 (AdlLib._scoreCollateral). |
| [`refreshBountyGap`](../sdk/low-level.md) | function | The minimum gap between paid refreshes for a market (fast or heartbeat cadence). |
| [`refreshBountyDue`](../sdk/low-level.md) | function | Whether refreshPrice would pay its bounty when it stores a print published at newPublishTs. |
| [`refreshBountyDueAt`](../sdk/low-level.md) | function | The first block time at which the bounty is payable, or null while the fund is too small. |
| [`convertExponent`](../sdk/low-level.md) | function | BazaarMathLib.convertExponent (division truncates toward zero). |
| [`legConfOk`](../sdk/low-level.md) | function | Whether a leg's confidence interval is within 2% of its price. |
| [`pairPrice`](../sdk/low-level.md) | function | The price BazaarOracle composes from one or two legs, and whether it clears the 2% cap. |
| [`BucketState`](../sdk/low-level.md) | interface | What `bucketState` returns: PnL, funding PnL, notional, the maintenance requirement and available equity. |
| [`MAX_EXPONENT_SHIFT`](../sdk/low-level.md) | const | The largest exponent difference `convertExponent` takes: 10^77 is the largest power of ten a uint256 holds, so the contract reverts past it (and an unbounded one would stall the caller). |
| [`Leg`](../sdk/low-level.md) | interface | One Pyth leg of a price: price, confidence, exponent, publish time. |
| [`PairPrice`](../sdk/low-level.md) | interface | What `pairPrice` returns: spot, the confidence bracket, the publish time, and whether confidence is within the cap. |
| [`Deployment`](../sdk/low-level.md) | interface | The contracts a factory is wired to. |
| [`OrderRecord`](../sdk/low-level.md) | interface | `orders(id)` on a pair, with the lens's `triggerBounty` for it. |
| [`PositionBucket`](../sdk/low-level.md) | interface | `positionBuckets(account)` on a pair: an account's position as the chain holds it now. |
| [`Reader`](../sdk/low-level.md) | class | Batched chain reads: the deployment's wiring, market discovery, per-block market state, positions and orders. |

### Subgraph Client

| Export | Kind | What it is |
|---|---|---|
| [`SUBGRAPH_PAGE`](../sdk/low-level.md) | const | Rows per page: the most a hosted graph-node returns for one `first:`. |
| [`SubgraphClient`](../sdk/low-level.md) | class | A GraphQL client for Bazaar's subgraph: queries, the indexer's head, and paging pinned to a block. |
| [`SubgraphError`](../sdk/low-level.md) | class | A `SubgraphClient` query the subgraph refused or failed (not the same class as `history.SubgraphError`). |
| [`SubgraphMeta`](../sdk/low-level.md) | type | The indexer's head: the block it has indexed, its hash, and whether it hit indexing errors. |
| [`SubgraphOptions`](../sdk/low-level.md) | interface | Options of `SubgraphClient`: `timeoutMs`, `fetch`, `maxResponseBytes` and `maxPages`. |

### Prices: Pyth Pro, PriceService and Signed Updates

The `lazer` namespace holds the whole update codec; its types, its error and the feed id helpers are also at the top level.

| Export | Kind | What it is |
|---|---|---|
| [`lazer.parseUpdate`](../sdk/low-level.md) | function | Reads a Pyth Pro update and recovers its signer: `{ signer, timestampUs, channel, feeds, payload }`. |
| [`lazer.readUpdate`](../sdk/low-level.md) | function | Reads an update without recovering its signer. |
| [`lazer.canonicalUpdate`](../sdk/low-level.md) | function | An update exactly as the verifier reads it: the envelope's header and the payload its size field names, as lowercase hex, without any bytes after them. |
| [`lazer.legEntries`](../sdk/low-level.md) | function | Each leg as BazaarOracle reads it out of a call's updates: the leg's entry in the update holding its most recently generated price (the earlier update on a tie); null for a leg no update carries. |
| [`lazer.parsePayload`](../sdk/low-level.md) | function | Reads a signed payload as LazerPayloadLib.readFeeds does; throws where the contract reverts as malformed. |
| [`lazer.splitUpdate`](../sdk/low-level.md) | function | Splits an update into its signature and its payload, as Pyth's verifier does. |
| [`lazer.recoverSigner`](../sdk/low-level.md) | function | The address that signed an update. |
| [`lazer.encodePayload`](../sdk/low-level.md) | function | Encodes a payload from feed fields (tests, local chains). |
| [`lazer.signPayload`](../sdk/low-level.md) | function | Wraps a payload in the EVM envelope, signed with a private key. |
| [`lazer.buildUpdate`](../sdk/low-level.md) | function | `encodePayload`, then `signPayload`. |
| [`lazer.localSignerKey`](../sdk/low-level.md) | function | The private key Bazaar's local deployments sign updates with: public by construction. |
| [`lazer.LOCAL_SIGNER_LABEL`](../sdk/low-level.md) | const | The label the local signing key is derived from. |
| [`lazer.normalizeHex`](../sdk/low-level.md) | function | Lowercase, 0x-prefixed form of hex given with or without 0x, or null when it is not whole bytes of hex. |
| [`lazer.channelName`](../sdk/low-level.md) | function | A payload channel number's name, or null. |
| [`lazer.ENVELOPE_MAGIC`](../sdk/low-level.md) | const | The first four bytes of an update in the EVM envelope. |
| [`lazer.PAYLOAD_MAGIC`](../sdk/low-level.md) | const | The first four bytes of a payload. |
| [`lazer.ENVELOPE_HEADER_BYTES`](../sdk/low-level.md) | const | Envelope bytes before the payload: 71. |
| [`lazer.MAX_PAYLOAD_BYTES`](../sdk/low-level.md) | const | The longest payload an envelope can frame. |
| [`lazer.MICROS_PER_SECOND`](../sdk/low-level.md) | const | 1,000,000n. |
| [`lazer.MAX_UPDATE_BYTES`](../sdk/low-level.md) | const | The largest update there can be: the envelope's header and the longest payload it can frame. |
| [`lazer.MAX_FEEDS_PER_UPDATE`](../sdk/low-level.md) | const | The most feeds one payload carries: its feed count is one byte. |
| [`lazer.HAS_PRICE`](../sdk/low-level.md) | const | Bit of `LazerFeed.included`: the payload carries the price. |
| [`lazer.HAS_EXPONENT`](../sdk/low-level.md) | const | Bit of `LazerFeed.included`: the payload carries the exponent. |
| [`lazer.HAS_CONFIDENCE`](../sdk/low-level.md) | const | Bit of `LazerFeed.included`: the payload carries the confidence. |
| [`lazer.HAS_FEED_UPDATE_TIMESTAMP`](../sdk/low-level.md) | const | Bit of `LazerFeed.included`: the payload carries the feed update timestamp. |
| [`lazer.LIVE_PROPERTIES`](../sdk/low-level.md) | const | What a feed must carry to price a live call. |
| [`lazer.TICK_PROPERTIES`](../sdk/low-level.md) | const | What a one-second update must carry for a feed to settle a pair at it. |
| [`lazer.CHAIN_PROPERTIES`](../sdk/low-level.md) | const | What a one-second update must carry to prove a chain sample. |
| [`lazer.Envelope`](../sdk/low-level.md) | interface | An update's envelope, split: `r`, `s`, the recovery id and the payload. |
| [`lazer.LegEntry`](../sdk/low-level.md) | interface | One leg as BazaarOracle reads it out of a call's updates. |
| [`CHANNEL_IDS`](../sdk/low-level.md) | const | Each channel's number in a payload. |
| [`CHANNEL_FIXED_RATE_1000`](../sdk/low-level.md) | const | The number of the channel whose updates are stamped once per second, on whole seconds. |
| [`Channel`](../sdk/low-level.md) | type | The channels Pyth Pro produces updates on: `real_time`, `fixed_rate@50ms`, `fixed_rate@200ms`, `fixed_rate@1000ms`. |
| [`LazerFeed`](../sdk/low-level.md) | interface | One feed's fields in one payload, with which properties the payload carries (`included`). |
| [`LazerFeedInput`](../sdk/low-level.md) | interface | One feed to encode; a property left undefined is left out of the payload. |
| [`LazerPayload`](../sdk/low-level.md) | interface | A payload's contents: timestamp, channel, feeds. |
| [`LazerPayloadInput`](../sdk/low-level.md) | interface | What `encodePayload` takes. |
| [`LazerUpdate`](../sdk/low-level.md) | interface | An update, read from its bytes: the payload's contents, the signer, the payload. |
| [`LazerError`](../sdk/low-level.md) | class | An update or feed id that is not valid. |
| [`feedIdHex`](../sdk/low-level.md) | function | The bytes32 feed id that holds a Pyth Pro feed number (1 → `0x00…01`). |
| [`proFeedId`](../sdk/low-level.md) | function | The Pyth Pro feed number a raw bytes32 feed id holds; throws on anything else. |
| [`isRawFeedId`](../sdk/low-level.md) | function | Whether an id has the form of a raw Pyth Pro feed id (BazaarOracle.isRawFeedId). |
| [`ProClient`](../sdk/low-level.md) | class | A client for Pyth Pro: `latest`, `latestUpdate`, `atTick`, `stream`, `symbols` and `close`. |
| [`ProClientOptions`](../sdk/low-level.md) | interface | Options of `ProClient`: the token, the endpoints, the channel, headers, timeout, `fetch`, `WebSocket`, `streamAuth` and `isTrustedSigner`. |
| [`ProError`](../sdk/low-level.md) | class | A Pyth Pro request or stream that failed; its message never shows a token. |
| [`ProUpdate`](../sdk/low-level.md) | interface | A signed update as the client read it: the blob, the signer, the timestamp, the channel, every feed's entry, and the live prints. |
| [`ProSymbol`](../sdk/low-level.md) | interface | One entry of Pyth Pro's symbols registry. |
| [`Print`](../sdk/low-level.md) | interface | One feed's price and the signed update that carries it. |
| [`SignerCheck`](../sdk/low-level.md) | type | Says whether updates signed by a signer may be used. |
| [`WebSocketConstructor`](../sdk/low-level.md) | type | A WebSocket constructor: the global one, or a package's. |
| [`WebSocketLike`](../sdk/low-level.md) | interface | The parts of a WebSocket the client uses. |
| [`AUTH_SUBPROTOCOL`](../sdk/low-level.md) | const | The subprotocol that marks the next entry of a WebSocket's subprotocol list as the token. |
| [`DEFAULT_CHANNEL`](../sdk/low-level.md) | const | The channel a client streams and reads the latest price on unless told otherwise. |
| [`PRO_PROPERTIES`](../sdk/low-level.md) | const | The properties every request asks for. |
| [`MAX_RESPONSE_BYTES`](../sdk/low-level.md) | const | The largest response body a request may return, in bytes (16 MiB). |
| [`MAX_STREAM_MESSAGE`](../sdk/low-level.md) | const | The longest message a price stream may send, in characters (1 MiB). |
| [`MAX_STRAY_MESSAGES`](../sdk/low-level.md) | const | How many messages in a row that are not price updates drop the stream endpoint sending them; it is reconnected with a growing delay. |
| [`MAX_UPDATE_AHEAD`](../sdk/low-level.md) | const | Seconds an update's own timestamp may lie ahead of the client's clock before the endpoint that sent it is dropped (60). |
| [`MAX_STREAM_NOTICES`](../sdk/low-level.md) | const | How many distinct notices one stream passes to its `onNotice` before it drops the rest. |
| [`STREAM_IDLE_TIMEOUT`](../sdk/low-level.md) | const | Seconds a price stream may bring no new update before it is abandoned and reconnected. |
| [`StreamOptions`](../sdk/low-level.md) | interface | Options of `ProClient.stream`: `idleTimeout` and `onNotice`. |
| [`isLivePrint`](../sdk/low-level.md) | function | Whether a feed entry holds a price a live call could use. |
| [`whyNotLive`](../sdk/low-level.md) | function | Why a feed entry holds no price a live call could use, or null when it holds one. |
| [`printsOf`](../sdk/low-level.md) | function | The prints a parsed update carries: one per feed that holds a live price. |
| [`ETH_USD_BOUNDS`](../sdk/low-level.md) | const | Default `PriceServiceOptions.ethUsdBounds`. |
| [`ETH_USD_MAX_AGE`](../sdk/low-level.md) | const | Default `PriceServiceOptions.ethUsdMaxAge`. |
| [`MAX_FUTURE_SKEW`](../sdk/low-level.md) | const | Default `PriceServiceOptions.maxFutureSkew`. |
| [`MAX_LATEST_PRICE_LAG`](../sdk/low-level.md) | const | The most seconds before its update was issued that a liquidation's price may have been generated: 57 (`MAX_LIQUIDATION_PRICE_AGE` less the 3 s window). |
| [`LatestPrice`](../sdk/low-level.md) | interface | Pyth's latest price for a market's legs as the oracle's latest-price path reads it: the updates, when the earliest was issued, each leg's generation second, and the composed price. |
| [`LiquidationUpdate`](../sdk/low-level.md) | interface | What `PriceService.liquidationUpdate` returns: `kind` (`"fresh"`, `"latest"` or null), the update, the price, each leg's generation second, `priceTime` and, when nothing can be attached, `reason`. |
| [`readLatestPrice`](../sdk/low-level.md) | function | Pyth's latest price for a market's legs as `BazaarOracle.verifyAndFetchLatestPrice` reads it out of a call's updates, or why the oracle would refuse it in any block. |
| [`PriceLogger`](../sdk/low-level.md) | interface | Where a `PriceService` reports warnings. |
| [`PriceService`](../sdk/low-level.md) | class | Live prints for every watched feed (streamed, or polled as a fallback), and per-market prices and updates, including what a liquidation can attach (`liquidationUpdate`, `latestFor`). |
| [`PriceServiceOptions`](../sdk/low-level.md) | interface | Options of `PriceService`: streaming, idle timeout, poll interval, clock, send margin, future skew, ETH/USD age and bounds, and logger. |
| [`PriceSource`](../sdk/low-level.md) | interface | Where a PriceService gets its prints: a `ProClient`, or anything shaped like one (`latest`, and `stream` over sets of feeds). |
| [`PrintListener`](../sdk/low-level.md) | type | Called after each batch of prints with the feeds that got a newer print in it. |
| [`distinctBlobs`](../sdk/low-level.md) | function | The distinct signed updates a list of prints came in, in the prints' order. |
| [`feedLabel`](../sdk/low-level.md) | function | 'Crypto.BTC/USD' -&gt; 'BTC/USD', 'Equity.US.AAPL/USD' -&gt; 'AAPL/USD'. |
| [`fetchFeedInfo`](../sdk/low-level.md) | function | Pyth Pro's registry entries for feeds, by feed id; empty when the registry cannot be read. |
| [`fetchSymbols`](../sdk/low-level.md) | function | Pyth symbols for feeds, from the symbols registry; empty when it cannot be read. |
| [`marketLabel`](../sdk/low-level.md) | function | A market's label from its legs' Pyth symbols; a composite (with a quote leg) is priced in USD. |

### URLs

| Export | Kind | What it is |
|---|---|---|
| [`isUrl`](../sdk/low-level.md) | function | Whether `value` is an http(s) or ws(s) URL, as fetch would read it. |
| [`urlCredential`](../sdk/low-level.md) | function | Where a URL may carry a credential, as a phrase (`a key in its path`, ...), or null when it carries none. |
| [`redactUrl`](../sdk/low-level.md) | function | The URL with every part not known to be public replaced by `mask`, safe to print or log (see the module's rules). |
| [`redactUrls`](../sdk/low-level.md) | function | Text with every http(s) or ws(s) URL inside it passed through `redactUrl`. |
| [`urlSecrets`](../sdk/low-level.md) | function | The parts of a URL that `redactUrl` masks (a user name and password, a host label, a path segment, a query value or item, the fragment), each once. |
| [`PATH_WORDS`](../sdk/low-level.md) | const | Path segments that are never secret (compared without case). |
| [`PUBLIC_PARAMS`](../sdk/low-level.md) | const | Query parameters whose (plain) values are never secret (compared without case). |

## `@liberta-labs/bazaar-keeper`

```ts
import { Keeper, loadConfig, jobs } from "@liberta-labs/bazaar-keeper";
```

See [The Keeper as a Library](../keeper/library.md) for how the pieces fit.

### The Keeper Engine

| Export | Kind | What it is |
|---|---|---|
| [`VERSION`](../keeper/library.md) | const | The keeper package's version. |
| [`CATCH_UP_BLOCKS`](../keeper/library.md) | const | A sync step that starts this many blocks behind the head is a catch-up (after a restart or an outage): the print path waits for it, so it does not plan from an index still being replayed. |
| [`JobStatusEntry`](../keeper/library.md) | interface | One job in the status file. |
| [`Keeper`](../keeper/library.md) | class | The keeper: `Keeper.create(config)`, `start()`, `stop()`, `close()`, `on(event)`, and `run` for one-shot operations. |
| [`KeeperEvent`](../keeper/library.md) | type | The name of a `KeeperEvents` event. |
| [`KeeperEvents`](../keeper/library.md) | interface | What `Keeper.on` delivers, by event. |
| [`KeeperListener`](../keeper/library.md) | type | A listener for one `KeeperEvents` event. |
| [`KeeperOptions`](../keeper/library.md) | interface | Options of `Keeper.create`: `loadWallets` (false for a watch-only keeper). |
| [`KeeperStatus`](../keeper/library.md) | interface | `status.json`, as the Python keeper writes it (the same keys), for `bazaar keeper status`. |
| [`MarketStatusEntry`](../keeper/library.md) | interface | One market in the status file. |
| [`Signal`](../keeper/library.md) | class | A settable event: set, clear, and wait until set. |
| [`StopOptions`](../keeper/library.md) | interface | Options of `Keeper.stop`: whether to collect first, and the timeout. |
| [`listMarkets`](../keeper/library.md) | function | The factory's markets with their labels, without indexing anything (for setup and listings). |
| [`stateDirFor`](../keeper/library.md) | function | Where a keeper for this network and factory keeps its snapshot, ledger and status. |

### Configuration

| Export | Kind | What it is |
|---|---|---|
| [`ConfigError`](../keeper/library.md) | class | A configuration problem, phrased for the person fixing it. |
| [`DEFAULT_CONFIG`](../keeper/library.md) | const | The default config file name: `bazaar-keeper.yaml`. |
| [`SECRET_KEYS`](../keeper/library.md) | const | Keys whose values are secrets. |
| [`expandHome`](../keeper/library.md) | function | A path with a leading `~` expanded to the home directory. |
| [`loadConfig`](../keeper/library.md) | function | Read a config file, its sibling .env, and the environment. |
| [`parseConfig`](../keeper/library.md) | function | Validate an already-interpolated config object. |
| [`enabledJobs`](../keeper/configuration.md) | function | The jobs switched on, by name. |
| [`priceEndpoints`](../keeper/configuration.md) | function | Where the keeper reads prices: the stream URLs, the request API and the symbols registry `prices.endpoint` names, each replaced by `prices.streamUrls`, `prices.restUrl` or `prices.symbolsUrl` when set. |
| [`StreamSocket`](../keeper/configuration.md) | class | `ws`'s WebSocket opened with `STREAM_SOCKET_OPTIONS`, which override any options passed. |
| [`streamSocket`](../keeper/configuration.md) | const | `StreamSocket` as the price client's `WebSocket` option takes it. |
| [`STREAM_SOCKET_OPTIONS`](../keeper/configuration.md) | const | What every stream connection is opened with: the frame bound, no compression, no redirects, and the handshake timeout. |
| [`MAX_STREAM_FRAME_BYTES`](../keeper/configuration.md) | const | The largest frame a stream connection accepts, in bytes: no message the price client would take is refused. |
| [`STREAM_HANDSHAKE_TIMEOUT_MS`](../keeper/configuration.md) | const | Milliseconds a stream connection may take to open before it counts as failed. |
| [`missingProKey`](../keeper/configuration.md) | function | `PRO_KEY_REQUIRED` when a `prices` section reads from Pyth's own request API or stream endpoints without a token, else null: what config validation refuses under `prices.token`. |
| [`PRO_KEY_REQUIRED`](../keeper/configuration.md) | const | What a config that reads prices from Pyth's own endpoints without a Pyth Pro API key is told. |
| [`PRICES_API_KEY_MESSAGE`](../keeper/troubleshooting.md) | const | What a config that still holds `prices.apiKey` is told: the setting, the key it takes and the endpoints it may go to. |
| [`hermesEndpointProblem`](../keeper/troubleshooting.md) | function | Why a price endpoint setting's URL must not be used (it names Hermes, a Pyth Core service the Pyth Pro token must not go to), or null. |
| [`UNCHECKED_SIGNERS_WARNING`](../keeper/configuration.md) | const | What the keeper logs at start, and doctor shows, while `prices.checkSigners` is off. |
| [`resolvedNetwork`](../keeper/configuration.md) | function | The network a config names, with its preset applied: chain id, factory, start block, subgraph and whether official. |
| [`subgraphUrl`](../keeper/configuration.md) | function | The subgraph URL a config resolves to, or null for `none`. |
| [`RpcConfig`](../keeper/configuration.md) | const + type | The `rpc` section's zod schema and type. |
| [`SubgraphConfig`](../keeper/configuration.md) | const + type | The `subgraph` section's zod schema and type. |
| [`PricesConfig`](../keeper/configuration.md) | const + type | The `prices` section's zod schema and type. |
| [`WalletConfig`](../keeper/configuration.md) | const + type | One entry of `wallets`: its zod schema and type. |
| [`JobConfig`](../keeper/configuration.md) | const + type | The options every job shares: zod schema and type. |
| [`LiquidationJob`](../keeper/configuration.md) | const + type | The `jobs.liquidation` section's zod schema and type. |
| [`TriggersJob`](../keeper/configuration.md) | const + type | The `jobs.triggers` section's zod schema and type. |
| [`UnloadJob`](../keeper/configuration.md) | const + type | The `jobs.unload` section's zod schema and type. |
| [`AdlJob`](../keeper/configuration.md) | const + type | The `jobs.adl` section's zod schema and type. |
| [`RefreshJob`](../keeper/configuration.md) | const + type | The `jobs.refresh` section's zod schema and type. |
| [`CollectJob`](../keeper/configuration.md) | const + type | The `jobs.collect` section's zod schema and type. |
| [`TerminalSettlementJob`](../keeper/configuration.md) | const + type | The `jobs.terminalSettlement` section's zod schema and type. |
| [`SweepExpiredJob`](../keeper/configuration.md) | const + type | The `jobs.sweepExpired` section's zod schema and type. |
| [`JobsConfig`](../keeper/configuration.md) | const + type | The `jobs` section's zod schema and type. |
| [`ProfitConfig`](../keeper/configuration.md) | const + type | The `profit` section's zod schema and type. |
| [`GasConfig`](../keeper/configuration.md) | const + type | The `gas` section's zod schema and type. |
| [`BudgetConfig`](../keeper/configuration.md) | const + type | The `budget` section's zod schema and type. |
| [`SafetyConfig`](../keeper/configuration.md) | const + type | The `safety` section's zod schema and type. |
| [`ALERT_KINDS`](../keeper/configuration.md) | const | The alert kinds `alerts.notify` can name: lowBalance, jobPaused, endpointDown, opportunity, dailySummary, action. |
| [`AlertKind`](../keeper/configuration.md) | type | One of `ALERT_KINDS`. |
| [`AlertsConfig`](../keeper/configuration.md) | const + type | The `alerts` section's zod schema and type. |
| [`StateConfig`](../keeper/configuration.md) | const + type | The `state` section's zod schema and type. |
| [`LogConfig`](../keeper/configuration.md) | const + type | The `log` section's zod schema and type. |
| [`EngineConfig`](../keeper/configuration.md) | const + type | The `engine` section's zod schema and type. |
| [`KeeperConfig`](../keeper/configuration.md) | const + type | The whole keeper config's zod schema and type. |
| [`JOB_NAMES`](../keeper/configuration.md) | const | The jobs in the order the keeper runs and reports them, by their config key. |
| [`JobName`](../keeper/configuration.md) | type | One of `JOB_NAMES`. |
| [`ResolvedNetwork`](../keeper/configuration.md) | interface | What `resolvedNetwork` returns. |

### Wallets and Signers

| Export | Kind | What it is |
|---|---|---|
| [`KEYS_DIR`](../keeper/wallets.md) | const | Where `bazaar wallet new` puts keystores (expand with `expandHome`). |
| [`KeystoreV3`](../keeper/wallets.md) | interface | A v3 JSON keystore. |
| [`LocalSigner`](../keeper/wallets.md) | class | Signs with a key held in this process. |
| [`RemoteSigner`](../keeper/wallets.md) | class | Any signer that answers eth_signTransaction over JSON-RPC (Web3Signer, a KMS bridge). |
| [`RemoteSignerOptions`](../keeper/wallets.md) | interface | Options of `RemoteSigner`: timeout and `fetch`. |
| [`Signer`](../keeper/wallets.md) | interface | Something that signs keeper transactions: an address and `sign(tx)`. |
| [`TxRequest`](../keeper/wallets.md) | interface | An EIP-1559 (type 2) transaction, as the executor builds it. |
| [`WalletError`](../keeper/wallets.md) | class | A wallet that cannot be loaded or used (a wrong password, a bad key or phrase, a remote signer's failure). |
| [`checkMnemonic`](../keeper/wallets.md) | function | The phrase, normalized, after the checks eth-account makes: a known word count, every word from one language's list, and a matching checksum. |
| [`decryptKeystore`](../keeper/wallets.md) | function | The private key in a v3 keystore. |
| [`encryptKeystore`](../keeper/wallets.md) | function | A v3 keystore for `key`, with the Python keeper's parameters and field order. |
| [`loadSigner`](../keeper/wallets.md) | function | The signer for one configured wallet. |
| [`newKey`](../keeper/wallets.md) | function | A new random private key. |
| [`writeKeystore`](../keeper/wallets.md) | function | Encrypt `key` to a JSON keystore at `path` (owner-only permissions where the OS has them); returns the address. |

### Execution, Ledger and Spend Policy

| Export | Kind | What it is |
|---|---|---|
| [`Action`](../keeper/library.md) | class | A call a job wants made: target, data, value, summary, locks, wallet and how it is paid. |
| [`ActionInit`](../keeper/library.md) | interface | What an `Action` is built from. |
| [`ActionResult`](../keeper/library.md) | class | What happened to an action: status, tx hash, gas, cost, reward, claimed, and the decoded error. |
| [`ActionResultInit`](../keeper/library.md) | interface | What an `ActionResult` is built from. |
| [`Emit`](../keeper/library.md) | type | How the executor reports events (`ExecutorEvents`). |
| [`Executor`](../keeper/library.md) | class | Simulate, decide, send and track: the path every keeper action takes, with one nonce lane per wallet. |
| [`ExecutorEvents`](../keeper/library.md) | interface | What the executor reports: "alert" [kind, message], "sent" [action, txHash], "action" (a sent call's result). |
| [`Lane`](../keeper/library.md) | class | One wallet: its signer and its nonce sequence. |
| [`Mutex`](../keeper/library.md) | class | A small FIFO mutex: acquire() returns nothing when the lock is free, so the free path never waits. |
| [`ResultStatus`](../keeper/library.md) | type | An action's outcome: `confirmed`, `reverted`, `unknown`, `skipped` or `simulated`. |
| [`RunOptions`](../keeper/library.md) | interface | Options of `Executor.run`: `dryRun`, `force` and the job's config. |
| [`lockKey`](../keeper/library.md) | function | One key in the executor's in-flight set, such as `lockKey("liq", market.address, account)`. |
| [`DAY`](../keeper/budgets.md) | const | 86,400 seconds. |
| [`Entry`](../keeper/budgets.md) | class | One ledger line: a transaction the keeper sent, with its cost, reward and kind. |
| [`EntryInit`](../keeper/budgets.md) | interface | What an `Entry` is built from. |
| [`EntryKind`](../keeper/budgets.md) | type | What an entry is: profit \| loss \| unpaid \| collect \| forward \| manual \| forced. |
| [`EntryStatus`](../keeper/budgets.md) | type | `confirmed`, `reverted` or `unknown`. |
| [`Ledger`](../keeper/budgets.md) | class | The earnings ledger (`ledger.jsonl`): every transaction sent, and the daily budgets read from it. |
| [`SummaryRow`](../keeper/budgets.md) | interface | One row of the ledger's summary: calls, reward, cost, net, claimed and reverted. |
| [`DecideOptions`](../keeper/budgets.md) | interface | Options of `SpendPolicy.decide`: whether the call is paid, an unpaid duty's cap, and `force`. |
| [`Decision`](../keeper/budgets.md) | interface | What `SpendPolicy.decide` returns: whether to send, the kind, and the reason. |
| [`DecisionKind`](../keeper/budgets.md) | type | profit \| loss \| unpaid \| forced \| skip, or a job's own (collect, forward). |
| [`Quote`](../keeper/budgets.md) | class | What a simulated call would earn and cost, in USD, and what it costs in wei. |
| [`SpendPolicy`](../keeper/budgets.md) | class | When a simulated call is worth sending: the profit rule, loss budgets and daily spend caps. |

### Jobs

The job classes are also on the `jobs` namespace (`import { jobs } from "@liberta-labs/bazaar-keeper"`).

| Export | Kind | What it is |
|---|---|---|
| [`ActionExtras`](../keeper/jobs.md) | type | Everything an Action takes besides what `Job.action` fills in. |
| [`JOBS`](../keeper/jobs.md) | const | Config key (camelCase, as JobsConfig names them) -&gt; job class. |
| [`Job`](../keeper/jobs.md) | class | The base class of a keeper job: its scope, cooldowns, the price it acts on, and `plan` (or `planGlobal`). |
| [`JobClass`](../keeper/jobs.md) | type | The constructor every job class has (the config is the job's own schema type). |
| [`PricedCall`](../keeper/jobs.md) | class | The price a planner judges by and the update payload its call carries. |
| [`jobs.AdlJob`](../keeper/jobs.md) | class | The `adl` job. |
| [`jobs.ALL_STATUSES`](../keeper/jobs.md) | const | Every market status (for a job that runs in all of them). |
| [`jobs.ActionExtras`](../keeper/jobs.md) | type | Everything an Action takes besides what `Job.action` fills in. |
| [`jobs.Job`](../keeper/jobs.md) | class | The base class of a keeper job: its scope, cooldowns, the price it acts on, and `plan` (or `planGlobal`). |
| [`jobs.JobClass`](../keeper/jobs.md) | type | The constructor every job class has (the config is the job's own schema type). |
| [`jobs.LIVE`](../keeper/jobs.md) | const | The statuses most jobs run in. |
| [`jobs.LIVE_OR_ADL`](../keeper/jobs.md) | const | Live, or with an ADL window open (matching halts; liquidation, ADL and refresh still run). |
| [`jobs.PricedCall`](../keeper/jobs.md) | class | The price a planner judges by and the update payload its call carries. |
| [`jobs.monotonic`](../keeper/jobs.md) | const | Seconds on a monotonic clock, for cooldowns and schedules. |
| [`jobs.CollectJob`](../keeper/jobs.md) | class | The `collect` job. |
| [`jobs.LiquidationJob`](../keeper/jobs.md) | class | The `liquidation` job. |
| [`jobs.belowMaintenance`](../keeper/jobs.md) | function | Whether `p` is below its maintenance requirement at `price` and `fundingIndex`. |
| [`jobs.NoLiquidationPrice`](../keeper/jobs.md) | interface | Why no price can decide a liquidation on a market now: what `LiquidationJob.liquidationPrice` returns in place of a `PricedCall`. |
| [`jobs.RefreshJob`](../keeper/jobs.md) | class | The `refresh` job. |
| [`jobs.SweepExpiredJob`](../keeper/jobs.md) | class | The `sweepExpired` job. |
| [`jobs.TerminalSettlementJob`](../keeper/jobs.md) | class | The `terminalSettlement` job. |
| [`jobs.TriggersJob`](../keeper/jobs.md) | class | The `triggers` job. |
| [`jobs.UnloadJob`](../keeper/jobs.md) | class | The `unload` job. |
| [`jobs.JOBS`](../keeper/jobs.md) | const | Config key (camelCase, as JobsConfig names them) -&gt; job class. |

### Manual Operations

| Export | Kind | What it is |
|---|---|---|
| [`AdlOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.executeAdl`: the winners to close on each side. |
| [`CollectOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.collect`: the markets to claim on. |
| [`FactoryOperations`](../keeper/manual-operations.md) | class | The factory's permissionless operations: listings and identifier upgrades. |
| [`LiquidateOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.liquidate`: the accounts to liquidate. |
| [`ManualOptions`](../keeper/manual-operations.md) | interface | How a manual operation goes. |
| [`ScheduledTermination`](../keeper/manual-operations.md#terminate-scheduled) | interface | A scheduled termination as planned: the call, and what it fixes. |
| [`ScheduledTerminationOptions`](../keeper/manual-operations.md#terminate-scheduled) | interface | How a scheduled termination is planned and sent. |
| [`OpOptions`](../keeper/manual-operations.md) | interface | How a one-shot run of an automatic job goes. |
| [`Operations`](../keeper/manual-operations.md) | class | `keeper.run`: every job once, on one market, and the manual operations. |
| [`SettleOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.settleTerminal`: the accounts to settle. |
| [`SweepOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.sweepExpired`: the orders to sweep. |
| [`TriggerOptions`](../keeper/manual-operations.md) | interface | Options of `keeper.run.executeTriggers`: the orders to fire. |
| [`Opportunity`](../keeper/manual-operations.md) | class | A manual operation someone could run: what, where (a market's label, for people), why, and the CLI command that runs it (naming the market by its address, and only ids checked to be ids). |
| [`findOpportunities`](../keeper/manual-operations.md) | function | Every manual operation that a dry run shows would go through now, or that a "too early" revert shows will open later. |

### Index: Store, Log Tail and Bootstrap

| Export | Kind | What it is |
|---|---|---|
| [`Effects`](../keeper/library.md) | class | What applying logs changed, for the engine to act on. |
| [`SNAPSHOT_VERSION`](../keeper/library.md) | const | The version of the keeper's snapshot format (the Python keeper's is 1; each ignores the other's and bootstraps afresh). |
| [`Store`](../keeper/library.md) | class | The keeper's local index: markets, open positions and live orders, kept current from logs. |
| [`handledPairEvents`](../keeper/library.md) | function | The names of the pair events the store reacts to (for tests that check them against the ABI). |
| [`bootstrap`](../keeper/library.md) | function | Load open positions and live orders as of `block` into the store, for the markets it holds, and return how many of each it loaded. |
| [`LogTail`](../keeper/library.md) | class | Follows the logs of the factory, the terminator and every market into a `Store`, handling reorgs and refused ranges. |
| [`REGROW_AFTER`](../keeper/library.md) | const | Log requests in a row that succeed at a reduced range before the tail tries one twice as wide. |
| [`REORG_REWIND`](../keeper/library.md) | const | Blocks the tail re-reads when the stored head's hash no longer matches the chain. |
| [`TailDeployment`](../keeper/library.md) | interface | The contracts the tail follows besides the markets (the SDK's Deployment fits). |
| [`TailLogger`](../keeper/library.md) | interface | Where the tail reports what it does. |
| [`refused`](../keeper/library.md) | function | Whether the node answered and turned the request down, as providers do when a log query spans too many blocks or would return too many logs. |

### Logging and Alerts

| Export | Kind | What it is |
|---|---|---|
| [`Alerter`](../keeper/production.md) | class | Sends alerts to Telegram, Discord or a webhook, with repeats suppressed. |
| [`AlerterOptions`](../keeper/production.md) | interface | Options of `Alerter`: timeout and `fetch`. |
| [`SendOptions`](../keeper/production.md) | interface | Options of `Alerter.send`: `repeatAfter`. |
| [`LogFormat`](../keeper/library.md) | type | `pretty` or `json`. |
| [`LogLevel`](../keeper/library.md) | type | `debug`, `info`, `warning` or `error`. |
| [`Logger`](../keeper/library.md) | interface | A named logger: `debug`, `info`, `warning`, `error`, `exception` and `isEnabledFor`. |
| [`formatMessage`](../keeper/library.md) | function | Fill a %-template; returns the text and the exception argument, if any. |
| [`getLogger`](../keeper/library.md) | function | The logger with this name, created on first use. |
| [`setup`](../keeper/library.md) | function | Configure every logger: the lowest level shown, and the output format. |
| [`setupLogging`](../keeper/library.md) | function | Configure every logger: the lowest level shown, and the output format. |

### CLI and Dev Tools

| Export | Kind | What it is |
|---|---|---|
| [`runDoctor`](../keeper/commands.md) | function | Run every check; true when nothing failed (warnings allowed). |
| [`runWizard`](../keeper/commands.md) | function | Ask for the network, RPC, subgraph, price endpoint, wallet, jobs and markets, checking each answer, then write the config at `configPath` and a `.env` beside it. |
| [`MockPro`](../keeper/local-testing.md) | class | A Pyth Pro compatible price server for local chains (`bazaar mock-prices`): updates built by the SDK's encoder, signed with the local signing key, stamped with the chain's time; prices set, paused and resumed per feed. |
| [`MockProOptions`](../keeper/local-testing.md) | interface | What `new MockPro` takes: starting prices and symbols, the chain (or clock) to follow, the signing key, the default confidence, a token to require. |
| [`MockProServer`](../keeper/local-testing.md) | interface | A running server: its `url`, `streamUrl`, host, port and `close()`. |
| [`MockClock`](../keeper/local-testing.md) | interface | The time a `MockPro` stamps updates with. |
| [`MockUpdate`](../keeper/local-testing.md) | interface | A signed update the mock built, and the feeds it carries. |
| [`MockUpdateSpec`](../keeper/local-testing.md) | interface | What an update is asked to hold: its stamp, channel and properties. |
| [`MockFeedState`](../keeper/local-testing.md) | interface | One feed as an update stamped at some instant carries it. |
| [`FeedRef`](../keeper/local-testing.md) | type | A feed as the mock takes it: its Pyth Pro number, decimal digits, or the bytes32 that holds it. |
| [`FeedEntries`](../keeper/local-testing.md) | type | Feed -> value, as a record, a Map or entries. |
| [`feedNumber`](../keeper/local-testing.md) | function | The Pyth Pro feed number a `FeedRef` names. |
| [`startMockPro`](../keeper/local-testing.md) | function | Serve a `MockPro` in the background (port 0 picks a free one); resolves once it listens. |
| [`serveMockPro`](../keeper/local-testing.md) | function | `bazaar mock-prices`: serve in the foreground until Ctrl-C (or SIGTERM). |

## Related Pages

- [Connecting](../sdk/connecting.md): the `Bazaar` object and the context.
- [Low-Level Building Blocks](../sdk/low-level.md): the chain, codec, price and subgraph layers.
- [The Keeper as a Library](../keeper/library.md): `Keeper` and its parts.
- [Development](development.md): regenerating the bindings and the ABIs.
