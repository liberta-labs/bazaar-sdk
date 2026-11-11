# Live Updates

This page covers following the chain: `watchMarket` and `watchAccount`, which deliver a market's or
an account's contract events as they land, typed, with refreshed snapshots when something relevant
changed; every update they deliver; how they handle reorgs, errors and stopping; and the
`LogFollower` underneath, for following any contracts' logs.

The samples assume `bz` connected as in [Connecting](connecting.md), `user` an address and `eth` a
market.

## Watching a Market

```ts
{{#include ../../examples/reads/live-updates.ts:market}}
```

`bz.live.watchMarket(market, onUpdate, options?)` returns a handle at once and starts following: every
event the market's pair emits (and every terminator event about it) is delivered as it lands, and a
fresh [`MarketSnapshot`](markets.md#market-snapshots) at the head is delivered when events landed (at
most one per `minSnapshotMs`), every `refreshMs` without events (funding accrues and clocks run), and
on `refresh()`. A snapshot after a `Trade`, `OrderUpdated` or `OrderAmended` has `bookChanged: true`,
the cue to re-read the [book](markets.md#the-book).

## Watching an Account

```ts
{{#include ../../examples/reads/live-updates.ts:account}}
```

`bz.live.watchAccount(user, markets, onUpdate, options?)` follows one account on a set of markets. It
delivers the events that concern the account (its fills, orders, position, collateral, fees,
liquidation or deleverage, insurance, its meta-transactions and permits) and the market-wide ones that
change its standing (ADL, settlement, termination, and every terminator event about those markets),
and a fresh
[`AccountSnapshot`](accounts.md) for each market an event touched, all of them read in one pass. Every
market is refreshed every `refreshMs`, and all of them on `refresh()`.

An event concerns the account when one of its address arguments is the account (`maker` or `taker`
of a `Trade`, `owner` of an `OrderUpdated`, `user` of a `CollateralDeposited`, `liquidatedUser` or
`liquidator` of a `PositionLiquidated`, ...), and a `TriggerBountyEscrowed` when it is for one of the
account's orders.

Between snapshots, health can follow the live price with no read: pass each new price to
[`account.accountHealth`](accounts.md#following-the-price).

## The Handle

| Member | What it does |
|---|---|
| `ready` | Settles once the watch has started and delivered its first snapshots, or reported why it could not. Never rejects. |
| `refresh()` | Reads the head and refreshes every snapshot now (after the user's own transaction lands, say). |
| `stop()` | Ends the watch: nothing is delivered after it returns. |
| `stopped` | Whether it has stopped. |

```ts
{{#include ../../examples/reads/live-updates.ts:stop}}
```

A watch runs until stopped. In a component, stop it when the component unmounts or its market or
account changes; a watch that is never stopped keeps polling.

## Updates

`onUpdate` receives one object per update, told apart by `type`:

| `type` | `watchMarket` | `watchAccount` | Fields |
|---|---|---|---|
| `"event"` | yes | yes | `event`: a typed `LiveEvent` (below). |
| `"snapshot"` | yes | | `snapshot` (a `MarketSnapshot`), `cause`, `bookChanged`. |
| `"account"` | | yes | `snapshot` (an `AccountSnapshot`), `cause`. |
| `"head"` | yes | yes | `block`, `timestamp`: the follower read up to a new head. |
| `"reorg"` | yes | yes | `fromBlock`, `head`: the chain was reorganized and logs are read again from `fromBlock`. |
| `"error"` | yes | yes | `error`, `retryInMs`: a tick failed and is retried after `retryInMs`; `null` means the watch gave up. |
| `"undecodable"` | yes | yes | `log`, `error`: a log from a watched contract that could not be decoded; it is skipped. |

`cause` says why a snapshot was read: `"initial"` (the watch started), `"events"`, `"timer"` or
`"manual"` (`refresh()`). Updates for one tick arrive in chain order: the events, then the snapshots.
A listener that throws does not stop the watch.

### Events

A `LiveEvent` is a `PairEvent` (`source: "pair"`) or a `TerminatorEvent` (`source: "terminator"`).
Every event has `name`, `args`, `market` (the pair it concerns), `blockNumber`, `blockHash`, `txHash`
and `logIndex`. Narrow on `source` and `name` to get a pair event's typed `args`:

```ts
if (u.type === "event" && u.event.source === "pair" && u.event.name === "Trade") u.event.args.price;
```

Amounts are 18-decimal `bigint`s; timestamps, block numbers, sequence numbers and enum values are
`number`s. The pair's events:

| Group | Events |
|---|---|
| Trading | `Trade`, `OrderUpdated`, `OrderAmended`, `OrderAmendSkipped` |
| Positions and collateral | `PositionBucketUpdated`, `PositionModified`, `CollateralDeposited`, `CollateralWithdrawn` |
| Fees and bounties | `FeeAccrued`, `FeesClaimed`, `TriggerBountyEscrowed`, `TriggerBountyReleased` |
| Prices | `NewPriceUpdateAdded` |
| Liquidation and ADL | `PositionLiquidated`, `AdlTriggered`, `AdlTerminationArmed`, `AdlResolved`, `AdlExecuted`, `UserAdld` |
| Settlement and termination | `InsolvencySettlementFixed`, `PairTerminated`, `TerminalRatiosRefrozen` |
| Gasless calls | `MetaTransactionExecuted`, `PermitExecutionFailed` |
| Insurance | `InsuranceCredited`, `InsuranceDeposited`, `InsuranceWithdrawalRequested`, `InsuranceWithdrawalLocked`, `InsuranceWithdrawalExecuted`, `InsuranceShareEpochBumped` |
| Other | `Initialized` |

Their arguments are the pair's own, typed in `live.PairEventArgs`. A few need a note:

- `OrderUpdated.payload` is the order's stored state at the event. `payload.action` is 0 (created),
  1 (triggered) or 2 (canceled); `payload.cancelReason` is 0 None, 1 Owner, 2 Expired, 3 Unfilled,
  4 BelowMinimum, 5 PostOnly, 6 SelfMatch, 7 StepLimit, 8 Margin, 9 PriceBand, 10 PositionClosed,
  11 Liquidated, 12 Deleveraged. Its `triggerPrice` is the price alone: the bounty is not part of the
  stored order.
- `OrderAmendSkipped.reason` is 0 Inactive, 1 Expired, 2 SizeFilled, 3 BelowMinimum, 4 WouldCross.
- `InsolvencySettlementFixed.reason` is the vault-health verdict: 2 ADL timeout, 3 balance short,
  4 bad debt.
- `InsuranceWithdrawalExecuted.amount` is the payout in 18 decimals. The contract's ABI calls it
  `usdcAmount`, but it is not in USDC units, so the SDK renames it.

Terminator events (proposals, schedules, settlement prices, insurer votes) are delivered with their
decoded `args` untyped, for every pair the event names.

`live.decodeLiveLog(log, terminator?)` decodes one log the same way, and works on a receipt's logs
(see [Quick Start: a Bot](../getting-started/quick-start-bot.md#6-place-an-order-and-cancel-it) for
finding a new order's id). It returns `null` for a log that is neither a pair's nor the terminator's.

## Options

```ts
{{#include ../../examples/reads/live-updates.ts:options}}
```

| Option | Default | Meaning |
|---|---|---|
| `prices` | none | A [`LivePrices`](live-prices.md): the venue for the snapshots, and the price accounts are valued at. |
| `fetchPrices` | `true` | Without live prices, let snapshots ask the connection's Pyth Pro source (one request per snapshot for trading-hours markets, and for accounts). |
| `refreshMs` | 15,000 | Refresh snapshots at least this often without events. 0: on events only. |
| `minSnapshotMs` | 1,000 | The least time between two event-driven refreshes: events in between are folded into one. |
| `initial` | `true` | Deliver snapshots as soon as the watch starts. |
| `pollMs` | 1,000 | Milliseconds between head polls. With a subscription, a backup poll runs every 10 × this. |
| `subscribe` | `true` | Wake on `eth_subscribe("newHeads")` when the transport supports it. |
| `fromBlock` | the block after the head at start | The first block to deliver events from. |
| `reorgDepth` | 32 | Blocks re-read after a reorg. |
| `logChunk` | 2,000 | The most blocks one `eth_getLogs` asks for; halved while the node refuses a range. |
| `maxBlocksPerTick` | 10 × `logChunk` | The most blocks one tick reads. A head further ahead is first checked (the follower reads the block it would stop at) and then caught up with in steps of this size. |
| `maxBackoffMs` | 30,000 | The longest wait between retries after errors. |

With `fromBlock` in the past, a watch delivers the events since that block (in steps of
`maxBlocksPerTick`) before following the head: a page can replay the last few minutes this way. For
anything older, read [History](history.md).

## How It Works

One follower per watch reads every watched market and the terminator in one `eth_getLogs` per tick,
from a block cursor that advances only once a range has been read. Each tick:

1. reads the latest block;
2. checks it extends what was read before (its parent hash, or the last head's hash);
3. reads the logs from the cursor up to it, delivers them in chain order, and moves the cursor;
4. reads the snapshots that are due, at that block.

### Subscriptions and Polling

The follower polls the head every `pollMs`. When the transport emits EIP-1193 `"message"` events (it
has an `on` method) and accepts `eth_subscribe("newHeads")`, the follower ticks on each new head
instead, with a backup poll every 10 × `pollMs`. A browser wallet's provider may or may not offer
subscriptions; the SDK's `JsonRpc` (any URL connection) does not, so a server polls. Polling is the
default because it works everywhere, and one `eth_getLogs` a second covers every watched market.

### Reorgs

When a new head's parent is not the last head read, or the last head is no longer on the chain, the
follower rewinds its cursor up to `reorgDepth` blocks, reports a `"reorg"` update, and reads those
blocks again. Logs already delivered from blocks that survived are not delivered twice. Events from
blocks the reorg removed are not retracted: treat events as notifications and the snapshots as the
truth (the next snapshot is read on the new chain). A node behind a load balancer that answers with an
older head than the last one is treated as lagging, not as a reorg.

### Errors and Backoff

A failed tick (the RPC is down, a snapshot read failed, a range the node refuses even at one block)
is reported as an `"error"` update and retried after `pollMs × 2^failures`, capped at `maxBackoffMs`:
2 s, 4 s, 8 s, ... with the defaults. Nothing is lost: the cursor advances only once a range has been
read, and a market whose snapshot failed stays due and is read again on the next tick. A node that
refuses a wide `eth_getLogs` range gets half of it, down to one block. A head the node reports but
cannot serve (a bogus head number) is not followed until it can.

An `"error"` with `retryInMs: null` means the watch could not start (a market name that matches
nothing): it has stopped.

## LogFollower

```ts
{{#include ../../examples/reads/live-updates.ts:follower}}
```

`new live.LogFollower(chain, addresses, onLogs, onNotice, options?)` is the follower both watches use,
for following any contracts' logs:

| Argument | Meaning |
|---|---|
| `chain` | The connection's `Chain` (`bz.ctx.chain`). |
| `addresses` | A function returning the contracts to follow, called each tick (so the set can change). |
| `onLogs(logs, head)` | Each tick's new raw logs in chain order (possibly none), with the block they were read up to. A rejection is reported as an error and retried with backoff; the logs it was given are not delivered again. |
| `onNotice(notice)` | The `"head"`, `"reorg"` and `"error"` notices. |
| `options` | `pollMs`, `fromBlock`, `reorgDepth`, `logChunk`, `maxBlocksPerTick`, `subscribe`, `maxBackoffMs`, as above. |

`start()` subscribes if it can and runs the first tick, settling when it is done (it never rejects);
`tick()` reads now; `stop()` ends it; `cursor`, `subscribed` and `isStopped` report its state.

## What Can Go Wrong

| What | Why |
|---|---|
| `"error"` updates with growing `retryInMs` | The RPC is failing; the watch keeps retrying and catches up when it recovers. |
| `"error"` with `retryInMs: null` | A market could not be resolved (`getMarket` failed): the watch stopped. |
| `"error"`: `The node reports block N as its head, ... but cannot serve block M` | A node reported a head it does not have; the follower waits until it can serve it. |
| `"error"`: `could not read the state of market ...` | A snapshot read failed; it is retried on the next tick. |
| Events arrive but no snapshots | `refreshMs: 0` and `initial: false`, or `minSnapshotMs` is folding them; or the snapshot reads are failing (see the errors). |
| `"undecodable"` updates | A log from a watched contract did not match the SDK's ABI: an SDK older than the contracts. |

## Related Pages

- [Markets](markets.md), [Accounts & Portfolios](accounts.md)
- [Live Prices](live-prices.md)
- [History](history.md)
- [Building a Bot](bots.md)
