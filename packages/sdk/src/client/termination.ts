/**
 * Ending a market: termination through a UMA claim or an insurer vote, fixing the settlement price,
 * and finalizing.
 *
 * Every Bazaar market can be wound down without anyone's permission:
 * - **UMA claim** (`proposeTermination`): a cessation event, posted with a USDC bond and a 12 h UMA
 *   liveness. Every claim also opens an insurer vote on its own cutoff.
 * - **Insurer vote** (`proposeInsurerTermination`, `voteForInsurerTermination`,
 *   `executeInsurerTermination`): matured insurance shares reaching 60% of the snapshot latch a
 *   cutoff, no later than one hour before it.
 * - **Stale oracle** (`terminateStalePair`): the pair has stored no price for 21 days.
 * - **Autonomous**: the pair's own insolvency checks (nothing to call).
 *
 * Every path is two-stage: the terminator fixes the settlement price (`terminateScheduledPair` at a
 * scheduled cutoff, or `terminateStalePair`), which opens the settlement window; then, once every
 * position is settled at that price or 14 days have passed, anyone calls `finalizeTermination` on
 * the pair and withdrawals open at the frozen payout ratios.
 *
 * Builders that post bonds, lock shares or pay fees return a {@link CostedCall}: a PreparedCall with
 * its `costs`, the USDC `approvals` to send first, and what it `requires`.
 */

import { type Address, type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";
import type { Receipt } from "../chain/client.js";
import { type DecodedLog, type RawLog, lens as lensCodec, oracle as oracleCodec, pair as pairCodec, terminator as terminatorCodec, factory as factoryCodec } from "../chain/codec.js";
import { type DecodedError, decodeError } from "../chain/errors.js";
import { toRpcError } from "../chain/rpc.js";
import {
  BP_SCALE,
  ETH_USD_FEED,
  LIMBO_LEAD,
  ORACLE_DEAD_THRESHOLD,
  SETTLEMENT_SAMPLE_COUNT,
  SETTLEMENT_SAMPLE_SPACING,
  SETTLE_AWAIT_VERDICT,
  SETTLE_CHAIN,
  SETTLE_NOTHING,
  SETTLE_TICK,
  TERMINAL_SETTLEMENT_ESCAPE,
  USDC_TO_BAZAAR,
  ZERO_ADDRESS,
} from "../constants.js";
import { CHAIN_PROPERTIES, CHANNEL_FIXED_RATE_1000, HAS_FEED_UPDATE_TIMESTAMP, MICROS_PER_SECOND, TICK_PROPERTIES } from "../prices/lazer.js";
import { type ProUpdate, printable } from "../prices/pro.js";
import { redactUrls } from "../urls.js";
import { InputError, simulate } from "./calls.js";
import { type BazaarContext, ConnectError, type PriceUpdateSource, type SubgraphSource } from "./context.js";
import { pairFeeds } from "./feeds.js";
import { SubgraphError } from "./history.js";
import {
  type Cost,
  type CostedCall,
  asAddress,
  asBytes32,
  assertionOracle,
  bondApprovals,
  chainNow,
  durationText,
  ethText,
  sharesText,
  timeText,
  usdcText,
  getAssertion,
  isZero32,
  previewSettlementOn,
  readMany,
  readOne,
  requireBondFloor,
  requireSettleable,
  statusOf,
} from "./uma.js";
import { formatDecimal } from "./units.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** The UMA termination bond's floor (USDC units); the bond posted is `requiredTerminationBond()`, which tracks UMA's own minimum upward. */
export const TERMINATION_PROPOSAL_BOND_USDC = 1_000n * 10n ** 6n;
/** UMA liveness of a termination claim (seconds). */
export const TERMINATION_PROPOSAL_LIVENESS = 12 * 3_600;
/** Longest `reason` a termination claim takes, in bytes. */
export const MAX_REASON_LENGTH = 1_000;
/** A cutoff sooner than this after acceptance is moved to this far after it (BazaarTypes.MIN_CUTOFF_LEAD: limbo lead + 1 s). */
export const MIN_CUTOFF_LEAD = LIMBO_LEAD + 1;
/** Earliest a proposed cutoff may sit after the proposal, for a UMA claim and a bare insurer proposal alike (seconds). */
export const INSURER_TERMINATION_MIN_LEAD = 2 * 3_600;
/** Voting and the latch close this long before a proposal's cutoff (seconds). */
export const INSURER_TERMINATION_LATCH_LEAD = 3_600;
/** Votes open this long before the cutoff (or at filing if later), and a bare cutoff may sit no further out (seconds). */
export const INSURER_TERMINATION_MAX_LEAD = 14 * 86_400;
/** Share of the snapshot that must vote yes (basis points). */
export const INSURER_TERMINATION_THRESHOLD_BP = 6_000n;
/** The bond a bare insurer proposal posts (USDC units), a fixed figure. */
export const INSURER_TERMINATION_BOND_USDC = TERMINATION_PROPOSAL_BOND_USDC;
/** Shares must be held this long before the vote window opens to vote (seconds). */
export const INSURER_SHARE_MATURITY_PERIOD = 4 * 86_400;
/** Most live proposals one voter may back on a pair. */
export const INSURER_MAX_LIVE_VOTES = 8;
/** Levy on each yes-voted share when the claim behind the vote is rejected (basis points). */
export const INSURER_LEVY_BP = 5_000n;
/** The least an unjudged outcome levies on each yes-voted share (basis points). */
export const INSURER_LEVY_FLOOR_BP = 1_000n;
/** How long after a claim is filed its vote-scheduled pair waits for the verdict (seconds). */
export const CLAIM_VERDICT_GRACE = 14 * 86_400;
/** Yes-voters of a costed outcome stay locked this long after the price fix: the insurance withdrawal cooldown (seconds). */
export const INSURER_POST_FIX_LOCK = 13 * 86_400;
/** Under UMA's rule only the cutoff's update settles for this long after the cutoff (or the verdict); then an empty call settles at the stored price (seconds). */
export const SCHEDULED_TERMINATION_GRACE = 12 * 3_600;
/** The settlement price (BAZAAR precision) a pair that never stored a price settles at under the stored-price paths (NEVER_PRICED_SETTLEMENT_PRICE). */
export const NEVER_PRICED_SETTLEMENT_PRICE = 1n;
/** BazaarPair storage slot of `shareEpoch`, which the terminator reads with `extsload` (PAIR_SLOT_SHARE_EPOCH). */
export const PAIR_SLOT_SHARE_EPOCH = 95n;

/** The four grounds a UMA termination claim may declare. */
export const TerminationCategory = {
  OracleDecommission: 1,
  AssetCessation: 2,
  StructuralChange: 3,
  PythVerifierMigration: 4,
} as const;
export type TerminationCategory = (typeof TerminationCategory)[keyof typeof TerminationCategory];

/** What each category means, condensed from the claim text the terminator writes into UMA's assertion. */
export const TERMINATION_CATEGORY_INFO: Readonly<Record<TerminationCategory, { readonly name: string; readonly description: string }>> = {
  1: {
    name: "Oracle decommission",
    description:
      "The market's Pyth Pro feed (either leg of a composite) has stopped publishing, or is scheduled to be decommissioned or to stop publishing.",
  },
  2: {
    name: "Asset cessation",
    description:
      "The asset has been or will be delisted from the exchange its feed tracks: delisting, merger or acquisition, bankruptcy, or an indefinite regulatory halt. A future event counts only once it is officially confirmed with a fixed date.",
  },
  3: {
    name: "Structural change",
    description:
      "An officially scheduled event makes the price series discontinuous: a split or reverse split, spinoff, rights offering, special distribution over 5%, redenomination or migration, or an index re-basing. Regular dividends and market moves of any size do not count.",
  },
  4: {
    name: "Pyth verifier migration",
    description:
      "The Pyth Pro verifier contract the market's oracle uses has been deprecated, is being replaced by a contract at a new address, or no longer verifies the updates Pyth distributes.",
  },
};

export type SettlementRuleKey = "nothing" | "tick" | "chain" | "awaitVerdict";

/** settlementRule's answers, by number. */
export const SETTLEMENT_RULE_KEYS: Readonly<Record<number, SettlementRuleKey>> = {
  [SETTLE_NOTHING]: "nothing",
  [SETTLE_TICK]: "tick",
  [SETTLE_CHAIN]: "chain",
  [SETTLE_AWAIT_VERDICT]: "awaitVerdict",
};

/** What each settlement rule means. */
export const SETTLEMENT_RULE_TEXT: Readonly<Record<SettlementRuleKey, string>> = {
  nothing: "Nothing to settle: the market has no scheduled cutoff, or its settlement price is already fixed.",
  tick:
    "UMA's rule: the market settles at the price Pyth's one-second update stamped at its cutoff carries, for every feed leg (a quiet feed's update carries its last price forward). Only that update settles it until the grace ends; after that, a call without it settles at the market's last stored price.",
  chain:
    "The chain rule: the market settles at the median of five Pyth prices chained from its cutoff, the first from the earliest one-second update carrying a price generated at or after the cutoff and each later one from the earliest carrying a price generated at least 10 minutes after the update before. There is no stored-price fallback until the last resort opens (21 days after the cutoff, or 12 hours after a UMA cutoff that caps the chain).",
  awaitVerdict:
    "Waiting for UMA's verdict on the claim behind the insurer vote that set the cutoff: if UMA upholds it the market settles under UMA's rule, otherwise under the chain rule.",
};

export type VerdictName = "pending" | "true" | "false";
export const VERDICT_NAMES: Readonly<Record<number, VerdictName>> = { 0: "pending", 1: "true", 2: "false" };

export type OutcomeName = "none" | "true" | "false" | "unjudged";
export const OUTCOME_NAMES: Readonly<Record<number, OutcomeName>> = { 0: "none", 1: "true", 2: "false", 3: "unjudged" };

/** What each insurer-vote outcome means for its yes-voters. */
export const OUTCOME_TEXT: Readonly<Record<OutcomeName, string>> = {
  none: "Not stamped yet: the outcome is recorded when the settlement price is fixed.",
  true: "UMA upheld the claim behind the vote: the market settled under UMA's rule, and the yes-voters owe nothing.",
  false: "UMA rejected the claim: the market settled under the chain rule; yes-voters stay locked 13 days after the fix and forfeit half of every share they voted.",
  unjudged:
    "No verdict (a bare vote, or a claim UMA did not rule on within 14 days): the market settled under the chain rule; unless the vote met a cutoff UMA had accepted, yes-voters stay locked 13 days and forfeit half of the dissent fraction of their voted shares, at least a tenth.",
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const T = () => terminatorCodec();
const P = () => pairCodec();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A uint256 time from the contract: null for 0 and for sentinels past any real time (uint64/uint256 max). */
const timeOrNull = (v: bigint | number): number | null => {
  const b = BigInt(v);
  return b === 0n || b > MAX_SAFE ? null : Number(b);
};

function requireTime(field: string, v: number): number {
  if (!Number.isSafeInteger(v) || v <= 0) throw new InputError(field, "must be a unix time in whole seconds");
  return v;
}

const short = (h: Hex) => `${h.slice(0, 10)}…`;

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The terminator's public constants, read from the chain, plus the live bond. */
export interface TerminatorConstants {
  readonly categories: Readonly<Record<"oracleDecommission" | "assetCessation" | "structuralChange" | "pythVerifierMigration", number>>;
  readonly outcomes: Readonly<Record<OutcomeName, number>>;
  readonly verdicts: Readonly<Record<VerdictName, number>>;
  readonly settleRules: Readonly<Record<SettlementRuleKey, number>>;
  /** USDC units: the floor. */
  readonly terminationProposalBondUsdc: bigint;
  /** USDC units: what a proposal posts now, max(floor, UMA's minimum). */
  readonly requiredTerminationBondUsdc: bigint;
  readonly terminationProposalLiveness: number;
  readonly maxReasonLength: number;
  readonly settlementSampleCount: number;
  readonly settlementSampleSpacing: number;
}

/** The terminator's public constants (categories, outcomes, verdicts, settlement rules, bonds, liveness, reason length, sample count and spacing). */
export async function terminatorConstants(ctx: BazaarContext): Promise<TerminatorConstants> {
  const names = [
    "CATEGORY_ORACLE_DECOMMISSION",
    "CATEGORY_ASSET_CESSATION",
    "CATEGORY_STRUCTURAL_CHANGE",
    "CATEGORY_PYTH_VERIFIER_MIGRATION",
    "OUTCOME_NONE",
    "OUTCOME_TRUE",
    "OUTCOME_FALSE",
    "OUTCOME_UNJUDGED",
    "VERDICT_PENDING",
    "VERDICT_TRUE",
    "VERDICT_FALSE",
    "SETTLE_NOTHING",
    "SETTLE_TICK",
    "SETTLE_CHAIN",
    "SETTLE_AWAIT_VERDICT",
    "TERMINATION_PROPOSAL_BOND",
    "requiredTerminationBond",
    "TERMINATION_PROPOSAL_LIVENESS",
    "MAX_REASON_LENGTH",
    "SETTLEMENT_SAMPLE_COUNT",
    "SETTLEMENT_SAMPLE_SPACING",
  ];
  const v = (await readMany(ctx, names.map((fn) => ({ to: ctx.terminator, codec: T(), fn })))).map((x) => x as number | bigint);
  const n = (i: number) => Number(v[i]);
  return {
    categories: { oracleDecommission: n(0), assetCessation: n(1), structuralChange: n(2), pythVerifierMigration: n(3) },
    outcomes: { none: n(4), true: n(5), false: n(6), unjudged: n(7) },
    verdicts: { pending: n(8), true: n(9), false: n(10) },
    settleRules: { nothing: n(11), tick: n(12), chain: n(13), awaitVerdict: n(14) },
    terminationProposalBondUsdc: BigInt(v[15]!),
    requiredTerminationBondUsdc: BigInt(v[16]!),
    terminationProposalLiveness: n(17),
    maxReasonLength: n(18),
    settlementSampleCount: n(19),
    settlementSampleSpacing: n(20),
  };
}

/** The USDC bond (6 decimals) a UMA termination claim posts now: max(1,000 USDC, UMA's minimum). */
export async function requiredTerminationBond(ctx: BazaarContext): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.terminator, T(), "requiredTerminationBond");
}

