# Low-Level Building Blocks

The `Bazaar` facade is built from smaller pieces, and the package exports all of them: the chain client
and its JSON-RPC transport, ABI codecs, revert decoding, the batched market reader, the subgraph client,
the Pyth Pro client, update codec and price service, ports of the contract formulas, and the typed ABIs. The keeper
runs on the same code.

Reach for them when the facade does too much or too little: a bot that reads every market's state in
one request per block, simulates its own calls through the probe, signs with its own key and submits
exactly once; a service that indexes logs; a tool that needs a contract call the SDK has no builder
for. A frontend rarely needs this page. `bz.ctx.chain` is the `Chain` a facade connection uses, so you
can mix both.

Every piece here is browser-safe unless it says otherwise; the samples run in Node and read their URLs
and keys from the environment.

## Chain

`Chain` wraps any EIP-1193 transport (`request({ method, params })`): a browser wallet's provider, a viem
client, or the SDK's own [`JsonRpc`](#jsonrpc). `Chain.fromUrl(url, options)` builds one over HTTP, with
an optional second endpoint for submitting transactions (a sequencer, a private relay):

```ts
{{#include ../../examples/advanced/low-level-chain.ts:chain}}
```

`Chain.fromUrl` takes the [`JsonRpc` options](#jsonrpc) and `sendUrl` (default: send through the read
URL). `new Chain(transport, { send })` does the same with transports you build:

```ts
{{#include ../../examples/advanced/low-level-chain.ts:transport}}
```

### Methods

| Method | Returns | Notes |
|---|---|---|
| `request(method, params?, via?)` | the JSON-RPC result | Any method. A JSON-RPC error is rethrown as `RpcError` however deep the transport nested it. `via` defaults to the read transport. |
| `chainId()`, `blockNumber()` | `number` | |
| `block(at = "latest")` | `Block` | `number`, `timestamp`, `hash`, `parentHash`, `baseFee` (`bigint`, 0 when absent). `at` is a number or `"latest"`, `"pending"`, `"safe"`, `"finalized"`, `"earliest"`. |
| `code(address, at = "latest")` | `Hex` | An earlier block needs a node that keeps historical state. |
| `balance(address)` | `bigint` | Wei, at the head. |
| `nonce(address, at = "pending")` | `number` | |
| `gasPrice()` | `bigint` | |
| `call(to, data, { from, value, block, overrides })` | `Hex` | One `eth_call`; `overrides` is an `eth_call` state override. A revert throws `RpcError` with `revertData`. |
| `batch(reads, block = "latest", chunk = 200)` | `[ok, data][]` | Many reads in as few calls as the node allows (below). |
| `supportsOverrides()` | `boolean` | Whether `eth_call` honours state overrides here; asked once and cached in `overridesSupported`. |
| `probe(sender, target, data, value, lens, pair)` | `ProbeResult` | Simulate one call from the probe and report what it earns on `pair` (below). |
| `estimateGas(from, to, data, value = 0n)` | `bigint` | |
| `logs(fromBlock, toBlock, addresses)` | `RawLog[]` | `eth_getLogs` for the addresses over the inclusive range, with no topic filter; removed (reorged) logs are dropped. Keep ranges within your provider's limit. |
| `sendRaw(raw)` | `Hex` | Submit a signed transaction exactly once (below). |
| `receipt(hash)` | `Receipt \| null` | null until mined. `status` is `"success"` or `"reverted"`; `logs` are `RawLog`s. |

### Batched Reads

`batch` takes `{ to, data }` reads and returns one `[ok, returnData]` per read, in order. A failing read
does not fail the batch: it comes back as `[false, revertData]`. It uses, in order of preference:

1. the probe's `aggregate`, placed at `PROBE_ADDRESS` by an `eth_call` state override, `chunk` reads per
   call, when the node honours overrides;
2. Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) `aggregate3`, when it is deployed;
3. parallel `eth_call`s.

If a node that honoured overrides stops doing so (a load balancer moved you to another node), `batch`
notices the empty answer, records `overridesSupported = false` and retries with the next strategy.

```ts
{{#include ../../examples/advanced/low-level-chain.ts:batch}}
```

### The Probe

The probe (`contracts/KeeperProbe.sol`) is never deployed: its runtime code is placed at `PROBE_ADDRESS`
(`0x0000000000000000000000000000000000bea7e5`) with `PROBE_BALANCE` (100 ETH, for Pyth fees) through an
`eth_call` state override (`stateOverride()`). `probe(sender, target, data, value, lens, pair)` runs
`target.call{value}(data)` from it and returns:

