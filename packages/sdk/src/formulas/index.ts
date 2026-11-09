/**
 * Ports of the contract formulas.
 *
 * Each function mirrors the Solidity it names, with the same integer rounding, so the SDK's view of a
 * position or a candidate matches the contract's whenever the inputs match. The chain still decides:
 * the keeper uses these only to pick what to simulate, and frontends only to preview.
 */

import {
  ADL_AUCTION_DURATION,
  ADL_MAX_SCORE,
  BAZAAR_EXPONENT,
  BAZAAR_SCALE,
  BP_SCALE,
  MAX_CONFIDENCE_BP,
  MAX_UINT256,
  REFRESH_BOUNTY_FAST_MIN_INSURANCE,
  REFRESH_BOUNTY_HEARTBEAT,
  REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE,
  REFRESH_BOUNTY_MIN_GAP,
  STOP_LIMIT,
  STOP_LOSS,
  TAKE_PROFIT,
  UNLOAD_BOUNTY_MIN_NOTIONAL,
} from "../constants.js";

const abs = (x: bigint) => (x < 0n ? -x : x);

/** OpenZeppelin Math.mulDiv for non-negative operands: floor(x * y / d). */
export function mulDiv(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}

/** BazaarMathLib.signedMulDiv: (x * y) / d rounded toward zero. */
export function signedMulDiv(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("division by zero");
  if (x === 0n || y === 0n) return 0n;
  const negative = (x < 0n) !== (y < 0n) !== (d < 0n);
  const q = (abs(x) * abs(y)) / abs(d);
  return negative ? -q : q;
}

// ---- BucketLib ----

export interface BucketState {
  readonly unrealizedPnl: bigint;
  readonly fundingPnl: bigint;
  readonly totalPnl: bigint;
  readonly currentNotional: bigint;
  readonly minRequiredCollateral: bigint;
  readonly availableEquity: bigint;
  /** collateral + total PnL, signed */
  readonly equity: bigint;
  readonly isSolvent: boolean;
}

/** BucketLib.effectiveMmrBp: the lower of the current rate and a non-zero lagged one. */
export function effectiveMmrBp(mmrBp: bigint, laggedMmrBp: bigint): bigint {
  return laggedMmrBp !== 0n && laggedMmrBp < mmrBp ? laggedMmrBp : mmrBp;
}

/** BucketLib.calculateState, with `mmrBp` already the effective rate. */
export function bucketState(
  isLong: boolean,
  size: bigint,
  entryValue: bigint,
  collateral: bigint,
  entryFundingIndex: bigint,
  price: bigint,
  fundingIndex: bigint,
  mmrBp: bigint,
): BucketState {
  if (size === 0n) {
    return {
      unrealizedPnl: 0n,
      fundingPnl: 0n,
      totalPnl: 0n,
      currentNotional: 0n,
      minRequiredCollateral: 0n,
      availableEquity: collateral,
      equity: collateral,
      isSolvent: true,
    };
  }
  const notional = mulDiv(size, price, BAZAAR_SCALE);
  const unrealized = isLong ? notional - entryValue : entryValue - notional;
  const rawFunding = signedMulDiv(fundingIndex - entryFundingIndex, size, BAZAAR_SCALE);
  const funding = isLong ? -rawFunding : rawFunding;
  const total = unrealized + funding;
  const equity = collateral + total;
  const available = equity > 0n ? equity : 0n;
  const required = mulDiv(mmrBp, notional, BP_SCALE);
  return {
    unrealizedPnl: unrealized,
    fundingPnl: funding,
    totalPnl: total,
    currentNotional: notional,
    minRequiredCollateral: required,
    availableEquity: available,
    equity,
    isSolvent: available >= required && equity > 0n,
  };
}

/** Equity over the maintenance requirement: below 1 is liquidatable. */
export function marginRatio(state: BucketState): number {
  if (state.minRequiredCollateral === 0n) return state.equity > 0n ? Number.POSITIVE_INFINITY : 0;
  return Number(state.equity) / Number(state.minRequiredCollateral);
}

// ---- trigger predicates ----

/** MatchingEngineLib._triggerReached, inclusive at the trigger. */
export function triggerReached(orderType: number, isLong: boolean, triggerPrice: bigint, price: bigint): boolean {
  if (orderType === TAKE_PROFIT) return isLong ? price <= triggerPrice : price >= triggerPrice;
  if (orderType === STOP_LIMIT || orderType === STOP_LOSS) return isLong ? price >= triggerPrice : price <= triggerPrice;
  return false;
}

// ---- AdlLib ----

/** AdlLib._getAdlScoreThreshold: quadratic decay from ADL_MAX_SCORE to 1 over the auction. */
export function adlThreshold(auctionStartTs: number, now: number): bigint {
  if (auctionStartTs === 0) return MAX_UINT256;
  const elapsed = Math.max(0, now - auctionStartTs);
  if (elapsed >= ADL_AUCTION_DURATION) return 1n;
  const remaining = BigInt(ADL_AUCTION_DURATION - elapsed);
  const d = BigInt(ADL_AUCTION_DURATION);
  return 1n + (ADL_MAX_SCORE * remaining * remaining) / (d * d);
}

