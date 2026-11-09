/**
 * Listing a market: anyone can, through a UMA assertion instead of a vote or a whitelist.
 *
 * `proposePairDeployment` pulls `totalAmount` (at least $4,000) from the proposer: the UMA bond
 * (`requiredDeploymentBond()`, at least $1,000) is posted to UMA's oracle with the proposer as
 * asserter, and the rest (at least $3,000) is escrowed as the market's insurance seed. After a
 * 48-hour liveness anyone may settle it: approved, the factory deploys the pair, seeds its
 * insurance fund (the proposer receives the seed as insurance shares) and UMA returns the bond;
 * rejected after a dispute, the bond goes to the disputer and the seed is credited back
 * (`claimSeedRefund`). One market per asset: a live pair or a pending proposal over the same raw
 * Pyth feed refuses a new one.
 *
 * Assets quoted in another currency trade against a composite feed (`base × quote` or
 * `base ÷ quote`), registered permissionlessly on the oracle before it is proposed
 * (`registerComposite`).
 */

import { type Abi, type Address, type Hex, encodePacked, getAddress, keccak256 } from "viem";
import type { Receipt } from "../chain/client.js";
import { ContractCodec, type DecodedLog, type RawLog, factory as factoryCodec, oracle as oracleCodec, pair as pairCodec } from "../chain/codec.js";
import { BAZAAR_SCALE, USDC_TO_BAZAAR, ZERO_ADDRESS } from "../constants.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import {
  type CostedCall,
  asAddress,
  asBytes32,
  assertionOracle,
  bondApprovals,
  chainNow,
  durationText,
  sharesText,
  timeText,
  usdcText,
  getAssertion,
  identifierWhitelisted,
  isZero32,
  previewSettlementOn,
  readMany,
  readOne,
  requireBondFloor,
  requireSettleable,
  statusOf,
} from "./uma.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Least `totalAmount` a listing takes (BAZAAR precision): $1,000 bond + $3,000 seed. */
export const MIN_DEPLOYMENT_AMOUNT = 4_000n * BAZAAR_SCALE;
/** The listing bond's floor (USDC units); the bond posted is `requiredDeploymentBond()`, which tracks UMA's minimum upward. */
export const DEPLOYMENT_BOND_USDC = 1_000n * 10n ** 6n;
/** UMA liveness of a listing (seconds). */
export const DEPLOYMENT_LIVENESS = 48 * 3_600;
/** Extra wait before a disputed listing that cannot settle may be released (seconds). */
export const DVM_DISPUTE_GRACE = 14 * 86_400;
/** Least insurance seed a pair is deployed with (BAZAAR precision): what remains of `totalAmount` after the bond. */
export const MIN_INSURANCE_SEED = 3_000n * BAZAAR_SCALE;
/** Longest listing description, in bytes. */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * What `PairDeploymentProposalVoided` means: UMA approved the listing without a dispute, but the
 * identifier it was asserted under has since been removed from UMA's live whitelist, so the factory
 * released it instead of deploying it. Its only check was the chance to dispute, no dispute under a
 * removed identifier can be ruled on, and the factory cannot tell whether the removal came before
 * the liveness ended. No pair is deployed; the pair-id and feed slots are freed; the escrowed seed is
 * credited to the deployer's `seedRefundOwed` (collect it with `claimSeedRefund`); UMA returns the
 * bond; and the asset can be proposed again under a live identifier.
 */
export const PAIR_DEPLOYMENT_PROPOSAL_VOIDED =
  "UMA approved this listing without a dispute, but the identifier it was asserted under has since left UMA's whitelist, so it was released instead of deployed. No market was created; the seed was credited back to the proposer (claimSeedRefund), UMA returned the bond, and the asset can be proposed again.";