| Field | Meaning |
|---|---|
| `ok`, `ret` | Whether the call succeeded, and its return or revert data (decode it with `decodeError`). |
| `claimBefore`, `claimAfter` | The probe's claimable balance on `pair` (through the lens) before and after. |
| `reward` | `claimAfter - claimBefore`, floored at 0: exactly what the call would earn, in BAZAAR precision. |
| `gasUsed` | Gas the call used. |
| `adlPendingAfter`, `settlementFixedAfter` | The pair's ADL flag and settlement-fixed time after the call. |

Pass `pair = null` to skip the claimable reads. A node that ignores the override answers `"0x"`, and
`probe` throws ("the node ignored the eth_call state override, so the probe cannot simulate here; use an
RPC that supports state overrides").

```ts
{{#include ../../examples/advanced/low-level-chain.ts:probe}}
```

This is how the keeper measures every reward before it sends: see
[What the Keeper Does](../keeper/overview.md).

### Sending a Signed Transaction

`sendRaw(raw)` submits a signed transaction (its canonical envelope, as viem's `signTransaction`
returns it) through the send transport, exactly once. `JsonRpc` never retries `eth_sendRawTransaction`;
a transport of your own must not either. The hash is computed locally as `keccak256(raw)`, so an
unknown outcome can always be settled by looking the hash up.

| Outcome | Result |
|---|---|
| The node answered with the same hash | returns the hash |
| The node already holds it ("already known", "known transaction", "transaction already imported", "AlreadyKnown") | returns the hash |
| "nonce too low" (or "nonce has already been used") and `eth_getTransactionByHash` finds the hash, on the read transport or then the send transport | returns the hash |
| `raw` is not 0x-prefixed hex bytes, or is an EIP-4844 blob transaction (type 3) | `TypeError`; nothing was sent |
| Any other JSON-RPC error (underpriced, insufficient funds, ...), or "nonce too low" with no transaction found | `RpcError`, the node's own error; the transaction is not in that node's pool |
| The transport failed (connection error, timeout, non-2xx HTTP, oversized or unreadable answer), the node's error reports a timeout, the node answered with another hash or with something that is not a hash, or the lookup after "nonce too low" failed | `SendError` with `hash` and `cause`: the outcome is unknown and the transaction may still be mined |

After a `SendError`, look up `e.hash` (`receipt`, `eth_getTransactionByHash`). Submitting the same signed
bytes again is safe: it cannot run twice. Signing a new transaction for the same work is not, until the
first is settled.

```ts
{{#include ../../examples/advanced/low-level-chain.ts:send-raw}}
```

A frontend sends through the user's wallet instead: see [Sending Transactions](sending.md).

### The Deployment Block

No Bazaar contract records the block it was deployed in. `findDeploymentBlock(chain, address, { head,
from })` finds it by binary search on `eth_getCode(address, block)` (code appears in exactly one block
and never leaves, since Bazaar's contracts cannot self-destruct): about 30 reads on Arbitrum One. It
searches `[from, head]`, by default `[0, the chain's head]`. It needs historical state (hosted providers
such as Alchemy, Infura and QuickNode keep it); it throws `DeploymentBlockError` when there is no code at
`head`, or when a read fails (a pruned node), rather than guess. The keeper uses it when its
configuration leaves out `startBlock`.

```ts
{{#include ../../examples/advanced/low-level-chain.ts:deployment-block}}
```

## JsonRpc

`JsonRpc(url, options)` is a small JSON-RPC client over HTTP(S) that implements `Transport`. It rate
limits itself, retries transient failures (never a send), caps response sizes, keeps revert data, and
never puts its URL or a header's value into an error message.

| Option | Default | Meaning |
|---|---|---|
| `perSecond` | `25` | Requests per second this client allows itself; concurrent callers queue in call order. |
| `timeoutMs` | `30000` | Per-request timeout. |
| `retries` | `3` | Retries after a failed request (HTTP error, connection error, timeout, unreadable answer), with delays doubling from 500 ms. Never for the methods in `NEVER_RETRIED`. |
| `headers` | none | Sent with every request. A name or value HTTP cannot carry (a line break, NUL, ...) throws `TypeError` at construction, naming the header, never its value. |
| `fetch` | `globalThis.fetch` | |
| `maxResponseBytes` | 64 MiB | The most bytes one response may hold, counted after decompression; a larger one throws `ResponseTooLargeError` and is not retried. |

`request(args, { retries })` overrides the retry count for one request. `displayUrl` is the URL with any
key masked (see [URLs](#urls)).

`NEVER_RETRIED` holds `eth_sendRawTransaction`, `eth_sendTransaction`,
`eth_sendRawTransactionConditional`, `eth_sendRawTransactionSync`, `eth_sendPrivateTransaction` and
`eth_sendBundle`: a lost answer to one of them does not mean it was not done.

| Error | When |
|---|---|
| `RpcError` | The node answered with a JSON-RPC error: `code`, `rpcMessage`, `data`, and `revertData` (the revert payload of a failed `eth_call` or `eth_estimateGas`, whatever shape the node uses; `"0x"` for a bare "execution reverted"; null when there is none). Not retried. |
| `HttpError` | A non-2xx answer, after the retries: `status`; the message carries the redacted URL, and 401/403 add "check the key in the URL". |
| `ResponseTooLargeError` | The body was over `maxResponseBytes`: `limit`. |
| `Error` | Anything else that failed (connection, timeout, not JSON-RPC), after the retries, with its text scrubbed of the URL and header values. |

`toRpcError(e)` turns whatever a transport threw into an `RpcError` when it carries a JSON-RPC error
(EIP-1193 providers and viem nest it at different depths), or null. `readTextCapped(response, maxBytes,
what)` is the capped body reader `JsonRpc` and `SubgraphClient` use; `sleep(ms)` is a promise timer.

## Codecs

One `ContractCodec` per contract, built once and cached: `factory()`, `pair()`, `lens()`,
`terminator()`, `oracle()`, or `codec(name)` with a `ContractName`. `new ContractCodec(abi)` builds one
for any other ABI.

| Member | Meaning |
|---|---|
| `encode(name, ...args)` | Calldata for `name(args)`. Structs may be objects of their fields or arrays. A wrong argument count throws `TypeError`. |
| `decode<T>(name, data)` | A return value, named as the ABI names it: a struct decodes to an object of its fields, several named outputs to an object of the output names, a single output to the bare value. |
| `decodeLog<A>(log)` | A `RawLog` decoded to `{ name, address, args, blockNumber, blockHash, txHash, logIndex }`, or null when its topic0 is not one of the contract's events. A dynamic indexed value (string, bytes, array, struct) is recoverable only as its topic hash. |
| `topic(event)`, `selector(fn)`, `fn(name)` | topic0, a selector, a `FunctionSpec`. An unknown name throws. |
| `functions`, `events`, `eventByName`, `errors` | The ABI's specs, by name, topic0 and selector. |

viem decodes integers of 48 bits or fewer as `number` and wider ones as `bigint`; both encode from
either. `allErrors()` maps every custom error the five contracts declare by selector, and
`canonicalType(param)` and `signature(name, inputs)` build the canonical signature strings selectors are
hashed from.

```ts
{{#include ../../examples/advanced/low-level-chain.ts:codec}}
```

The pair's codec decodes the events of the libraries it links, which run in the pair's context and log
from its address:

```ts
{{#include ../../examples/advanced/low-level-chain.ts:logs}}
```

## decodeError

`decodeError(data)` turns revert data into a `DecodedError`:

| Revert data | `name` | `args` |
|---|---|---|
| Shorter than a selector (`"0x"`, out of gas) | `Reverted` | `{}` |
| `Error(string)` | `Error` | `{ message }` |
| `Panic(uint256)` | `Panic` | `{ code }` |
| A custom error any of the five contracts declares | its name, e.g. `BazaarPair__TradingHalted` | its arguments by name (`arg0`, ... when unnamed) |
| Anything else | `Unknown(0x12345678)` | `{}` |

| Member | Meaning |
|---|---|
| `message` | The text for an end user: the registered user message (from [Errors & Messages](errors.md)), else the operator hint, else the name. |
| `hint` | The operator-facing hint from `KEEPER_HINTS`, or `""`. |
| `opensAt()` | For a "too early" error, the time the call opens: the first of its `deadline`, `effectiveTs`, `expiryTs`, `opensAt` or `scheduledTs` arguments, or null. |
| `toString()` | `name(arg=value, ...): hint`, for logs. |
| `data` | The revert data, lowercase. |

```ts
{{#include ../../examples/advanced/low-level-chain.ts:errors}}
```

`KEEPER_HINTS` holds the sentences written for someone running the keeper. User messages are
registered by `installUserMessages()` (which `connect` calls); `registerUserMessages(map)` adds your own.
For any error a call can throw, use `errorMessage(e)`.

## Reader

`Reader` makes the keeper's batched market reads through any object with `call` and `batch` (a
`Chain`). Reads for many markets go out as one `chain.batch`, never one request per market. Call
`deployment(factory)` first: every other read needs it (they throw "Reader.deployment() has not been
called").

| Method | Returns |
|---|---|
| `deployment(factory)` | `Deployment`: `factory`, `lens`, `terminator`, `oracle`, `usdc`. Throws when the address does not answer as a Bazaar factory. |
| `wiringProblems()` | `string[]`: a lens or terminator that does not report a factory, or belongs to another. Empty when consistent. |
| `pairAddresses()` | Every pair the factory deployed. |
| `describe(addresses)` | `Market[]`: `pairId`, `baseFeedId`, `legs` (one raw Pyth feed, or two for a composite), `invertQuote`, `continuous` (traded 24/7). `label` and `description` are empty: fill them yourself. Throws when one of a pair's reads fails. |
| `marketStates(markets, block, timestamp)` | `Map<Address, MarketState>` at `block`: one batched read of 12 values per market. A market whose price, margin or vault read fails is left out. |
| `buckets(pair, accounts)` | `Map<Address, PositionBucket>`: `isLong`, `size`, `entryValue`, `collateral`, `entryFundingIndex`, `takeProfitOrderId`, `stopLossOrderId`. |
| `orders(pair, ids)` | `Map<bigint, OrderRecord>`: the stored order with its trigger `bounty` (0 when that read failed). A slot that never held an order has a zero `creator`; `expiryBlock` is 2^64 - 1 for an order that never expires. |
| `windowDeposits(pair, accounts)` | Each account's ADL score deposit (0 where the read fails). |
| `predecessor(pair, isLong, limitPrice)` | The book-insertion hint `lens.findPredecessor` gives, followed through up to 8 pages of 64. |
| `claimable(wallet)` | `Map<Address, bigint>`: what the wallet can claim, by pair; pairs owing nothing are left out. |
| `updateFee(updates)` | The oracle's fee in wei for having these updates verified: Pyth's fee per update times their number (0 for none). The same fee applies to live calls and to settlement sets. |
| `usdcBalance(account)` | USDC balance, in USDC units. |
| `one(to, codec, fn, ...args)` | One call, decoded. |

```ts
{{#include ../../examples/advanced/low-level-reader.ts:reader}}
```

## Models

`MarketState` is one read of a market: `block`, `timestamp`, the stored price `spot` and its
`updateTs`, `imrBp`, `mmrBp`, `laggedMmrBp`, the stored `fundingIndex` and the lens's
`projectedFundingIndex` (accrued to now), `adlPending`, `adlAuctionStart`, `adlTerminationTs`,
`settlementFixedTs`, `scheduledTs`, `terminated`, open interest (`longOi`, `shortOi`), `insurance`,
`deficit`, and the vault's inventory on each side (`longInv`, `shortInv`: `size`, `entryNotional`,
`bankruptcyNotional`, `seized`, `entryFundingIndex`, `seizedTs`). Times are seconds, zero when unset.

`marketStatus(state, now)` gives the market's `Status`, checked in this order:

| Status | When |
|---|---|
| `terminated` | The pair is terminated. |
| `settling` | Its settlement price is fixed, not yet finalized. |
| `limbo` | A cutoff is scheduled and `now + LIMBO_LEAD` (6 s) has reached it: trading has halted, the price is not yet fixed. |
| `adl` | An ADL window is open: matching halts, liquidation and ADL run. |
| `live` | None of the above. |

`freeCapital(state)` is the insurance balance less the seizure earmarked against inventory the vault
holds, and `inventorySize(state)` the inventory on both sides. `Market` adds mutable fields the keeper
uses (`state`, `dirty`, `lastRead`); `marketStatic`, `marketFromStatic`, `Position`, `Order`,
`orderRemaining` and `emptyInventory` are the keeper's store types.

## Formulas

Ports of the contract formulas, each with the Solidity's integer rounding, so the SDK's view of a
position matches the contract's whenever the inputs match. The chain still decides: use them to
preview and to pick what to simulate.

| Function | Port of | Returns |
|---|---|---|
| `bucketState(isLong, size, entryValue, collateral, entryFundingIndex, price, fundingIndex, mmrBp)` | `BucketLib.calculateState` | `BucketState`: `unrealizedPnl`, `fundingPnl`, `totalPnl`, `currentNotional`, `minRequiredCollateral`, `availableEquity`, `equity`, `isSolvent`. `mmrBp` must already be the effective rate. |
| `effectiveMmrBp(mmrBp, laggedMmrBp)` | `BucketLib.effectiveMmrBp` | The lower of the current rate and a non-zero lagged one. |
| `marginRatio(state)` | | Equity over the maintenance requirement as a `number`: below 1 is liquidatable. |
| `triggerReached(orderType, isLong, triggerPrice, price)` | `MatchingEngineLib._triggerReached` | Whether a trigger order fires at `price` (inclusive). |
| `adlThreshold(auctionStartTs, now)` | `AdlLib._getAdlScoreThreshold` | The ADL score threshold, decaying quadratically from 25e18 to 1 over 10 minutes. |
| `adlScore(totalPnl, collateral, windowDeposit)` | `AdlLib._scoreCollateral` | A winner's ADL score. |
| `refreshBountyGap`, `refreshBountyDue`, `refreshBountyDueAt` | `RiskParamsLib.payRefreshBounty` | When `refreshPrice` pays its bounty. |
| `convertExponent(value, fromExpo, toExpo = -18)` | `BazaarMathLib.convertExponent` | A Pyth price rescaled; `RangeError` past `MAX_EXPONENT_SHIFT` (77). |
| `pairPrice(legs, invertQuote)` | `BazaarOracle` | `PairPrice` (`spot`, `low`, `high`, `publishTime`, `confidenceOk`) composed from one or two legs, or null for a non-positive leg. |
| `legConfOk(price, conf)` | | Whether one leg's confidence is within the 2% cap. |
| `mulDiv`, `signedMulDiv` | OpenZeppelin `Math.mulDiv`, `BazaarMathLib.signedMulDiv` | Floor, and rounding toward zero. |

An account's health with the market's own rates, as the keeper's liquidation job computes it:

```ts
{{#include ../../examples/advanced/low-level-reader.ts:health}}
```

`bz.account.accountSnapshot` does this at the live price for you: see [Accounts & Portfolios](accounts.md).
Orders read straight from the pair:

```ts
{{#include ../../examples/advanced/low-level-reader.ts:orders}}
```

## SubgraphClient

`SubgraphClient(url, apiKey?, options)` is the keeper's GraphQL client: raw queries, the indexer's head,
and paging pinned to one block. For typed, paginated history use [History](history.md) instead.

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Per request. |
| `fetch` | `globalThis.fetch` | |
| `maxResponseBytes` | 16 MiB | The most bytes one answer may hold. |
| `maxPages` | `1000` | The most pages `pages` reads for one entity (a million rows). |

| Method | Returns |
|---|---|
| `query<T>(query, variables?)` | The answer's `data`. |
| `meta()` | `[block, hash, hasIndexingErrors]`: the indexer's head. |
| `pages<T>(entity, fields, where, block, bytesId = false)` | Every row of `entity` matching `where` (GraphQL filter text, may be empty) as of `block`, in id order, `SUBGRAPH_PAGE` (1000) rows a request. `bytesId` for entities whose id is `Bytes`. |
| `descriptions(block)` | Each pair's listing description, by address. |
| `proposals()` | Open termination, insurer, listing and identifier-upgrade proposals, raw. |
| `close()` | Nothing to release; there so callers can close every client alike. |

`apiKey` is sent as `Authorization: Bearer <key>`. Every failure (unreachable, HTTP 400 or above, GraphQL
errors, an unreadable or oversized answer, no data) throws this module's `SubgraphError`, with the URL
redacted and the key masked. `pages` also throws when the subgraph returns rows out of id order or
without a valid id, or runs past `maxPages`, rather than page forever. The subgraph lags the chain and
cannot see state that changes without an event: treat what it returns as discovery and re-read from the
chain before acting.

```ts
{{#include ../../examples/advanced/low-level-subgraph.ts:subgraph}}
```

This `SubgraphError` (exported at the top level) is a different class from `history.SubgraphError`, which
the history functions throw; test for the one that matches the client you use.

## Prices

### ProClient

`new ProClient(options)` reads Pyth Pro: its request API (the latest signed update for a set of feeds,
and the one-second channel's update for any past second), its WebSocket stream, and its symbols
registry. The options are those of [Connecting](connecting.md#prices). A token or header that an HTTP
header cannot carry, a base URL with a query or a fragment, and a credential bound for a plain
`http://` or `ws://` endpoint on another machine without `allowInsecure` (the token, headers, or a user
name, password or query in the endpoint's URL; only exactly `localhost`, `127.0.0.0/8` and `[::1]` count
as this machine) throw `ProError` at construction, naming the setting and quoting no token, header
value or URL.

| Method | Returns |
|---|---|
| `latest(ids)` | `Print[]`: the latest print for each feed with a usable live price, all from one signed update. |
| `latestUpdate(ids)` | That update as a `ProUpdate` (`blob`, `signer`, `timestampUs`, `channel`, `feeds`, `prints`), or null. More than 255 feeds (`lazer.MAX_FEEDS_PER_UPDATE`, all one update carries) throws. |
| `atTick(ids, second)` | The `fixed_rate@1000ms` update stamped exactly `second` as a `ProUpdate`, or null when there is none (settlement proofs). Throws when the endpoint answers with another update. |
| `symbols({ query?, assetType? })` | `ProSymbol[]` from the registry: `id`, `feedId`, `symbol`, `assetType`, `minChannel`, `state`, `schedule`, ..., every text field printable and at most 256 characters. No token is sent. An answer that is not a list throws `ProError`. |
| `stream(feeds, signal?, { idleTimeout, onNotice })` | An async generator of `Print[]` batches. `feeds` is one set or a list of sets; each distinct set is one subscription, so its updates carry exactly its feeds. It connects to every stream endpoint, yields each update once, and reconnects a dropped endpoint with a growing delay: one that drops, sends an update it cannot read, one stamped more than `maxUpdateAhead` seconds ahead of `clock`, one from an untrusted signer, or `MAX_STRAY_MESSAGES` (64) messages in a row that are not price updates. With a signer check, each set keeps only its newest update waiting and the sets take turns, so slow checks never starve a set; nothing counts as taken before its check passes. No new update for `idleTimeout` seconds (default `STREAM_IDLE_TIMEOUT`, 10; null or 0 waits forever) throws `ProError`. |
| `close()` | Ends any open streams. |
| `displayUrl` | The request API's base URL with any key masked. |

Feed IDs are `bytes32` everywhere in the SDK, as the contracts hold them; only this client converts
them to Pyth's numbers. `feedIdHex(1)` is BTC/USD's `0x00…01`, `proFeedId(id)` the number a raw ID
holds, and `isRawFeedId(id)` the oracle's own test (a non-zero 32-bit integer in a `bytes32`).

A `Print` has `feedId`, `price`, `conf`, `expo`, `publishTime` (the second the price was generated in),
`generatedUs`, `timestampUs`, `channel`, `signer`, `blob` (the signed update to attach to a call) and
`received` (seconds on a monotonic clock). Every field but `received` and `signer` is read from the
update's signed payload, never from the JSON beside it. A feed without a usable live price (no price,
no confidence, a price at or below zero, a property the request left out, a price or confidence that
does not scale to the oracle's 18 decimals) yields no print; `whyNotLive(entry)` says why. An
endpoint's text that a message quotes (a body, a close reason) is put on one line and bounded.
Responses over `MAX_RESPONSE_BYTES` (16 MiB) and stream messages over `MAX_STREAM_MESSAGE` (1 MiB) are
refused. Errors are `ProError`: unreachable, refused (401/403: "check the token"), 404, another HTTP
error, not JSON, an update that cannot be read, or one from a signer that is not trusted.

**Signers.** With `isTrustedSigner` set, the signer of each update the client takes is recovered and
an update it does not accept is never used. `verifierSignerCheck(chain, oracle)` is the check `connect`
installs: it asks the deployment's Pyth verifier (`oracle.pythLazer()`, then `isValidSigner`) and keeps
each answer for a minute (`ttl`); a "trusted" answer is then refreshed in the background and used
meanwhile for up to `maxAge` (10 minutes). A failed check's error is reduced to a short summary with
every URL redacted, since the transport behind it may quote its own.

**The key.** A `ProClient` for Pyth's own endpoints takes the API key as `token`, and is refused in a
web page, where the key would be public.

```ts
{{#include ../../examples/advanced/low-level-prices.ts:pro}}
```

`fetchSymbols(client, feeds)` maps feed ids to their Pyth symbols and `fetchFeedInfo(client, feeds)` to
their whole registry entries (both empty when the registry cannot be read);
`feedLabel("Crypto.BTC/USD")` is `"BTC/USD"`, and `marketLabel(base, quote?)` labels a composite (one
with a quote leg) in USD.

### PriceService

`PriceService(source, options)` keeps the newest print of every watched feed and the newest update of
every watched set of feeds, from a `ProClient` or any `PriceSource` (`latest` and `stream`), and builds
per-market prices and updates from them. It is what the keeper runs; frontends use
[`bz.livePrices()`](live-prices.md) instead.

| Option | Default | Meaning |
|---|---|---|
| `stream` | `true` | Follow the stream, falling back to polling when it fails. |
| `streamIdleTimeout` | `10` | Seconds without a new update before the stream is dropped and reconnected; null or 0 waits forever. |
| `pollInterval` | `1` | Seconds between polls when not streaming. |
| `clock` | the system clock | The time freshness is judged at, in Unix seconds. |
| `sendMargin` | `1` | A price must be this many seconds younger than the 3 s limit to count as fresh. |
| `maxFutureSkew` | `5` | Seconds a print may be dated ahead of `clock` before it is ignored (with one warning per feed). |
| `ethUsdMaxAge` | `60` | Seconds after which `ethUsd()` stops trusting the ETH/USD print. |
| `ethUsdBounds` | `[100, 1000000]` | The ETH/USD prices `ethUsd()` accepts. |
| `logger` | `console` | Where endpoint failures are reported; null for silence. |

| Member | Meaning |
|---|---|
| `watchMarkets(markets)`, `watchSets(sets)`, `watch(feeds)` | Watch each market's legs (or each set) as one subscription, or each feed on its own. ETH/USD (`ETH_USD_FEED`, Pyth Pro feed 2) is always watched, for gas. A new set restarts the stream. |
| `run()` | Follow the stream (or poll) until `stop()`, through any failure: three in a row mark the service unhealthy and switch a streaming service to polling for a minute. Never rejects. |
| `stop()` | End `run` at once and release `nextPrints`. |
| `fetch(feeds?)` | The latest prints, outside the loop: one request per 255 feeds, and a request the endpoint refuses (HTTP 403) asked again in parts, so a feed the token does not cover fails only the markets on it. |
| `ingest(prints)` | Take in prints from a source of your own. |
| `onPrints(listener)` | Call `listener(feeds)` after each batch that brings a newly generated price; returns the function that removes it. |
| `nextPrints()` | Wait for newly generated prices and return their feeds; for one consumer. |
| `price(market)` | The composed `PairPrice`, or null while a leg has no print. |
| `fresh(market, now?, margin?)` | Every leg's price generated within `3 - sendMargin` seconds of `now` and the price inside the 2% confidence cap. |
| `closed(market, now?, after = 15)` | No price generated for `after` seconds while the endpoint is otherwise delivering: a closed session. |
| `legs(market)` | The prints the market prices from, or null. |
| `updateFor(market)` | The signed update a call on the market attaches: the one update that carries exactly its legs (one per leg only while its own subscription has delivered none or lags). |
| `printsFor(feeds)` | The prints a call reading these feeds together would attach. |
| `latestFor(market)` | The prints of the most recently issued update the service holds for the market's legs, however old their prices: the market's own update, unless another carrying one of its legs was issued a second or more later. Each print's `timestampUs` is when its update was issued, `generatedUs` when its price was generated. |
| `liquidationUpdate(market, now?, margin?)` | What a liquidation on the market attaches now, as a `LiquidationUpdate` (below). |
| `ethUsd(now?)` | USD per ETH for pricing gas, or null when missing, too old or out of bounds. |
| `missing()` | Watched feeds without a print yet. |
| `latest`, `healthy`, `lastError`, `lastUpdate` | The prints by feed, and the endpoint's health. |

A print is newer when its price was *generated* later (`generatedUs`), several times a second on a
fast channel. An update that only carries the same price forward under a later timestamp, as Pyth
sends for a quiet feed, changes nothing, and its price stays as old as when it was generated. The
service still keeps it as the feed's most recently issued update (`latestFor`), which is what a
liquidation on a closed market carries. A print whose price or update is dated more than
`maxFutureSkew` seconds ahead of the clock is ignored, so it can hold neither.

**Liquidations.** A liquidation without an update runs only on a stored price at most 3 seconds old. On
a market with trading hours it reads an attached update as Pyth's latest price instead
(`BazaarOracle.verifyAndFetchLatestPrice`): every update must have been issued within 3 seconds of the
block, and each leg's price generated at most a minute (`MAX_LIQUIDATION_PRICE_AGE`, 60 s) before it.
An update carries each feed's most recent price as of when it was issued, so one issued that close to
the block proves no newer price existed. `liquidationUpdate(market, now?, margin?)` returns:

| `kind` | When | `update` | `priceTime` |
|---|---|---|---|
| `"fresh"` | `fresh(market, now, margin)`, and on a market with trading hours every update issued within `3 − margin` seconds of `now` | `updateFor(market)` | The older leg's generation second. |
| `"latest"` | A market with trading hours whose `latestFor` updates were all issued within `3 − margin` seconds of `now` and pass `readLatestPrice` | Those updates | The earliest update's issue second. |
| `null` | Anything else; `reason` says why | `[]` | `null` |

The result also has `price` (the `PairPrice` the oracle reads from the update; the pair stores it when
it is newer than its own) and `generated` (each leg's generation second). The call must land within
3 seconds of `priceTime`: check it again just before signing. `readLatestPrice(update, legs,
invertQuote)` is the reading itself, without a clock: updates issued no more than 3 seconds apart, each
leg from the update holding its most
recently generated price, a usable live price, generated no more than `MAX_LATEST_PRICE_LAG` (57)
seconds before the earliest update was issued and no later than the newest was, inside the 2%
confidence cap (a wider latest price is refused, never passed over for an older one). It returns a
`LatestPrice` (`update`, `issuedAt`, `generated`, `price`) or `{ problem }`. With `kind` null, a call
without an update runs only while the pair stored a price within the last 3 seconds, which the
service cannot see.

```ts
{{#include ../../examples/advanced/low-level-prices.ts:service}}
```

A call that needs a price attaches `updateFor(market)` and sends `Reader.updateFee(update)` wei with it:

```ts
{{#include ../../examples/advanced/low-level-prices.ts:update}}
```

### Signed Updates

A Pyth Pro update is an envelope (a magic number, a signature, the payload's size) around a signed
payload: the update's timestamp in microseconds, its channel, and per feed the properties the
requester asked for. The `lazer` namespace reads and builds them: `parseUpdate(blob)` (the payload and
the recovered `signer`), `readUpdate(blob)` (the payload alone), `parsePayload`, `splitUpdate`,
`recoverSigner`, and for tests and local chains `encodePayload`, `signPayload` and `buildUpdate`.
The parser is as strict as the oracle's own (`LazerPayloadLib`): the same bytes are malformed, and each
feed's `included` bits tell a property that was left out of the request from one that is present and
zero. Malformed input throws `LazerError`.

```ts
{{#include ../../examples/advanced/low-level-prices.ts:updates}}
```

## URLs

Hosted RPCs, indexers and price services often put the API key in the URL: Alchemy's `/v2/<key>`,
Infura's `/v3/<id>`, The Graph gateway's `/api/<key>/`, a `?key=` query, `user:password@`.
`redactUrl(url, mask = "***")` keeps only the parts of a URL known not to be secret and masks the rest,
whatever the key looks like:

- a user name and password: always masked;
- the host: a label under 16 characters is kept, a longer one only when it is lowercase words joined by
  `-`;
- path segments: kept when empty, a word in `PATH_WORDS` (`rpc`, `api`, `subgraphs`, `stream`,
  `arbitrum`, ...), a version (`v2`), a number of up to 8 digits, one or two characters, or lowercase
  words joined by `-` or `_`; every other segment is masked;
- query values: masked, except plain values of the parameters in `PUBLIC_PARAMS` (`network`, `chain`,
  `chainId`, `asset_type`);
- the fragment: masked.

A value that is not an http(s) or ws(s) URL is returned unchanged (`isUrl` tells). `urlCredential(url)`
says where a URL may carry a credential, as a phrase, or null; it is non-null exactly when `redactUrl`
would mask something. Every SDK error that mentions a URL passes it through `redactUrl`, and the keeper's
config loader refuses a URL with a credential written into its file.

```ts
{{#include ../../examples/advanced/low-level-subgraph.ts:urls}}
```

## The Typed ABIs

The five contracts' ABIs are vendored as `as const` modules from the Bazaar repository's `abi/`
directory (MIT): `bazaarFactoryAbi`, `bazaarOracleAbi`, `bazaarPairAbi`, `bazaarPairLensAbi`,
`bazaarPairTerminatorAbi`, and `ABIS` by `ContractName` (`CONTRACT_NAMES` lists them). `bazaarPairAbi`
also carries the events and errors of the libraries the pair links: they run by DELEGATECALL in the
pair's context, so their logs carry the pair's address and their reverts surface from its calls. Use
them with viem, wagmi or any typed client:

```ts
{{#include ../../examples/advanced/low-level-abi.ts:abi}}
```

`ABI_SOURCE` records the Bazaar commit the ABIs were copied from (`commit`, `date`, `dirty`).
`npm run sync-abis` refreshes them: see [Development](../reference/development.md).

## Related

- [Building a Bot](bots.md): these pieces put together.
- [The Keeper as a Library](../keeper/library.md): the keeper's engine on top of them.
- [Errors & Messages](errors.md): `errorMessage` and the user messages behind `DecodedError.message`.
- [Units & Constants](../reference/units.md): the constants the formulas use.
