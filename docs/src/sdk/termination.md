# Termination & Settlement

Every Bazaar market can be wound down without anyone's permission: when its feed is decommissioned,
its asset is delisted, or its price series breaks. This page covers the SDK side of that: reading
where a market stands, proposing termination through UMA or an insurer vote, fixing the settlement
price (including fetching and proving the archived Pyth Pro updates it needs), settling positions,
finalizing, and withdrawing what a terminated market pays.

Use it for a market-status banner, a "propose termination" or "vote" screen for insurers, a
withdrawal screen on an ended market, or a bot that settles markets for their tips. The rules
themselves (why the cutoff must be 12 hours out, how the chain rule picks its five prices, the
settlement waterfall) are in Bazaar's
[Termination & Settlement](https://docs.bazaar.finance/protocol/termination.html) page; this page
links to it rather than repeating it.

Everything here is on `bz.termination` (with `bz` connected as in [Connecting](connecting.md)). The
`termination` namespace export has the same functions with a context first, plus the pure helpers
and constants (`reasonProblem`, `TerminationCategory`, `insurerProposalId`, ...).

## How a Market Ends

There are four ways in, and every one of them goes through the same two stages.

| Path | Who starts it | SDK |
|---|---|---|
| UMA claim | Anyone, with a USDC bond (at least 1,000 USDC) and a 12-hour UMA liveness | `proposeTermination`, `settleTerminationProposal` |
| Insurer vote | Insurers whose matured shares reach 60% of the vote's snapshot | `proposeInsurerTermination`, `voteForInsurerTermination`, `executeInsurerTermination` |
| Stale oracle | Anyone, once the market has stored no price for 21 days | `terminateStalePair` |
| Autonomous | The pair's own insolvency checks | nothing to call |

1. **The cutoff.** A UMA claim or an insurer vote schedules a cutoff. Trading, deposits and
   withdrawals stop 6 seconds before it (`LIMBO_LEAD`): the market is in **limbo**.
2. **Fixing the price.** After the cutoff, anyone calls `terminateScheduledPair` with the archived
   Pyth Pro updates that prove the settlement price (the stale-oracle path fixes it directly at the
   last stored price). This opens the **settlement window**.
3. **Settling.** In the window every open position is settled at the fixed price (`liquidate` on
   the pair, permissionless, tipped $0.05 per position settled for someone else).
4. **Finalizing.** Once every position is settled, or 14 days after the fix, anyone calls
   `finalizeTermination`. The payout ratios freeze and withdrawals open for good.

## Costed Calls

Every builder on this page returns a `CostedCall` (except `terminateScheduledPair`, which returns a
plan holding one). A `CostedCall` is a [`PreparedCall`](sending.md) (simulate it and send it as one)
with four more fields:

| Field | Meaning |
|---|---|
| `costs` | Every bond, fee, levy and share lock the call takes or puts at risk, each a `Cost`. Empty for a call that costs only gas. |
| `approvals` | ERC-20 approvals to send first, as `PreparedCall`s, each for **exactly** the amount (never unlimited). Empty when the allowance already covers it. The SDK never assumes an approval exists. |
| `requires` | Preconditions in words for the UI to show: an allowance to send first, a balance short of the bond, a cap the contract enforces. |
| `notes` | What will happen, in plain language, and warnings. |

A `Cost`:

| Field | Meaning |
|---|---|
| `kind` | `"bond"`, `"seed"`, `"fee"`, `"levy"` or `"lock"`. |
| `label` | What it is, in a trader's words ("UMA termination bond"). |
| `amount` | In `unit`'s own precision: USDC with 6 decimals, ETH in wei, shares with 18 decimals, `"token"` in the token's units. |
| `unit` | `"USDC"`, `"ETH"`, `"shares"` or `"token"` (an ERC-20 other than USDC; see `token` and `decimals`). |
| `token` | The ERC-20 it is paid in; `null` for ETH and shares. |
| `decimals` | For `"token"`: the token's decimals. |
| `payee` | Who takes or holds it (the contract pulling a bond, the oracle), or `null` when nothing moves now. |
| `returned` | When and how it comes back, if ever. |
| `contingent` | `true` for a worst case that depends on what happens later (a levy that depends on a verdict). |

Note the units: a bond's `amount` is in USDC's 6 decimals, while the call's `pullsUsdc` is the same
bond in 18 decimals, like every other `pullsUsdc`. Format costs with `uma.usdcText`,
`uma.ethText` and `uma.sharesText`, which print the exact amount.

A helper that shows a costed call, sends its approvals, simulates it and sends it:

```ts
{{#include ../../examples/protocol/termination-propose.ts:costed}}
```

Simulate after the approvals have landed: the call pulls the bond with `transferFrom` and reverts
until the allowance is there. When the wallet already allows the spender **more** than the bond, no
approval is returned, and a note warns that the contract takes what it charges when the call runs, up
to that allowance; to cap it at the quote, approve exactly the bond first.

A bond quote read from the chain that is below the contract's own floor (an RPC answering 0, for
example) cannot be right: the builder throws `uma.BondQuoteError` and builds nothing, since an
approval sized to it would be wrong.

