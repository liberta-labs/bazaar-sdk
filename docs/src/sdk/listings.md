# Listing Markets

Anyone can list a new market on Bazaar. There is no vote and no whitelist: the proposer posts a USDC
bond to UMA's Optimistic Oracle with a claim that the asset meets Bazaar's listing criteria, plus an
insurance seed for the new market. If nobody disputes the claim within 48 hours, anyone can settle it and
the factory deploys the market. The `listings` area builds every call in that flow and reads where a
proposal stands.

Use this page to build a "propose a market" screen, a tool that settles listings when their liveness
ends, or a dashboard of pending listings. What UMA's verifiers check, and why the rules are what they
are, is in Bazaar's [Markets & Listing](https://docs.bazaar.finance/protocol/listing.html) page; this
page covers the SDK side. Disputing a listing is a generic UMA action, covered in
[UMA Disputes & Governance](governance.md).

The samples assume `bz` is connected as in [Connecting](connecting.md) with the user's wallet as the
transport, and `user` is the wallet's address.

## The Flow

1. If the asset is not quoted in USD, register its **composite feed** on Bazaar's oracle
   (`registerComposite`). A USD-quoted asset uses its Pyth Pro feed ID directly.
2. **Propose** it (`proposePairDeployment`). The factory pulls `totalAmount` USDC from the proposer:
   the UMA bond (`requiredDeploymentBond()`, at least 1,000 USDC) is posted to UMA with the proposer as
   asserter, and the rest (at least 3,000 USDC) is escrowed as the market's insurance seed.