/** settlementRule(pair), decoded. Times are unix seconds; null where the rule sets none. */
export interface SettlementRuleInfo {
  readonly rule: number;
  readonly key: SettlementRuleKey;
  readonly meaning: string;
  /** Under UMA's rule the cutoff, whose update settles the market; under the chain rule the first sample's target, also the cutoff. */
  readonly firstTarget: number | null;
  /** Under UMA's rule the cutoff again; under the chain rule the latest second a sample's update may be stamped with. Null when unbounded (a chain no UMA cutoff caps) or not applicable. */
  readonly latestPublishTs: number | null;
  /** After this instant a call with no updates settles at the stored price; null when not applicable or beyond any real time. */
  readonly lastResortTs: number | null;
  /** While waiting for a verdict: when the vote stops waiting and settles unjudged. */
  readonly verdictDeadline: number | null;
}

function toRule(raw: { rule: number; firstTarget: bigint; latestPublishTs: bigint; lastResortTs: bigint; verdictDeadline: bigint }): SettlementRuleInfo {
  const key = SETTLEMENT_RULE_KEYS[Number(raw.rule)] ?? "nothing";
  return {
    rule: Number(raw.rule),
    key,
    meaning: SETTLEMENT_RULE_TEXT[key],
    firstTarget: timeOrNull(raw.firstTarget),
    latestPublishTs: timeOrNull(raw.latestPublishTs),
    lastResortTs: timeOrNull(raw.lastResortTs),
    verdictDeadline: timeOrNull(raw.verdictDeadline),
  };
}

/**
 * How `terminateScheduledPair` would settle the market if called now, and what it needs. A verdict
 * the DVM has reached but nobody has recorded reads here as no verdict (see {@link SETTLEMENT_RULE_TEXT}).
 */
export async function settlementRule(ctx: BazaarContext, pair: Address): Promise<SettlementRuleInfo> {
  return toRule(await readOne(ctx, ctx.terminator, T(), "settlementRule", asAddress("pair", pair)));
}

/** A UMA termination claim, from `terminationProposals(assertionId)`. */
export interface TerminationProposalInfo {
  readonly assertionId: Hex;
  readonly pair: Address;
  readonly proposer: Address;
  /** The cutoff the claim proposed. */
  readonly lastTradingTs: number;
  readonly reason: string;
  readonly proposalTs: number;
  /** When UMA's liveness ends: undisputed, the claim can be settled (accepted) from then. */
  readonly livenessEndsAt: number;
  readonly resolved: boolean;
  readonly category: number;
  readonly categoryName: string;
}

/** A UMA termination claim by its assertion id, or null when the terminator has none. */
export async function terminationProposal(ctx: BazaarContext, assertionId: Hex): Promise<TerminationProposalInfo | null> {
  const id = asBytes32("assertionId", assertionId);
  return toTerminationProposal(id, await readOne(ctx, ctx.terminator, T(), "terminationProposals", id));
}

function toTerminationProposal(id: Hex, r: Record<string, unknown>): TerminationProposalInfo | null {
  if ((r.proposer as Address) === ZERO_ADDRESS) return null;
  const category = Number(r.category);
  const proposalTs = Number(r.proposalTs as bigint);
  return {
    assertionId: id,
    pair: getAddress(r.pair as Address),
    proposer: getAddress(r.proposer as Address),
    lastTradingTs: Number(r.lastTradingTs as bigint),
    reason: r.reason as string,
    proposalTs,
    livenessEndsAt: proposalTs + TERMINATION_PROPOSAL_LIVENESS,
    resolved: r.resolved as boolean,
    category,
    categoryName: TERMINATION_CATEGORY_INFO[category as TerminationCategory]?.name ?? `category ${category}`,
  };
}

/**
 * Where an insurer vote stands at the chain's time:
 * - `upcoming`: its window has not opened (a claim filed more than 14 days before its cutoff);
 * - `voting`: open for votes and, once at the threshold, for executeInsurerTermination;
 * - `expired`: the latch has closed without the vote scheduling the market; executing it now resolves it as failed;
 * - `scheduled`: it reached the threshold and set the market's cutoff;
 * - `rejected`: UMA rejected the claim behind it before it scheduled anything;
 * - `ended`: resolved otherwise (failed, preempted by an earlier cutoff, or voided by a drained fund); the events say which.
 */
export type InsurerProposalState = "upcoming" | "voting" | "expired" | "scheduled" | "rejected" | "ended";

/** An insurer-termination proposal, from `insurerProposals(id)`. Shares are 18 decimals. */
export interface InsurerProposalInfo {
  readonly id: Hex;
  readonly pair: Address;
  /** The bare proposer owed the bond, or the claim's UMA proposer. */
  readonly proposer: Address;
  readonly proposalTs: number;
  /** The pair's share generation at the snapshot. */
  readonly shareEpoch: bigint;
  readonly cutoffTs: number;
  readonly windowOpenTs: number;
  /** Votes and the latch close at this instant: the cutoff less one hour. */
  readonly votingClosesAt: number;
  readonly yesShares: bigint;
  /** The frozen denominator; 0 until the snapshot is taken (at the first touch once the window is open). */
  readonly snapshotTotalShares: bigint;
  readonly snapshotTaken: boolean;
  /** Yes-shares needed: 60% of the snapshot. 0 until the snapshot is taken. */
  readonly thresholdShares: bigint;
  readonly thresholdMet: boolean;
  /** True for the vote every UMA claim opens; its id is the claim's assertion id and UMA holds its bond. */
  readonly claimBacked: boolean;
  readonly resolved: boolean;
  readonly scheduled: boolean;
  /** Stamped at the fix: the yes-voters owe the post-fix lock and the levy. */
  readonly costed: boolean;
  readonly verdict: number;
  readonly verdictName: VerdictName;
  readonly outcome: number;
  readonly outcomeName: OutcomeName;
  readonly outcomeText: string;
  /** Stamped with the outcome: the share of each yes-voted share forfeited at redemption (basis points). */
  readonly levyBp: number;
  readonly state: InsurerProposalState;
}

function toInsurerProposal(id: Hex, r: Record<string, unknown>, now: number): InsurerProposalInfo | null {
  if (BigInt(r.proposalTs as bigint) === 0n) return null;
  const snapshot = r.snapshotTotalShares as bigint;
  const yes = r.yesShares as bigint;
  const taken = r.snapshotTaken as boolean;
  const threshold = (snapshot * INSURER_TERMINATION_THRESHOLD_BP) / BP_SCALE;
  const cutoffTs = Number(r.cutoffTs as bigint);
  const windowOpenTs = Number(r.windowOpenTs as bigint);
  const verdict = Number(r.verdict);
  const outcome = Number(r.outcome);
  const resolved = r.resolved as boolean;
  const scheduled = r.scheduled as boolean;
  let state: InsurerProposalState;
  if (!resolved) state = now < windowOpenTs ? "upcoming" : now + INSURER_TERMINATION_LATCH_LEAD > cutoffTs ? "expired" : "voting";
  else state = scheduled ? "scheduled" : verdict === 2 ? "rejected" : "ended";
  const outcomeName = OUTCOME_NAMES[outcome] ?? "none";
  return {
    id,
    pair: getAddress(r.pair as Address),
    proposer: getAddress(r.proposer as Address),
    proposalTs: Number(r.proposalTs as bigint),
    shareEpoch: BigInt(r.shareEpoch as bigint),
    cutoffTs,
    windowOpenTs,
    votingClosesAt: cutoffTs - INSURER_TERMINATION_LATCH_LEAD,
    yesShares: yes,
    snapshotTotalShares: snapshot,
    snapshotTaken: taken,
    thresholdShares: threshold,
    thresholdMet: taken && snapshot > 0n && yes >= threshold,
    claimBacked: r.claimBacked as boolean,
    resolved,
    scheduled,
    costed: r.costed as boolean,
    verdict,
    verdictName: VERDICT_NAMES[verdict] ?? "pending",
    outcome,
    outcomeName,
    outcomeText: OUTCOME_TEXT[outcomeName],
    levyBp: Number(r.levyBp),
    state,
  };
}

/** An insurer-termination proposal by id (a claim's assertion id, or a bare proposal's id), or null when none exists. */
export async function insurerProposal(ctx: BazaarContext, id: Hex): Promise<InsurerProposalInfo | null> {
  const pid = asBytes32("id", id);
  const [r, now] = await Promise.all([readOne<Record<string, unknown>>(ctx, ctx.terminator, T(), "insurerProposals", pid), chainNow(ctx)]);
  return toInsurerProposal(pid, r, now);
}

/** Shares `voter` has voted into proposal `id` on `pair` (0 when the record is dead or absent); after the fix, the voted stake the levy still draws on. */
export async function getInsurerVote(ctx: BazaarContext, args: { pair: Address; voter: Address; id: Hex }): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.terminator, T(), "getInsurerVote", asAddress("pair", args.pair), asAddress("voter", args.voter), asBytes32("id", args.id));
}

/** Shares `user` has voted into live proposals on `pair`: what the insurance withdrawal gate refuses to release. Shares voted into several proposals count once per proposal. */
export async function getLockedShares(ctx: BazaarContext, args: { pair: Address; user: Address }): Promise<bigint> {
  return readOne<bigint>(ctx, ctx.terminator, T(), "getLockedShares", asAddress("pair", args.pair), asAddress("user", args.user));
}

/** What a terminated market pays an account. Amounts are BAZAAR precision (1e18 = $1); ratios 1e18 = 100%. */
export interface TerminalEntitlement {
  /** The account's bucket collateral. */
  readonly collateral: bigint;
  /** Its registered profit claim (a winner settled before finalize). */
  readonly registeredClaim: bigint;
  /** Cash per unit of collateral; 0 before finalize. */
  readonly principalRatio: bigint;
  /** Cash per unit of registered claim; 0 before finalize. */
  readonly profitRatio: bigint;
  /** collateral × principalRatio + registeredClaim × profitRatio: what withdrawing everything pays now. */
  readonly payout: bigint;
  /** True once finalizeTermination has run, so the ratios are set and withdrawals are open. */
  readonly finalized: boolean;
}

/**
 * The lens's terminal entitlement for `account` on `pair`. Before finalize the ratios read 0, so the
 * payout does too ("not frozen yet", not "worthless"); a position still open is not included until
 * it is settled.
 */
export async function getTerminalEntitlement(ctx: BazaarContext, args: { pair: Address; account: Address }): Promise<TerminalEntitlement> {
  const pair = asAddress("pair", args.pair);
  const account = asAddress("account", args.account);
  const [e, terminated] = await readMany(ctx, [
    { to: ctx.lens, codec: lensCodec(), fn: "getTerminalEntitlement", args: [pair, account] },
    { to: pair, codec: P(), fn: "isPairTerminated" },
  ]);
  const x = e as { collateral: bigint; registeredClaim: bigint; principalRatio: bigint; profitRatio: bigint; payout: bigint };
  return { ...x, finalized: terminated as boolean };
}

/** Where a market is on its way to termination. */
export type TerminationPhase =
  /** No cutoff scheduled. */
  | "live"
  /** A cutoff is scheduled and trading continues until 6 s before it. */
  | "scheduled"
  /** Within 6 s of the cutoff, or past it, with no settlement price yet: nothing trades, deposits or withdraws until terminateScheduledPair fixes the price. */
  | "limbo"
  /** The settlement price is fixed: positions settle at it (liquidate) until finalizeTermination. */
  | "settling"
  /** Finalized: withdrawals pay at the frozen ratios. */
  | "terminated";

/** Proposals still open on a market, and where their ids came from. */
export interface OpenProposals {
  readonly termination: readonly TerminationProposalInfo[];
  readonly insurer: readonly InsurerProposalInfo[];
  /** How the ids were found: Bazaar's subgraph, the terminator's logs, the ids given, or nowhere (then both lists are empty). */
  readonly source: "subgraph" | "logs" | "ids" | "none";
}

/** A market's termination state in one call. Times are unix seconds, null where unset. */
export interface TerminationStatus {
  readonly pair: Address;
  /** The chain time this was judged at. */
  readonly now: number;
  readonly phase: TerminationPhase;
  readonly scheduledTerminationTs: number | null;
  /** When trading halts: the cutoff less 6 s (LIMBO_LEAD). */
  readonly haltsAt: number | null;
  readonly cutoffPassed: boolean;
  readonly settlementPriceFixedTs: number | null;
  /** The fixed settlement price (BAZAAR precision), null until fixed. */
  readonly settlementPrice: bigint | null;
  readonly isPairTerminated: boolean;
  readonly settlementRule: SettlementRuleInfo;
  /** The accepted UMA claim whose cutoff is in force, null until one is accepted. */
  readonly acceptedTerminationAssertionId: Hex | null;
  /** While an insurer vote holds the schedule: the UMA cutoff that caps its chain's prints, null when none. */
  readonly umaCutoffCap: number | null;
  /** True while the market's cutoff is one an insurer vote set. */
  readonly insurerScheduled: boolean;
  /** The proposal whose vote holds the cutoff, null when none does. */
  readonly insurerScheduleId: Hex | null;
  /** Open interest (BAZAAR precision): finalize waits for both to reach zero, or for the 14-day escape hatch. */
  readonly openInterest: { readonly long: bigint; readonly short: bigint };
  /** When finalizeTermination can be called: now once every position is settled, else 14 days after the fix; null before the fix or after finalize. */
  readonly finalizeOpensAt: number | null;
  readonly openProposals: OpenProposals;
}

/** Where to look for a market's open proposals. */
export interface ProposalSearch {
  /** Proposal ids the UI already knows (assertion ids and bare insurer ids). */
  readonly ids?: readonly Hex[];
  /** Scan the terminator's logs from this block (one eth_getLogs to `toBlock`); used when the context has no subgraph. */
  readonly fromBlock?: number;
  readonly toBlock?: number;
}

