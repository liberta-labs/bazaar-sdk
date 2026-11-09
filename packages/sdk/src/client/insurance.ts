/**
 * Insurance LP flows on a pair: deposit, the request / lock / pay exit, and the reads a frontend
 * shows an LP (share price, position value, quotes at the live price, the exit's timing and the
 * shared withdrawal budget).
 *
 * Shares are priced at the mark, not the fund's balance, so quote deposits and redemptions at the
 * live price the call will carry: the quotes here compose it from the price source's update as
 * BazaarOracle composes it (trade.ts `livePairPrice`), unless a price is passed. The lens's
 * `getInsuranceSharePrice` / `getInsuranceDepositValue` report the stored mark instead.
 *
 * An exit on a live pair (docs/protocol/insurance.md):
 * 1. `requestInsuranceWithdrawal` starts a 13-day cooldown (filing again replaces the request and
 *    restarts it).
 * 2. The cooldown opens an execution window: 2 days on a pair that trades around the clock, 4 on a
 *    pair with trading hours (whose calls need a fresh price, so only trading hours count).
 * 3. The first `executeInsuranceWithdrawal` in the window LOCKS: it records what the requested shares
 *    are worth and pays nothing.
 * 4. From 5 minutes after the lock (later after a 2% price jump or the end of a price gap of an hour
 *    or more), the next call PAYS the lower of the locked amount and what the shares are worth then,
 *    within the shared 6-hour budget and, while the vault holds liquidated inventory, the fund's
 *    headroom (paying part and leaving the rest requested for a later call in the window).
 * A terminated pair pays in one call after the request. {@link insuranceExitPlan} tells a UI which
 * step an LP is on and when the next call can land.
 */

import { type Address, type Hex, getAddress, toHex } from "viem";
import { lens as lensCodec, pair as pairCodec, terminator as terminatorCodec } from "../chain/codec.js";
import { LIMBO_LEAD } from "../constants.js";
import { InputError, type PreparedCall } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { requirePair } from "./guard.js";
import { DIRECT_META, chainTime, encodePairWrite } from "./signing.js";
import { livePairPrice, optionalUpdate } from "./trade.js";
import { floorToUsdc, formatUnits18 } from "./units.js";

// ---- InsuranceVaultLib constants ----
export const MIN_INSURANCE_DEPOSIT = 5n * 10n ** 18n;
export const MAX_INSURANCE_DEPOSIT = (1n << 128n) - 1n;
export const INSURANCE_WITHDRAWAL_COOLDOWN = 13 * 86_400;
export const INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS = 2 * 86_400;
export const INSURANCE_WITHDRAWAL_WINDOW_SESSION = 4 * 86_400;
/** The paying call opens this long after the lock, and after the last stored 2% price jump. */
export const INSURANCE_WITHDRAWAL_CLAIM_DELAY = 300;
/** ...and this long after the last stored price that ended a gap of an hour or more. */
export const INSURANCE_WITHDRAWAL_REOPEN_CLAIM_DELAY = 1_800;
/** RiskParamsLib.REOPEN_GAP_MIN_STALENESS: a store after this long without one ends a gap. */
export const REOPEN_GAP_MIN_STALENESS = 3_600;
/** TERMINAL_SETTLEMENT_ESCAPE + INSURER_SWEEP_GRACE: the longest exits wait after an escape-hatch finalize. */
const SWEEP_RELEASE_AFTER_FIX = 28 * 86_400;
/** BazaarPairLens.SLOT_REOPEN_GAP_EMA: lastObsTs in bits 0-63, lastJumpTs in bits 192-255. */
const SLOT_REOPEN_GAP_EMA = toHex(107n, { size: 32 });
/**
 * BazaarPairTerminator.PAIR_SLOT_SHARE_EPOCH: the pair's insurance share generation, which has no
 * getter. A drained-fund recap bumps it, and every withdrawal request stamped in an earlier one is
 * void (InsuranceVaultLib reverts `WithdrawalRequestStaleEpoch` on execute).
 */
const SLOT_SHARE_EPOCH = toHex(95n, { size: 32 });

/**
 * A raw `insuranceWithdrawalRequestTs` (`shareEpoch << 64 | timestamp`) against the pair's current
 * share epoch: its timestamp, and whether it is a live request (non-zero, and stamped in this epoch)
 * or a voided one (stamped before a recap).
 */
