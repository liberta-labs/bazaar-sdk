# The Jobs

This page describes each automatic job in depth: when it plans, what it calls, how it is paid, the
keys that change it, the market states it runs in, and its edge cases. [Configuration
Reference](configuration.md#jobs) lists every key with its type and default; [Budgets & Losing
Calls](budgets.md) explains the rule that decides whether a planned call is sent.

## How Jobs Run

Every `engine.tickSeconds` (0.5 s) the keeper reads the head, applies the new blocks' logs to its
index, re-reads the state of the markets those logs touched (and of the others every
`engine.idleRefreshSeconds`), and lets every enabled job plan. A plan returns calls; each one goes to
the executor on its own, which simulates it, prices it, applies the spend policy and sends it.

- **In-flight keys.** Each call carries keys (a position, an order, a market) and is not dispatched
  while any of them is already in flight, so the tick and the print path never send the same candidate
  twice. A send with no receipt after 90 seconds keeps its keys for 5 more minutes, in case it still
  lands.
- **Cooldowns.** A candidate the chain refused (a revert in simulation, or a call the policy skipped)
  waits before it is simulated again: `engine.simCooldownSeconds` for most jobs, longer for some (each
  job says below). Nothing brings it back sooner.
- **Pauses.** `safety.pauseAfterReverts` on-chain reverts in a row pause a job on a market for
  `safety.pauseMinutes`. Pauses are kept by market label, so markets sharing a label pause together.
- **Your own positions** are never liquidated or settled by your keeper.

### Market States

A market's state, read from the chain, gates which jobs plan on it:

| State | Meaning | Jobs that plan |
|---|---|---|
| live | trading normally | liquidation, triggers, unload, refresh, sweepExpired, collect |
| adl | an ADL window is open: matching halts | liquidation, adl, refresh, collect |
| limbo | from 6 s before a scheduled cutoff until the settlement price is fixed | collect |
| settling | the settlement price is fixed, not finalized | terminalSettlement, collect |
| terminated | finalized | terminalSettlement, collect |

A one-shot `bazaar keeper run` on a market in another state is skipped with `the market is settling;
this job runs while it is live`.

### Prices

A price-touching call judged at a fresh print carries that print's signed Pyth Pro update: the update
the market's own subscription delivers, which carries exactly those feeds (both legs of a composite in
one), so the call pays one verification fee. A call carries a print only while it is fresh enough to
send: its price generated within the pair's 3 s limit less `prices.sendMarginSeconds`, with confidence
within the pair's cap. The oracle's fee for the update is sent as the call's ETH value (and counts as
its cost).

Nothing on chain holds a price but the pair itself. An update a call carries is verified and must be
fresh: one that is stale or that Pyth's verifier refuses reverts the call, so the keeper never
attaches one it would not send. A call without an update runs on the pair's stored price while that
is at most 3 s old.

Planning, the simulation and the wallet's queue all take time, so the price a call relies on (the
print's, or the stored price it is judged at) is checked once more just before the call is signed,
against the chain's time: one older than the pair's 3 s limit less `prices.sendMarginSeconds` is not
sent. Nothing refused the candidate, so it does not cool down: the next print plans it again.

A market with trading hours gets no fresh print while its venue is closed: Pyth's updates keep
arriving, but they carry the last price forward, and a price is as old as when it was generated. So
only the jobs that work without a fresh print still act there: liquidation (judging by the stored
price), sweepExpired, terminal settlement and collect.

A print without a confidence is never attached. The oracle reads a zero confidence as a missing one
and reverts the call, so a market whose feed reports none is planned as one without a fresh print,
and no confidence is made up for it.

### The Price a Call Is Judged At

A pair stores the price a call carries only when that price was generated in a later second than the
price it holds (for a composite, when its older leg was). Otherwise it judges the call at the price it
holds: within one second, the first price stored stands.

The planners judge the same way. While a market's stored price is from the print's second or a later
one, liquidation, triggers and ADL judge at the stored price:

- a candidate that crosses only at the newer print is left for the next second's print, with no
  simulation and no cooldown spent on it;
- a candidate that crosses at the stored price is planned even though the print has moved back.

Such a call carries no update. The chain's stored price is at least as new as the one the keeper
read, and it never goes back, so the pair could never store that print: attaching it would only cost
its fee, and revert the call once the print aged past the pair's limit, where the call without it
still runs on the stored price. No refresh bounty is planned in that second, since the pair would
store nothing.

