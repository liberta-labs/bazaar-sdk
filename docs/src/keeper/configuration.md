# Configuration Reference

The keeper reads one YAML file, `bazaar-keeper.yaml` by default (`-c <path>` names another). This page
lists every section and every key, with its type, its default and what it does. Defaults are the
schema's (`packages/keeper/src/config/schema.ts`): a key you leave out takes its default, and so does
a whole section.

`bazaar keeper init` writes a working file for you ([Setting Up a Keeper](setup.md)); the repository's
`bazaar-keeper.example.yaml` shows the common options with comments. A complete annotated example is
at the [end of this page](#a-complete-example).

## How the File Is Read

1. The `.env` file in the config's directory is loaded into the environment. Variables already set
   in the environment win.
2. The YAML is parsed. It must be a mapping.
3. The [secrets rules](wallets.md#the-secrets-rules) are checked on the text as written: secret keys
   must be `${NAME}` references, URLs that may carry a key must come from the environment, and
   `prices.headers` values must be references.
4. Every `${NAME}` and `${NAME:-default}` in a string value is filled from the environment.
5. The result is validated against the schema. **Unknown keys are refused everywhere**, so a typo is
   an error, not a silently ignored setting. Every problem is listed at once:

```text
the config is not valid:
  rpc: Unrecognized key(s) in object: 'chunk'
  wallets.default: a keystore wallet needs path
  config: job liquidation uses wallet 'fast', which is not under wallets
```

The library's `parseConfig(object)` does step 5 only ([The Keeper as a Library](library.md#configuring-in-code)).

Three YAML details matter here:

- **Quote addresses.** YAML reads an unquoted `0x…` as a hexadecimal number. Write
  `factory: "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c"`.
- **An empty job turns it off.** `liquidation:` with nothing under it is null, and a null job is
  disabled. Write `liquidation: {}` to enable a job with its defaults.
- **Use block style for references.** `${NAME}` inside a flow mapping (`{ botToken: ${TG_BOT_TOKEN} }`)
  does not parse; write the mapping on separate lines, or quote the value.

## Where

| Key | Type | Default | Meaning |
|---|---|---|---|
| `network` | string | required | `arbitrum-one`, `arbitrum-sepolia`, `anvil`, or `custom` |
| `chainId` | integer | the preset's | required for `custom`; on a preset it replaces the preset's chain id |
| `factory` | address | the preset's | the deployment's factory. Required for `custom`, and for any preset without an official factory (at present `arbitrum-one`) |
| `startBlock` | integer ≥ 0 | see below | where a first start without a subgraph begins reading logs: the factory's deployment block |

| Preset | Chain id | Sequencer endpoint (`rpc.send: sequencer`) | Official factory |
|---|---|---|---|
| `arbitrum-one` | 42161 | `https://arb1-sequencer.arbitrum.io/rpc` | not yet |
| `arbitrum-sepolia` | 421614 | none | `0x9f077B7D49EE7B451ae0858e391dC6960F144612`, from block 328418565 |
| `anvil` | 31337 | none | never (a local chain) |

The keeper reads everything else from the factory: the lens, the terminator, the oracle, USDC, every
market and its price feeds. It refuses to start if the lens or the terminator belongs to a different
factory. A factory that is not a network's official one is used all the same, with a warning
(`factory 0x… is not an official deployment`) in the log, `doctor` and `status`.

**`startBlock` left out.** Nothing of Bazaar's emits a log before its factory exists, so the scan can
start at the factory's deployment block. When `startBlock` is left out (and no official preset gives
it), a first start without a subgraph finds that block on chain: a binary search on `eth_getCode` at
historical blocks, about 30 reads on Arbitrum One. It logs `found the factory's deployment block, N
(set startBlock: N in the config to skip the search)`. The search needs an RPC that keeps historical
state (hosted providers do). A node that has pruned it cannot answer, and the keeper refuses to start
rather than scan from block 0:

```text
could not find the factory's deployment block (…). Set startBlock in the config to the block the factory was deployed in, use an RPC that keeps historical state, or configure a subgraph
```

`startBlock` matters only for the first start without a subgraph (or after the state directory is
emptied): later starts resume from the snapshot.

## `rpc`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `http` | string | required | the JSON-RPC URL every read goes to. Usually holds a key: write `${RPC_HTTP_URL}` |
| `send` | string | `http` | where transactions are submitted: `sequencer` for the network's sequencer endpoint (Arbitrum One only; on another network it is an error), or any URL |
| `maxRequestsPerSecond` | number > 0 | `25` | the client's rate limit on `http` |
| `logChunk` | integer > 0 | `2000` | blocks per `eth_getLogs` request |

The node must support `eth_call` state overrides for rewards to be measured ([What the Keeper
Does](overview.md#what-you-need)). A log range it refuses (too many blocks or logs) is halved and asked
for again, down to one block. The reduced range is kept for later requests, and tried twice as wide
again after eight full-size successes in a row; only the first refusal is logged. A `logChunk` within the
provider's block limit avoids the refused requests. Rate-limit answers (HTTP 429), timeouts and connection failures are
not refusals: the sync step fails and the next tick resumes after the last chunk applied.

## `subgraph`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | `default` | `default` (the network preset's subgraph; only `arbitrum-sepolia` has one, so on the other presets this means none), `none`, or any deployment of Bazaar's subgraph |
| `apiKey` | string | none | sent as `Authorization: Bearer <key>`. A `${NAME}` reference |

The subgraph only finds accounts and orders for the first start: the keeper reads its `_meta` block,
pages through open positions and live or bounty-holding orders pinned to that block, and tails the
chain's logs from the next block. Every decision is made from chain state. If the subgraph fails for
any reason, the first start indexes from chain logs instead. The `opportunities` scan also uses it to
find open termination claims, insurer votes and listings.

## `prices`

Prices come from Pyth Pro: signed updates the keeper attaches to its calls and the pair's oracle has
verified on chain. Pyth's own endpoints serve prices only to the holder of a Pyth Pro API key, which
you get from Pyth: a config that reads prices from them without one is refused when it loads
(`prices.token: Pyth's own price endpoints serve prices only to the holder of a Pyth Pro API key: …`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `endpoint` | string | `pyth` | `pyth` (Pyth's own Pyth Pro endpoints, with your Pyth Pro API key), or the `http(s)` base URL of a Pyth Pro compatible service |
| `token` | string | none | the Pyth Pro API key, sent as `Authorization: Bearer <token>`. A `${NAME}` reference. Required wherever the request API or a stream endpoint is Pyth's own (an empty or blank one counts as none); a compatible service (a proxy that adds the key, `bazaar mock-prices`) may need none |
| `channel` | `real_time` \| `fixed_rate@50ms` \| `fixed_rate@200ms` \| `fixed_rate@1000ms` | `fixed_rate@200ms` | the channel the keeper streams and polls. Keep a fixed-rate one to liquidate on closed markets: it is what guarantees an update every interval, the latest update such a liquidation carries (**The channel**, below) |
| `streamUrls` | list of strings, at least one | the endpoint's | the WebSocket stream endpoints, in place of the endpoint's own; the keeper connects to every one |
| `restUrl` | string | the endpoint's | the request API's base URL (`/v1/latest_price`, `/v1/price`), in place of the endpoint's own |
| `symbolsUrl` | string | the endpoint's | the symbols registry's base URL (`/v1/symbols`), in place of the endpoint's own |
| `headers` | map of string | `{}` | extra request headers for the request API and the stream connections (a proxy's, say); each value a `${NAME}` reference, optionally after a scheme (`Bearer ${NAME}`) |
| `checkSigners` | boolean | `true` | use only updates signed by a signer the deployment's Pyth verifier trusts |
| `allowInsecure` | boolean | `false` | send the token, the headers, and a user name, password or query a URL holds, over plain `http`/`ws` to an endpoint on another machine. Refused by default; an endpoint on this machine (exactly `localhost`, `127.0.0.0/8` or `[::1]`) never needs it |
| `stream` | boolean | `true` | follow the WebSocket price stream; when off, poll the request API for the latest price |
| `pollInterval` | number > 0 | `1.0` | seconds between polls when not streaming |
| `streamIdleTimeoutSeconds` | number ≥ 0 | `10` | a stream that brings no new update for this long is dropped and reconnected; `0` waits forever |
| `sendMarginSeconds` | 0 ≤ number < 3 | `1.0` | a call carries a print only while it is this much younger than the pair's 3 s limit, so it is still fresh when the transaction lands (a liquidation's latest update, only while it was issued that recently) |

**The endpoint.** `pyth` is three stream endpoints (`wss://pyth-lazer-0.dourolabs.app/v1/stream`, and
`-1` and `-2`), the request API at `https://pyth-lazer.dourolabs.app` and the symbols registry at
`https://pyth.dourolabs.app`. A base URL names a service that answers the request API and the symbols
registry at that URL and streams at its `/v1/stream` over `ws` or `wss`: `http://127.0.0.1:8787`
(where [`bazaar mock-prices`](local-testing.md#the-mock-price-server) listens) means the request API
and the registry there and the stream at `ws://127.0.0.1:8787/v1/stream`. `streamUrls`, `restUrl` and
`symbolsUrl` each replace one of the three, over a preset or a base URL. Whichever way they are named,
a request API or stream endpoint on Pyth's own hosts needs `token`, a custom `restUrl` beside `pyth`'s
stream endpoints included. A URL that carries a key is a secret like any other: write it as `${NAME}`
([the secrets rules](wallets.md#the-secrets-rules)).

**Plain `http` and `ws`.** A token or a header sent over plain `http` or `ws` can be read by anyone on
the path, so the keeper refuses to start when one would go that way to another machine:
`prices: the price request URL uses http://, which would send the price token and headers unencrypted
to another machine: …`. The same holds for a user name, a password or a query inside a URL, token or
no token (`prices: a price stream URL holds a user name, a password or a query and uses ws://, …`); no
message quotes the URL. Use `https` and `wss`. Set `allowInsecure: true` only for an endpoint on a
network you trust end to end (a proxy beside the keeper, say). This machine is exactly `localhost`,
an address in `127.0.0.0/8`, or `[::1]`: a name under `.localhost` is resolved like any other name, so
it counts as another machine. `bazaar mock-prices` on the same machine needs neither a token nor this.

A compatible service must serve `POST /v1/latest_price`, `POST /v1/price` (the one-second channel's
update for a past second, which `terminate-scheduled` settles with), `GET /v1/symbols` (feed symbols,
for market labels; asked without the token) and the WebSocket stream.

**The stream.** Updates are judged against the chain's clock, as their prices are: one stamped more
than a minute ahead of it drops the endpoint that sent it. The keeper opens one subscription per watched market, for that market's feeds
together, plus one for ETH/USD (Pyth Pro feed 2, for pricing gas). The signed update a call attaches
therefore carries exactly its pair's feeds, both legs of a composite in one update, and costs one
verification fee. The same subscriptions run on every stream endpoint and each update is taken once,
from whichever endpoint brings it first; an endpoint that drops is reconnected while the others keep
delivering. Three failures in a row mark prices unhealthy and switch a stream to polling for a minute.
Each newer print wakes the liquidation and trigger planners. The stream runs on the `ws` package, on
every supported Node version, bounded so an endpoint cannot make the keeper buffer more than it reads:
no compression, no redirects, a 10 s handshake timeout, and a frame larger than 3 MiB ends the
connection unread (the endpoint is reconnected like any that drops).

**The channel.** A faster channel shows a move sooner and brings more updates to read. A print is as
old as its price, not as the update that carries it: a quiet feed's updates carry its last price
forward, and those read as stale. A fixed-rate channel (`fixed_rate@50ms`, `fixed_rate@200ms`, the
default, or `fixed_rate@1000ms`) issues an update every interval whether or not the price moved,
carrying the last price with the time it was generated. That is what a liquidation on a market with
trading hours carries once the venue has closed: the newest such update, for a minute after that
price ([Liquidation](jobs.md#liquidation)). A fixed-rate channel is what guarantees an update every
interval, so keep one if the keeper should liquidate on closed markets. A feed Pyth does not serve on
the chosen channel, or that the token does not cover, gets no print; the keeper warns once per feed
and its markets get no price.

**`checkSigners`.** Once the deployment is read, the keeper asks its Pyth verifier whether it trusts
the signer of each update (`isValidSigner`, each answer kept for a minute) and takes no price from an
update signed by anyone else: a stream endpoint that sends one is dropped and reconnected while the
others keep delivering, and a request API response that carries one is refused whole. The chain
verifies every update a call carries either way; the ETH/USD print that prices gas reaches no
contract, so this is the only check on it, and with it off the keeper warns at start (`bazaar keeper
doctor` says so too). It costs one signature recovery per update taken, which adds up with many
markets on a fast channel: turn it off, or pick a slower channel, if the keeper falls behind the
stream.

## `wallets`

A map from a name of your choosing to a wallet. Jobs use `default` unless they name another. Left out,
the keeper is watch-only. [Wallets & Secrets](wallets.md) explains each type.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `type` | `keystore` \| `privateKey` \| `mnemonic` \| `remote` | required | the kind of wallet |
| `path` | string | none | keystore: the file (`~/` is your home directory). Required for `keystore` |
| `password` | string | none | keystore: its password, a `${NAME}` reference; left out, asked for at start in a terminal |
| `key` | string | none | privateKey: the key, a `${NAME}` reference. Required for `privateKey` |
| `phrase` | string | none | mnemonic: the phrase, a `${NAME}` reference. Required for `mnemonic` |
| `index` | integer ≥ 0 | `0` | mnemonic: the account, `m/44'/60'/0'/0/{index}` |
| `url` | string | none | remote: the signer's JSON-RPC URL. Required for `remote` |
| `address` | address | none | remote: the address it signs for. Required for `remote` |

## `jobs`

Each job is switched on by being present (`liquidation: {}` or with settings), and off by being left
out, null, or `enabled: false`. Every job takes the common keys; most also have their own.
[The Jobs](jobs.md) explains what each one does with them.

### Common Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` keeps the job's settings but turns it off |
| `markets` | `all` \| list of strings | `all` | the markets it runs on. `all` includes future listings. A list names markets by address, pair id, or label or description (case-insensitive) |
| `exclude` | list of strings | `[]` | markets it never runs on, named the same ways |
| `wallet` | string | `default` | the wallet it sends from; must be under `wallets` (when there are any) |
| `dryRun` | boolean | `false` | plan and simulate, never send (as `start --dry-run` does for every job) |
| `minProfitUsd` | number | `profit.minProfitUsd` | this job's profit rule |
| `gasSafetyMultiplier` | number | `profit.gasSafetyMultiplier` | this job's profit rule |
| `enforceProfit` | boolean | `profit.enforce` | `false` sends this job's calls whatever they earn, held only by the daily spend caps |
| `allowLoss` | boolean | `false` (`true` for `sweepExpired`) | also send calls that cost more than they earn, within the caps below |
| `maxLossUsdPerCall` | number ≥ 0 | `0.05` | the most one losing call may lose |
| `lossBudgetUsdPerDay` | number ≥ 0 | `1.0` (`0.25` for `sweepExpired`) | the most this job may lose in 24 hours; also the budget for its unpaid duties (`finalize`, health pokes) |

**Naming markets.** An address names one market and must be one of the factory's (`0x… is not a
market of this factory`). A label such as `BTC/USD` names every market carrying it: labels are not
unique, since a market relisted after a termination keeps its label and a composite is labelled after
its base. Such a label covers all of them, each job acting only on those in a market state it runs in,
and the keeper logs a warning naming their addresses. A name no market carries stops the start with
`no market called 'X'. Markets: …`. `bazaar keeper markets` lists every market with its label and
address.

### `liquidation`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `watchBufferPct` | number ≥ 0 | `3.0` | positions within this many percent of their maintenance requirement count as at risk in `status.json` (the `atRisk` field); it does not change what is liquidated |
| `maxAccountsPerCall` | integer > 0 | `40` | accounts per `liquidate` call; more are split into several calls |

### `triggers`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `minBountyUsd` | number ≥ 0 | `0.01` | orders with a smaller bounty are not fired |
| `includeUnbountied` | boolean | `false` | also fire orders with no bounty at all (they pay nothing, so they send only with `allowLoss`) |

### `unload`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxSteps` | integer, 1 to 32 | `32` | the book walk's step budget per `unloadVault` call |
| `recheckSeconds` | number > 0 | `15` | how often a market holding inventory is simulated again when nothing has changed |

### `adl`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxWinnersPerSide` | integer, 1 to 25 | `25` | candidates per list in an `executeAdl` batch |

### `refresh`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `healthPokes` | boolean | `false` | also pay for unpaid refreshes that would open an ADL window or end a timed-out one. Turning it on is consent to pay for them |
| `healthPokeIntervalSeconds` | number > 0 | `60` | how often each market holding inventory is checked for a health poke |
| `healthPokeMaxCostUsd` | number ≥ 0 | `0.1` | the most one health poke may cost |

### `terminalSettlement`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `finalize` | boolean | `true` | finalize the termination once every position is settled or the 14-day escape opens. `finalizeTermination` pays nothing: `true` is consent to pay for it |
| `finalizeMaxCostUsd` | number ≥ 0 | `0.5` | the most one finalize may cost |
| `maxAccountsPerCall` | integer > 0 | `100` | positions settled per call; the next tick takes the rest |

### `collect`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `thresholdUsd` | number ≥ 0 | `5` | claim a market once a wallet's balance there reaches this, and covers the claim's gas × `gasSafetyMultiplier` |
| `maxAgeDays` | number > 0 | `7` | a balance first seen longer ago than this is claimed whenever it covers its gas, whatever its size |
| `forwardTo` | address | none | move each wallet's USDC here once it holds `forwardMinUsd` |
| `forwardMinUsd` | number ≥ 0 | `50` | the USDC balance at which a wallet forwards |
| `onShutdown` | boolean | `true` | on a clean stop, claim every balance that covers its gas |
| `intervalSeconds` | number > 0 | `600` | how often balances are read (sooner, after 5 s, when the logs show a wallet's balance changed) |

### `sweepExpired`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowLoss` | boolean | `true` | `sweepExpired` pays nothing, so every call is a loss: the job only runs with this on |
| `lossBudgetUsdPerDay` | number ≥ 0 | `0.25` | the job's daily budget |
| `minBatch` | integer > 0 | `10` | expired orders to wait for before sweeping (finished orders holding a bounty are swept at once) |
| `maxOrdersPerCall` | integer > 0 | `100` | orders per call |
| `includeBountyRefunds` | boolean | `true` | also sweep finished orders still holding a bounty, which returns it to the owner |

## `profit`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `minProfitUsd` | number | `0.001` | a paid call is sent when reward − gas ≥ this… |
| `gasSafetyMultiplier` | number ≥ 1 | `1.25` | …and reward ≥ gas × this |
| `enforce` | boolean | `true` | `false` switches the rule off: every call is sent whatever it earns or costs, held only by the daily spend caps |

Each job can override all three (`enforceProfit` for `enforce`). [Budgets & Losing Calls](budgets.md#2-the-profit-rule).

## `gas`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxFeeGwei` | number | none | a hard ceiling on the fee per gas: nothing is sent while the base fee is above it, and `maxFeePerGas` is capped at it |
| `backgroundMaxFeeGwei` | number or null | `0.1` | the ceiling for background work (collect, forwarding, sweeps, finalize); `null` removes it |
| `feeMultiplier` | number ≥ 1 | `2.0` | `maxFeePerGas` = base fee × this (priority fee is always 0) |
| `gasLimitMultiplier` | number ≥ 1 | `1.25` | gas limit = estimate × this + 10,000 |
| `ethUsdFallback` | number > 0 | `3000` | prices gas when the endpoint serves no fresh, plausible ETH/USD print |
| `ethUsdFloor` | number > 0 | `1000` | gas is never priced below this, so a bad feed cannot make calls look free |
| `ethUsdMaxAgeSeconds` | number > 0 | `60` | an older ETH/USD print is not used; `ethUsdFallback` is |

## `budget`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxSpendUsdPerDay` | number ≥ 0 | `10` | all gas, every job, in the last 24 hours, sends in flight included |
| `maxSpendEthPerDay` | number ≥ 0 | `maxSpendUsdPerDay / gas.ethUsdFloor` (0.01 ETH with the defaults) | the same cap counted in wei, gas and update fees together, so no price feed can lift it |
| `maxLossUsdPerDay` | number ≥ 0 | `2` | every loss-taking and unpaid call together |
| `minEthBalance` | number ≥ 0 | `0.002` | ETH; while any wallet holds less, all sending stops |

[Budgets & Losing Calls](budgets.md) explains how they combine.

## `safety`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `pauseAfterReverts` | integer > 0 | `3` | this many on-chain reverts in a row pause a job on a market… |
| `pauseMinutes` | number > 0 | `15` | …for this long, with a `jobPaused` alert |

A revert on chain means the state changed between the simulation and the block (usually another
keeper got there first). A success resets the count.

## `alerts`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `telegram` | `{ botToken, chatId }` | none | `botToken` a `${NAME}` reference; `chatId` a string |
| `discord` | `{ webhook }` | none | the webhook URL, a `${NAME}` reference |
| `webhook` | `{ url }` | none | any URL; receives `POST {"kind", "message", "ts"}` as JSON |
| `notify` | list | `[lowBalance, jobPaused, endpointDown, opportunity, dailySummary]` | which kinds are sent; `action` (one message per sent call) is the sixth kind |

[Running in Production](production.md#alerts) describes each kind.

## `state`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | string | `~/.bazaar` | where the keeper keeps its snapshot, earnings ledger and status file, under `keeper/<chainId>-<first 8 hex digits of the factory>/` |

So one state directory can hold several keepers (different networks or factories) side by side.
`init` sets it to `state/` beside the config.

## `log`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `level` | `debug` \| `info` \| `warning` \| `error` | `info` | the lowest level shown |
| `format` | `pretty` \| `json` | `pretty` | `pretty`: `12:00:01 INFO    message`; `json`: one object per line, `{"ts", "level", "logger", "msg", "exc"?}` |

## `engine`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tickSeconds` | number > 0 | `0.5` | how often the keeper reads the head and new logs and lets every job plan (liquidation and triggers also plan on each new print) |
| `simCooldownSeconds` | number ≥ 0 | `2.0` | how long a candidate the chain refused waits before it is simulated again |
| `idleRefreshSeconds` | number > 0 | `5.0` | how often a market's state is re-read when no event marked it changed |
| `snapshotSeconds` | number > 0 | `60` | how often the index is saved |

## A Complete Example

Every section, with the defaults written out where they are worth seeing. Secrets come from `.env`
beside the file.

```yaml
# ---- Where ----
network: arbitrum-one
factory: "0x0000000000000000000000000000000000000000"  # quoted: YAML reads bare 0x… as a number
startBlock: 123456789            # the factory's deployment block; leave out to have it found on chain

rpc:
  http: ${RPC_HTTP_URL}          # the provider's URL holds its key: it lives in .env
  send: sequencer                # Arbitrum One: submit straight to the sequencer
  maxRequestsPerSecond: 25
  logChunk: 2000                 # blocks per eth_getLogs; refused ranges are halved automatically

subgraph:
  url: ${SUBGRAPH_URL:-none}     # a Bazaar subgraph if SUBGRAPH_URL is set, else index from logs

prices:
  endpoint: pyth                 # Pyth Pro; or ${PRICE_ENDPOINT_URL} for another Pyth Pro compatible service
  token: ${PYTH_PRO_TOKEN}       # your Pyth Pro API key: Pyth's own endpoints serve no one without it
  channel: fixed_rate@200ms
  checkSigners: true             # only updates signed by a signer the deployment's Pyth verifier trusts
  stream: true
  streamIdleTimeoutSeconds: 10
  sendMarginSeconds: 1.0

# ---- Who ----
wallets:
  default:                       # collect, refresh, unload, settlement, manual operations
    type: keystore
    path: /srv/keeper/keys/default.json
    password: ${KEEPER_KEYSTORE_PASSWORD}
  fast:                          # its own nonce queue for the jobs that race
    type: keystore
    path: /srv/keeper/keys/fast.json
    password: ${KEEPER_FAST_PASSWORD}

# ---- What ----
jobs:
  liquidation:
    wallet: fast
    markets: all
    allowLoss: true              # liquidate even at a small loss: it keeps the market solvent
    maxLossUsdPerCall: 0.10
    lossBudgetUsdPerDay: 2
  triggers:
    wallet: fast
    minBountyUsd: 0.02
  unload: {}                     # {} enables a job with its defaults; an empty key would disable it
  adl: {}
  refresh:
    exclude: ["0x0000000000000000000000000000000000000001"]   # a market's address: never refresh it
    healthPokes: true            # pay for refreshes that open or end an ADL window
    healthPokeMaxCostUsd: 0.10
  terminalSettlement:
    finalize: true               # unpaid, but it releases everyone's payout
    finalizeMaxCostUsd: 0.5
  collect:
    thresholdUsd: 10
    maxAgeDays: 7
    forwardTo: "0x0000000000000000000000000000000000000002"   # a cold wallet
    forwardMinUsd: 100
  sweepExpired:                  # unpaid public service, within its daily budget
    lossBudgetUsdPerDay: 0.25
    minBatch: 10

# ---- How much ----
profit:
  minProfitUsd: 0.001
  gasSafetyMultiplier: 1.25
gas:
  maxFeeGwei: 1                  # never pay more than 1 gwei per gas
  backgroundMaxFeeGwei: 0.1      # collect, sweeps, finalize and forwarding wait for a quiet chain
  feeMultiplier: 2.0
  ethUsdFallback: 3000
  ethUsdFloor: 1000
  ethUsdMaxAgeSeconds: 60
budget:
  maxSpendUsdPerDay: 20
  maxSpendEthPerDay: 0.02        # the same cap in ETH, which no price feed can lift
  maxLossUsdPerDay: 5
  minEthBalance: 0.005
safety:
  pauseAfterReverts: 3
  pauseMinutes: 15

# ---- Around it ----
alerts:
  telegram:
    botToken: ${TG_BOT_TOKEN}
    chatId: "123456789"
  notify: [lowBalance, jobPaused, endpointDown, opportunity, dailySummary]
state:
  dir: /srv/keeper/state
log:
  level: info
  format: json                   # one JSON object per line, for a log collector
engine:
  tickSeconds: 0.5
  simCooldownSeconds: 2.0
  idleRefreshSeconds: 5.0
  snapshotSeconds: 60
```

## Related Pages

- [Wallets & Secrets](wallets.md): wallet types and the secrets rules.
- [The Jobs](jobs.md): what each job's keys change.
- [Budgets & Losing Calls](budgets.md): `profit`, `gas` and `budget` together.
- [Troubleshooting](troubleshooting.md): every config error.