function requestOf(raw: bigint, epoch: bigint): { ts: number; live: boolean; voided: boolean } {
  const ts = Number(BigInt.asUintN(64, raw));
  const current = raw >> 64n === epoch;
  return { ts, live: ts !== 0 && current, voided: ts !== 0 && !current };
}

const usdc = (v: bigint) => formatUnits18(v, 6);
const shares = (v: bigint) => formatUnits18(v, 6);
const maxU = (1n << 256n) - 1n;

function wait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** BazaarPair.InsuranceVaultLib.claimOpensAt. */
export function claimOpensAt(lockTs: number, lastGapTs: number, lastJumpTs: number): number {
  const opens = Math.max(lockTs, lastJumpTs) + INSURANCE_WITHDRAWAL_CLAIM_DELAY;
  return Math.max(opens, lastGapTs + INSURANCE_WITHDRAWAL_REOPEN_CLAIM_DELAY);
}

export const withdrawalWindowOf = (continuous: boolean) => (continuous ? INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS : INSURANCE_WITHDRAWAL_WINDOW_SESSION);

async function quotePrice(ctx: BazaarContext, pair: Address, price?: bigint): Promise<{ price: bigint; publishTime: number | null }> {
  if (price !== undefined) {
    if (price <= 0n) throw new InputError("price", "A price must be positive.");
    return { price, publishTime: null };
  }
  const live = await livePairPrice(ctx, pair);
  return { price: live.price.spot, publishTime: live.price.publishTime };
}

// ---- writes ----

/**
 * Deposit USDC into the pair's insurance fund for shares priced at the fund's value at the mark.
 * `amount` is BAZAAR precision, floored to whole micro-USDC and pulled from the wallet (approve the
 * pair, or pass `permitData`); at least 5 USDC. The pair reads a price only while its vault holds
 * liquidated inventory, and then needs it fresh; the update is attached whenever a price source is
 * connected (its fee is refunded when unread). Refused while an ADL window is pending, once the pair
 * is terminated or settling, in the seconds before a scheduled cutoff, past 100 deposits in four
 * days, and where the deposit's price would open an ADL window.
 */
export async function depositToInsurance(
  ctx: BazaarContext,
  pair: Address,
  from: Address,
  amount: bigint,
  opts: { withPrice?: boolean; permitData?: Hex } = {},
): Promise<PreparedCall> {
  const floored = floorToUsdc(amount);
  if (floored < MIN_INSURANCE_DEPOSIT) throw new InputError("amount", "The minimum insurance deposit is 5 USDC.");
  if (floored > MAX_INSURANCE_DEPOSIT) throw new InputError("amount", "That amount is too large.");
  pair = await requirePair(ctx, pair);
  const pc = pairCodec();
  const names = ["isAdlPending", "isPairTerminated", "scheduledTerminationTs", "settlementPriceFixedTs", "pairVault"] as const;
  const [res, now] = await Promise.all([ctx.chain.batch(names.map((n) => ({ to: pair, data: pc.encode(n) }))), chainTime(ctx)]);
  if (!res.every(([ok]) => ok)) throw new Error(`could not read ${pair}'s state`);
  const [adl, terminated, scheduled, fixedTs, vault] = res.map(([, d], i) => pc.decode(names[i]!, d)) as [
    boolean,
    boolean,
    bigint,
    bigint,
    { longInv: { size: bigint }; shortInv: { size: bigint } },
  ];
  if (terminated) throw new InputError("pair", "This market has been terminated and takes no new insurance.");
  if (fixedTs !== 0n) throw new InputError("pair", "This market is settling and takes no new insurance.");
  if (scheduled !== 0n && BigInt(now + LIMBO_LEAD) >= scheduled) throw new InputError("pair", "This market is closing for termination and takes no new insurance.");
  if (adl) throw new InputError("pair", "Insurance deposits are paused while this market is deleveraging (ADL).");
  const inventory = vault.longInv.size + vault.shortInv.size;
  const fresh = await optionalUpdate(ctx, pair, opts.withPrice, async () => inventory !== 0n);
  const data = encodePairWrite({ action: "depositToInsurance", amount: floored }, { priceUpdate: fresh.update }, { ...DIRECT_META, permitData: opts.permitData ?? "0x" });
  return {
    action: "depositToInsurance",
    to: pair,
    data,
    value: fresh.fee,
    from: getAddress(from),
    summary: `Deposit ${usdc(floored)} USDC into the insurance fund`,
    ...(fresh.publishTime !== null ? { priceTime: fresh.publishTime } : {}),
    pullsUsdc: floored,
  };
}