/** What each factory listing event means, for an activity feed. */
export const LISTING_EVENT_TEXT: Readonly<Record<string, string>> = {
  PairDeploymentProposed: "A listing was proposed: its UMA liveness started and its seed is escrowed.",
  PairDeploymentProposalDisputed: "The listing was disputed: UMA's voters will decide it.",
  PairDeploymentProposalResolved: "UMA resolved the listing: approved and deployed, or rejected with the seed credited back.",
  PairDeployed: "The market was deployed and seeded with its insurance fund.",
  PairDeploymentProposalExpired: "A disputed listing that could not settle was released; its seed was credited back.",
  PairDeploymentProposalVoided: PAIR_DEPLOYMENT_PROPOSAL_VOIDED,
  SeedRefundCredited: "A listing's seed was credited back to its proposer, to collect with claimSeedRefund.",
  SeedRefundClaimed: "A proposer collected a seed refund.",
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const F = () => factoryCodec();
const O = () => oracleCodec();

/** Pyth's getPriceUnsafe, which the factory reads to check a raw feed holds a price on this chain. */
const pythAbi = [
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint256" },
        ],
      },
    ],
  },
] as const;
let pythCache: ContractCodec | null = null;
const pythCodec = () => (pythCache ??= new ContractCodec(pythAbi as unknown as Abi));

const DESCRIPTION_EXTRA = new Set([..." .,&/-"]);

/**
 * Why a listing `description` would be refused, or null when the factory accepts it: 1 to 200 bytes
 * of letters, digits, space and `. , & / -`. Everything else (colons, quotes, brackets, accents and
 * every other non-ASCII character) is refused, because the description is spliced into the claim
 * UMA's voters read, between fences the charset makes unforgeable.
 */
