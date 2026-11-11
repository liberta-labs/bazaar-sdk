# What the Keeper Does

Bazaar needs someone to do its upkeep: liquidate positions that fall below their maintenance margin,
fire stop orders when the price reaches them, sell the insurance vault's inherited inventory, run ADL
auctions, keep quiet markets' prices fresh, settle terminated markets. None of it is restricted. Anyone
may call these functions, and most of them pay the caller a bounty in USDC.

A **keeper** is a program that does this work for its bounties. `@liberta-labs/bazaar-keeper` is one:
it watches the markets you choose, works out which calls are due, simulates each one against the
chain to learn exactly what it would earn, and sends the ones worth sending from your own wallet. It
runs as a command-line program (`bazaar keeper start`), in a container, or inside your own TypeScript
service ([The Keeper as a Library](library.md)).

This page explains what the keeper does and what it needs. [Setting Up a Keeper](setup.md) takes you
from nothing to a running keeper.

## The Jobs

Each job is one kind of upkeep. You switch each one on in the config and choose its markets.

| Job | What it does | Who pays you, and how much |
|---|---|---|
| `liquidation` | seizes positions below their maintenance margin | the insurance fund: $0.05 per position seized, or the larger of $0.05 and 2 bp of the notional it retires when the seizure nets the vault's two buckets; plus whatever 2 bp of the call's inline unload exceeds that. A position worth less than $5 pays at most its own equity |
| `triggers` | fires StopLimit, StopLoss and TakeProfit orders whose trigger the price reached | the order's owner, through the bounty they attached when they placed it: paid in proportion to what your call fills, the whole remainder once the order completes or rests in the book |
| `unload` | sells the vault's liquidated inventory into the book | the insurance fund: 2 bp of what sells, raised to a $0.25 floor when a call unloads $1,250 or more or clears the inventory |
| `adl` | runs ADL batches while an ADL window is open | the insurance fund: 2 bp at the mark of what a batch closes, or 0.1% of the bad debt the close averts where that is larger, plus 2 bp of the overlap the batch's netting retires |
| `refresh` | stores a fresh price on quiet markets | the insurance fund: $0.10 per refresh, when the refresh bounty's gates hold ([The Jobs](jobs.md#refresh)) |
| `terminalSettlement` | settles positions at a terminated market's fixed price, then finalizes it | $0.05 per position settled for someone else, from that position's collateral (the insurance fund tops up positions worth at least $5); finalizing pays nothing |
| `collect` | claims what your wallets have earned, and can forward the USDC elsewhere | nothing: it moves your earnings to your wallet |
| `sweepExpired` | unlinks expired orders and returns stranded bounties to their owners | nobody: a public service, run within a small daily loss budget |

