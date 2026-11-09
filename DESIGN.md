# Design

How the SDK and its keeper work and why they are built this way. Usage is in the [README](README.md),
[packages/sdk](packages/sdk/README.md) and [packages/keeper](packages/keeper/README.md).

The code is TypeScript in two packages. `@liberta-labs/bazaar-sdk` (`packages/sdk/src`) holds everything
that runs in a browser as well as in Node: the typed ABIs, the chain client and codecs, the price layer,
formulas, models, the reader and the subgraph client (shared by the keeper), and the frontend client
(`client/`). `@liberta-labs/bazaar-keeper` (`packages/keeper/src`) holds what only a server runs: the
config, the store and log tail, wallets and the executor, the engine with its jobs and operations
(`keeper/`), and the `bazaar` CLI. A path below such as `sync/reader.ts` is under one of those two.

The package was ported from Python (`bazaar_sdk`). The behaviour is the same, with these deliberate
differences: the keeper's snapshot format is version 2 (bigints as decimal strings) and does not read
the Python keeper's; job names are camelCase everywhere; and the port fixed what it found on the way
(the wizard's empty-job bug, receipt polling that could drop a sent transaction's record, alert
channels that failed together, a price stream with no stall timeout) and what a security audit of the
port found (prices taken from the signed update rather than the endpoint's JSON, ETH-denominated spend
caps, bounded deadlines, pair checks before any approval or permit, and the rest).

## The frontend client

The SDK never holds a user's key. Every write is built as a `PreparedCall` (`client/calls.ts`: target,
calldata, ETH value, the account it acts for, a one-line summary, what it pulls in USDC, and the
publish time of an attached price), which the frontend simulates as the user (a revert comes back
decoded, with a user-facing message from `errors/messages.ts`) and sends with its own wallet stack.
Signatures (gasless calls, USDC permits) are requested from an EIP-1193 provider with
`eth_signTypedData_v4`, so the wallet shows the user what they sign, and recovered locally before use.

A connection is a `BazaarContext` (`client/context.ts`): one chain, one deployment read from its
factory, and optional price and subgraph sources behind small interfaces, so any EIP-1193 provider,
viem client, Hermes proxy or GraphQL endpoint can stand behind them. Each area (markets, account,
live, trade, insurance, signing, permits, relay, batching, history, previews, termination, listings,
governance, uma) is a module of plain functions taking the context first; the `Bazaar` facade
(`client/bazaar.ts`) binds the context for every such function, from a list `scripts/gen-bindings.mjs`
generates from the source so it cannot drift. Reads batch through the probe where the node supports
state overrides, Multicall3 otherwise, and parallel calls as a last resort.

What can be checked before signing is checked: order specs are validated rule for rule as
`OrderManagementLib.createOrder` does, bonds, seeds and levies are shown as costs with the exact
approvals they need, and previews (fees, margin, liquidation price, withdrawal freezes) port the
contracts' integer math.

## Scope

The keeper runs every permissionless upkeep duty in Bazaar except relaying signed meta-transactions:

- **Automatic jobs**, each switched on per job and scoped to markets the operator lists:
  liquidation, trigger execution, vault unload, ADL execution, price refresh, collect, terminal
  settlement (with finalize) and expired-order cleanup.
- **Manual operations**, run only when asked, with the market or proposal named on each call:
  `finalizeTermination`, `terminateStalePair`, `terminateScheduledPair`, `settleTerminationProposal`,
  `executeInsurerTermination`, and the factory's `settleDeploymentProposal`,
  `expireStuckDeploymentProposal`, `settleIdentifierUpgradeProposal`,
  `expireStuckIdentifierUpgradeProposal` and `activateIdentifierUpgrade`.

Governance actions that post a bond or vote (termination and listing proposals, insurer votes) are
not keeper duties: the SDK's `termination`, `listings`, `governance` and `uma` modules build them for a
person to sign.

## Architecture

