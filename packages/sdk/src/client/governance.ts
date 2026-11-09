/**
 * Bazaar's one governance lever: swapping the UMA identifier every listing and termination is
 * adjudicated under.
 *
 * UMA's oracle address is immutable in the factory; what UMA changes over time is its identifier
 * whitelist, so that is what Bazaar's governance track upgrades. Anyone may propose a new identifier
 * (`proposeUmaIdentifierUpgrade`): a bond of at least $5,000 and a 2-day UMA liveness. The candidate
 * must be on UMA's live whitelist and named `ASSERT_TRUTH…`. Approval does not swap anything: it
 * queues the upgrade behind a 7-day timelock (4 days once the incumbent is off UMA's whitelist),
 * after which anyone may `activateIdentifierUpgrade`. One upgrade is pending at a time.
 *
 * While the incumbent is off the whitelist (`umaIdentifierIsLive()` false), new listings and UMA
 * termination claims are refused, and an upgrade proposal is asserted under the proposed identifier
 * so a dispute on it can still be ruled on.
 */

import { type Address, type Hex, getAddress } from "viem";
import { factory as factoryCodec } from "../chain/codec.js";
import { ZERO_ADDRESS } from "../constants.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import {
  type AssertionStatus,
  type CostedCall,
  asAddress,
  asBytes32,
  assertionOracle,
  bondApprovals,
  chainNow,
  durationText,
  timeText,
  usdcText,
  getAssertion,
  identifierFromText,
  identifierText,
  identifierWhitelisted,
  isZero32,
  optimisticOracle,
  previewSettlement,
  readMany,
  readOne,
  requireBondFloor,
  requireSettleable,
  statusOf,
} from "./uma.js";

/** The identifier-upgrade bond's floor (USDC units); the bond posted is `requiredIdentifierUpgradeBond()`. */
export const IDENTIFIER_UPGRADE_BOND_USDC = 5_000n * 10n ** 6n;
/** UMA liveness of an identifier-upgrade proposal (seconds). */
export const IDENTIFIER_UPGRADE_LIVENESS = 2 * 86_400;
/** Delay between approval and activation (seconds). */
export const IDENTIFIER_UPGRADE_TIMELOCK = 7 * 86_400;
/** Delay between approval and activation once the incumbent identifier is off UMA's live whitelist (seconds). */
export const IDENTIFIER_UPGRADE_MIN_NOTICE = 4 * 86_400;
/** Every adjudication identifier begins with these 12 ASCII bytes. */
export const ASSERT_TRUTH_PREFIX = "ASSERT_TRUTH";
const DVM_DISPUTE_GRACE = 14 * 86_400;
const F = () => factoryCodec();

/** True when `identifier`'s first 12 bytes are ASCII "ASSERT_TRUTH" (the factory's truth-identifier rule). */
export function isAssertTruthIdentifier(identifier: Hex): boolean {
  return identifier.toLowerCase().startsWith(identifierFromText(ASSERT_TRUTH_PREFIX).slice(0, 2 + 24));
}

/** An identifier given as bytes32 hex or as its text ("ASSERT_TRUTH2"). */
export function parseIdentifier(field: string, value: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase() as Hex;
  try {
    return identifierFromText(value);
  } catch {
    throw new InputError(field, 'Give the identifier as its name (e.g. "ASSERT_TRUTH2") or as 32 bytes of hex.');
  }
}

/** The governance track's constants, read from the factory, plus the live bond. */
export interface IdentifierUpgradeConstants {
  readonly identifierUpgradeBondUsdc: bigint;
  readonly requiredIdentifierUpgradeBondUsdc: bigint;
  readonly identifierUpgradeLiveness: number;
  readonly identifierUpgradeTimelock: number;
  readonly identifierUpgradeMinNotice: number;
  readonly dvmDisputeGrace: number;
}