Every bounty is credited to your wallet's claimable balance on the market that paid it, and stays
there until it is claimed with `claimFees()` on that market. The `collect` job does that for you.
Every payout from the insurance fund is capped at the fund's free capital. The full rules are in
Bazaar's [Earning on Bazaar](https://docs.bazaar.finance/guide/earning.html) and
[Parameters](https://docs.bazaar.finance/reference/parameters.html).

Besides the jobs, the keeper runs **manual operations** when you ask for them: terminating a market at
its scheduled cutoff or after its oracle died, settling UMA claims and insurer votes, finalizing a
termination, and the factory's listing and identifier-upgrade housekeeping. They pay nothing and are
never sent on their own. `bazaar keeper opportunities` lists the ones available now
([Manual Operations](manual-operations.md)).

Relaying signed meta-transactions is not a keeper job. Governance actions that post a bond or vote
(termination and listing proposals, insurer votes) are not either: the SDK builds those for a person
to sign ([Termination & Settlement](../sdk/termination.md), [Listing Markets](../sdk/listings.md)).

## How the Keeper Decides

The keeper never sends a call on an estimate. For each call it is about to make it does this:

1. **Find candidates.** It keeps a local index of every open position and live order, built from the
   subgraph or from the chain's logs and kept current from each new block's logs. On each new price
   print and on each tick (every `engine.tickSeconds`, 0.5 s by default) every job checks its markets
   locally: is a position below its requirement at the live price, has a stop's trigger been
   reached, does the vault hold inventory. Liquidation and triggers make no RPC request until a
   position or order crosses at the live price.
2. **Re-read from the chain.** The index only finds candidates. Before acting, the job re-reads each
   one from the chain (the position's bucket, the order record) and drops what no longer qualifies.
3. **Simulate through the probe.** The call is run with `eth_call` from a small contract placed at a
   fixed address by a state override. Rewards accrue to the caller, so the difference in the probe's
   claimable balance before and after the call is exactly what the call would earn, with every cap the
   contracts apply. A call that reverts in simulation is never sent.
4. **Price the gas.** The gas comes from `eth_estimateGas` of the real transaction from the real
   wallet, priced at the current base fee and the live ETH/USD print.
5. **Apply the spend policy.** A paid call goes out when reward − gas ≥ `minProfitUsd` and reward ≥
   gas × `gasSafetyMultiplier`. A call that fails that test is sent only if you chose to take losses
   on that job, within per-call and daily caps. Every call, whatever decided it, must fit the daily
   spend caps and the fee ceilings. [Budgets & Losing Calls](budgets.md) has every rule.
6. **Send and book.** The transaction goes out with priority fee 0 (Arbitrum's sequencer orders
   transactions first come, first served). When its receipt arrives, the reward and claim it logged
   are written with the gas it actually cost to the earnings ledger, which `bazaar keeper earnings`
   reads.

A dry run (`--dry-run`) takes the same path and stops before sending, so what it reports is what a
real run would do.

## What You Need

| Requirement | Why | Notes |
|---|---|---|
| Node 20 or later | the keeper is a Node program | or Docker ([Running in Production](production.md#docker)) |
| An Arbitrum RPC with `eth_call` state overrides | the probe is placed by a state override; reads are batched through it | Without overrides calls are simulated directly: reverts are still caught, but the reward is unknown, so paid jobs skip. `bazaar keeper doctor` checks. The node must also answer `eth_getLogs` (refused ranges are split automatically) and, when there is no subgraph and no `startBlock`, historical `eth_getCode` reads |
| A Pyth Pro price endpoint | every price-touching call carries a signed Pyth Pro update, which Pyth's verifier checks on chain | `pyth` with your own Pyth Pro access token, or the URL of a Pyth Pro compatible service. Bazaar's shared endpoint (`bazaar`) has no URLs yet. The keeper streams over a WebSocket (the `ws` package, so Node 20 works) |
| ETH on Arbitrum | gas, and Pyth's update fee | no keeper call needs USDC or an approval |
| A wallet | to sign | an encrypted keystore (recommended), a private key, a mnemonic, or a remote signer ([Wallets & Secrets](wallets.md)). Without one the keeper is watch-only |
| The deployment's factory address | everything else is read from it | Bazaar's network presets carry no official factory address yet, so the config names one |
| A subgraph (optional) | a fast first start | without one the first start replays Bazaar's logs from the factory's deployment block |

## How Fast It Is

Liquidations and trigger executions race other keepers, and what makes them due is usually a price
move. So besides the tick, these two jobs plan a market the moment a newer print for one of its legs
arrives. Each print plans only the markets whose feeds moved, checks every position or order
against the live price locally, and makes RPC requests only for real candidates. The package README
gives a median of 0.5 ms from print to planned with 200 markets of 2,000 positions each, and the
end-to-end test reports the keeper's latency from a price move to its send.

Prints and the tick share one plan per job and market at a time: a print that arrives during a plan
queues one more plan, which then judges by the newest print. While the index is catching up (a sync
step 64 or more blocks behind the head, as after a restart), the print path waits, so it never plans
from a half-replayed index.

Latency wins races on Arbitrum, not fees. To be fast:

- give the latency-critical jobs (`liquidation`, `triggers`) a wallet of their own, so their sends
  never wait behind another job's nonce ([Wallets & Secrets](wallets.md#several-wallets));
- on Arbitrum One, submit straight to the sequencer with `rpc.send: sequencer`;
- run close to your RPC and price endpoint.

## Related Pages

- [Setting Up a Keeper](setup.md): install, configure, check, fund, start.
- [The Jobs](jobs.md): each job in depth.
- [Budgets & Losing Calls](budgets.md): the spend policy.
- [Configuration Reference](configuration.md): every option.