/** The most open proposals of each kind (UMA claims, insurer votes) {@link openProposals} takes from the subgraph for one market. */
export const MAX_OPEN_PROPOSALS = 1_000;
const PROPOSAL_PAGE = 100;
const BYTES32_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * The ids of `pair`'s open proposals from Bazaar's subgraph, paged by id (ascending). Every id must
 * be 32 bytes of hex and strictly greater than the one before (so paging always advances), a page
 * may hold no more rows than asked, and each kind is capped at {@link MAX_OPEN_PROPOSALS}: an
 * answer that breaks any of these is refused rather than half-used.
 */
async function subgraphProposalIds(sg: SubgraphSource, pair: Address): Promise<Hex[]> {
  const kinds = [
    { key: "terminationProposals", what: "UMA termination claims", filter: "status_in: [Pending, Disputed]" },
    { key: "insurerProposals", what: "insurer votes", filter: "status: Open" },
  ] as const;
  const last = new Map<string, Hex | null>(kinds.map((k) => [k.key, null]));
  const counts = new Map<string, number>(kinds.map((k) => [k.key, 0]));
  const ids: Hex[] = [];
  let paging = [...kinds];
  const refuse = (why: string) =>
    new SubgraphError(`Bazaar's subgraph answered the open-proposal query with ${why}, so its answer was not used: pass the proposal ids you know (ids) or scan the terminator's logs (fromBlock) instead.`);
  while (paging.length) {
    const parts = paging.map((k) => {
      const after = last.get(k.key);
      // `after` is an id this function checked against BYTES32_ID: safe to place in the query.
      return `${k.key}(first: ${PROPOSAL_PAGE}, orderBy: id, orderDirection: asc, where: { pair: $pair, ${k.filter}${after ? `, id_gt: "${after}"` : ""} }) { id }`;
    });
    const res = await sg.query<Record<string, unknown> | null>(`query OpenProposals($pair: String!) {\n  ${parts.join("\n  ")}\n}`, { pair: pair.toLowerCase() });
    if (res === null || typeof res !== "object") throw refuse("no data");
    const next: (typeof kinds)[number][] = [];
    for (const k of paging) {
      const rows = res[k.key] ?? [];
      if (!Array.isArray(rows)) throw refuse(`no list of ${k.what}`);
      if (rows.length > PROPOSAL_PAGE) throw refuse(`more ${k.what} in one page than asked for`);
      for (const r of rows) {
        const id = (r as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || !BYTES32_ID.test(id)) throw refuse("a proposal id that is not 32 bytes of hex");
        const lc = id.toLowerCase() as Hex;
        const prev = last.get(k.key);
        if (prev && lc <= prev) throw refuse(`${k.what} out of id order (its paging did not advance)`);
        last.set(k.key, lc);
        ids.push(lc);
      }
      const n = counts.get(k.key)! + rows.length;
      counts.set(k.key, n);
      if (n > MAX_OPEN_PROPOSALS) throw refuse(`more than ${MAX_OPEN_PROPOSALS} open ${k.what} for one market`);
      if (rows.length === PROPOSAL_PAGE) next.push(k);
    }
    paging = next;
  }
  return ids;
}

/**
 * The open proposals on `pair`: UMA claims not yet resolved and insurer votes not yet resolved.
 * The terminator keeps no list, so ids come from Bazaar's subgraph when the context has one (every
 * page, each id checked; at most {@link MAX_OPEN_PROPOSALS} of each kind), else from the
 * terminator's logs when `fromBlock` is given, plus any `ids` passed; each is then read on chain, so
 * the answer reflects the chain, not the index.
 */
export async function openProposals(ctx: BazaarContext, pair: Address, search: ProposalSearch = {}): Promise<OpenProposals> {
  const p = asAddress("pair", pair);
  const ids = new Set<Hex>((search.ids ?? []).map((x) => asBytes32("ids", x)));
  let source: OpenProposals["source"] = ids.size ? "ids" : "none";
  if (ctx.subgraph) {
    for (const id of await subgraphProposalIds(ctx.subgraph, p)) ids.add(id);
    source = "subgraph";
  } else if (search.fromBlock !== undefined) {
    const to = search.toBlock ?? (await ctx.chain.blockNumber());
    for (const lg of await ctx.chain.logs(search.fromBlock, to, [ctx.terminator])) {
      const d = T().decodeLog<{ pair?: Address; assertionId?: Hex; id?: Hex }>(lg);
      if (!d || !d.args.pair || getAddress(d.args.pair) !== p) continue;
      if (d.name === "TerminationProposalSubmitted" && d.args.assertionId) ids.add(d.args.assertionId);
      if (d.name === "InsurerTerminationProposed" && d.args.id) ids.add(d.args.id);
    }
    source = "logs";
  }
  if (!ids.size) return { termination: [], insurer: [], source };
  const list = [...ids];
  const now = await chainNow(ctx);
  const res = await readMany(ctx, [
    ...list.map((id) => ({ to: ctx.terminator, codec: T(), fn: "terminationProposals", args: [id] })),
    ...list.map((id) => ({ to: ctx.terminator, codec: T(), fn: "insurerProposals", args: [id] })),
  ]);
  const termination: TerminationProposalInfo[] = [];
  const insurer: InsurerProposalInfo[] = [];
  list.forEach((id, i) => {
    const tp = toTerminationProposal(id, res[i] as Record<string, unknown>);
    if (tp && tp.pair === p && !tp.resolved) termination.push(tp);
    const ip = toInsurerProposal(id, res[list.length + i] as Record<string, unknown>, now);
    if (ip && ip.pair === p && !ip.resolved) insurer.push(ip);
  });
  termination.sort((a, b) => a.proposalTs - b.proposalTs);
  insurer.sort((a, b) => a.cutoffTs - b.cutoffTs);
  return { termination, insurer, source };
}

/**
 * A market's termination status in one call: its cutoff and phase, whether and when its settlement
 * price was fixed, the settlement rule that applies and what it means, the accepted UMA claim, the
 * UMA cap on an insurer schedule, open interest and when finalize opens, and the open proposals
 * (see {@link openProposals} for where their ids come from).
 */
export async function terminationStatus(ctx: BazaarContext, pair: Address, search: ProposalSearch = {}): Promise<TerminationStatus> {
  const p = asAddress("pair", pair);
  const [reads, now, open] = await Promise.all([
    readMany(ctx, [
      { to: p, codec: P(), fn: "scheduledTerminationTs" },
      { to: p, codec: P(), fn: "settlementPriceFixedTs" },
      { to: p, codec: P(), fn: "isPairTerminated" },
      { to: p, codec: P(), fn: "auxState" },
      { to: p, codec: P(), fn: "pairVault" },
      { to: ctx.terminator, codec: T(), fn: "settlementRule", args: [p] },
      { to: ctx.terminator, codec: T(), fn: "acceptedTerminationAssertionId", args: [p] },
      { to: ctx.terminator, codec: T(), fn: "umaCutoffCap", args: [p] },
      { to: ctx.terminator, codec: T(), fn: "insurerScheduleId", args: [p] },
    ]),
    chainNow(ctx),
    openProposals(ctx, p, search),
  ]);
  const scheduled = timeOrNull(reads[0] as bigint);
  const fixedTs = timeOrNull(reads[1] as bigint);
  const terminated = reads[2] as boolean;
  const aux = reads[3] as { settlementPrice: bigint };
  const vault = reads[4] as { totalLongOI: bigint; totalShortOI: bigint };
  const accepted = reads[6] as Hex;
  const scheduleId = reads[8] as Hex;
  let phase: TerminationPhase = "live";
  if (terminated) phase = "terminated";
  else if (fixedTs) phase = "settling";
  else if (scheduled && now + LIMBO_LEAD >= scheduled) phase = "limbo";
  else if (scheduled) phase = "scheduled";
  const swept = vault.totalLongOI === 0n && vault.totalShortOI === 0n;
  return {
    pair: p,
    now,
    phase,
    scheduledTerminationTs: scheduled,
    haltsAt: scheduled ? scheduled - LIMBO_LEAD : null,
    cutoffPassed: scheduled !== null && now > scheduled,
    settlementPriceFixedTs: fixedTs,
    settlementPrice: fixedTs ? aux.settlementPrice : null,
    isPairTerminated: terminated,
    settlementRule: toRule(reads[5] as never),
    acceptedTerminationAssertionId: isZero32(accepted) ? null : accepted,
    umaCutoffCap: timeOrNull(reads[7] as bigint),
    insurerScheduled: !isZero32(scheduleId),
    insurerScheduleId: isZero32(scheduleId) ? null : scheduleId,
    openInterest: { long: vault.totalLongOI, short: vault.totalShortOI },
    finalizeOpensAt: !fixedTs || terminated ? null : swept ? now : fixedTs + TERMINAL_SETTLEMENT_ESCAPE,
    openProposals: open,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

const REASON_EXTRA = new Set([..." .,&/-:?=#%_~+"]);

/**
 * Why a termination `reason` would be refused, or null when the terminator accepts it: 1 to 1,000
 * bytes of letters, digits, space and `. , & / - : ? = # % _ ~ +`. Everything else, including every
 * non-ASCII character and square brackets, is refused: the reason is spliced into the claim UMA's
 * voters read between fences the charset makes unforgeable.
 */
export function reasonProblem(reason: string): string | null {
  if (typeof reason !== "string" || reason.length === 0) return "Give the grounds and evidence for ending the market.";
  for (const ch of reason) {
    const ok = /[A-Za-z0-9]/.test(ch) || REASON_EXTRA.has(ch);
    if (!ok) {
      return `The character ${JSON.stringify(ch)} is not allowed: use letters, digits, spaces and . , & / - : ? = # % _ ~ + only (no square brackets or accents).`;
    }
  }
  if (reason.length > MAX_REASON_LENGTH) return `Keep it to ${MAX_REASON_LENGTH} characters; this is ${reason.length}.`;
  return null;
}

/** The maturity cutoff for a vote whose window opened at `windowOpenTs`: shares deposited at or before it vote. */
export const maturityCutoff = (windowOpenTs: number) => (windowOpenTs > INSURER_SHARE_MATURITY_PERIOD ? windowOpenTs - INSURER_SHARE_MATURITY_PERIOD : 0);

/** When a claim's vote window opens: 14 days before its cutoff, or at filing (`now`) when that is later. */
export const voteWindowOpens = (cutoffTs: number, now: number) =>
  cutoffTs > INSURER_TERMINATION_MAX_LEAD && cutoffTs - INSURER_TERMINATION_MAX_LEAD > now ? cutoffTs - INSURER_TERMINATION_MAX_LEAD : now;

/** The levy (basis points) an unjudged outcome charges with `yes` of `snapshot` voted: 50% × dissent, at least 10%. */
export function unjudgedLevyBp(snapshot: bigint, yes: bigint): bigint {
  const dissent = snapshot > yes ? snapshot - yes : 0n;
  const bp = snapshot === 0n ? 0n : (INSURER_LEVY_BP * dissent) / snapshot;
  return bp < INSURER_LEVY_FLOOR_BP ? INSURER_LEVY_FLOOR_BP : bp;
}

/** The UMA cutoff in force on a pair (BazaarPairTerminator._umaCutoffInForce), null when no claim has been accepted. */
function umaCutoffInForce(accepted: Hex, insurerScheduled: boolean, cap: bigint, scheduledTs: bigint): bigint | null {
  if (isZero32(accepted)) return null;
  return insurerScheduled ? cap : scheduledTs;
}

/** How long a transaction built now may take to land: minimum leads are checked this far ahead. */
const DEFAULT_SLACK = 60;

// ---------------------------------------------------------------------------------------------
// UMA-claim termination
// ---------------------------------------------------------------------------------------------

/**
 * Propose ending a market through UMA. The terminator pulls the bond (`requiredTerminationBond()`,
 * at least 1,000 USDC) from the caller with `transferFrom` and posts it to UMA's oracle as the
 * assertion bond, with the caller as asserter: UMA returns it to the caller when the claim resolves
 * true, and pays it to the disputer if UMA's voters reject it. The USDC approval for the terminator
 * is returned in `approvals` whenever the allowance is short.
 *
 * The claim names the market by its pair id and feed ids, declares `category`, proposes
 * `lastTradingTs` as the cutoff, and splices `reason` (the grounds and evidence) last, between
 * fences. Filing also opens an insurer vote on the same cutoff, under the claim's assertion id.
 *
 * Timing: the cutoff must be at least 2 hours out. Acceptance alone enforces it as proposed only
 * when it is at least 12 hours (UMA's liveness) out; a nearer cutoff is met as proposed only if the
 * insurers vote it through, and otherwise the claim is accepted after it and the cutoff moves to 7 s
 * after acceptance. Once a UMA cutoff is in force, a claim must name an earlier one.
 *
 * Refused up front: an unregistered or already-ended market, a category outside 1-4, a cutoff too
 * soon or not earlier than the UMA cutoff in force, an invalid reason, and UMA's identifier being
 * off its live whitelist (proposals fail closed until the identifier upgrade). A bond quote below
 * the terminator's 1,000 USDC floor can only be a wrong node answer: it throws BondQuoteError. An
 * allowance already above the bond is flagged in `notes` (it does not bound what is pulled).
 *
 * @param args.lastTradingTs The proposed cutoff (unix seconds). An event that has already happened is proposed at the earliest cutoff accepted.
 * @param args.slackSeconds How long the transaction may take to land: the 2-hour minimum is checked this much ahead (default 60).
 */
export async function proposeTermination(
  ctx: BazaarContext,
  args: { pair: Address; category: number; lastTradingTs: number; reason: string; from: Address; slackSeconds?: number },
): Promise<CostedCall> {
  const pair = asAddress("pair", args.pair);
  const from = asAddress("from", args.from);
  const category = args.category;
  if (!Number.isInteger(category) || category < 1 || category > 4) {
    throw new InputError("category", "Choose one of the four grounds: oracle decommission, asset cessation, structural change or Pyth verifier migration.");
  }
  const lastTradingTs = requireTime("lastTradingTs", args.lastTradingTs);
  const why = reasonProblem(args.reason);
  if (why) throw new InputError("reason", why);
  const slack = args.slackSeconds ?? DEFAULT_SLACK;

  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.terminator, codec: T(), fn: "isPair", args: [pair] },
      { to: pair, codec: P(), fn: "isPairTerminated" },
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: pair, codec: P(), fn: "scheduledTerminationTs" },
      { to: ctx.terminator, codec: T(), fn: "acceptedTerminationAssertionId", args: [pair] },
      { to: ctx.terminator, codec: T(), fn: "insurerScheduleId", args: [pair] },
      { to: ctx.terminator, codec: T(), fn: "umaCutoffCap", args: [pair] },
      { to: ctx.factory, codec: factoryCodec(), fn: "umaIdentifierIsLive" },
      { to: ctx.terminator, codec: T(), fn: "requiredTerminationBond" },
    ]),
    chainNow(ctx),
  ]);
  if (!(r[0] as boolean)) throw new InputError("pair", "This market is not registered with Bazaar's terminator.");
  if (r[1] as boolean) throw new InputError("pair", "This market has already ended.");
  if ((r[2] as bigint) !== 0n) throw new InputError("pair", "This market's settlement price is already fixed.");
  const inForce = umaCutoffInForce(r[4] as Hex, !isZero32(r[5] as Hex), r[6] as bigint, r[3] as bigint);
  if (inForce !== null && BigInt(lastTradingTs) >= inForce) {
    throw new InputError(
      "lastTradingTs",
      `UMA has already accepted a cutoff for this market at ${timeText(inForce)}: a new claim must name an earlier one.`,
    );
  }
  const minTs = now + slack + INSURER_TERMINATION_MIN_LEAD;
  if (lastTradingTs < minTs) {
    throw new InputError("lastTradingTs", `The cutoff must be at least ${durationText(INSURER_TERMINATION_MIN_LEAD)} away: ${timeText(minTs)} or later.`);
  }
  if (!(r[7] as boolean)) {
    throw new InputError("pair", "UMA's identifier is off its live whitelist, so new termination claims are closed until Bazaar's identifier upgrade completes. The insurer vote and stale-oracle paths still work.");
  }
  const bond = r[8] as bigint;
  requireBondFloor("a termination bond", bond, TERMINATION_PROPOSAL_BOND_USDC);
  const info = TERMINATION_CATEGORY_INFO[category as TerminationCategory];
  const { approvals, requires, warnings } = await bondApprovals(ctx, from, [
    { token: ctx.usdc, spender: ctx.terminator, spenderName: "the Bazaar terminator", amount: bond, purpose: "the termination bond" },
  ]);
  const notes: string[] = [
    `The claim is open for dispute for ${durationText(TERMINATION_PROPOSAL_LIVENESS)}. Undisputed, anyone can settle it afterwards and the market is scheduled to stop trading at the cutoff (6 seconds before it).`,
    `Filing also opens an insurer vote on the same cutoff; its window opens at ${timeText(voteWindowOpens(lastTradingTs, now))}.`,
    "If UMA's acceptance schedules the market, the proposer earns 0.1% of its insurance fund (at most $100), claimable on the market.",
  ];
  if (lastTradingTs < now + TERMINATION_PROPOSAL_LIVENESS) {
    notes.push(
      `This cutoff is less than ${durationText(TERMINATION_PROPOSAL_LIVENESS)} away, so UMA cannot accept the claim before it: it is met as proposed only if insurers vote it through by ${timeText(lastTradingTs - INSURER_TERMINATION_LATCH_LEAD)}; otherwise the cutoff moves to ${MIN_CUTOFF_LEAD} seconds after acceptance.`,
    );
  }
  if (inForce === null && r[3] !== 0n) {
    notes.push(`An insurer vote has already scheduled this market for ${timeText(r[3] as bigint)}; an accepted claim either pulls that earlier or caps its settlement prints.`);
  }
  notes.push(...warnings);
  const costs: Cost[] = [
    {
      kind: "bond",
      label: "UMA termination bond",
      amount: bond,
      unit: "USDC",
      token: ctx.usdc,
      payee: ctx.terminator,
      returned: "Returned to you by UMA when the claim is accepted; paid to the disputer if UMA's voters reject it.",
      contingent: false,
    },
  ];
  return {
    action: "proposeTermination",
    to: ctx.terminator,
    data: T().encode("proposeTermination", pair, category, BigInt(lastTradingTs), args.reason),
    value: 0n,
    from,
    summary: `Propose ending this market (${info.name}) at ${timeText(lastTradingTs)}: posts a ${usdcText(bond)} UMA bond, returned if UMA accepts, lost to a disputer if it rejects`,
    pullsUsdc: bond * USDC_TO_BAZAAR,
    costs,
    approvals,
    requires,
    notes,
  };
}