/** PnL over the collateral less this window's tagged deposit, floored at 1 (AdlLib._scoreCollateral). */
export function adlScore(totalPnl: bigint, collateral: bigint, windowDeposit: bigint): bigint {
  if (totalPnl <= 0n) return 0n;
  const base = collateral > windowDeposit ? collateral - windowDeposit : 0n;
  return mulDiv(totalPnl, BAZAAR_SCALE, base || 1n);
}

// ---- RiskParamsLib.payRefreshBounty ----

export function refreshBountyGap(inventoryNotional: bigint, freeCapital: bigint): number {
  const fast = inventoryNotional >= UNLOAD_BOUNTY_MIN_NOTIONAL && freeCapital > REFRESH_BOUNTY_FAST_MIN_INSURANCE;
  return fast ? REFRESH_BOUNTY_MIN_GAP : REFRESH_BOUNTY_HEARTBEAT;
}

/** Whether refreshPrice would pay its bounty when it stores a print published at newPublishTs. */
export function refreshBountyDue(
  prevUpdateTs: number,
  newPublishTs: number,
  now: number,
  inventoryNotional: bigint,
  freeCapital: bigint,
): boolean {
  if (newPublishTs <= prevUpdateTs) return false;
  if (now <= prevUpdateTs + refreshBountyGap(inventoryNotional, freeCapital)) return false;
  return freeCapital > REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE;
}

/** The first block time at which the bounty is payable, or null while the fund is too small. */
export function refreshBountyDueAt(prevUpdateTs: number, inventoryNotional: bigint, freeCapital: bigint): number | null {
  if (freeCapital <= REFRESH_BOUNTY_HEARTBEAT_MIN_INSURANCE) return null;
  return prevUpdateTs + refreshBountyGap(inventoryNotional, freeCapital) + 1;
}

// ---- BazaarOracle ----

/**
 * The largest exponent difference {@link convertExponent} takes: 10^77 is the largest power of ten
 * a uint256 holds, so the contract reverts past it (and an unbounded one would stall the caller).
 */
export const MAX_EXPONENT_SHIFT = 77;

/**
 * BazaarMathLib.convertExponent (division truncates toward zero). Throws RangeError when the
 * exponents are not integers or differ by more than {@link MAX_EXPONENT_SHIFT}.
 */
export function convertExponent(value: bigint, fromExpo: number, toExpo: number = BAZAAR_EXPONENT): bigint {
  if (fromExpo === toExpo) return value;
  if (!(Math.abs(toExpo - fromExpo) <= MAX_EXPONENT_SHIFT) || !Number.isInteger(fromExpo) || !Number.isInteger(toExpo)) {
    throw new RangeError(`cannot convert a price from exponent ${fromExpo} to ${toExpo}: they must be integers at most ${MAX_EXPONENT_SHIFT} apart`);
  }
  if (fromExpo < toExpo) {
    const d = 10n ** BigInt(toExpo - fromExpo);
    const q = abs(value) / d;
    return value >= 0n ? q : -q;
  }
  return value * 10n ** BigInt(fromExpo - toExpo);
}

export interface Leg {
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: number;
}

export interface PairPrice {
  readonly spot: bigint;
  readonly low: bigint;
  readonly high: bigint;
  readonly publishTime: number;
  readonly confidenceOk: boolean;
}

export function legConfOk(price: bigint, conf: bigint): boolean {
  return price > 0n && price * MAX_CONFIDENCE_BP >= conf * BP_SCALE;
}

function normalize(leg: Leg): [bigint, bigint, bigint] {
  const spot = convertExponent(leg.price, leg.expo);
  let conf = convertExponent(leg.conf, leg.expo);
  if (conf < 0n) conf = 0n;
  const low = conf >= spot ? 1n : spot - conf;
  return [spot, low, spot + conf];
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** The price BazaarOracle composes from one or two legs, and whether it clears the 2% cap. */
export function pairPrice(legs: readonly Leg[], invertQuote: boolean): PairPrice | null {
  const base = legs[0];
  if (!base || legs.some((l) => l.price <= 0n)) return null;
  const [bSpot, bLow, bHigh] = normalize(base);
  let ok = legConfOk(base.price, base.conf);
  const quote = legs[1];
  if (!quote) return { spot: bSpot, low: bLow, high: bHigh, publishTime: base.publishTime, confidenceOk: ok };
  const [qSpot, qLow, qHigh] = normalize(quote);
  ok = ok && legConfOk(quote.price, quote.conf);
  let spot: bigint, low: bigint, high: bigint;
  if (invertQuote) {
    spot = mulDiv(bSpot, BAZAAR_SCALE, qSpot);
    low = mulDiv(bLow, BAZAAR_SCALE, qHigh);
    high = mulDiv(bHigh, BAZAAR_SCALE, qLow);
  } else {
    spot = mulDiv(bSpot, qSpot, BAZAAR_SCALE);
    low = mulDiv(bLow, qLow, BAZAAR_SCALE);
    high = mulDiv(bHigh, qHigh, BAZAAR_SCALE);
  }
  spot = max(spot, 1n);
  low = max(low, 1n);
  high = max(high, spot);
  const cap = spot * MAX_CONFIDENCE_BP;
  ok = ok && (high - spot) * BP_SCALE <= cap && (spot - low) * BP_SCALE <= cap;
  return { spot, low, high, publishTime: Math.min(base.publishTime, quote.publishTime), confidenceOk: ok };
}
