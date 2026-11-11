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
viem client, Pyth Pro client or GraphQL endpoint can stand behind them. Each area (markets, account,
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
factory → markets, legs,   Pyth Pro stream, one update   one signer + nonce
per-block state, candidate per pair, composite prices,   sequence per wallet
re-reads                   freshness
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

A planner judges a call at the price the pair will judge it at. A pair stores an update's price only
when it was generated in a later second than the price it holds (for a composite, when its older leg
was), so while a market's stored price is from the print's second or a later one, the planners judge
at the stored price: a candidate that crosses only at the print waits for the next second's print,
and one that crosses at the stored price is not missed. Such a call carries no update: the chain's
stored price never goes back, so the pair could never store the print, and attaching it would only
cost its fee and a revert once the print aged past the window. Without a fresh print, a liquidation on
a market with trading hours carries Pyth's latest update (`PriceService.liquidationUpdate`) and is
judged at its price, or at the stored price when that is strictly newer; failing that, on any market,
it runs without an update only on a stored price within the window less the send margin, and
otherwise waits, with the reason at debug level. A candidate the chain refuses waits `engine.simCooldownSeconds` before
it is simulated again; nothing else schedules a retry. Just before signing, the executor checks the
age of the price a call relies on (for a latest update, when it was issued) against the chain's time,
and does not send one older than the pair's 3 s window less `prices.sendMarginSeconds`: nothing
refused that candidate, so the next print or tick plans it again.

## The subgraph finds, the chain decides

The subgraph lags the chain and cannot see state that changes without an event: the funding index
between stored prices, the margin curve, the 24 h-lagged MMR, the live price. So it is only a
discovery source.

1. **Bootstrap.** Read `_meta`, then page through open positions and live or bounty-holding orders,
   every page pinned to that block, so the snapshot is consistent. With no subgraph, replay the
   factory's, the terminator's and every market's logs from `startBlock` instead. Left out (and not
   given by an official network preset), `startBlock` is the factory's deployment block, found by a
   binary search on `eth_getCode` at historical blocks: nothing of Bazaar's emits a log before the
   factory exists, and one request covers every address over a block range, so the scan's cost is set
   by its first block, not by when each pair was listed.
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

Prices come from Pyth Pro: signed updates fetched off chain and verified on chain by Pyth's verifier
contract, which stores nothing. `prices/lazer.ts` reads and builds the updates, `prices/pro.ts` is the
client, and `prices/service.ts` keeps the live state.

- **Signed bytes only.** Every price is parsed from the update's signed payload, with the same
  strictness as the oracle's own parser, never from the JSON an endpoint sends beside it. With a
  signer check installed (a context installs one that asks the deployment's verifier), an update
  whose signature does not recover to a trusted signer never becomes a print.
- **One subscription per pair.** The stream subscribes to each watched market's legs as one set (plus
  ETH/USD on its own, for pricing gas), so the signed update a call attaches carries exactly that
  pair's feeds, both legs of a composite in one, and costs one verification fee. The same
  subscriptions run on every stream endpoint, and each update is taken once, from whichever endpoint
  brings it first, and nothing counts as taken before its signer check passes. When the stream
  fails, the service polls `latest` in requests of at most 255 feeds (all one update carries), each
  market's legs in one.
- **Generation time, not update time.** A quiet feed's updates carry its last price forward under
  each new timestamp. A print's age is therefore when its price was generated (the feed update
  timestamp), which is what the pair judges; a newer update with the same price is not a newer print.
- **Freshness.** The pair accepts a price generated at most 3 s from the block's time whose confidence
  is within 2% (per leg, and on the composed price). A call carries an update only while its price is
  `sendMarginSeconds` younger than that, so it is still fresh when the transaction lands. Attaching
  an older one would revert the call, so a closed session market gets no fresh update; only the jobs
  that work without one proceed there, and liquidation through Pyth's latest price (below).
- **Liquidation reads Pyth's latest price.** A call without an update never liquidates on a stored
  price more than 3 s old. On a market with trading hours it reads an attached update as Pyth's latest price
  (`BazaarOracle.verifyAndFetchLatestPrice`): every update issued within 3 s of the block, each leg's
  price generated at most `MAX_LIQUIDATION_PRICE_AGE` (60 s) before it. An update carries each feed's
  most recent price as of when it was issued, so that proves no newer price existed; a closed venue's
  last price can decide a liquidation for a minute after it was generated, and then positions wait for
  the next price. `PriceService` keeps each market's most recently issued update alongside its
  freshest one (`latestFor`), and `liquidationUpdate(market)` says what a liquidation attaches: the
  fresh price's update, else Pyth's latest one when it was issued within the window less the send
  margin and its price at most `MAX_LATEST_PRICE_LAG` (57 s) before that, which keeps the price within
  the minute in any block the issue time admits, else nothing, with the reason. The call must land
  within 3 s of its `priceTime`, the latest update's issue second (for a fresh price, its generation
  second, so the call goes only while that price is fresh). `liquidationUpdateFor(ctx, pair)` reads the
  price source's latest update the same way, without a clock: on a market with trading hours its
  `priceTime` is that update's issue second whether the price is fresh or not, since the oracle judges
  every update a liquidation there carries by when it was issued, and it throws rather than return an
  empty update.
- **A live price needs four properties.** Price, exponent, a confidence above zero and a generation
  time. The oracle refuses an update without any of them, so a feed entry lacking one yields no print.
