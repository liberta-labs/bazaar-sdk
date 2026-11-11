# Building a Bot

This page builds a complete trading bot with the SDK: a two-sided quoting bot (a simple market maker)
for one market. It signs with its own key, follows the live Pyth price over one stream, keeps one
post-only bid and one post-only ask resting around it, requotes both in one transaction when the price
moves, limits its inventory, and cancels everything when it stops. The same structure fits a
rebalancer, a hedger or a strategy that only takes.

The whole file is at the end of the page ([The Complete Bot](#the-complete-bot)); the sections before
it walk through it part by part. It builds on [Sending Transactions](sending.md),
[Placing Orders](orders.md) and [Managing Orders](managing-orders.md).

The packages are not yet on npm. Once published, install with `npm install @liberta-labs/bazaar-sdk
viem`; until then, build them from the repository (`git clone
https://github.com/liberta-labs/bazaar-sdk && cd bazaar-sdk && npm install && npm run build`) and depend
on `packages/sdk`. See [Installation](../getting-started/installation.md).

## Structure

| Part | Job |
|---|---|
| [Configuration](#configuration) | Every number the strategy uses, from the environment. |
| [Connection and Wallet](#connection-and-wallet) | Reads through a rate-limited RPC client, a local key for sending, one price stream. |
| [Account State](#account-state) | The bot's position and orders, kept current by a watcher. |
| [Acting](#acting) | Build, simulate, send, wait: one transaction at a time. |
| [Collateral](#collateral) | Top the account up to a target on start. |
| [The Strategy](#the-strategy) | Where the quotes should be, and the calls that put them there. |
| [The Loop](#the-loop) | Requote on price moves, and on a timer. |
| [Shutdown](#shutdown) | Cancel the quotes and stop cleanly. |

## Configuration

```ts
{{#include ../../examples/bots/market-maker.ts:config}}
```

All amounts are BAZAAR precision (`parseUnits18`): 18 decimals, `1e18` = one unit of the base asset or
$1. The price grid (`TICK`) is the bot's own choice: the pair takes any price, but rounding keeps quotes
on levels other traders can see.

## Connection and Wallet

```ts
{{#include ../../examples/bots/market-maker.ts:connect}}
```

- **The key.** The bot signs with a local viem account, and sends with a viem wallet client: it never
  hands the key to the SDK. Use a key that holds only what the bot needs: ETH on the chain for gas and
  Pyth update fees, and the USDC it trades with. Load it from the environment or a secret store, never
  from the repository. Do not spread `toTransactionRequest(call)` into this client (see
  [Sending From a Bot](sending.md#sending-from-a-bot-with-a-local-key)).
- **Reads.** `JsonRpc` is the SDK's own JSON-RPC client: it rate limits itself (`perSecond`, 25 by
  default), retries transient failures (`retries`, 3 by default, with doubling delays from 500 ms; never
  a send), times out (`timeoutMs`, 30 s), caps response sizes, and keeps the URL, which often holds a
  provider key, out of its error messages. Passing a URL string as `transport` creates one with the
  defaults. `chainId` makes `connect` refuse any other chain.
- **Prices.** `livePrices([market], { client })` streams the market's feeds from Pyth Pro, one
  subscription on every stream endpoint (falling back to polling while the stream fails), and composes
  the pair's price exactly as the oracle does. The stream runs over a WebSocket: Node 22 and later have
  one, and on Node 20 the `ProClient` takes a constructor (`WebSocket`, the `ws` package's). `live.price(market)` reads it from memory: `spot`, `low`, `high`, `publishTime`,
  `age`, and `fresh` (inside the pair's 3-second window and its confidence cap). See
  [Live Prices](live-prices.md).
- **Prices for calls.** A `LivePrices` is also a price source. `Bazaar.from({ ...base.ctx, prices: live })`
  makes the builders take their price updates from the stream (a price generated at most `reuseAge`,
  1 second, ago) instead of making a Pyth Pro request per call, which saves time inside the 3-second
  window and requests.

For a bot that trades several markets, pass them all to `livePrices` and watch them all; for market
facts (margin rates, funding, open interest, the book), read `bz.markets.marketSnapshot(market)` and
`bz.markets.getBook(market, levels)` ([Markets](markets.md)).

## Account State

```ts
{{#include ../../examples/bots/market-maker.ts:state}}
```

`bz.live.watchAccount(user, markets, onUpdate, opts)` follows the pair's events and delivers a fresh
account snapshot (position, orders, collateral, health at the live price) after every event that touches
the account, at most once a second (`minSnapshotMs`), and every `refreshMs` even when nothing happens. It
handles reorgs. The bot keeps the latest snapshot and decides from it, rather than reading the chain
before every decision. `pollMs` sets how often the watcher looks for a new block. See
[Live Updates](live-updates.md).

`state.lastTxBlock` guards against acting on a snapshot older than the bot's own last transaction:
otherwise the bot could place a second quote before the snapshot shows the first.

## Acting

```ts
{{#include ../../examples/bots/market-maker.ts:act}}
```

Every transaction goes through `act`:

- **Build late.** `build` runs right before the send, so a price-carrying call's update is fresh. If
  the simulation took long enough for the print to age past 2 seconds, it builds again. Signed locally
  and sent at once, the call lands well inside the pair's 3-second window. See
  [The 3-Second Price Window](sending.md#the-3-second-price-window).
- **Simulate first.** A call that would revert is skipped and logged with its reason, and costs no gas.
- **One at a time.** `act` waits for each receipt before returning, and the loop never runs two rounds
  at once (`state.busy`), so each decision sees the result of the last. This also keeps transaction
  nonces simple; viem's `nonceManager` hands them out locally in case the bot sends more than one at a
  time (the shutdown path, for example).
- **Errors.** An `InputError` means the builder refused (an order that is no longer open, a price out of
  band): log it and move on. Everything else (a revert, an RPC failure, a receipt timeout) is logged with
  `errorMessage(e)` and counted, and the loop backs off as failures repeat. A receipt timeout does not
  mean the transaction failed: the next snapshot will show whether it landed.

Bazaar's gasless nonces (`metaTxNonces`) play no part here: the bot sends directly.

## Collateral

```ts
{{#include ../../examples/bots/market-maker.ts:collateral}}
```

On start the bot tops its collateral on the market up to `COLLATERAL`, approving exactly the amount it
deposits (an approval replaces the previous one; see [Approving USDC](collateral.md#approving-usdc)).
The pair's minimum deposit is 5 USDC. Resting orders are reserved against collateral at creation, so a
bot with too little sees its `createOrder` and `amendOrders` simulations fail with
`OrderManagementLib__InsufficientMarginAfterOrder`; [`previewOrder`](previews.md) tells it how much is
needed.

## The Strategy

```ts
{{#include ../../examples/bots/market-maker.ts:quote}}
```

Each round:

1. **Targets.** A bid `SPREAD_BP` below the live price and an ask the same distance above, snapped to
   the grid. A side that would grow the net position past `MAX_POSITION` gets size 0.
2. **Cancel** extra quotes (anything beyond one per side), a side whose size is now 0, and quotes with
   less than 10 minutes left: an order with less than about a minute left cannot be moved by an
   amendment, so they are replaced before that. One `cancelOrders` call takes up to 200 ids.
3. **Amend** the resting quotes to the new prices in one `amendOrders` call. Each amendment sets the new
   **total** size, so `filled + size` restores a partly filled quote to full size. `bestEffort: true`
   means a quote that filled or expired in the meantime is skipped rather than reverting the batch.
   When the price moves up the ask is moved first, so the bid's new price is never judged against the
   old ask.
4. **Place** a missing side as a post-only Limit: if it would cross the book on arrival it is canceled
   rather than filled as a taker.

Rules this respects, from [Orders](https://docs.bazaar.finance/protocol/orders.html):

- Its own orders never fill each other: a crossing quote is canceled as a self-match. The spread keeps
  the bid below the ask.
- One account has at most 32 live Limit and StopLimit orders per market.
- A Limit's price must stay within ±50% of the oracle price.
- An order's notional must be at least $5.
- Fills cost the maker 0.25 bp of notional for insurance, plus 0.25 bp to an integrator when the order
  names one (this bot connects without one).

## The Loop

```ts
{{#include ../../examples/bots/market-maker.ts:loop}}
```

`live.subscribe(listener, [market])` calls the listener after each batch of prints for the market, and
when its `fresh` or venue flag flips. The bot requotes when the price has moved `REQUOTE_BP` from the
last quote, at most once every `minRequoteMs`, and on a 15-second timer regardless, which catches
expiries, a side that was canceled, and a snapshot that arrived late.

It does not quote while the price is not `fresh` (the stream has fallen behind, or a market with
trading hours has its venue closed), or while the market is not live (ADL, the limbo before a scheduled
termination, settlement, termination: `snapshot.status`).

### Rate Limits

What the bot asks of its providers, and how to keep it down:

| Provider | Load | Control |
|---|---|---|
| RPC reads | The watcher's head poll and refreshes; each round's builder reads (block, order state, hints) and simulation. | `JsonRpc`'s `perSecond`; `pollMs` and `refreshMs` on the watcher; `minRequoteMs`. |
| RPC sends | At most a few transactions per round. | The requote threshold and throttle. |
| Pyth Pro | One stream; one request per build only when the stream's price is over 1 second old. | `reuseAge` on `livePrices`; the client's `channel`. A server holds its own API key (`new ProClient({ token })`). |

A 429 from the RPC is retried with backoff by `JsonRpc`; a provider that keeps refusing shows up as
`act` failures and the loop's backoff.

## Shutdown

```ts
{{#include ../../examples/bots/market-maker.ts:shutdown}}
```

On SIGINT or SIGTERM the bot stops quoting, waits for a round in flight, refreshes its snapshot, cancels
its Limit orders, and stops the watcher and the price stream. A process manager sends SIGTERM on stop or
restart, so quotes do not outlive the process that manages them. A crash or a killed process skips
this: quotes keep resting until they expire, which is one reason to keep `orderLifetimeSeconds` short.

## Running in Production

Compile the bot (`tsc`, with `"module": "NodeNext"` and Node 20 or later) or run it with a TypeScript
runner, under a process manager that restarts it and sends SIGTERM on stop.

With systemd, a unit such as `/etc/systemd/system/bazaar-mm.service`:

```ini
[Unit]
Description=Bazaar market maker
After=network-online.target
Wants=network-online.target

[Service]
User=bazaar
WorkingDirectory=/opt/bazaar-mm
EnvironmentFile=/etc/bazaar-mm.env
ExecStart=/usr/bin/node dist/market-maker.js
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

`/etc/bazaar-mm.env` holds `RPC_URL`, `PYTH_PRO_API_KEY`, `BAZAAR_FACTORY`, `BOT_PRIVATE_KEY` and the
strategy's settings; make it readable by the service's user only (`chmod 600`). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bazaar-mm
journalctl -u bazaar-mm -f
```

With pm2:

```bash
pm2 start dist/market-maker.js --name bazaar-mm --kill-timeout 60000
pm2 save
```

Whatever runs it:

- **Run one instance per key.** Two processes quoting from the same account fight over its orders and
  its nonces.
- **Watch the wallet's ETH.** Every transaction pays gas and, for price-carrying calls, a Pyth fee; a
  bot out of ETH stops with "Your wallet does not have enough ETH for gas".
- **Alert on repeated failures** (the `failed:` and `skipped` lines), on the position reaching its limit,
  and on the market's status leaving `live`.
- **Claim what the account earns** now and then with `claimFees` (refunded bounties, and integrator fees
  if the bot names its own address as integrator; see [Claiming Fees](managing-orders.md#claiming-fees)).
- **Test against a local chain first**: [Testing Locally with Anvil](../keeper/local-testing.md) sets up
  a deployment the bot can connect to.

## The Complete Bot

```ts
{{#include ../../examples/bots/market-maker.ts:all}}
```

## Related Pages

- [Sending Transactions](sending.md): the price window, and sending with a local key.
- [Live Prices](live-prices.md) and [Live Updates](live-updates.md): the stream and the watcher.
- [Smart Accounts & Batching](batching.md): quoting several levels in one transaction from a contract
  account.
- [The Keeper as a Library](../keeper/library.md): the keeper's own long-running service, for
  comparison.