/**
 * Settle a UMA termination claim once UMA can resolve it: the terminator settles the assertion on
 * the oracle it was made on, UMA pays the bond to the winning side, and the terminator applies the
 * verdict: an accepted claim schedules the market (or pulls its cutoff earlier, or caps an insurer
 * schedule's prints), a rejected one leaves it alone and ends the claim's vote. Costs only gas.
 *
 * Refused up front: an unknown or resolved claim, and one still inside UMA's liveness. A disputed
 * claim settles only after UMA's voters have ruled; until then the call reverts.
 */
export async function settleTerminationProposal(ctx: BazaarContext, args: { assertionId: Hex; from?: Address }): Promise<CostedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const tp = await terminationProposal(ctx, id);
  if (!tp) throw new InputError("assertionId", "The terminator has no termination claim with this id.");
  if (tp.resolved) throw new InputError("assertionId", "This claim is already resolved.");
  const oo = await assertionOracle(ctx, id, "terminator");
  const [a, now] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx)]);
  const st = statusOf(a, now);
  requireSettleable(st, "assertionId");
  const notes =
    st.phase === "disputed"
      ? ["The claim was disputed: this succeeds only once UMA's voters have ruled."]
      : ["Undisputed past its liveness: UMA accepts the claim, returns the bond to the proposer, and the terminator schedules the market."];
  return {
    action: "settleTerminationProposal",
    to: ctx.terminator,
    data: T().encode("settleTerminationProposal", id),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Settle termination claim ${short(id)} on UMA and apply the verdict (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Insurer-vote termination
// ---------------------------------------------------------------------------------------------

/** keccak256(abi.encode(pair, proposer, timestamp)): a bare insurer proposal's id, fixed by the second it is filed. */
export function insurerProposalId(pair: Address, proposer: Address, timestamp: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint64" }], [pair, proposer, BigInt(timestamp)]));
}

/**
 * Propose that a market stop trading at `cutoffTs` with no UMA claim behind it (a bare insurer
 * proposal). The terminator pulls a fixed 1,000 USDC bond from the caller with `transferFrom`
 * (approval returned in `approvals` when short) and holds it until the vote resolves: refunded if the
 * vote schedules the market, is preempted by an earlier cutoff, is voided by a drained fund, or fails
 * having reached the threshold; forfeited to the market's insurance fund if it fails short of it.
 *
 * The proposal does not vote the proposer's shares: vote separately with
 * {@link voteForInsurerTermination}. A bare vote settles unjudged under the chain rule, so its
 * yes-voters stay locked 13 days after the fix and forfeit half the dissent fraction of their voted
 * shares (at least a tenth) unless it meets a cutoff UMA accepted. A claim UMA can judge is filed
 * with {@link proposeTermination}, which opens its vote itself.
 *
 * Refused up front: an unregistered or fixed market, a cutoff less than 2 hours or more than 14 days
 * away, one at or after a cutoff the market already carries, and a proposer with no shares matured
 * 4 days (the maturity rule the vote applies).
 *
 * @param args.cutoffTs The trading cutoff (unix seconds). The vote must pass and be executed at least 1 hour before it.
 * @param args.slackSeconds How long the transaction may take to land: the 2-hour minimum is checked this far ahead (default 60).
 */
export async function proposeInsurerTermination(
  ctx: BazaarContext,
  args: { pair: Address; cutoffTs: number; from: Address; slackSeconds?: number },
): Promise<CostedCall> {
  const pair = asAddress("pair", args.pair);
  const from = asAddress("from", args.from);
  const cutoffTs = requireTime("cutoffTs", args.cutoffTs);
  const slack = args.slackSeconds ?? DEFAULT_SLACK;
  const now = await chainNow(ctx);
  const r = await readMany(ctx, [
    { to: ctx.terminator, codec: T(), fn: "isPair", args: [pair] },
    { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
    { to: pair, codec: P(), fn: "scheduledTerminationTs" },
    { to: pair, codec: P(), fn: "getSharesAsOf", args: [from, BigInt(maturityCutoff(now))] },
  ]);
  if (!(r[0] as boolean)) throw new InputError("pair", "This market is not registered with Bazaar's terminator.");
  if ((r[1] as bigint) !== 0n) throw new InputError("pair", "This market's settlement price is already fixed.");
  const minTs = now + slack + INSURER_TERMINATION_MIN_LEAD;
  const maxTs = now + INSURER_TERMINATION_MAX_LEAD;
  if (cutoffTs < minTs) throw new InputError("cutoffTs", `The cutoff must be at least ${durationText(INSURER_TERMINATION_MIN_LEAD)} away: ${timeText(minTs)} or later.`);
  if (cutoffTs > maxTs) throw new InputError("cutoffTs", `The cutoff can be at most ${durationText(INSURER_TERMINATION_MAX_LEAD)} away: ${timeText(maxTs)} or earlier.`);
  const existing = Number(r[2] as bigint);
  if (existing !== 0 && existing <= cutoffTs) {
    throw new InputError("cutoffTs", `The market is already scheduled to stop at ${timeText(existing)}: propose an earlier cutoff.`);
  }
  if ((r[3] as bigint) === 0n) {
    throw new InputError("from", `Only insurers whose shares are at least ${durationText(INSURER_SHARE_MATURITY_PERIOD)} old can propose; this wallet has none that old.`);
  }
  const bond = INSURER_TERMINATION_BOND_USDC;
  const { approvals, requires, warnings } = await bondApprovals(ctx, from, [
    { token: ctx.usdc, spender: ctx.terminator, spenderName: "the Bazaar terminator", amount: bond, purpose: "the insurer-vote bond" },
  ]);
  return {
    action: "proposeInsurerTermination",
    to: ctx.terminator,
    data: T().encode("proposeInsurerTermination", pair, BigInt(cutoffTs)),
    value: 0n,
    from,
    summary: `Propose an insurer vote to end this market at ${timeText(cutoffTs)}: posts a ${usdcText(bond)} bond, lost to the insurance fund if the vote fails short of 60%`,
    pullsUsdc: bond * USDC_TO_BAZAAR,
    costs: [
      {
        kind: "bond",
        label: "Insurer-vote bond",
        amount: bond,
        unit: "USDC",
        token: ctx.usdc,
        payee: ctx.terminator,
        returned:
          "Refunded when the vote schedules the market, is preempted or voided, or fails after reaching 60%; forfeited to the market's insurance fund if it fails short of 60%.",
        contingent: false,
      },
    ],
    approvals,
    requires,
    notes: [
      `Voting opens now and closes at ${timeText(cutoffTs - INSURER_TERMINATION_LATCH_LEAD)}: yes-votes must reach 60% of the share snapshot, and someone must execute the vote, by then.`,
      "Proposing does not vote your shares: vote separately.",
      "A bare vote settles under the chain rule; its yes-voters stay locked 13 days after the fix and forfeit 10-20% of the shares they voted (half the share of the snapshot that did not vote yes, at least a tenth).",
      "The proposal's id is fixed by the second it lands: read it from the InsurerTerminationProposed event in the receipt (proposalIdsFromReceipt).",
      ...warnings,
    ],
  };
}

/**
 * Vote yes on insurer proposal `id` by locking `shares` of your insurance shares. Votes are never
 * withdrawn; the same shares may back several proposals (up to 8 live ones per pair).
 *
 * The locked shares cannot be withdrawn from the insurance fund until the proposal's cutoff or the
 * market's, whichever is first (a failed proposal releases them sooner only while the market has no
 * cutoff). If this proposal ends the market, its outcome decides what the yes-voters owe: nothing
 * when UMA upheld the claim behind it; otherwise a 13-day lock after the price fix and a levy
 * forfeited at redemption to the bug bounty address: half of every voted share when UMA rejected the
 * claim, half the dissent fraction (at least a tenth) when no verdict came or the vote was bare,
 * unless the vote met a cutoff UMA had accepted within 14 days of its own. The worst case is
 * returned as a contingent `levy` cost.
 *
 * Eligible shares are those held now that were deposited at least 4 days before the vote window
 * opened. Refused up front: an unknown or resolved proposal, a window not yet open or already closed
 * (one hour before the cutoff), a fixed market, a proposal from a wiped share generation, and more
 * shares than the wallet can still vote on it.
 *
 * @param args.shares Insurance shares to vote (18 decimals).
 */
export async function voteForInsurerTermination(
  ctx: BazaarContext,
  args: { pair: Address; id: Hex; shares: bigint; from: Address },
): Promise<CostedCall> {
  const pair = asAddress("pair", args.pair);
  const id = asBytes32("id", args.id);
  const from = asAddress("from", args.from);
  if (typeof args.shares !== "bigint" || args.shares <= 0n) throw new InputError("shares", "Vote at least some shares.");
  const shares = args.shares;
  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.terminator, codec: T(), fn: "insurerProposals", args: [id] },
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: pair, codec: P(), fn: "extsload", args: [("0x" + PAIR_SLOT_SHARE_EPOCH.toString(16).padStart(64, "0")) as Hex] },
      { to: ctx.terminator, codec: T(), fn: "getInsurerVote", args: [pair, from, id] },
      { to: pair, codec: P(), fn: "totalInsuranceShares" },
      { to: pair, codec: P(), fn: "insuranceShares", args: [ZERO_ADDRESS] },
      { to: ctx.terminator, codec: T(), fn: "umaCutoffCap", args: [pair] },
    ]),
    chainNow(ctx),
  ]);
  const prop = toInsurerProposal(id, r[0] as Record<string, unknown>, now);
  if (!prop || prop.pair !== pair || prop.resolved) throw new InputError("id", "There is no open vote with this id on this market.");
  if (now < prop.windowOpenTs) throw new InputError("id", `Voting on this proposal opens at ${timeText(prop.windowOpenTs)}.`);
  if (now + INSURER_TERMINATION_LATCH_LEAD > prop.cutoffTs) throw new InputError("id", `Voting closed at ${timeText(prop.votingClosesAt)}, one hour before the cutoff.`);
  if ((r[1] as bigint) !== 0n) throw new InputError("pair", "This market's settlement price is already fixed: the vote is over.");
  const epoch = BigInt(r[2] as Hex);
  if (prop.snapshotTaken && prop.shareEpoch !== epoch) {
    throw new InputError("id", "The insurance fund was drained and recapitalized since this vote's snapshot: the vote is void.");
  }
  const voted = r[3] as bigint;
  const eligible = await readOne<bigint>(ctx, pair, P(), "getSharesAsOf", from, BigInt(maturityCutoff(prop.windowOpenTs)));
  const unlocked = eligible > voted ? eligible - voted : 0n;
  if (shares > unlocked) {
    throw new InputError(
      "shares",
      unlocked === 0n
        ? `This wallet has no more shares that can vote on this proposal: only shares deposited by ${timeText(maturityCutoff(prop.windowOpenTs))} count.`
        : `This wallet can vote at most ${sharesText(unlocked)} more on this proposal (shares deposited by ${timeText(maturityCutoff(prop.windowOpenTs))}).`,
    );
  }
  const snapshot = prop.snapshotTaken ? prop.snapshotTotalShares : (r[4] as bigint) - (r[5] as bigint);
  const required = (snapshot * INSURER_TERMINATION_THRESHOLD_BP) / BP_SCALE;
  const yesAfter = prop.yesShares + shares;
  const cap = BigInt(r[6] as bigint);
  const exempt = cap !== 0n && cap >= BigInt(prop.cutoffTs) && cap - BigInt(prop.cutoffTs) <= BigInt(INSURER_TERMINATION_MAX_LEAD);
  // Unjudged: the levy is read when the vote schedules the market, from the yes count then, which is at least the threshold.
  const unjudgedWorst = exempt ? 0n : unjudgedLevyBp(snapshot, yesAfter > required ? yesAfter : required);
  const worstBp = prop.claimBacked ? INSURER_LEVY_BP : unjudgedWorst;
  const levy = (shares * worstBp) / BP_SCALE;
  const pct = (bp: bigint) => `${Number(bp) / 100}%`;
  const levyText = prop.claimBacked
    ? `If this vote ends the market: nothing if UMA upholds the claim; ${pct(INSURER_LEVY_BP)} of the voted shares if UMA rejects it; ${exempt ? "nothing" : `${pct(unjudgedWorst)} or less`} if UMA never rules.`
    : exempt
      ? "This vote meets a cutoff UMA accepted, so an unjudged outcome costs nothing."
      : `If this vote ends the market: ${pct(unjudgedWorst)} or less of the voted shares (half the share of the snapshot that did not vote yes, at least ${pct(INSURER_LEVY_FLOOR_BP)}).`;
  const costs: Cost[] = [
    {
      kind: "lock",
      label: "Shares locked by the vote",
      amount: shares,
      unit: "shares",
      token: null,
      payee: null,
      returned: `Locked against insurance withdrawal until ${timeText(prop.cutoffTs)} or the market's own cutoff if sooner; if this vote ends the market and its outcome is costed, until ${durationText(INSURER_POST_FIX_LOCK)} after the settlement price is fixed.`,
      contingent: false,
    },
  ];
  if (worstBp > 0n) {
    costs.push({
      kind: "levy",
      label: "Levy on voted shares (worst case)",
      amount: levy,
      unit: "shares",
      token: null,
      payee: null,
      returned: `Never: forfeited at redemption to Bazaar's bug bounty address. ${levyText}`,
      contingent: true,
    });
  }
  const summary =
    worstBp > 0n
      ? `Vote ${sharesText(shares)} to end this market at ${timeText(prop.cutoffTs)}: locks them, and up to ${sharesText(levy)} may be forfeited if this vote ends the market`
      : `Vote ${sharesText(shares)} to end this market at ${timeText(prop.cutoffTs)}: locks them until the cutoff`;
  const notes = [
    levyText,
    `The vote needs ${sharesText(required)} (60% of ${sharesText(snapshot)}); with yours it has ${sharesText(yesAfter)}.`,
    `It takes effect only when someone executes it (executeInsurerTermination) before ${timeText(prop.votingClosesAt)}.`,
  ];
  if (yesAfter >= required && snapshot > 0n) notes.push("With this vote the threshold is met: the vote can be executed right after it lands.");
  return {
    action: "voteForInsurerTermination",
    to: ctx.terminator,
    data: T().encode("voteForInsurerTermination", pair, id, shares),
    value: 0n,
    from,
    summary,
    costs,
    approvals: [],
    requires: [`At most ${INSURER_MAX_LIVE_VOTES} live votes per wallet on a market.`],
    notes,
  };
}