```text
            config (YAML via loadConfig, or an object via parseConfig)
                                │
  ┌─────────────────────────────┼──────────────────────────────┐
  ▼                             ▼                              ▼
Reader (sync/reader.ts)    PriceService (prices/)        Lanes (exec/wallets.ts)
factory → markets, legs,   one Hermes stream, per-pair   one signer + nonce
per-block state, candidate update payloads, composite    sequence per wallet
re-reads                   prices, freshness
  │                             │                              ▲
  ▼                             │                              │
Store (state/)  ◀── LogTail (sync/tail.ts) ◀── subgraph bootstrap (sync/bootstrap.ts)
positions, live orders,         │                              │
bounties, snapshots             │                              │
  │                             ▼                              │
  └──▶ Jobs (keeper/jobs/) ──▶ Executor (exec/executor.ts) ───┘
       candidates → Actions       probe simulation → spend policy → send → receipt → ledger
```

`Keeper` (keeper/engine.ts) owns these and runs one loop every `engine.tickSeconds`: read the head,
apply new logs, re-read the state of markets that changed, let every job plan, and hand each action
to the executor in its own task. The same executor path serves automatic jobs, one-shot runs
(`keeper.run.*`) and dry runs, so what a dry run reports is what a real run would do.

Liquidation and trigger execution race other keepers, and what usually makes them due is a price
move, so they also plan a market the moment a newer print for one of its legs arrives, without
waiting for the tick. The tick keeps planning them as well, because funding, margin rates, new
positions and new orders change without a print, and a closed session market gets none. Prints and
the tick share one plan per job and market at a time: a print or tick that arrives during a plan
queues one more plan, which then judges by the newest print. Planning is local until something
crosses (each position or order is checked against the live price first), so planning on every
print costs RPC requests only for real candidates. The print path waits while the index catches up
(a sync step that starts 64 or more blocks behind the head, as after a restart): positions opened
meanwhile are not indexed yet, and the bounty deltas being replayed would land on top of what a
plan re-read.

## The subgraph finds, the chain decides

The subgraph lags the chain and cannot see state that changes without an event: the funding index
between stored prices, the margin curve, the 24 h-lagged MMR, the live price. So it is only a
discovery source.

1. **Bootstrap.** Read `_meta`, then page through open positions and live or bounty-holding orders,
   every page pinned to that block, so the snapshot is consistent. With no subgraph, replay the
   factory's, the terminator's and every market's logs from `startBlock` instead.
2. **Tail.** From the next block, `eth_getLogs` over the factory, the terminator and every market,
   `rpc.logChunk` blocks a request. Events that report full state (a position bucket, an order
   update) overwrite; fills and bounty movements apply as deltas. A head whose hash changed rewinds
   64 blocks and re-reads them. After downtime the same tail replays every block since the snapshot;
   the subgraph is not asked again. Progress is recorded after each chunk, so a request that fails
   part-way through a catch-up resumes after the last applied chunk instead of applying the deltas
   twice. A range the node refuses (too many blocks or logs) is halved down to one block, and widened
   again after a run of successes, since the refusal may have been one busy stretch.
3. **Re-read before acting.** Every planner re-reads its candidates from the chain (position
   buckets, `orders(id)`, `triggerBounty`) in the block it simulates against.
4. **Snapshot.** The store is saved every minute with its block, so a restart tails from there.

Markets' state (price, margin rates, lagged MMR, projected funding index, ADL clocks, termination
stamps, vault buckets) is read in one batched call when a market's events mark it dirty, and every
`idleRefreshSeconds` otherwise.

## Prices

- **One stream.** The keeper subscribes once to the union of every watched market's legs plus
  ETH/USD (for pricing gas), and falls back to polling `latest` when the stream fails. Each newer
  print, from the stream or a poll, wakes the price-driven planners (see Architecture).
- **Per-pair payloads.** A Pyth accumulator update carries one signed root and a separate proof per
  feed, so `prices/accumulator.ts` re-encodes the stream's multi-feed update with only one pair's
  legs, without re-signing. A call then verifies only its own feeds.
- **Freshness.** The pair accepts a print at most 3 s from the block's time whose confidence is
  within 2% (per leg, and on the composed price). A call carries a print only while it is
  `sendMarginSeconds` younger than that, so it is still fresh when the transaction lands. Attaching
  an older print would revert the call, so a closed session market gets no update and only the jobs
  that work on the stored price proceed (liquidation, within 10 minutes of the stored price).
