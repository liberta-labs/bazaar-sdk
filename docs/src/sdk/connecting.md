# Connecting

Every use of the SDK starts with a connection: one chain, one Bazaar deployment, and optionally a
price source and Bazaar's subgraph. This page covers `Bazaar.connect` and `connect()` with every
option, the transports they accept, price sources (and how to keep a price API key out of a browser),
the subgraph, the integrator address, the chain check, checking market addresses, and the errors a
connection can raise.

What a connection is, and what the SDK caches on it, is on [Core Concepts](../getting-started/concepts.md#the-connection).

## Bazaar.connect

```ts
{{#include ../../examples/reads/connecting.ts:options}}
```

`Bazaar.connect(options)` does four things:

1. Registers the user-facing error messages (`installUserMessages()`), so a decoded revert reads as a
   sentence from then on.
2. Wraps the transport in a `Chain`: a URL becomes the SDK's own HTTP client (`JsonRpc`), anything
   else is used as given.
3. Reads the chain id and, in one batched call alongside it, the factory's `lens`, `pairTerminator`,
   `oracle` and `usdc`. (The first batch also detects how this node batches; see
   [Transports](#transports).)
4. Checks the chain id against `chainId`, when given, and that the factory answered all four reads.

It returns a `Bazaar` with the context bound into every area. Nothing else is read until you ask:
the market list loads on the first `listMarkets` (or anything that resolves a market by name).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `transport` | `Transport \| string` | required | An EIP-1193 provider (a browser wallet's, a viem client, a `JsonRpc`) or a JSON-RPC URL. See [Transports](#transports). |
| `factory` | `Address` | required | The deployment's `BazaarFactory`. Everything else is read from it. Take it from Bazaar's [deployments page](https://docs.bazaar.finance/reference/networks.html): anyone can deploy a fork. |
| `chainId` | `number` | none | Refuse to connect on any other chain. |
| `prices` | `ProClientOptions \| ProClient \| PriceUpdateSource \| null` | `null` | Where signed Pyth Pro updates come from. Options (`{ token, ... }`) or a `ProClient` are made into a `proPriceSource`. Without one the connection is read-only for prices: every call that carries a price throws a `ConnectError`. See [Prices](#prices). |
| `checkSigners` | `boolean` | `true` | Have the price source use only updates signed by a signer the deployment's Pyth verifier trusts. See [Prices](#prices). |
| `subgraph` | `string \| { url, apiKey? } \| SubgraphSource \| null` | `null` | Bazaar's subgraph. A string or `{ url, apiKey }` is made into an `httpSubgraph`. Needed only for history (and for market descriptions in the market list). See [The Subgraph](#the-subgraph). |
| `integrator` | `Address \| null` | the zero address | Named on every order this connection creates; earns the integrator fee on their fills. See [The Integrator Address](#the-integrator-address). |

The returned object has:

| Member | What it is |
|---|---|
| `bz.ctx` | The `BazaarContext`: `chain`, `chainId`, `factory`, `lens`, `terminator`, `oracle`, `usdc`, `prices`, `subgraph`, `integrator`. |
| `bz.chainId` | The chain id the transport reported. |
| `bz.deployment` | `{ factory, lens, terminator, oracle, usdc }`. |
| `bz.markets`, `bz.account`, `bz.trade`, ... | Every area's context-first functions, bound. |
| `bz.simulate(call, opts?)`, `bz.send(wallet, call, opts?)`, `bz.waitForReceipt(hash, opts?)` | The write path ([Sending Transactions](sending.md)). |
| `bz.livePrices(opts?)` | A live price stream for every listed market ([Live Prices](live-prices.md)). |

## connect() and Bazaar.from

`connect(options)` is what `Bazaar.connect` calls. It returns the bare `BazaarContext`, for code that
uses the per-area functions (`markets.getMarket(ctx, ...)`), and takes sources only: its `prices` must
be a `PriceUpdateSource` and its `subgraph` a `SubgraphSource`, not URLs. `Bazaar.from(ctx)` wraps a
context in the facade.

```ts
{{#include ../../examples/reads/connecting.ts:low-level}}
```

| Option | Type | Default |
|---|---|---|
| `transport` | `Transport \| string` | required |
| `factory` | `Address` | required |
| `chainId` | `number` | none |
| `prices` | `PriceUpdateSource \| null` | `null` |
| `checkSigners` | `boolean` | `true` |
| `subgraph` | `SubgraphSource \| null` | `null` |
| `integrator` | `Address \| null` | the zero address |

The SDK keeps its caches per context object. Two contexts built from the same options (or a copy made
with `{ ...ctx, prices }`) each list the markets once.

## Transports

A `Transport` is anything with EIP-1193's `request({ method, params })`. Four kinds are common:

```ts
{{#include ../../examples/reads/connecting.ts:transports}}
```

- **A browser wallet's provider** (`window.ethereum`, or one from an EIP-6963 picker). Reads go
  through the wallet's own RPC. The same object is the `wallet` you send and sign with.
- **A viem client.** A `PublicClient` or `WalletClient` has a matching `request`; wagmi's clients are
  viem clients.
- **A URL**, `http(s)://`. The SDK makes a `JsonRpc` with its defaults.
- **A `JsonRpc`** of your own, to change those defaults:

| `JsonRpc` option | Default | Meaning |
|---|---|---|
| `perSecond` | 25 | Requests per second the client allows itself; extra requests queue in order. |
| `timeoutMs` | 30,000 | Per request. |
| `retries` | 3 | Retries after a failed request (HTTP errors, connection errors, timeouts, unreadable answers), waiting 500 ms, then 1 s, 2 s, ... Never for a send (`eth_sendRawTransaction`, `eth_sendTransaction`, ...). A JSON-RPC error answer (a revert) is not retried. |
| `headers` | none | Sent with every request. A value HTTP cannot carry (a line break) is refused when the client is made. |
| `fetch` | `globalThis.fetch` | The fetch to use. |
| `maxResponseBytes` | 64 MiB | A larger answer is refused, not retried. |

A `JsonRpc` never puts its URL or a header's value into an error message: `displayUrl` is the URL
with every part that may be a key masked. Its errors are `HttpError` (a non-2xx answer, with
`status`), `RpcError` (the node's JSON-RPC error, with `code` and `revertData`) and
`ResponseTooLargeError`.

**What the node needs.** Batched reads go through the SDK's probe contract placed with an `eth_call`
state override where the node honors overrides, through Multicall3 where it is deployed, and as
parallel `eth_call`s otherwise; the SDK detects which once per connection. Any node works. Live
updates use `eth_getLogs`, and wake on `eth_subscribe("newHeads")` when the transport emits EIP-1193
`"message"` events (a `JsonRpc` does not, so a URL connection polls). See
[Live Updates](live-updates.md#subscriptions-and-polling).

## Prices

Calls that need the price (order creation and amendment, trigger execution, a withdrawal with a
position, an insurance exit) carry a signed Pyth Pro update, fetched from the connection's
`PriceUpdateSource` when the call is built. Reads use it too: the market list takes labels from Pyth
Pro's symbols registry, and snapshots ask the source for the price of trading-hours markets to tell
whether their venue is open.

Pyth Pro needs a token on every request and every stream connection. There are two kinds: the
long-lived **API key**, and **short-lived tokens** minted from it (they live at most 15 minutes).
A server (a bot, a keeper, a relayer) may hold the key. A browser must not: code in a bundle is
public. A frontend therefore either gets short-lived tokens from its own backend
([below](#tokens-for-a-browser)), or leaves prices out and routes orders through a relayer that
attaches the update ([Gasless Trading](gasless.md)).

`prices` takes three forms:

- **Options for a client**: `{ token }`, where `token` is the API key (servers), or a function that
  returns a short-lived token and is called for each request and each connection attempt. The other
  `ProClient` options go in the same object.
- **A `ProClient`** you made, to share it with a live stream.
- **A `PriceUpdateSource`** you build: `proPriceSource(...)`, a `LivePrices` stream, or your own.

```ts
{{#include ../../examples/reads/connecting.ts:prices}}
```

`proPriceSource(options | ProClient)` and `new ProClient(options)` take:

| Option | Default | Meaning |
|---|---|---|
| `token` | none | A string, or `() => string \| Promise<string>`. Sent as `Authorization: Bearer <token>`; on a stream connection in a browser, in the subprotocol list instead, since a browser cannot set a WebSocket's headers. |
| `channel` | `"fixed_rate@200ms"` | The channel streamed and read by `latest`: `real_time`, `fixed_rate@50ms`, `fixed_rate@200ms` or `fixed_rate@1000ms`. A feed is served on its registry `min_channel` and every slower one. |
| `streamUrls` | Pyth's three | The WebSocket endpoints. The stream connects to all of them, as Pyth requires, and yields each update once. |
| `restUrl` | Pyth's | Base URL of the request API (`/v1/latest_price`, `/v1/price`). A URL with a query or a fragment is refused: a key goes in `token` or `headers`. |
| `symbolsUrl` | Pyth's | Base URL of the symbols registry, which needs no token. No query or fragment either. |
| `headers` | none | Extra request headers for the request API and the stream (an endpoint behind your proxy), on a stream connection wherever the runtime lets a WebSocket set headers (not in a browser). Never sent to the symbols registry. |
| `timeout` | 10 | Seconds a request may take (the stream has no limit). |
| `fetch` | `globalThis.fetch` | The fetch to use. |
| `WebSocket` | the global one | The WebSocket constructor to stream with. Node before 22 has none: pass a package's, such as `ws`. |
| `streamAuth` | by runtime | `"header"` or `"subprotocol"`: how a stream connection presents the token. Defaults to the subprotocol in a browser or a web worker, the header elsewhere. |
| `isTrustedSigner` | none | `(signer) => boolean`: when set, the signer of each update the client takes is recovered and an update it refuses is never used. `connect` sets it for you (below). |
| `allowInsecure` | `false` | Send credentials over plain `http://` or `ws://` to an endpoint that is not this machine: the token and headers, and a user name, password or query inside an endpoint's URL. Refused otherwise. Only a host that is exactly `localhost`, an address in `127.0.0.0/8` or `[::1]` counts as this machine (a name under `.localhost` does not: it may be resolved through DNS). |
| `clock` | the system clock | Unix seconds a streamed update's own timestamp is judged against (a keeper passes the chain's). |
| `maxUpdateAhead` | 60 (`MAX_UPDATE_AHEAD`) | Seconds a streamed update may be stamped ahead of `clock`; an endpoint sending one further ahead is dropped and reconnected later. |

The source has `latest(feedIds)` (one request for exactly those feeds, so the update carries them and
nothing else, both legs of a composite in one; and the second the oldest of their prices was generated
in), `atTick(feedIds, second)` (the one-second channel's update for a past second, which settlement
proofs are made of), `prints(feedIds)` (the parsed prints) and `client`, its `ProClient`. Every price is
read from the signed update itself, never from the JSON an endpoint sends beside it, so a dishonest
endpoint can only withhold prices, not change them, and every update is kept exactly as Pyth's
verifier reads it: bytes an endpoint appends to one never reach a call's calldata.

The client keeps its credentials out of sight: the token, the headers and the configured URLs are
private fields, so printing or serializing a client (or a context, or a `PriceService`) shows none of
them; every message it produces has them masked and every URL in it redacted; and a request carrying
a token or headers never follows a redirect.

**Whose signature.** Pyth signs every update, and the chain accepts one only from a signer its
verifier contract trusts. `connect` gives the source the same test: it reads the verifier from the
deployment's oracle (`pythLazer()`) and asks it `isValidSigner(signer)` for each new signer, keeping
the answer for a minute. An update signed by anyone else is refused before it becomes a price your
page shows or a call carries. Checking costs one signature recovery per update; pass
`checkSigners: false` to leave the source as you gave it. The chain verifies every update a call
carries either way.

**Feed IDs.** A Pyth Pro feed is a number (BTC/USD is 1). The contracts hold it in a `bytes32`
(`0x00…01`), and the SDK uses that form everywhere a feed ID appears; `feedIdHex(1)` and
`proFeedId(id)` convert. A composite market's ID is a hash, and its two legs are raw feed IDs.

### Tokens for a Browser

Your backend exchanges the API key for a short-lived token and hands that to your page:

```ts
{{#include ../../examples/reads/price-proxy.ts:tokens}}
```

The page asks for one when it needs it, and keeps it until shortly before it expires:

```ts
{{#include ../../examples/reads/connecting.ts:token}}
```

`cachedToken(mint, { margin })` calls `mint` only when it holds no token or the one it holds expires
within `margin` seconds (default 60), and shares one call among concurrent requests. A token whose
expiry the endpoint does not give is reused for five minutes. Gate the endpoint like any other of
yours: whoever is handed a token can read prices on your key until it expires.

### Your Own Source

A `PriceUpdateSource` is one method, and two optional ones:

| Method | Returns |
|---|---|
| `latest(feedIds)` | `{ update: Hex[], publishTime }`: the update a call's `priceUpdate` takes, carrying those feeds, and the second the oldest of their prices was generated in (Unix seconds). |
| `atTick?(feedIds, second)` | The one-second channel's update stamped exactly `second`, as a `ProUpdate`, or null when there is none. Only termination settlement uses it. |
| `useSignerCheck?(check)` | Called by `connect` with the deployment's signer test. Leave it out if your source cannot check signers. |

A source that is not a `proPriceSource` gives the SDK no symbols registry and no parsed prints: the
market list then takes labels from Pyth's own registry (`PYTH_PRO.symbolsUrl`), and snapshots judge a
trading-hours venue only from live prices you pass them.

## The Subgraph

History (trades, candles, orders and their events, positions, fees, liquidations, insurance,
proposals and votes) comes from Bazaar's subgraph. The market list also takes each market's listing
description from it, when it can; every other read comes from the chain.

```ts
{{#include ../../examples/reads/connecting.ts:subgraph}}
```

`subgraph` takes a GraphQL URL, `{ url, apiKey }`, or a `SubgraphSource` (anything with
`query(query, variables)`). The URL forms build `history.httpSubgraph(url, apiKey?, options?)`, which
POSTs `{ query, variables }` and sends the key as `Authorization: Bearer <key>` (The Graph's gateway
also takes it in the URL path; such a URL is masked in errors). Its options:

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 30,000 | Per query. |
| `headers` | none | Extra request headers. |
| `fetch` | `globalThis.fetch` | The fetch to use. |

The same rule about keys applies as for prices. Without a subgraph, every `history` function throws a
`ConnectError`; the rest of the SDK is unaffected. See [History](history.md).

## The Integrator Address

An order names an integrator, an address that earns 0.25 bp of each fill's notional from the side of
the fill that carries it (see Bazaar's [integrator guide](https://docs.bazaar.finance/guide/integrators.html)).
The connection's `integrator` is written into every order `trade.createOrder` and `trade.prepareOrder`
build (and so into gasless order requests). It is your users' surcharge as well as your revenue:
leave it unset (the zero address) to charge none. Collect what it earns with `trade.claimFees` on each
market.

## Chain Checks

With `chainId` given, `connect` throws a `ConnectError` when the transport is on another chain. Give
it in a frontend: a wallet can be on any network, and a factory address means nothing on the wrong
one. The SDK does not follow the wallet's `chainChanged` events: listen for them yourself and connect
again.

Signing (permits, gasless requests) also checks the clocks: deadlines are counted from the lower of
the latest block's time and this device's clock, and a `ClockSkewError` refuses to sign when they
differ by more than two minutes (except on local development chains, ids 31337 and 1337). Its message
tells the user to set their clock to update automatically.

## Checking Market Addresses

A market address that reaches your code from a link, a query string or a subgraph row is untrusted.
Every builder checks its pair with the factory (`factory.isPair`) before building anything for it,
and `requirePair` makes the same check for your own code:

```ts
{{#include ../../examples/reads/connecting.ts:require-pair}}
```

`requirePair(ctx, address)` resolves to the checksummed address, or rejects with an `InputError` on
`pair` ("... is not a market of this Bazaar deployment, so nothing will be built or signed for it.").
A confirmation is cached per connection; a refusal is not, so a market listed later is accepted.
`markets.getMarket` resolves only the factory's own markets, so a market found through it needs no
further check.

## What Can Go Wrong

```ts
{{#include ../../examples/reads/connecting.ts:errors}}
```

| Error | Message | Why |
|---|---|---|
| `ConnectError` | `connected to chain 421614, expected 42161` | The transport (the wallet) is on another chain. |
| `ConnectError` | `0x... does not answer as a Bazaar factory on chain 42161` | The factory's reads reverted: the address is some other contract. |
| viem's `AbiDecodingZeroDataError` | `Cannot decode zero data ("0x") ...` | The factory address has no contract on this chain at all (the reads "succeed" with empty answers). |
| viem's `InvalidAddressError` | `Address "..." is invalid.` | `factory` or `integrator` is not an address. |
| `HttpError` | `HTTP 401 from https://.../v2/***: the provider refused the request; check the key in the URL` | The RPC refused the request. |
| `TypeError` | `JsonRpc: the ... header's value holds a line break, ...` | A header value (often from an `.env` file) has a stray character. |
| `ProError` | `the price token (prices.token) holds a line break ...` | The same, for the Pyth Pro token. Raised when the client is made, or when a token provider returns one. |
| `ConnectError` | `this call needs a fresh Pyth Pro price: connect with a price source (prices)` | Later, from a builder: the connection has no `prices`. |
| `ConnectError` | `history comes from Bazaar's subgraph: connect with a subgraph source` | Later, from `history`: the connection has no `subgraph`. |

`errorMessage(e)` shows these as "Something went wrong. Please try again." (they are not the user's
doing); log `e.message` for the detail.

## Related Pages

- [Core Concepts](../getting-started/concepts.md)
- [Markets](markets.md), [Accounts & Portfolios](accounts.md)
- [Live Prices](live-prices.md), [Live Updates](live-updates.md)
- [Sending Transactions](sending.md)
- [Security Notes for Integrators](../reference/security.md)
