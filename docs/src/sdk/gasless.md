# Gasless Trading & Relayers

Eight actions on a pair can be signed instead of sent: the user signs an EIP-712 request in their
wallet, and a **relayer** submits it from its own account. The relayer pays the gas and the Pyth fee in
ETH; the pair credits it the `relayerFee` the user signed, in USDC, on its claimable balance. With a
USDC permit riding along, a user needs no ETH and no approve transaction at all.

| Relayable | Not relayable |
|---|---|
| `depositCollateral`, `withdrawCollateral`, `createOrder`, `cancelOrders`, `amendOrders`, `depositToInsurance`, `requestInsuranceWithdrawal`, `executeInsuranceWithdrawal` | `claimFees`, `executeTriggeredOrders`, and everything outside the pair (approvals, termination, listings). |

Gasless calls also solve the [3-second price window](sending.md#the-3-second-price-window) for
browser users: the price update is not part of what the user signs, so the relayer attaches a fresh one
when it submits, however long the user took to approve.

This page covers both sides: signing on the frontend, and a complete relayer server. The protocol's
rules are in [Gasless Transactions](https://docs.bazaar.finance/protocol/meta-transactions.html). The
samples assume `bz` connected as in [Connecting](connecting.md), `user` the wallet's address and `eth`
a market.

## How It Works

1. **The frontend** calls `bz.relay.signRelayed(input, opts)`. It checks the action against the chain
   (as the direct builders do), signs a USDC permit first if asked, then has the wallet sign the
   request, and returns a `RelayedRequest`.
2. **It posts** `relay.serializeRelayed(req)` (JSON) to the relayer, at once: the request is valid for
   at most 10 seconds.
3. **The relayer** parses it (`relay.parseRelayed`), checks it (`bz.relay.verifyRelayed`), builds the
   call with a fresh price update and fresh book hints (`bz.relay.encodeRelayed`), and sends it from its
   own key.
4. **The pair** recovers the signer from the signature, acts as them, pulls the fee from their wallet
   (or nets it from a payout) and credits it to whoever submitted the transaction.
5. **The relayer** collects its fees per pair with `claimFees`.

## Signing a Request

```ts
{{#include ../../examples/trading/gasless-client.ts:submit}}
```

```ts
{{#include ../../examples/trading/gasless-client.ts:sign-order}}
```

`bz.relay.signRelayed(input, opts)` takes what to do as `input`, one of:

| `input` | Signs |
|---|---|
| `{ action: "createOrder", order }` | An `OrderInput` ([Placing Orders](orders.md#the-order)), checked against the chain as `prepareOrder` does, with the connection's `integrator`. |
| `{ action: "amendOrders", amendments }` | `AmendInput[]` ([Managing Orders](managing-orders.md#amending)), checked and given hints as `prepareAmends` does. |
| `{ action: "depositCollateral", amount }`, `{ action: "withdrawCollateral", amount }`, `{ action: "depositToInsurance", amount }` | An amount in BAZAAR precision. Deposits are floored to micro-USDC first. |
| `{ action: "requestInsuranceWithdrawal", shareAmount }`, `{ action: "executeInsuranceWithdrawal" }` | See [Insurance](insurance.md). |
| `{ action: "cancelOrders", orderIds }` | 1 to 200 distinct order ids. |
| `{ action: "createOrder", spec }`, `{ action: "amendOrders", amends }` | An already built `OrderSpec`, or the flat amendment words, signed as given. |

| Option | Default | Meaning |
|---|---|---|
| `wallet` | required | The user's EIP-1193 provider. |
| `signer` | required | The user's address. The wallet must sign as it. |
| `pair` | required | The market's pair. It is the domain the user signs under and the permit's spender, so it must be one of the deployment's pairs (`InputError` on `pair` otherwise, before anything is asked). |
| `relayerFee` | `0n` | What the relayer charges, BAZAAR precision, at most $1. Floored to micro-USDC before signing, so the signed fee is exactly what is charged. |
| `deadlineWindow` | 10 | Seconds the signature stays valid, at most the deployment's window (10). |
| `nonce` | read | The nonce to sign. Read from the pair when omitted; pass it to sign several requests in a row. |
| `permit` | none | `true`, or `{ value?, deadline?, always? }`: also sign a USDC permit for what the call takes from the wallet. See [Permits on the Gasless Path](#permits-on-the-gasless-path). |

What it does, in order:

1. Floors the fee, reads the deployment's fee cap and deadline window from the lens
   (`eip712Limits`, once per connection), and confirms the pair.
2. Resolves and checks the action: an order or amendments against the chain, a deposit's floor, a
   withdrawal on a terminated market against what it pays (`checkSignedFields`, below).
3. Signs the permit, when asked, as its own wallet prompt. This happens before the request's deadline is
   stamped, so the time the user spends on the permit prompt does not count against the 10 seconds.
4. Reads the nonce and stamps the deadline (`chainDeadline`).
5. Asks the wallet to sign the typed data with `eth_signTypedData_v4`, normalizes the signature and
   recovers it locally: a signature that does not recover to `signer` is refused (`SigningError`).

It returns a `RelayedRequest`: the signed fields (`action` and the action's own arguments), `pair`,
`chainId`, `signer`, `nonce`, `deadline` (unix seconds), `relayerFee` (floored), `signature` and
`permitData` (`"0x"` without a permit).

```ts
{{#include ../../examples/trading/gasless-client.ts:other-actions}}
```

### The Deadline Window

The pair accepts a signature only before its deadline and only if the deadline is at most 10 seconds
past the landing block's timestamp (`MAX_DEADLINE_WINDOW`), so a signed request cannot be stored and
used later. That makes the timing tight:

- **The deadline is counted from a checked clock**: the lower of the latest block's timestamp and the
  device's clock. If the two differ by more than 2 minutes (`MAX_CLOCK_SKEW`), `signRelayed` throws
  `ClockSkewError` and nothing is signed: an RPC reporting a block far in the future must not stretch a
  deadline. A device clock so far behind the chain that the deadline would already have passed by chain
  time is refused the same way. Local development chains (31337, 1337) use their own time unchecked.
- **The user has the window to approve the prompt.** The deadline is stamped just before the wallet is
  asked. If the user takes longer than the window, the request arrives expired: the relayer's check
  reports it (`deadline: expired 4 s ago`) and the pair would refuse it (`MetaTx__ExpiredDeadline`).
  Ask the user to sign again; do not retry the same request.
- **A device clock behind the chain shortens the window**: with the clock 4 seconds behind, a 10-second
  window leaves 6 seconds by chain time.
- **Post at once**, and the relayer must verify, encode and send at once.

`bz.signing.chainDeadline(windowSeconds?)` returns such a deadline for your own signing code, and
`signing.checkClockSkew(chainNow, localNow?)` the check alone.

### Nonces

Each signer has one nonce per pair (`metaTxNonces`), shared by every action, strictly sequential: a
request lands only at the signer's current nonce, and each landed request uses one.

- `signRelayed` reads it (`bz.signing.readMetaTxNonce(pair, user)`) unless you pass `nonce`.
- To sign several requests before any lands, pass consecutive nonces and submit them in nonce order; the
  relayer must land each before the next is valid.
- A request whose nonce was used (another request landed first) fails with `MetaTx__InvalidNonce`; sign
  it again.

```ts
{{#include ../../examples/trading/gasless-client.ts:sequence}}
```

### Fees

The fee is the relayer's price, agreed off chain: the frontend signs whatever the relayer charges, and
the relayer refuses requests below its price. The pair caps it at $1 per action (`MAX_RELAYER_FEE`,
checked against the lens's `maxRelayerFee`) and charges it at its USDC floor (`signing.floorRelayerFee`).

Where it comes from depends on the action:

| Action | The signer's wallet pays (`relay.relayedPull`) |
|---|---|
| `depositCollateral`, `depositToInsurance` | The deposit plus the fee. |
| `createOrder` | The fee plus the trigger order's keeper bounty. |
| `cancelOrders`, `amendOrders`, `requestInsuranceWithdrawal` | The fee. |
| `executeInsuranceWithdrawal` | The fee on the first, locking call; nothing on the paying call, whose fee comes out of the payout. |
| `withdrawCollateral` | Nothing: the fee comes out of the payout. On a terminated market whose payout ratio leaves 0, the fee comes from the wallet. |

`checkSignedFields(fields, relayerFee, terminalPayout?)` enforces the bounds that need no read, and
`signRelayed` and `verifyRelayed` both run it: deposits of at least 5 USDC that exceed the fee, a
withdrawal larger than the fee (or, on a terminated market, a payout larger than the fee), a non-zero
share amount, 1 to 200 distinct cancel ids, 1 to 32 well-formed amendments, and an order spec the order
rules accept. A withdrawal on a terminated market that would pay nothing is refused.

### Permits on the Gasless Path

`permit: true` signs a USDC permit for exactly what the call takes from the wallet
(`relayedPull`, rounded up to USDC units), so a user who has never approved anything can deposit,
trade, amend and cancel with signatures alone:

```ts
{{#include ../../examples/trading/gasless-client.ts:sign-deposit}}
```

| `permit` | Meaning |
|---|---|
| `true` | Sign a permit for the pull, unless the pair's current allowance already covers it. |
| `{ value }` | The permit's value in USDC units, instead of the pull. |
| `{ deadline }` | The permit's expiry, unix seconds (default 30 minutes). |
| `{ always: true }` | Sign one even when the allowance covers the pull. |

The allowance check matters because a permit sets the allowance to its value: one signed anyway would
replace a larger approval with this call's amount. A withdrawal takes no permit (`InputError` on
`permit`). See [USDC Permits](collateral.md#usdc-permits) for the rest of the rules, including signing
one permit at a time.

### Smart-Contract Wallets Cannot Sign

The pair verifies with plain ECDSA (`ECDSA.recover`) and acts for whatever address the signature
recovers to. A smart-contract wallet (a Safe, an ERC-4337 account) signs through ERC-1271, whose
signature recovers to some other address or to none. `signRelayed` catches this: it recovers the
signature locally and throws `SigningError` ("this wallet does not sign as a plain account. Gasless
calls need an account's own signature; send the transaction directly instead"). Smart accounts send
their calls directly, and can batch them: see [Smart Accounts & Batching](batching.md).

## The Wire Format

`relay.serializeRelayed(req)` is `JSON.stringify` with every `bigint` as a decimal string:

```json
{
  "action": "cancelOrders",
  "orderIds": ["42"],
  "pair": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "chainId": 42161,
  "signer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "nonce": "3",
  "deadline": 1762612345,
  "relayerFee": "50000000000000000",
  "signature": "0x1b2c...",
  "permitData": "0x"
}
```

A `createOrder` request carries `spec` (the `OrderSpec`, with its numbers as strings) instead of
`orderIds`; deposits and withdrawals carry `amount`, `amendOrders` `amends`, and
`requestInsuranceWithdrawal` `shareAmount`.

`relay.parseRelayed(body)` takes the JSON string (or an already parsed object) and returns a
`RelayedRequest`, checking every field's type and shape (`InputError` naming the field otherwise:
`"nonce: expected a non-negative integer"`). It canonicalizes the signature into the one form the pair
accepts (65 bytes, `v` 27 or 28): a `v` of 0 or 1 and a 64-byte EIP-2098 signature are converted, and a
high-s signature is refused. It does not verify the signature; that is `verifyRelayed`.

## Running a Relayer

A relayer is a small service with a funded key: ETH for gas and Pyth fees on the deployment's chain. It
earns USDC per request. The complete server below uses Node's own `node:http`; any HTTP framework works
the same way.

### Setup

```ts
{{#include ../../examples/trading/gasless-relayer.ts:setup}}
```

`bz.signing.verifyTypehashes(pair?)` compares every type string the SDK signs with the lens's
`getTypehashes()`, the domain's name and version hashes and the fee and deadline caps with
`getEip712Constants()`, and, given a pair, the domain separator with the pair's `DOMAIN_SEPARATOR()`. It
returns `{ ok, mismatches, typehashes, constants, domain? }`. Run it once at startup.

### Verifying

```ts
{{#include ../../examples/trading/gasless-relayer.ts:handle}}
```

`bz.relay.verifyRelayed(req)` checks everything that would make the call revert, and returns a
`RelayCheck` instead of throwing:

| Field | Meaning |
|---|---|
| `ok` | Safe to submit now: `problems` is empty. |
| `signer` | The address the signature recovers to, or `null`. |
| `problems` | `{ field, message }` for each thing that would revert: the pair is not the deployment's (nothing else is read then), the chain id, a signature that does not recover to `signer` over exactly these fields or is not in canonical form, a deadline that has passed or is more than 10 seconds ahead of chain time, a nonce that is not the signer's current one (used, or ahead: "an earlier request has to land first"), a fee above the cap, and the action's own bounds. |
| `warnings` | What would not revert by itself: a permit that would fail (wrong signer, used nonce, expired, too small, bad `v` or `s`), after which the call needs an allowance already in place; a terminated-market withdrawal that pays nothing, whose fee then comes from the wallet. |
| `secondsLeft` | Seconds until the deadline by chain time (negative once passed). |

`permits.checkPermit(ctx, permitData, { owner, spender, needUsdc })` is the permit part on its own,
returning `{ ok, problems, value }`.

### Encoding and Sending

`bz.relay.encodeRelayed(req, opts?)` builds the `PreparedCall` the relayer sends: the signed fields,
the signature and permit, plus what sits outside the signature, built now:

- a fresh price update for the actions that take one (`withdrawCollateral`, `depositToInsurance`,
  `executeInsuranceWithdrawal`, `createOrder`, `amendOrders`), with `value` its Pyth fee, which the
  relayer pays. `createOrder` and `amendOrders` always carry one, so the relayer's connection needs a
  price source;
- fresh `MatchHints` for `createOrder` (or `opts.hints`). A relayed order always walks the protocol's
  default budget. Amendment hints are inside the signed words and cannot change.

| Option | Meaning |
|---|---|
| `relayer` | The relayer's address, used as the call's `from` (so `bz.simulate(call)` runs as the relayer). Without it `from` is `null`. |
| `hints` | `MatchHints` for a `createOrder`, instead of the ones the SDK finds. |

The call's `pullsUsdc` is what it takes from the **signer's** wallet, and its summary reads
`Relay for 0x...: Buy 0.5 at 2950 (limit, GTC) (fee 0.05 USDC)`. It throws `InputError` for a request
signed for another chain or a signature not in canonical form (`parseRelayed` produces the canonical
form).

Send it at once, from the relayer's own key, as on
[Sending From a Bot](sending.md#sending-from-a-bot-with-a-local-key). Simulate first: the relayer pays
the gas of a call that reverts.

### Ordering

```ts
{{#include ../../examples/trading/gasless-relayer.ts:queue}}
```

Requests from one signer on one pair can only land in nonce order, so the server handles them one at a
time and waits for each to be mined before the next. Requests from different signers do not wait for
each other. The relayer's own transaction nonces are handled by viem's `nonceManager`.

### The Server

```ts
{{#include ../../examples/trading/gasless-relayer.ts:server}}
```

Limit body size and request rate: a request costs the relayer chain reads before it can be refused. Set
`access-control-allow-origin` to your frontend's origin.

### Claiming the Fees

```ts
{{#include ../../examples/trading/gasless-relayer.ts:claim}}
```

Fees accrue to the relayer's claimable balance on each pair, alongside any integrator fees if the
relayer's address is also the frontend's integrator. `claimFees` pays it all out and has no gasless
form ([Managing Orders](managing-orders.md#claiming-fees)).

## Lower-Level Pieces

The `signing` namespace has everything `signRelayed` is built from, for a relayer in another language or
a custom signer:

| Export | What it is |
|---|---|
| `TYPE_STRINGS`, `BAZAAR_TYPES` | The eight primary types, as strings and as viem / `eth_signTypedData_v4` field lists. |
| `pairDomain(chainId, pair)`, `domainSeparator(chainId, pair)` | The pair's EIP-712 domain (`"BazaarPair"`, version `"1"`) and its separator. |
| `typedDataFor(chainId, pair, fields, meta)` | The typed data a user signs. `typedDataJson(td)` is its JSON for `eth_signTypedData_v4`; `relayedDigest(td)` its digest. |
| `typeHash(primaryType)` | keccak256 of a type string. |
| `signTypedDataV4(wallet, signer, td)` | Sign through a wallet, normalized and checked to recover to `signer`. |
| `normalizeSignature(sig)` | A signature in the 65-byte, `v` 27/28, low-s form the pair accepts. |
| `encodePairWrite(fields, extra, meta)` | The calldata of any of the eight actions, direct or relayed. |
| `RELAYED_ACTIONS`, `PRIMARY_TYPE`, `takesPriceUpdate(action)` | The relayable actions, their primary types, and which take a price update. |
| `MAX_RELAYER_FEE`, `MAX_DEADLINE_WINDOW`, `MAX_CLOCK_SKEW`, `DEV_CHAIN_IDS` | $1, 10 s, 120 s, `[31337, 1337]`. |

In the `relay` namespace: `describeRelayed(fields)` (one line for a request), `relayedPull` and
`checkSignedFields` (above).

## What Can Go Wrong

| You see | It means |
|---|---|
| `SigningError`: "You declined the signature." | The user rejected the prompt. |
| `SigningError`: "... does not sign as a plain account ..." | A smart-contract wallet. Send directly instead. |
| `ClockSkewError` | The device's clock and the RPC's chain time disagree by more than 2 minutes. |
| `InputError` on `relayerFee`: "A relayer fee is at most $1 per action." | The fee cap. |
| `InputError` on `relayerFee`: "The relayer fee must be less than the deposit." | A deposit must exceed its fee. |
| `MetaTx__ExpiredDeadline` / `deadline: expired ...` | The request took longer than its window. Sign again. |
| `MetaTx__DeadlineTooFar` | A deadline more than 10 seconds ahead of the block. |
| `MetaTx__InvalidNonce` / `nonce: ... is already used` | Another request from this signer landed first. Sign again. |
| `nonce: ... is ahead of the signer's next nonce` | An earlier request has to land first. |
| `MetaTx__InvalidSignature` | The signature does not match the request (a field changed after signing). |
| `MetaTx__RelayerFeeExceedsMax` | The fee is above the deployment's cap. |
| `BazaarPair__AmountLteRelayerFee` | A withdrawal's payout does not cover the fee. |
| `permit: ...` warning | The permit will fail; the call then needs an allowance in place. |

## Related Pages

- [Collateral, Approvals & Permits](collateral.md): permits in detail.
- [Placing Orders](orders.md) and [Managing Orders](managing-orders.md): the actions being signed.
- [Errors & Messages](errors.md): showing these errors.
- [Security Notes for Integrators](../reference/security.md).