- **The pair reads Pyth's cache first** and verifies an attached update only when the cache is stale,
  so attaching one costs no verification gas when another transaction has just posted.

## Simulation probe

`contracts/KeeperProbe.sol` is never deployed. Its runtime code is placed at a fixed address through
an `eth_call` state override, and the keeper uses it two ways:

- **`execute`** runs the candidate call from the probe and returns the probe's claimable balance on
  the pair before and after, the call's return data or revert data, and two post-call facts
  (`isAdlPending`, `settlementPriceFixedTs`). Rewards accrue to `msg.sender`, so the balance delta is
  exactly what the call would earn, with every cap the contracts apply: insurance free capital, the
  unload tail, dust positions paid at their own equity, pro-rated bounties, settlement tips.
- **`aggregate`** batches reads into one `eth_call`, on any chain whose RPC supports overrides.

The gas cost comes from `eth_estimateGas` of the real transaction from the real wallet. Without
state overrides (`doctor` checks), calls are simulated directly: reverts are still caught, but the
reward is unknown, so only unpaid duties and loss-taking jobs can send.

## Spend policy

`exec/policy.ts` decides, for each simulated call, given reward R and cost C in USD:

1. Every call must fit `budget.maxSpendUsdPerDay` (gas across all jobs in the last 24 h, in-flight
   sends included).
