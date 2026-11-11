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
 * Pyth Pro feed refuses a new one.
 *
 * A feed is named by its Pyth Pro feed ID, a number (BTC/USD is 1), which the contracts hold in a
 * bytes32. The builders take either form. Whether Pyth publishes a feed under an ID is not something
 * the chain can see: it is the first thing the listing's claim asks UMA to verify, and the builders
 * check it against Pyth Pro's symbols registry where one is at hand.
 *
 * Assets quoted in another currency trade against a composite feed (`base × quote` or
 * `base ÷ quote`), registered permissionlessly on the oracle before it is proposed
 * (`registerComposite`).
 */

import { type Address, type Hex, encodePacked, getAddress, keccak256 } from "viem";
import type { Receipt } from "../chain/client.js";
import { type DecodedLog, type RawLog, factory as factoryCodec, oracle as oracleCodec, pair as pairCodec } from "../chain/codec.js";
import { BAZAAR_SCALE, USDC_TO_BAZAAR, ZERO_ADDRESS } from "../constants.js";
import { LazerError, feedIdHex, isRawFeedId, proFeedId } from "../prices/lazer.js";
import { type ProSymbol, printable } from "../prices/pro.js";
import { InputError } from "./calls.js";
import type { BazaarContext, SubgraphSource } from "./context.js";
import { SubgraphError } from "./history.js";
import { type SymbolSource, cachedRegistry, contextRegistry } from "./registry.js";
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

/** A feed ID as a caller may give it: the Pyth Pro feed number (a number, a bigint or decimal digits) or the bytes32 that holds it; a composite ID only as its bytes32. */
export type FeedIdInput = Hex | number | bigint | string;

const DECIMAL = /^\d{1,10}$/;

/**
 * `v` as the bytes32 feed ID the contracts take: a Pyth Pro feed number (1, 1n, "1") becomes the
 * bytes32 holding it, and a bytes32 is returned as it is (lowercase), raw or composite. Throws
 * InputError on `field` for anything else.
 */
export function asFeedId(field: string, v: FeedIdInput): Hex {
  if (typeof v === "string" && v.startsWith("0x")) return asBytes32(field, v as Hex).toLowerCase() as Hex;
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" && DECIMAL.test(v.trim()) ? Number(v.trim()) : v;
  try {
    return feedIdHex(n as number);
  } catch (e) {
    if (!(e instanceof LazerError)) throw e;
    throw new InputError(field, "Give a Pyth Pro feed ID: a number such as 1 (BTC/USD), or the 32-byte hex that holds it.");
  }
}

/** A feed ID for a message: a raw Pyth Pro ID as its number, a composite as its short hex. */
const feedText = (id: Hex) => (isRawFeedId(id) ? String(proFeedId(id)) : `${id.slice(0, 10)}…`);

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
export function compositeId(baseId: FeedIdInput, quoteId: FeedIdInput, invertQuote: boolean): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32", "bool"], [asFeedId("baseId", baseId), asFeedId("quoteId", quoteId), invertQuote]));
}

/** The legs `id` resolves to on the oracle, or null when it is not a registered composite (a raw feed id, or an unregistered one). */
export async function getComposite(ctx: BazaarContext, id: FeedIdInput): Promise<CompositeFeed | null> {
  const c = await readOne<CompositeFeed>(ctx, ctx.oracle, O(), "composites", asFeedId("id", id));
  return isZero32(c.baseId) ? null : c;
}

/**
 * Register a composite feed on Bazaar's oracle, so `compositeId(baseId, quoteId, invertQuote)` can be
 * listed. Permissionless and idempotent (a registered composite is left as it is), and it costs only
 * gas. Register before proposing: the factory refuses an id that is neither a raw Pyth Pro feed id
 * nor a registered composite.
 *
 * Refused up front, as the oracle refuses them (BazaarOracle__InvalidCompositeLegs): a leg that is
 * not a raw Pyth Pro feed id (which also rules out nesting one composite inside another), and the
 * same feed twice.
 *
 * @param args.baseId The asset's Pyth Pro feed in its native currency, as its number or its bytes32.
 * @param args.quoteId The Pyth Pro FX feed linking that currency to USD.
 * @param args.invertQuote False when the FX feed is CCY/USD (multiply), true when it is USD/CCY (divide).
 * @param args.from The account that will send it, when known.
 */