/** IDENTIFIER_UPGRADE_BOND_USDC, the live requiredIdentifierUpgradeBond, LIVENESS, TIMELOCK, MIN_NOTICE and DVM_DISPUTE_GRACE. */
export async function identifierUpgradeConstants(ctx: BazaarContext): Promise<IdentifierUpgradeConstants> {
  const v = await readMany(
    ctx,
    ["IDENTIFIER_UPGRADE_BOND_USDC", "requiredIdentifierUpgradeBond", "IDENTIFIER_UPGRADE_LIVENESS", "IDENTIFIER_UPGRADE_TIMELOCK", "IDENTIFIER_UPGRADE_MIN_NOTICE", "DVM_DISPUTE_GRACE"].map(
      (fn) => ({ to: ctx.factory, codec: F(), fn }),
    ),
  );
  return {
    identifierUpgradeBondUsdc: v[0] as bigint,
    requiredIdentifierUpgradeBondUsdc: v[1] as bigint,
    identifierUpgradeLiveness: Number(v[2]),
    identifierUpgradeTimelock: Number(v[3]),
    identifierUpgradeMinNotice: Number(v[4]),
    dvmDisputeGrace: Number(v[5]),
  };
}

/** The USDC bond (6 decimals) an identifier-upgrade proposal posts now: max(5,000 USDC, UMA's minimum). */
export async function requiredIdentifierUpgradeBond(ctx: BazaarContext): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.factory, F(), "requiredIdentifierUpgradeBond");
}

/** The identifier Bazaar's assertions are made under, as bytes32. */
export async function umaIdentifier(ctx: BazaarContext): Promise<Hex> {
  return readOne<Hex>(ctx, ctx.factory, F(), "umaIdentifier");
}

/**
 * Whether Bazaar's identifier is on UMA's live whitelist. False means new listings and UMA
 * termination claims are refused until an identifier upgrade (it is also the one-call monitoring
 * endpoint: alarm when it turns false).
 */
export async function umaIdentifierIsLive(ctx: BazaarContext): Promise<boolean> {
  return readOne<boolean>(ctx, ctx.factory, F(), "umaIdentifierIsLive");
}

/** An identifier-upgrade proposal. */
export interface IdentifierUpgradeProposalInfo {
  readonly assertionId: Hex;
  readonly proposer: Address;
  readonly newIdentifier: Hex;
  readonly newIdentifierText: string | null;
  readonly proposalTs: number;
  /** When UMA's liveness ends. */
  readonly livenessEndsAt: number;
  readonly resolved: boolean;
  /** UMA's verdict, meaningful once resolved through settlement (an expired proposal reads false). */
  readonly settlementResolution: boolean;
  readonly disputed: boolean;
  /** When expireStuckIdentifierUpgradeProposal may release it if it cannot settle: liveness end, plus 14 days if disputed. */
  readonly releaseOpensAt: number;
}

function toUpgrade(id: Hex, r: Record<string, unknown>): IdentifierUpgradeProposalInfo | null {
  if ((r.proposer as Address) === ZERO_ADDRESS) return null;
  const proposalTs = Number(r.proposalTs as bigint);
  const disputed = r.disputed as boolean;
  return {
    assertionId: id,
    proposer: getAddress(r.proposer as Address),
    newIdentifier: r.newIdentifier as Hex,
    newIdentifierText: identifierText(r.newIdentifier as Hex),
    proposalTs,
    livenessEndsAt: proposalTs + IDENTIFIER_UPGRADE_LIVENESS,
    resolved: r.resolved as boolean,
    settlementResolution: r.settlementResolution as boolean,
    disputed,
    releaseOpensAt: proposalTs + IDENTIFIER_UPGRADE_LIVENESS + (disputed ? DVM_DISPUTE_GRACE : 0),
  };
}

/** An identifier-upgrade proposal by its assertion id, or null when the factory has none. */
export async function identifierUpgradeProposal(ctx: BazaarContext, assertionId: Hex): Promise<IdentifierUpgradeProposalInfo | null> {
  const id = asBytes32("assertionId", assertionId);
  return toUpgrade(id, await readOne(ctx, ctx.factory, F(), "getIdentifierUpgradeProposal", id));
}

