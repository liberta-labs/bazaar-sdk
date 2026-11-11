# Insurance

Each Bazaar market has its own insurance fund, owned by liquidity providers (LPs) who hold its
shares. The fund earns the market's insurance fees and absorbs what liquidations lose beyond
maintenance margin. This page covers the LP flow from the SDK: reading an LP's position, quoting at
the live price, depositing, and the multi-step exit (request, cooldown, lock, paying call), with
`insuranceExitPlan` telling a UI which step the LP is on.

Use it to build an "earn" or "provide insurance" screen, or a bot that manages an LP position. The
mechanics (share pricing, the target, the rate limit, the headroom rule) are described in Bazaar's
[Insurance Fund](https://docs.bazaar.finance/protocol/insurance.html) page; this page says what each
SDK call does with them.

Everything here is on `bz.insurance` (with `bz` connected as in [Connecting](connecting.md)), and the
same functions take a context first on the `insurance` namespace export
(`insurance.depositToInsurance(ctx, ...)`), along with the constants and the pure helper
`claimOpensAt`.

## Before You Start

- **Connect a price source.** Shares are priced at the fund's value at the mark, so quotes,
  the budget and both exit calls on a live market use the live Pyth price. Without `prices` on
  `Bazaar.connect`, the quotes and the budget throw a `ConnectError` unless you pass a `price`,
  `executeInsuranceWithdrawal` throws one on a live market because it needs a price update, and the
  exit plan leaves its estimates `null`.
- **Units.** USDC amounts are 18-decimal `bigint`s (1e18 = $1), floored to whole micro-USDC by the
  pair; use `parseUnits18("250")` and `formatUnits18(x, 2)`. Insurance shares are 18-decimal too.
  Times are unix seconds of the chain's clock. See [Units & Constants](../reference/units.md).
- **Writes are `PreparedCall`s.** Simulate each as the LP, then send it with the wallet
  ([Sending Transactions](sending.md)). Calls that carry a price update have a `priceTime` and must
  land within 3 seconds of it, so build them right before the wallet prompt (`buildAndSend`).

## Reading an LP's Position

```ts
{{#include ../../examples/protocol/insurance-deposit.ts:read}}
```

| Function | Returns |
|---|---|
| `getInsuranceSharePrice(pair)` | What one share redeems for at the pair's **stored** mark (1.0 while no shares exist). |
| `getInsuranceDepositValue(pair, user)` | What `user`'s shares redeem for at the stored mark. |
| `insuranceShares(pair, user)` | `user`'s shares. 0 for a balance a fund recapitalization wiped (see [Share Epochs](#share-epochs-and-voided-requests)). |
| `quoteInsuranceDeposit(pair, amount, { price? })` | Shares a deposit would mint at the live price. |
| `quoteInsuranceWithdrawal(pair, shareAmount, { price? })` | USDC a redemption would pay at the live price. |

The first two read the lens at the price the pair last stored, which can be minutes old on a quiet
market. For anything the LP will act on, use the quotes: they compose the live price from the price
source the way the oracle composes it, so they match what a call carrying that price will do.

The market's fund as a whole (balance, free capital, the seizure earmarked against inventory, the
target ratio) is in `marketSnapshot(...).insurance`; see [Markets](markets.md).

## Quotes

```ts
{{#include ../../examples/protocol/insurance-deposit.ts:quote}}
```

Both quotes return an `InsuranceQuote`:

| Field | Meaning |
|---|---|
| `value` | Shares minted (deposit) or USDC paid (withdrawal), 18 decimals. |
| `price` | The mark it was priced at. |
| `publishTime` | The live update's publish time, or `null` when you passed `price`. |

Pass `{ price }` to quote at a price of your own (for "what if" displays); it must be positive.

