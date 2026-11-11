# Budgets & Losing Calls

Every call the keeper plans is simulated, priced and then judged by the **spend policy**: the rules
that decide whether it is sent. This page gives every rule, in the order the keeper applies them, and
the settings that change each one. The short version: by default only profitable calls are sent;
taking losses is something you switch on per job, within caps you set; and every call, however it was
decided, must fit the daily spend caps and the fee ceilings.

## What a Call Earns and Costs

For each call the executor knows:

- **R**, the reward in USD: exactly what the call would add to the wallet's claimable balance on the
  market, measured by the probe simulation. Without `eth_call` state overrides it cannot be measured
  and counts as 0.
- **C**, the cost in USD: the gas from `eth_estimateGas` of the real transaction from the real wallet,
  times the current base fee, plus the ETH the call carries (Pyth's update fee), priced at
  [ETH/USD](#pricing-gas-in-usd).
- the same cost in wei, for the [ETH cap](#1-the-daily-spend-caps).

The policy then decides as follows.

## 1. The Daily Spend Caps

Every call must fit both caps, whoever decided it should go (the profit rule, a loss you allowed, a
job's own rule, `--force`, a manual operation):

| Setting | Default | What it counts |
|---|---|---|
| `budget.maxSpendUsdPerDay` | `10` | the USD cost of every call sent in the last 24 hours, all jobs and wallets, plus the calls in flight |
| `budget.maxSpendEthPerDay` | `maxSpendUsdPerDay / gas.ethUsdFloor` (0.01 ETH with the defaults) | the same in wei: gas and the update fees the calls carried |

The ETH cap is counted in wei, so no ETH/USD price can lift it: a feed reporting ETH at $1 would make
gas look free in USD, but not in wei. Set `maxSpendEthPerDay` yourself to decouple it from the floor.

A call that does not fit is skipped: `daily gas budget reached ($9.98 of $10.00 spent)` or `daily ETH
spend cap reached (0.00998 of 0.01 ETH spent; budget.maxSpendEthPerDay)`. The window slides: a call
sent 24 hours ago stops counting. A call whose cost cannot be priced (not a finite number) is refused
outright.

## 2. The Profit Rule

A **paid** call (one that earns a bounty) is sent when both hold:

```text
R − C ≥ minProfitUsd          (default 0.001)
R ≥ C × gasSafetyMultiplier   (default 1.25)
```

| Setting | Default | |
|---|---|---|
| `profit.minProfitUsd` | `0.001` | the least net profit worth a call |
| `profit.gasSafetyMultiplier` | `1.25` | headroom against the gas estimate being low |
| `jobs.<job>.minProfitUsd`, `jobs.<job>.gasSafetyMultiplier` | the `profit` values | per-job overrides |

Otherwise it is skipped: `below the profit rule: earns $0.0400 for $0.0500 of gas, needs ×1.25 and
$0.001 net (allowLoss is off)`, unless the job takes losses.

## 3. Losing Calls

A keeper may want to send calls that cost more than they earn: liquidating a position before it turns
into bad debt, opening an ADL window, or cleaning up books as a public service. That is your choice,
per job, and always capped. A call that fails the profit rule is sent only with consent:

- **`allowLoss: true`** on the job, or
- **an unpaid duty switched on by name**: `terminalSettlement.finalize` (default on) or
  `refresh.healthPokes` (default off). Turning one on is consent to pay for that call.

```yaml
jobs:
  liquidation:
    allowLoss: true            # also send calls that cost more than they earn
    maxLossUsdPerCall: 0.10    # never lose more than this on one call
    lossBudgetUsdPerDay: 2     # nor more than this per day for this job
budget:
  maxLossUsdPerDay: 5          # and never more than this across all jobs
```

The loss, C − R, must then fit three caps:

| Cap | Setting | Default |
|---|---|---|
| per call | `jobs.<job>.maxLossUsdPerCall`, or the duty's own: `terminalSettlement.finalizeMaxCostUsd`, `refresh.healthPokeMaxCostUsd` | `0.05`; `0.5` for finalize; `0.1` for health pokes |
| per job, per day | `jobs.<job>.lossBudgetUsdPerDay` (the duties count against their job's) | `1.0`; `0.25` for `sweepExpired` |
| all jobs, per day | `budget.maxLossUsdPerDay` | `2` |

Each refusal says which cap: `would lose $0.1200, above the $0.1000 per-call cap`, `liquidation's
daily loss budget is spent ($1.98 of $2.00)`, `the global daily loss budget is spent ($2.00 of
$2.00)`. A call that pays nothing and has no consent is skipped with `pays nothing, and this job does
not take losses (allowLoss is off)`.

`sweepExpired` pays nothing ever, so it ships with `allowLoss: true` and a $0.25 daily budget, and runs
only if you enable the job. `includeUnbountied` trigger orders pay nothing too, so they send only with
`allowLoss`.

Only calls the policy sent as losses count against the loss budgets (their ledger kind is `loss` or
`unpaid`). A profitable call that turned out to lose on chain (the receipt's gas higher than the
estimate) counts toward the spend caps, not the loss budgets.

## 4. Collect and Forwarding

`collect` replaces the profit rule with its own (claiming earns nothing new): claim a balance once it
reaches `thresholdUsd` and covers the gas × `gasSafetyMultiplier`; claim a balance older than
`maxAgeDays`, or anything on shutdown, whenever it covers the gas. Forwarding sends whenever the
wallet's USDC reaches `forwardMinUsd`. Both still fit the spend caps and the fee ceilings.
[The Jobs](jobs.md#collect).

## 5. The Fee Ceilings

Arbitrum's sequencer orders transactions first come, first served, so a priority fee buys nothing.
The keeper sends with priority fee 0 and `maxFeePerGas` = base fee × `gas.feeMultiplier` (2.0), and
caps it:

| Setting | Default | Applies to |
|---|---|---|
| `gas.maxFeeGwei` | none | every call: nothing is sent while the base fee is above it, and `maxFeePerGas` is capped at it |
| `gas.backgroundMaxFeeGwei` | `0.1` | background work (collect claims except on shutdown, forwarding, sweeps, finalize), on top of `maxFeeGwei` (the lower of the two wins); `null` removes it |

While the base fee is above the ceiling, the call waits: `base fee 0.1500 gwei is above the 0.1 gwei
ceiling`. `--force` and manual operations keep the ceilings. The gas limit is the estimate ×
`gas.gasLimitMultiplier` (1.25) + 10,000.

## 6. The Low-Balance Halt

The keeper reads every wallet's ETH balance once a minute (and before the first send of a one-shot
run). While any wallet holds less than `budget.minEthBalance` (0.002 ETH), **all sending stops**, on
every wallet, with a `lowBalance` alert:

```text
sending paused: fast (0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f) holds 0.00140 ETH, below budget.minEthBalance
```

It resumes on its own once every wallet is funded. Forced calls and manual operations stop too. When a
send needs a fresh balance check (the first send, and one-shot runs) and the balances cannot be read,
that call is not sent: `could not read the wallets' balances, so nothing is sent: …`.

## Pricing Gas in USD

The USD budgets depend on the ETH/USD price, which never goes on chain, so nothing verifies it. The
keeper guards it:

| Setting | Default | |
|---|---|---|
| `gas.ethUsdMaxAgeSeconds` | `60` | an ETH/USD print older than this is not used |
| `gas.ethUsdFallback` | `3000` | used when there is no fresh print, or the print is outside $100 to $1,000,000 |
| `gas.ethUsdFloor` | `1000` | gas is never priced below this, whatever the print or fallback says |

So the price used is the fresh, plausible print, else the fallback, and never below the floor. Each
call uses one price for its decision and its ledger entry. `doctor` warns when no fresh, plausible
ETH/USD print is available.

## What `--force` Skips and Keeps

`bazaar keeper run <operation> --force` (and `{ force: true }` in the library) is for one-shot calls
you want sent even when the policy would not:

| Skips | Keeps |
|---|---|
| the profit rule | the simulation: nothing that reverts is ever sent |
| `allowLoss` and the per-call, per-job and global loss caps | a job's own check of the simulation (an unload must sell something; a health poke must change the vault's health) |
| | the daily USD and ETH spend caps |
| | the fee ceilings |
| | the low-balance halt |
| | the in-flight keys: a call the running keeper (in the same process) is already sending is not sent twice |

A forced call is booked with kind `forced` and does not count against the loss budgets; it counts
against the spend caps. Manual operations are always sent this way (they pay nothing and run because
you asked). For `collect`, `--force` means something else: claim every balance that covers its gas, as
on shutdown.

## Reservations Under Concurrency

Each call is planned and sent in its own task, so many may be deciding at once. The moment a call is
decided, its cost (and its loss, if it was sent as one) is **reserved** in the ledger, with no wait
between the decision and the reservation. Every later decision sees it, so concurrent sends cannot
together overshoot a budget. When the receipt arrives the reservation becomes the ledger entry, at the
actual gas cost; a send that never went out releases it.

A send that got no answer and shows no receipt within 90 seconds is booked as `unknown` at its
estimated cost: it may still land, so it keeps counting, and its candidate stays locked for 5 more
minutes.

## The Ledger and `earnings`

Every transaction the keeper sends becomes one line in `ledger.jsonl` in the state directory
(`<state.dir>/keeper/<chainId>-<factory>/ledger.jsonl`), appended when its receipt arrives:

```json
{"ts": 1762600998.12, "job": "liquidation", "market": "ETH/USD", "wallet": "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", "tx": "0x5c1e…", "status": "confirmed", "kind": "profit", "cost_usd": 0.0019, "reward_usd": 0.1, "expected_reward_usd": 0.1, "claimed_usd": 0, "gas_used": 412345, "summary": "liquidate 2 account(s), $4,100 notional", "extra": {"cost_wei": "1900000000000"}}
```

| Field | Meaning |
|---|---|
| `ts` | seconds since the epoch |
| `job` | the job (`forward` for forwarding; the operation's name for manual operations) |
| `market` | the market's label, or empty |
| `wallet` | the sending wallet's address |
| `tx`, `status` | the transaction and `confirmed`, `reverted` or `unknown` |
| `kind` | `profit`, `loss`, `unpaid`, `forced`, `collect` or `forward` |
| `cost_usd` | the gas actually paid (or the estimate, for `unknown`) |
| `reward_usd`, `claimed_usd` | the `FeeAccrued` and `FeesClaimed` amounts the receipt logged for this wallet |
| `expected_reward_usd` | what the simulation said |
| `extra.cost_wei` | wei that left the wallet: gas, plus the ETH the call carried unless it reverted |

The daily budgets are read from the ledger, so they survive restarts. Only sent transactions are
written; skips and dry runs are not. The format is the Python keeper's, so either reads the other's
ledger.

`bazaar keeper earnings` sums it:

```bash
bazaar keeper earnings --since 24h
bazaar keeper earnings --since 30d --by market
```

```text
 JOB                 CALLS  REVERTED   EARNED      GAS      NET  CLAIMED
 collect                 2         0  $0.0000  $0.0004  $-0.0004   $12.40
 liquidation            14         1  $1.4000  $0.0310  $1.3690    $0.00
 triggers               31         3  $2.1700  $0.0620  $2.1080    $0.00
```

`EARNED` is what the calls accrued to your claimable balances, `NET` that less gas, and `CLAIMED` what
`collect` moved to your wallet. `--since` takes `30m`, `24h`, `7d` (a bare number is days; default
`7d`); `--by` is `job` (default) or `market`.

## Choosing Your Numbers

- Start with the defaults and `start --dry-run` for a while: the log shows what would be sent and why
  each skip was skipped.
- Raise `maxSpendUsdPerDay` (and `maxSpendEthPerDay`) to what you are willing to spend on a bad day,
  not an average one.
- Turn on `allowLoss` only for jobs whose work matters to you even unpaid, with small per-call caps.
- Set `gas.maxFeeGwei` so a gas spike cannot make the keeper bid into it.

## Related Pages

- [The Jobs](jobs.md): which calls are paid and which are not.
- [Configuration Reference](configuration.md#budget): every key.
- [Commands](commands.md#keeper-earnings): `earnings` in full.
