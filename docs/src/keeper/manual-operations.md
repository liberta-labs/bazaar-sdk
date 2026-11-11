# Manual Operations

`bazaar keeper run <operation>` runs one operation now, on a market you name. It covers two kinds of
operation:

- **the automatic jobs, once**: the same planning, simulation and spend policy the running keeper
  uses, on one market, when you want to act without waiting (or to see what the keeper would do);
- **manual operations**: calls no job makes on its own because they end markets or settle
  governance, pay nothing, and should happen only when someone decides they should. The keeper builds
  and checks them; you send them.

`bazaar keeper opportunities` tells you when a manual operation is available. The same calls are
`keeper.run.*` in the library ([The Keeper as a Library](library.md#one-shot-runs)).

## How a Run Works

1. The config is loaded and the wallets are unlocked (a keystore without a stored password is asked
   for).
2. The keeper connects: it checks the chain and the factory's wiring, loads the snapshot in the state
   directory (or, with none, builds the index as a first start does), and replays the blocks since.
3. The market is resolved. `--market` takes a label (`ETH/USD`), a description, an address or a pair
   id. A label several markets carry is refused (`'ETH/USD' matches several markets (0x…, 0x…); use
   an address`); `bazaar keeper markets` shows the addresses.
4. The market's state is read and fresh prints are fetched for its legs.
5. The call is planned, simulated, priced and judged; then sent, or (for a manual operation) shown
   and confirmed first.

Nothing that reverts in simulation is ever sent, and the daily spend caps, the low-balance halt and
the fee ceilings apply to every run ([Budgets & Losing Calls](budgets.md)).

A one-shot run is a separate process from a running keeper. If it signs with a wallet the running
keeper also uses, their nonces can collide: the run re-reads the nonce and retries once, so an
occasional run works, but prefer running manual operations when the keeper is idle, or from a wallet
of their own (they use `default`, see below).

## Options

| Option | Effect |
|---|---|
| `--dry-run` | simulate and report, send nothing |
| `--force` | automatic operations only: send even when the profit and loss rules would skip it. Keeps everything else: the simulation, the spend caps, the fee ceilings, the low-balance halt ([What `--force` skips and keeps](budgets.md#what---force-skips-and-keeps)) |
| `-y, --yes` | manual operations only: send without asking |
| `--stored-price <policy>` | `terminate-scheduled` only: when a settlement at the market's stored price is planned once its last resort is open, `whenAbsent` (default), `always` or `never` ([The Last Resort](#the-last-resort)) |
| `--accept-stored-price` | `terminate-scheduled` only: send a settlement at the stored price. Without it such a plan is shown and not sent, `--yes` or not |

## The Automatic Operations

| Operation | Job | With no list | With a list |
|---|---|---|---|
| `liquidate --market M [--accounts a,b]` | liquidation | every account below its requirement at the live price | exactly those accounts, in one call |
| `execute-triggers --market M [--orders 1,2]` | triggers | every order ready to fire | exactly those orders (each StopLimit gets its hint) |
| `unload --market M` | unload | the vault's inventory, if the book takes some | |
| `execute-adl --market M` | adl | the planner's winners for each side | (in the library: `longBucketWinners`, `shortBucketWinners`) |
| `refresh-price --market M` | refresh | a refresh, judged by the profit rule (it pays $0.10 only when the bounty is due) | |
| `collect [--market M1,M2]` | collect | every market where a wallet holds a balance | those markets |
| `settle-terminal --market M [--accounts a,b]` | terminalSettlement | every open position but your own (one batch) | exactly those accounts |
| `sweep-expired --market M [--orders 1,2]` | sweepExpired | every expired order and every finished one holding a bounty | exactly those orders |

Each uses the job's settings from the config, or the job's defaults when the config leaves the job
off, sending from the job's wallet (or, for a job not configured, `default` or the first wallet). The
job's market states apply: on a market in another state the run is skipped with `the market is
settling; this job runs while it is live`. Planning finds nothing: `skipped … no position is below its
maintenance margin`.

With an explicit list the planner's filters are skipped (the chain still decides in simulation), so
`--accounts` can name an account the index does not know about. The price is the job's: `liquidate
--accounts` on a closed market carries Pyth's latest update, as the job does
([Liquidation](jobs.md#liquidation)). When no price can decide a liquidation (that update's price more
than a minute old, say), `liquidate` is skipped with the reason and nothing is simulated: `no price can
decide a liquidation now (…): positions wait for the market's next price` (without `--accounts`, on a
market that holds positions). `execute-triggers --orders` and `execute-adl` need a fresh print.

For `collect`, `--force` means "claim every balance that covers its gas, as on shutdown" rather than
skipping the rules.

```bash
bazaar keeper run liquidate --market ETH/USD --dry-run
bazaar keeper run execute-triggers --market 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0 --orders 1042,1043
bazaar keeper run sweep-expired --market BTC/USD --force
bazaar keeper run collect --market ETH/USD,BTC/USD
```

## The Manual Operations

Manual operations pay the caller nothing. They are sent from the wallet named `default`, or the first
wallet configured when there is none by that name, as forced calls: no profit rule, but the spend
caps, the fee ceilings and the low-balance halt apply. Each run first simulates (`simulated`, with
what it would cost), then asks `Send it?` (default no), or sends at once with `--yes`. Without a
terminal and without `--yes`, it prints `Not sent: pass --yes to send without confirming.` A preview
that would revert or cannot be sent is printed and nothing is asked.

| Operation | Calls | Available when |
|---|---|---|
| `finalize --market M` | the pair's `finalizeTermination()` | the settlement price is fixed and either every position is settled (both sides' open interest zero) or 14 days have passed since the fix |
| `terminate-stale --market M` | the terminator's `terminateStalePair(pair)` | the market's stored price is more than 21 days old (a dead oracle) |
| `terminate-scheduled --market M` | the terminator's `terminateScheduledPair(pair, priceUpdate)` | the market's scheduled cutoff has passed: see [below](#terminate-scheduled) |
| `settle-termination --assertion A` | the terminator's `settleTerminationProposal(assertionId)` | a UMA termination claim's liveness has ended |
| `execute-insurer-termination --market M --proposal P` | the terminator's `executeInsurerTermination(pair, proposalId)` | an insurer vote on the market can be resolved |
| `settle-listing --assertion A` | the factory's `settleDeploymentProposal(assertionId)` | a listing proposal's liveness has ended |
| `expire-listing --pair-id P` | the factory's `expireStuckDeploymentProposal(pairId)` | a listing cannot settle |
| `settle-identifier-upgrade --assertion A` | the factory's `settleIdentifierUpgradeProposal(assertionId)` | an identifier upgrade is pending |
| `expire-identifier-upgrade` | the factory's `expireStuckIdentifierUpgradeProposal()` | the pending upgrade cannot settle |
| `activate-identifier-upgrade` | the factory's `activateIdentifierUpgrade()` | an approved upgrade is queued and its delay has passed |

The contracts decide each condition; the simulation shows their answer. A call made too early comes
back with when it opens (`opens at 2026-11-09 14:30:00 UTC`) where the revert says so. Bazaar's
[Termination](https://docs.bazaar.finance/protocol/termination.html) and
[Listing](https://docs.bazaar.finance/protocol/listing.html) pages explain what each call does to the
market.

`finalize` shares its in-flight key with the terminal-settlement job, so a run and a running keeper in
the same process never finalize twice.

```text
$ bazaar keeper run terminate-stale --market 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
simulated  terminateStalePair  GME/USD  end GME/USD (dead oracle)
   sent on request (profit and loss rules skipped)
   would earn $0.0000 for about $0.0042 of gas
? Send it? (y/N)
```

## Terminate Scheduled

A market with a scheduled cutoff (from a UMA claim upheld or an insurer vote) is ended by
`terminateScheduledPair`, which must carry archived Pyth Pro updates that prove the settlement price.
All of them come from Pyth's one-second channel (`fixed_rate@1000ms`), which issues one update per
second, stamped on the second; the keeper asks the price endpoint's request API (`POST /v1/price`)
for the update stamped on each second it needs, so the token must cover that channel. The keeper
builds the call with the SDK's `termination.terminateScheduledPair`, which reads
`settlementRule(pair)` from the terminator and fetches what the rule needs:

| Rule | Updates |
|---|---|
| nothing (`SETTLE_NOTHING`) | none: the market has no scheduled cutoff, or its price is already fixed. Skipped |
| UMA's rule (`SETTLE_TICK`) | the update stamped at the cutoff, carrying every leg (one update with both legs of a composite, or one per leg). The pair settles at the price it carries, whenever that price was generated: a feed that was quiet at the cutoff settles at its last price |
| the chain rule (`SETTLE_CHAIN`) | five samples chained from the cutoff, each the earliest second whose update carries a price generated at or after its target (with the quiet second before it when that is not the target itself), the next target 600 s past the sample's second (the later leg's), every one no later than the rule's latest publish time |
| awaiting a verdict (`SETTLE_AWAIT_VERDICT`), or an insurer vote backed by a UMA claim whose verdict nobody recorded | the call records the verdict itself, so the builder previews how UMA ruled and builds that rule's set; when the verdict cannot be previewed it builds both sets and the contract's simulation says which applies |

Before offering a set, the builder has the pair's own oracle verify it exactly as the terminator will
(`fetchPriceAtTick` for UMA's rule, `fetchChainedMedian` for the chain rule, the same arguments, the
update fee as value, from the sending wallet), and the summary names the price that call returns:

```text
simulated  terminateScheduledPair  TSLA/USD  terminate TSLA/USD at its cutoff under the chain rule (the median of five chained prices), settling at 251.37
   sent on request (profit and loss rules skipped)
   would earn $0.0000 for about $0.0088 of gas
```

This matters because past the grace or the last resort the terminator catches a refused set and
settles at the stored price instead, so simulating `terminateScheduledPair` alone would pass either way
and label a stored-price settlement as a proven one. The keeper never sends a set the oracle refused
as a proven settlement; the result's reason says why, for example `under the chain rule (the median of
five chained prices): The oracle would not verify these updates (…). The stored-price fallback is
open, so a call carrying them would settle at the market's stored price (250.1) instead: they are not
offered as a proven settlement.`

When nothing can be sent yet, the run is skipped with the reasons, such as `Under UMA's rule (the
one-second update stamped at the cutoff): Pyth's archive has no one-second update for feed … at
second … yet. The stored-price fallback opens after …`. A feed that carries no price at the cutoff
(one listed after it, say) builds no chain: the market waits for its last resort like any other that
cannot be proven. A run before the cutoff, or on a market without one, is skipped with the
terminator's own reason.

### The Last Resort

Past `lastResortTs`, a call with no updates settles at the stored price: for good, at a price no Pyth
update proves. The keeper plans that call as `--stored-price` allows:

| `--stored-price` | The call at the stored price is planned |
|---|---|
| `whenAbsent` (default) | only when every set failed because Pyth's archive holds no usable update for it, and the archive is shown to work (it serves ETH/USD's one-second update from a minute before the chain's time). A timeout, a refusal, a wrong archive URL or a set the oracle refused may hide a proven price, so none of them leads to the stored price |
| `always` | whenever no verified set goes through |
| `never` | never |

Withheld, the run is skipped with why and what would change it: `… The stored-price fallback is open
but not offered: a proven settlement may still exist (…): try again later, or run with --stored-price
always to settle at the stored price anyway.` Planned, the preview says what it fixes, and the call is
sent only with `--accept-stored-price` (and then `--yes`, or a yes at the prompt):

```text
$ bazaar keeper run terminate-scheduled --market TSLA/USD --yes
simulated  terminateScheduledPair  TSLA/USD  terminate TSLA/USD at its cutoff at its stored price, 250.1 (the last resort is open)
   sent on request (profit and loss rules skipped); this settles the market irreversibly at its stored price, 250.1, stored 22 d 0 h ago (2026-10-18 14:30:00 UTC): no Pyth update proves it; under UMA's rule (…): …
   would earn $0.0000 for about $0.0061 of gas
Not sent: this settles the market at its stored price, which no Pyth update proves. Pass --accept-stored-price to send it.
```

In the library, `keeper.run.terminateScheduledPair` takes `storedPrice` and sends such a call only with
`acceptStoredPrice: true`.

### What Is Sent Is What Was Shown

The run previews the call, asks, and then builds the plan again just before sending: when the rule,
the settlement price or the call differs from the preview's (an archive that answered for the preview
and not since, a verdict recorded in between), nothing is sent: `the settlement changed since the
preview (…): nothing was sent; run the command again`.

## Opportunities

```bash
bazaar keeper opportunities
```

Dry-runs every manual operation that might be due and lists the ones that would go through now
(`ready now`), or that a "too early" revert shows will open later (`opens at …`), each with the
command that runs it. Commands name markets by address, and only ids checked to be ids go into them.

| Looks at | Operation |
|---|---|
| every market past its scheduled cutoff, price not fixed | `terminateScheduledPair` |
| every market with a fixed price, not terminated, with zero open interest or past the 14-day escape | `finalizeTermination` |
| every market whose stored price is more than 21 days old | `terminateStalePair` |
| with a subgraph: termination claims past their liveness | `settleTerminationProposal` |
| with a subgraph: insurer votes | `executeInsurerTermination` |
| with a subgraph: listing proposals past their liveness | `settleDeploymentProposal`, `expireStuckDeploymentProposal` |
| the factory's pending identifier upgrade | `settleIdentifierUpgradeProposal`, `expireStuckIdentifierUpgradeProposal` |
| the factory's queued identifier upgrade | `activateIdentifierUpgrade` |

Without a subgraph, claims, votes and listings are not found (their ids are not in the keeper's
index); the market and factory checks still run.

A running keeper scans the same way every 5 minutes and sends each finding as an `opportunity` alert
(at most once a day each), when an alert channel is configured and `opportunity` is in
`alerts.notify` ([Running in Production](production.md#alerts)).

## Related Pages

- [Commands](commands.md#keeper-run): every `run` option.
- [Budgets & Losing Calls](budgets.md): what applies to forced calls.
- [Termination & Settlement](../sdk/termination.md): building the governance calls that schedule a
  termination.