export async function registerComposite(
  ctx: BazaarContext,
  args: { baseId: FeedIdInput; quoteId: FeedIdInput; invertQuote: boolean; from?: Address },
): Promise<CostedCall & { readonly compositeId: Hex }> {
  const baseId = asFeedId("baseId", args.baseId);
  const quoteId = asFeedId("quoteId", args.quoteId);
  if (!isRawFeedId(baseId)) throw new InputError("baseId", "Give the asset's Pyth Pro feed ID (a number such as 1): a composite's legs must both be plain Pyth Pro feeds.");
  if (!isRawFeedId(quoteId)) throw new InputError("quoteId", "Give the FX leg's Pyth Pro feed ID (a number): a composite's legs must both be plain Pyth Pro feeds.");
  if (baseId === quoteId) throw new InputError("quoteId", "The FX leg must be a different feed from the asset's.");
  const id = compositeId(baseId, quoteId, args.invertQuote);
  const existing = await readOne<CompositeFeed>(ctx, ctx.oracle, O(), "composites", id);
  const already = !isZero32(existing.baseId);
  return {
    action: "registerComposite",
    to: ctx.oracle,
    data: O().encode("registerComposite", baseId, quoteId, args.invertQuote),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Register the composite feed ${id.slice(0, 10)}… (feed ${feedText(baseId)} ${args.invertQuote ? "÷" : "×"} FX feed ${feedText(quoteId)}) on Bazaar's oracle (no cost but gas)`,
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

/** The raw Pyth Pro feed a listing prices: the feed itself, or a composite's base leg (the key one-market-per-asset is enforced on). */
export async function rawBaseFeed(ctx: BazaarContext, baseFeedId: FeedIdInput): Promise<Hex> {
  const id = asFeedId("baseFeedId", baseFeedId);
  const c = await getComposite(ctx, id);
  return c ? c.baseId : id;
}

/**
 * The listing proposal pending for an asset, or null. By `pairId` it reads
 * `pendingDeploymentByPairId`; by `baseFeedId` it reads `pendingDeploymentByBaseFeed` under the raw
 * feed (a composite's base leg), which also finds a composite of the same asset through another FX
 * leg.
 */
export async function pendingDeployment(ctx: BazaarContext, by: { pairId: Hex } | { baseFeedId: FeedIdInput }): Promise<DeploymentProposalInfo | null> {
  const id =
    "pairId" in by
      ? await readOne<Hex>(ctx, ctx.factory, F(), "pendingDeploymentByPairId", asBytes32("pairId", by.pairId))
      : await readOne<Hex>(ctx, ctx.factory, F(), "pendingDeploymentByBaseFeed", await rawBaseFeed(ctx, by.baseFeedId));
  return isZero32(id) ? null : deploymentProposal(ctx, id);
}

/** Where {@link openListings} looks for listing proposals. */
export interface ListingSearch {
  /** Assertion ids the UI already knows. */
  readonly ids?: readonly Hex[];
  /** Scan the factory's logs from this block (to `toBlock`); used when the context has no subgraph. */
  readonly fromBlock?: number;
  readonly toBlock?: number;
}

export interface OpenListings {
  /** Unresolved listing proposals as the chain reads them now, oldest first. */
  readonly listings: DeploymentProposalInfo[];
  /** Where the ids came from: Bazaar's subgraph, the factory's logs, only the ids passed, or nowhere. */
  readonly source: "subgraph" | "logs" | "ids" | "none";
}

/** Most open listings the subgraph may report; more is refused as a broken answer. */
export const MAX_OPEN_LISTINGS = 1_000;
/** Most listing ids read on chain in one call; a log scan that finds more needs a later `fromBlock`. */
export const MAX_LISTING_IDS = 10_000;
const LISTING_PAGE = 100;
const BYTES32_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * The ids of unresolved listing proposals from Bazaar's subgraph, paged by id (ascending). Every id
 * must be 32 bytes of hex and strictly greater than the one before (so paging always advances), a
 * page may hold no more rows than asked, and the total is capped at {@link MAX_OPEN_LISTINGS}: an
 * answer that breaks any of these is refused rather than half-used.
 */
async function subgraphListingIds(sg: SubgraphSource): Promise<Hex[]> {
  const refuse = (why: string) =>
    new SubgraphError(
      `Bazaar's subgraph answered the open-listing query with ${why}, so its answer was not used: pass the assertion ids you know (ids) or scan the factory's logs (fromBlock) instead.`,
    );
  const ids: Hex[] = [];
  let after: Hex | null = null;
  for (;;) {
    // `after` is an id this function checked against BYTES32_ID: safe to place in the query.
    const where = `status_in: [Pending, Disputed]${after ? `, id_gt: "${after}"` : ""}`;
    const res = await sg.query<Record<string, unknown> | null>(
      `query OpenListings {\n  listingProposals(first: ${LISTING_PAGE}, orderBy: id, orderDirection: asc, where: { ${where} }) { id }\n}`,
    );
    if (res === null || typeof res !== "object") throw refuse("no data");
    const rows = res.listingProposals ?? [];
    if (!Array.isArray(rows)) throw refuse("no list of listing proposals");
    if (rows.length > LISTING_PAGE) throw refuse("more listing proposals in one page than asked for");
    for (const r of rows) {
      const id = (r as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !BYTES32_ID.test(id)) throw refuse("a proposal id that is not 32 bytes of hex");
      const lc = id.toLowerCase() as Hex;
      if (after && lc <= after) throw refuse("listing proposals out of id order (its paging did not advance)");
      after = lc;
      ids.push(lc);
    }
    if (ids.length > MAX_OPEN_LISTINGS) throw refuse(`more than ${MAX_OPEN_LISTINGS} open listing proposals`);
    if (rows.length < LISTING_PAGE) return ids;
  }
}

/**
 * The listing proposals not yet resolved: in UMA's liveness, settleable, or disputed and waiting on
 * UMA's vote. The factory keeps them in maps keyed by pair id and by feed, which no call can list, so
 * ids come from Bazaar's subgraph when the context has one, else from the factory's
 * `PairDeploymentProposed` logs when `fromBlock` is given, plus any `ids` passed. Each is then read on
 * chain, so the answer reflects the chain, not the index: a proposal the subgraph still shows as
 * pending but the chain has resolved is left out.
 */
export async function openListings(ctx: BazaarContext, search: ListingSearch = {}): Promise<OpenListings> {
  const ids = new Set<Hex>((search.ids ?? []).map((x) => asBytes32("ids", x).toLowerCase() as Hex));
  let source: OpenListings["source"] = ids.size ? "ids" : "none";
  if (ctx.subgraph) {
    for (const id of await subgraphListingIds(ctx.subgraph)) ids.add(id);
    source = "subgraph";
  } else if (search.fromBlock !== undefined) {
    const to = search.toBlock ?? (await ctx.chain.blockNumber());
    for (const lg of await ctx.chain.logs(search.fromBlock, to, [ctx.factory])) {
      const d = F().decodeLog<{ assertionId?: Hex }>(lg);
      if (d?.name === "PairDeploymentProposed" && d.args.assertionId) ids.add(d.args.assertionId.toLowerCase() as Hex);
    }
    source = "logs";
  }
  if (ids.size > MAX_LISTING_IDS) {
    throw new InputError("fromBlock", `found ${ids.size} listing proposals, more than ${MAX_LISTING_IDS} to read at once: scan from a later block`);
  }
  if (!ids.size) return { listings: [], source };
  const list = [...ids];
  const [res, now] = await Promise.all([
    readMany(ctx, [
      ...list.map((id) => ({ to: ctx.factory, codec: F(), fn: "getDeploymentProposal", args: [id] })),
      ...list.map((id) => ({ to: ctx.factory, codec: F(), fn: "deploymentDisputed", args: [id] })),
    ]),
    chainNow(ctx),
  ]);
  const listings: DeploymentProposalInfo[] = [];
  list.forEach((id, i) => {
    const info = toDeployment(id, res[i] as Record<string, unknown>, res[list.length + i] as boolean, now);
    if (info && !info.resolved) listings.push(info);
  });
  listings.sort((a, b) => a.proposalTs - b.proposalTs || (a.assertionId < b.assertionId ? -1 : 1));
  return { listings, source };
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
 * invalid description; a composite marked continuously traded; an id that is neither a raw Pyth Pro
 * feed id nor a registered composite (register the composite first); a feed Pyth Pro's symbols
 * registry does not list; a live market over the same asset; another listing of the asset still in
 * review or headed for deployment; and UMA's identifier off its live whitelist (listings fail closed
 * until the identifier upgrade). A bond quote below the factory's 1,000 USDC floor can only be a
 * wrong node answer: it throws BondQuoteError. An allowance already above what the call pulls is
 * flagged in `notes`.
 *
 * The registry check protects the bond: a listing of a feed Pyth does not publish is disputed and
 * loses it. It reads the registry of the context's Pyth Pro price source, or `registry` when given,
 * and says in `notes` what the registry lists each feed as. Where no registry is at hand, or it
 * cannot be read, the check is skipped and `notes` says so.
 *
 * @param args.baseFeedId A Pyth Pro feed id (its number, or the bytes32 holding it), or a composite id registered on Bazaar's oracle.
 * @param args.isContinuouslyTraded True only for assets that trade around the clock (crypto); false for anything with sessions, and always for composites.
 * @param args.totalAmount The whole deposit in BAZAAR precision (4_000e18 is $4,000): the bond plus the seed.
 * @param args.description What the asset is, e.g. "AAPL on NASDAQ".
 * @param args.from The account that will send it and post the bond.
 * @param args.registry Where to look the feeds up: a symbols registry's base URL or a source; null to skip the check. Default the context's.
 */
export async function proposePairDeployment(
  ctx: BazaarContext,
  args: { baseFeedId: FeedIdInput; isContinuouslyTraded: boolean; totalAmount: bigint; description: string; from: Address; registry?: string | SymbolSource | null },
): Promise<CostedCall & { readonly pairId: Hex; readonly bondUsdc: bigint; readonly seedAmountUsdc: bigint; readonly legFeeds: readonly (ProSymbol | null)[] }> {
  const baseFeedId = asFeedId("baseFeedId", args.baseFeedId);
  const from = asAddress("from", args.from);
  if (isZero32(baseFeedId)) throw new InputError("baseFeedId", "Give the asset's Pyth Pro feed ID.");
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
  if (!comp && !isRawFeedId(baseFeedId)) {
    throw new InputError(
      "baseFeedId",
      "This is neither a Pyth Pro feed ID (a number such as 1, or the 32-byte hex holding it) nor a composite registered on Bazaar's oracle: for a non-USD asset, register its composite feed first and list that.",
    );
  }
  const raw = comp ? comp.baseId : baseFeedId;
  const legs = comp ? [comp.baseId.toLowerCase() as Hex, comp.quoteId.toLowerCase() as Hex] : [baseFeedId];
  const [r, registry] = await Promise.all([
    readMany(ctx, [
      { to: ctx.factory, codec: F(), fn: "requiredDeploymentBond" },
      { to: ctx.factory, codec: F(), fn: "umaIdentifierIsLive" },
      { to: ctx.factory, codec: F(), fn: "pairAddressById", args: [baseFeedId] },
      { to: ctx.factory, codec: F(), fn: "pairAddressByBaseFeed", args: [raw] },
      { to: ctx.factory, codec: F(), fn: "pendingDeploymentByBaseFeed", args: [raw] },
    ]),
    registryEntries(ctx, legs, args.registry),
  ]);
  const [bond, live, existing, holder, pendingId] = r as [bigint, boolean, Address, Address, Hex];
  const registryNotes: string[] = [];
  const legFeeds: (ProSymbol | null)[] = legs.map(() => null);
  if (registry === "unread") {
    registryNotes.push("Pyth Pro's symbols registry could not be read, so the feed was not checked against it: confirm the feed ID before sending.");
  } else if (registry !== null) {
    legs.forEach((leg, i) => {
      const entry = registry.get(leg);
      if (!entry) {
        throw new InputError(
          "baseFeedId",
          `Pyth Pro's symbols registry lists no feed with ID ${feedText(leg)}: check the ID (Pyth Pro feed IDs are numbers; Pyth Core's 32-byte IDs are a different namespace).`,
        );
      }
      legFeeds[i] = entry;
      registryNotes.push(feedNote(entry));
    });
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
    ...registryNotes,
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
    legFeeds,
  };
}

/**
 * Pyth Pro's registry entries for `legs`: null when there is no registry to ask (`opt` is null, or
 * it is left out and the context has no Pyth Pro source), "unread" when it cannot be read or answers
 * with nothing, else the entries it lists among `legs`.
 */
async function registryEntries(ctx: BazaarContext, legs: readonly Hex[], opt: string | SymbolSource | null | undefined): Promise<Map<Hex, ProSymbol> | "unread" | null> {
  const source = opt === null ? null : (opt ?? contextRegistry(ctx));
  if (!source) return null;
  let all: ProSymbol[];
  try {
    all = await cachedRegistry(source).symbols();
  } catch {
    return "unread";
  }
  if (all.length === 0) return "unread";
  const out = new Map<Hex, ProSymbol>();
  for (const e of all) if (legs.includes(e.feedId) && !out.has(e.feedId)) out.set(e.feedId, e);
  return out;
}

/** What the registry lists a feed as, for a builder's notes: its text made printable and bounded, whatever source listed it. */
function feedNote(e: ProSymbol): string {
  const t = (s: string) => printable(typeof s === "string" ? s : "", 100);
  const [symbol, name, assetType, state, minChannel, schedule] = [e.symbol, e.name, e.assetType, e.state, e.minChannel, e.schedule].map(t);
  const facts = [assetType, state && `state ${state}`, minChannel && `fastest channel ${minChannel}`, schedule && `schedule ${schedule}`].filter(Boolean);
  return `Pyth Pro's registry lists feed ${e.id} as ${symbol || name || "an unnamed feed"}${facts.length ? ` (${facts.join(", ")})` : ""}: UMA's voters check it against the description.`;
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