/** What executing an insurer vote would do now. */
export type InsurerExecutionOutcome = "schedule" | "preempted" | "voided" | "failedRefund" | "failedForfeit";

/**
 * Resolve insurer proposal `id` (anyone may):
 * - threshold met before the latch closes: the market is scheduled to stop at the cutoff (or its
 *   schedule pulled earlier), and a bare bond refunded;
 * - the latch closed without scheduling: failed; a bare bond refunded if it reached 60%, else
 *   forfeited to the insurance fund;
 * - the market's price already fixed, or a cutoff at or before this one already scheduled:
 *   preempted, bond refunded;
 * - the fund drained and recapitalized since the snapshot: voided, bond refunded.
 * A claim-backed vote's bond is UMA's, so none of these moves one. `notes[0]` and `outcome` say which applies now.
 *
 * Refused up front: an unknown or resolved proposal, and one still open below its threshold (the
 * contract reverts until the vote reaches 60% or its latch closes).
 */
export async function executeInsurerTermination(
  ctx: BazaarContext,
  args: { pair: Address; id: Hex; from?: Address },
): Promise<CostedCall & { readonly outcome: InsurerExecutionOutcome }> {
  const pair = asAddress("pair", args.pair);
  const id = asBytes32("id", args.id);
  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.terminator, codec: T(), fn: "insurerProposals", args: [id] },
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: pair, codec: P(), fn: "extsload", args: [("0x" + PAIR_SLOT_SHARE_EPOCH.toString(16).padStart(64, "0")) as Hex] },
      { to: pair, codec: P(), fn: "scheduledTerminationTs" },
    ]),
    chainNow(ctx),
  ]);
  const prop = toInsurerProposal(id, r[0] as Record<string, unknown>, now);
  if (!prop || prop.pair !== pair || prop.resolved) throw new InputError("id", "There is no open vote with this id on this market.");
  const bare = !prop.claimBacked;
  let outcome: InsurerExecutionOutcome;
  let text: string;
  if ((r[1] as bigint) !== 0n) {
    outcome = "preempted";
    text = "The market's price is already fixed: the vote is resolved as preempted" + (bare ? " and its bond refunded." : ".");
  } else if (prop.snapshotTaken && prop.shareEpoch !== BigInt(r[2] as Hex)) {
    outcome = "voided";
    text = "The insurance fund was recapitalized since the snapshot: the vote is voided" + (bare ? " and its bond refunded." : ".");
  } else if (now + INSURER_TERMINATION_LATCH_LEAD > prop.cutoffTs) {
    outcome = prop.thresholdMet ? "failedRefund" : "failedForfeit";
    text =
      `The vote's latch closed at ${timeText(prop.votingClosesAt)} without scheduling the market: it is resolved as failed` +
      (bare ? (prop.thresholdMet ? ", and its bond refunded since it reached 60%." : ", and its bond forfeited to the insurance fund.") : ".");
  } else if (!prop.thresholdMet) {
    throw new InputError(
      "id",
      `The vote has ${sharesText(prop.yesShares)} of the ${sharesText(prop.snapshotTaken ? prop.thresholdShares : 0n)} it needs; it can be executed once it reaches 60%, until ${timeText(prop.votingClosesAt)}.`,
    );
  } else {
    const existing = Number(r[3] as bigint);
    if (existing !== 0 && existing <= prop.cutoffTs) {
      outcome = "preempted";
      text = `The market is already scheduled to stop at ${timeText(existing)}: the vote is resolved as preempted` + (bare ? " and its bond refunded." : ".");
    } else {
      outcome = "schedule";
      text =
        `The market is scheduled to stop trading at ${timeText(prop.cutoffTs)} (6 seconds before it)` +
        (bare ? ", and the bond is refunded; it settles under the chain rule." : "; it settles under UMA's verdict on the claim behind the vote.");
    }
  }
  return {
    action: "executeInsurerTermination",
    to: ctx.terminator,
    data: T().encode("executeInsurerTermination", pair, id),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Resolve insurer vote ${short(id)}: ${text.charAt(0).toLowerCase()}${text.slice(1)} (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes: [text],
    outcome,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixing the settlement price: the stale-oracle path
// ---------------------------------------------------------------------------------------------

/**
 * End a market that has stored no price for more than 21 days, at its last stored price (or at a
 * nominal price of 1 when it never stored one, aged from its creation). Anyone may call it; it pays
 * nothing and costs only gas. The pair's own stored price is the evidence: a pair stores one whenever
 * a call lands on it with a fresh update, and one `refreshPrice` restarts the 21 days.
 *
 * Refused up front: an unregistered or fixed market, one whose vote-set cutoff has passed (it settles
 * through terminateScheduledPair), and one whose stored price is 21 days old or less (with the time
 * it opens).
 */
export async function terminateStalePair(ctx: BazaarContext, args: { pair: Address; from?: Address }): Promise<CostedCall> {
  const pair = asAddress("pair", args.pair);
  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.terminator, codec: T(), fn: "isPair", args: [pair] },
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: ctx.terminator, codec: T(), fn: "insurerScheduleId", args: [pair] },
      { to: pair, codec: P(), fn: "scheduledTerminationTs" },
      { to: pair, codec: P(), fn: "lastPairPrice" },
      { to: pair, codec: P(), fn: "auxState" },
    ]),
    chainNow(ctx),
  ]);
  if (!(r[0] as boolean)) throw new InputError("pair", "This market is not registered with Bazaar's terminator.");
  if ((r[1] as bigint) !== 0n) throw new InputError("pair", "This market's settlement price is already fixed.");
  const scheduled = Number(r[3] as bigint);
  if (!isZero32(r[2] as Hex) && now > scheduled) {
    throw new InputError("pair", "An insurer vote's cutoff has passed: this market settles through terminateScheduledPair, whose own fallback reaches the stored price.");
  }
  const last = r[4] as { spotPrice: bigint; updateTs: bigint };
  const created = Number((r[5] as { pairCreatedTs: bigint }).pairCreatedTs);
  const asOf = last.spotPrice === 0n ? created : Number(last.updateTs);
  if (now - asOf <= ORACLE_DEAD_THRESHOLD) {
    const opens = asOf + ORACLE_DEAD_THRESHOLD + 1;
    throw new InputError(
      "pair",
      `This market stored a price within the last ${durationText(ORACLE_DEAD_THRESHOLD)}: the stale-oracle path opens at ${timeText(opens)} if it stores none until then.`,
    );
  }
  return {
    action: "terminateStalePair",
    to: ctx.terminator,
    data: T().encode("terminateStalePair", pair),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: "End this market at its last stored price: it has stored no price for more than 21 days (no cost but gas)",
    costs: [],
    approvals: [],
    requires: [],
    notes: [
      last.spotPrice === 0n
        ? "The market never stored a price, so it settles at the nominal price of 1."
        : "The market settles at its last stored, confidence-checked price.",
      "Fixing the price opens the settlement window: positions settle at it, then finalizeTermination opens withdrawals.",
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Fixing the settlement price at a scheduled cutoff
// ---------------------------------------------------------------------------------------------

/** One of Pyth's one-second updates, read for one feed, as settlement evidence. Times are unix seconds. */
export interface SettlementPrint {
  readonly feedId: Hex;
  /** The signed update (one `bytes` element of the call's priceUpdate). */
  readonly update: Hex;
  /** The second the update is stamped with. */
  readonly tick: number;
  /** Which of the feed's properties the update carries (prices/lazer.ts HAS_* bits). */
  readonly included: number;
  /** Whether the feed holds a price in it: Pyth encodes "no price" as zero. */
  readonly priced: boolean;
  /** The feed's price mantissa as the update carries it: zero for no price. The oracle refuses to settle at a price at or below zero. */
  readonly price: bigint;
  /**
   * When that price was generated, in microseconds (the feed update timestamp): the update's own
   * instant when Pyth produced a price on that second, earlier when the price is carried forward.
   * Zero when the update carries no generation time for the feed.
   */
  readonly generatedUs: bigint;
  /** The second that price was generated in; 0 when the update carries no generation time. */
  readonly publishTime: number;
}

/**
 * Pyth's one-second update stamped `second`, carrying `feedIds` together, or null when the archive
 * has none for that second. The shape of {@link PriceUpdateSource.atTick}.
 */
export type TickFetcher = (feedIds: readonly Hex[], second: number) => Promise<ProUpdate | null>;

/**
 * Why a settlement update could not be had. `absent`: the archive answered, and what it holds shows no
 * proven settlement exists now (no update for the second, no price in it, a price the oracle refuses,
 * no chain under its bound, or none yet). `unreachable`: the archive could not be asked, or its answer
 * could not be used (a failed or refused request, a signer check that failed, an answer that is not
 * the update asked for, one without the feed or without a property asked for), so a proven settlement
 * may well exist.
 */
export type SettlementPrintFailure = "absent" | "unreachable";

/** A settlement update that could not be fetched, or a sample that cannot be proven. */
export class SettlementPrintError extends Error {
  override readonly name = "SettlementPrintError";
  constructor(
    message: string,
    readonly feedId: Hex,
    readonly target: number,
    /** Whether the archive showed that no usable update exists, or could not be relied on (see {@link SettlementPrintFailure}). */
    readonly kind: SettlementPrintFailure = "unreachable",
  ) {
    super(message);
  }
}

/** A {@link TickFetcher} over the context's price source (its `atTick`). */
export function tickFetcher(source: PriceUpdateSource | null): TickFetcher {
  if (!source?.atTick) {
    throw new ConnectError("Settling a market at its cutoff needs Pyth's archived one-second updates: connect with a Pyth Pro price source (one that serves atTick).");
  }
  return source.atTick.bind(source);
}

/** Text from outside the SDK (an archive's or a transport's error), fit to quote: every URL in it redacted, made printable and bounded. */
const outsideText = (text: string) => printable(redactUrls(text), 300);

/**
 * `feedId` as the one-second update `u` for `second` carries it. Throws SettlementPrintError where
 * BazaarOracle refuses the update for this feed whatever else it holds: it is not the one-second
 * channel's update stamped `second` (BazaarOracle__WrongTick), it does not carry the feed
 * (BazaarOracle__FeedNotInUpdate), or the feed's entry lacks its price or its exponent
 * (BazaarOracle__IncompleteFeed). Each counts as unreachable: an update leaves out a feed the token
 * does not cover as well as one Pyth does not serve, so none of these shows that no price exists.
 */
export function settlementPrint(u: ProUpdate, feedId: Hex, second: number): SettlementPrint {
  const id = feedId.toLowerCase() as Hex;
  if (u.channel !== CHANNEL_FIXED_RATE_1000 || u.timestampUs !== BigInt(second) * MICROS_PER_SECOND) {
    throw new SettlementPrintError(`The update offered for second ${second} is not Pyth's one-second update stamped on it.`, id, second, "unreachable");
  }
  const f = u.feeds.get(id);
  if (!f) throw new SettlementPrintError(`Pyth's one-second update for second ${second} does not carry feed ${short(id)}.`, id, second, "unreachable");
  if ((f.included & TICK_PROPERTIES) !== TICK_PROPERTIES) {
    throw new SettlementPrintError(`Pyth's one-second update for second ${second} carries feed ${short(id)} without its price or its exponent.`, id, second, "unreachable");
  }
  const generatedUs = (f.included & HAS_FEED_UPDATE_TIMESTAMP) !== 0 ? f.feedUpdateTimestamp : 0n;
  return { feedId: id, update: u.blob, tick: second, included: f.included, priced: f.price !== 0n, price: f.price, generatedUs, publishTime: Number(generatedUs / MICROS_PER_SECOND) };
}

/**
 * The one-second update for `second` carrying `feedIds`; throws SettlementPrintError when the archive
 * has none (absent) or cannot be asked (unreachable).
 */
async function tickAt(fetch: TickFetcher, feedIds: readonly Hex[], second: number): Promise<ProUpdate> {
  let u: ProUpdate | null;
  try {
    u = await fetch(feedIds, second);
  } catch (e) {
    if (e instanceof SettlementPrintError) throw e;
    throw new SettlementPrintError(
      `Pyth's archive could not serve feed ${short(feedIds[0]!)} at second ${second}: ${outsideText(e instanceof Error ? e.message : String(e))}`,
      feedIds[0]!,
      second,
      "unreachable",
    );
  }
  if (!u) throw new SettlementPrintError(`Pyth's archive has no one-second update for feed ${short(feedIds[0]!)} at second ${second} yet.`, feedIds[0]!, second, "absent");
  return u;
}

/** What UMA's rule settles a market with: the cutoff's update for every leg. */
export interface TickProof {
  /** The call's priceUpdate: one update carrying every leg, or one per leg. */
  readonly updates: Hex[];
  /** Each leg as the cutoff's update carries it, in `legs` order. */
  readonly prints: SettlementPrint[];
}

/**
 * UMA's rule: Pyth's one-second update stamped `cutoff` for every leg, whose price settles the
 * market whenever it was generated (a quiet feed's update carries its last price forward). The legs
 * are asked for together, so a composite settles with one update; when the archive does not answer
 * for them together, each leg is asked for on its own and the proof is one update per leg.
 *
 * Throws SettlementPrintError when the archive has no such update, and when it carries no price above
 * zero for a leg: the oracle refuses a price at or below zero, and the market can then only settle at
 * its stored price once the grace ends.
 */
export async function tickPrints(fetch: TickFetcher, legs: readonly Hex[], cutoff: number): Promise<TickProof> {
  let together: ProUpdate | null = null;
  if (legs.length > 1) {
    try {
      const u = await fetch(legs, cutoff);
      if (u && legs.every((l) => u.feeds.has(l.toLowerCase() as Hex))) together = u;
    } catch {
      // asked for one by one below, which reports what fails
    }
  }
  const updates: Hex[] = [];
  const prints: SettlementPrint[] = [];
  for (const leg of legs) {
    const p = settlementPrint(together ?? (await tickAt(fetch, [leg], cutoff)), leg, cutoff);
    if (!p.priced) {
      throw new SettlementPrintError(`Pyth's one-second update stamped at the cutoff (${cutoff}) carries no price for feed ${short(p.feedId)}: it cannot settle the market.`, p.feedId, cutoff, "absent");
    }
    if (p.price < 0n) {
      throw new SettlementPrintError(
        `Pyth's one-second update stamped at the cutoff (${cutoff}) carries a price below zero for feed ${short(p.feedId)}, which the oracle refuses: it cannot settle the market.`,
        p.feedId,
        cutoff,
        "absent",
      );
    }
    prints.push(p);
    if (!updates.includes(p.update)) updates.push(p.update);
  }
  return { updates, prints };
}

/** How far a chain sample may be searched for. */
export interface ChainSearchBounds {
  /** The latest second a sample's update may be stamped with (the UMA cutoff that caps the chain); null when unbounded. */
  readonly latest: number | null;
  /** The newest second the archive can hold an update for: the present. */
  readonly newest: number;
}

/**
 * Whether `p` carries a price generated at or after second `target` (BazaarOracle._pricedSince):
 * true for the update a sample is taken from, false for one that shows the feed quiet (a price
 * carried forward from before the target). Throws SettlementPrintError where the oracle refuses the
 * update as incomplete: it was requested without the feed update timestamp (unreachable: the archive
 * left out a property asked for), it carries no price, or it carries a price without a generation
 * time (both absent: Pyth's own data). Such an update does not say when the feed last priced, so it
 * cannot show the feed quiet.
 */
export function generatedAtOrAfter(p: SettlementPrint, target: number): boolean {
  if ((p.included & CHAIN_PROPERTIES) !== CHAIN_PROPERTIES) {
    throw new SettlementPrintError(
      `Pyth's one-second update for second ${p.tick} carries feed ${short(p.feedId)} without its feed update timestamp: it proves nothing about the target ${target}.`,
      p.feedId,
      target,
      "unreachable",
    );
  }
  if (!p.priced) {
    throw new SettlementPrintError(`Pyth's one-second update for second ${p.tick} carries no price for feed ${short(p.feedId)}: it proves nothing about the target ${target}.`, p.feedId, target, "absent");
  }
  if (p.generatedUs === 0n) {
    throw new SettlementPrintError(
      `Pyth's one-second update for second ${p.tick} carries a price for feed ${short(p.feedId)} without saying when it was generated: it proves nothing about the target ${target}.`,
      p.feedId,
      target,
      "absent",
    );
  }
  return p.generatedUs >= BigInt(target) * MICROS_PER_SECOND;
}

/** `p`, the update a sample is taken from, unless its price is one the oracle refuses to settle at (at or below zero). */
function samplePrice(p: SettlementPrint, target: number): SettlementPrint {
  if (p.price <= 0n) {
    throw new SettlementPrintError(
      `Pyth's one-second update for second ${p.tick} gives feed ${short(p.feedId)} a price at or below zero for the target ${target}, which the oracle refuses: no chain can be proven.`,
      p.feedId,
      target,
      "absent",
    );
  }
  return p;
}

/**
 * One leg of one chain sample: the earliest one-second update carrying a price for `feedId`
 * generated at or after `target`, with what proves it is the earliest (BazaarOracle._sampleLeg).
 *
 * When the update stamped `target` carries such a price, it is its own proof and is returned alone.
 * Otherwise the feed was quiet at the target: its updates carry the earlier price forward until it
 * produces a new one, and since the generation time never goes backwards from one second to the
 * next, the first second whose update carries a price generated at or after the target is found by
 * doubling the step from the target and then bisecting. Two updates are returned, in the order the
 * oracle reads them: that second's predecessor, still quiet, and that second's.
 *
 * Throws SettlementPrintError when the archive lacks an update the search needs, when the feed has
 * produced no such price up to `bounds.newest` (the sample does not exist yet), when the sample
 * would be stamped after `bounds.latest` (no chain exists under that bound), and when the sample's
 * price is at or below zero (the oracle refuses it).
 */
export async function chainSample(fetch: TickFetcher, feedId: Hex, target: number, bounds: ChainSearchBounds): Promise<SettlementPrint[]> {
  const leg = feedId.toLowerCase() as Hex;
  const { latest, newest } = bounds;
  if (latest !== null && target > latest) {
    throw new SettlementPrintError(`The sample's target ${target} lies after the latest second a sample may be stamped with (${latest}): no chain exists under that bound.`, leg, target, "absent");
  }
  if (target > newest) throw new SettlementPrintError(`The sample's target ${target} has not been reached yet: its update does not exist.`, leg, target, "absent");
  const at = async (second: number) => settlementPrint(await tickAt(fetch, [leg], second), leg, second);
  const first = await at(target);
  if (generatedAtOrAfter(first, target)) return [samplePrice(first, target)];

  // `quiet` is the last second known to carry no price generated at or after the target, `live` the
  // first known to carry one.
  const limit = latest === null ? newest : Math.min(latest, newest);
  let quiet = first;
  let live: SettlementPrint | null = null;
  for (let step = 1; live === null; step *= 2) {
    if (quiet.tick >= limit) {
      throw new SettlementPrintError(
        latest !== null && limit === latest
          ? `Feed ${short(leg)} produced no price from ${target} up to the latest second a sample may be stamped with (${latest}): no chain exists under that bound.`
          : `Feed ${short(leg)} has produced no price since ${target} yet (looked up to ${limit}): its sample does not exist.`,
        leg,
        target,
        "absent",
      );
    }
    const p = await at(Math.min(quiet.tick + step, limit));
    if (generatedAtOrAfter(p, target)) live = p;
    else quiet = p;
  }
  while (live.tick - quiet.tick > 1) {
    const p = await at(quiet.tick + Math.floor((live.tick - quiet.tick) / 2));
    if (generatedAtOrAfter(p, target)) live = p;
    else quiet = p;
  }
  return [quiet, samplePrice(live, target)];
}

/** What the chain rule settles a market with. */
export interface ChainProof {
  /** The call's priceUpdate: sample by sample, the base leg's one or two updates, then the quote leg's. */
  readonly updates: Hex[];
  /** The same updates as read, in the same order. */
  readonly prints: SettlementPrint[];
  /** Each sample's target. */
  readonly targets: number[];
  /** The second each sample is stamped with: for a composite, the later of its two legs'. */
  readonly ticks: number[];
}

/**
 * The chain rule's sample set: `count` samples, the first targeting `firstTarget` (the cutoff), each
 * later one targeting `spacing` seconds past the second the sample before is stamped with (for a
 * composite, the later of its two legs'), every sample stamped no later than `bounds.latest` when
 * bounded. Each leg of each sample is found and proven by {@link chainSample}. The targets depend on
 * the samples, so the samples are searched in sequence; the legs of one sample in parallel.
 */
export async function chainPrints(
  fetch: TickFetcher,
  legs: readonly Hex[],
  firstTarget: number,
  bounds: ChainSearchBounds,
  count = SETTLEMENT_SAMPLE_COUNT,
  spacing = SETTLEMENT_SAMPLE_SPACING,
): Promise<ChainProof> {
  const prints: SettlementPrint[] = [];
  const targets: number[] = [];
  const ticks: number[] = [];
  let target = firstTarget;
  for (let k = 0; k < count; k++) {
    targets.push(target);
    const t = target;
    const sample = await Promise.all(legs.map((leg) => chainSample(fetch, leg, t, bounds)));
    let tick = 0;
    for (const proof of sample) {
      prints.push(...proof);
      tick = Math.max(tick, proof[proof.length - 1]!.tick);
    }
    ticks.push(tick);
    target = tick + spacing;
  }
  return { updates: prints.map((p) => p.update), prints, targets, ticks };
}

/** Which rule a terminateScheduledPair call settles under: UMA's cutoff update, the chain's median, or the stored-price last resort. */
export type SettleUnder = "tick" | "chain" | "storedPrice";

/**
 * Why a candidate failed: the archive showed no usable update exists (`absent`), could not be asked or
 * relied on (`unreachable`), or the oracle or the contract refused the set (`refused`).
 */
export type SettlementFailure = SettlementPrintFailure | "refused";

/**
 * When terminateScheduledPair offers the stored-price call once its last resort is open, as a call
 * that settles the market irreversibly: `whenAbsent` only when every proven set failed as absent and
 * the archive answered a control request (ETH/USD a minute ago), so its "none" is believed; `always`
 * whenever no proven set is accepted, for a caller who has decided; `never` not at all.
 */
export type StoredPricePolicy = "whenAbsent" | "always" | "never";

/** One candidate the builder tried. */
export interface SettlementAttempt {
  readonly under: SettleUnder;
  /** True when the contract accepted it in simulation. */
  readonly ok: boolean;
  /** Why it was not used (a missing update or an unprovable sample, the oracle's or the contract's refusal), or "" when ok. */
  readonly reason: string;
  /** What kind of failure that was (see {@link SettlementFailure}); null when ok. */
  readonly kind: SettlementFailure | null;
  /** The oracle's or the contract's decoded refusal, when one reverted. */
  readonly error: DecodedError | null;
  /**
   * The price it would fix (BAZAAR precision): what the oracle returned when it verified the updates
   * (fetchPriceAtTick or fetchChainedMedian, called as the terminator calls it), or the stored price
   * for the fallback; null when the updates were not verified.
   */
  readonly price: bigint | null;
}

/** What terminateScheduledPair needs now. */
export interface ScheduledSettlementPlan {
  readonly pair: Address;
  readonly now: number;
  readonly scheduledTerminationTs: number;
  readonly rule: SettlementRuleInfo;
  /** The call the contract accepts, or null when no candidate settles the market yet. */
  readonly call: CostedCall | null;
  readonly under: SettleUnder | null;
  /** The call's priceUpdate. */
  readonly updates: readonly Hex[];
  /** The updates as read, feed by feed: under the chain rule in calldata order, under UMA's rule one per leg. */
  readonly prints: readonly SettlementPrint[];
  /**
   * The settlement price the call fixes (BAZAAR precision): the price the oracle returned for its
   * updates, or the market's stored price under `storedPrice`; null when there is no call.
   */
  readonly settlementPrice: bigint | null;
  readonly attempts: readonly SettlementAttempt[];
  /** Why there is no call, for display. */
  readonly reason: string | null;
  /** When to try again, when known (the verdict, the stored-price fallback). */
  readonly retryAt: number | null;
  /**
   * Why the stored-price call is not offered although its last resort is open (see
   * {@link StoredPricePolicy}): `attempts` then say which sets failed and how. Null when it is offered,
   * and when it is not open.
   */
  readonly storedPriceWithheld: string | null;
}

const UNDER_TEXT: Readonly<Record<SettleUnder, string>> = {
  tick: "UMA's rule (the one-second update stamped at the cutoff)",
  chain: "the chain rule (the median of five chained prices)",
  storedPrice: "the stored price (the last resort is open)",
};

/** Seconds before the chain's present at which the archive is asked for its control update, in the order tried. */
const CONTROL_SECONDS_BACK = [60, 61, 62];

/**
 * Whether the archive behind `fetch` works: it serves a one-second update carrying a price for
 * ETH/USD, which Pyth prices around the clock, at one of a few seconds a minute before `now`.
 */
async function archiveAnswers(fetch: TickFetcher, now: number): Promise<boolean> {
  for (const back of CONTROL_SECONDS_BACK) {
    const second = now - back;
    try {
      const u = await fetch([ETH_USD_FEED], second);
      if (u !== null && settlementPrint(u, ETH_USD_FEED, second).price > 0n) return true;
    } catch {
      // not this second: the next one, until the tries run out
    }
  }
  return false;
}

/**
 * Build `terminateScheduledPair(pair, priceUpdate)`: fix a scheduled market's settlement price with
 * Pyth's archived one-second updates, fetched for the rule that applies, and simulated as `from` so
 * the returned call is one the contract accepts.
 *
 * It reads `settlementRule(pair)`, then fetches from the price source's `atTick` (or `fetchTick`):
 * - `tick` (UMA's rule): the update stamped at the cutoff for every leg ({@link tickPrints}), whose
 *   price settles the market.
 * - `chain`: five samples ({@link chainPrints}), each the earliest update carrying a price generated
 *   at or after its target, the next target 600 s past the sample's second (the later leg's), every
 *   sample stamped no later than `latestPublishTs` (the UMA cap, when there is one).
 * - A claim-backed vote whose verdict nobody has recorded may settle under either rule, because the
 *   call records the verdict itself (UMA's rule if the DVM upheld the claim, the chain rule if not).
 *   The builder first simulates OOv3's `settleAndGetAssertionResult` (uma's `previewSettlement`) to
 *   see whether and how the DVM ruled, and builds that rule's set (an upheld claim's UMA rule has no
 *   stored-price fallback yet: its grace starts at this recording). When the verdict cannot be
 *   previewed, both sets are built and each is simulated, and the one the contract accepts is
 *   returned. Building the cutoff's set here, rather than first recording an upheld verdict on its
 *   own, also avoids starting its 12-hour grace before the update is in hand. (Trying the other
 *   rule's set blindly is avoided once the verdict is known: past a last resort the contract would
 *   accept it by falling back to the stored price, and the call would be mislabelled.)
 * - Past `lastResortTs`, a call with no updates settles at the stored price, for good. It is offered
 *   only when no proven set is accepted, and by default (`storedPrice: "whenAbsent"`) only when every
 *   set failed because Pyth's archive holds no usable update and the archive is shown to work: a
 *   request that timed out, was refused, or reached the wrong URL must not settle a market at its
 *   stored price while a proven price exists. Otherwise the plan says why it is withheld
 *   (`storedPriceWithheld`), so the caller can try again later or decide with `storedPrice: "always"`.
 *
 * The fee for either set is `getUpdateFee(updates.length)` on the pair's oracle: Pyth's fee per
 * update, each update verified in a call of its own.
 *
 * Every set is then verified the way the terminator verifies it: an eth_call (as `from`, with the
 * fee) of the pair's oracle's `fetchPriceAtTick` (UMA's rule) or `fetchChainedMedian` (the chain
 * rule), with the arguments the terminator passes. Only a set that call accepts is offered as a
 * proven settlement, and the price it fixes is shown (`settlementPrice`). This matters once the
 * fallback is open: the terminator then catches a refused set and settles at the stored price
 * instead, so the contract's simulation alone would accept updates Pyth refuses (a signer it has
 * retired, a wrong update) and the call would be labelled with a price it does not fix. A refused set
 * is reported in `attempts`, saying when a call carrying it would settle at the stored price.
 *
 * The call sends the Pyth fee as `value` (any excess is refunded) and pays nothing back; the
 * returned `costs` carry the fee. Refused up front: an unregistered or fixed market, one with no
 * cutoff, and one whose cutoff has not passed yet. Otherwise a plan with `call: null` says why, and
 * when to try again if that is known.
 *
 * @param args.pair The market to settle.
 * @param args.from The account that will send it: the simulation runs as it (the fee is sent as ETH).
 * @param args.fetchTick Overrides the price source (tests, or a custom archive).
 * @param args.estimateGas Also estimate the call's gas in the simulation; default false.
 * @param args.storedPrice When the stored-price call is offered once its last resort is open; default "whenAbsent" ({@link StoredPricePolicy}).
 */
export async function terminateScheduledPair(
  ctx: BazaarContext,
  args: { pair: Address; from: Address; fetchTick?: TickFetcher; estimateGas?: boolean; storedPrice?: StoredPricePolicy },
): Promise<ScheduledSettlementPlan> {
  const pair = asAddress("pair", args.pair);
  const from = asAddress("from", args.from);
  const policy = args.storedPrice ?? "whenAbsent";
  if (policy !== "whenAbsent" && policy !== "always" && policy !== "never") {
    throw new InputError("storedPrice", 'It is "whenAbsent", "always" or "never".');
  }
  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: ctx.terminator, codec: T(), fn: "isPair", args: [pair] },
      { to: pair, codec: P(), fn: "scheduledTerminationTs" },
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: ctx.terminator, codec: T(), fn: "settlementRule", args: [pair] },
      { to: ctx.terminator, codec: T(), fn: "insurerScheduleId", args: [pair] },
      { to: ctx.terminator, codec: T(), fn: "umaCutoffCap", args: [pair] },
      { to: pair, codec: P(), fn: "oracle" },
      { to: pair, codec: P(), fn: "lastPairPrice" },
    ]),
    chainNow(ctx),
  ]);
  if (!(r[0] as boolean)) throw new InputError("pair", "This market is not registered with Bazaar's terminator.");
  if ((r[2] as bigint) !== 0n) throw new InputError("pair", "This market's settlement price is already fixed.");
  const cutoff = Number(r[1] as bigint);
  if (cutoff === 0) throw new InputError("pair", "This market has no scheduled cutoff.");
  if (now <= cutoff) throw new InputError("pair", `The market's cutoff is ${timeText(cutoff)}: it can be settled from the first block after it.`);
  const rule = toRule(r[3] as never);
  const scheduleId = r[4] as Hex;
  const capRaw = BigInt(r[5] as bigint);
  const cap = timeOrNull(capRaw);
  // What the terminator settles with: the pair's own oracle, and its stored price for the fallback
  // (BazaarPairTerminator._lastStoredPrice: a pair that never stored one settles at 1).
  const pairOracle = getAddress(r[6] as Address);
  const storedSpot = (r[7] as { spotPrice: bigint }).spotPrice;
  const stored = storedSpot === 0n ? NEVER_PRICED_SETTLEMENT_PRICE : storedSpot;

  const base = { pair, now, scheduledTerminationTs: cutoff, rule };
  if (rule.key === "nothing") {
    return { ...base, call: null, under: null, updates: [], prints: [], settlementPrice: null, attempts: [], reason: rule.meaning, retryAt: null, storedPriceWithheld: null };
  }
  // The source is resolved when a set is fetched, so that under "always" the stored-price call can be
  // built without one; under the other policies a missing source is refused here, as nothing could be
  // settled without it.
  if (!args.fetchTick && policy !== "always") tickFetcher(ctx.prices);
  const fetch: TickFetcher = args.fetchTick ?? ((ids, second) => tickFetcher(ctx.prices)(ids, second));
  const feeds = await pairFeeds(ctx, pair);

  // Which rule the call settles under. settlementRule cannot see a verdict UMA's DVM has reached on
  // the claim behind a vote until someone records it, but the call records it itself and settles
  // under it: UMA's rule for an upheld claim, the chain rule otherwise.
  let rules: ("tick" | "chain")[] = rule.key === "tick" ? ["tick"] : rule.key === "chain" ? ["chain"] : [];
  let chainAt = { first: rule.firstTarget ?? cutoff, latest: rule.latestPublishTs };
  let lastResort = rule.lastResortTs;
  let recordsVerdict = false;
  if (!isZero32(scheduleId)) {
    const vote = toInsurerProposal(scheduleId, await readOne(ctx, ctx.terminator, T(), "insurerProposals", scheduleId), now);
    // Undisputed past its liveness, the claim reads as upheld (UMA's rule) and the call records it.
    if (vote?.claimBacked && vote.verdict === 0 && rule.key === "tick") recordsVerdict = true;
    if (vote?.claimBacked && vote.verdict === 0 && rule.key !== "tick") {
      const oo = await assertionOracle(ctx, scheduleId, "terminator");
      const st = statusOf(await getAssertion(ctx, oo, scheduleId), now);
      if (rule.key === "awaitVerdict" && st.phase === "liveness") {
        return {
          ...base,
          call: null,
          under: null,
          updates: [],
          prints: [],
          settlementPrice: null,
          attempts: [],
          reason: `The vote that set the cutoff waits for UMA's verdict on its claim, which is known when the claim's liveness ends at ${timeText(st.canSettleAt!)}.`,
          retryAt: st.canSettleAt,
          storedPriceWithheld: null,
        };
      }
      // A disputed claim: simulate settling it to see whether, and how, the DVM has ruled.
      const pv = st.phase === "disputed" ? await previewSettlementOn(ctx, oo, scheduleId, from) : null;
      const capped = cap;
      if (pv?.result === true) {
        // Upheld: UMA's rule at the cutoff, its grace counted from this recording, so no fallback yet.
        rules = ["tick"];
        lastResort = null;
        recordsVerdict = true;
      } else if (pv?.result === false) {
        rules = ["chain"];
        chainAt = { first: cutoff, latest: capped };
        lastResort = chainLastResort(cutoff, capped);
        recordsVerdict = true;
      } else if (rule.key === "awaitVerdict") {
        // The verdict could not be previewed: build both sets and let the contract say which it takes.
        rules = ["tick", "chain"];
        chainAt = { first: cutoff, latest: capped };
        lastResort = null;
        recordsVerdict = true;
      }
    }
  }

  // Pyth's fee for `n` updates, as the terminator reads it: from the pair's own oracle.
  const feeFor = (n: number) => (n === 0 ? Promise.resolve(0n) : readOne<bigint>(ctx, pairOracle, oracleCodec(), "getUpdateFee", BigInt(n)));
  type Built = { updates: Hex[]; prints: SettlementPrint[]; fee: bigint };
  type Candidate = { under: SettleUnder; build: () => Promise<Built> };
  const candidates: Candidate[] = [];
  if (rules.includes("tick")) {
    candidates.push({
      under: "tick",
      build: async () => {
        const w = await tickPrints(fetch, feeds.legs, cutoff);
        return { updates: w.updates, prints: w.prints, fee: await feeFor(w.updates.length) };
      },
    });
  }
  if (rules.includes("chain")) {
    candidates.push({
      under: "chain",
      build: async () => {
        const c = await chainPrints(fetch, feeds.legs, chainAt.first, { latest: chainAt.latest, newest: now });
        return { updates: c.updates, prints: c.prints, fee: await feeFor(c.updates.length) };
      },
    });
  }
  // Past the last resort an empty call settles at the stored price; tried only after the proven sets.
  const storedOpen = rules.length === 1 && lastResort !== null && now > lastResort;
  // Whether the terminator, given a set the oracle refuses under `under`, settles at the stored price
  // instead of reverting (its try/catch past the grace or the last resort).
  const fallsBack = (under: "tick" | "chain"): boolean => {
    if (rules.length === 2) return under === "chain" && now > chainLastResort(cutoff, cap);
    return lastResort !== null && now > lastResort;
  };
  // The oracle call the terminator makes with these updates, with its arguments, as `from` with the fee.
  const U64_MAX = (1n << 64n) - 1n;
  const chainMax = capRaw === 0n || capRaw > U64_MAX ? U64_MAX : capRaw; // _insurerSettlementBounds' latestPublishTs
  const prove = async (under: "tick" | "chain", updates: Hex[], fee: bigint): Promise<{ price: bigint } | { why: string; error: DecodedError | null }> => {
    const oc = oracleCodec();
    const fn = under === "tick" ? "fetchPriceAtTick" : "fetchChainedMedian";
    const data =
      under === "tick"
        ? oc.encode(fn, feeds.baseFeedId, updates, BigInt(cutoff))
        : oc.encode(fn, feeds.baseFeedId, updates, BigInt(cutoff), chainMax, BigInt(SETTLEMENT_SAMPLE_SPACING), BigInt(SETTLEMENT_SAMPLE_COUNT));
    let ret: Hex;
    try {
      ret = await ctx.chain.call(pairOracle, data, { from, value: fee });
    } catch (e) {
      const rpc = toRpcError(e);
      if (!rpc) throw e;
      const error = decodeError(rpc.revertData);
      // No revert data: the node refused the call itself (say, `from` cannot cover the fee); say what it said.
      return { why: !rpc.revertData || rpc.revertData === "0x" ? outsideText(rpc.rpcMessage) : error.message, error };
    }
    try {
      return { price: oc.decode<bigint>(fn, ret) };
    } catch {
      return { why: "the oracle returned no price", error: null };
    }
  };

  const attempts: SettlementAttempt[] = [];
  /** Build, verify and simulate one candidate: the plan when the contract accepts it, else null with its attempt recorded. */
  const settle = async (c: Candidate): Promise<ScheduledSettlementPlan | null> => {
    let built: Built;
    try {
      built = await c.build();
    } catch (e) {
      if (!(e instanceof SettlementPrintError)) throw e;
      attempts.push({ under: c.under, ok: false, reason: e.message, kind: e.kind, error: null, price: null });
      return null;
    }
    let price = stored;
    let fallback = false;
    if (c.under !== "storedPrice") {
      fallback = fallsBack(c.under);
      const proof = await prove(c.under, built.updates, built.fee);
      if (!("price" in proof)) {
        const refused = `The oracle would not verify these updates (${proof.why}).`;
        attempts.push({
          under: c.under,
          ok: false,
          reason: fallback
            ? `${refused} The stored-price fallback is open, so a call carrying them would settle at the market's stored price (${priceText(stored)}) instead: they are not offered as a proven settlement.`
            : `${refused} The terminator would refuse them too.`,
          kind: "refused",
          error: proof.error,
          price: null,
        });
        return null;
      }
      price = proof.price;
    }
    const call = scheduledCall(ctx, pair, from, c.under, built.updates, built.fee, cutoff, recordsVerdict, price, fallback ? stored : null);
    const sim = await simulate(ctx, call, { from, estimateGas: args.estimateGas ?? false });
    if (sim.ok) {
      attempts.push({ under: c.under, ok: true, reason: "", kind: null, error: null, price });
      return { ...base, call, under: c.under, updates: built.updates, prints: built.prints, settlementPrice: price, attempts, reason: null, retryAt: null, storedPriceWithheld: null };
    }
    attempts.push({ under: c.under, ok: false, reason: `The contract refused it: ${sim.error?.message ?? "reverted"}`, kind: "refused", error: sim.error, price });
    return null;
  };
  for (const c of candidates) {
    const plan = await settle(c);
    if (plan) return plan;
  }

  /** Why the open stored-price call is not offered, or null to offer it (see StoredPricePolicy). */
  const withholdStoredPrice = async (): Promise<string | null> => {
    if (policy === "never") return 'storedPrice is "never"';
    if (policy === "always") return null;
    const doubtful = attempts.filter((a) => a.kind !== "absent");
    if (doubtful.length > 0) {
      return `a proven settlement may still exist (${doubtful.map((a) => `${a.under}: ${a.kind}`).join(", ")}): try again later, or pass storedPrice: "always" to settle at the stored price anyway`;
    }
    if (await archiveAnswers(fetch, now)) return null;
    // The archive answered nothing it must hold, so its "none" says nothing either.
    for (let i = 0; i < attempts.length; i++) {
      attempts[i] = { ...attempts[i]!, kind: "unreachable", reason: `${attempts[i]!.reason} (Not believed: the archive did not serve ETH/USD's one-second update from a minute ago either.)` };
    }
    return `Pyth's archive did not serve ETH/USD's one-second update from a minute ago, so its lack of a settlement update is not believed: try again later, or pass storedPrice: "always" to settle at the stored price anyway`;
  };
  let withheld: string | null = null;
  if (storedOpen) {
    withheld = await withholdStoredPrice();
    if (withheld === null) {
      const plan = await settle({ under: "storedPrice", build: async () => ({ updates: [], prints: [], fee: 0n }) });
      if (plan) return plan;
    }
  }

  let reason = attempts.map((a) => `Under ${UNDER_TEXT[a.under]}: ${a.reason}`).join(" ") || "No settlement updates are available yet.";
  let retryAt: number | null = null;
  if (rule.key === "awaitVerdict") {
    reason += ` The vote waits for UMA's verdict on its claim until ${timeText(rule.verdictDeadline!)}.`;
    retryAt = rule.verdictDeadline;
  } else if (lastResort !== null && now <= lastResort) {
    reason += ` The stored-price fallback opens after ${timeText(lastResort)}.`;
    retryAt = lastResort + 1;
  }
  if (withheld !== null) reason += ` The stored-price fallback is open but not offered: ${withheld}.`;
  return { ...base, call: null, under: null, updates: [], prints: [], settlementPrice: null, attempts, reason, retryAt, storedPriceWithheld: withheld };
}