/** An approved upgrade waiting out its timelock. */
export interface QueuedIdentifierUpgrade {
  readonly assertionId: Hex;
  readonly newIdentifier: Hex;
  readonly newIdentifierText: string | null;
  /** When the full timelock ends. */
  readonly effectiveTs: number;
  /** When it was approved: effectiveTs less the 7-day timelock. */
  readonly approvedAt: number;
  /** When activation opens: effectiveTs, or 4 days after approval while the incumbent is off UMA's whitelist. */
  readonly activationOpensAt: number;
  readonly canActivate: boolean;
  /** Whether the incoming identifier is still on UMA's whitelist; activation cancels the upgrade if not. Null if the lookup failed. */
  readonly newIdentifierWhitelisted: boolean | null;
}

/** The governance track in one call. */
export interface IdentifierGovernanceStatus {
  readonly now: number;
  readonly umaIdentifier: Hex;
  readonly umaIdentifierText: string | null;
  readonly umaIdentifierIsLive: boolean;
  /** The proposal in UMA's review (one at a time), with its assertion's status. */
  readonly pending: (IdentifierUpgradeProposalInfo & { readonly assertion: AssertionStatus }) | null;
  readonly queued: QueuedIdentifierUpgrade | null;
  readonly constants: IdentifierUpgradeConstants;
}

/**
 * The identifier in force, whether it is live on UMA's whitelist, the pending upgrade (with where
 * its UMA assertion stands) and the queued one (with when it may activate).
 */
export async function identifierGovernance(ctx: BazaarContext): Promise<IdentifierGovernanceStatus> {
  const [[ident, live, pendingId, queuedRaw], constants, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.factory, codec: F(), fn: "umaIdentifier" },
      { to: ctx.factory, codec: F(), fn: "umaIdentifierIsLive" },
      { to: ctx.factory, codec: F(), fn: "pendingIdentifierUpgradeAssertionId" },
      { to: ctx.factory, codec: F(), fn: "queuedIdentifierUpgrade" },
    ]),
    identifierUpgradeConstants(ctx),
    chainNow(ctx),
  ]);
  let pending: IdentifierGovernanceStatus["pending"] = null;
  if (!isZero32(pendingId as Hex)) {
    const p = await identifierUpgradeProposal(ctx, pendingId as Hex);
    if (p) {
      const oo = await assertionOracle(ctx, p.assertionId, "factory");
      pending = { ...p, assertion: statusOf(await getAssertion(ctx, oo, p.assertionId), now) };
    }
  }
  const q = queuedRaw as { assertionId: Hex; newIdentifier: Hex; effectiveTs: bigint };
  let queued: QueuedIdentifierUpgrade | null = null;
  if (q.effectiveTs !== 0n) queued = await queuedInfo(ctx, q, ident as Hex, now);
  return {
    now,
    umaIdentifier: ident as Hex,
    umaIdentifierText: identifierText(ident as Hex),
    umaIdentifierIsLive: live as boolean,
    pending,
    queued,
    constants,
  };
}

async function queuedInfo(ctx: BazaarContext, q: { assertionId: Hex; newIdentifier: Hex; effectiveTs: bigint }, incumbent: Hex, now: number): Promise<QueuedIdentifierUpgrade> {
  const oo = await optimisticOracle(ctx);
  const [incumbentLive, newLive] = await Promise.all([identifierWhitelisted(ctx, incumbent, { oo }), identifierWhitelisted(ctx, q.newIdentifier, { oo })]);
  const effectiveTs = Number(q.effectiveTs);
  const approvedAt = effectiveTs - IDENTIFIER_UPGRADE_TIMELOCK;
  // The factory shortens the wait only when the whitelist answers that the incumbent is removed; a failed lookup keeps the timelock.
  const activationOpensAt = incumbentLive === false ? approvedAt + IDENTIFIER_UPGRADE_MIN_NOTICE : effectiveTs;
  return {
    assertionId: q.assertionId,
    newIdentifier: q.newIdentifier,
    newIdentifierText: identifierText(q.newIdentifier),
    effectiveTs,
    approvedAt,
    activationOpensAt,
    canActivate: now >= activationOpensAt,
    newIdentifierWhitelisted: newLive,
  };
}