## Liquidation

**Plans** on every newer print for one of the market's legs, and on every tick. For each open position
in the index it computes equity at [the price the call would be judged at](#the-price-a-call-is-judged-at)
and the market's projected funding index, against
the effective maintenance rate (the lower of the market's MMR and its non-zero 24-hour-lagged MMR).
This runs on every position on every print and allocates nothing, so a print costs no RPC requests
until a position crosses.

**Re-reads** each crossing account's position bucket from the chain (alongside the update fee),
updates the index, and keeps the accounts still below their requirement. A bucket found empty is
dropped from the index.

**Calls** `liquidate(accounts, priceUpdate)`, every confirmed account in one batch of up to
`maxAccountsPerCall` (40), more batches for more accounts.

**Is paid** by the insurance fund: $0.05 per position seized, or max($0.05, 2 bp of the notional it
retires) for a seizure that nets the vault's two buckets, plus whatever 2 bp of the call's inline unload
exceeds that; an account worth less than $5 pays at most its own equity; capped at the fund's free
capital. Batching earns the same as splitting, for less gas. The probe measures the exact amount.

| Key | Effect |
|---|---|
| `maxAccountsPerCall` | accounts per call |
| `watchBufferPct` | only the `atRisk` count in `status.json` |
| `allowLoss`, `maxLossUsdPerCall`, `lossBudgetUsdPerDay` | liquidate even when gas costs more than the reward ([Budgets](budgets.md#3-losing-calls)) |

**Runs in** live and adl.

**Edge cases**

- **Closed sessions.** With no fresh print, a market with trading hours is judged at its stored price
  if that price is less than 9.5 minutes old (the pair accepts one up to 10 minutes old), and the call
  carries no update. Older than that, nothing is planned until the market reopens.
- A refused account cools for `engine.simCooldownSeconds` (2 s).

## Triggers

**Plans** on every newer print and on every tick. A candidate is a StopLimit, StopLoss or TakeProfit
order that the index knows, that is not finished and not resting in the book, is unexpired at the next
block, holds at least `minBountyUsd` of bounty (or none, with `includeUnbountied`), and whose trigger
the live price reached (inclusive at the trigger; stops fire on a rise for buys and a fall for sells,
take-profits the other way).

**Re-reads** each candidate's order record. It drops orders that are cancelled, filled, now in the
book or expired, and orders that rested in the current block: an execution in the block a stale-price
creation left the order waiting in pays the bounty to the owner, not to you.

**Calls** `executeTriggeredOrders(execs, priceUpdate)` with up to 20 orders, highest bounty first. Each
StopLimit gets a `findPredecessor` hint for where its limit rests once fired.

**Is paid** by the order's owner, through the bounty escrowed at creation: in proportion to the size
your call fills out of what remained, and the whole remainder once the order completes or rests.

| Key | Effect |
|---|---|
| `minBountyUsd` | the smallest bounty worth a candidate |
| `includeUnbountied` | also consider orders with no bounty (they pay nothing, so they send only with `allowLoss`) |

**Runs in** live. A stale price can neither arm a stop nor bound its fill, so a closed market gets no
trigger executions.

**Edge cases**: a refused batch cools for `engine.simCooldownSeconds`; a fired StopLimit the book could
not finish stays live and is worth its unpaid remainder.

## Unload

**Plans** on a market whose vault holds inventory in either bucket, at most every `recheckSeconds`
(15 s), and sooner when the logs show the book changed or a liquidation happened on that market.

**Calls** `unloadVault(maxSteps, priceUpdate)`, simulated first and **sent only if it sells something**
(`the book has nothing the vault may sell into at this price` otherwise).

**Is paid** by the insurance fund: 2 bp of what it sells, raised to a $0.25 floor when one call sells
$1,250 or more or clears the inventory.

| Key | Effect |
|---|---|
| `maxSteps` | the walk's step budget (1 to 32) |
| `recheckSeconds` | how often a quiet market is re-simulated |

**Runs in** live, with a fresh print (against a stale stored price the walk sells nothing and pays nothing).

**Edge case: the floor slide.** Bids within min(5%, MMR) of the oracle fill at once. A bid beyond that
edge but above the estates' bankruptcy price fills only once the vault's floor has slid down to it,
which takes up to 3 minutes from the bucket's seizure stamp. So while a bucket is inside its slide,
the job also re-checks one second after the slide completes, even if nothing else changed.

## ADL

**Plans** while the market's ADL window is open, on every tick, with a fresh print. It scores the
positions that would close: shorts against the vault's long bucket (while it holds inventory) and
longs against the short bucket (likewise), counting only positions in profit at the live price. Each
score is PnL over collateral less this window's tagged deposit (read from the chain), floored at 1.

**Keeps** candidates whose score is at least the auction's Dutch threshold, which falls quadratically
from 25 to 1 over the 10-minute auction: `1 + 25e18 × (D − t)² / D²` with D = 600 s and t the time
since the auction started.

**Calls** `executeAdl(longBucketWinners, shortBucketWinners, priceUpdate)` with the top
`maxWinnersPerSide` (25) of each list; the pair ranks and sorts each list itself at the price the call
stores, so a newer tick re-ranks but never reverts the batch.

**Is paid** by the insurance fund: 2 bp at the mark of every unit a batch closes, or 0.1% of the bad
debt that close averts where larger, plus 2 bp of the overlap the batch's netting retires; capped at
free capital.

| Key | Effect |
|---|---|
| `maxWinnersPerSide` | candidates per list (1 to 25) |

**Runs in** adl only. ADL refuses the stored price, so it needs a fresh print. A refused batch cools
for `engine.simCooldownSeconds`. Bazaar's [ADL](https://docs.bazaar.finance/protocol/adl.html) page
explains the auction.

## Refresh

**Plans** on every tick, with a fresh print, when the refresh bounty would pay. The bounty's gates
(`RiskParamsLib.payRefreshBounty`, copied into the SDK for scheduling; the probe still decides):

- the print's price was generated in a later second than the stored price;
- the stored price is older than **5 minutes** while the vault holds at least **$1,250** of inventory
  and the fund more than **$5,000** of free capital, or older than **1 day** otherwise;
- the fund's free capital exceeds **$1,000**.

**Calls** `refreshPrice(priceUpdate)`. **Is paid** $0.10 by the insurance fund.

**Why it matters beyond the bounty.** A pair whose stored price is more than 21 days old can be ended
by anyone at that price ([`terminate-stale`](manual-operations.md#terminatestalepair)), and one refresh
with a fresh update restarts the count. On a quiet market this job is what keeps a pair on a live feed
out of reach. Where no bounty pays (a fund with $1,000 or less of free capital) the job plans nothing;
`bazaar keeper run refresh-price --market … --force` sends one refresh regardless of the profit rule.

**Health pokes.** A refresh also judges the vault's health: on a book too thin to trade, it is what
opens an ADL window (and starts its 24-hour clock) once inherited inventory drifts past the trigger,
and what ends a timed-out window by fixing the settlement price. Those refreshes may pay nothing. With
`healthPokes: true`, on a market holding inventory, every `healthPokeIntervalSeconds` (60 s) the job
simulates an unpaid refresh and sends it only if the probe shows it would open the ADL window (it was
not pending before) or fix the settlement price. Turning health pokes on is consent to pay for them:
each within `healthPokeMaxCostUsd` (0.10) and the job's `lossBudgetUsdPerDay`, and the global
`budget.maxLossUsdPerDay`. Otherwise it is skipped with `the refresh would not change the vault's
health state`.

| Key | Effect |
|---|---|
| `healthPokes` | send unpaid refreshes that change the vault's health state |
| `healthPokeIntervalSeconds` | how often each market is checked for one |
| `healthPokeMaxCostUsd` | the most one may cost |

**Runs in** live and adl. A refused refresh cools for 10 s.

## Terminal Settlement

**Plans** on every tick on a market whose settlement price is fixed (settling or terminated).

1. **Settle.** Every open position in the index, except your own wallets' (their owner settles them by
   withdrawing), is re-read from the chain; the ones still open are settled with `liquidate(accounts,
   [])`, which in settlement mode needs no price update and carries no ETH. One batch of up to
   `maxAccountsPerCall` (100) per tick; the next tick takes the rest.
2. **Finalize.** With `finalize: true` (the default), once nothing is left to settle and the market is
   not yet terminated, and either both sides' open interest is zero or 14 days have passed since the
   settlement price was fixed (the escape hatch), it calls `finalizeTermination()`.

**Is paid** $0.05 per position settled for someone else, from the position's remaining collateral; the
insurance fund tops up only positions worth at least $5 at the settlement price, so a smaller one pays
what its collateral covers. Settling is a paid call under the profit rule. **Finalize pays nothing**:
`finalize: true` is consent to pay for it, within `finalizeMaxCostUsd` (0.50), the job's
`lossBudgetUsdPerDay` and `budget.maxLossUsdPerDay`. It is background work, so it also waits while the
base fee is above `gas.backgroundMaxFeeGwei`.

| Key | Effect |
|---|---|
| `finalize` | finalize once settled (or past the escape) |
| `finalizeMaxCostUsd` | the most one finalize may cost |
| `maxAccountsPerCall` | positions per settlement call |

**Runs in** settling and terminated. A refused call cools for 30 s. Finalizing releases everyone's
payout; Bazaar's [Termination](https://docs.bazaar.finance/protocol/termination.html) page explains the
sequence. Terminating a market in the first place is a [manual operation](manual-operations.md).

## Sweep Expired

**Plans** on every tick on live markets, from the index:

- **expired orders**: Limit and StopLimit orders, not finished, whose expiry block has passed;
- **refunds** (with `includeBountyRefunds`): finished orders still holding a bounty, which the sweep
  returns to their owner.

It sends when there is any refund, or when expired orders number at least `minBatch` (10). It
re-reads the orders first, drops what changed, and sweeps up to `maxOrdersPerCall` (100) with
`sweepExpired(orderIds)`.

**Pays nothing**: it is a public service that keeps books short and returns stranded bounties. So the
job ships with `allowLoss: true` and a $0.25 `lossBudgetUsdPerDay`, each call within
`maxLossUsdPerCall` (0.05), and it is background work under `gas.backgroundMaxFeeGwei`. It runs only if
you enable it (`init` leaves it unchecked).

| Key | Effect |
|---|---|
| `minBatch` | expired orders to wait for |
| `maxOrdersPerCall` | orders per call |
| `includeBountyRefunds` | also sweep finished orders holding a bounty |
| `lossBudgetUsdPerDay`, `maxLossUsdPerCall` | what the service may cost |

**Runs in** live. A sweep that was not sent waits 5 minutes before the next.

## Collect

Bounties accrue to each wallet's claimable balance on the market that paid them. `collect` claims
them.

**Plans** every `intervalSeconds` (600 s), and 5 seconds after the logs show one of your wallets'
claimable balances changed. It reads every wallet's claimable balances across the markets and plans a
`claimFees()` on each market in its scope where a wallet holds a balance, sent from the wallet that
holds it.

**Decides by its own rule**, not the profit rule (claiming earns nothing new):

- a balance of at least `thresholdUsd` (5) that covers the claim's gas × `gasSafetyMultiplier` is
  claimed;
- a balance first seen more than `maxAgeDays` (7) ago is claimed whenever it covers its gas, however
  small. The age counts from when this process first saw the balance, so a restart starts it again;
- on a clean stop with `onShutdown: true` (the default), every balance that covers its gas is claimed.

Claims are simulated from the wallet itself (claimFees pays `msg.sender`), so a watch-only keeper
cannot collect. Except on shutdown they are background work under `gas.backgroundMaxFeeGwei`.

**Forwarding.** With `forwardTo` set, each wallet whose **USDC balance** reaches `forwardMinUsd` (50)
transfers its whole USDC balance to that address. Note that this moves any USDC in the wallet, not
only claimed bounties. Forwarding is background work, recorded in the ledger as job `forward`, and
fits the spend caps like any call.

| Key | Effect |
|---|---|
| `thresholdUsd` | the balance worth a claim |
| `maxAgeDays` | claim older balances regardless of size |
| `forwardTo`, `forwardMinUsd` | move USDC to another address |
| `onShutdown` | claim everything on a clean stop |
| `intervalSeconds` | how often balances are read |
| `markets`, `exclude` | which markets' balances are claimed |
| `gasSafetyMultiplier` | the cover the threshold rule asks for |

**Runs in** every state: claiming works on a terminated market too.

## Related Pages

- [Budgets & Losing Calls](budgets.md): what decides whether a planned call is sent.
- [Manual Operations](manual-operations.md): one-shot runs of each job, and the operations no job runs.
- [Configuration Reference](configuration.md#jobs): every job key.