## Reading Where a Market Stands

```ts
{{#include ../../examples/protocol/termination-settle.ts:status}}
```

`terminationStatus(pair, search?)` answers in one call. `phase` is:

| Phase | Meaning |
|---|---|
| `live` | No cutoff scheduled. |
| `scheduled` | A cutoff is scheduled; trading continues until 6 seconds before it. |
| `limbo` | Within 6 seconds of the cutoff, or past it, with no settlement price yet: nothing trades, deposits or withdraws until `terminateScheduledPair` fixes the price. |
| `settling` | The settlement price is fixed; positions settle at it until `finalizeTermination`. |
| `terminated` | Finalized: withdrawals pay at the frozen ratios. |

| Field | Meaning |
|---|---|
| `now` | The chain time the status was judged at. |
| `scheduledTerminationTs`, `haltsAt`, `cutoffPassed` | The cutoff, when trading halts (the cutoff less 6 s), and whether it has passed. |
| `settlementPriceFixedTs`, `settlementPrice` | When the price was fixed and the price (18 decimals), or `null`. |
| `isPairTerminated` | Finalized. |
| `settlementRule` | How `terminateScheduledPair` would settle now (see [below](#at-a-scheduled-cutoff)). |
| `acceptedTerminationAssertionId` | The accepted UMA claim whose cutoff is in force, or `null`. |
| `umaCutoffCap` | While an insurer vote holds the schedule: the UMA cutoff that caps its settlement samples, or `null`. |
| `insurerScheduled`, `insurerScheduleId` | Whether an insurer vote set the cutoff, and which. |
| `openInterest` | `{ long, short }`: finalize waits for both to reach zero, or for the 14-day escape hatch. |
| `finalizeOpensAt` | When `finalizeTermination` can be called: now once every position is settled, else 14 days after the fix; `null` before the fix and after finalize. |
| `openProposals` | Unresolved UMA claims and insurer votes on the market. |

The terminator keeps no list of proposals, so `openProposals` (also callable on its own as
`openProposals(pair, search?)`) finds their ids, then reads each one on chain, so the answer reflects
the chain rather than the index. Its `source` says where the ids came from:

| `source` | When |
|---|---|
| `"subgraph"` | The connection has a subgraph: every page of pending and disputed claims and open votes, each id checked (32 bytes, strictly ascending, at most `MAX_OPEN_PROPOSALS` = 1,000 of each kind). An answer that breaks any of these throws `SubgraphError` rather than being half-used. |
| `"logs"` | No subgraph, and `search.fromBlock` is given: one `eth_getLogs` over the terminator from `fromBlock` to `search.toBlock` (default: the latest block). |
| `"ids"` | Only `search.ids` were given. Ids you pass are always read, whatever else runs. |
| `"none"` | Nothing to search: both lists are empty. |

Other reads:

| Function | Returns |
|---|---|
| `settlementRule(pair)` | The terminator's `settlementRule`, decoded (fields below). |
| `terminationProposal(assertionId)` | A UMA claim: `pair`, `proposer`, `lastTradingTs` (its cutoff), `reason`, `proposalTs`, `livenessEndsAt`, `resolved`, `category`, `categoryName`; or `null`. |
| `insurerProposal(id)` | An insurer vote (see [Reading Votes](#reading-votes)), or `null`. |
| `requiredTerminationBond()` | The bond a UMA claim posts now, USDC units: the larger of 1,000 USDC and UMA's minimum. |
| `terminatorConstants()` | The terminator's constants read from the chain: category, outcome, verdict and rule numbers, the bond floor and the live bond, the liveness, the reason length, the sample count and spacing. |

A market snapshot also carries the termination stamps (`marketSnapshot(...).termination`: the cutoff,
the fixed price, the ratios, the bad debt) and a `status`; see [Markets](markets.md).

## Ending a Market Through UMA

### Proposing

```ts
{{#include ../../examples/protocol/termination-propose.ts:reason}}
```

```ts
{{#include ../../examples/protocol/termination-propose.ts:propose}}
```

`proposeTermination(args)` posts a claim to UMA's Optimistic Oracle that the market should end.

| Argument | Meaning |
|---|---|
| `pair` | The market. |
| `category` | One of the four grounds, 1 to 4 (`termination.TerminationCategory`). |
| `lastTradingTs` | The proposed cutoff, unix seconds. |
| `reason` | The grounds and evidence, 1 to 1,000 characters of a restricted charset. |
| `from` | The proposer, who posts the bond. |
| `slackSeconds` | How long the transaction may take to land: the 2-hour minimum is checked this far ahead. Default 60. |

The categories (`termination.TERMINATION_CATEGORY_INFO` has a name and a description of each, for a
picker):

| Value | Name | Grounds |
|---|---|---|
| 1 `OracleDecommission` | Oracle decommission | The market's Pyth Pro feed (either leg of a composite) has stopped or is scheduled to stop publishing. |
| 2 `AssetCessation` | Asset cessation | The asset has been or will be delisted (delisting, merger, bankruptcy, an indefinite halt), once officially confirmed with a fixed date. |
| 3 `StructuralChange` | Structural change | An officially scheduled event breaks the price series: a split, spinoff, rights offering, special distribution over 5%, redenomination, index re-basing. |
| 4 `PythVerifierMigration` | Pyth verifier migration | The Pyth Pro verifier contract the market's oracle uses is deprecated, being replaced, or no longer verifies the updates Pyth distributes. |

Market moves of any size are not grounds.

**The reason.** The terminator splices `reason` into the claim UMA's voters read, between fences
that its charset makes unforgeable, so it accepts only letters, digits, space and
`. , & / - : ? = # % _ ~ +` (enough for evidence URLs). Every other character, including square
brackets and anything non-ASCII, is refused. `termination.reasonProblem(reason)` returns why a reason
would be refused, or `null`, so a form can check it as the user types. The claim names the market by
its pair id and feed ids; the reason cannot change which market it is about.

**The bond.** The terminator pulls `requiredTerminationBond()` (at least 1,000 USDC) from the
proposer and posts it to UMA as the assertion bond. UMA returns it when the claim is accepted, and
pays it to the disputer if UMA's voters reject the claim. The call's `costs` has the bond, and its
`approvals` the USDC approval for the terminator when the allowance is short. If UMA's acceptance
schedules the market, the proposer also earns 0.1% of its insurance fund, at most $100, claimable on
the market with `claimFees`.

**The cutoff.** It must be at least 2 hours out (plus `slackSeconds`). Acceptance alone enforces it
as proposed only when it is at least 12 hours out (UMA's liveness), so prefer that. A nearer cutoff is
met as proposed only if insurers vote it through an hour before it; otherwise the claim is accepted
after it and the cutoff moves to 7 seconds after acceptance (`MIN_CUTOFF_LEAD`), and the call's notes
say so. For an event that has already happened, propose the earliest cutoff accepted. Once a UMA
cutoff is in force, a new claim must name an earlier one. Filing also opens an insurer vote on the
same cutoff, under the claim's assertion id (its window opens 14 days before the cutoff, or at
filing).

`proposalIdsFromReceipt(receipt)` reads the claim's `assertionId` (and the insurer vote it opened,
`insurerProposalId`, which is the same id) from the receipt's terminator events.

The builder refuses up front, with an `InputError`: a market the terminator does not know, one
already ended or with its price fixed, a category outside 1 to 4, a cutoff too soon or not earlier
than the UMA cutoff in force, an invalid reason, and UMA's identifier being off its live whitelist
(claims are closed until Bazaar's identifier upgrade completes; see
[UMA Disputes & Governance](governance.md)). The insurer-vote and stale-oracle paths still work then.

### Settling the Claim

```ts
{{#include ../../examples/protocol/termination-propose.ts:settle}}
```

`settleTerminationProposal({ assertionId, from? })` settles the assertion on the oracle it was made on
and applies the verdict: an accepted claim schedules the market (or pulls its cutoff earlier, or caps
an insurer schedule's samples); a rejected one leaves the market alone and ends the claim's vote. It
costs only gas, and anyone may send it.

It refuses an unknown or resolved claim, and one still inside UMA's liveness. A disputed claim settles
only after UMA's voters have ruled; until then the call reverts, so simulate it. Use
`bz.uma.assertionStatus(id, { home: "terminator" })` to show where the claim stands (`liveness` with
`canSettleAt`, `settleable`, `disputed`, `settledTrue`, `settledFalse`), and see
[UMA Disputes & Governance](governance.md) for disputing a claim and previewing a DVM ruling.

## Insurer Votes

An insurer vote ends a market when yes-votes from matured insurance shares reach 60% of the vote's
share snapshot, and someone executes it at least one hour before its cutoff. Every UMA claim opens
one; an insurer can also file a **bare** proposal with no claim behind it.

### A Bare Proposal

```ts
{{#include ../../examples/protocol/termination-insurer.ts:propose}}
```

`proposeInsurerTermination({ pair, cutoffTs, from, slackSeconds? })` posts a fixed 1,000 USDC bond
(`INSURER_TERMINATION_BOND_USDC`), held by the terminator until the vote resolves: refunded if the
vote schedules the market, is preempted by an earlier cutoff, is voided by a drained fund, or fails
having reached 60%; forfeited to the market's insurance fund if it fails short of 60%.

The cutoff must be 2 hours to 14 days out and earlier than any cutoff the market already carries, and
the proposer must hold shares deposited at least 4 days ago. Proposing does not vote the proposer's
shares. A bare vote settles under the chain rule, so its yes-voters pay a levy (below) unless the vote
meets a cutoff UMA accepted. The id is fixed by the second the proposal lands; read it with
`proposalIdsFromReceipt(receipt).insurerProposalId` (or compute it with
`termination.insurerProposalId(pair, proposer, timestamp)`).

### Voting

```ts
{{#include ../../examples/protocol/termination-insurer.ts:vote}}
```

`voteForInsurerTermination({ pair, id, shares, from })` votes yes with `shares` (18 decimals). Votes
are never withdrawn. The same shares may back several proposals, up to 8 live ones per wallet on a
market (`INSURER_MAX_LIVE_VOTES`, enforced by the contract and listed in `requires`).

Only shares held now that were deposited at least 4 days before the vote window opened count
(`termination.maturityCutoff(windowOpenTs)` gives that instant), less what the wallet has already
voted on this proposal. The builder refuses more than that, with the limit in the message.

The call's `costs` describe what voting puts at stake:

- a `lock`: the voted shares cannot be withdrawn from the insurance fund until the proposal's cutoff
  or the market's, whichever is first (a failed proposal releases them sooner only while the market
  has no cutoff); if this vote ends the market and its outcome is costed, until 13 days after the
  settlement price is fixed (`INSURER_POST_FIX_LOCK`);
- a `levy`, `contingent`, at its worst case: shares forfeited at redemption to Bazaar's bug bounty
  address if this vote ends the market.

| Outcome (stamped at the fix) | What the yes-voters owe |
|---|---|
| `true`: UMA upheld the claim behind the vote | Nothing; it settles under UMA's rule. |
| `false`: UMA rejected the claim | The 13-day lock, and half of every voted share (`INSURER_LEVY_BP` = 5,000). |
| `unjudged`: a bare vote, or no verdict within 14 days of the claim | The 13-day lock, and half the dissent fraction of the voted shares, at least a tenth (`termination.unjudgedLevyBp(snapshot, yes)`), unless the vote met a cutoff UMA had accepted. |

The notes also say how many shares the vote needs, how many it has with yours, and whether yours meet
the threshold. `termination.OUTCOME_TEXT` has a sentence for each outcome.

### Executing

```ts
{{#include ../../examples/protocol/termination-insurer.ts:execute}}
```

A vote takes effect only when someone executes it. `executeInsurerTermination({ pair, id, from? })`
resolves it; anyone may send it, and it costs only gas. Its extra `outcome` field (and `notes[0]`)
says what it will do now:

| `outcome` | When | A bare vote's bond |
|---|---|---|
| `schedule` | At or above 60% before the latch closes: the market is scheduled to stop at the cutoff, or its schedule pulled earlier. | Refunded |
| `preempted` | The price is already fixed, or a cutoff at or before this one is already scheduled. | Refunded |
| `voided` | The fund was drained and recapitalized since the snapshot. | Refunded |
| `failedRefund` | The latch closed (one hour before the cutoff) without scheduling, having reached 60%. | Refunded |
| `failedForfeit` | The latch closed short of 60%. | Forfeited to the insurance fund |

A claim-backed vote's bond is UMA's, so none of these moves one. The builder refuses an unknown or
resolved vote, and one still open below its threshold (the contract reverts until the vote reaches
60% or its latch closes).

### Reading Votes

```ts
{{#include ../../examples/protocol/termination-insurer.ts:read}}
```

`insurerProposal(id)` returns the vote with its `state` judged at the chain's time:

| `state` | Meaning |
|---|---|
| `upcoming` | Its window has not opened (a claim filed more than 14 days before its cutoff). |
| `voting` | Open for votes and, once at the threshold, for execution. |
| `expired` | The latch closed without the vote scheduling the market; executing it now resolves it as failed. |
| `scheduled` | It reached the threshold and set the market's cutoff. |
| `rejected` | UMA rejected the claim behind it before it scheduled anything. |
| `ended` | Resolved otherwise (failed, preempted or voided); the events say which. |

Its other fields: `proposer`, `proposalTs`, `shareEpoch`, `cutoffTs`, `windowOpenTs`,
`votingClosesAt` (the cutoff less one hour), `yesShares`, `snapshotTotalShares` and `snapshotTaken`
(the snapshot is taken at the first touch once the window is open), `thresholdShares` and
`thresholdMet`, `claimBacked`, `resolved`, `scheduled`, `costed`, `verdict`/`verdictName`,
`outcome`/`outcomeName`/`outcomeText`, and `levyBp` (stamped with the outcome).

`getInsurerVote({ pair, voter, id })` is the shares a voter has in one vote, and
`getLockedShares({ pair, user })` the shares voted into live proposals, which an insurance withdrawal
cannot take (the [exit plan](insurance.md#the-exit-plan) reports them as `lockedForVoting`).

## Fixing the Settlement Price

### Stale Oracle

```ts
{{#include ../../examples/protocol/termination-settle.ts:stale}}
```

`terminateStalePair({ pair, from? })` ends a market that has stored no price for more than 21 days
(`ORACLE_DEAD_THRESHOLD`) at its last stored price, or at a nominal price of 1 when it never stored
one (then aged from its creation). Anyone may call it; it pays nothing and costs only gas. The pair's
own stored price is the evidence: a pair stores one whenever a call lands on it with a fresh update,
so one `refreshPrice` restarts the 21 days.

It refuses a market the terminator does not know, one with its price fixed, one whose vote-set cutoff
has passed (that market settles through `terminateScheduledPair`, whose own fallback reaches the
stored price), and one that stored a price within 21 days, with the time the path opens.

### At a Scheduled Cutoff

```ts
{{#include ../../examples/protocol/termination-settle.ts:scheduled}}
```

`terminateScheduledPair({ pair, from, fetchTick?, estimateGas? })` fixes a scheduled market's price
with archived Pyth Pro updates. Pyth keeps no prices on chain, so every settlement price is submitted
as a signed update and verified on the spot. All of them come from Pyth's **one-second channel**
(`fixed_rate@1000ms`), which issues one update per second, stamped on the second, and whose archive
serves the update for any past second: the connection's price source fetches them (`atTick`; without
a Pyth Pro source the builder throws `ConnectError`). It returns a `ScheduledSettlementPlan` whose
`call` is one the contract accepted in simulation as `from`, or `null` with the reason.

It reads `settlementRule(pair)`, whose fields are:

| Field | Meaning |
|---|---|
| `rule`, `key` | 0 `nothing`, 1 `tick`, 2 `chain`, 3 `awaitVerdict`. |
| `meaning` | A sentence for the rule (`termination.SETTLEMENT_RULE_TEXT`). |
| `firstTarget` | The cutoff: the second whose update settles the market under UMA's rule, the first sample's target under the chain rule. |
| `latestPublishTs` | Under UMA's rule the cutoff again; under the chain rule the latest second a sample's update may be stamped with, `null` when unbounded. |
| `lastResortTs` | After this a call with no updates settles at the stored price; `null` when not applicable. |
| `verdictDeadline` | While waiting for a verdict: when the vote stops waiting and settles unjudged. |

and builds the set the rule needs:

| Rule | Updates | Fee |
|---|---|---|
| `tick` (UMA's rule) | The update stamped at the cutoff, carrying every feed leg: one update for both legs of a composite, or one per leg when the archive will not answer for them together. The market settles at the price it carries, whenever that price was generated: a quiet feed's update carries its last price forward. | `getUpdateFee(updates.length)` |
| `chain` | Five samples. Each is the earliest second whose update carries a price generated at or after the sample's target: the target's own update when it does, otherwise two updates, the quiet second before and that second. The first target is the cutoff, each later one 600 s past the second of the sample before (the later leg's, for a composite); every sample's second no later than `latestPublishTs`. Per sample the base leg's one or two updates come first, then the quote leg's. | `getUpdateFee(updates.length)` |
| `awaitVerdict` | Nothing yet: the vote that set the cutoff waits for UMA's verdict on its claim. | |
| `nothing` | Nothing to settle (no cutoff, or the price is fixed). | |

**Finding a chain sample.** `termination.chainSample` fetches the update stamped at the target. If
its price was generated at or after the target, that one update is the sample. If not, the feed was
quiet there, and since a price's generation time never goes backwards from one second to the next, the
first second with a new price is found by doubling the step from the target and then bisecting: a
reopen days later takes a few dozen requests. The targets cannot be computed ahead, so the five
samples are searched in sequence, and the last exists only once its price does, at least 40 minutes
after the cutoff. A sample that would land past `latestPublishTs`, or that the feed has not produced
yet, makes the builder return no call and say so.

**Proving the set.** Each set is verified by calling the pair's oracle exactly as the terminator does
(`fetchPriceAtTick` or `fetchChainedMedian`, as `from`, with the fee), and only a set the oracle
accepts is offered. The price it returns is the plan's `settlementPrice`. This matters once the
stored-price fallback is open: the terminator then settles at the stored price instead of reverting on
a refused set, so the contract's simulation alone would accept bad updates and the call would be
labelled with a price it does not fix.

**Verdicts.** `settlementRule` cannot see a verdict UMA's DVM has reached on the claim behind a vote
until someone records it, but `terminateScheduledPair` records it itself. For a disputed claim the
builder previews the DVM's ruling (`uma.previewSettlement`) and builds that rule's set: UMA's rule if
the claim was upheld (whose 12-hour grace starts at this recording, so no fallback yet), the chain
rule if not. When the ruling cannot be previewed, it builds both sets and returns the one the contract
accepts. A claim still in its liveness returns no call, with `retryAt` set to the end of the liveness.

**The last resort.** Past `lastResortTs`, a call with no updates settles the market at its stored
price, for good (12 hours after the cutoff or the verdict under UMA's rule; 21 days after the cutoff
under the chain rule, or 12 hours after a capping UMA cutoff, `termination.chainLastResort`). It is
tried only when no proven set is accepted, and when it is offered depends on `storedPrice`:

| `storedPrice` | The stored-price call is offered |
|---|---|
| `"whenAbsent"` (default) | Only when every set failed because Pyth's archive holds no usable update (none for the second, no price in it, no chain under its bound or none yet), and the archive is shown to work: it must serve ETH/USD's one-second update from a minute before the chain's time, or its "none" is not believed. A request that timed out or was refused, an archive at a wrong URL, a signer check that failed, and a set the oracle refuses may all hide a proven price, so the call is withheld and the plan says why. |
| `"always"` | Whenever no proven set is accepted, for a caller who has decided. It needs no price source. |
| `"never"` | Never. |

The plan:

| Field | Meaning |
|---|---|
| `call` | The `CostedCall` to send, or `null`. Its `value` is the Pyth fee in ETH (in `costs`; any excess is refunded); its notes state the price and the rule. |
| `under` | `"tick"`, `"chain"` or `"storedPrice"`. |
| `updates` | The call's `priceUpdate`. |
| `prints` | The updates as read, feed by feed (`feedId`, `update`, `tick`, `priced`, `price`, `generatedUs`, `publishTime`): in calldata order under the chain rule, one per leg under UMA's rule. |
| `settlementPrice` | The price the call fixes (18 decimals). |
| `attempts` | Each candidate tried: `under`, `ok`, `reason`, `kind` (`"absent"`: the archive showed no proven settlement exists now; `"unreachable"`: it could not be asked or relied on; `"refused"`: the oracle or the contract refused the set; `null` when it was accepted), the decoded `error`, `price`. |
| `reason` | Why there is no call. |
| `retryAt` | When to try again, when known (the verdict, the fallback). |
| `storedPriceWithheld` | Why the stored-price call is not offered although its last resort is open; `null` when it is offered or not open. |
| `rule`, `scheduledTerminationTs`, `now` | What it was judged against. |

The builder throws an `InputError` for a market the terminator does not know, one with its price
fixed, one with no cutoff, and one whose cutoff has not passed yet. Updates are fetched with
`termination.tickFetcher(source)`; pass `fetchTick` (a `TickFetcher`:
`(feedIds, second) => Promise<ProUpdate | null>`) to use another archive. The building blocks are
exported too: `tickPrints`, `chainSample`, `chainPrints`, `settlementPrint`, `generatedAtOrAfter`, and
`SettlementPrintError` for an update that cannot be fetched or a sample that cannot be proven, whose
`kind` is `"absent"` or `"unreachable"` as in `attempts`. A price at or below zero, at the cutoff or in
a chain sample, cannot settle the market: the oracle refuses it.

No keeper job fixes prices on its own; the keeper's operator can run `terminateStalePair` and
`terminateScheduledPair` as manual operations (see [Manual Operations](../keeper/manual-operations.md)).

## The Settlement Window

Once the price is fixed, trading, ADL, deposits and all withdrawals stay frozen while every open
position is settled at it. Settling is the pair's `liquidate(accounts, [])`: anyone may call it, with
no price update and no ETH, and settling someone else's position earns a $0.05 tip, claimable with
`claimFees`. Settling your own is free (a position also settles on its owner's first withdrawal after
finalize).

The SDK has no builder for this call; encode it with the pair's codec:

```ts
{{#include ../../examples/protocol/termination-settle.ts:positions}}
```

The sample finds open positions in Bazaar's subgraph (`bz.history.positions`, see
[History](history.md)). The keeper's `terminalSettlement` job does the same from its own index, then
finalizes; see [The Jobs](../keeper/jobs.md).

## Finalizing

```ts
{{#include ../../examples/protocol/termination-settle.ts:finalize}}
```

`finalizeTermination({ pair, from? })` retires the vault's inherited inventory and freezes the payout
ratios. Anyone may call it once every position is settled (open interest is zero) or, as the escape
hatch, 14 days after the fix (`TERMINAL_SETTLEMENT_ESCAPE`); it costs only gas. It refuses a market
with no price fixed, one already finalized, and one with positions still open before the escape hatch
(with the time it opens).

Finalizing through the escape hatch with positions open is allowed, but a bankrupt position settled
afterwards can lower the ratios for everyone still in, and insurance redemptions wait until those
positions are settled. Settle first when you can.

## Withdrawing After Termination

```ts
{{#include ../../examples/protocol/termination-settle.ts:withdraw}}
```

`getTerminalEntitlement({ pair, account })` reads what the market pays an account:

| Field | Meaning |
|---|---|
| `collateral` | The account's collateral. |
| `registeredClaim` | Its profit claim (a winner settled before finalize). |
| `principalRatio`, `profitRatio` | Cash per unit of collateral and of claim (1e18 = 100%); 0 before finalize. |
| `payout` | collateral × principal ratio + claim × profit ratio: what withdrawing everything pays now. |
| `finalized` | `true` once finalize has run. |

Before finalize the ratios, and so the payout, read 0: show that as "not frozen yet", not "worthless".
A position still open is not included until it is settled.

Withdraw with `bz.trade.withdrawCollateral(pair, user, amount)` as on a live market. The amount is in
collateral units, the first withdrawal credits the registered claim into collateral, and the wallet
receives the amount times the principal ratio; the call's summary says what it pays, and a withdrawal
that would pay nothing is refused. `bz.previews.previewWithdrawal(pair, user)` returns the largest
amount accepted (`maxWithdrawable`) and the entitlement (`terminal`). Settlement tips and a UMA
proposer's reward are separate, in the fee balance (`claimFees`). Insurance LPs redeem through the
[insurance exit](insurance.md#on-a-terminated-market).

## Events

`termination.decodeTerminatorLog(log)` decodes a terminator log (or returns `null` for another
contract's), and `termination.TERMINATOR_EVENT_TEXT` has a sentence for each event, for an activity
feed. Every UMA claim ends in exactly one of `TerminationProposalAccepted`,
`TerminationScheduleRefused`, `TerminationProposalSuperseded` or `TerminationProposalRejected`. For
indexed history (`terminationProposals`, `insurerProposals`, `insurerVotes`, `insurerLevies`,
`pairTerminations`, `terminalRatioUpdates`) see [History](history.md). [Live Updates](live-updates.md)
reads the terminator's logs alongside each watched market's.

## Constants

| Constant | Value |
|---|---|
| `TERMINATION_PROPOSAL_BOND_USDC` | 1,000 USDC (the floor; the bond posted is `requiredTerminationBond()`) |
| `TERMINATION_PROPOSAL_LIVENESS` | 12 hours |
| `MAX_REASON_LENGTH` | 1,000 |
| `MIN_CUTOFF_LEAD` | 7 s (a late acceptance's cutoff) |
| `INSURER_TERMINATION_MIN_LEAD` | 2 hours |
| `INSURER_TERMINATION_LATCH_LEAD` | 1 hour |
| `INSURER_TERMINATION_MAX_LEAD` | 14 days |
| `INSURER_TERMINATION_THRESHOLD_BP` | 6,000 (60%) |
| `INSURER_TERMINATION_BOND_USDC` | 1,000 USDC |
| `INSURER_SHARE_MATURITY_PERIOD` | 4 days |
| `INSURER_MAX_LIVE_VOTES` | 8 |
| `INSURER_LEVY_BP`, `INSURER_LEVY_FLOOR_BP` | 5,000 and 1,000 |
| `CLAIM_VERDICT_GRACE` | 14 days |
| `INSURER_POST_FIX_LOCK` | 13 days |
| `SCHEDULED_TERMINATION_GRACE` | 12 hours |
| `NEVER_PRICED_SETTLEMENT_PRICE` | 1, the smallest price in 18 decimals (a market that never stored a price) |

These are on the `termination` namespace; `LIMBO_LEAD`, `ORACLE_DEAD_THRESHOLD`,
`TERMINAL_SETTLEMENT_ESCAPE`, `SETTLEMENT_SAMPLE_COUNT` and `SETTLEMENT_SAMPLE_SPACING` are exported
at the top level. See [Units & Constants](../reference/units.md).

## What Can Go Wrong

Builder refusals are `InputError`s naming the argument; `errorMessage(e)` gives the sentence. A
`BondQuoteError`, a `SettlementPrintError`, a `SubgraphError` or a `ConnectError` carries its own
`message`: show that (`errorMessage` does not recognize them). Reverts a simulation can show:

| Error | Meaning |
|---|---|
| `BazaarPairTerminator__LastTradingTsTooSoon`, `InsurerCutoffTooSoon`, `InsurerCutoffTooLate` | The cutoff is outside its bounds; the time moved on while the user decided. Rebuild. |
| `BazaarPairTerminator__CutoffNotEarlier`, `InsurerCutoffNotEarlier` | An earlier or equal cutoff is already in force. |
| `BazaarPairTerminator__UmaIdentifierNotLive` | UMA claims are closed until the identifier upgrade. |
| `BazaarPairTerminator__InsurerNoMatureShares`, `InsurerInsufficientUnlockedShares` | Not enough shares held 4 days before the window opened. |
| `BazaarPairTerminator__InsurerThresholdNotMet` | The vote is below 60% and still open. |
| `BazaarPairTerminator__InsurerTooManyLiveVotes` | The wallet backs 8 live votes on this market. |
| `BazaarPairTerminator__InsurerVotingClosed`, `InsurerVoteNotOpen` | Outside the vote's window. |
| `BazaarPairTerminator__InsurerVerdictPending` | The claim behind the vote has no verdict yet. |
| `BazaarPairTerminator__OracleNotStaleEnough` | The market stored a price within 21 days. |
| `BazaarPairTerminator__TerminationTimeNotReached` | The cutoff has not passed. |
| `BazaarPairTerminator__InsufficientPythFee` | Not enough ETH for the updates' fee. Rebuild. |
| `BazaarOracle__SampleCountMismatch` | The chain set does not hold one update per leg for each of five samples. |

## Related

- [Insurance](insurance.md): LP shares, which vote, and redeeming after termination.
- [UMA Disputes & Governance](governance.md): disputing a claim, previewing a ruling, the identifier upgrade.
- [Listing Markets](listings.md): the other UMA flow, with the same `CostedCall` shape.
- [Termination & Settlement](https://docs.bazaar.finance/protocol/termination.html) in Bazaar's docs.