/**
 * Propose switching Bazaar to `newIdentifier`. The factory pulls the bond
 * (`requiredIdentifierUpgradeBond()`, at least 5,000 USDC) from the caller with `transferFrom`
 * (approval for the factory returned in `approvals` when short) and posts it to UMA as the
 * assertion bond: returned by UMA if the proposal is approved, paid to the disputer if UMA's voters
 * reject it. Approved, the upgrade is queued for 7 days (4 once the incumbent is off UMA's
 * whitelist) and then needs {@link activateIdentifierUpgrade}.
 *
 * Before taking a new proposal the factory settles a pending one and activates a queued one that
 * may activate; it refuses while either still blocks. Refused up front: an empty identifier, one not
 * named `ASSERT_TRUTH…`, the identifier already in force, one not on UMA's live whitelist, a pending
 * proposal still in review or already approved, and a queued upgrade still timelocked. A bond quote
 * below the factory's 5,000 USDC floor can only be a wrong node answer: it throws BondQuoteError.
 *
 * @param args.newIdentifier The identifier as its name ("ASSERT_TRUTH3") or as bytes32 hex.
 */
export async function proposeUmaIdentifierUpgrade(ctx: BazaarContext, args: { newIdentifier: string; from: Address }): Promise<CostedCall> {
  const from = asAddress("from", args.from);
  const newId = parseIdentifier("newIdentifier", args.newIdentifier);
  if (isZero32(newId)) throw new InputError("newIdentifier", "Give the identifier to switch to.");
  if (!isAssertTruthIdentifier(newId)) {
    throw new InputError("newIdentifier", `Bazaar adjudicates only under UMA truth identifiers: the name must begin with ${ASSERT_TRUTH_PREFIX}.`);
  }
  const g = await identifierGovernance(ctx);
  const notes: string[] = [];
  let current = g.umaIdentifier;
  if (g.pending) {
    const ph = g.pending.assertion.phase;
    if (ph === "liveness") throw new InputError("newIdentifier", `Another upgrade proposal is in UMA's review until ${timeText(g.pending.livenessEndsAt)}: one at a time.`);
    if (ph === "settleable") {
      throw new InputError("newIdentifier", "Another upgrade proposal has passed UMA's review: settling it queues it for the timelock, and no new proposal is taken until it activates.");
    }
    // Disputed: the factory settles it first, which works only once UMA's voters have ruled, and an approval then blocks behind its timelock.
    const pv = await previewSettlement(ctx, g.pending.assertionId, { home: "factory", from });
    if (pv.result === true) {
      throw new InputError("newIdentifier", "Another upgrade proposal was disputed and UMA's voters approved it: settling it queues it for the timelock, and no new proposal is taken until it activates.");
    }
    if (!pv.settleable) {
      throw new InputError("newIdentifier", "Another upgrade proposal is disputed and UMA's voters have not ruled yet: one at a time (expireStuckIdentifierUpgradeProposal releases it after the dispute grace).");
    }
    notes.push("Another upgrade proposal was disputed and UMA's voters rejected it: your call settles it first.");
  }
  if (g.queued) {
    if (!g.queued.canActivate) {
      throw new InputError("newIdentifier", `An approved upgrade is waiting out its timelock until ${timeText(g.queued.activationOpensAt)}: no new proposal until it activates.`);
    }
    notes.push("Your call first activates the queued upgrade.");
    if (g.queued.newIdentifierWhitelisted !== false) current = g.queued.newIdentifier;
  }
  if (newId === current.toLowerCase()) throw new InputError("newIdentifier", "That identifier is already the one in force.");
  const oo = await optimisticOracle(ctx);
  const wl = await identifierWhitelisted(ctx, newId, { oo });
  if (wl === false) throw new InputError("newIdentifier", "That identifier is not on UMA's live whitelist.");
  if (wl === null) notes.push("UMA's whitelist could not be read: the factory checks it itself and refuses an identifier it cannot confirm.");
  const bond = await requiredIdentifierUpgradeBond(ctx);
  requireBondFloor("an identifier-upgrade bond", bond, IDENTIFIER_UPGRADE_BOND_USDC);
  const { approvals, requires, warnings } = await bondApprovals(ctx, from, [
    { token: ctx.usdc, spender: ctx.factory, spenderName: "the Bazaar factory", amount: bond, purpose: "the identifier-upgrade bond" },
  ]);
  notes.push(
    `Open for dispute for ${durationText(IDENTIFIER_UPGRADE_LIVENESS)}. Approved, it is queued for ${durationText(IDENTIFIER_UPGRADE_TIMELOCK)} (${durationText(IDENTIFIER_UPGRADE_MIN_NOTICE)} if the current identifier is off UMA's whitelist) before anyone can activate it.`,
  );
  if (!g.umaIdentifierIsLive) notes.push("The current identifier is off UMA's whitelist, so this proposal is asserted under the proposed identifier, keeping a dispute on it resolvable.");
  notes.push(...warnings);
  const name = identifierText(newId) ?? newId;
  return {
    action: "proposeUmaIdentifierUpgrade",
    to: ctx.factory,
    data: F().encode("proposeUmaIdentifierUpgrade", newId),
    value: 0n,
    from,
    summary: `Propose switching Bazaar's UMA identifier to ${name}: posts a ${usdcText(bond)} bond, returned if UMA approves, lost to a disputer if it rejects`,
    pullsUsdc: bond * 10n ** 12n,
    costs: [
      {
        kind: "bond",
        label: "Identifier-upgrade bond",
        amount: bond,
        unit: "USDC",
        token: ctx.usdc,
        payee: ctx.factory,
        returned: "Returned to you by UMA when the proposal is approved; paid to the disputer if UMA's voters reject it.",
        contingent: false,
      },
    ],
    approvals,
    requires,
    notes,
  };
}

