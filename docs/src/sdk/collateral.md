# Collateral, Approvals & Permits

Each Bazaar market (pair) keeps its own collateral for each account: USDC deposited into the account's
position bucket on that pair, which backs its position and its resting orders. This page covers moving
USDC in and out, the allowance a deposit or a keeper bounty needs, USDC permits as a signed alternative
to an approve transaction, and what stops a withdrawal.

The samples assume `bz` connected as in [Connecting](connecting.md), `user` the wallet's address, `eth`
a market from [Markets](markets.md), and a `run(call)` helper that simulates, sends and waits as on
[Sending Transactions](sending.md). For the margin rules that decide how much collateral a position
needs, see [Margin](https://docs.bazaar.finance/protocol/margin.html).

## Units

Two precisions meet here:

- **BAZAAR precision** (18 decimals, `1e18` = $1): every amount the pair takes or reports, including
  `PreparedCall.pullsUsdc`. The pair floors what it moves to whole micro-USDC (multiples of `1e12`).
- **USDC units** (6 decimals): what USDC's own functions count in: `balanceOf`, `allowance`, `approve`,
  `permit`. Every function in the `allowance` and `permits` areas takes and returns USDC units.

```ts
{{#include ../../examples/trading/collateral.ts:units}}
```

| Helper | Converts |
|---|---|
| `parseUnits18("12.5")` | A decimal string to BAZAAR precision. Throws `UnitError` on more than 18 decimals. |
| `formatUnits18(x, maxDecimals?)` | BAZAAR precision to a decimal string, trailing zeros trimmed. |
| `toUsdcUnits(x)` | BAZAAR precision to USDC units, floored as the pair floors it. |
| `toUsdcUnitsCeil(x)` | BAZAAR precision to USDC units, rounded up: for an allowance or permit that must cover a pull. |
| `fromUsdcUnits(x)` | USDC units to BAZAAR precision. |
| `floorToUsdc(x)` | BAZAAR precision floored to a multiple of `1e12`: what the pair actually moves. |
| `allowance.formatUsdcUnits(x)` | USDC units to a decimal string. |

[Units & Constants](../reference/units.md) lists the rest.

## Depositing

`bz.trade.depositCollateral(pair, from, amount, opts?)` builds a deposit of `amount` (BAZAAR precision)
into `from`'s bucket on `pair`. The pair pulls the USDC from the wallet, so the wallet needs that much
approved to the pair, or a permit carried in the call.

| Argument | Meaning |
|---|---|
| `pair` | The market's pair address (`eth.address`). It must be one of the deployment's pairs: any other address is refused with `InputError` on `pair` before anything is built. |
| `from` | The depositing account. The collateral is credited to it. |
| `amount` | BAZAAR precision. Floored to whole micro-USDC first; at least 5 USDC after flooring, or `InputError` on `amount` ("The minimum deposit is 5 USDC."). |
| `opts.permitData` | A USDC permit (`SignedPermit.permitData`) the pair executes before it pulls. Default `"0x"`, none. |

The call's `pullsUsdc` is the floored amount; its `summary` reads `Deposit 100 USDC as collateral`. It
carries no price update and sends no ETH.

The pair refuses a deposit once the market is terminated (`CollateralLib__DepositsAreBlocked`), in the
seconds before a scheduled termination cutoff, and while its settlement window is open. The builder does
not check these; the simulation reports them.

### Checking Balance and Allowance

```ts
{{#include ../../examples/trading/collateral.ts:deposit-approve}}
```

| Function | Returns |
|---|---|
| `bz.allowance.usdcBalance(owner)` | The owner's USDC balance, in USDC units. |
| `bz.allowance.usdcAllowance(owner, spender)` | What `spender` (a pair) may pull from `owner`, in USDC units. |
| `bz.allowance.usdcFunding(owner, spender, pullBazaar)` | Balance and allowance against a pull, in one batched read (below). |

`usdcFunding` takes the pull in BAZAAR precision (pass `call.pullsUsdc`) and returns:

| Field | Meaning |
|---|---|
| `needUsdc` | The pull in USDC units, rounded up. |
| `balance` | The wallet's USDC balance. |
| `allowance` | What the pair may pull now. |
| `enoughBalance` | `balance >= needUsdc`. |
| `enoughAllowance` | `allowance >= needUsdc`. |
| `approveUsdc` | What to approve: `needUsdc` when the allowance falls short, else `0n`. It is the whole amount, not the difference, because an approval replaces the previous one. |

Without enough allowance the pull fails inside USDC's `transferFrom` with the token's own revert (on
native USDC, `ERC20: transfer amount exceeds allowance`), so check before simulating, and wait for the
approval's receipt before simulating the deposit.

### Approving USDC

`bz.allowance.approveUsdc(owner, spender, amountUsdc, opts?)` builds USDC's `approve(spender, value)`
from `owner`, as a `PreparedCall` to the USDC contract (`action: "approve"`).

| Argument | Meaning |
|---|---|
| `owner` | The wallet giving the allowance (the call's `from`). |
| `spender` | A pair of this deployment. Anything else is refused with `InputError` on `pair`, revocations included, so a link cannot pass another contract off as a market. |
| `amountUsdc` | USDC units. `0n` revokes. Ignored with `unlimited`. |
| `opts.unlimited` | Approve `2^256 - 1`. Default false. |

```ts
{{#include ../../examples/trading/collateral.ts:unlimited}}
```

**Exact approvals are the default on purpose.** An unlimited approval saves one approve transaction per
deposit, but it leaves the whole wallet balance pullable by that contract for as long as the approval
stands. Offer it only as the user's explicit choice, say what it means, and give them a way to revoke it
(`approveUsdc(owner, pair, 0n)`). Each pair pulls for itself, so every market needs its own allowance.

Approvals and deposits are two transactions. A permit makes them one.

## USDC Permits

A permit (ERC-2612) is an approval the user signs instead of sending. The pair call carries it in
`permitData` and executes it just before it pulls, so the user signs once and sends once, and on the
gasless path needs no ETH at all.

```ts
{{#include ../../examples/trading/collateral.ts:deposit-permit}}
```

`bz.permits.signPermit(wallet, req)` asks the wallet to sign a USDC permit with
`eth_signTypedData_v4`, so the wallet shows every field.

| `req` field | Default | Meaning |
|---|---|---|
| `owner` | required | The signing wallet's address. |
| `spender` | required | The pair that will pull. Must be one of the deployment's pairs, or `InputError` on `pair` before the wallet is asked. |
| `value` | required | USDC units, more than zero. `permits.permitValueFor(pullBazaar)` converts a BAZAAR-precision pull, rounded up. |
| `deadline` | 30 minutes | Unix seconds. The default is `DEFAULT_PERMIT_WINDOW` (1800 s) past the lower of the chain's time and the device's clock. |
| `nonce` | read | The owner's permit nonce on USDC; read from the token unless given. |

It returns a `SignedPermit`: the message (`owner`, `spender`, `value`, `nonce`, `deadline`), the
`signature` and its `v`, `r`, `s`, and `permitData`, the
`abi.encode(value, deadline, v, r, s)` the pair call takes.

Rules a permit follows:

- **It sets the allowance; it does not add to it.** `value` must cover everything the call pulls, and
  a permit signed when a larger allowance is in place replaces that allowance with the smaller one.
  Check `usdcAllowance` first, as the sample does. (`signRelayed` makes that check for you on the
  gasless path.)
- **It is best effort.** A permit that fails (expired, already used, front-run) does not fail the call:
  the pair emits `PermitExecutionFailed` and falls back to the allowance already in place, so the call
  then succeeds or fails on that allowance.
- **One at a time.** Each permit uses the owner's next USDC nonce. Sign one, submit the call that
  carries it, and only then sign the next; two permits signed in a row share a nonce and the second
  fails.
- **What it must cover**, by call:

  | Call | The permit covers |
  |---|---|
  | `depositCollateral`, `depositToInsurance` | The deposit (plus the relayer fee when relayed). |
  | `createOrder` | The trigger order's keeper bounty (plus the relayer fee when relayed). |
  | `cancelOrders`, `amendOrders`, `requestInsuranceWithdrawal`, the locking `executeInsuranceWithdrawal` | The relayer fee alone. A direct call of these pulls nothing and ignores a permit. |
  | `withdrawCollateral`, the paying `executeInsuranceWithdrawal` | Takes no permit: the fee comes out of the payout. |

- **Only an account's own signature works.** The SDK recovers the signature locally and refuses one
  that does not recover to `owner` (`SigningError`), which is what a smart-contract wallet signing
  through ERC-1271 produces. Smart accounts approve with an `approve` call instead, usually in the same
  batch ([Smart Accounts & Batching](batching.md)).
- **The wallet must be on the deployment's chain**: the permit's domain names the chain id, and wallets
  refuse to sign for another one.
- **The deadline is counted from a checked clock.** The SDK takes the lower of the latest block's
  timestamp and the device's clock, and refuses with `ClockSkewError` when they disagree by more than 2
  minutes (`MAX_CLOCK_SKEW`), so an RPC reporting a far-future block cannot stretch a permit's life.
  Local development chains (chain ids 31337 and 1337) skip the check.

The lower-level pieces are in the `permits` namespace: `usdcPermitDomain(ctx)` (USDC's EIP-712 domain,
checked against the token's own `DOMAIN_SEPARATOR()`), `permitNonce(ctx, owner)`,
`permitTypedData(domain, msg)`, `encodePermitData(value, deadline, v, r, s)`, `decodePermitData(data)`,
and `checkPermit(ctx, permitData, { owner, spender, needUsdc })`, which a relayer uses to check a
permit it received (see [Gasless Trading & Relayers](gasless.md#verifying)).

## Withdrawing

`bz.trade.withdrawCollateral(pair, from, amount, opts?)` withdraws `amount` (BAZAAR precision) from
`from`'s bucket to the wallet, which receives it floored to micro-USDC.

```ts
{{#include ../../examples/trading/collateral.ts:withdraw}}
```

| Argument | Meaning |
|---|---|
| `amount` | More than zero, or `InputError` on `amount`. |
| `opts.withPrice` | Whether to attach a Pyth update. Default: attached whenever the connection has a price source with an update the oracle would accept (the pair refunds the fee when it does not read the price); without one, a flat account's withdrawal goes without and one with exposure is refused on a continuously traded market (`NoFreshPriceError`). `false` attaches none. `true` requires a price source and a fresh price. |

An account with a position or resting orders is priced fresh: the pair keeps the position's margin, its
resting orders' reservation and a minimum behind, and refuses its stored fallback price for a position
holder. A flat account with no orders reads no price. Without a price source, the builder refuses
(`ConnectError`) for an account that needs a price.

The most an account can withdraw right now is `previewWithdrawal(...).maxWithdrawable`, also on the
account snapshot as `maxWithdrawable` ([Accounts & Portfolios](accounts.md)). Use
[`previewWithdrawal`](previews.md#previewwithdrawal) to tell a user why a larger amount is refused.

### Withdrawal Freezes

Some states stop withdrawals whatever the account holds. `previewWithdrawal` lists the ones that apply
in `freezes`, each with its error name, a user message and, when known, `until` (when it lifts at the
latest, unix seconds). The account snapshot's `withdrawalBlocked` and the market's flags
(`positionWithdrawalsFrozen`, `allWithdrawalsPaused`, with `reasons`) report the same states for a UI
to grey out its button ([Markets](markets.md)).

| Freeze | Who | Lifts |
|---|---|---|
| An auto-deleveraging window is open (`BazaarPair__WithdrawalsFrozenAdlPending`) | Accounts with a position | When ADL resolves, or the market terminates (at most 24 hours plus a 30-minute grace). |
| The settlement price is fixed and the termination is not finalized (`BazaarPair__SweepWindowActive`) | Everyone | At finalization, at most 14 days after the price was fixed. |
| Limbo, the seconds before a scheduled termination cutoff (`CollateralLib__PairScheduledForTermination`) | Everyone | When the settlement price is fixed, the settlement window (the row above) takes over. |
| The vault has realized bad debt (`CollateralLib__WithdrawalBlockedVaultUnhealthy`) | Accounts that are priced (a position or orders) | When the market settles. |
| A market with trading hours whose venue is closed (`CollateralLib__WithdrawalRequiresFreshPrice`) | Accounts with a position | With the first fresh price at the reopen. |

The ledger can also be short: no withdrawal may exceed the pair's deposits ledger
(`CollateralLib__LedgerShortfall`), which `previewWithdrawal` reports in `ledgerAvailable`. For the
mechanics behind each freeze see [Margin](https://docs.bazaar.finance/protocol/margin.html),
[Termination](https://docs.bazaar.finance/protocol/termination.html) and
[Oracle](https://docs.bazaar.finance/protocol/oracle.html).

### Terminated-Pair Payouts

Once a market is terminated and finalized, a withdrawal pays `amount × principalRatio`, the share of
collateral the market's estate can pay (1e18 = 100%). `withdrawCollateral` reads the ratio and puts the
payout in the call's summary:

```ts
{{#include ../../examples/trading/collateral.ts:terminal}}
```

`trade.terminalWithdrawal(ctx, pair, user, amount)` returns `{ payout, principalRatio }` on a
terminated pair and `null` on a live one; it is not bound on `bz`, so call it with `bz.ctx`. A
withdrawal that would pay nothing is refused (`InputError` on `amount`). Registered profit claims are
paid at the separate `profitRatio`; `previewWithdrawal(...).terminal` and the account snapshot's
`terminal` give the whole entitlement. [Termination & Settlement](termination.md) covers the rest.

## The Testnet Faucet

On a testnet deployment USDC is Bazaar's test token, whose faucet pays 10,000 test USDC to the caller
at most once a day per address. `bz.allowance.faucetStatus(user)` says whether `user` can claim now
(`available`, `canClaimNow`, `nextClaimTs`, `amountUsdc`, judged at the latest block's time), and
`bz.allowance.claimFaucet(user)` builds the claim, a `PreparedCall` the wallet sends and pays the gas
for:

```ts
const faucet = await bz.allowance.faucetStatus(user);
if (faucet.canClaimNow) await run(await bz.allowance.claimFaucet(user));
```

`claimFaucet` refuses, with an `InputError` on `owner`, while the address waits out its cooldown (with
the time it ends) and on a deployment whose USDC has no faucet, which `faucetStatus` reports as
`available: false`.

## What Can Go Wrong

| You see | It means |
|---|---|
| `InputError` on `amount`: "The minimum deposit is 5 USDC." | The deposit, floored to micro-USDC, is under 5 USDC. |
| `InputError` on `pair`: "... is not a market of this Bazaar deployment ..." | The address is not one of the factory's pairs. Nothing was built or signed. |
| `Error`: "ERC20: transfer amount exceeds allowance" (or "... balance") | USDC refused the pull: approve or permit first, or the wallet holds too little. |
| `CollateralLib__InvalidDepositAmount` | The pair's own minimum check. |
| `CollateralLib__InsufficientMarginAfterWithdrawal`, `CollateralLib__MustRetainMinimumCollateral` | The withdrawal would leave the position or orders under-margined. Withdraw less (`maxWithdrawable`). |
| `ConnectError`: "this call needs a fresh Pyth price" | The account needs a priced withdrawal and the connection has no price source. |
| `ClockSkewError` | The device's clock and the chain's time disagree by more than 2 minutes; nothing was signed. |
| `SigningError`: "You declined the signature." | The user rejected the permit prompt. |

See [Errors & Messages](errors.md) for how to show these.

## Related Pages

- [Placing Orders](orders.md): orders pull a keeper bounty from the wallet, too.
- [Previews](previews.md): the withdrawal ceiling and every reason it binds.
- [Gasless Trading & Relayers](gasless.md): deposits and withdrawals without ETH.
- [Insurance](insurance.md): the other pool of USDC on each pair.