export function descriptionProblem(description: string): string | null {
  if (typeof description !== "string" || description.length === 0) return 'Describe the asset, e.g. "AAPL on NASDAQ".';
  for (const ch of description) {
    if (!/[A-Za-z0-9]/.test(ch) && !DESCRIPTION_EXTRA.has(ch)) {
      return `The character ${JSON.stringify(ch)} is not allowed: use letters, digits, spaces and . , & / - only.`;
    }
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) return `Keep it to ${MAX_DESCRIPTION_LENGTH} characters; this is ${description.length}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Composite feeds
// ---------------------------------------------------------------------------------------------

/** A composite feed's legs. */
export interface CompositeFeed {
  /** The asset's feed in its native currency. */
  readonly baseId: Hex;
  /** The FX feed linking that currency to USD. */
  readonly quoteId: Hex;
  /** False when the FX feed is CCY/USD (multiply), true when it is USD/CCY (divide). */
  readonly invertQuote: boolean;
}

/** keccak256(baseId ‖ quoteId ‖ invertQuote): the id a composite is registered and listed under (BazaarOracle.getCompositeId). */
export function compositeId(baseId: Hex, quoteId: Hex, invertQuote: boolean): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32", "bool"], [asBytes32("baseId", baseId), asBytes32("quoteId", quoteId), invertQuote]));
}

/** The legs `id` resolves to on the oracle, or null when it is not a registered composite (a plain feed id, or an unregistered one). */
export async function getComposite(ctx: BazaarContext, id: Hex): Promise<CompositeFeed | null> {
  const c = await readOne<CompositeFeed>(ctx, ctx.oracle, O(), "composites", asBytes32("id", id));
  return isZero32(c.baseId) ? null : c;
}

/**
 * Register a composite feed on Bazaar's oracle, so `compositeId(baseId, quoteId, invertQuote)` can be
 * listed. Permissionless and idempotent (a registered composite is left as it is), and it costs only
 * gas. Register before proposing: the factory refuses an unregistered composite id, since Pyth holds
 * no price under it.
 *
 * Refused up front: a zero leg, the same feed twice, and a leg that is itself a composite (nesting is
 * not supported).
 */
export async function registerComposite(
  ctx: BazaarContext,
  args: { baseId: Hex; quoteId: Hex; invertQuote: boolean; from?: Address },
): Promise<CostedCall & { readonly compositeId: Hex }> {
  const baseId = asBytes32("baseId", args.baseId);
  const quoteId = asBytes32("quoteId", args.quoteId);
  if (isZero32(baseId)) throw new InputError("baseId", "Give the asset's Pyth feed id.");
  if (isZero32(quoteId)) throw new InputError("quoteId", "Give the FX Pyth feed id.");
  if (baseId === quoteId) throw new InputError("quoteId", "The FX leg must be a different feed from the asset's.");
  const id = compositeId(baseId, quoteId, args.invertQuote);
  const [b, q, existing] = (await readMany(ctx, [
    { to: ctx.oracle, codec: O(), fn: "composites", args: [baseId] },
    { to: ctx.oracle, codec: O(), fn: "composites", args: [quoteId] },
    { to: ctx.oracle, codec: O(), fn: "composites", args: [id] },
  ])) as CompositeFeed[];
  if (!isZero32(b!.baseId)) throw new InputError("baseId", "This id is itself a composite: both legs must be plain Pyth feeds.");
  if (!isZero32(q!.baseId)) throw new InputError("quoteId", "This id is itself a composite: both legs must be plain Pyth feeds.");
  const already = !isZero32(existing!.baseId);
  return {
    action: "registerComposite",
    to: ctx.oracle,
    data: O().encode("registerComposite", baseId, quoteId, args.invertQuote),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Register the composite feed ${id.slice(0, 10)}… (${args.invertQuote ? "base ÷ FX" : "base × FX"}) on Bazaar's oracle (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes: already ? ["This composite is already registered: the call changes nothing."] : [`List it with baseFeedId ${id}.`],
    compositeId: id,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The factory's listing constants, read from the chain, plus the live bond. */
export interface DeploymentConstants {
  /** BAZAAR precision. */
  readonly minDeploymentAmount: bigint;
  /** USDC units: the floor. */
  readonly deploymentBondUsdc: bigint;
  /** USDC units: what a listing posts now, max(floor, UMA's minimum). */
  readonly requiredDeploymentBondUsdc: bigint;
  readonly deploymentLiveness: number;
  readonly dvmDisputeGrace: number;
  /** BAZAAR precision (BazaarTypes.MIN_INSURANCE_SEED; not exposed on chain). */
  readonly minInsuranceSeed: bigint;
  readonly maxDescriptionLength: number;
}

/** MIN_DEPLOYMENT_AMOUNT, DEPLOYMENT_BOND_USDC, the live requiredDeploymentBond, DEPLOYMENT_LIVENESS and DVM_DISPUTE_GRACE. */
export async function deploymentConstants(ctx: BazaarContext): Promise<DeploymentConstants> {
  const [min, bond, req, live, grace] = await readMany(
    ctx,
    ["MIN_DEPLOYMENT_AMOUNT", "DEPLOYMENT_BOND_USDC", "requiredDeploymentBond", "DEPLOYMENT_LIVENESS", "DVM_DISPUTE_GRACE"].map((fn) => ({ to: ctx.factory, codec: F(), fn })),
  );
  return {
    minDeploymentAmount: min as bigint,
    deploymentBondUsdc: bond as bigint,
    requiredDeploymentBondUsdc: req as bigint,
    deploymentLiveness: Number(live),
    dvmDisputeGrace: Number(grace),
    minInsuranceSeed: MIN_INSURANCE_SEED,
    maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  };
}

/** The USDC bond (6 decimals) a listing posts now: max(1,000 USDC, UMA's minimum). */
export async function requiredDeploymentBond(ctx: BazaarContext): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.factory, F(), "requiredDeploymentBond");
}

/**
 * Where a listing stands:
 * - `inReview`: in UMA's liveness; disputable until it ends;
 * - `settleable`: past liveness undisputed: settling it deploys the market (or voids it, if UMA has
 *   since removed its identifier);
 * - `disputed`: UMA's voters decide it;
 * - `deployed`: the market exists;
 * - `notDeployed`: rejected, voided or released; the seed was credited to `seedRefundOwed`.
 */
export type DeploymentStatus = "inReview" | "settleable" | "disputed" | "deployed" | "notDeployed";

/** A listing proposal, from `getDeploymentProposal(assertionId)`. */
export interface DeploymentProposalInfo {
  readonly assertionId: Hex;
  readonly deployer: Address;
  readonly baseFeedId: Hex;
  /** The pair id the market will have (= baseFeedId). */
  readonly pairId: Hex;
  readonly isContinuouslyTraded: boolean;
  /** The insurance seed, BAZAAR precision. */
  readonly seedAmount: bigint;
  /** The insurance seed, USDC units. */
  readonly seedAmountUsdc: bigint;
  readonly description: string;
  readonly proposalTs: number;
  /** When UMA's liveness ends. */
  readonly livenessEndsAt: number;
  readonly resolved: boolean;
  readonly deployed: boolean;
  readonly disputed: boolean;
  readonly status: DeploymentStatus;
  /** When expireStuckDeploymentProposal may release it if it cannot settle: liveness end, plus 14 days if disputed. */
  readonly releaseOpensAt: number;
}

function toDeployment(id: Hex, r: Record<string, unknown>, disputed: boolean, now: number): DeploymentProposalInfo | null {
  if ((r.deployer as Address) === ZERO_ADDRESS) return null;
  const proposalTs = Number(r.proposalTs as bigint);
  const livenessEndsAt = proposalTs + DEPLOYMENT_LIVENESS;
  const resolved = r.resolved as boolean;
  const deployed = r.deployed as boolean;
  const status: DeploymentStatus = resolved ? (deployed ? "deployed" : "notDeployed") : disputed ? "disputed" : now < livenessEndsAt ? "inReview" : "settleable";
  return {
    assertionId: id,
    deployer: getAddress(r.deployer as Address),
    baseFeedId: r.baseFeedId as Hex,
    pairId: r.pairId as Hex,
    isContinuouslyTraded: r.isContinuouslyTraded as boolean,
    seedAmount: r.seedAmount as bigint,
    seedAmountUsdc: r.seedAmountUsdc as bigint,
    description: r.description as string,
    proposalTs,
    livenessEndsAt,
    resolved,
    deployed,
    disputed,
    status,
    releaseOpensAt: livenessEndsAt + (disputed ? DVM_DISPUTE_GRACE : 0),
  };
}

/** A listing proposal by its UMA assertion id, or null when the factory has none. */
export async function deploymentProposal(ctx: BazaarContext, assertionId: Hex): Promise<DeploymentProposalInfo | null> {
  const id = asBytes32("assertionId", assertionId);
  const [[r, disputed], now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.factory, codec: F(), fn: "getDeploymentProposal", args: [id] },
      { to: ctx.factory, codec: F(), fn: "deploymentDisputed", args: [id] },
    ]),
    chainNow(ctx),
  ]);
  return toDeployment(id, r as Record<string, unknown>, disputed as boolean, now);
}

/** The raw Pyth feed a listing prices: the feed itself, or a composite's base leg (the key one-market-per-asset is enforced on). */
export async function rawBaseFeed(ctx: BazaarContext, baseFeedId: Hex): Promise<Hex> {
  const c = await getComposite(ctx, baseFeedId);
  return c ? c.baseId : asBytes32("baseFeedId", baseFeedId);
}

/**
 * The listing proposal pending for an asset, or null. By `pairId` it reads
 * `pendingDeploymentByPairId`; by `baseFeedId` it reads `pendingDeploymentByBaseFeed` under the raw
 * feed (a composite's base leg), which also finds a composite of the same asset through another FX
 * leg.
 */
export async function pendingDeployment(ctx: BazaarContext, by: { pairId: Hex } | { baseFeedId: Hex }): Promise<DeploymentProposalInfo | null> {
  const id =
    "pairId" in by
      ? await readOne<Hex>(ctx, ctx.factory, F(), "pendingDeploymentByPairId", asBytes32("pairId", by.pairId))
      : await readOne<Hex>(ctx, ctx.factory, F(), "pendingDeploymentByBaseFeed", await rawBaseFeed(ctx, by.baseFeedId));
  return isZero32(id) ? null : deploymentProposal(ctx, id);
}

/** USDC (6 decimals) `account` may collect with claimSeedRefund from listings that did not deploy. */
export async function seedRefundOwed(ctx: BazaarContext, account: Address): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.factory, F(), "seedRefundOwed", asAddress("account", account));
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/**
 * Propose listing a market. The factory pulls `totalAmount` (floored to whole micro-USDC) from the
 * caller with `transferFrom` (one USDC approval for the factory, returned in `approvals` when the
 * allowance is short), posts the bond (`requiredDeploymentBond()`) to UMA with the caller as
 * asserter, and escrows the rest as the insurance seed. After 48 hours undisputed, anyone may settle
 * it: the pair is deployed with the seed as its insurance fund (the caller receives it as insurance
 * shares) and UMA returns the bond. If UMA's voters reject it after a dispute, the bond goes to the
 * disputer and the seed is credited back for `claimSeedRefund`; the same credit follows a voided or
 * released listing.
 *
 * Refused up front: `totalAmount` below $4,000 or a seed below $3,000 once the live bond is taken; an
 * invalid description; a composite marked continuously traded; a raw feed Pyth holds no price for on
 * this chain (post one update first; a composite must be registered first); a live market over the
 * same asset; another listing of the asset still in review or headed for deployment; and UMA's
 * identifier off its live whitelist (listings fail closed until the identifier upgrade). A bond
 * quote below the factory's 1,000 USDC floor can only be a wrong node answer: it throws
 * BondQuoteError. An allowance already above what the call pulls is flagged in `notes`.
 *
 * @param args.baseFeedId A Pyth feed id, or a composite id registered on Bazaar's oracle.
 * @param args.isContinuouslyTraded True only for assets that trade around the clock (crypto); false for anything with sessions, and always for composites.
 * @param args.totalAmount The whole deposit in BAZAAR precision (4_000e18 is $4,000): the bond plus the seed.
 * @param args.description What the asset is, e.g. "AAPL on NASDAQ".
 */
export async function proposePairDeployment(
  ctx: BazaarContext,
  args: { baseFeedId: Hex; isContinuouslyTraded: boolean; totalAmount: bigint; description: string; from: Address },
): Promise<CostedCall & { readonly pairId: Hex; readonly bondUsdc: bigint; readonly seedAmountUsdc: bigint }> {
  const baseFeedId = asBytes32("baseFeedId", args.baseFeedId);
  const from = asAddress("from", args.from);
  if (isZero32(baseFeedId)) throw new InputError("baseFeedId", "Give the asset's Pyth feed id.");
  if (typeof args.totalAmount !== "bigint") throw new InputError("totalAmount", "must be an amount in BAZAAR precision (bigint)");
  if (args.totalAmount < MIN_DEPLOYMENT_AMOUNT) {
    throw new InputError("totalAmount", `A listing takes at least ${usdcText(MIN_DEPLOYMENT_AMOUNT / USDC_TO_BAZAAR)}: the UMA bond plus at least ${usdcText(MIN_INSURANCE_SEED / USDC_TO_BAZAAR)} of insurance seed.`);
  }
  const why = descriptionProblem(args.description);
  if (why) throw new InputError("description", why);

  const [comp, now] = await Promise.all([getComposite(ctx, baseFeedId), chainNow(ctx)]);
  if (comp && args.isContinuouslyTraded) {
    throw new InputError("isContinuouslyTraded", "A composite (non-USD) market cannot be continuously traded: its FX leg does not trade around the clock.");
  }
  const raw = comp ? comp.baseId : baseFeedId;
  const pyth = comp ? null : await readOne<Address>(ctx, ctx.oracle, O(), "pyth");
  const [r, [pythPrice]] = await Promise.all([
    readMany(ctx, [
      { to: ctx.factory, codec: F(), fn: "requiredDeploymentBond" },
      { to: ctx.factory, codec: F(), fn: "umaIdentifierIsLive" },
      { to: ctx.factory, codec: F(), fn: "pairAddressById", args: [baseFeedId] },
      { to: ctx.factory, codec: F(), fn: "pairAddressByBaseFeed", args: [raw] },
      { to: ctx.factory, codec: F(), fn: "pendingDeploymentByBaseFeed", args: [raw] },
    ]),
    pyth ? readMany(ctx, [{ to: pyth, codec: pythCodec(), fn: "getPriceUnsafe", args: [baseFeedId] }], { allowFailure: true }) : Promise.resolve([true]),
  ]);
  const [bond, live, existing, holder, pendingId] = r as [bigint, boolean, Address, Address, Hex];
  if (!comp && pythPrice === undefined) {
    throw new InputError(
      "baseFeedId",
      "Pyth has no price for this feed on this chain: post one update for it first, check the id, or, for a non-USD asset, register its composite feed and list that.",
    );
  }
  requireBondFloor("a listing bond", bond, DEPLOYMENT_BOND_USDC);
  const totalUsdc = args.totalAmount / USDC_TO_BAZAAR;
  if (totalUsdc <= bond) throw new InputError("totalAmount", `The amount must exceed the ${usdcText(bond)} UMA bond.`);
  const seedUsdc = totalUsdc - bond;
  if (seedUsdc * USDC_TO_BAZAAR < MIN_INSURANCE_SEED) {
    throw new InputError(
      "totalAmount",
      `After the ${usdcText(bond)} UMA bond the seed would be ${usdcText(seedUsdc)}; it must be at least ${usdcText(MIN_INSURANCE_SEED / USDC_TO_BAZAAR)}, so deposit at least ${usdcText(bond + MIN_INSURANCE_SEED / USDC_TO_BAZAAR)}.`,
    );
  }
  if (live === false) {
    throw new InputError("baseFeedId", "UMA's identifier is off its live whitelist, so listings are closed until Bazaar's identifier upgrade completes.");
  }
  const pairs = [existing, holder].filter((a): a is Address => !!a && a !== ZERO_ADDRESS);
  const terminated = pairs.length
    ? ((await readMany(ctx, pairs.map((a) => ({ to: a, codec: pairCodec(), fn: "isPairTerminated" })), { allowFailure: true })) as (boolean | undefined)[])
    : [];
  const liveOf = (a: Address) => terminated[pairs.indexOf(a)] !== true;
  if (existing && existing !== ZERO_ADDRESS && liveOf(existing)) throw new InputError("baseFeedId", `A market for this feed already exists at ${getAddress(existing)}.`);
  if (holder && holder !== ZERO_ADDRESS && holder !== existing && liveOf(holder)) {
    throw new InputError("baseFeedId", `This asset is already listed at ${getAddress(holder)} (through the same Pyth feed): one market per asset.`);
  }
  const notes: string[] = [];
  if (pendingId && !isZero32(pendingId)) {
    const pending = await deploymentProposal(ctx, pendingId);
    if (pending && !pending.resolved) {
      if (pending.status === "inReview") {
        throw new InputError("baseFeedId", `Another listing of this asset is in UMA's review until ${timeText(pending.livenessEndsAt)}.`);
      }
      // The factory settles a pending listing of the same asset first; it blocks unless it resolves without deploying.
      const oo = await assertionOracle(ctx, pendingId, "factory");
      if (pending.status === "settleable") {
        const a = await getAssertion(ctx, oo, pendingId);
        if (!a || (await identifierWhitelisted(ctx, a.identifier, { oo })) !== false) {
          throw new InputError("baseFeedId", "Another listing of this asset has passed UMA's review and deploys when settled: settle it (settleDeploymentProposal) instead.");
        }
        notes.push("Another listing of this asset passed review under an identifier UMA has since removed: your call voids it first.");
      } else {
        const pv = await previewSettlementOn(ctx, oo, pendingId, from);
        if (pv.result === true) {
          throw new InputError("baseFeedId", "Another listing of this asset was disputed and UMA's voters approved it: it deploys when settled (settleDeploymentProposal).");
        }
        if (!pv.settleable) {
          throw new InputError("baseFeedId", "Another listing of this asset is disputed and UMA's voters have not ruled yet: one listing per asset at a time.");
        }
        notes.push("Another listing of this asset was disputed and UMA's voters rejected it: your call settles it first.");
      }
    }
  }
  const { approvals, requires, warnings } = await bondApprovals(ctx, from, [
    { token: ctx.usdc, spender: ctx.factory, spenderName: "the Bazaar factory", amount: totalUsdc, purpose: "the listing bond and seed" },
  ]);
  if (args.totalAmount % USDC_TO_BAZAAR !== 0n) notes.push("The amount is floored to whole micro-USDC: the factory pulls only that.");
  notes.push(
    `UMA's liveness is ${durationText(DEPLOYMENT_LIVENESS)}: anyone may dispute the listing until ${timeText(now + DEPLOYMENT_LIVENESS)} (from submission). Undisputed, anyone can then settle it to deploy the market.`,
    `On deployment you receive ${sharesText(seedUsdc * USDC_TO_BAZAAR)} insurance shares for the seed; they redeem like any insurer's, after the 13-day withdrawal cooldown.`,
    ...warnings,
  );
  return {
    action: "proposePairDeployment",
    to: ctx.factory,
    data: F().encode("proposePairDeployment", baseFeedId, args.isContinuouslyTraded, args.totalAmount, args.description),
    value: 0n,
    from,
    summary: `Propose listing "${args.description}": pulls ${usdcText(totalUsdc)}, a ${usdcText(bond)} UMA bond (lost if a dispute succeeds) and a ${usdcText(seedUsdc)} insurance seed`,
    pullsUsdc: totalUsdc * USDC_TO_BAZAAR,
    costs: [
      {
        kind: "bond",
        label: "UMA listing bond",
        amount: bond,
        unit: "USDC",
        token: ctx.usdc,
        payee: ctx.factory,
        returned: "Returned to you by UMA when the listing is approved (deployed or voided); paid to the disputer if UMA's voters reject it.",
        contingent: false,
      },
      {
        kind: "seed",
        label: "Insurance seed",
        amount: seedUsdc,
        unit: "USDC",
        token: ctx.usdc,
        payee: ctx.factory,
        returned:
          "Escrowed until UMA decides. Approved, it becomes the market's insurance fund and you hold it as insurance shares (it absorbs the market's losses). Rejected, voided or released, it is credited back to claim with claimSeedRefund.",
        contingent: false,
      },
    ],
    approvals,
    requires,
    notes,
    pairId: baseFeedId,
    bondUsdc: bond,
    seedAmountUsdc: seedUsdc,
  };
}