/**
 * Request to withdraw `shareAmount` insurance shares: starts the 13-day cooldown, after which the
 * execution window opens (2 days, or 4 on a pair with trading hours). Filing again replaces a
 * pending request and restarts its cooldown, and a lock the earlier request made no longer counts.
 * Moves no USDC.
 */
export async function requestInsuranceWithdrawal(ctx: BazaarContext, pair: Address, from: Address, shareAmount: bigint): Promise<PreparedCall> {
  if (shareAmount <= 0n) throw new InputError("shareAmount", "Enter a number of shares to withdraw.");
  const me = getAddress(from);
  pair = await requirePair(ctx, pair);
  const pc = pairCodec();
  const res = await ctx.chain.batch([
    { to: pair, data: pc.encode("insuranceShares", me) },
    { to: pair, data: pc.encode("insuranceWithdrawalRequestTs", me) },
    { to: pair, data: pc.encode("isContinuouslyTraded") },
    { to: pair, data: pc.encode("extsload", SLOT_SHARE_EPOCH) },
  ]);
  if (!res.every(([ok]) => ok)) throw new Error(`could not read ${me}'s insurance shares on ${pair}`);
  const held = pc.decode<bigint>("insuranceShares", res[0]![1]);
  const pending = requestOf(pc.decode<bigint>("insuranceWithdrawalRequestTs", res[1]![1]), BigInt(pc.decode<Hex>("extsload", res[3]![1]))).live;
  const continuous = pc.decode<boolean>("isContinuouslyTraded", res[2]![1]);
  if (held === 0n) throw new InputError("shareAmount", "You hold no insurance shares on this market.");
  if (shareAmount > held) throw new InputError("shareAmount", `You hold ${shares(held)} shares.`);
  const window = withdrawalWindowOf(continuous) / 86_400;
  return {
    action: "requestInsuranceWithdrawal",
    to: pair,
    data: encodePairWrite({ action: "requestInsuranceWithdrawal", shareAmount }, {}, DIRECT_META),
    value: 0n,
    from: me,
    summary: pending
      ? `Replace your pending withdrawal request with ${shares(shareAmount)} shares (restarts the 13-day cooldown)`
      : `Request to withdraw ${shares(shareAmount)} insurance shares (13-day cooldown, then a ${window}-day window)`,
    pullsUsdc: 0n,
  };
}

/**
 * The next step of a requested withdrawal. On a live pair the first call in the window locks what
 * the shares are worth and pays nothing; the next, once {@link insuranceExitPlan}'s `nextCallAt`
 * has passed, pays (see the module notes). Both need a fresh price. On a terminated pair one call
 * pays and reads no price. Refused here when the plan says no call can land now, with the reason.
 */
export async function executeInsuranceWithdrawal(ctx: BazaarContext, pair: Address, from: Address, opts: { withPrice?: boolean } = {}): Promise<PreparedCall> {
  pair = await requirePair(ctx, pair);
  const plan = await insuranceExitPlan(ctx, pair, from, { quote: false });
  if (plan.step !== "lock" && plan.step !== "claim" && plan.step !== "redeem") throw new InputError("pair", plan.message);
  // A terminated pair ignores the update (and refunds its fee), so none is attached unless asked for.
  const fresh = await optionalUpdate(ctx, pair, plan.step === "redeem" ? (opts.withPrice ?? false) : opts.withPrice, async () => true);
  const summary =
    plan.step === "lock"
      ? `Lock your withdrawal of ${shares(plan.requestedShares)} shares (pays nothing; collect it from ${wait((plan.claimOpensTs ?? plan.now + INSURANCE_WITHDRAWAL_CLAIM_DELAY) - plan.now)} later)`
      : plan.step === "claim"
        ? `Collect your insurance withdrawal (at most ${usdc(plan.lockedAmount ?? 0n)} USDC)`
        : `Redeem ${shares(plan.requestedShares)} insurance shares`;
  return {
    action: "executeInsuranceWithdrawal",
    to: pair,
    data: encodePairWrite({ action: "executeInsuranceWithdrawal" }, { priceUpdate: fresh.update }, DIRECT_META),
    value: fresh.fee,
    from: getAddress(from),
    summary,
    ...(fresh.publishTime !== null ? { priceTime: fresh.publishTime } : {}),
    pullsUsdc: 0n,
  };
}

// ---- reads ----

