# The Keeper as a Library

Everything the `bazaar` command does is available from TypeScript in `@liberta-labs/bazaar-keeper`:
build a keeper from the same config, listen to what it does, run one call, or run it all inside your
own service. Use the library when the keeper is part of something larger (a trading system that also
keeps its markets, a service with its own health checks and metrics), or to script one-off
operations.

The package runs in Node 20 or later (it reads files, holds keys and opens sockets: it is not for
browsers). Install it as in [Setting Up a Keeper](setup.md#1-install); the samples import from
`@liberta-labs/bazaar-keeper` and `@liberta-labs/bazaar-sdk`.

## Creating a Keeper

```ts
{{#include ../../examples/keeper/library.ts:create}}
```

| Function | What it does |
|---|---|
| `loadConfig(path?)` | reads the YAML file (default `bazaar-keeper.yaml`), the `.env` beside it and the environment, applies the [secrets rules](wallets.md#the-secrets-rules), fills `${NAME}` references and validates. Throws `ConfigError` |
| `parseConfig(object)` | validates an object against the same schema, with the same defaults. Throws `ConfigError` |
| `Keeper.create(cfg, { loadWallets? })` | builds the keeper and loads its wallets (a keystore may prompt for its password when stdin is a terminal). `loadWallets: false` makes a watch-only keeper. Throws `ConfigError` for a config it cannot run with (`rpc.send: sequencer` on a network without one, a `prices.endpoint` that is neither `pyth` nor a URL, Pyth's own endpoints without `prices.token`), `WalletError` for a wallet it cannot load |
| `setupLogging(level, format, write?)` | configures the keeper's log output: `level` `debug`/`info`/`warning`/`error`, `format` `pretty`/`json`, lines to stdout or to `write`. Until it is called, warnings and errors go to stderr as bare messages and the rest is dropped |

`ConfigError` and `WalletError` messages are written for the person fixing the problem and never
contain a key or a password. `new Keeper(cfg)` builds a keeper without loading its wallets yet; they
load on the first `connect()` (and so on `start()` or any `run.*` call).

### Configuring in Code

`parseConfig` takes the same keys as the YAML file. It does not read `.env`, fill `${NAME}`
references or apply the file's secrets rules: the object is used as given, so take secrets from the
environment or a secret store yourself.

```ts
{{#include ../../examples/keeper/config-object.ts:parse}}
```

## Events

```ts
{{#include ../../examples/keeper/library.ts:events}}
```

| Event | Payload | When |
|---|---|---|
| `action` | `ActionResult` | a sent transaction's result, once its receipt is in (`confirmed`, `reverted` or `unknown`) |
| `sent` | `[Action, txHash]` | a transaction was submitted |
| `alert` | `[kind, message]` | `lowBalance`, `jobPaused` or `endpointDown`, whether or not an alert channel is configured or the kind is in `alerts.notify` (the daily summary goes to the channels only) |
| `opportunity` | `Opportunity` | a manual operation found by the running keeper's periodic scan. The scan runs only when an alert channel is configured and `opportunity` is in `alerts.notify`; otherwise call `findOpportunities` yourself |

`on(event, handler)` returns a function that unsubscribes. A handler that throws or rejects is logged
and never breaks the keeper. Skipped calls are not events (they repeat every tick); they are logged.

An `ActionResult` has:

| Field | Meaning |
|---|---|
| `status` | `confirmed`, `reverted`, `unknown` (sent, no receipt), `skipped` (not sent), `simulated` (dry run or preview) |
| `job`, `market`, `summary` | the job (or operation), the market's label, a one-line description |
| `reason` | why it was sent or skipped (`earns $0.1000 for $0.0021 of gas`, `daily gas budget reached …`) |
| `kind` | the decision: `profit`, `loss`, `unpaid`, `forced`, `skip`, `collect`, `forward` |
| `wouldSend` | whether the policy would send it (meaningful for `simulated`) |
| `sent` | `true` for `confirmed`, `reverted` and `unknown` |
| `txHash`, `gasUsed` | the transaction, once sent |
| `costUsd` | the estimated gas cost, then the actual one after the receipt |
| `expectedRewardUsd` | what the simulation said the call would earn |
| `rewardUsd`, `claimedUsd` | what the receipt shows it earned and claimed |
| `error` | a revert, decoded (`toString()` gives a readable line), or null |
| `opensAt` | for a "too early" revert, when the call opens (seconds since the epoch), or null |
| `returned` | the call's return data from the simulation |

## One-Shot Runs

`keeper.run` holds every automatic job once and every manual operation, each naming its market on the
call (a label, an address or a pair id). Each connects and syncs first when needed, so it works on a
keeper that is not running as well as on one that is. [Manual Operations](manual-operations.md)
explains what each does.

```ts
{{#include ../../examples/keeper/library.ts:oneshot}}
```

The automatic jobs return `ActionResult[]` (one per call planned, or one `skipped` result saying why
nothing was planned) and take `{ dryRun?, force? }`; the list-taking ones accept the list either as an
argument or in the options:

| Method | Lists |
|---|---|
| `liquidate(market, accounts?, opts?)` | `accounts` |
| `executeTriggers(market, orderIds?, opts?)` | `orderIds` |
| `unload(market, opts?)` | |
| `executeAdl(market, longBucketWinners?, shortBucketWinners?, opts?)` | `longBucketWinners`, `shortBucketWinners` |
| `refreshPrice(market, opts?)` | |
| `collect(markets?, opts?)` | `"all"` (default) or a list of markets |
| `settleTerminal(market, accounts?, opts?)` | `accounts` |
| `sweepExpired(market, orderIds?, opts?)` | `orderIds` |

The manual operations return one `ActionResult` and take `{ dryRun? }`: `finalizeTermination(market)`,
`terminateStalePair(market)`, `terminateScheduledPair(market)`, `settleTerminationProposal(assertionId)`,
`executeInsurerTermination(market, proposalId)`, and under `run.factory`:
`settleDeploymentProposal(assertionId)`, `expireStuckDeploymentProposal(pairId)`,
`settleIdentifierUpgradeProposal(assertionId)`, `expireStuckIdentifierUpgradeProposal()`,
`activateIdentifierUpgrade()`. Ids are 32-byte hex strings (with or without `0x`) or bytes.

```ts
{{#include ../../examples/keeper/operations.ts:auto}}
```

A manual operation sends at once unless `dryRun` is set, so preview it first, as the CLI does:

```ts
{{#include ../../examples/keeper/operations.ts:manual}}
```

`findOpportunities(keeper)` returns what `bazaar keeper opportunities` prints: each `Opportunity` has
`operation`, `market` (a label, for people), `detail`, `command` (the CLI command, naming the market by
address), `ready` and `opensAt`, and `describe()` for one line.

```ts
{{#include ../../examples/keeper/operations.ts:opportunities}}
```

A one-shot run takes the same in-flight keys as the running keeper's jobs, so in one process it never
sends a call the keeper is already sending (`already in flight: the keeper is sending this call; try
again once it lands`).

## Starting and Stopping

```ts
{{#include ../../examples/keeper/library.ts:start-stop}}
```

| Method | What it does |
|---|---|
| `start()` | connects (unless connected), then runs the tick loop, the price stream and the print path until `stop()`. Resolves once the shutdown has finished; rejects if connecting fails (wrong chain, bad wiring, no deployment block found) |
| `stop({ collect?, timeout? })` | stops dispatching, ends the price stream at once, waits up to `timeout` seconds (60) for the loop and the in-flight sends, claims earnings if `collect` (default `jobs.collect.onShutdown`), and saves the snapshot. Calling it again returns the same promise |
| `close()` | releases the price stream, the subgraph and alert clients. Call it after `stop()`, or after one-shot use |
| `connect()` | checks the chain and the wiring, loads the snapshot or builds the index, reads the watched markets' state. Once; `start()` and `run.*` call it |

A keeper runs once: after `stop()`, `start()` throws `this keeper has already run and stopped; create a
new Keeper to start again`. Calling `start()` while it runs throws `the keeper is already running`.

## Status and State

| Member | What it is |
|---|---|
| `statusDict()` | the `KeeperStatus` object `status.json` holds: head, index, prices, each market and job, the wallets, `halted` ([fields](production.md#monitoring)) |
| `writeStatus()` | writes `status.json` now (the running keeper does every 5 s) |
| `running` | `true` while `start()` runs |
| `recent` | the latest 50 sent results, newest first |
| `ledger` | the earnings ledger: `ledger.summary(sinceSeconds, "job" \| "market")`, `ledger.entries`, `ledger.spentToday()` |
| `store` | the index: `store.markets` (address to `Market`), `store.positions`, `store.orders` |
| `prices` | the SDK's `PriceService`: `prices.latest`, `prices.healthy`, `prices.onPrints(listener)` |
| `jobs` | the enabled jobs by name |
| `cfg`, `net` | the parsed config, and the resolved network (`chainId`, `factory`, `official`, `startBlock`) |
| `stateDir` | where the snapshot, ledger and status file live |
| `resolveMarket(ref)`, `findMarkets(ref)` | a market by label, address or pair id (one, or every one carrying a label) |

`stateDirFor(cfg)` gives the state directory without building a keeper, and `listMarkets(cfg)` lists the
factory's markets with their labels without indexing anything.

## Embedding in a Service

A keeper inside a long-running service, with a health endpoint and running totals for metrics:

```ts
{{#include ../../examples/keeper/service.ts:service}}
```

Points to keep in mind:

- **One keeper per set of wallets**, in one process ([Running in Production](production.md#one-process-per-set-of-wallets)).
- **Handle SIGTERM** by calling `stop()`, and give the process time to finish (up to `timeout`, plus the
  shutdown collect).
- **Configure logging** with `setupLogging` before creating the keeper; pass `write` to route lines
  into your own logger.
- **Event handlers run on the keeper's event loop.** Keep them short; hand slow work (a database write,
  a network call) to a queue rather than awaiting it in the handler.
- The `bazaar_sdk.*` loggers never log keys or full URLs; your handlers should not either (pass URLs
  through the SDK's `redactUrl`).

## Related Pages

- [Configuration Reference](configuration.md): every key `parseConfig` takes.
- [Manual Operations](manual-operations.md): what each `run.*` call does.
- [Testing Locally with Anvil](local-testing.md): a keeper and a mock price server in one script.