`quoteInsuranceDeposit` floors the amount to micro-USDC as the pair does and runs the lens's
`quoteInsuranceDeposit`, the pair's own arithmetic. It ignores the deposit's gates (the minimum, the
market's state, the rate limit) and returns 0 where the fund's value is nil.
`quoteInsuranceWithdrawal` is what the shares are worth now; a locked exit's paying call pays the
lower of this and the locked amount, and while the vault holds liquidated inventory no more than the
fund's headroom.

## Depositing

```ts
{{#include ../../examples/protocol/insurance-deposit.ts:deposit}}
```

`depositToInsurance(pair, from, amount, opts?)` builds the deposit. The amount is floored to whole
micro-USDC and pulled from the wallet, so the wallet needs that much USDC approved to the pair (the
sample approves exactly `pullsUsdc`) or a USDC permit passed as `permitData`; see
[Collateral, Approvals & Permits](collateral.md).

| Option | Default | Meaning |
|---|---|---|
| `withPrice` | attach when a price source is connected | `false` sends no price update. The pair reads a price only while its vault holds liquidated inventory, and then needs a fresh one; an update it does not read has its fee refunded. `true` requires one (a `ConnectError` without a price source). |
| `permitData` | `"0x"` | A signed USDC permit, so no separate approval transaction is needed. |

The builder refuses up front, with an `InputError`:

- an amount under 5 USDC (`MIN_INSURANCE_DEPOSIT`) or above 2^128 - 1 (`MAX_INSURANCE_DEPOSIT`);
- a terminated market, a market whose settlement price is fixed, and a market within 6 seconds of
  a scheduled cutoff;
- a market with an ADL window pending.

The contract also refuses more than 100 deposits per user in four days
(`InsuranceVaultLib__TooManyRecentInsuranceDeposits`) and a deposit whose price would open an ADL
window. Those show up in the simulation.

The returned call's `pullsUsdc` is the floored amount, and `value` is the Pyth fee when a price
update is attached.

## Leaving the Fund

An exit on a live market takes three transactions, spread over at least 13 days:

1. **Request** (`requestInsuranceWithdrawal`): starts a 13-day cooldown. Moves no USDC.
2. **Lock** (the first `executeInsuranceWithdrawal` in the window): once the cooldown ends, an
   execution window opens: 2 days on a market that trades around the clock, 4 days on a market with
   trading hours. The first execute call in it records what the requested shares are worth and pays
   nothing.
3. **Pay** (the next `executeInsuranceWithdrawal`): from 5 minutes after the lock, it burns the
   shares and pays the lower of the locked amount and what they are worth then. The paying call is
   pushed back to 5 minutes after the last stored price that jumped 2% or more, and to 30 minutes
   after the last stored price that ended a gap of an hour or more.

On a terminated market the request is followed by a single execute call that pays at once.

| Constant | Value | Meaning |
|---|---|---|
| `INSURANCE_WITHDRAWAL_COOLDOWN` | 13 days | From the request to the window. |
| `INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS` | 2 days | The window on a 24/7 market. |
| `INSURANCE_WITHDRAWAL_WINDOW_SESSION` | 4 days | The window on a market with trading hours. |
| `INSURANCE_WITHDRAWAL_CLAIM_DELAY` | 300 s | From the lock (and from the last 2% jump) to the paying call. |
| `INSURANCE_WITHDRAWAL_REOPEN_CLAIM_DELAY` | 1,800 s | From the end of a price gap to the paying call. |
| `REOPEN_GAP_MIN_STALENESS` | 3,600 s | A stored price after this long without one ends a gap. |

`withdrawalWindowOf(continuous)` returns the window for a market, and
`claimOpensAt(lockTs, lastGapTs, lastJumpTs)` is the pair's own rule for when the paying call opens.

### Requesting

`requestInsuranceWithdrawal(pair, from, shareAmount)` files the request. `shareAmount` is in shares
(18 decimals) and must be positive and no more than the LP holds; the builder refuses an LP with no
shares. Filing again **replaces** a pending request and restarts its cooldown, and a lock the
earlier request made no longer counts; the call's `summary` says so when a request is pending.

Shares that back an insurer termination vote cannot leave while the vote holds them. Request no more
than `shares - lockedForVoting` from the [exit plan](#the-exit-plan), or the execute calls are
refused with `InsuranceVaultLib__SharesLockedForVoting`.

### The Lock and the Paying Call

`executeInsuranceWithdrawal(pair, from, opts?)` builds whichever execute call comes next. It reads
the exit plan first and refuses with an `InputError` carrying the plan's message when no execute call
can land now (still in the cooldown, waiting for the claim to open, the window closed, a freeze).
The `summary` says which call it is:

- the lock: "Lock your withdrawal of ... shares (pays nothing; collect it from ... later)";
- the paying call: "Collect your insurance withdrawal (at most ... USDC)";
- on a terminated market: "Redeem ... insurance shares".

Both calls on a live market need a fresh price, so the update is attached when a price source is
connected (`withPrice: false` sends none, and the call then reverts on a live market). On a market
with trading hours that means they can land only while its venue trades. On a terminated market no
price is read, so none is attached unless you pass `withPrice: true`.

While the vault holds liquidated inventory, a paying call is held to the fund's **headroom**: it may
pay part of the claim and leave the rest requested, under the same lock scaled to it, for another
paying call later in the window. Run the exit plan again after each paying call.

### The Exit Plan

```ts
{{#include ../../examples/protocol/insurance-exit.ts:plan}}
```

`insuranceExitPlan(pair, user, { quote? })` reads everything the exit depends on in one batch (the
shares, the request and its share epoch, the lock, the market's state, the price-gap clocks, the
vault's inventory, the shares locked by votes) and says where the LP stands. `step` is one of:

| Step | Meaning | `nextAction` |
|---|---|---|
| `none` | No shares and no request. | `null` |
| `request` | No request yet, or only a voided one (see [Share Epochs](#share-epochs-and-voided-requests)). On a terminated market the redemption then pays at once. | `requestInsuranceWithdrawal` |
| `cooldown` | Requested; the window opens at `nextCallAt`. | `executeInsuranceWithdrawal` |
| `lock` | The window is open; the next execute locks and pays nothing. | `executeInsuranceWithdrawal` |
| `waitClaim` | Locked; the paying call opens at `nextCallAt`. | `executeInsuranceWithdrawal` |
| `claim` | Locked and open: the next execute pays. | `executeInsuranceWithdrawal` |
| `redeem` | Terminated market: the next execute pays. | `executeInsuranceWithdrawal` |
| `expired` | The window closed, too little of it is left to lock and collect, or a price move pushed the claim past its end. Request again. | `requestInsuranceWithdrawal` |
| `blocked` | No exit call can land now: the settlement window, the 6 seconds before a cutoff, the settlement of open positions after finalize, or shares committed to a vote. `nextCallAt` says when, where it is known. | varies |

The plan's fields:

| Field | Meaning |
|---|---|
| `message` | One line for the LP, with the waits written out ("9 d 4 h"). |
| `nextAction` | The function to call next, or `null`. |
| `nextCallAt` | The earliest chain time the next call can land (`now` when it can land now), or `null`. |
| `nextCallBy` | The latest chain time it can land, or `null` for no limit. For a lock this is the window's end less the 5-minute claim delay. |
| `now` | The chain time of this reading. |
| `shares`, `requestedShares` | The LP's shares, and those in the live request (0 without one). |
| `lockedForVoting` | Shares committed to insurer votes, which the exit cannot take. |
| `requestTs`, `windowOpensTs`, `windowEndTs` | The request and its window, or `null`. |
| `lockTs`, `lockedAmount`, `claimOpensTs` | The lock, once made. For the `lock` step `claimOpensTs` is when a lock made now would open its claim. |
| `payoutEstimate` | For `lock`, `waitClaim`, `claim` and `redeem`, with a price source: the most the paying call would pay now (the lower of the locked amount and the live value). |
| `budgetRemaining` | The shared budget left, with a price source; `null` when unlimited or unknown. |
| `notes` | What can still hold the paying call back: trading hours, an open ADL window, inventory in the vault, shares locked by a vote. |

`{ quote: false }` skips the price reads (`payoutEstimate` and `budgetRemaining` stay `null`), which
is what `executeInsuranceWithdrawal` does internally. Without a price source they are `null` too.
Every time is the chain's: compare against `now`, not the browser's clock.

### Taking the Next Step

```ts
{{#include ../../examples/protocol/insurance-exit.ts:next}}
```

A UI can run the plan on a timer and enable one button: "Request withdrawal" for `request` and
`expired`, "Lock" for `lock`, "Collect" for `claim` and `redeem`, a countdown to `nextCallAt` for
`cooldown` and `waitClaim`. Remind LPs that the window is short (2 or 4 days) and the lock and
the paying call must both land inside it.

## Budgets and Locks

```ts
{{#include ../../examples/protocol/insurance-exit.ts:budget}}
```

`getInsuranceWithdrawalBudget(pair, { price? })` is the lens's reading of the market's shared 6-hour
withdrawal budget at the live price (or `price`): the number a paying call is checked against, as of
now. It is a reading, not a reservation. Every LP on the market draws on the same budget, and the
check runs at the paying call, not at the request or the lock.

| Field | Meaning |
|---|---|
| `remaining` | What the current period still admits, 18 decimals. |
| `cap` | The period's budget. |
| `resetsAt` | When the period ends and the budget refills; `null` when unlimited. |
| `unlimited` | No limit applies: the market is terminated or has no open interest. |
| `coverageRatioBp` | Free capital over open-interest notional, in basis points. |
| `targetRatioBp` | The live target; below it the stricter budget applies. |
| `price` | The price it was read at. |

`getInsuranceWithdrawalLock(pair, user)` is the lens's view of the two execute calls: `isLocked`,
`lockedAmount` (the most the paying call pays), `lockTs`, `claimOpensTs` (a later price jump or reopen
pushes it back) and `windowEndTs` (0 without a request).

`getInsuranceWithdrawalConstants()` reads the protocol's terms from the lens: `cooldown`,
`continuousWindow`, `sessionWindow` and `rateLimitPeriod` in seconds, and `rateLimitBp`,
`aboveTargetRateLimitBp`, `aboveTargetFundCapBp` and `belowTargetFundCapBp` in basis points.

## Share Epochs and Voided Requests

When bad debt drains a fund below $1, the next deposit starts a new **share epoch**: balances from
before the drain read as zero, and the rescuer is minted shares 1:1 against their own deposit. A
withdrawal request is stamped with the epoch it was filed in, and the pair refuses to execute one from
an earlier epoch (`InsuranceVaultLib__WithdrawalRequestStaleEpoch`).

The SDK reads the epoch with the request, so a voided request is no request at all: the plan reports
`request` (or `none` when the LP holds no shares in the new epoch) and its `message` starts with
"Your earlier withdrawal request was voided when the insurance fund was recapitalized.", and
`requestInsuranceWithdrawal` describes a new request rather than a replacement.

## On a Terminated Market

After `finalizeTermination`, the fund is whatever remains once every trader is paid, and its shares
redeem against that residual. The plan reports `request` and then `redeem`, and one execute call pays
with no price update.

If finalize ran through the 14-day escape hatch with positions still open, redemptions wait until
those positions are settled (anyone can settle them; see
[Termination & Settlement](termination.md#the-settlement-window)), or 28 days after the settlement
price was fixed at the latest. The plan reports `blocked` with that time as `nextCallAt`.

Insurers also take part in ending a market: voting shares for an insurer termination locks them,
and some outcomes levy part of them. See [Insurer Votes](termination.md#insurer-votes).

## Gasless

All three LP calls have relayed forms (`depositToInsurance`, `requestInsuranceWithdrawal`,
`executeInsuranceWithdrawal`), signed with `bz.relay.signRelayed` like any other action; see
[Gasless Trading & Relayers](gasless.md). A relayed deposit pulls the amount plus the relayer fee from
the wallet. A relayed request and a relayed lock pay their fee from the wallet too (the lock pays
nothing out), so they need an allowance or a permit; a relayed paying call takes its fee out of the
payout.

## What Can Go Wrong

Builder refusals are `InputError`s whose `field` names the argument (`amount`, `shareAmount`,
`pair`); `errorMessage(e)` turns them and every decoded revert into one sentence. The contract errors
an LP is most likely to see in a simulation:

| Error | Meaning |
|---|---|
| `InsuranceVaultLib__CooldownNotElapsed` | The 13-day cooldown has not ended. |
| `InsuranceVaultLib__ClaimNotOpen` | Locked; the paying call opens at `claimOpensTs`. |
| `InsuranceVaultLib__LockTooLate` | The claim a lock would open could only open after the window closes. Request again. |
| `InsuranceVaultLib__WithdrawalWindowExpired` | The window closed. Request again. |
| `InsuranceVaultLib__NoWithdrawalRequest` | No request to execute. |
| `InsuranceVaultLib__WithdrawalRequestStaleEpoch` | The request predates a fund recapitalization. |
| `InsuranceVaultLib__RateLimitExceeded` | The shared 6-hour budget is used up. Withdraw less or wait for `resetsAt`. |
| `InsuranceVaultLib__AdlBlocking` | The fund's headroom cannot pay any of the claim (ADL due or running). |
| `InsuranceVaultLib__VaultUnhealthy` | Exits are paused while the market is unhealthy. |
| `InsuranceVaultLib__SharesLockedForVoting` | Shares in the request back an open termination vote. |
| `InsuranceVaultLib__SweepIncomplete` | After an escape-hatch finalize, positions are still being settled. |
| `InsuranceVaultLib__PairScheduledForTermination` | Within 6 seconds of a scheduled cutoff, or settling. |
| `InsuranceVaultLib__TooManyRecentInsuranceDeposits` | More than 100 deposits in four days. |
| `InsuranceVaultLib__DepositTooSmall` | The deposit buys no shares. |
| `BazaarPair__InsufficientPythFee` | The price update's fee changed; rebuild the call. |

A call that carries a price update and lands more than 3 seconds after its `priceTime` is refused:
rebuild it and send again. See [Errors & Messages](errors.md).

## History

Bazaar's subgraph records every insurance event: `bz.history.insuranceEvents` (deposits, requests,
locks and payouts), `insuranceProviders` (each LP's position per market) and `insurerLevies`. See
[History](history.md).

## Related

- [Termination & Settlement](termination.md): insurer votes, and what a terminated market pays.
- [Markets](markets.md): the fund's balance, target and coverage in a market snapshot.
- [Collateral, Approvals & Permits](collateral.md): approving USDC, or signing a permit.
- [Insurance Fund](https://docs.bazaar.finance/protocol/insurance.html) in Bazaar's docs.
