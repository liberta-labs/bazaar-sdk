# Testing Locally with Anvil

Before a keeper spends real gas, you can run it against a local chain: a Bazaar deployment on
[Anvil](https://book.getfoundry.sh/anvil/), prices from a mock Pyth Pro server whose updates the local
deployment's verifier accepts, and every job enabled. You move the price and the clock yourself and watch each job do its
work. This page covers the fastest way (the repository's end-to-end suite), a local deployment of your
own, the mock price server, and a keeper config for Anvil.

You need Foundry's `anvil` (and `cast`, for poking the chain) and the repository built from source
([Setting Up a Keeper](setup.md#1-install)).

## The End-to-End Suite

The repository's end-to-end tests do everything for you: they replay a recorded deployment of
Bazaar's current contracts on a fresh Anvil (no Bazaar checkout and no compiler needed), list an
ETH/USD market, build a book, a stop-loss and a leveraged position, then run the real keeper with
every job enabled against the mock price server, moving the price and the clock to give each job its
work, and check each outcome on chain. It also reports the keeper's latency from a price move to its
send.

```bash
# a fresh Anvil with the flags the suite expects
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000

# in another terminal, from the repository
npx vitest run -c vitest.e2e.config.ts packages/keeper/test/e2e/keeper.e2e.test.ts
```

| Flag | Why |
|---|---|
| `--block-time 1` | a block a second, as the scenario's waits assume |
| `--base-fee 10000000` | 0.01 gwei, under the keeper's default `gas.backgroundMaxFeeGwei` (0.1), so background work runs |
| `--code-size-limit 100000` | Bazaar's contracts are larger than the 24 KB mainnet limit |

`BAZAAR_E2E_RPC` points the suite at another URL (default `http://127.0.0.1:8546`); with no Anvil
answering there, the suite is skipped. Running all three e2e files (`npx vitest run -c
vitest.e2e.config.ts`) adds a deployment smoke test and a run of the frontend SDK through the same
scenario. Each file snapshots the chain first and reverts to the snapshot at the end, so the next file
replays on the same Anvil; it also means the deployment is gone afterwards.

### The Fixtures

`packages/keeper/test/e2e/fixtures/` holds what the suite replays:

| File | What it is |
|---|---|
| `deployment.json` | the transactions Bazaar's Anvil deployment (`script/DeployBazaar.s.sol`) sends, computed from a built Bazaar checkout's artifacts |
| `MockArbSys.json` | the bytecode the replay places at the ArbSys precompile (`0x…64`), where the pair reads its block number |
| `build.mjs` | produces the two files from a built Bazaar checkout (`node packages/keeper/test/e2e/fixtures/build.mjs <checkout>`), with no chain and no compiler |

The deployment is 21 transactions from Anvil's first account: twelve libraries through the
deterministic CREATE2 deployer, then `MockPythLazer` (Pyth's verifier, with no fee) and the call that
makes it trust the public test signer, `MockUSDC`, `MockOptimisticOracleV3`, `BazaarOracle`, the
`BazaarPair` implementation, `BazaarPairLens`, `BazaarPairTerminator` and `BazaarFactory`. Replayed on
a fresh Anvil they land at the same addresses:

| Contract | Address |
|---|---|
| `BazaarFactory` | `0xc6e7DF5E7b4f2A278906862b61205850344D4e7d` |
| `MockPythLazer` | `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0` |
| `MockUSDC` | `0x9A676e781A523b5d0C0e43731313A708CB607508` |

The fixtures' `README.md` records the Bazaar commit they come from, and how to regenerate them
whenever Bazaar's contracts change (together with the SDK's ABIs, `npm run sync-abis`).

## A Local Deployment of Your Own

To keep a deployment running and point your own keeper at it, deploy from a Bazaar checkout:

```bash
# in a Bazaar checkout with its lib/ submodules
forge build script/DeployBazaar.s.sol test/mocks/MockArbSys.sol
anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000

# Anvil's first default account (the public test mnemonic): a test key only
forge script script/DeployBazaar.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --code-size-limit 100000

# the pair reads its block number from ArbSys: place the mock at the precompile's address
cast rpc --rpc-url http://127.0.0.1:8546 anvil_setCode 0x0000000000000000000000000000000000000064 \
  "$(jq -r .deployedBytecode.object out/MockArbSys.sol/MockArbSys.json)"
```

The contracts' addresses are in `broadcast/DeployBazaar.s.sol/31337/run-latest.json`. The
deployment's Pyth verifier is `MockPythLazer`: it charges no fee and trusts one signer, whose key is
derived from a public label (`keccak256("bazaar.test.pyth-lazer-signer")`, the SDK's
`lazer.localSignerKey()`), so anyone on the chain can sign a price. Only a chain with id 31337 may
trust that key: the deployment script refuses, anywhere else, a verifier that trusts it.

A factory with no markets gives the keeper nothing to do, so list one next. The e2e scenario's
`Scenario.setup` in `packages/keeper/test/e2e/chain.ts` is a working recipe: it mints MockUSDC to
Anvil's accounts, proposes an ETH/USD listing (Pyth Pro feed 2) with a $5,000 seed
(`proposePairDeployment`), warps 48 hours, settles it (`settleDeploymentProposal`, which a keeper can
also run: `bazaar keeper run settle-listing --assertion …`), deposits collateral and insurance with
updates it signs with the test key, and builds a book, a stop-loss and a position close to
liquidation. [Listing Markets](../sdk/listings.md) builds the same listing calls with the SDK.

## The Mock Price Server

Bazaar's pairs have every price update verified by Pyth's verifier, and on Anvil that is
`MockPythLazer`, which trusts the public test signer. The mock price server is a Pyth Pro endpoint
whose updates that key signs, so the keeper (and any SDK client) can use it as `prices.endpoint`.

```bash
bazaar mock-prices --rpc http://127.0.0.1:8546 --price 2=2000
```

```text
mock Pyth Pro on http://127.0.0.1:8787 (stream ws://127.0.0.1:8787/v1/stream), on the clock of http://127.0.0.1:8546; feeds: 2
```

It serves what the keeper and the SDK use, each update built by the SDK's encoder, signed with the
test key and stamped with the chain's time (the latest block's timestamp plus the time since that
block was seen), so Anvil accepts it as fresh whatever you do to the clock:

| Route | What it serves |
|---|---|
| WebSocket `/v1/stream` | per subscription, an update at once and one per interval of its channel (`real_time` runs at 50 ms) |
| `POST /v1/latest_price` | the newest update on the requested channel, for the requested feeds |
| `POST /v1/price` | the `fixed_rate@1000ms` update stamped on the requested second (for `terminate-scheduled`), or HTTP 404 for a second the chain has not reached |
| `GET /v1/symbols` | the registry: each feed with its symbol (ETH/USD is `Crypto.ETH/USD`) |
| `GET /mock/price` | the current prices, by feed number |
| `POST /mock/price` | set a feed's price, pause or resume it, or fix its confidence |

Feeds are Pyth Pro feed numbers; `--price` and `POST /mock/price` also take the bytes32 a pair reports
(its `baseFeedId`). Prices have exponent −8 and a confidence of 0.1% of the price, never less than one
unit. ETH/USD (feed 2, which the keeper prices gas with) starts at 2000 unless `--price` sets it. Only
ETH/USD has a symbol from the command line (`MockPro` in TypeScript takes symbols for the others), so
markets on other feeds are labelled by their listing description. A feed serves its starting price
for every past second, so the archive answers for any cutoff.

Set a price while it runs:

```bash
curl -X POST localhost:8787/mock/price -H 'content-type: application/json' \
  -d '{"id": 2, "price": 1850.5}'
```

Add `"paused": true` to stop the feed generating prices, as a market closing for the night would: its
updates keep coming and carry its last price forward with the time that price was generated, so they
read as stale, as Pyth's do (a liquidation on a market with trading hours may still carry the newest
of them for a minute after that price, as it may Pyth's: [Liquidation](jobs.md#liquidation)).
`"paused": false` resumes it. `"confidence": 0` makes its updates carry no
confidence (the oracle refuses those, and the keeper never attaches them); `"confidence": null` goes
back to the default.

The server is for local testing only. A `POST` to `/mock/price` must be JSON (`content-type:
application/json`); it and a stream connection must carry a `Host` header that names this machine
(`localhost`, an IP address, or the `--host` it listens on) and come from no web page on another
origin, so a site open in a browser can neither set your prices nor read the stream, directly or
through DNS rebinding. A name under `.localhost` does not count as this machine: a resolver that
answers for it can point it anywhere. Its updates verify only on a chain whose verifier trusts the
public test key.

It listens on this machine only (`localhost`, `127.0.0.0/8` or `::1`) unless it has a token, since
anyone who reaches it can set the prices a keeper acts on. To reach it from another machine (a
container, say), give it one from the environment and listen on an address that machine reaches:

```bash
MOCK_PRICES_TOKEN=made-up-local-token bazaar mock-prices --host 0.0.0.0 --token-env MOCK_PRICES_TOKEN
```

Every request but the symbols registry must then present it, the price controls included (`-H
"authorization: Bearer $MOCK_PRICES_TOKEN"`). A keeper sends it as `prices.token`, names the server
by its IP address (another name is refused as DNS rebinding, unless it is the `--host` itself), and
needs `prices.allowInsecure: true` to send the token over plain `http` to another machine.

### In the Same Process

From TypeScript, `MockPro` and `startMockPro` run the same server inside your script, and the
`MockPro` object sets prices directly:

```ts
{{#include ../../examples/keeper/local-anvil.ts:mock}}
```

`new MockPro({ rpc, prices, symbols, confidenceBp, token })` takes the chain whose clock it follows (a
URL, an EIP-1193 transport or an SDK `Chain`; left out, this machine's clock, or a `clock` you give),
starting prices and symbols by feed, the confidence in basis points (default 10), and a token every
request and stream connection must then present. `startMockPro(mock, { host?, port? })` resolves once it
listens and returns its `url`, its `streamUrl` and a `close()`. `mock.setPrice(feed, usd)` moves a
price, `mock.pause(feed)` and `mock.resume(feed)` stop and restart it, and `mock.setConfidence(feed, c)`
fixes its confidence.

## A Keeper Config for Anvil

```yaml
network: anvil
factory: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d"

rpc:
  http: http://127.0.0.1:8546
  maxRequestsPerSecond: 200

subgraph:
  url: none                      # index from logs: on a fresh chain the scan is short

prices:
  endpoint: http://127.0.0.1:8787  # bazaar mock-prices: no token needed
  sendMarginSeconds: 0.5         # Anvil's one-second blocks land prints quickly

wallets:
  default:
    type: privateKey
    key: ${ANVIL_KEEPER_KEY}     # in .env: one of Anvil's test keys, never a real one

jobs:
  liquidation: {}
  triggers: {}
  unload:
    recheckSeconds: 2
  adl: {}
  refresh: {}
  terminalSettlement:
    finalizeMaxCostUsd: 1
  sweepExpired:
    minBatch: 1
  collect:
    thresholdUsd: 0.01
    intervalSeconds: 3

budget:
  minEthBalance: 0.001

state:
  dir: ./state-anvil             # separate from any real keeper's; relative to where you start it

engine:
  idleRefreshSeconds: 1.5
  simCooldownSeconds: 1
```

```bash
# .env beside it: Anvil's eighth default account, m/44'/60'/0'/0/7 of the public test mnemonic
ANVIL_KEEPER_KEY=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
```

The wallet key is a secret key, so even a public test key goes in `.env`. Anvil's accounts start with
10,000 ETH. Then:

```bash
bazaar keeper doctor -c anvil.yaml
bazaar keeper start -c anvil.yaml
```

`doctor` and the log say `factory … is not an official deployment`: expected on Anvil. With `startBlock`
left out, the first start finds the factory's deployment block by searching the chain's history, which
Anvil keeps.

The same keeper in one script, with the mock server, moving the price and pausing the feed:

```ts
{{#include ../../examples/keeper/local-anvil.ts:keeper}}
```

```ts
{{#include ../../examples/keeper/local-anvil.ts:move}}
```

## Moving the Clock

Many jobs wait for time: the refresh bounty for 5 minutes or a day, the unload floor for 3 minutes,
an ADL auction for 10, a termination for its cutoff. Anvil lets you jump:

```bash
cast rpc --rpc-url http://127.0.0.1:8546 evm_increaseTime 3600   # one hour later…
cast rpc --rpc-url http://127.0.0.1:8546 evm_mine                # …from the next block
```

The keeper follows the chain's clock (the latest block's time), and the mock stamps every update with
it, so prices stay fresh across a jump.

Two things to expect:

- **One price a second.** A pair stores the price a call carries only when it was generated in a
  later second than the price it holds; within a second the first one stands. A move made in the
  second of the pair's last stored price reaches the chain with the next second's update, for any
  sender, and the keeper plans it then ([The Price a Call Is Judged At](jobs.md#the-price-a-call-is-judged-at)).
  The e2e suite waits for the chain to pass that second before each move.
- **The stream's cadence.** The mock streams on the configured channel (`fixed_rate@200ms` by
  default), so a move takes up to one interval to reach the keeper before the keeper's own reaction
  time.

## Related Pages

- [Commands](commands.md#mock-prices): every `mock-prices` option.
- [Configuration Reference](configuration.md): what each Anvil-specific value changes.
- [Development](../reference/development.md): the repository's other tests.
