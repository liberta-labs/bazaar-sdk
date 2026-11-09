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
 * - **Stale oracle** (`terminateStalePair`): no price for 21 days.
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
  LIMBO_LEAD,
  MAX_PRICE_STALENESS,
  ORACLE_DEAD_THRESHOLD,
  SETTLEMENT_SAMPLE_COUNT,
  SETTLEMENT_SAMPLE_SPACING,
  SETTLE_AWAIT_VERDICT,
  SETTLE_CHAIN,
  SETTLE_NOTHING,
  SETTLE_WINDOW,
  TERMINAL_SETTLEMENT_ESCAPE,
  USDC_TO_BAZAAR,
  ZERO_ADDRESS,
} from "../constants.js";
import { InputError, simulate } from "./calls.js";
import { type BazaarContext, ConnectError, type PriceUpdateSource, type SubgraphSource } from "./context.js";
import { pairFeeds, updateFee } from "./feeds.js";
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
/** Under UMA's rule only the precise print settles for this long after the cutoff (or the verdict); then an empty call settles at the stored price (seconds). */
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
  PythContractMigration: 4,
} as const;
export type TerminationCategory = (typeof TerminationCategory)[keyof typeof TerminationCategory];

/** What each category means, condensed from the claim text the terminator writes into UMA's assertion. */
export const TERMINATION_CATEGORY_INFO: Readonly<Record<TerminationCategory, { readonly name: string; readonly description: string }>> = {
  1: {
    name: "Oracle decommission",
    description:
      "The market's Pyth feed (either leg of a composite) has stopped publishing, or is scheduled to be decommissioned or to stop publishing.",
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
    name: "Pyth contract migration",
    description: "The Pyth oracle contract the market reads has been deprecated or is migrating to a new address.",
  },
};

export type SettlementRuleKey = "nothing" | "window" | "chain" | "awaitVerdict";

/** settlementRule's answers, by number. */
export const SETTLEMENT_RULE_KEYS: Readonly<Record<number, SettlementRuleKey>> = {
  [SETTLE_NOTHING]: "nothing",
  [SETTLE_WINDOW]: "window",
  [SETTLE_CHAIN]: "chain",
  [SETTLE_AWAIT_VERDICT]: "awaitVerdict",
};