/** What one share redeems for at the pair's stored mark (BAZAAR precision; 1.0 while no shares exist). */
export async function getInsuranceSharePrice(ctx: BazaarContext, pair: Address): Promise<bigint> {
  const lc = lensCodec();
  return lc.decode<bigint>("getInsuranceSharePrice", await ctx.chain.call(ctx.lens, lc.encode("getInsuranceSharePrice", pair)));
}

/** What `user`'s shares redeem for at the pair's stored mark (BAZAAR precision). */
export async function getInsuranceDepositValue(ctx: BazaarContext, pair: Address, user: Address): Promise<bigint> {
  const lc = lensCodec();
  return lc.decode<bigint>("getInsuranceDepositValue", await ctx.chain.call(ctx.lens, lc.encode("getInsuranceDepositValue", pair, getAddress(user))));
}

/** `user`'s insurance shares (0 for a balance a fund recap wiped). */
export async function insuranceShares(ctx: BazaarContext, pair: Address, user: Address): Promise<bigint> {
  const pc = pairCodec();
  return pc.decode<bigint>("insuranceShares", await ctx.chain.call(pair, pc.encode("insuranceShares", getAddress(user))));
}

export interface InsuranceQuote {
  /** Shares a deposit mints, or USDC (BAZAAR precision) a redemption pays. */
  readonly value: bigint;
  /** The mark it was priced at. */
  readonly price: bigint;
  /** The live update's publish time, or null for a caller-supplied price. */
  readonly publishTime: number | null;
}

/**
 * Shares a deposit of `amount` (BAZAAR precision, floored to micro-USDC as the pair floors it) would
 * mint at the live price (or `price`): `lens.quoteInsuranceDeposit`, the pair's own arithmetic. It
 * ignores the deposit's gates (minimum, pair state, rate limit); 0 where the fund's value is nil.
 */
export async function quoteInsuranceDeposit(ctx: BazaarContext, pair: Address, amount: bigint, opts: { price?: bigint } = {}): Promise<InsuranceQuote> {
  const p = await quotePrice(ctx, pair, opts.price);
  const lc = lensCodec();
  const value = lc.decode<bigint>("quoteInsuranceDeposit", await ctx.chain.call(ctx.lens, lc.encode("quoteInsuranceDeposit", pair, floorToUsdc(amount), p.price)));
  return { value, ...p };
}

/**
 * USDC (BAZAAR precision) a redemption of `shareAmount` would pay at the live price (or `price`):
 * `lens.quoteInsuranceWithdrawal`. A locked redemption's paying call pays the lower of this and the
 * locked amount, and while the vault holds inventory no more than the fund's headroom.
 */
export async function quoteInsuranceWithdrawal(ctx: BazaarContext, pair: Address, shareAmount: bigint, opts: { price?: bigint } = {}): Promise<InsuranceQuote> {
  const p = await quotePrice(ctx, pair, opts.price);
  const lc = lensCodec();
  const value = lc.decode<bigint>("quoteInsuranceWithdrawal", await ctx.chain.call(ctx.lens, lc.encode("quoteInsuranceWithdrawal", pair, shareAmount, p.price)));
  return { value, ...p };
}

export interface InsuranceWithdrawalLock {
  /** Whether the current request's first (locking) call has run. */
  readonly isLocked: boolean;
  /** What the requested shares were worth at the lock (BAZAAR precision): the most the paying call pays. */
  readonly lockedAmount: bigint;
  readonly lockTs: number;
  /** When the paying call opens. A later price jump or reopen pushes it back. */
  readonly claimOpensTs: number;
  /** When the request's window closes (0 without a request). */
  readonly windowEndTs: number;
}

/** `lens.getInsuranceWithdrawalLock`: where an LP's two execute calls stand. */
export async function getInsuranceWithdrawalLock(ctx: BazaarContext, pair: Address, user: Address): Promise<InsuranceWithdrawalLock> {
  const lc = lensCodec();
  const r = lc.decode<{ isLocked: boolean; lockedAmount: bigint; lockTs: bigint; claimOpensTs: bigint; windowEndTs: bigint }>(
    "getInsuranceWithdrawalLock",
    await ctx.chain.call(ctx.lens, lc.encode("getInsuranceWithdrawalLock", pair, getAddress(user))),
  );
  return { isLocked: r.isLocked, lockedAmount: r.lockedAmount, lockTs: Number(r.lockTs), claimOpensTs: Number(r.claimOpensTs), windowEndTs: Number(r.windowEndTs) };
}