/** A settlement price (BAZAAR precision) as a decimal, exactly. */
const priceText = (price: bigint) => formatDecimal(price, 18);

/** The chain rule's last resort (BazaarPairTerminator._insurerSettlementBounds): 21 days after the cutoff, or 12 hours after a capping UMA cutoff when sooner. */
export function chainLastResort(cutoff: number, umaCutoffCap: number | null): number {
  let lr = cutoff + ORACLE_DEAD_THRESHOLD;
  if (umaCutoffCap !== null && umaCutoffCap < lr - SCHEDULED_TERMINATION_GRACE) lr = umaCutoffCap + SCHEDULED_TERMINATION_GRACE;
  return lr;
}

function scheduledCall(
  ctx: BazaarContext,
  pair: Address,
  from: Address,
  under: SettleUnder,
  updates: readonly Hex[],
  fee: bigint,
  cutoff: number,
  recordsVerdict: boolean,
  /** The price it fixes: the oracle's answer for the updates, or the stored price. */
  price: bigint,
  /** The stored price, when the fallback is open behind a proven set. */
  fallback: bigint | null,
): CostedCall {
  const notes: string[] = [];
  if (under === "tick") {
    notes.push(
      `Settles at ${priceText(price)}: the price in Pyth's one-second update stamped at the cutoff (${cutoff}), which the oracle verified (fetchPriceAtTick, as the terminator calls it).`,
    );
  }
  if (under === "chain") {
    notes.push(
      `Settles at ${priceText(price)}: the median of five Pyth prices chained from the cutoff, each from the earliest one-second update carrying a price generated at least 10 minutes after the update before, which the oracle verified (fetchChainedMedian, as the terminator calls it).`,
    );
  }
  if (under === "storedPrice") notes.push(`Carries no updates: the stored-price fallback is open, so the market settles at its last stored price, ${priceText(price)}.`);
  if (fallback !== null) {
    notes.push(`The stored-price fallback is open: if Pyth refused these updates when the call runs, the market would settle at its stored price (${priceText(fallback)}) instead, and the fee would be refunded.`);
  }
  notes.push("Fixing the price opens the settlement window: positions settle at it, then finalizeTermination opens withdrawals.");
  if (recordsVerdict) notes.push("This call also records UMA's verdict on the claim behind the vote that set the cutoff.");
  return {
    action: "terminateScheduledPair",
    to: ctx.terminator,
    data: T().encode("terminateScheduledPair", pair, updates),
    value: fee,
    from,
    summary:
      fee > 0n
        ? `Fix this market's settlement price at ${priceText(price)} under ${UNDER_TEXT[under]}: pays a ${ethText(fee)} Pyth fee`
        : `Fix this market's settlement price at ${priceText(price)} under ${UNDER_TEXT[under]} (no cost but gas)`,
    costs:
      fee > 0n
        ? [
            {
              kind: "fee",
              label: "Pyth verification fee",
              amount: fee,
              unit: "ETH",
              token: null,
              payee: ctx.oracle,
              returned: "Spent verifying the updates; anything sent beyond it is refunded.",
              contingent: false,
            },
          ]
        : [],
    approvals: [],
    requires: [],
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------------------------

/**
 * Finalize a terminated market (stage 2, on the pair): retires the vault's inherited inventory and
 * freezes the payout ratios, after which every account withdraws collateral × principal ratio plus
 * claim × profit ratio. Anyone may call it once every position has been settled at the fixed price
 * (open interest is zero) or, as the escape hatch, 14 days after the fix; it costs only gas.
 *
 * Refused up front: no settlement price fixed, already finalized, and positions still open before
 * the escape hatch (with the time it opens; settling the remaining positions with `liquidate` opens
 * it sooner).
 */
export async function finalizeTermination(ctx: BazaarContext, args: { pair: Address; from?: Address }): Promise<CostedCall> {
  const pair = asAddress("pair", args.pair);
  const [r, now] = await Promise.all([
    readMany(ctx, [
      { to: pair, codec: P(), fn: "settlementPriceFixedTs" },
      { to: pair, codec: P(), fn: "isPairTerminated" },
      { to: pair, codec: P(), fn: "pairVault" },
    ]),
    chainNow(ctx),
  ]);
  const fixedTs = Number(r[0] as bigint);
  if (fixedTs === 0) throw new InputError("pair", "This market's settlement price is not fixed yet: there is nothing to finalize.");
  if (r[1] as boolean) throw new InputError("pair", "This market is already finalized.");
  const vault = r[2] as { totalLongOI: bigint; totalShortOI: bigint };
  const swept = vault.totalLongOI === 0n && vault.totalShortOI === 0n;
  const hatch = fixedTs + TERMINAL_SETTLEMENT_ESCAPE;
  if (!swept && now < hatch) {
    throw new InputError("pair", `Positions are still open at the settlement price: settle them first (liquidate, tipped $0.05 each), or wait until ${timeText(hatch)}.`);
  }
  return {
    action: "finalizeTermination",
    to: pair,
    data: P().encode("finalizeTermination"),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: "Finalize this market: freezes the payout ratios and opens withdrawals (no cost but gas)",
    costs: [],
    approvals: [],
    requires: [],
    notes: swept
      ? ["Every position is settled, so the payout ratios are exact."]
      : [
          "Positions are still open (the 14-day escape hatch): each settles on its owner's first withdrawal or when anyone settles it; a bankrupt one can lower the ratios for everyone still in.",
        ],
  };
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

/** Decode a terminator log, or null for another contract's. */
export function decodeTerminatorLog(log: RawLog): DecodedLog | null {
  return T().decodeLog(log);
}

/** What each terminator event means, for an activity feed. */
export const TERMINATOR_EVENT_TEXT: Readonly<Record<string, string>> = {
  TerminationProposalSubmitted: "A UMA termination claim was filed; its insurer vote opened with it.",
  TerminationProposalDisputed: "The termination claim was disputed: UMA's voters will decide it.",
  TerminationProposalAccepted: "UMA accepted the termination claim: the market is scheduled to stop at the cutoff UMA verified (or that cutoff caps an insurer schedule's prints).",
  TerminationScheduleRefused: "UMA accepted the claim, but the market refused the schedule; it keeps whatever cutoff it has.",
  TerminationProposalSuperseded: "UMA accepted the claim, but it changed nothing: an earlier cutoff was already in force, or the price was fixed.",
  TerminationProposalRejected: "UMA rejected the termination claim: the market is unchanged.",
  StalePairTerminated: "The market was ended at its last stored price: its oracle had been silent for more than 21 days.",
  SettlementPriceFixed: "The settlement price is fixed: positions settle at it until finalize.",
  InsurerTerminationProposed: "An insurer vote to end the market was opened.",
  InsurerTerminationSnapshot: "The vote's share snapshot was taken: 60% of it must vote yes.",
  InsurerTerminationVoted: "An insurer voted shares to end the market.",
  InsurerTerminationScheduled: "The vote reached 60%: the market is scheduled to stop at its cutoff.",
  InsurerTerminationFailed: "The vote's latch closed without it scheduling the market.",
  InsurerTerminationBondRefundFailed: "The vote's bond could not be refunded to its proposer and went to the insurance fund instead.",
  InsurerTerminationPreempted: "The vote was resolved because the market already had an earlier or equal cutoff, or a fixed price.",
  InsurerTerminationVoided: "The vote was voided: the insurance fund was drained and recapitalized after its snapshot.",
  InsurerTerminationRejected: "UMA rejected the claim behind the vote before it scheduled the market: the vote is over.",
  InsurerTerminationOutcome: "The vote's outcome was stamped as the settlement price was fixed.",
  InsurerLevyCharged: "A yes-voter's redemption forfeited part of their voted shares to the bug bounty address.",
};

/** The proposal ids a proposeTermination or proposeInsurerTermination receipt created. */
export function proposalIdsFromReceipt(ctx: BazaarContext, receipt: Receipt): { assertionId: Hex | null; insurerProposalId: Hex | null } {
  let assertionId: Hex | null = null;
  let insurerProposalId: Hex | null = null;
  for (const lg of receipt.logs) {
    if (getAddress(lg.address) !== ctx.terminator) continue;
    const d = T().decodeLog<{ assertionId?: Hex; id?: Hex }>(lg);
    if (d?.name === "TerminationProposalSubmitted") assertionId = d.args.assertionId ?? null;
    if (d?.name === "InsurerTerminationProposed") insurerProposalId = d.args.id ?? null;
  }
  return { assertionId, insurerProposalId };
}