3. For **48 hours** anyone may dispute the claim (`uma.disputeAssertion`, see
   [Disputing an Assertion](governance.md#disputing-an-assertion)).
4. **Settle** it (`settleDeploymentProposal`) once UMA can resolve it. Anyone may call it.
   - Undisputed: the pair is deployed with the seed as its insurance fund, the proposer receives the
     seed as insurance shares, and UMA returns the bond.
   - Undisputed, but UMA has since removed the identifier it was asserted under: the listing is
     **voided**. No pair is deployed, UMA returns the bond and the seed is credited back.
   - Disputed: UMA's voters decide. Approved, it deploys as above. Rejected, the bond goes to the
     disputer and the seed is credited back.
5. A seed credited back is collected with `claimSeedRefund`.
6. A listing whose assertion cannot settle at all can be **released** with
   `expireStuckDeploymentProposal`, which frees the asset's listing slot.

One market per asset: the factory refuses a proposal while a live (not terminated) market prices the
same raw Pyth Pro feed, or while another proposal over that feed is pending. For a composite the raw feed is
its base leg, so the same stock through a different FX leg counts as the same asset.

## The Constants

```ts
{{#include ../../examples/protocol/listings-propose.ts:constants}}
```

`deploymentConstants()` reads the factory's listing constants in one batched call:

| Field | Unit | Value | Meaning |
|---|---|---|---|
| `minDeploymentAmount` | 18 decimals | $4,000 | The least `totalAmount` a listing takes. |
| `deploymentBondUsdc` | USDC, 6 decimals | 1,000 USDC | The bond's floor. |
| `requiredDeploymentBondUsdc` | USDC, 6 decimals | live | The bond a listing posts now: the larger of the floor and UMA's minimum bond for USDC. |
| `deploymentLiveness` | seconds | 48 hours | UMA's liveness: how long the claim can be disputed. |
| `dvmDisputeGrace` | seconds | 14 days | Extra wait before a disputed listing that cannot settle may be released. |
| `minInsuranceSeed` | 18 decimals | $3,000 | The least seed left after the bond. Not exposed on chain; the SDK's constant. |
| `maxDescriptionLength` | bytes | 200 | The longest description. |

The same values are exported as constants (`listings.MIN_DEPLOYMENT_AMOUNT`,
`listings.DEPLOYMENT_BOND_USDC`, `listings.DEPLOYMENT_LIVENESS`, `listings.DVM_DISPUTE_GRACE`,
`listings.MIN_INSURANCE_SEED`, `listings.MAX_DESCRIPTION_LENGTH`). Only the bond moves: quote
`requiredDeploymentBond()` (or `requiredDeploymentBondUsdc`) rather than assuming 1,000 USDC, since it
tracks UMA's minimum upward.

Note the units: `totalAmount` and the seed constants are in Bazaar's 18-decimal precision
(`parseUnits18("4000")` is $4,000), while the bond and anything named `...Usdc` are in USDC's 6
decimals. See [Units & Constants](../reference/units.md).

## The Description

The description is the one proposer-written string in the claim UMA's voters read, so the factory
accepts only 1 to 200 bytes of letters, digits, space and `. , & / -`. Colons, quotes, brackets, accents
and every other non-ASCII character are refused. `listings.descriptionProblem(text)` applies the same
rule and returns a sentence for the user, or `null` when the text is accepted, so a form can check it as
the user types:

```ts
{{#include ../../examples/protocol/listings-propose.ts:description}}
```

Descriptions come back from the chain and the subgraph as plain strings written by whoever proposed the
listing. Render them as text, never as HTML (see
[Security Notes for Integrators](../reference/security.md)).

## Composite Feeds

A Pyth Pro feed ID is a number (BTC/USD is 1), listed in Pyth Pro's symbols registry. The contracts
hold it in a `bytes32`, and every builder here takes either form: `1`, `"1"`, or
`0x0000…0001` (`listings.asFeedId` converts). Pyth Pro's IDs are a different namespace from Pyth
Core's 32-byte IDs, which the factory refuses.

An asset quoted in another currency (DAX in EUR, say) trades against a composite feed: the asset's own
feed times or divided by an FX feed. The composite is registered on Bazaar's oracle, permissionlessly,
and its id (a hash of its legs) is then used wherever a feed id is expected:

```ts
{{#include ../../examples/protocol/listings-propose.ts:composite}}
```

| Function | What it does |
|---|---|
| `listings.compositeId(baseId, quoteId, invertQuote)` | `keccak256(baseId ‖ quoteId ‖ invertQuote)`, the id the composite is registered and listed under. Pure; no connection needed. |
| `getComposite(id)` | The legs (`baseId`, `quoteId`, `invertQuote`) `id` resolves to on the oracle, or `null` when it is not a registered composite. |
| `registerComposite({ baseId, quoteId, invertQuote, from? })` | A `CostedCall` (plus `compositeId`) that registers it. Costs only gas and is idempotent: when the composite is already registered, `notes` says the call changes nothing. |
| `rawBaseFeed(baseFeedId)` | The raw Pyth Pro feed a listing prices: the feed itself, or a composite's base leg. This is the key one-market-per-asset is enforced on. |
| `listings.asFeedId(field, value)` | The `bytes32` feed ID for a feed number, decimal digits or a `bytes32`; an `InputError` on `field` for anything else. Pure. |

`invertQuote` is `false` when the FX feed is CCY/USD (the price multiplies, as EUR/USD does) and `true`
when it is USD/CCY (the price divides, as USD/JPY does). `registerComposite` refuses, as the oracle
does, a leg that is not a raw Pyth Pro feed ID (which rules out nesting one composite in another) and
the same feed twice. Register before proposing: the factory refuses an ID that is neither a raw feed
ID nor a registered composite. A composite market is never continuously traded, because its FX leg
does not trade around the clock.

## Proposing a Market

`proposePairDeployment` builds the proposal and returns a [`CostedCall`](#costedcall) whose `approvals`
must be sent first. A small helper sends them, then simulates and sends the call:

```ts
{{#include ../../examples/protocol/listings-propose.ts:send}}
```

Simulate only after the approvals have landed: until then the factory's `transferFrom` would revert,
and the simulation would report that rather than the real outcome.

```ts
{{#include ../../examples/protocol/listings-propose.ts:propose}}
```

| Argument | Type | Meaning |
|---|---|---|
| `baseFeedId` | `number \| string \| Hex` | A Pyth Pro feed ID (its number, or the `bytes32` holding it), or a composite id registered on Bazaar's oracle. It becomes the market's pair id. |
| `isContinuouslyTraded` | `boolean` | `true` only for assets that trade around the clock (crypto); `false` for anything with sessions, and always for a composite. The flag decides the market's margin and stale-price rules ([Price Oracle](https://docs.bazaar.finance/protocol/oracle.html)). |
| `totalAmount` | `bigint`, 18 decimals | The whole deposit: the bond plus the seed. At least $4,000, and enough that the seed is at least $3,000 after the live bond. Floored to whole micro-USDC; the factory pulls only that. |
| `description` | `string` | What the asset is, e.g. `"AAPL on NASDAQ"`. 1 to 200 bytes of the allowed characters. |
| `from` | `Address` | The proposer: who pays, who is the UMA asserter, and who receives the seed as insurance shares. |
| `registry` | URL, source or `null` | Where to look the feeds up. Default: the symbols registry of the connection's Pyth Pro client. `null` skips the check. |

**The registry check.** The chain cannot see whether Pyth publishes a feed under an ID: that is the
first thing the listing's claim asks UMA to verify, and a listing of a feed that does not exist is
disputed and loses its bond. So the builder looks each feed (both legs of a composite) up in Pyth
Pro's symbols registry when one is at hand, refuses an ID the registry does not list, and says in
`notes` what it lists each feed as (symbol, asset type, state, fastest channel, schedule) so you can
compare it with the description. Where the connection has no Pyth Pro source, or the registry cannot
be read, the check is skipped; when it could not be read, `notes` says so.

Besides the `CostedCall` fields, the result carries `pairId` (the `bytes32` `baseFeedId`), `bondUsdc`
and `seedAmountUsdc` (both 6 decimals), `pullsUsdc` (18 decimals), and `legFeeds` (each leg's registry
entry, or `null` where it was not looked up). Its two `costs` are:

| `kind` | `label` | Comes back |
|---|---|---|
| `bond` | UMA listing bond | Returned by UMA when the listing is approved (deployed or voided); paid to the disputer if UMA's voters reject it. |
| `seed` | Insurance seed | Approved, it becomes the market's insurance fund and the proposer holds it as insurance shares, which absorb the market's losses and redeem after the 13-day withdrawal cooldown ([Insurance](insurance.md)). Rejected, voided or released, it is credited back for `claimSeedRefund`. |

`notes` says when the dispute window ends, how many insurance shares the seed will become, and whether
the call will first settle or void another listing of the same asset. When the wallet already allows
the factory more than the call pulls, a warning in `notes` says so: the contract takes what it charges
when the call runs, up to the allowance, so a UI that wants the quote to be a cap should approve exactly
the amount first. `approvals` holds one exact-amount USDC approval for the factory when the allowance
is short, and `requires` lists a balance shortfall rather than throwing, since the user may top up
before sending.

After the receipt, `listingFromReceipt(receipt)` returns the `assertionId` and `pairId` from the
factory's `PairDeploymentProposed` event (or `null` when the receipt has none). Keep the assertion id:
every later call about the proposal takes it.

### What `proposePairDeployment` Refuses

Each of these throws an `InputError` naming the field, before anything is built. `errorMessage(e)`
returns its message.

| Field | Why |
|---|---|
| `baseFeedId` | Not a feed number or 32 bytes of hex, or zero. |
| `totalAmount` | Not a `bigint`; below $4,000; not above the live bond; or leaving a seed below $3,000 once the live bond is taken (the message says how much to deposit). |
| `description` | Fails `descriptionProblem`. |
| `isContinuouslyTraded` | `true` for a composite. |
| `baseFeedId` | Neither a raw Pyth Pro feed ID nor a registered composite (a Pyth Core ID or an unregistered composite id lands here): for a non-USD asset, register its composite and list that. |
| `baseFeedId` | Pyth Pro's symbols registry lists no feed with this ID. |
| `baseFeedId` | UMA's identifier is off its live whitelist: listings are closed until Bazaar's [identifier upgrade](governance.md#identifier-upgrades) completes. |
| `baseFeedId` | A live market for this feed or this asset already exists (the message names its address). A terminated market does not block. |
| `baseFeedId` | Another listing of the asset is in UMA's review (with the time it ends); has passed review and deploys when settled; was disputed and approved by UMA's voters; or is disputed and not yet ruled on. |
| `from` | Not a valid address. |

A bond quote below the factory's 1,000 USDC floor can only be a wrong answer from the node (an RPC
returning 0, say). The SDK then throws `uma.BondQuoteError` and builds nothing, since an approval sized
to a wrong quote would be wrong too. `errorMessage` does not recognize this class and returns its
generic sentence, so show `e.message` for it.

If the call reverts anyway (the state changed between building and sending), the simulation's
`error.message` explains it, for example `Factory__ProposalAlreadyPending` ("Another listing proposal
for this asset is still pending. Wait for it to resolve.") or `Factory__InvalidFeedId`. See
[Errors & Messages](errors.md).

## Where a Proposal Stands

```ts
{{#include ../../examples/protocol/listings-settle.ts:status}}
```

`deploymentProposal(assertionId)` reads the factory's record and returns `null` for an unknown id.
`pendingDeployment({ pairId })` or `pendingDeployment({ baseFeedId })` returns the listing pending for an
asset, or `null`; by `baseFeedId` it looks under the raw feed, so it also finds a composite of the same
asset through another FX leg.

| Field | Meaning |
|---|---|
| `assertionId` | The UMA assertion id. |
| `deployer` | The proposer. |
| `baseFeedId`, `pairId` | The feed (or composite) listed, and the pair id the market will have (the same value). |
| `isContinuouslyTraded` | The flag proposed. |
| `seedAmount`, `seedAmountUsdc` | The escrowed seed, in 18 decimals and in USDC units. |
| `description` | The proposer's text. Render it as text. |
| `proposalTs`, `livenessEndsAt` | When it was proposed, and when UMA's liveness ends (proposal time plus 48 hours). |
| `resolved`, `deployed`, `disputed` | The factory's flags. |
| `status` | One of the statuses below. |
| `releaseOpensAt` | When `expireStuckDeploymentProposal` may release it: the end of liveness, plus 14 days if disputed. |

| `status` | Meaning |
|---|---|
| `inReview` | In UMA's liveness: disputable until it ends. |
| `settleable` | Past liveness without a dispute: settling it deploys the market (or voids it, if UMA has since removed its identifier). |
| `disputed` | UMA's voters decide it. Use [`uma.previewSettlement`](governance.md#previewing-a-settlement) to see whether they have ruled. |
| `deployed` | The market exists. |
| `notDeployed` | Rejected, voided or released; the seed was credited to `seedRefundOwed`. |

The proposal's UMA assertion itself (bond, asserter, dispute window) is read with
[`uma.assertionStatus`](governance.md#assertion-status).

### Every Open Listing

`openListings(search?)` returns every listing proposal not yet resolved (`inReview`, `settleable` or
`disputed`), oldest first, with the same fields as `deploymentProposal`:

```ts
{{#include ../../examples/protocol/listings-settle.ts:open}}
```

The factory keeps proposals in maps keyed by pair id and by feed, which no call can list, so
`openListings` finds their ids first, then reads each one on chain: the answer reflects the chain
rather than the index, and a proposal the subgraph still shows as pending after the chain resolved it is
left out. Its `source` says where the ids came from:

| `source` | When |
|---|---|
| `"subgraph"` | The connection has a subgraph: every page of pending and disputed listings, each id checked (32 bytes, strictly ascending, at most `MAX_OPEN_LISTINGS` = 1,000). An answer that breaks any of these throws `SubgraphError` rather than being half-used. |
| `"logs"` | No subgraph, and `search.fromBlock` is given: one `eth_getLogs` over the factory from `fromBlock` to `search.toBlock` (default: the latest block), keeping its `PairDeploymentProposed` events. |
| `"ids"` | Only `search.ids` were given. Ids you pass are always read, whatever else runs. |
| `"none"` | Nothing to search: `listings` is empty. |

Without a subgraph, scan from the factory's deployment block (or later): no listing is older. More than
`MAX_LISTING_IDS` = 10,000 ids in all throws an `InputError` on `fromBlock`: scan from a later block.

## Settling a Listing

```ts
{{#include ../../examples/protocol/listings-settle.ts:settle}}
```

`settleDeploymentProposal({ assertionId, from? })` has the factory settle the assertion on UMA's oracle,
UMA pay the bond to the winning side, and the factory apply the verdict. It costs only gas and anyone can
send it. `notes[0]` says what will happen: the market is deployed; it is voided (the
`listings.PAIR_DEPLOYMENT_PROPOSAL_VOIDED` text); or, for a disputed listing, that the call succeeds only
once UMA's voters have ruled.

It throws an `InputError` on `assertionId` for an unknown or already resolved listing, and while UMA's
liveness is still open (with the time it can be settled). A disputed listing the voters have not ruled
on cannot be told apart in advance: the simulation reverts in UMA's oracle. Settling the assertion
directly on the oracle (`uma.settleAssertion`) has the same effect.

## Releasing a Stuck Listing

An assertion that can never settle on UMA's oracle (a proposer who can no longer receive USDC, a dispute
the DVM never resolves) would hold the asset's listing slot forever. `expireStuckDeploymentProposal`
releases it:

```ts
{{#include ../../examples/protocol/listings-settle.ts:expire}}
```

It takes the **pair id**, not the assertion id. The factory first tries to settle the listing, so one
that can still resolve simply resolves. Otherwise an undisputed listing past its liveness is approved
(deployed, or voided if its identifier was removed), and a disputed one past the 14-day grace is
discarded with its seed credited back. The assertion stays on UMA's oracle, so the winning side can still
collect its bond. It costs only gas.

It throws an `InputError` on `pairId` when no listing is pending for that pair id, and when it is not
yet releasable, with the time it opens (`releaseOpensAt`). The one exception: a listing disputed after
its identifier left UMA's whitelist may be released at once, because no ruling can ever come. The
factory keeps the timing of that dispute private, so when the identifier is off the whitelist the SDK
builds the call with a note and leaves the outcome to the simulation (`Factory__DeploymentNotExpired`
when it is too early).

## Claiming a Seed Refund

A listing that did not deploy (rejected, voided or released) credits its seed to the proposer's
`seedRefundOwed` instead of sending it, so a failing transfer cannot block UMA's settlement:

```ts
{{#include ../../examples/protocol/listings-settle.ts:refund}}
```

`seedRefundOwed(account)` is in USDC units. `claimSeedRefund({ from })` pays only the caller, and
returns `amountUsdc` with the call. It throws an `InputError` on `from` when nothing is owed.

## Reading Listings

From the [subgraph](history.md), `history.listingProposals` lists proposals newest first, filtered by
`deployer`, `status` (`"Pending"`, `"Disputed"`, `"Deployed"`, `"Rejected"`, `"Expired"`, `"Voided"`)
and time, and paginated:

```ts
{{#include ../../examples/protocol/listings-settle.ts:history}}
```

Each row has the assertion `id`, `pairId`, `deployer`, `baseFeedId`, `description`, `seedAmount`,
`status`, `disputed`, `proposedAt`, `livenessEndsAt`, `resolvedAt`, the deployed `pair` (once deployed),
`seedRefundUsdc` (once credited back) and `transactionHash`. The subgraph can trail the chain; read a
single proposal's current state with `deploymentProposal`.

From the chain's own events, `listings.decodeFactoryLog(log)` decodes any factory log (or returns `null`
for another contract's), and `listings.LISTING_EVENT_TEXT` has one sentence per listing event for an
activity feed:

```ts
{{#include ../../examples/protocol/listings-settle.ts:events}}
```

| Event | Meaning |
|---|---|
| `PairDeploymentProposed` | A listing was proposed: its UMA liveness started and its seed is escrowed. |
| `PairDeploymentProposalDisputed` | The listing was disputed: UMA's voters will decide it. |
| `PairDeploymentProposalResolved` | UMA resolved the listing: approved and deployed, or rejected with the seed credited back. |
| `PairDeployed` | The market was deployed and seeded with its insurance fund. |
| `PairDeploymentProposalExpired` | A disputed listing that could not settle was released; its seed was credited back. |
| `PairDeploymentProposalVoided` | Approved without a dispute, but its identifier has since left UMA's whitelist: released instead of deployed. |
| `SeedRefundCredited` | A listing's seed was credited back to its proposer. |
| `SeedRefundClaimed` | A proposer collected a seed refund. |

`markets.listMarkets` caches its list per connection: after a listing deploys, call it with
`{ refresh: true }` to pick up the new market (see [Markets](markets.md)).

## CostedCall

Every builder on this page returns a `CostedCall`: a [`PreparedCall`](sending.md) (simulate and send it
as one) plus four lists for a confirmation screen.

| Field | Meaning |
|---|---|
| `costs` | Every bond, seed, fee, levy and lock the call posts, each a `Cost`. Empty for calls that cost only gas. |
| `approvals` | ERC-20 approvals (`PreparedCall`s) to send first, each for exactly the amount. Empty when the allowance already covers it. The SDK never assumes an approval exists. |
| `requires` | Preconditions in words: an allowance to send, a balance to top up. |
| `notes` | What will happen, and warnings. |

A `Cost` has `kind` (`"bond"`, `"seed"`, `"fee"`, `"levy"` or `"lock"`), `label`, `amount` in `unit`'s
own precision (`"USDC"` is 6 decimals), `unit`, `token`, `payee` (who takes or holds it), `returned`
(when and how it comes back, if ever) and `contingent` (true for a worst case that depends on a later
verdict). `uma.usdcText(amount)` prints a USDC amount exactly ("1,000 USDC"). The termination and
governance builders return the same shape ([Termination & Settlement](termination.md),
[UMA Disputes & Governance](governance.md)).

## Function Reference

On `bz.listings` (the connection bound), and as `listings.*(ctx, ...)`:

| Function | Returns |
|---|---|
| `deploymentConstants()` | `DeploymentConstants` |
| `requiredDeploymentBond()` | The bond a listing posts now, USDC units. |
| `deploymentProposal(assertionId)` | `DeploymentProposalInfo \| null` |
| `pendingDeployment({ pairId } \| { baseFeedId })` | `DeploymentProposalInfo \| null` |
| `openListings(search?)` | `OpenListings`: `{ listings, source }` |
| `seedRefundOwed(account)` | USDC units owed. |
| `getComposite(id)` | `CompositeFeed \| null` |
| `rawBaseFeed(baseFeedId)` | The raw Pyth Pro feed id, as a `bytes32`. |
| `registerComposite(args)` | `CostedCall & { compositeId }` |
| `proposePairDeployment(args)` | `CostedCall & { pairId, bondUsdc, seedAmountUsdc }` |
| `settleDeploymentProposal({ assertionId, from? })` | `CostedCall` |
| `expireStuckDeploymentProposal({ pairId, from? })` | `CostedCall` |
| `claimSeedRefund({ from })` | `CostedCall & { amountUsdc }` |
| `listingFromReceipt(receipt)` | `{ assertionId, pairId } \| null` |

Pure helpers, on `listings` only: `descriptionProblem`, `compositeId`, `decodeFactoryLog`,
`LISTING_EVENT_TEXT`, `PAIR_DEPLOYMENT_PROPOSAL_VOIDED` and the constants above.

## Related

- [UMA Disputes & Governance](governance.md): disputing a listing, previewing a DVM ruling, the
  identifier that listings are asserted under.
- [Insurance](insurance.md): the seed becomes insurance shares.
- [Collateral, Approvals & Permits](collateral.md): USDC approvals.
- Bazaar's [Markets & Listing](https://docs.bazaar.finance/protocol/listing.html): the listing criteria
  UMA's verifiers check.