export interface InsuranceWithdrawalBudget {
  /** What the current 6-hour period still admits, BAZAAR precision (shared by every LP). */
  readonly remaining: bigint;
  /** The period's budget. */
  readonly cap: bigint;
  /** When the period ends and the budget refills; null when the pair is not rate-limited. */
  readonly resetsAt: number | null;
  /** No limit applies: the pair is terminated or has no open interest. */
  readonly unlimited: boolean;
  /** Free capital over open-interest notional, bp. */
  readonly coverageRatioBp: bigint;
  /** The live target ratio, bp: below it the stricter budget applies. */
  readonly targetRatioBp: bigint;
  readonly price: bigint;
}

/**
 * `lens.getInsuranceWithdrawalBudget` at the live price (or `price`): the number a paying call is
 * checked against, as of now. A reading, not a reservation: every LP draws on it, at the paying call.
 */
export async function getInsuranceWithdrawalBudget(ctx: BazaarContext, pair: Address, opts: { price?: bigint } = {}): Promise<InsuranceWithdrawalBudget> {
  const p = await quotePrice(ctx, pair, opts.price);
  const lc = lensCodec();
  const r = lc.decode<{ remaining: bigint; cap: bigint; resetsAt: bigint; coverageRatioBp: bigint; targetRatioBp: bigint }>(
    "getInsuranceWithdrawalBudget",
    await ctx.chain.call(ctx.lens, lc.encode("getInsuranceWithdrawalBudget", pair, p.price)),
  );
  const unlimited = r.cap === maxU;
  return { remaining: r.remaining, cap: r.cap, resetsAt: unlimited ? null : Number(r.resetsAt), unlimited, coverageRatioBp: r.coverageRatioBp, targetRatioBp: r.targetRatioBp, price: p.price };
}

export interface InsuranceWithdrawalConstants {
  readonly cooldown: number;
  readonly continuousWindow: number;
  readonly sessionWindow: number;
  readonly rateLimitPeriod: number;
  readonly rateLimitBp: bigint;
  readonly aboveTargetRateLimitBp: bigint;
  readonly aboveTargetFundCapBp: bigint;
  readonly belowTargetFundCapBp: bigint;
}

/** `lens.getInsuranceWithdrawalConstants`: durations in seconds, budget terms in bp. */
export async function getInsuranceWithdrawalConstants(ctx: BazaarContext): Promise<InsuranceWithdrawalConstants> {
  const lc = lensCodec();
  const r = lc.decode<Record<keyof InsuranceWithdrawalConstants, bigint>>(
    "getInsuranceWithdrawalConstants",
    await ctx.chain.call(ctx.lens, lc.encode("getInsuranceWithdrawalConstants")),
  );
  return {
    cooldown: Number(r.cooldown),
    continuousWindow: Number(r.continuousWindow),
    sessionWindow: Number(r.sessionWindow),
    rateLimitPeriod: Number(r.rateLimitPeriod),
    rateLimitBp: r.rateLimitBp,
    aboveTargetRateLimitBp: r.aboveTargetRateLimitBp,
    aboveTargetFundCapBp: r.aboveTargetFundCapBp,
    belowTargetFundCapBp: r.belowTargetFundCapBp,
  };
}

// ---- the exit plan ----

/**
 * Where an LP's exit stands:
 * - `none`: no shares and no request.
 * - `request`: no request yet, or only one stamped before a fund recap bumped the share epoch, which
 *   the pair voids; next call requestInsuranceWithdrawal (on a terminated pair it then pays at once).
 * - `cooldown`: requested; the window opens at `nextCallAt`.
 * - `lock`: the window is open; the next execute locks (pays nothing).
 * - `waitClaim`: locked; the paying call opens at `nextCallAt`.
 * - `claim`: locked and open: the next execute pays.
 * - `redeem`: terminated pair: the next execute pays.
 * - `expired`: the window closed, or too little of it is left to lock and claim; request again.
 * - `blocked`: no exit call can land now (settlement window, the cutoff's limbo, the post-finalize
 *   sweep, or shares committed to an insurer vote); `nextCallAt` says when, where known.
 */
export type InsuranceExitStep = "none" | "request" | "cooldown" | "lock" | "waitClaim" | "claim" | "redeem" | "expired" | "blocked";