/** What each settlement rule means. */
export const SETTLEMENT_RULE_TEXT: Readonly<Record<SettlementRuleKey, string>> = {
  nothing: "Nothing to settle: the market has no scheduled cutoff, or its settlement price is already fixed.",
  window:
    "UMA's rule: the market settles at the first Pyth print in the 3 seconds ending at its cutoff, one print per feed leg. Only that print settles it until the grace ends; after that, a call with no print settles at the market's last stored price.",
  chain:
    "The chain rule: the market settles at the median of five Pyth prints chained from its cutoff, each the first published at least 10 minutes after the one before. There is no stored-price fallback until the last resort opens (21 days after the cutoff, or 12 hours after a UMA cutoff that caps the chain).",
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
  readonly categories: Readonly<Record<"oracleDecommission" | "assetCessation" | "structuralChange" | "pythContractMigration", number>>;
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
    "CATEGORY_PYTH_CONTRACT_MIGRATION",
    "OUTCOME_NONE",
    "OUTCOME_TRUE",
    "OUTCOME_FALSE",
    "OUTCOME_UNJUDGED",
    "VERDICT_PENDING",
    "VERDICT_TRUE",
    "VERDICT_FALSE",
    "SETTLE_NOTHING",
    "SETTLE_WINDOW",
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
    categories: { oracleDecommission: n(0), assetCessation: n(1), structuralChange: n(2), pythContractMigration: n(3) },
    outcomes: { none: n(4), true: n(5), false: n(6), unjudged: n(7) },
    verdicts: { pending: n(8), true: n(9), false: n(10) },
    settleRules: { nothing: n(11), window: n(12), chain: n(13), awaitVerdict: n(14) },
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
  /** The first (or only) print's target: the cutoff − 3 s under UMA's rule, the cutoff under the chain rule. */
  readonly firstTarget: number | null;
  /** The latest publish time any print may carry; null when unbounded (a chain no UMA cutoff caps) or not applicable. */
  readonly latestPublishTs: number | null;
  /** After this instant a call with no prints settles at the stored price; null when not applicable or beyond any real time. */
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
    throw new InputError("category", "Choose one of the four grounds: oracle decommission, asset cessation, structural change or Pyth contract migration.");
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
 * End a market whose oracle has been dead for more than 21 days, at its last stored price (or at a
 * nominal price of 1 when it never stored one, aged from its creation). Anyone may call it; it pays
 * nothing and costs only gas. The oracle is read only as a liveness probe: any confidence-cleared
 * Pyth tick newer than 21 days blocks it.
 *
 * Refused up front: an unregistered or fixed market, one whose vote-set cutoff has passed (it settles
 * through terminateScheduledPair), and one whose stored price or Pyth's latest tick is 21 days old or
 * less (with the time it opens).
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
      { to: pair, codec: P(), fn: "baseFeedId" },
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
  const [probe] = await readMany(ctx, [{ to: ctx.oracle, codec: oracleCodec(), fn: "tryReadStalePrice", args: [r[6] as Hex] }], { allowFailure: true });
  const pr = probe as { found: boolean; publishTime: bigint } | undefined;
  const newest = Math.max(asOf, pr?.found ? Number(pr.publishTime) : 0);
  if (now - newest <= ORACLE_DEAD_THRESHOLD) {
    const opens = newest + ORACLE_DEAD_THRESHOLD + 1;
    throw new InputError("pair", `This market's oracle printed within the last ${durationText(ORACLE_DEAD_THRESHOLD)}: the stale-oracle path opens at ${timeText(opens)} if it stays silent.`);
  }
  return {
    action: "terminateStalePair",
    to: ctx.terminator,
    data: T().encode("terminateStalePair", pair),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: "End this market at its last stored price: its oracle has been silent for more than 21 days (no cost but gas)",
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

/** One archived Pyth print offered as settlement evidence. Times are unix seconds. */
export interface SettlementPrint {
  readonly feedId: Hex;
  /** The signed update (one `bytes` element of the call's priceUpdate), carrying this feed. */
  readonly update: Hex;
  readonly publishTime: number;
  /** The publish time of the feed's previous print, signed inside the update; null when the source did not report it. */
  readonly prevPublishTime: number | null;
}

/** The first print at or after `target` for one feed, or null when the archive has none. */
export type PrintFetcher = (feedId: Hex, target: number) => Promise<SettlementPrint | null>;

/** A settlement print that could not be fetched or does not prove itself. */
export class SettlementPrintError extends Error {
  override readonly name = "SettlementPrintError";
  constructor(
    message: string,
    readonly feedId: Hex,
    readonly target: number,
  ) {
    super(message);
  }
}

/**
 * A {@link PrintFetcher} over the context's price source's historical route (`atOrAfter`, Hermes'
 * `/v2/updates/price/{time}`), asking for one feed at a time: each leg's first print is its own,
 * and the chain rule needs exactly one update per leg per sample.
 */
export function printFetcher(source: PriceUpdateSource | null): PrintFetcher {
  if (!source?.atOrAfter) {
    throw new ConnectError("Settling a market at its cutoff needs archived Pyth prints: connect with a price source that serves Hermes' historical route (atOrAfter).");
  }
  const atOrAfter = source.atOrAfter.bind(source);
  return async (feedId, target) => {
    const res = await atOrAfter(target, [feedId]);
    const r = res[0];
    if (!r || r.update.length === 0) return null;
    if (r.update.length !== 1) {
      throw new SettlementPrintError(`The price source returned ${r.update.length} updates for one feed at ${target}; a settlement print is exactly one update per leg.`, feedId, target);
    }
    return { feedId, update: r.update[0]!, publishTime: r.publishTime, prevPublishTime: r.prevPublishTime };
  };
}

/**
 * Why `p` would not settle as the first print at or after `target` published no later than
 * `latest`, or null when it proves itself. The checks mirror what Pyth's parser enforces for the
 * terminator (`parsePriceFeedUpdatesWithConfig` with uniqueness on), so a set that passes them is
 * refused only for reasons the archive cannot show (a guardian set that no longer verifies, a fee):
 *
 * 1. **publishTime ≥ target.** Pyth refuses a print published before the window's start
 *    (minPublishTime). An archive answering a different question (the latest print *before* a
 *    time) would hand back exactly that.
 * 2. **prevPublishTime < target.** This is what makes the print the *first* at or after the target,
 *    and so the only one anybody could submit: the update signs its predecessor's publish time, and
 *    Pyth checks it is earlier than minPublishTime. A print whose predecessor is itself at or after
 *    the target has an earlier qualifying print before it; Pyth refuses it, and accepting it would
 *    let whoever settles choose among prints. When the source does not report prevPublishTime the
 *    check is left to Pyth (the simulation).
 * 3. **publishTime ≤ latest.** Pyth refuses a print after maxPublishTime. Under UMA's rule that is
 *    the cutoff: a first print after it means the 3-second window was empty, and the market can only
 *    settle at its stored price once the grace ends. Under the chain rule it is the UMA cutoff that
 *    caps the chain (`umaCutoffCap`), so a reopen print past an event UMA verified cannot count.
 */
export function settlementPrintProblem(p: SettlementPrint, target: number, latest: number | null): string | null {
  const feed = p.feedId.slice(0, 10);
  if (p.publishTime < target) {
    return `The archive's print for feed ${feed} was published at ${p.publishTime}, before its target ${target}: it is not the first print at or after the target.`;
  }
  if (p.prevPublishTime !== null && p.prevPublishTime >= target) {
    return `Feed ${feed} also printed at ${p.prevPublishTime}, at or after the target ${target}, before the print the archive returned: that print is not the first at or after the target.`;
  }
  if (latest !== null && p.publishTime > latest) {
    return `Feed ${feed}'s first print at or after ${target} was published at ${p.publishTime}, after the latest publish time allowed (${latest}).`;
  }
  return null;
}

/** The first print at or after `target` for `feedId`, checked by {@link settlementPrintProblem}; throws SettlementPrintError when there is none or it does not prove itself. */
export async function firstPrintAtOrAfter(fetch: PrintFetcher, feedId: Hex, target: number, latest: number | null): Promise<SettlementPrint> {
  let p: SettlementPrint | null;
  try {
    p = await fetch(feedId, target);
  } catch (e) {
    if (e instanceof SettlementPrintError) throw e;
    throw new SettlementPrintError(`The price archive could not serve feed ${feedId.slice(0, 10)} at ${target}: ${e instanceof Error ? e.message : String(e)}`, feedId, target);
  }
  if (!p) throw new SettlementPrintError(`The price archive has no print for feed ${feedId.slice(0, 10)} at or after ${target} yet.`, feedId, target);
  const why = settlementPrintProblem(p, target, latest);
  if (why) throw new SettlementPrintError(why, feedId, target);
  return p;
}

/** UMA's rule: one print per leg, each that leg's first at or after `target` (the cutoff − 3 s), published no later than `latest` (the cutoff). */
export async function windowPrints(fetch: PrintFetcher, legs: readonly Hex[], target: number, latest: number): Promise<SettlementPrint[]> {
  return Promise.all(legs.map((leg) => firstPrintAtOrAfter(fetch, leg, target, latest)));
}

/**
 * The chain rule's sample set: `count` samples, the first targeting `firstTarget` (the cutoff), each
 * later one targeting the previous sample's publish time plus `spacing` (for a composite, the later
 * of its two legs'), every print published no later than `latest` when bounded. Ordered sample by
 * sample, legs in `legs` order. The targets depend on the prints, so the samples are fetched in
 * sequence; the legs of one sample in parallel.
 */
export async function chainPrints(
  fetch: PrintFetcher,
  legs: readonly Hex[],
  firstTarget: number,
  latest: number | null,
  count = SETTLEMENT_SAMPLE_COUNT,
  spacing = SETTLEMENT_SAMPLE_SPACING,
): Promise<{ prints: SettlementPrint[]; targets: number[] }> {
  const prints: SettlementPrint[] = [];
  const targets: number[] = [];
  let target = firstTarget;
  for (let k = 0; k < count; k++) {
    targets.push(target);
    const sample = await Promise.all(legs.map((leg) => firstPrintAtOrAfter(fetch, leg, target, latest)));
    prints.push(...sample);
    target = Math.max(...sample.map((p) => p.publishTime)) + spacing;
  }
  return { prints, targets };
}

/** Which rule a terminateScheduledPair call settles under: UMA's window print, the chain's median, or the stored-price last resort. */
export type SettleUnder = "window" | "chain" | "storedPrice";

/** One candidate the builder tried. */
export interface SettlementAttempt {
  readonly under: SettleUnder;
  /** True when the contract accepted it in simulation. */
  readonly ok: boolean;
  /** Why it was not used (a missing or unprovable print, the oracle's or the contract's refusal), or "" when ok. */
  readonly reason: string;
  /** The oracle's or the contract's decoded refusal, when one reverted. */
  readonly error: DecodedError | null;
  /**
   * The price it would fix (BAZAAR precision): what the oracle returned when it verified the prints
   * (fetchFirstPriceAtOrAfter or fetchChainedMedian, called as the terminator calls it), or the
   * stored price for the fallback; null when the prints were not verified.
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
  /** The prints the call carries, in calldata order. */
  readonly prints: readonly SettlementPrint[];
  /**
   * The settlement price the call fixes (BAZAAR precision): the price the oracle returned for its
   * prints, or the market's stored price under `storedPrice`; null when there is no call.
   */
  readonly settlementPrice: bigint | null;
  readonly attempts: readonly SettlementAttempt[];
  /** Why there is no call, for display. */
  readonly reason: string | null;
  /** When to try again, when known (the verdict, the stored-price fallback). */
  readonly retryAt: number | null;
}

const UNDER_TEXT: Readonly<Record<SettleUnder, string>> = {
  window: "UMA's rule (the first print in the 3 seconds before the cutoff)",
  chain: "the chain rule (the median of five chained prints)",
  storedPrice: "the stored price (the last resort is open)",
};

/**
 * Build `terminateScheduledPair(pair, priceUpdate)`: fix a scheduled market's settlement price with
 * archived Pyth prints that prove themselves, fetched for the rule that applies, and simulated as
 * `from` so the returned call is one the contract accepts.
 *
 * It reads `settlementRule(pair)`, then fetches, per leg, the first print at or after each target
 * from the price source's historical route (or `fetchPrint`), checking each with
 * {@link settlementPrintProblem}:
 * - `window` (UMA's rule): one print per leg at or after `firstTarget` (the cutoff − 3 s), published
 *   no later than the cutoff. Fee: `getUpdateFee`.
 * - `chain`: five samples, each target the previous sample's later leg + 600 s, every print no
 *   later than `latestPublishTs` (the UMA cap, when there is one). Fee: `getSampleSetFee`.
 * - A claim-backed vote whose verdict nobody has recorded may settle under either rule, because the
 *   call records the verdict itself (UMA's rule if the DVM upheld the claim, the chain rule if not).
 *   The builder first simulates OOv3's `settleAndGetAssertionResult` (uma's `previewSettlement`) to
 *   see whether and how the DVM ruled, and builds that rule's set (an upheld claim's UMA rule has no
 *   stored-price fallback yet: its grace starts at this recording). When the verdict cannot be
 *   previewed, both sets are built and each is simulated, and the one the contract accepts is
 *   returned. Building the window set here, rather than first recording an upheld verdict on its
 *   own, also avoids starting its 12-hour grace before the print is in hand. (Trying the other
 *   rule's set blindly is avoided once the verdict is known: past a last resort the contract would
 *   accept it by falling back to the stored price, and the call would be mislabelled.)
 * - Past `lastResortTs`, a call with no prints settles at the stored price; it is offered only when no
 *   proven set is available.
 *
 * Every print set is then verified the way the terminator verifies it: an eth_call (as `from`, with
 * the fee) of the pair's oracle's `fetchFirstPriceAtOrAfter` (UMA's rule) or `fetchChainedMedian`
 * (the chain rule), with the arguments the terminator passes. Only a set that call accepts is
 * offered as a proven-print settlement, and the price it returns is shown (`settlementPrice`). This
 * matters once the fallback is open: the terminator then catches a refused set and settles at the
 * stored price instead, so the contract's simulation alone would accept prints Pyth refuses (an
 * expired guardian set, a wrong print) and the call would be labelled with a price it does not fix.
 * A refused set is reported in `attempts`, saying when a call carrying it would settle at the stored
 * price, and the stored-price call (no prints, no fee) is offered in its place when it is open.
 *
 * The call sends the Pyth fee as `value` (any excess is refunded) and pays nothing back; the
 * returned `costs` carry the fee. Refused up front: an unregistered or fixed market, one with no
 * cutoff, and one whose cutoff has not passed yet. Otherwise a plan with `call: null` says why, and
 * when to try again if that is known.
 *
 * @param args.from The account that will send it: the simulation runs as it (the fee is sent as ETH).
 * @param args.fetchPrint Overrides the price source (tests, or a custom archive).
 */
export async function terminateScheduledPair(
  ctx: BazaarContext,
  args: { pair: Address; from: Address; fetchPrint?: PrintFetcher; estimateGas?: boolean },
): Promise<ScheduledSettlementPlan> {
  const pair = asAddress("pair", args.pair);
  const from = asAddress("from", args.from);
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
  const fetch = args.fetchPrint ?? printFetcher(ctx.prices);
  const feeds = await pairFeeds(ctx, pair);

  const base = { pair, now, scheduledTerminationTs: cutoff, rule };
  if (rule.key === "nothing") {
    return { ...base, call: null, under: null, prints: [], settlementPrice: null, attempts: [], reason: rule.meaning, retryAt: null };
  }

  // Which rule the call settles under. settlementRule cannot see a verdict UMA's DVM has reached on
  // the claim behind a vote until someone records it, but the call records it itself and settles
  // under it: UMA's rule for an upheld claim, the chain rule otherwise.
  let rules: ("window" | "chain")[] = rule.key === "window" ? ["window"] : rule.key === "chain" ? ["chain"] : [];
  let windowAt = { target: rule.firstTarget ?? cutoff - MAX_PRICE_STALENESS, latest: rule.latestPublishTs ?? cutoff };
  let chainAt = { first: rule.firstTarget ?? cutoff, latest: rule.latestPublishTs };
  let lastResort = rule.lastResortTs;
  let recordsVerdict = false;
  if (!isZero32(scheduleId)) {
    const vote = toInsurerProposal(scheduleId, await readOne(ctx, ctx.terminator, T(), "insurerProposals", scheduleId), now);
    // Undisputed past its liveness, the claim reads as upheld (UMA's rule) and the call records it.
    if (vote?.claimBacked && vote.verdict === 0 && rule.key === "window") recordsVerdict = true;
    if (vote?.claimBacked && vote.verdict === 0 && rule.key !== "window") {
      const oo = await assertionOracle(ctx, scheduleId, "terminator");
      const st = statusOf(await getAssertion(ctx, oo, scheduleId), now);
      if (rule.key === "awaitVerdict" && st.phase === "liveness") {
        return {
          ...base,
          call: null,
          under: null,
          prints: [],
          settlementPrice: null,
          attempts: [],
          reason: `The vote that set the cutoff waits for UMA's verdict on its claim, which is known when the claim's liveness ends at ${timeText(st.canSettleAt!)}.`,
          retryAt: st.canSettleAt,
        };
      }
      // A disputed claim: simulate settling it to see whether, and how, the DVM has ruled.
      const pv = st.phase === "disputed" ? await previewSettlementOn(ctx, oo, scheduleId, from) : null;
      const capped = cap;
      if (pv?.result === true) {
        // Upheld: UMA's rule at the cutoff, its grace counted from this recording, so no fallback yet.
        rules = ["window"];
        windowAt = { target: cutoff - MAX_PRICE_STALENESS, latest: cutoff };
        lastResort = null;
        recordsVerdict = true;
      } else if (pv?.result === false) {
        rules = ["chain"];
        chainAt = { first: cutoff, latest: capped };
        lastResort = chainLastResort(cutoff, capped);
        recordsVerdict = true;
      } else if (rule.key === "awaitVerdict") {
        // The verdict could not be previewed: build both sets and let the contract say which it takes.
        rules = ["window", "chain"];
        windowAt = { target: cutoff - MAX_PRICE_STALENESS, latest: cutoff };
        chainAt = { first: cutoff, latest: capped };
        lastResort = null;
        recordsVerdict = true;
      }
    }
  }

  type Candidate = { under: SettleUnder; build: () => Promise<{ prints: SettlementPrint[]; fee: bigint }> };
  const candidates: Candidate[] = [];
  if (rules.includes("window")) {
    candidates.push({
      under: "window",
      build: async () => {
        const prints = await windowPrints(fetch, feeds.legs, windowAt.target, windowAt.latest);
        return { prints, fee: await updateFee(ctx, prints.map((p) => p.update)) };
      },
    });
  }
  if (rules.includes("chain")) {
    candidates.push({
      under: "chain",
      build: async () => {
        const { prints } = await chainPrints(fetch, feeds.legs, chainAt.first, chainAt.latest);
        const updates = prints.map((p) => p.update);
        const fee = await readOne<bigint>(ctx, ctx.oracle, oracleCodec(), "getSampleSetFee", feeds.baseFeedId, updates);
        return { prints, fee };
      },
    });
  }
  // Past the last resort an empty call settles at the stored price; offered only after the proven sets.
  if (rules.length === 1 && lastResort !== null && now > lastResort) {
    candidates.push({ under: "storedPrice", build: async () => ({ prints: [], fee: 0n }) });
  }
  // Whether the terminator, given a set the oracle refuses under `under`, settles at the stored price
  // instead of reverting (its try/catch past the grace or the last resort).
  const fallsBack = (under: "window" | "chain"): boolean => {
    if (rules.length === 2) return under === "chain" && now > chainLastResort(cutoff, cap);
    return lastResort !== null && now > lastResort;
  };
  // The oracle call the terminator makes with these prints, with its arguments, as `from` with the fee.
  const U64_MAX = (1n << 64n) - 1n;
  const chainMax = capRaw === 0n || capRaw > U64_MAX ? U64_MAX : capRaw; // _insurerSettlementBounds' latestPublishTs
  const prove = async (under: "window" | "chain", updates: Hex[], fee: bigint): Promise<{ price: bigint } | { why: string; error: DecodedError | null }> => {
    const oc = oracleCodec();
    const fn = under === "window" ? "fetchFirstPriceAtOrAfter" : "fetchChainedMedian";
    const data =
      under === "window"
        ? oc.encode(fn, feeds.baseFeedId, updates, BigInt(cutoff - MAX_PRICE_STALENESS), BigInt(cutoff))
        : oc.encode(fn, feeds.baseFeedId, updates, BigInt(cutoff), chainMax, BigInt(SETTLEMENT_SAMPLE_SPACING), BigInt(SETTLEMENT_SAMPLE_COUNT));
    let ret: Hex;
    try {
      ret = await ctx.chain.call(pairOracle, data, { from, value: fee });
    } catch (e) {
      const rpc = toRpcError(e);
      if (!rpc) throw e;
      const error = decodeError(rpc.revertData);
      // No revert data: the node refused the call itself (say, `from` cannot cover the fee); say what it said.
      return { why: !rpc.revertData || rpc.revertData === "0x" ? rpc.rpcMessage : error.message, error };
    }
    try {
      return { price: oc.decode<bigint>(fn, ret) };
    } catch {
      return { why: "the oracle returned no price", error: null };
    }
  };

  const attempts: SettlementAttempt[] = [];
  for (const c of candidates) {
    let built: { prints: SettlementPrint[]; fee: bigint };
    try {
      built = await c.build();
    } catch (e) {
      if (!(e instanceof SettlementPrintError)) throw e;
      attempts.push({ under: c.under, ok: false, reason: e.message, error: null, price: null });
      continue;
    }
    let price = stored;
    let fallback = false;
    if (c.under !== "storedPrice") {
      fallback = fallsBack(c.under);
      const proof = await prove(c.under, built.prints.map((p) => p.update), built.fee);
      if (!("price" in proof)) {
        const refused = `The oracle would not verify these prints (${proof.why}).`;
        attempts.push({
          under: c.under,
          ok: false,
          reason: fallback
            ? `${refused} The stored-price fallback is open, so a call carrying them would settle at the market's stored price (${priceText(stored)}) instead: they are not offered as a proven settlement.`
            : `${refused} The terminator would refuse them too.`,
          error: proof.error,
          price: null,
        });
        continue;
      }
      price = proof.price;
    }
    const call = scheduledCall(ctx, pair, from, c.under, built.prints, built.fee, cutoff, recordsVerdict, price, fallback ? stored : null);
    const sim = await simulate(ctx, call, { from, estimateGas: args.estimateGas ?? false });
    if (sim.ok) {
      attempts.push({ under: c.under, ok: true, reason: "", error: null, price });
      return { ...base, call, under: c.under, prints: built.prints, settlementPrice: price, attempts, reason: null, retryAt: null };
    }
    attempts.push({ under: c.under, ok: false, reason: `The contract refused it: ${sim.error?.message ?? "reverted"}`, error: sim.error, price });
  }

  let reason = attempts.map((a) => `Under ${UNDER_TEXT[a.under]}: ${a.reason}`).join(" ") || "No settlement prints are available yet.";
  let retryAt: number | null = null;
  if (rule.key === "awaitVerdict") {
    reason += ` The vote waits for UMA's verdict on its claim until ${timeText(rule.verdictDeadline!)}.`;
    retryAt = rule.verdictDeadline;
  } else if (lastResort !== null && now <= lastResort) {
    reason += ` The stored-price fallback opens after ${timeText(lastResort)}.`;
    retryAt = lastResort + 1;
  }
  return { ...base, call: null, under: null, prints: [], settlementPrice: null, attempts, reason, retryAt };
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
  prints: readonly SettlementPrint[],
  fee: bigint,
  cutoff: number,
  recordsVerdict: boolean,
  /** The price it fixes: the oracle's answer for the prints, or the stored price. */
  price: bigint,
  /** The stored price, when the fallback is open behind a proven set. */
  fallback: bigint | null,
): CostedCall {
  const notes: string[] = [];
  if (under === "window") {
    notes.push(
      `Settles at ${priceText(price)}: the first Pyth print in [${cutoff - MAX_PRICE_STALENESS}, ${cutoff}], one per feed leg, which the oracle verified (fetchFirstPriceAtOrAfter, as the terminator calls it).`,
    );
  }
  if (under === "chain") {
    notes.push(
      `Settles at ${priceText(price)}: the median of five Pyth prints chained from the cutoff, each the first at least 10 minutes after the one before, which the oracle verified (fetchChainedMedian, as the terminator calls it).`,
    );
  }
  if (under === "storedPrice") notes.push(`Carries no prints: the stored-price fallback is open, so the market settles at its last stored price, ${priceText(price)}.`);
  if (fallback !== null) {
    notes.push(`The stored-price fallback is open: if Pyth refused these prints when the call runs, the market would settle at its stored price (${priceText(fallback)}) instead, and the fee would be refunded.`);
  }
  notes.push("Fixing the price opens the settlement window: positions settle at it, then finalizeTermination opens withdrawals.");
  if (recordsVerdict) notes.push("This call also records UMA's verdict on the claim behind the vote that set the cutoff.");
  return {
    action: "terminateScheduledPair",
    to: ctx.terminator,
    data: T().encode(
      "terminateScheduledPair",
      pair,
      prints.map((p) => p.update),
    ),
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
              returned: "Spent verifying the prints; anything sent beyond it is refunded.",
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