- **No price on chain but the pair's own.** An update a call carries is verified and must be fresh, or
  the call reverts; the pair then judges the call at it when it was generated in a later second than
  the price the pair holds, and at the price it holds otherwise. A liquidation on a market with
  trading hours is the exception, above: its update is read as Pyth's latest price, and it is judged at
  that price in the stored price's own second too. A call without one runs on the
  pair's stored price while that is at most 3 s old (at any age on a market with trading hours, where
  the call accepts that, which a liquidation never does). So the SDK's builders attach an update only
  when the oracle would accept it, and otherwise send none on a market with trading hours and refuse to
  build on a continuously traded one (`NoFreshPriceError`).
- **A Pyth Pro API key.** Pyth's own endpoints serve prices only to the holder of a Pyth Pro API key,
  so a `ProClient` for them without a token is refused when it is made (an `InputError` on
  `prices.token`); in a browser the token is a short-lived one the app's backend mints from the key.
  Without a token both the request API and every stream endpoint must be custom ones (a proxy that adds
  the key, a local mock), and the symbols registry needs none.
- **The keeper's client.** The keeper builds one `ProClient` from `prices` (the endpoint's three places,
  the token, the channel); `prices.endpoint` defaults to `pyth`, and config validation refuses Pyth's
  own endpoints without `prices.token` (a `ConfigError` naming it, which the keeper also raises in
  place of the client's `InputError` for a config that skipped validation). It streams on the `ws`
  package (Node has a global WebSocket only from 22),
  bounded so an endpoint cannot make it buffer more than the client reads: no compression, no
  redirects, a handshake timeout, and a frame announcing more than three times the SDK's
  `MAX_STREAM_MESSAGE` ends the connection unread. Once the deployment is read it installs the
  verifier's signer check unless `prices.checkSigners` is off (and then warns at start): the ETH/USD
  print that prices gas reaches no contract, so only that check vouches for it. Market labels come
  from the symbols registry, which needs no token. `terminateScheduledPair` runs the SDK's builder
  with the client's `atTick`.

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

The call must carry archived Pyth Pro updates from the one-second channel, which issues one update
per second, stamped on the second. `client/termination.ts` reads `settlementRule(pair)` and fetches
what the rule needs from the price source's `atTick`:

- `SETTLE_TICK` (UMA's rule): the update stamped at the cutoff, carrying every leg. The pair settles
  at the price it carries, whenever that price was generated.
- `SETTLE_CHAIN`: five samples, each the earliest second whose update carries a price generated at or
  after the sample's target, the next target 600 s past that second (the later leg's). The target's
  own update proves itself; a later second is proven together with the quiet second before it. That
  second is found by doubling the step from the target and bisecting, since a price's generation time
  never goes backwards from one second to the next.
- A claim-backed vote whose verdict nobody has recorded may settle under either rule, and the call
  records the verdict itself, so both sets are built, each is simulated, and the one the contract
  accepts is sent. That also avoids recording an upheld verdict on its own, which would start its
  12 h grace before the update is in hand.
- Past `lastResortTs`, an empty call settles at the stored price, for good. By default
  (`storedPrice: "whenAbsent"`) that call is offered only when every set failed because the archive
  holds no usable update and the archive is shown to work (it serves ETH/USD's one-second update from a
  minute before the chain's time): a timeout, a refusal, a wrong archive URL or a refused set may hide
  a proven price, and settling at the stored price cannot be undone. The plan then says why it is
  withheld; `"always"` offers it whenever no proven set is accepted, `"never"` never does.

Every set is first verified by calling the pair's oracle as the terminator does, so a set Pyth would
refuse is never offered as a proven settlement. The fee is the oracle's `getUpdateFee` of the number
of updates.

The keeper's `run terminate-scheduled` takes the policy as `--stored-price` and sends what its
preview showed or nothing: just before sending it builds the plan again and stops when the rule, the
settlement price or the call differs. A settlement at the stored price is sent only with
`--accept-stored-price`, after the preview has shown that price and how old it is; the library's
`keeper.run.terminateScheduledPair` asks for `acceptStoredPrice` the same way. The opportunity alert
names the rule a settlement is under, and calls a stored-price fallback what it is.

## Testing

- **Unit tests** (`packages/*/test`, vitest): the formula ports against hand-worked cases, ABI encoding
  and log and error decoding, Pyth Pro update parsing, encoding and signing, the price client against a
  fake request API and a fake WebSocket, the store's event handling and
  snapshots, the config rules, the spend policy, keystores (cross-checked against eth-account in both
  directions), each job's planning, the engine's print and tick paths, the CLI, and every frontend
  module against a fake EIP-1193 transport (typed-data hashes against the documented type strings,
  packing, validation, fee and margin math against hand-worked Solidity cases, a message for every
  custom error).
- **End to end** (`packages/keeper/test/e2e`, `npm run test:e2e`): replays a deployment of Bazaar's
  current contracts on a fresh Anvil (no compilation: `fixtures/build.mjs` computes it from a Bazaar
  build's artifacts), lists an ETH/USD market, builds a book, a stop-loss and a leveraged position,
  then runs the real keeper with every job enabled against the mock Pyth Pro server (its updates
  signed with the public test key the deployment's mock verifier trusts), moving the price and the clock to
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
   Bazaar hand signed updates to third-party keepers. Until then there is none: `PRICE_ENDPOINTS`
   holds only `pyth`, and a client for Pyth's endpoints needs the operator's own Pyth Pro API key.
2. **Network presets.** The official factory, its deployment block and the subgraph URL for each
   network, once deployed.
3. **Refresh-bounty constants** are internal to `RiskParamsLib`, so `constants.ts` copies them for
   scheduling (the probe still decides). A lens getter would remove the copy.
4. **Licensing of the formula ports.** They re-implement formulas from AGPL files (`BucketLib`,
   `AdlLib`, `BazaarMathLib`, `BazaarOracle`) in an MIT package; the copyright holder can do that, and
   should say so in the package's notice.