/**
 * Settle a listing once UMA can resolve it: the factory settles the assertion on its oracle, UMA
 * pays the bond to the winning side, and the factory applies the verdict: approved, it deploys and
 * seeds the market (or voids it if UMA has since removed the identifier it was asserted under);
 * rejected, it credits the seed back. Costs only gas.
 *
 * Refused up front: an unknown or resolved listing, and one still in UMA's liveness. A disputed
 * listing settles only after UMA's voters have ruled.
 */
export async function settleDeploymentProposal(ctx: BazaarContext, args: { assertionId: Hex; from?: Address }): Promise<CostedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const p = await deploymentProposal(ctx, id);
  if (!p) throw new InputError("assertionId", "The factory has no listing with this id.");
  if (p.resolved) throw new InputError("assertionId", "This listing is already resolved.");
  const oo = await assertionOracle(ctx, id, "factory");
  const [a, now] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx)]);
  const st = statusOf(a, now);
  requireSettleable(st, "assertionId");
  const notes: string[] = [];
  if (st.phase === "disputed") notes.push("The listing was disputed: this succeeds only once UMA's voters have ruled.");
  else if (a && (await identifierWhitelisted(ctx, a.identifier, { oo })) === false) notes.push(PAIR_DEPLOYMENT_PROPOSAL_VOIDED);
  else notes.push("Undisputed past its liveness: the market is deployed and seeded, and UMA returns the bond to the proposer.");
  return {
    action: "settleDeploymentProposal",
    to: ctx.factory,
    data: F().encode("settleDeploymentProposal", id),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Settle the listing of "${p.description}" on UMA and apply the verdict (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes,
  };
}