export interface InsuranceExitPlan {
  readonly step: InsuranceExitStep;
  /** One line for the LP. */
  readonly message: string;
  readonly nextAction: "requestInsuranceWithdrawal" | "executeInsuranceWithdrawal" | null;
  /** Earliest chain time the next call can land (now when it can land now), or null. */
  readonly nextCallAt: number | null;
  /** Latest chain time it can land, or null for no limit. */
  readonly nextCallBy: number | null;
  /** Chain time of this reading. */
  readonly now: number;
  readonly shares: bigint;
  readonly requestedShares: bigint;
  /** Shares committed to insurer votes, which the exit cannot take. */
  readonly lockedForVoting: bigint;
  readonly requestTs: number | null;
  readonly windowOpensTs: number | null;
  readonly windowEndTs: number | null;
  readonly lockTs: number | null;
  readonly lockedAmount: bigint | null;
  readonly claimOpensTs: number | null;
  /** For a lock, claim or redeem step with a price source: what the next paying call would pay at most now. */
  readonly payoutEstimate: bigint | null;
  /** The shared budget left, with a price source (null when unlimited or unknown). */
  readonly budgetRemaining: bigint | null;
  /** Things that can still hold the paying call back, for the UI to show. */
  readonly notes: readonly string[];
}

/**
 * Read where `user`'s insurance exit on `pair` stands and when the next call can land: the request,
 * its cooldown and window, the lock and when its claim opens (BazaarPairLens.getInsuranceWithdrawalLock),
 * the gates that freeze exits, shares locked for voting, and, with a price source, the payout the next
 * paying call could make and the shared budget left. All times are chain time (unix seconds).
 */