2. A paid call is sent when R − C ≥ `minProfitUsd` and R ≥ C × `gasSafetyMultiplier`.
3. Otherwise it is sent only with consent: the job's `allowLoss`, or an unpaid duty switched on by
   name (`terminalSettlement.finalize`, `refresh.healthPokes`). The loss C − R must fit the per-call
   cap (`maxLossUsdPerCall`, or the duty's own cap), the job's `lossBudgetUsdPerDay`, and
   `budget.maxLossUsdPerDay`.
4. `force` (one-shot calls only) skips the profit and loss rules; nothing that reverts in
   simulation is ever sent.

`sweepExpired` pays nothing, so it ships with `allowLoss: true` and a small daily budget. Collect
and forwarding use their own rule (claim at the threshold when the balance covers the gas, or
anything older than `maxAgeDays`).

## Sending

- Each wallet is a lane: an `asyncio` lock around nonce assignment, the nonce cached and re-read after
  any send error.
- Arbitrum's sequencer orders transactions first come, first served, so a priority fee buys nothing:
  the keeper sends with priority fee 0 and `maxFeePerGas` = base fee × `feeMultiplier`. Latency wins
  races, which is why the latency-critical jobs can have their own wallet and `rpc.send` can point at
  the sequencer.
- Background work (collect, cleanup, finalize, forwarding) waits while the base fee is above
  `gas.backgroundMaxFeeGwei`.
- Each receipt's `FeeAccrued` and `FeesClaimed` logs give the actual reward and claim, written with
  the actual gas cost to the ledger (`ledger.jsonl`), which also backs the daily budgets and
  `earnings`.
- `safety.pauseAfterReverts` consecutive on-chain reverts pause that job on that market for
  `pauseMinutes`. A wallet below `budget.minEthBalance` stops all sending until it is funded.

## The jobs

| Job | Plans when | Call |
|---|---|---|
| liquidation | a position's equity is below the effective maintenance rate (the lower of `mmrBp` and a non-zero lagged rate) at the live price and projected funding index | `liquidate(accounts, update)`, every crossing account in one batch |
| triggers | a waiting trigger order's predicate holds at the live price, it is unexpired, not in the book, holds at least `minBountyUsd`, and was not left by a stale-price creation in the current block | `executeTriggeredOrders(execs, update)`, ≤ 20, highest bounty first, StopLimits with a `findPredecessor` hint |
| unload | either bucket holds inventory; re-checked on book changes, new prints, `recheckSeconds`, and the end of the 3-minute floor slide | `unloadVault(maxSteps, update)`, sent only if it sells something |
| adl | an ADL window is open; candidates on each side score at least the Dutch threshold (`1 + 25e18 × (D − t)² / D²`, D = 10 min) | `executeAdl(longBucketWinners, shortBucketWinners, update)`, top 25 per side |
| refresh | the refresh bounty's gates hold (the stored price advances; more than 5 min with ≥ $1,250 of inventory and > $5,000 free capital, else 1 day; > $1,000 free) — or, with health pokes, the probe shows the refresh would open an ADL window or fix the settlement price | `refreshPrice(update)` |
| terminalSettlement | the settlement price is fixed: other accounts' open positions; then, once open interest is zero or 14 days have passed, finalize | `liquidate(accounts, [])`, then `finalizeTermination()` |
| sweepExpired | resting orders past their expiry block, or finished orders still holding a bounty | `sweepExpired(orderIds)` |
| collect | a wallet's balance on a market reaches `thresholdUsd` | `claimFees()`, then optionally a USDC transfer to `forwardTo` |

Market state gates which jobs plan: live (all but ADL and settlement), ADL window open (liquidation,
ADL, refresh, collect: the pair halts matching), limbo (collect only), settling and terminated
(terminal settlement, collect).

## terminateScheduledPair

The call must carry archived Pyth prints that prove themselves. The keeper reads
`settlementRule(pair)` and fetches, per leg, the first print at or after each target from the
endpoint's historical route, checking that each print's `prevPublishTime` is before its target
(the "first at or after" condition) and that it is published no later than `latestPublishTs`:

- `SETTLE_WINDOW`: one print per leg at or after `firstTarget`.
- `SETTLE_CHAIN`: five samples, each target the previous sample's later leg plus 600 s.
- A claim-backed vote whose verdict nobody has recorded may settle under either rule, and the call
  records the verdict itself, so the keeper builds both sets, simulates each and sends the one the
  contract accepts. That also avoids recording an upheld verdict on its own, which would start its
  12 h grace before the print is in hand.
- Past `lastResortTs`, an empty call settles at the stored price.

## Testing

- **Unit tests** (`packages/*/test`, vitest): the formula ports against hand-worked cases, ABI encoding
  and log and error decoding, accumulator parsing and re-encoding, the store's event handling and
  snapshots, the config rules, the spend policy, keystores (cross-checked against eth-account in both
  directions), each job's planning, the engine's print and tick paths, the CLI, and every frontend
  module against a fake EIP-1193 transport (typed-data hashes against the documented type strings,
  packing, validation, fee and margin math against hand-worked Solidity cases, a message for every
  custom error).
- **End to end** (`packages/keeper/test/e2e`, `npm run test:e2e`): replays a recorded deployment of
  Bazaar's current contracts on a fresh Anvil (no compilation; `fixtures/README.md` says how the record
  is made), lists an ETH/USD market, builds a book, a stop-loss and a leveraged position, then runs the
  real keeper with every job enabled against the mock Hermes server, moving the price and the clock to
  give each job its work, and checks each outcome on chain (it also reports the keeper's latency from
  print to send). A second file drives the frontend SDK through the same scenario: permits, every
  order type, gasless relaying, previews compared with what the chain did, insurance exits, listings,
  and termination through UMA and insurer votes to finalization.

## Not built yet

- ADL has unit-tested formulas but no end-to-end scenario: opening a window needs the vault's
  exposure past its trigger, which takes a deliberately broken book to set up.
- Head and log updates are polled; WebSocket subscriptions would cut a little latency.
- Hardware wallets, a Prometheus endpoint and a local web dashboard.
- A router contract to bundle calls on several markets into one transaction (rewards accrue to
  `msg.sender`, so it would have to claim and forward them; new contract code to audit).
- Bidding for Arbitrum's Timeboost express lane.

## Open questions

1. **The shared price endpoint.** Its URL, how keepers authenticate, and whether Pyth's licence lets
   Bazaar hand signed updates to third-party keepers. `prices.endpoint: bazaar` errors until then.
2. **Network presets.** The official factory, its deployment block and the subgraph URL for each
   network, once deployed.
3. **Refresh-bounty constants** are internal to `RiskParamsLib`, so `constants.ts` copies them for
   scheduling (the probe still decides). A lens getter would remove the copy.
4. **Licensing of the formula ports.** They re-implement formulas from AGPL files (`BucketLib`,
   `AdlLib`, `BazaarMathLib`, `BazaarOracle`) in an MIT package; the copyright holder can do that, and
   should say so in the package's notice.