/**
 * Settle an identifier-upgrade proposal once UMA can resolve it: UMA pays the bond to the winning
 * side, and an approved upgrade is queued behind the timelock. Costs only gas. Refused up front: an
 * unknown or resolved proposal, and one still in UMA's liveness; a disputed one settles only after
 * UMA's voters have ruled.
 */
export async function settleIdentifierUpgradeProposal(ctx: BazaarContext, args: { assertionId: Hex; from?: Address }): Promise<CostedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const p = await identifierUpgradeProposal(ctx, id);
  if (!p) throw new InputError("assertionId", "The factory has no identifier-upgrade proposal with this id.");
  if (p.resolved) throw new InputError("assertionId", "This proposal is already resolved.");
  const oo = await assertionOracle(ctx, id, "factory");
  const [a, now] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx)]);
  const st = statusOf(a, now);
  requireSettleable(st, "assertionId");
  return {
    action: "settleIdentifierUpgradeProposal",
    to: ctx.factory,
    data: F().encode("settleIdentifierUpgradeProposal", id),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Settle the upgrade to ${p.newIdentifierText ?? p.newIdentifier} on UMA and apply the verdict (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes: [
      st.phase === "disputed"
        ? "The proposal was disputed: this succeeds only once UMA's voters have ruled."
        : `Undisputed past its liveness: the upgrade is approved and queued for ${durationText(IDENTIFIER_UPGRADE_TIMELOCK)}.`,
    ],
  };
}

/**
 * Release the single pending-upgrade slot when its assertion cannot settle on UMA's oracle. The
 * factory first tries to settle it; otherwise an undisputed proposal past liveness is approved and
 * queued, and a disputed one past the 14-day grace is discarded (the assertion stays on the oracle so
 * the winning side can still collect its bond). Costs only gas.
 *
 * Refused up front: no pending proposal, and one not yet releasable (liveness, plus 14 days if
 * disputed). A dispute filed after the identifier left UMA's whitelist may be released at once; the
 * factory keeps that fact private, so it is left to the simulation.
 */