/**
 * Release an asset's listing slot when its assertion cannot settle on UMA's oracle (a blacklisted
 * payee, a dispute the DVM never resolves). The factory first tries to settle it, so a listing that
 * can still resolve simply resolves. Otherwise an undisputed listing past its liveness is approved
 * (deployed, or voided if its identifier was removed), and a disputed one past the 14-day grace is
 * discarded with its seed credited back for `claimSeedRefund`. The assertion stays on the oracle, so
 * the winning side can still collect its bond. Costs only gas.
 *
 * Refused up front: no pending listing for `pairId`, and one not yet releasable (liveness, plus 14
 * days if disputed), with the time it opens. A dispute filed after the identifier left UMA's
 * whitelist may be released at once; the factory keeps that fact private, so it is left to the
 * simulation.
 */
export async function expireStuckDeploymentProposal(ctx: BazaarContext, args: { pairId: Hex; from?: Address }): Promise<CostedCall> {
  const pairId = asBytes32("pairId", args.pairId);
  const p = await pendingDeployment(ctx, { pairId });
  if (!p) throw new InputError("pairId", "No listing is pending for this pair id.");
  const now = await chainNow(ctx);
  const notes: string[] = [];
  if (now < p.releaseOpensAt) {
    let maybeNow = false;
    if (p.disputed) {
      const oo = await assertionOracle(ctx, p.assertionId, "factory");
      const a = await getAssertion(ctx, oo, p.assertionId);
      maybeNow = !!a && (await identifierWhitelisted(ctx, a.identifier, { oo })) === false;
    }
    if (!maybeNow) throw new InputError("pairId", `This listing cannot be released before ${timeText(p.releaseOpensAt)}.`);
    notes.push(`The listing's identifier has left UMA's whitelist: if it was disputed after that, it is released at once; otherwise the call reverts until ${timeText(p.releaseOpensAt)}.`);
  }
  notes.push(
    p.disputed
      ? "A disputed listing that still cannot settle is discarded, and its seed credited back for claimSeedRefund."
      : "An undisputed listing past its liveness is approved: the market is deployed, unless its identifier was removed (then voided and the seed credited back).",
  );
  return {
    action: "expireStuckDeploymentProposal",
    to: ctx.factory,
    data: F().encode("expireStuckDeploymentProposal", pairId),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Release the stuck listing of "${p.description}" (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes,
  };
}

/**
 * Withdraw the seed credited back to the caller by listings that did not deploy (rejected, voided or
 * released). The factory pays only the caller. Refused up front when nothing is owed.
 */
export async function claimSeedRefund(ctx: BazaarContext, args: { from: Address }): Promise<CostedCall & { readonly amountUsdc: bigint }> {
  const from = asAddress("from", args.from);
  const owed = await seedRefundOwed(ctx, from);
  if (owed === 0n) throw new InputError("from", "No seed refund is owed to this wallet.");
  return {
    action: "claimSeedRefund",
    to: ctx.factory,
    data: F().encode("claimSeedRefund"),
    value: 0n,
    from,
    summary: `Withdraw your ${usdcText(owed)} listing seed refund`,
    costs: [],
    approvals: [],
    requires: [],
    notes: [],
    amountUsdc: owed,
  };
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

/** Decode a factory log, or null for another contract's. */
export function decodeFactoryLog(log: RawLog): DecodedLog | null {
  return F().decodeLog(log);
}

/** The assertion id and pair id a proposePairDeployment receipt created, or null. */
export function listingFromReceipt(ctx: BazaarContext, receipt: Receipt): { assertionId: Hex; pairId: Hex } | null {
  for (const lg of receipt.logs) {
    if (getAddress(lg.address) !== ctx.factory) continue;
    const d = F().decodeLog<{ assertionId: Hex; pairId: Hex }>(lg);
    if (d?.name === "PairDeploymentProposed") return { assertionId: d.args.assertionId, pairId: d.args.pairId };
  }
  return null;
}