export async function insuranceExitPlan(ctx: BazaarContext, pair: Address, user: Address, opts: { quote?: boolean } = {}): Promise<InsuranceExitPlan> {
  const me = getAddress(user);
  const pc = pairCodec();
  const lc = lensCodec();
  const tc = terminatorCodec();
  const reads = [
    { to: pair, data: pc.encode("insuranceShares", me) },
    { to: pair, data: pc.encode("insuranceWithdrawalRequestTs", me) },
    { to: pair, data: pc.encode("insuranceWithdrawalRequestShareAmount", me) },
    { to: pair, data: pc.encode("isPairTerminated") },
    { to: pair, data: pc.encode("isContinuouslyTraded") },
    { to: pair, data: pc.encode("scheduledTerminationTs") },
    { to: pair, data: pc.encode("settlementPriceFixedTs") },
    { to: pair, data: pc.encode("lastPairPrice") },
    { to: pair, data: pc.encode("extsload", SLOT_REOPEN_GAP_EMA) },
    { to: pair, data: pc.encode("pairVault") },
    { to: pair, data: pc.encode("isAdlPending") },
    { to: ctx.lens, data: lc.encode("getInsuranceWithdrawalLock", pair, me) },
    { to: ctx.terminator, data: tc.encode("getLockedShares", pair, me) },
    { to: pair, data: pc.encode("extsload", SLOT_SHARE_EPOCH) },
  ];
  const [res, now] = await Promise.all([ctx.chain.batch(reads), chainTime(ctx)]);
  const need = (i: number) => {
    const [ok, d] = res[i]!;
    if (!ok) throw new Error(`could not read ${me}'s insurance position on ${pair}`);
    return d;
  };
  const held = pc.decode<bigint>("insuranceShares", need(0));
  // A request stamped in an earlier share epoch was voided by a fund recap: the pair refuses to
  // execute it (WithdrawalRequestStaleEpoch), so it is no request at all.
  const request = requestOf(pc.decode<bigint>("insuranceWithdrawalRequestTs", need(1)), BigInt(pc.decode<Hex>("extsload", need(13))));
  const requestTs = request.live ? request.ts : 0;
  const voided = request.voided ? "Your earlier withdrawal request was voided when the insurance fund was recapitalized. " : "";
  const requested = pc.decode<bigint>("insuranceWithdrawalRequestShareAmount", need(2));
  const terminated = pc.decode<boolean>("isPairTerminated", need(3));
  const continuous = pc.decode<boolean>("isContinuouslyTraded", need(4));
  const scheduled = Number(pc.decode<bigint>("scheduledTerminationTs", need(5)));
  const fixedTs = Number(pc.decode<bigint>("settlementPriceFixedTs", need(6)));
  const stored = pc.decode<{ updateTs: bigint }>("lastPairPrice", need(7));
  const gapWord = BigInt(pc.decode<Hex>("extsload", need(8)));
  const vault = pc.decode<{ totalLongOI: bigint; totalShortOI: bigint; longInv: { size: bigint }; shortInv: { size: bigint } }>("pairVault", need(9));
  const adlPending = pc.decode<boolean>("isAdlPending", need(10));
  const lock = lc.decode<{ isLocked: boolean; lockedAmount: bigint; lockTs: bigint; claimOpensTs: bigint; windowEndTs: bigint }>("getInsuranceWithdrawalLock", need(11));
  const [okV, v] = res[12]!;
  const lockedForVoting = okV ? tc.decode<bigint>("getLockedShares", v) : 0n;

  const inventory = vault.longInv.size + vault.shortInv.size;
  const notes: string[] = [];
  const hasRequest = requestTs !== 0;
  const base = {
    now,
    shares: held,
    requestedShares: hasRequest ? requested : 0n,
    lockedForVoting,
    requestTs: hasRequest ? requestTs : null,
    windowOpensTs: null as number | null,
    windowEndTs: null as number | null,
    lockTs: null as number | null,
    lockedAmount: null as bigint | null,
    claimOpensTs: null as number | null,
    payoutEstimate: null as bigint | null,
    budgetRemaining: null as bigint | null,
    notes,
  };
  type Head = Pick<InsuranceExitPlan, "step" | "message" | "nextAction" | "nextCallAt" | "nextCallBy">;
  const out = (p: Head & Partial<Omit<InsuranceExitPlan, keyof Head | "notes">>): InsuranceExitPlan => ({ ...base, ...p, notes });

  if (held === 0n && !hasRequest) {
    return out({ step: "none", message: `${voided}You hold no insurance shares on this market.`, nextAction: null, nextCallAt: null, nextCallBy: null });
  }
  if (hasRequest && requested + lockedForVoting > held) {
    notes.push(`${shares(lockedForVoting)} of your shares back an insurer vote and stay locked until it resolves.`);
  }

  if (terminated) {
    if (!hasRequest) {
      return out({ step: "request", message: `${voided}The market is terminated: request a withdrawal, then redeem it at once.`, nextAction: "requestInsuranceWithdrawal", nextCallAt: now, nextCallBy: null });
    }
    if (vault.totalLongOI !== 0n || vault.totalShortOI !== 0n) {
      const release = fixedTs + SWEEP_RELEASE_AFTER_FIX;
      if (now < release) {
        return out({
          step: "blocked",
          message: `Redemptions wait until every open position is settled (anyone can settle them), or ${wait(release - now)} at most.`,
          nextAction: "executeInsuranceWithdrawal",
          nextCallAt: release,
          nextCallBy: null,
        });
      }
    }
    if (requested + lockedForVoting > held) {
      return out({ step: "blocked", message: notes[0]!, nextAction: "executeInsuranceWithdrawal", nextCallAt: null, nextCallBy: null });
    }
    const est = opts.quote === false ? null : await estimate(ctx, pair, requested, null);
    return out({ step: "redeem", message: `Redeem ${shares(requested)} shares now.`, nextAction: "executeInsuranceWithdrawal", nextCallAt: now, nextCallBy: null, payoutEstimate: est?.payout ?? null });
  }

  if (fixedTs !== 0) {
    return out({ step: "blocked", message: "Insurance withdrawals are frozen while the market settles; they reopen once it is finalized.", nextAction: null, nextCallAt: null, nextCallBy: null });
  }
  if (scheduled !== 0 && now + LIMBO_LEAD >= scheduled) {
    return out({ step: "blocked", message: "The market is closing for termination; withdrawals reopen once it is finalized.", nextAction: null, nextCallAt: null, nextCallBy: null });
  }
  if (!hasRequest) {
    return out({
      step: "request",
      message: `${voided}Request a withdrawal to start the 13-day cooldown; you then have ${withdrawalWindowOf(continuous) / 86_400} days to complete it.`,
      nextAction: "requestInsuranceWithdrawal",
      nextCallAt: now,
      nextCallBy: null,
    });
  }

  const windowOpensTs = requestTs + INSURANCE_WITHDRAWAL_COOLDOWN;
  const windowEndTs = windowOpensTs + withdrawalWindowOf(continuous);
  Object.assign(base, { windowOpensTs, windowEndTs });
  if (!continuous) notes.push("Both execute calls need a fresh price, so on this market they can land only while its venue trades.");
  if (adlPending) notes.push("An ADL window is open: redemptions are refused until it resolves.");
  if (inventory !== 0n) notes.push("The vault holds liquidated inventory: a paying call may pay part of the claim and leave the rest requested for later in the window.");

  if (now > windowEndTs) {
    return out({ step: "expired", message: "Your withdrawal window has closed. Request again to start a new cooldown.", nextAction: "requestInsuranceWithdrawal", nextCallAt: now, nextCallBy: null });
  }
  if (now < windowOpensTs) {
    return out({
      step: "cooldown",
      message: `Your withdrawal's cooldown ends in ${wait(windowOpensTs - now)}; you then have ${wait(windowEndTs - windowOpensTs)} to lock and collect it.`,
      nextAction: "executeInsuranceWithdrawal",
      nextCallAt: windowOpensTs,
      nextCallBy: windowEndTs - INSURANCE_WITHDRAWAL_CLAIM_DELAY,
    });
  }

  if (!lock.isLocked) {
    // The lock is refused when the claim it would open could only open after the window closes.
    const lastGap = Number(BigInt.asUintN(64, gapWord));
    const lastJump = Number(gapWord >> 192n);
    let opens = claimOpensAt(now, lastGap, lastJump);
    // The paying call's own store counts: after an hour without one, the next ends a gap.
    if (now >= Number(stored.updateTs) + REOPEN_GAP_MIN_STALENESS) opens = Math.max(opens, now + INSURANCE_WITHDRAWAL_REOPEN_CLAIM_DELAY);
    if (opens > windowEndTs) {
      return out({ step: "expired", message: "Too little of your window is left to lock and collect a withdrawal. Request again.", nextAction: "requestInsuranceWithdrawal", nextCallAt: now, nextCallBy: null, claimOpensTs: opens });
    }
    const est = opts.quote === false ? null : await estimate(ctx, pair, requested, null);
    return out({
      step: "lock",
      message: `Lock your withdrawal now (it pays nothing); you can collect it ${wait(opens - now)} later, before the window closes in ${wait(windowEndTs - now)}.`,
      nextAction: "executeInsuranceWithdrawal",
      nextCallAt: now,
      nextCallBy: windowEndTs - INSURANCE_WITHDRAWAL_CLAIM_DELAY,
      claimOpensTs: opens,
      payoutEstimate: est?.payout ?? null,
      budgetRemaining: est?.budget ?? null,
    });
  }

  const claimOpensTs = Number(lock.claimOpensTs);
  const locked = { lockTs: Number(lock.lockTs), lockedAmount: lock.lockedAmount, claimOpensTs };
  if (claimOpensTs > windowEndTs) {
    return out({ step: "expired", message: "A price move pushed your collection past the window's end. Request again.", nextAction: "requestInsuranceWithdrawal", nextCallAt: now, nextCallBy: null, ...locked });
  }
  if (requested + lockedForVoting > held) {
    return out({ step: "blocked", message: notes[0]!, nextAction: "executeInsuranceWithdrawal", nextCallAt: null, nextCallBy: windowEndTs, ...locked });
  }
  const est = opts.quote === false ? null : await estimate(ctx, pair, requested, lock.lockedAmount);
  if (now < claimOpensTs) {
    return out({
      step: "waitClaim",
      message: `Locked at ${usdc(lock.lockedAmount)} USDC. You can collect in ${wait(claimOpensTs - now)}, before the window closes in ${wait(windowEndTs - now)}.`,
      nextAction: "executeInsuranceWithdrawal",
      nextCallAt: claimOpensTs,
      nextCallBy: windowEndTs,
      ...locked,
      payoutEstimate: est?.payout ?? null,
      budgetRemaining: est?.budget ?? null,
    });
  }
  return out({
    step: "claim",
    message: `Collect your withdrawal now: up to ${usdc(lock.lockedAmount)} USDC, before the window closes in ${wait(windowEndTs - now)}.`,
    nextAction: "executeInsuranceWithdrawal",
    nextCallAt: now,
    nextCallBy: windowEndTs,
    ...locked,
    payoutEstimate: est?.payout ?? null,
    budgetRemaining: est?.budget ?? null,
  });
}

/** With a price source: min(locked, value at the live price), and the shared budget left. Null without one. */
async function estimate(ctx: BazaarContext, pair: Address, requested: bigint, lockedAmount: bigint | null): Promise<{ payout: bigint; budget: bigint | null } | null> {
  if (!ctx.prices || requested === 0n) return null;
  try {
    const live = await livePairPrice(ctx, pair);
    const [q, b] = await Promise.all([
      quoteInsuranceWithdrawal(ctx, pair, requested, { price: live.price.spot }),
      getInsuranceWithdrawalBudget(ctx, pair, { price: live.price.spot }),
    ]);
    const payout = lockedAmount !== null && lockedAmount < q.value ? lockedAmount : q.value;
    return { payout, budget: b.unlimited ? null : b.remaining };
  } catch {
    return null;
  }
}