export async function expireStuckIdentifierUpgradeProposal(ctx: BazaarContext, args: { from?: Address } = {}): Promise<CostedCall> {
  const [pendingId, now] = await Promise.all([readOne<Hex>(ctx, ctx.factory, F(), "pendingIdentifierUpgradeAssertionId"), chainNow(ctx)]);
  if (isZero32(pendingId)) throw new InputError("assertionId", "No identifier upgrade is pending.");
  const p = (await identifierUpgradeProposal(ctx, pendingId))!;
  const notes: string[] = [];
  if (now < p.releaseOpensAt) {
    let maybeNow = false;
    if (p.disputed) {
      const oo = await assertionOracle(ctx, pendingId, "factory");
      const a = await getAssertion(ctx, oo, pendingId);
      maybeNow = !!a && (await identifierWhitelisted(ctx, a.identifier, { oo })) === false;
    }
    if (!maybeNow) throw new InputError("assertionId", `The pending upgrade cannot be released before ${timeText(p.releaseOpensAt)}.`);
    notes.push(`Its identifier has left UMA's whitelist: if it was disputed after that, it is released at once; otherwise the call reverts until ${timeText(p.releaseOpensAt)}.`);
  }
  notes.push(p.disputed ? "A disputed proposal that still cannot settle is discarded, freeing the slot." : "An undisputed proposal past its liveness is approved and queued.");
  return {
    action: "expireStuckIdentifierUpgradeProposal",
    to: ctx.factory,
    data: F().encode("expireStuckIdentifierUpgradeProposal"),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Release the stuck upgrade proposal to ${p.newIdentifierText ?? p.newIdentifier} (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes,
  };
}

/**
 * Activate the queued identifier upgrade once its timelock has run (or 4 days after approval while
 * the incumbent is off UMA's whitelist). Anyone may call it; it costs only gas. The factory checks
 * the whitelist again: an incoming identifier UMA has removed since cancels the upgrade and keeps the
 * incumbent. Refused up front: nothing queued, and a call before activation opens.
 */
export async function activateIdentifierUpgrade(ctx: BazaarContext, args: { from?: Address } = {}): Promise<CostedCall> {
  const [[ident, queuedRaw], now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.factory, codec: F(), fn: "umaIdentifier" },
      { to: ctx.factory, codec: F(), fn: "queuedIdentifierUpgrade" },
    ]),
    chainNow(ctx),
  ]);
  const q = queuedRaw as { assertionId: Hex; newIdentifier: Hex; effectiveTs: bigint };
  if (q.effectiveTs === 0n) throw new InputError("assertionId", "No identifier upgrade is queued.");
  const info = await queuedInfo(ctx, q, ident as Hex, now);
  if (!info.canActivate) throw new InputError("assertionId", `The upgrade can be activated from ${timeText(info.activationOpensAt)}.`);
  const name = info.newIdentifierText ?? info.newIdentifier;
  return {
    action: "activateIdentifierUpgrade",
    to: ctx.factory,
    data: F().encode("activateIdentifierUpgrade"),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Activate the switch to UMA identifier ${name} (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes: [
      info.newIdentifierWhitelisted === false
        ? `${name} is no longer on UMA's whitelist: activating cancels the upgrade and keeps the current identifier.`
        : `From then on, new listings and termination claims are asserted under ${name}; assertions already made keep theirs.`,
    ],
  };
}

/** What each governance event means, for an activity feed (decode them with listings' decodeFactoryLog). */
export const IDENTIFIER_UPGRADE_EVENT_TEXT: Readonly<Record<string, string>> = {
  UmaIdentifierUpgradeProposed: "An identifier upgrade was proposed: its UMA liveness started.",
  UmaIdentifierUpgradeDisputed: "The identifier upgrade was disputed: UMA's voters will decide it.",
  UmaIdentifierUpgradeQueued: "UMA approved the identifier upgrade: it is queued behind the timelock.",
  UmaIdentifierUpgraded: "The identifier upgrade was activated: new assertions use the new identifier.",
  UmaIdentifierUpgradeCanceled: "The queued upgrade was canceled at activation: UMA had removed the incoming identifier.",
  UmaIdentifierUpgradeExpired: "A disputed upgrade proposal that could not settle was discarded.",
};
