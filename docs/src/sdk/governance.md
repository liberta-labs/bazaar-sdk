# UMA Disputes & Governance

Bazaar has no admin and no token vote. Every decision that cannot be made by a formula goes to UMA's
Optimistic Oracle V3 as an **assertion**: a claim posted with a USDC bond that anyone may dispute during
its liveness window. Undisputed, it resolves true when the liveness ends. Disputed, UMA's voters (the
DVM) decide it, which takes days (up to about 12), and the losing side forfeits its bond. Bazaar's
contracts never hold the verdict themselves: the factory and the terminator learn it through the
oracle's callback when someone settles the assertion.

Three flows make assertions:

| Flow | Made by | Bond floor | Liveness | Page |
|---|---|---|---|---|
| Listing a market | the factory | 1,000 USDC | 48 hours | [Listing Markets](listings.md) |
| Upgrading the UMA identifier | the factory | 5,000 USDC | 2 days | [Identifier Upgrades](#identifier-upgrades), below |
| Terminating a market | the terminator | 1,000 USDC | see the termination page | [Termination & Settlement](termination.md) |

The SDK splits this into two areas:

- `uma` (`bz.uma`): any assertion, whichever flow made it. Where it stands, disputing it with its bond,
  previewing what settling it would do, settling it, and decoding the oracle's events.
- `governance` (`bz.governance`): Bazaar's one governance lever, swapping the UMA identifier every
  listing and termination is adjudicated under.

The samples assume `bz` is connected as in [Connecting](connecting.md) with the user's wallet as the
transport, and `user` is the wallet's address. The mechanics, and why they are built this way, are in
Bazaar's [Markets & Listing](https://docs.bazaar.finance/protocol/listing.html#the-only-governance-swapping-the-uma-identifier)
and [Termination & Settlement](https://docs.bazaar.finance/protocol/termination.html) pages.

## Which Oracle

The oracle's address comes from the deployment: `factory.oo()`, which is immutable. Each assertion also
records the oracle it was made on: `factory.assertionOo(id)` for listings and identifier upgrades,
`terminator.assertionOo(id)` for termination claims. The `uma` functions take a `home` option,
`"factory"` (the default) or `"terminator"`, that says which record to read; when the record is empty
they fall back to `factory.oo()`. Pass `home: "terminator"` for a termination claim.

You can also pass `oo` to name the oracle yourself, but it is used only if it is `factory.oo()` or the
oracle recorded for this assertion. Any other address is refused with an `InputError` on `oo`, because it
would be the call's target and, for a dispute, the spender of the bond. Leave it out and the SDK finds
the right oracle. `uma.optimisticOracle()` returns `factory.oo()`, and `uma.assertionOracle(id, home)`
the oracle an assertion was made on.

## Assertion Status

```ts
{{#include ../../examples/protocol/governance-uma.ts:status}}
```

`assertionStatus(assertionId, { home?, oo? })` reads the assertion and the latest block's time, and
returns an `AssertionStatus`:

| Field | Meaning |
|---|---|
| `phase` | Where the assertion stands (below). |
| `assertion` | The oracle's record (`UmaAssertion`), or `null` when the oracle has no such assertion. |
| `canSettleAt` | When it can be settled: its `expirationTime` while in liveness, `now` when settleable, `null` when disputed or resolved. |
| `disputableUntil` | The last second a dispute is accepted (`expirationTime - 1`), or `null` when it can no longer be disputed. |
| `now` | The chain time the status was judged at. |

| `phase` | Meaning |
|---|---|
| `notFound` | No such assertion on this oracle. |
| `liveness` | Undisputed and inside its liveness: disputable until `expirationTime`, settleable from it. |
| `settleable` | Undisputed and past its liveness: it can only resolve true, and anyone may settle it now. |
| `disputed` | Waiting on UMA's voters. It settles once they have ruled, which this view cannot see; use [`previewSettlement`](#previewing-a-settlement). |
| `settledTrue` | Settled: UMA accepted the claim. |
| `settledFalse` | Settled: UMA rejected the claim. |

`uma.ASSERTION_PHASE_TEXT` has one sentence per phase for a UI. Times are judged against the chain's
latest block, not the user's clock, since that is what the contracts compare against.

The `UmaAssertion` record has `assertionId`, `oo`, `asserter`, `assertionTime`, `settled`, `currency`
(USDC for every Bazaar assertion), `expirationTime` (from this instant the oracle refuses disputes and an
undisputed assertion may be settled), `settlementResolution` (the verdict, meaningful only once
`settled`), `domainId`, `identifier`, `bond` (in the currency's units: USDC has 6 decimals),
`callbackRecipient`, `disputer` (`null` while undisputed) and `escalationManager` (`null` when none).
`uma.getAssertion(oo, assertionId)` returns it alone, and `uma.assertionPhase(assertion, now)` and
`uma.statusOf(assertion, now)` compute the phase and status from a record you already hold.

The flows' own reads (`listings.deploymentProposal`, `governance.identifierGovernance`,
`termination.terminationStatus`) describe the Bazaar side of the same proposal.

## Disputing an Assertion

A dispute matches the assertion's bond and sends the claim to UMA's voters. If they reject the claim, the
disputer receives both bonds less the share UMA burns as its fee. If they uphold it, the dispute bond is
gone.

```ts
{{#include ../../examples/protocol/governance-uma.ts:dispute}}
```

`disputeAssertion` takes:

| Argument | Type | Meaning |
|---|---|---|
| `assertionId` | `Hex` | The assertion to dispute. |
| `from` | `Address` | Who sends the call and pays the bond. |
| `disputer` | `Address`, optional | Who is paid if the dispute wins. Defaults to `from`; cannot be the zero address. |
| `home` | `"factory"` \| `"terminator"`, optional | Which contract made the assertion. Default `"factory"`. |
| `oo` | `Address`, optional | The oracle, checked as in [Which Oracle](#which-oracle). |

It returns a `CostedCall` (see [CostedCall](listings.md#costedcall)) whose one cost is the dispute bond
(`kind: "bond"`, payee the oracle). The oracle pulls the bond with `transferFrom`, so `approvals` holds
an exact-amount approval for the oracle whenever the allowance is short; send it first, then simulate
and send the dispute. `notes` says:

- until when the claim can be disputed, and that UMA's voters then take days;
- what the disputer receives if the dispute wins, computed from the oracle's `burnedBondPercentage()`
  (both bonds less UMA's fee; 50% of one bond is burned on the live oracle), or in words when the oracle
  does not report it;
- a warning when the claim's identifier is no longer on UMA's whitelist: UMA's voters can then never
  rule on a dispute, and the bond would stay locked in the oracle for good;
- a warning when the bond is not in USDC, since then it is not a claim Bazaar made;
- a warning when the wallet already allows the oracle more than the bond.

How a dispute affects each flow: a listing or identifier upgrade waits on UMA's voters. A termination
claim's insurer vote keeps running (see [Termination & Settlement](termination.md)).

### What `disputeAssertion` Refuses

| Field | Why |
|---|---|
| `assertionId` | Not 32 bytes of hex; no such assertion on the oracle; already disputed; already settled; or past its liveness ("UMA's dispute window closed at ..."): the oracle accepts disputes only while `expirationTime` is after the block's time. |
| `from`, `disputer` | Not a valid address, or a zero `disputer`. |
| `oo` | Neither `factory.oo()` nor the oracle recorded for this assertion. |

These throw `InputError`. A USDC bond below the 1,000 USDC every Bazaar claim posts, or a zero bond in
another currency, can only be a wrong answer from the node: it throws `uma.BondQuoteError` and nothing
is built. `errorMessage` does not recognize `BondQuoteError` and returns its generic sentence, so show
`e.message` for it.

A dispute sent in the last seconds of the window can land in a block after `expirationTime` and
revert in the oracle. Leave a margin.

## Previewing a Settlement

Bazaar's own views read a disputed claim as pending until someone settles it on chain, even after UMA's
voters have ruled. `previewSettlement` is the one way to see the ruling first: it simulates the oracle's
`settleAndGetAssertionResult(assertionId)` without sending anything.

```ts
{{#include ../../examples/protocol/governance-uma.ts:preview}}
```

It takes `{ home?, oo?, from? }` and returns a `SettlementPreview`:

| Field | Meaning |
|---|---|
| `settleable` | `true` when a settle would go through now. |
| `result` | The verdict a settle would apply (`true`: the claim is accepted), or `null` when it cannot settle yet. |
| `error` | Why it cannot settle, decoded (`DecodedError`). A disputed assertion the DVM has not ruled on reverts in UMA's oracle. |

The simulation runs Bazaar's callback too, so a callback that would revert shows up here as
`settleable: false` with its decoded error.

## Settling an Assertion

Settling pays the bond to the winning side, then calls the Bazaar contract that made the assertion, which
applies the verdict: deploys or refunds a listing, queues an identifier upgrade, schedules or rejects a
termination. Anyone may settle, and it costs only gas.

```ts
{{#include ../../examples/protocol/governance-uma.ts:settle}}
```

`settleAssertion({ assertionId, from?, home?, oo?, getResult? })` settles on the oracle directly. With
`getResult: true` it calls `settleAndGetAssertionResult` instead of `settleAssertion`, which also returns
the verdict. It returns a plain `PreparedCall`. Each flow also has its own settle function on the Bazaar
contract (`listings.settleDeploymentProposal`, `governance.settleIdentifierUpgradeProposal`,
`termination.settleTerminationProposal`); either way works, and the flow's own function adds notes about what will
happen.

It throws an `InputError` on `assertionId` when the oracle has no such assertion, while the liveness is
still open (with the time it can be settled), and once it is settled. A disputed assertion settles only
after the DVM has ruled; until then the call reverts, which the builder cannot see in advance. Simulate
it, or call `previewSettlement` first.

## Other Reads

| Function | Returns |
|---|---|
| `uma.getMinimumBond({ currency?, oo? })` | The smallest bond the oracle accepts in `currency` (USDC by default), in its units; 0 when the oracle has never cached it. |
| `uma.defaultIdentifier({ oo? })` | The oracle's default identifier. On the live oracle this is `ASSERT_TRUTH`, which UMA has de-whitelisted; Bazaar asserts under its own governed identifier instead. |
| `uma.burnedBondPercentage({ oo? })` | The share of a disputed bond UMA burns as its fee, 1e18 = 100%, or `null` if the oracle does not report it. |
| `uma.identifierWhitelisted(identifier, { oo? })` | Whether the identifier is on UMA's live whitelist, resolved as the factory resolves it (oracle, then finder, then IdentifierWhitelist). `null` when any step fails to answer. |

## Oracle Events

`uma.decodeAssertionLog(log)` decodes the oracle's `AssertionMade`, `AssertionDisputed` and
`AssertionSettled` events (or returns `null` for another contract's log), and `uma.ASSERTION_EVENT_TEXT`
has a sentence for each:

```ts
{{#include ../../examples/protocol/governance-uma.ts:logs}}
```

Bazaar's own events about the same proposals (`PairDeploymentProposalDisputed`,
`UmaIdentifierUpgradeQueued`, the terminator's resolution events) are decoded with
`listings.decodeFactoryLog` and the termination area. For past proposals, the subgraph has
`history.listingProposals`, `history.identifierUpgradeProposals` and `history.terminationProposals`
([History](history.md)).

## Identifier Upgrades

UMA's oracle address is fixed in the factory. What UMA changes over time is its whitelist of
identifiers, so the identifier Bazaar asserts under (`umaIdentifier`, currently `ASSERT_TRUTH2`) is the
one thing Bazaar's governance can change:

1. Anyone **proposes** a new identifier (`proposeUmaIdentifierUpgrade`) with a bond of at least 5,000
   USDC. The candidate must be on UMA's live whitelist and named `ASSERT_TRUTH…`.
2. For **2 days** anyone may dispute it.
3. Once UMA can resolve it, anyone **settles** it (`settleIdentifierUpgradeProposal`). Approval does not
   swap anything: it queues the upgrade behind a **7-day** timelock (4 days once the incumbent is off
   UMA's whitelist).
4. After the timelock, anyone **activates** it (`activateIdentifierUpgrade`). The factory checks the
   whitelist again: an incoming identifier UMA has removed since cancels the upgrade.

One upgrade is pending at a time. Assertions already made keep the identifier they were made under.

While the incumbent is off UMA's whitelist (`umaIdentifierIsLive()` is `false`), new listings and UMA
termination claims are refused, and an upgrade proposal is asserted under the proposed identifier so a
dispute on it can still be ruled on.

### The Governance Status

```ts
{{#include ../../examples/protocol/governance-identifier.ts:status}}
```

`identifierGovernance()` returns the whole track in one call:

| Field | Meaning |
|---|---|
| `now` | The chain time it was read at. |
| `umaIdentifier`, `umaIdentifierText` | The identifier in force, as bytes32 and as text (`null` if not printable ASCII). |
| `umaIdentifierIsLive` | Whether it is on UMA's live whitelist. |
| `pending` | The proposal in UMA's review, or `null`: an `IdentifierUpgradeProposalInfo` plus `assertion`, its [assertion status](#assertion-status). |
| `queued` | The approved upgrade waiting out its timelock, or `null` (below). |
| `constants` | The track's constants (below). |

A pending proposal (`IdentifierUpgradeProposalInfo`, also from `identifierUpgradeProposal(assertionId)`)
has `assertionId`, `proposer`, `newIdentifier`, `newIdentifierText`, `proposalTs`, `livenessEndsAt`,
`resolved`, `settlementResolution` (meaningful once resolved through settlement; an expired proposal
reads `false`), `disputed`, and `releaseOpensAt` (the end of liveness, plus 14 days if disputed).

A queued upgrade (`QueuedIdentifierUpgrade`) has:

| Field | Meaning |
|---|---|
| `assertionId`, `newIdentifier`, `newIdentifierText` | The approved proposal. |
| `effectiveTs` | When the full 7-day timelock ends. |
| `approvedAt` | `effectiveTs` less 7 days. |
| `activationOpensAt` | `effectiveTs`, or 4 days after approval while the incumbent is off UMA's whitelist. A failed whitelist lookup keeps the full timelock, as the factory does. |
| `canActivate` | Whether `now` has reached `activationOpensAt`. |
| `newIdentifierWhitelisted` | Whether the incoming identifier is still whitelisted; activation cancels the upgrade if not. `null` if the lookup failed. |

### The Constants

`identifierUpgradeConstants()` reads them from the factory:

| Field | Value | Meaning |
|---|---|---|
| `identifierUpgradeBondUsdc` | 5,000 USDC | The bond's floor (6 decimals). |
| `requiredIdentifierUpgradeBondUsdc` | live | The bond a proposal posts now: the larger of the floor and UMA's minimum. Also `requiredIdentifierUpgradeBond()`. |
| `identifierUpgradeLiveness` | 2 days | UMA's liveness, in seconds. |
| `identifierUpgradeTimelock` | 7 days | From approval to activation. |
| `identifierUpgradeMinNotice` | 4 days | From approval to activation once the incumbent is off UMA's whitelist. |
| `dvmDisputeGrace` | 14 days | Extra wait before a disputed proposal that cannot settle may be released. |

The same values are exported as `governance.IDENTIFIER_UPGRADE_BOND_USDC`,
`IDENTIFIER_UPGRADE_LIVENESS`, `IDENTIFIER_UPGRADE_TIMELOCK` and `IDENTIFIER_UPGRADE_MIN_NOTICE`.

### Monitoring the Identifier

`umaIdentifierIsLive()` is the one read to alarm on: when it turns `false`, listings and UMA termination
claims are closed until an upgrade activates.

```ts
{{#include ../../examples/protocol/governance-identifier.ts:monitor}}
```

`umaIdentifier()` returns the identifier in force as bytes32.

### Proposing an Upgrade

```ts
{{#include ../../examples/protocol/governance-identifier.ts:propose}}
```

`proposeUmaIdentifierUpgrade({ newIdentifier, from })` takes the identifier as its name
(`"ASSERT_TRUTH3"`) or as bytes32 hex. The factory pulls the bond from `from` with `transferFrom`, so
`approvals` holds an exact-amount USDC approval for the factory when the allowance is short. The one cost
is the bond: returned by UMA when the proposal is approved, paid to the disputer if UMA's voters reject
it. `notes` gives the dispute window and the timelock, says when the call will first settle a rejected
proposal or activate a queued upgrade (the factory does both before taking a new proposal), and says
when the proposal will be asserted under the proposed identifier because the incumbent is off the
whitelist.

It throws an `InputError` on `newIdentifier` when the identifier:

- is empty, or neither a name of 1 to 32 printable ASCII characters nor 32 bytes of hex;
- does not begin with `ASSERT_TRUTH` (Bazaar adjudicates only under UMA truth identifiers);
- is already the one in force (or the one a queued upgrade is about to activate);
- is not on UMA's live whitelist. When the whitelist cannot be read, the call is built with a note,
  since the factory checks it itself;

and when another proposal blocks: one still in UMA's review, one past review that settling would queue,
one disputed and approved by UMA's voters, one disputed and not yet ruled on, or a queued upgrade still
in its timelock. A bond quote below 5,000 USDC throws `uma.BondQuoteError`.

### Settling, Releasing and Activating

```ts
{{#include ../../examples/protocol/governance-identifier.ts:settle}}
```

`settleIdentifierUpgradeProposal({ assertionId, from? })` settles the proposal on UMA: UMA pays the bond
to the winning side, and an approved upgrade is queued behind the timelock. It costs only gas. It throws
an `InputError` on `assertionId` for an unknown or resolved proposal and while UMA's liveness is open; a
disputed one settles only after UMA's voters have ruled.

```ts
{{#include ../../examples/protocol/governance-identifier.ts:activate}}
```

`activateIdentifierUpgrade({ from? })` activates the queued upgrade once `activationOpensAt` has passed.
`notes[0]` says what will happen: from then on, new listings and termination claims are asserted under
the new identifier, or, when UMA has removed it since, activating cancels the upgrade and keeps the
incumbent. It throws an `InputError` when nothing is queued and before activation opens (with the time).

```ts
{{#include ../../examples/protocol/governance-identifier.ts:expire}}
```

`expireStuckIdentifierUpgradeProposal({ from? })` releases the single pending slot when its assertion
cannot settle (a proposer who can no longer receive USDC, a dispute the DVM never resolves). The factory
first tries to settle it. Otherwise an undisputed proposal past liveness is approved and queued, and a
disputed one past the 14-day grace is discarded. The assertion stays on UMA's oracle, so the winning side
can still collect its bond. It throws an `InputError` when nothing is pending and before
`releaseOpensAt`, except that a proposal disputed after its identifier left UMA's whitelist may be
released at once; the factory keeps the timing of that dispute private, so the SDK then builds the call
with a note and leaves the outcome to the simulation.

The `InputError`s from `activateIdentifierUpgrade` and `expireStuckIdentifierUpgradeProposal` name the
field `assertionId`, although neither function takes one.

### Identifier Helpers and Events

```ts
{{#include ../../examples/protocol/governance-identifier.ts:parse}}
```

| Helper | What it does |
|---|---|
| `governance.parseIdentifier(field, value)` | A name or bytes32 hex to bytes32; an `InputError` on `field` otherwise. |
| `governance.isAssertTruthIdentifier(id)` | Whether the first 12 bytes are ASCII `ASSERT_TRUTH`, the factory's rule. |
| `uma.identifierFromText(text)` | `"ASSERT_TRUTH2"` to bytes32, as UMA stores identifiers. |
| `uma.identifierText(id)` | bytes32 to its text, or `null` when it is not printable ASCII. |

The factory's governance events are decoded with `listings.decodeFactoryLog`, and
`governance.IDENTIFIER_UPGRADE_EVENT_TEXT` has a sentence for each: `UmaIdentifierUpgradeProposed`,
`UmaIdentifierUpgradeDisputed`, `UmaIdentifierUpgradeQueued`, `UmaIdentifierUpgraded`,
`UmaIdentifierUpgradeCanceled` and `UmaIdentifierUpgradeExpired`. Past proposals are listed by
`history.identifierUpgradeProposals`, filtered by `proposer` and `status` (`"Pending"`, `"Disputed"`,
`"Queued"`, `"Upgraded"`, `"Canceled"`, `"Expired"`, `"Rejected"`).

## Errors

Builders throw `InputError` (with `field`) for anything they can check up front; `errorMessage(e)`
returns its message. A call that passes the builder but reverts on chain comes back from `bz.simulate`
with `error.message`, for example `Factory__IdentifierNotWhitelisted`, `Factory__IdentifierUpgradeStillPending`
or `Factory__IdentifierUpgradeTimelocked` ("The approved identifier upgrade can be activated ..."). See
[Errors & Messages](errors.md).

| Error | Where | Meaning |
|---|---|---|
| `InputError` | every builder | An argument or a state the SDK checked first. |
| `uma.BondQuoteError` | `disputeAssertion`, `proposeUmaIdentifierUpgrade`, `proposePairDeployment` | The node reported a bond below the contract's own floor. Check the RPC connection. |
| `uma.ReadError` | any read | A contract read reverted; `decoded` holds the reason. |

## The Shared Plumbing

`bz.uma` also exposes the helpers the listing, termination and governance builders are made of, for
anyone building their own UMA-gated calls:

| Function | What it does |
|---|---|
| `readMany(reads, { allowFailure? })` | Several contract reads (`{ to, codec, fn, args }`) in as few `eth_call`s as the node allows, decoded. A revert throws `ReadError`, or reads `undefined` with `allowFailure`. |
| `readOne(to, codec, fn, ...args)` | One read. |
| `chainNow()` | The latest block's timestamp. |
| `bondApprovals(owner, pulls)` | For a list of ERC-20 pulls (`{ token, spender, spenderName, amount, purpose }`): the exact-amount approvals to send, the `requires` lines (allowance and balance shortfalls) and warnings about larger existing allowances. |

On `uma` only: `approveCall(token, spender, amount, from, summary)` (an ERC-20 approve as a
`PreparedCall`), `optimisticOracleV3Abi` with `optimisticOracleCodec()` and `erc20Codec()`, and the
formatters `usdcText`, `sharesText`, `ethText` (exact amounts), `timeText` (a unix time as
"2026-11-08 14:00:00 UTC") and `durationText` ("2 days"). See
[Low-Level Building Blocks](low-level.md) for codecs.

## Related

- [Listing Markets](listings.md): the listing flow, and the `CostedCall` shape.
- [Termination & Settlement](termination.md): UMA termination claims and insurer votes.
- [Sending Transactions](sending.md): simulating and sending a `PreparedCall`.
- Bazaar's [Markets & Listing](https://docs.bazaar.finance/protocol/listing.html#the-only-governance-swapping-the-uma-identifier):
  why the identifier is the one governed parameter, degraded mode, and the release rules.
