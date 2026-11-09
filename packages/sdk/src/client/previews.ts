/**
 * What a trade or a withdrawal will do before it is sent.
 *
 * {@link previewOrder} reads the account's position, the pair's margin rates, the insurance fund's
 * coverage, the account's resting orders and the opposite side of the book, then runs the order
 * through ports of the pair's own arithmetic: the matching walk (MatchingEngineLib._walkTaker), the
 * fee schedule (MatchingEngineLib._computePairFees, RiskParamsLib.getInsuranceFeeRates, the 1%
 * bug-bounty skim of _finalizeTx), the per-fill margin gate (_checkMargin), the position transition
 * (_applyFillCore) and the creation gate (OrderManagementLib._creationShortfall). The integer math is
 * the contract's, so a preview matches the transaction whenever its inputs still hold when it lands.
 * They may not: the call stores a fresh price first, which can move the funding index, the fee rates
 * and (at most once a minute) the margin rates, and other transactions can change the book. So:
 *
 * - exact for the inputs read: fees per fill, the creation gate's requirement, the per-fill margin
 *   verdicts, the resulting position, the account's current state (BazaarPairLens.checkBucketSolvency)
 *   and the withdrawal ceiling (BazaarPairLens.getMaxWithdrawable);
 * - estimates: which makers an order meets (a maker's own margin gate can cancel it mid-walk), when a
 *   resting remainder fills (assumed later, at its limit, as maker), what a trigger order meets when it
 *   fires (assumed at its trigger), and the liquidation price (funding held where it is now). A fill
 *   whose fees exceed what the pair's deposits ledger can fund has its fees waived on-chain; previews
 *   always charge them.
 *
 * The pure functions ({@link simulateOrder}, the fee and margin helpers) take every input explicitly,
 * for a UI that already holds the pair's state.
 */

import type { Address } from "viem";
import { getAddress } from "viem";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import type { Read } from "../chain/client.js";
import {
  BAZAAR_SCALE,
  BP_SCALE,
  EBP_SCALE,
  LIMBO_LEAD,
  MAX_PRICE_STALENESS,
  MAX_WALK_STEPS,
  MIN_ORDER_AMOUNT,
  OrderType,
  STOP_LIMIT,
  STOP_LOSS,
  TAKE_PROFIT,
  TERMINAL_SETTLEMENT_ESCAPE,
  TRIGGER_PRICE_MASK,
  ZERO_ADDRESS,
} from "../constants.js";
import { type BucketState, bucketState, effectiveMmrBp, mulDiv, signedMulDiv, triggerReached } from "../formulas/index.js";
import { userMessage } from "../errors/messages.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import type { CancelReason } from "./history.js";

// ---- Bazaar constants the previews mirror (internal in the contracts, so copied) ----

/** BazaarTypes.MAKER_INSURANCE_FEE_EBP: 0.25 bp, flat. */
export const MAKER_INSURANCE_FEE_EBP = 25n;
/** BazaarTypes.MAKER_INTEGRATOR_FEE_EBP: 0.25 bp, only on orders that carry an integrator. */
export const MAKER_INTEGRATOR_FEE_EBP = 25n;
/** BazaarTypes.TAKER_INTEGRATOR_FEE_EBP: 0.25 bp, only on orders that carry an integrator. */
export const TAKER_INTEGRATOR_FEE_EBP = 25n;
/** RiskParamsLib taker insurance curve: 0.75 bp at the 2% target, 4.25 bp at 10%, x(1 + 49 d^2) below target, 50 bp cap. */
export const TAKER_INSURANCE_FEE_MIN_EBP = 75n;
export const TAKER_INSURANCE_FEE_MAX_EBP = 425n;
export const TAKER_INSURANCE_FEE_MULTIPLIER = 49n;
export const TAKER_INSURANCE_FEE_CAP_EBP = 5_000n;
/** BazaarTypes.INSURANCE_TARGET_BASE / _MAX, in bp of open-interest notional. */
export const INSURANCE_TARGET_BASE_BP = 200n;
export const INSURANCE_TARGET_MAX_BP = 1_000n;
/** BazaarTypes.BUG_BOUNTY_TAX_BP: 1% of the insurance and integrator fee streams. */
export const BUG_BOUNTY_TAX_BP = 100n;
/** BazaarTypes.MAX_SLIPPAGE_BP: 10%. */
export const MAX_SLIPPAGE_BP = 1_000n;
/** BazaarTypes.MAX_PLACEMENT_DEVIATION_BP: a Limit must sit within 50% of the price. */
export const MAX_PLACEMENT_DEVIATION_BP = 5_000n;
/** BazaarTypes.MAX_STALE_DEVIATION_BP: fills under the stale fallback stay within 10% of it. */
export const MAX_STALE_DEVIATION_BP = 1_000n;
/** BazaarTypes.MAX_ACTIVE_LIMIT_ORDERS_PER_USER. */
export const MAX_ACTIVE_LIMIT_ORDERS = 32;

const TIF_GTC = 0;
const TIF_IOC = 1;
const TIF_FOK = 2;

const isTriggerType = (ot: number) => ot === STOP_LIMIT || ot === TAKE_PROFIT || ot === STOP_LOSS;
const isReduceOnly = (ot: number) => ot === TAKE_PROFIT || ot === STOP_LOSS;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// =====================================================================================================
// Fees
// =====================================================================================================

/** RiskParamsLib.getTakerInsuranceFeeBase: the taker's base insurance rate (EBP) at a fund target ratio (bp). */
export function takerInsuranceFeeBase(targetRatioBp: bigint): bigint {
  if (targetRatioBp <= INSURANCE_TARGET_BASE_BP) return TAKER_INSURANCE_FEE_MIN_EBP;
  if (targetRatioBp >= INSURANCE_TARGET_MAX_BP) return TAKER_INSURANCE_FEE_MAX_EBP;
  return (
    TAKER_INSURANCE_FEE_MIN_EBP +
    ((targetRatioBp - INSURANCE_TARGET_BASE_BP) * (TAKER_INSURANCE_FEE_MAX_EBP - TAKER_INSURANCE_FEE_MIN_EBP)) /
      (INSURANCE_TARGET_MAX_BP - INSURANCE_TARGET_BASE_BP)
  );
}

export interface TakerFeeRates {
  /** The dynamic rate risk-adding notional pays (EBP, 1/100 bp). */
  readonly takerEbp: bigint;
  /** The base rate risk-reducing notional pays (EBP). Never above takerEbp. */
  readonly closingEbp: bigint;
}

/**
 * RiskParamsLib.getInsuranceFeeRates from the fund's coverage (free capital over open-interest
 * notional, bp; 2^256-1 with no open interest) and its target ratio (bp), as
 * BazaarPairLens.getInsuranceWithdrawalBudget reports both. At or above target the taker pays the base
 * rate; below it the base is multiplied by 1 + 49 x shortfall^2, capped at 50 bp.
 */
export function takerInsuranceFeeRates(coverageRatioBp: bigint, targetRatioBp: bigint): TakerFeeRates {
  const fBase = takerInsuranceFeeBase(targetRatioBp);
  if (coverageRatioBp >= targetRatioBp || targetRatioBp === 0n) return { takerEbp: fBase, closingEbp: fBase };
  const deficit = ((targetRatioBp - coverageRatioBp) * BP_SCALE) / targetRatioBp;
  const sq = BP_SCALE * BP_SCALE;
  let fee = (fBase * (sq + TAKER_INSURANCE_FEE_MULTIPLIER * deficit * deficit)) / sq;
  if (fee > TAKER_INSURANCE_FEE_CAP_EBP) fee = TAKER_INSURANCE_FEE_CAP_EBP;
  return { takerEbp: fee, closingEbp: fBase };
}

export interface FillFee {
  /** The insurance leg (BAZAAR precision). */
  readonly insurance: bigint;
  /** The integrator leg; 0 when the order carries no integrator. */
  readonly integrator: bigint;
  readonly total: bigint;
}

/**
 * One taker fill's fee (MatchingEngineLib._computePairFees, taker side): the integrator leg at 0.25 bp
 * when the order carries an integrator, and the insurance leg at the dynamic rate, except that the
 * part of the fill that reduces the taker's position pays the closing (base) rate. `position` is the
 * taker's position before this fill.
 */
export function takerFillFee(
  fillSize: bigint,
  fillPrice: bigint,
  orderIsLong: boolean,
  position: { readonly isLong: boolean; readonly size: bigint },
  rates: TakerFeeRates,
  hasIntegrator: boolean,
): FillFee {
  const notional = mulDiv(fillSize, fillPrice, BAZAAR_SCALE);
  const integrator = hasIntegrator ? (notional * TAKER_INTEGRATOR_FEE_EBP) / EBP_SCALE : 0n;
  let insurance: bigint;
  if (position.size === 0n || position.isLong === orderIsLong) {
    insurance = (notional * rates.takerEbp) / EBP_SCALE;
  } else {
    const closingSize = fillSize > position.size ? position.size : fillSize;
    const closingNotional = mulDiv(closingSize, fillPrice, BAZAAR_SCALE);
    insurance = (closingNotional * rates.closingEbp) / EBP_SCALE + ((notional - closingNotional) * rates.takerEbp) / EBP_SCALE;
  }
  return { insurance, integrator, total: insurance + integrator };
}

/** One maker fill's fee: a flat 0.25 bp insurance leg, plus 0.25 bp when the order carries an integrator. */
export function makerFillFee(fillSize: bigint, fillPrice: bigint, hasIntegrator: boolean): FillFee {
  const notional = mulDiv(fillSize, fillPrice, BAZAAR_SCALE);
  const integrator = hasIntegrator ? (notional * MAKER_INTEGRATOR_FEE_EBP) / EBP_SCALE : 0n;
  const insurance = (notional * MAKER_INSURANCE_FEE_EBP) / EBP_SCALE;
  return { insurance, integrator, total: insurance + integrator };
}

export interface FeeBreakdown extends FillFee {
  /** The insurance leg less the bug-bounty skim, credited to the pair's insurance fund. */
  readonly toInsuranceFund: bigint;
  /** The integrator leg less the skim, credited to the integrator's claimable balance. */
  readonly toIntegrator: bigint;
  /** 1% of each leg, credited to the bug-bounty address's claimable balance. */
  readonly toBugBounty: bigint;
}

/**
 * Where a fee goes (MatchingEngineLib._finalizeTx): 1% of the insurance and integrator legs is skimmed
 * to the bug bounty, the rest of the insurance leg to the fund and the rest of the integrator leg to
 * the integrator. The pair skims the walk's totals, so a fill shared with other fills can differ by a
 * unit of the last decimal.
 */
export function feeBreakdown(fee: FillFee): FeeBreakdown {
  const bbIns = mulDiv(fee.insurance, BUG_BOUNTY_TAX_BP, BP_SCALE);
  const bbInt = mulDiv(fee.integrator, BUG_BOUNTY_TAX_BP, BP_SCALE);
  return {
    ...fee,
    toInsuranceFund: fee.insurance - bbIns,
    toIntegrator: mulDiv(fee.integrator, BP_SCALE - BUG_BOUNTY_TAX_BP, BP_SCALE),
    toBugBounty: bbIns + bbInt,
  };
}

// =====================================================================================================
// Positions and margin
// =====================================================================================================

/** A position bucket as the pair stores it (BAZAAR precision; entryFundingIndex signed). */
export interface Bucket {
  readonly isLong: boolean;
  readonly size: bigint;
  readonly entryValue: bigint;
  readonly collateral: bigint;
  readonly entryFundingIndex: bigint;
  readonly takeProfitOrderId?: bigint;
  readonly stopLossOrderId?: bigint;
}

export interface MarginRates {
  /** Initial margin rate (bp). */
  readonly imrBp: bigint;
  /** Maintenance margin rate (bp): half of initial. */
  readonly mmrBp: bigint;
  /** The 24 h lagged maintenance rate (pair.getLaggedMmr); 0 before any sample. */
  readonly laggedMmrBp: bigint;
}

export interface FillResult {
  readonly position: Bucket;
  /** Price PnL of the size closed. */
  readonly realizedPnl: bigint;
  /** Funding settled into collateral on the size closed. */
  readonly settledFunding: bigint;
}

/**
 * MatchingEngineLib._applyFillCore: one fill's effect on a position. The fee comes off collateral; an
 * opposite-side fill closes size at `price`, realizing its PnL and its share of accrued funding into
 * collateral, and a fill larger than the position flips it, opening the rest at `price` and the current
 * funding index. A same-side fill averages the entry funding index by size.
 */
export function applyFill(pos: Bucket, orderIsLong: boolean, fillSize: bigint, price: bigint, fee: bigint, fundingIndex: bigint): FillResult {
  const fillNotional = mulDiv(fillSize, price, BAZAAR_SCALE);
  let collateral = pos.collateral - fee;
  if (pos.size === 0n) {
    return {
      position: { ...pos, isLong: orderIsLong, size: fillSize, entryValue: fillNotional, collateral, entryFundingIndex: fundingIndex },
      realizedPnl: 0n,
      settledFunding: 0n,
    };
  }
  if (pos.isLong === orderIsLong) {
    const newSize = pos.size + fillSize;
    const efi = signedMulDiv(pos.entryFundingIndex * pos.size + fundingIndex * fillSize, 1n, newSize);
    return {
      position: { ...pos, size: newSize, entryValue: pos.entryValue + fillNotional, collateral, entryFundingIndex: efi },
      realizedPnl: 0n,
      settledFunding: 0n,
    };
  }
  const closingSize = fillSize > pos.size ? pos.size : fillSize;
  const closingEntryValue = mulDiv(pos.entryValue, closingSize, pos.size);
  const closingNotional = mulDiv(closingSize, price, BAZAAR_SCALE);
  const realizedPnl = pos.isLong ? closingNotional - closingEntryValue : closingEntryValue - closingNotional;
  const rawFunding = signedMulDiv(fundingIndex - pos.entryFundingIndex, pos.size, BAZAAR_SCALE);
  const fundingPnl = pos.isLong ? -rawFunding : rawFunding;
  const settledFunding = signedMulDiv(fundingPnl, closingSize, pos.size);
  collateral += realizedPnl + settledFunding;
  if (fillSize >= pos.size) {
    const rest = fillSize - pos.size;
    const position: Bucket =
      rest !== 0n
        ? { ...pos, isLong: orderIsLong, size: rest, entryValue: mulDiv(rest, price, BAZAAR_SCALE), collateral, entryFundingIndex: fundingIndex }
        : { ...pos, size: 0n, entryValue: 0n, collateral, entryFundingIndex: 0n };
    return { position, realizedPnl, settledFunding };
  }
  return { position: { ...pos, size: pos.size - fillSize, entryValue: pos.entryValue - closingEntryValue, collateral }, realizedPnl, settledFunding };
}

/** BucketLib.calculateState for a bucket, at the effective maintenance rate. */
export function positionState(pos: Bucket, price: bigint, fundingIndex: bigint, rates: MarginRates): BucketState {
  return bucketState(pos.isLong, pos.size, pos.entryValue, pos.collateral, pos.entryFundingIndex, price, fundingIndex, effectiveMmrBp(rates.mmrBp, rates.laggedMmrBp));
}

/**
 * MatchingEngineLib._checkMargin: whether a fill of `fillSize` at `price` (the maker's limit) passes
 * the account's margin gate at the oracle `mark`. The fee must fit the collateral; then, as the fill
 * would leave the account and counting the held position's unrealized loss but never its gain: an
 * open, add or flip must keep initial margin on the resulting notional (valued at the mark) after the
 * loss a fill above the mark books on fresh exposure; a close must leave non-negative margin, and a
 * partial close that leaves less than initial margin must keep at least the margin-to-maintenance
 * ratio the account had before. A refused fill auto-cancels the order (cancel reason Margin).
 */
export function fillMarginOk(
  pos: Bucket,
  orderIsLong: boolean,
  fillSize: bigint,
  price: bigint,
  fee: bigint,
  mark: bigint,
  fundingIndex: bigint,
  rates: MarginRates,
): boolean {
  const st = positionState(pos, mark, fundingIndex, rates);
  if (pos.collateral < fee) return false;
  let c = pos.collateral - fee;
  const heldLoss = st.totalPnl < 0n ? -st.totalPnl : 0n;
  let fresh: bigint;
  let notional: bigint;
  if (pos.size === 0n) {
    fresh = fillSize;
    notional = mulDiv(fillSize, mark, BAZAAR_SCALE);
  } else if (pos.isLong === orderIsLong) {
    if (heldLoss > c) return false;
    c -= heldLoss;
    fresh = fillSize;
    notional = st.currentNotional + mulDiv(fillSize, mark, BAZAAR_SCALE);
  } else if (fillSize <= pos.size) {
    const closedEntryValue = mulDiv(pos.entryValue, fillSize, pos.size);
    const closedNotional = mulDiv(fillSize, price, BAZAAR_SCALE);
    const realized = pos.isLong ? closedNotional - closedEntryValue : closedEntryValue - closedNotional;
    const closedFunding = signedMulDiv(st.fundingPnl, fillSize, pos.size);
    const remaining = pos.size - fillSize;
    const marginAfter = c + realized + closedFunding - mulDiv(heldLoss, remaining, pos.size);
    if (marginAfter < 0n) return false;
    const remainingNotional = mulDiv(remaining, mark, BAZAAR_SCALE);
    if (marginAfter >= mulDiv(rates.imrBp, remainingNotional, BP_SCALE)) return true;
    const mmr = effectiveMmrBp(rates.mmrBp, rates.laggedMmrBp);
    const requiredAfter = mulDiv(mmr, remainingNotional, BP_SCALE);
    const marginBefore = pos.collateral - heldLoss;
    const requiredBefore = mulDiv(mmr, st.currentNotional, BP_SCALE);
    return marginAfter * requiredBefore >= marginBefore * requiredAfter;
  } else {
    const closedNotional = mulDiv(pos.size, price, BAZAAR_SCALE);
    const realized = pos.isLong ? closedNotional - pos.entryValue : pos.entryValue - closedNotional;
    const postClose = c + realized + st.fundingPnl;
    if (postClose < 0n) return false;
    c = postClose;
    fresh = fillSize - pos.size;
    notional = mulDiv(fresh, mark, BAZAAR_SCALE);
  }
  if (fresh > 0n) {
    let loss = 0n;
    if (orderIsLong && price > mark) loss = mulDiv(fresh, price - mark, BAZAAR_SCALE);
    else if (!orderIsLong && mark > price) loss = mulDiv(fresh, mark - price, BAZAAR_SCALE);
    if (loss > c) return false;
    c -= loss;
  }
  return c >= mulDiv(rates.imrBp, notional, BP_SCALE);
}

/**
 * The estimated liquidation price of a position: where its equity (collateral plus price and funding
 * PnL, funding held at `fundingIndex`) meets the maintenance requirement at the effective rate (the
 * lower of mmrBp and a non-zero lagged rate), as BucketLib.calculateState judges solvency. A long is
 * liquidatable below it, a short above it. null for a flat position, or a long whose collateral covers
 * its whole entry value (no positive price liquidates it); 0 for a short that is insolvent at any price.
 * An estimate: funding keeps accruing and margin rates move.
 */
export function liquidationPrice(pos: Bucket, fundingIndex: bigint, rates: MarginRates): bigint | null {
  if (pos.size === 0n) return null;
  const mmr = effectiveMmrBp(rates.mmrBp, rates.laggedMmrBp);
  const raw = signedMulDiv(fundingIndex - pos.entryFundingIndex, pos.size, BAZAAR_SCALE);
  const funding = pos.isLong ? -raw : raw;
  if (pos.isLong) {
    // collateral + N - entry + funding = mmr x N  =>  N = (entry - collateral - funding) / (1 - mmr)
    if (mmr >= BP_SCALE) return null;
    const owed = pos.entryValue - pos.collateral - funding;
    if (owed <= 0n) return null;
    return ceilDiv(owed * BP_SCALE * BAZAAR_SCALE, (BP_SCALE - mmr) * pos.size);
  }
  // collateral + entry - N + funding = mmr x N  =>  N = (collateral + entry + funding) / (1 + mmr)
  const backing = pos.collateral + pos.entryValue + funding;
  if (backing <= 0n) return 0n;
  return (backing * BP_SCALE * BAZAAR_SCALE) / ((BP_SCALE + mmr) * pos.size);
}

/** The most leverage the pair allows a new position now: 1 / imrBp (25 at a 4% initial margin). */
export function maxLeverage(imrBp: bigint): number | null {
  return imrBp > 0n ? Number(BP_SCALE) / Number(imrBp) : null;
}

/** CollateralLib._worstCaseNotional: the position plus same-side orders, or the opposite orders' overshoot into a flip. */
export function worstCaseNotional(posIsLong: boolean, posNotional: bigint, longExposure: bigint, shortExposure: bigint): bigint {
  const same = posIsLong ? longExposure : shortExposure;
  const opp = posIsLong ? shortExposure : longExposure;
  const worstSame = posNotional + same;
  const worstFlip = opp > posNotional ? opp - posNotional : 0n;
  return worstSame > worstFlip ? worstSame : worstFlip;
}

/**
 * CollateralLib._fillDebitOf: what the fill gate debits for a resting Limit or StopLimit before its
 * margin test, and what creation, amendment and withdrawal therefore reserve on top of initial margin:
 * the loss a fill at the limit books against the mark on fresh exposure (a bid above the mark, an ask
 * below it; a waiting StopLimit against its trigger), plus the maker fee on the limit notional.
 */
export function fillDebit(
  orderType: number,
  isLong: boolean,
  size: bigint,
  limitPrice: bigint,
  triggerPrice: bigint,
  mark: bigint,
  hasIntegrator: boolean,
): bigint {
  if (orderType === OrderType.Market) return 0n;
  const limitNotional = mulDiv(size, limitPrice, BAZAAR_SCALE);
  const refNotional = mulDiv(size, orderType === STOP_LIMIT ? triggerPrice : mark, BAZAAR_SCALE);
  let debit = 0n;
  if (isLong) {
    if (limitNotional > refNotional) debit = limitNotional - refNotional;
  } else if (refNotional > limitNotional) {
    debit = refNotional - limitNotional;
  }
  const ebp = MAKER_INSURANCE_FEE_EBP + (hasIntegrator ? MAKER_INTEGRATOR_FEE_EBP : 0n);
  return debit + mulDiv(limitNotional, ebp, EBP_SCALE);
}

/** A live resting order as the reservation reads it. */
export interface RestingOrder {
  readonly orderType: number;
  readonly isLong: boolean;
  /** Unfilled size. */
  readonly remaining: bigint;
  readonly limitPrice: bigint;
  readonly triggerPrice: bigint;
  /** An armed StopLimit sits in the book and is reserved as the Limit it now is. */
  readonly inBook: boolean;
  readonly integrator: Address;
}

export interface RestingReserve {
  /** Notional the long orders are reserved at. */
  readonly longExposure: bigint;
  readonly shortExposure: bigint;
  /** The fill gate's debit summed over both sides. */
  readonly fillDebit: bigint;
}

/**
 * CollateralLib._sweepRestingReserve: the account's live orders reserved at `mark`. A bid at the mark,
 * an ask at the larger of its limit and the mark, a waiting StopLimit at the largest of its trigger,
 * its limit and the mark, each with its fill debit. (The pair first tries a cheaper upper bound from
 * its tally and reads the orders only when that bound fails; only the reading refuses, so this is the
 * figure that decides.)
 */
export function restingReserve(ordersLive: readonly RestingOrder[], mark: bigint): RestingReserve {
  let longExposure = 0n;
  let shortExposure = 0n;
  let debit = 0n;
  for (const o of ordersLive) {
    const ot = o.inBook ? OrderType.Limit : o.orderType;
    let valuation = mark;
    if (ot === STOP_LIMIT) {
      valuation = max(max(valuation, o.triggerPrice), o.limitPrice);
    } else if (!o.isLong && o.limitPrice > valuation) {
      valuation = o.limitPrice;
    }
    const notional = mulDiv(o.remaining, valuation, BAZAAR_SCALE);
    if (o.isLong) longExposure += notional;
    else shortExposure += notional;
    debit += fillDebit(ot, o.isLong, o.remaining, o.limitPrice, o.triggerPrice, mark, o.integrator !== ZERO_ADDRESS);
  }
  return { longExposure, shortExposure, fillDebit: debit };
}

export interface CreationGate {
  /** The collateral createOrder requires (BAZAAR precision), or 0 when it does not judge the order. */
  readonly required: bigint;
  readonly ok: boolean;
}

/**
 * OrderManagementLib._creationShortfall: what createOrder requires of the account's collateral. The
 * order is valued at no less than the mark (a Market order at the far slippage bound, a sell Limit at
 * its limit when above the mark, a StopLimit at the largest of trigger, limit and mark); the position it
 * leaves plus the resting orders in whichever direction is worse must be covered at initial margin,
 * together with the fill debit of this order and of every resting one and the held position's
 * unrealized loss. Judged only when the result adds exposure beyond the held position, or when flat.
 * TakeProfit and StopLoss skip the gate.
 */
export function creationGate(
  order: { orderType: number; isLong: boolean; size: bigint; limitPrice: bigint; triggerPrice: bigint; maxSlippageBp: bigint; hasIntegrator: boolean },
  pos: Bucket,
  state: BucketState,
  mark: bigint,
  imrBp: bigint,
  resting: RestingReserve,
): CreationGate {
  if (isReduceOnly(order.orderType)) return { required: 0n, ok: true };
  let exec: bigint;
  if (order.orderType === OrderType.Limit) exec = !order.isLong && order.limitPrice > mark ? order.limitPrice : mark;
  else if (order.orderType === OrderType.Market) exec = (mark * (BP_SCALE + order.maxSlippageBp)) / BP_SCALE;
  else exec = max(max(order.triggerPrice, order.limitPrice), mark);
  const orderNotional = mulDiv(order.size, exec, BAZAAR_SCALE);
  const flat = pos.size === 0n;
  let posNotional: bigint;
  if (flat) posNotional = orderNotional;
  else if (pos.isLong === order.isLong) posNotional = state.currentNotional + orderNotional;
  else if (orderNotional > state.currentNotional) posNotional = orderNotional - state.currentNotional;
  else posNotional = state.currentNotional - orderNotional;
  let posIsLong = flat ? order.isLong : pos.isLong;
  if (!flat && pos.isLong !== order.isLong && orderNotional > state.currentNotional) posIsLong = order.isLong;
  const worst = worstCaseNotional(posIsLong, posNotional, resting.longExposure, resting.shortExposure);
  if (!(worst > state.currentNotional || flat)) return { required: 0n, ok: true };
  let required =
    mulDiv(imrBp, worst, BP_SCALE) +
    resting.fillDebit +
    fillDebit(order.orderType, order.isLong, order.size, order.limitPrice, order.triggerPrice, mark, order.hasIntegrator);
  if (state.totalPnl < 0n) required += -state.totalPnl;
  return { required, ok: pos.collateral >= required };
}

// =====================================================================================================
// Order preview
// =====================================================================================================

/** An order as the preview takes it. Prices and sizes in BAZAAR precision. */
export interface OrderInput {
  /** BazaarTypes.OrderType (default Market). */
  readonly orderType?: number;
  readonly isLong: boolean;
  /** Units of the base asset; a TakeProfit or StopLoss may pass 2^256-1 for "the whole position". */
  readonly size: bigint;
  readonly limitPrice?: bigint;
  /** The trigger price; a keeper bounty packed in the high 128 bits is ignored. */
  readonly triggerPrice?: bigint;
  /** Market, TakeProfit and StopLoss: how far from the oracle price the walk may fill (1 to 1000 bp). */
  readonly maxSlippageBp?: bigint;
  readonly isPostOnly?: boolean;
  /** 0 GTC (default), 1 IOC, 2 FOK. */
  readonly tif?: number;
  /** Defaults to the context's integrator. */
  readonly integrator?: Address | null;
}

/** A resting order on the opposite side of the book, in book order. */
export interface BookMaker {
  readonly orderId: bigint;
  readonly owner: Address;
  readonly price: bigint;
  readonly remaining: bigint;
  readonly expiryBlock: number;
}

export interface SimulateInput {
  readonly order: OrderInput;
  readonly account: Address;
  readonly integrator?: Address;
  readonly bucket: Bucket;
  /** The price the call resolves (the spot of its price update). */
  readonly mark: bigint;
  readonly fundingIndex: bigint;
  readonly rates: MarginRates;
  readonly fees: TakerFeeRates;
  /** Traded 24/7, as opposed to a market with trading hours. */
  readonly continuous: boolean;
  /** The call would resolve the stale fallback: a market with trading hours whose venue is closed. */
  readonly stale?: boolean;
  /** The opposite side of the book, best first. Without it, fills are assumed at `fillPrice`. */
  readonly book?: readonly BookMaker[];
  /** The L2 block the book's expiry is judged at. */
  readonly currentBlock?: number;
  /** The account's resting orders, reserved at the mark (see {@link restingReserve}). */
  readonly resting?: RestingReserve;
  /** How many live orders the account has in its active set (the 32-order cap). */
  readonly activeOrders?: number;
  /** The assumed fill price when no book is given, or for a trigger order that has not fired. */
  readonly fillPrice?: bigint;
  /** The account's state from BazaarPairLens.checkBucketSolvency at `mark`, to use for "before". */
  readonly beforeState?: BucketState;
}

export interface PreviewFill {
  readonly price: bigint;
  readonly size: bigint;
  readonly notional: bigint;
  readonly role: "taker" | "maker";
  readonly fee: FillFee;
  /** A maker fill of the remainder that rests, assumed later at its limit. */
  readonly later: boolean;
  /** Assumed rather than met in the book read (no book, or a trigger that has not fired). */
  readonly assumed: boolean;
}

export interface PositionView {
  readonly isLong: boolean;
  readonly size: bigint;
  readonly entryValue: bigint;
  /** entryValue / size; 0 when flat. */
  readonly entryPrice: bigint;
  readonly collateral: bigint;
  readonly entryFundingIndex: bigint;
  /** Valued at the mark. */
  readonly notional: bigint;
  readonly unrealizedPnl: bigint;
  readonly fundingPnl: bigint;
  readonly equity: bigint;
  /** Maintenance requirement at the effective rate. */
  readonly maintenanceRequired: bigint;
  readonly isSolvent: boolean;
  /** Estimated: see {@link liquidationPrice}. */
  readonly liquidationPrice: bigint | null;
  /** Notional over equity; null when flat or without positive equity. */
  readonly leverage: number | null;
}

/** A reason the contract would refuse the call (or the walk would cancel the order), with its user message. */
export interface PreviewIssue {
  /** The custom error the pair would revert with (its name in the ABI). */
  readonly error: string;
  readonly args: Record<string, unknown>;
  readonly message: string;
  /** For a freeze, when it lifts at the latest, if known (seconds). */
  readonly until?: number | null;
}

export interface OrderPreview {
  readonly before: PositionView;
  /** After everything fills: what fills now, and a resting remainder assumed filled later at its limit. */
  readonly after: PositionView;
  /** After what fills in this transaction only. */
  readonly afterArrival: PositionView;
  readonly fills: readonly PreviewFill[];
  /** Whether a trigger order fires on arrival (its trigger is met at the mark). */
  readonly triggersNow: boolean;
  /** Size that fills in this transaction, and its average price. */
  readonly takerSize: bigint;
  readonly takerAvgPrice: bigint | null;
  /** Size left resting in the book (or waiting outside it, for a trigger order). */
  readonly restingSize: bigint;
  /**
   * Whether the resting remainder would pass its margin gate if it filled at today's mark (null when
   * nothing rests). It is reserved in full at creation, so only a moved price, rate or funding can fail it.
   */
  readonly laterFillOk: boolean | null;
  /** Size canceled at the end of the walk, and why. */
  readonly canceledSize: bigint;
  readonly cancelReason: CancelReason | null;
  readonly realizedPnl: bigint;
  readonly settledFunding: bigint;
  readonly fees: FeeBreakdown;
  /** The order adds exposure: opens a position, adds to it, or flips it. */
  readonly opens: boolean;
  /** The order trades against the held position (a reduce, a close or a flip). */
  readonly reduces: boolean;
  /** The position ends flat. */
  readonly closes: boolean;
  /** The position ends on the other side. */
  readonly flips: boolean;
  readonly margin: {
    readonly imrBp: bigint;
    readonly mmrBp: bigint;
    readonly effectiveMmrBp: bigint;
    /** Initial margin on the resulting position (imrBp of its notional). */
    readonly initialMargin: bigint;
    /** What createOrder requires of collateral (0 when it does not judge this order). */
    readonly requiredCollateral: bigint;
    readonly collateral: bigint;
    readonly ok: boolean;
    /** How much more collateral the order needs; 0 when it passes. */
    readonly shortfall: bigint;
    /**
     * The collateral the resulting position must keep as cash (unrealized profit does not count): the
     * maintenance rate on 24/7 markets, the initial rate on markets with trading hours, whose overnight
     * gaps liquidation cannot interpose across. Withdrawals stop there.
     */
    readonly retainedFloorBp: bigint;
    readonly retainedFloor: bigint;
  };
  readonly maxLeverage: number | null;
  /** Reasons the contract would refuse the order outright. Empty when it would go through. */
  readonly blockers: readonly PreviewIssue[];
}

function issue(error: string, args: Record<string, unknown> = {}, until?: number | null): PreviewIssue {
  return { error, args, message: userMessage(error, args), ...(until !== undefined ? { until } : {}) };
}

function view(pos: Bucket, mark: bigint, fundingIndex: bigint, rates: MarginRates, st?: BucketState): PositionView {
  const s = st ?? positionState(pos, mark, fundingIndex, rates);
  return {
    isLong: pos.isLong,
    size: pos.size,
    entryValue: pos.entryValue,
    entryPrice: pos.size === 0n ? 0n : (pos.entryValue * BAZAAR_SCALE) / pos.size,
    collateral: pos.collateral,
    entryFundingIndex: pos.entryFundingIndex,
    notional: s.currentNotional,
    unrealizedPnl: s.unrealizedPnl,
    fundingPnl: s.fundingPnl,
    equity: s.equity,
    maintenanceRequired: s.minRequiredCollateral,
    isSolvent: s.isSolvent,
    liquidationPrice: liquidationPrice(pos, fundingIndex, rates),
    leverage: pos.size === 0n || s.equity <= 0n ? null : Number(s.currentNotional) / Number(s.equity),
  };
}

/** BazaarMathLib.effectivePrice: a Limit or StopLimit walks to its limit; the others to the oracle +- slippage. */
function walkBound(ot: number, limitPrice: bigint, isLong: boolean, slippageBp: bigint, oracle: bigint): bigint {
  if (ot === OrderType.Limit || ot === STOP_LIMIT) return limitPrice;
  const adj = (oracle * slippageBp) / BP_SCALE;
  return isLong ? oracle + adj : oracle - adj;
}

/**
 * Run an order through the pair's arithmetic with every input given: the validation createOrder
 * applies, its margin gate, the arrival walk against `book` (per-fill fees and margin gates, the
 * position after each fill), and the remainder's disposal. No reads; see {@link previewOrder} for the
 * version that reads the pair.
 */
export function simulateOrder(input: SimulateInput): OrderPreview {
  const o = input.order;
  const ot = o.orderType ?? OrderType.Market;
  if (!Number.isInteger(ot) || ot < 0 || ot > 4) throw new InputError("orderType", "is not an order type");
  const tif = o.tif ?? TIF_GTC;
  if (tif !== TIF_GTC && tif !== TIF_IOC && tif !== TIF_FOK) throw new InputError("tif", "must be GTC (0), IOC (1) or FOK (2)");
  if (o.size <= 0n) throw new InputError("size", "must be more than zero");
  const limitPrice = ot === OrderType.Limit || ot === STOP_LIMIT ? (o.limitPrice ?? 0n) : 0n;
  const triggerPrice = isTriggerType(ot) ? (o.triggerPrice ?? 0n) & TRIGGER_PRICE_MASK : 0n;
  const slippage = ot === OrderType.Market || isReduceOnly(ot) ? (o.maxSlippageBp ?? 0n) : 0n;
  if (limitPrice < 0n || triggerPrice < 0n || slippage < 0n) throw new InputError("price", "cannot be negative");
  const integrator = o.integrator === undefined ? (input.integrator ?? ZERO_ADDRESS) : (o.integrator ?? ZERO_ADDRESS);
  const hasIntegrator = getAddress(integrator) !== ZERO_ADDRESS;
  const { mark, fundingIndex, rates, bucket } = input;
  const resting = input.resting ?? { longExposure: 0n, shortExposure: 0n, fillDebit: 0n };
  const blockers: PreviewIssue[] = [];

  // ---- createOrder's validation, in its order ----
  if (o.isPostOnly && ot !== OrderType.Limit) blockers.push(issue("OrderManagementLib__PostOnlyNotAllowed"));
  if (tif !== TIF_GTC) {
    const typeOk = ot === OrderType.Limit || (tif === TIF_FOK && ot === OrderType.Market);
    if (o.isPostOnly || !typeOk) blockers.push(issue("OrderManagementLib__InvalidTimeInForce"));
  }
  const joinsSet = (ot === OrderType.Limit && tif === TIF_GTC) || ot === STOP_LIMIT;
  if (joinsSet && (input.activeOrders ?? 0) >= MAX_ACTIVE_LIMIT_ORDERS) blockers.push(issue("OrderManagementLib__TooManyActiveLimitOrders"));
  if (ot === OrderType.Limit) {
    if (limitPrice === 0n) blockers.push(issue("OrderManagementLib__ZeroLimitPrice"));
    const lo = (mark * (BP_SCALE - MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
    const hi = (mark * (BP_SCALE + MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
    if (limitPrice !== 0n && (limitPrice < lo || limitPrice > hi)) {
      blockers.push(issue("OrderManagementLib__LimitPriceOutsidePlacementBand", { limitPrice, minPrice: lo, maxPrice: hi }));
    }
  } else if (ot === OrderType.Market || isReduceOnly(ot)) {
    if (isReduceOnly(ot) && triggerPrice === 0n) blockers.push(issue("OrderManagementLib__ZeroTriggerPrice"));
    if (slippage === 0n || slippage > MAX_SLIPPAGE_BP) blockers.push(issue("OrderManagementLib__InvalidSlippage", { maxSlippageBp: slippage }));
  } else {
    if (triggerPrice === 0n) blockers.push(issue("OrderManagementLib__ZeroTriggerPrice"));
    if (limitPrice === 0n) blockers.push(issue("OrderManagementLib__ZeroLimitPrice"));
    if (triggerPrice !== 0n && limitPrice !== 0n && (o.isLong ? limitPrice < triggerPrice : limitPrice > triggerPrice)) {
      blockers.push(issue("OrderManagementLib__StopLimitPriceOnWrongSide"));
    }
  }
  if (isReduceOnly(ot)) {
    if (bucket.size === 0n) blockers.push(issue("OrderManagementLib__NoPositionForTpSl"));
    else if (bucket.isLong === o.isLong) blockers.push(issue("OrderManagementLib__TpSlMustBeOppositeDirection"));
    const existing = ot === TAKE_PROFIT ? bucket.takeProfitOrderId : bucket.stopLossOrderId;
    if (existing !== undefined && existing !== 0n) blockers.push(issue("OrderManagementLib__TpSlOrderAlreadyExists"));
  }
  const capSize = isReduceOnly(ot) ? min(o.size, bucket.size) : o.size;
  {
    const ref = limitPrice > 0n ? limitPrice : triggerPrice > 0n ? triggerPrice : mark;
    const notional = mulDiv(capSize, ref, BAZAAR_SCALE);
    const fullClose = bucket.size > 0n && bucket.isLong !== o.isLong && capSize === bucket.size;
    if (notional < MIN_ORDER_AMOUNT && !fullClose && !(isReduceOnly(ot) && bucket.size === 0n)) {
      blockers.push(issue("OrderManagementLib__NotionalBelowMinimum", { notional, minimum: MIN_ORDER_AMOUNT }));
    }
  }
  const beforeState = input.beforeState ?? positionState(bucket, mark, fundingIndex, rates);
  const gate = creationGate(
    { orderType: ot, isLong: o.isLong, size: o.size, limitPrice, triggerPrice: ot === OrderType.Market ? mark : triggerPrice, maxSlippageBp: slippage, hasIntegrator },
    bucket,
    beforeState,
    mark,
    rates.imrBp,
    resting,
  );
  if (!gate.ok) blockers.push(issue("OrderManagementLib__InsufficientMarginAfterOrder", { marginRatio: bucket.collateral, required: gate.required }));
  if (ot === OrderType.Market && input.stale) blockers.push(issue("MatchingEngineLib__BlockedOracleStale"));

  // ---- the arrival walk ----
  const triggersNow = isTriggerType(ot) && !input.stale && triggerReached(ot, o.isLong, triggerPrice, mark);
  const executesNow = !isTriggerType(ot) || triggersNow;
  const oracle = executesNow ? mark : triggerPrice; // a trigger order not yet fired is previewed at its trigger
  // A firing TP/SL is capped at the position it closes, and closes nothing on a flat or same-side one.
  let remaining = isReduceOnly(ot) ? (bucket.size > 0n && bucket.isLong !== o.isLong ? capSize : 0n) : capSize;
  let pos: Bucket = bucket;
  let realizedPnl = 0n;
  let settledFunding = 0n;
  const fills: PreviewFill[] = [];
  let cancel: CancelReason | null = null;
  if (isReduceOnly(ot) && remaining === 0n) cancel = "PositionClosed";
  const takeFill = (price: bigint, size: bigint, role: "taker" | "maker", later: boolean, assumed: boolean): boolean => {
    const fee = role === "taker" ? takerFillFee(size, price, o.isLong, pos, input.fees, hasIntegrator) : makerFillFee(size, price, hasIntegrator);
    if (!fillMarginOk(pos, o.isLong, size, price, fee.total, oracle, fundingIndex, rates)) return false;
    const r = applyFill(pos, o.isLong, size, price, fee.total, fundingIndex);
    pos = r.position;
    realizedPnl += r.realizedPnl;
    settledFunding += r.settledFunding;
    fills.push({ price, size, notional: mulDiv(size, price, BAZAAR_SCALE), role, fee, later, assumed });
    return true;
  };

  if (input.book && executesNow && remaining > 0n) {
    const bound = walkBound(ot, limitPrice, o.isLong, slippage, oracle);
    const account = getAddress(input.account);
    let nodes = 0;
    for (const m of input.book) {
      if (remaining === 0n) break;
      if (o.isLong ? m.price > bound : m.price < bound) break;
      nodes++;
      if (nodes > MAX_WALK_STEPS) {
        cancel = "StepLimit";
        break;
      }
      if (input.currentBlock !== undefined && m.expiryBlock < input.currentBlock) continue;
      if (input.stale) {
        const hi = (mark * (BP_SCALE + MAX_STALE_DEVIATION_BP)) / BP_SCALE;
        const lo = (mark * (BP_SCALE - MAX_STALE_DEVIATION_BP)) / BP_SCALE;
        if (o.isLong ? m.price > hi : m.price < lo) {
          cancel = "PriceBand";
          break;
        }
        if (o.isLong ? m.price < lo : m.price > hi) continue;
      }
      if (o.isPostOnly) {
        cancel = "PostOnly";
        break;
      }
      if (getAddress(m.owner) === account) {
        cancel = "SelfMatch";
        break;
      }
      const size = min(remaining, m.remaining);
      if (size === 0n) continue;
      if (!takeFill(m.price, size, "taker", false, false)) {
        cancel = "Margin";
        break;
      }
      remaining -= size;
    }
  } else if (remaining > 0n && cancel === null) {
    // No book (or a trigger that has not fired): one assumed fill. A Limit without a book rests,
    // unless it crosses the mark and either a fill price is given or it may not rest (IOC/FOK).
    let price: bigint | null;
    if (ot === OrderType.Limit) {
      const crosses = o.isLong ? limitPrice >= mark : limitPrice <= mark;
      price = !crosses || o.isPostOnly ? null : (input.fillPrice ?? (tif !== TIF_GTC ? limitPrice : null));
    } else {
      price = input.fillPrice ?? (ot === STOP_LIMIT ? limitPrice : isReduceOnly(ot) ? triggerPrice : mark);
    }
    if (price !== null) {
      if (takeFill(price, remaining, "taker", false, true)) remaining = 0n;
      else cancel = "Margin";
    }
  }
  const takerFills = fills.filter((f) => f.role === "taker");
  const takerSize = takerFills.reduce((a, f) => a + f.size, 0n);
  const takerNotional = takerFills.reduce((a, f) => a + f.notional, 0n);
  const posArrival = pos;

  // ---- disposal of the remainder (MatchingEngineLib._disposeRemainder) ----
  let restingSize = 0n;
  let canceledSize = 0n;
  if (remaining > 0n) {
    if (tif === TIF_FOK) {
      blockers.push(issue("MatchingEngineLib__FillOrKillUnfilled", { orderId: 0n, remaining }));
    } else if (isTriggerType(ot) && (cancel !== null || isReduceOnly(ot) || !executesNow)) {
      // a trigger order whose walk stopped keeps its remainder live outside the book
      if (cancel === "PositionClosed") canceledSize = remaining;
      else restingSize = remaining;
    } else if (cancel !== null) {
      canceledSize = remaining;
    } else if (ot === OrderType.Market || tif === TIF_IOC) {
      canceledSize = remaining;
      cancel = "Unfilled";
    } else {
      const notional = mulDiv(remaining, limitPrice, BAZAAR_SCALE);
      const fullClose = posArrival.size > 0n && posArrival.isLong !== o.isLong && remaining === posArrival.size;
      if (notional < MIN_ORDER_AMOUNT && !fullClose) {
        canceledSize = remaining;
        cancel = "BelowMinimum";
      } else {
        restingSize = remaining;
      }
    }
  }
  // A resting Limit or armed StopLimit fills later as maker at its limit (assumed, at today's mark).
  let laterFillOk: boolean | null = null;
  if (restingSize > 0n && (ot === OrderType.Limit || (ot === STOP_LIMIT && executesNow))) {
    laterFillOk = takeFill(limitPrice, restingSize, "maker", true, true);
  }

  const fee = fills.reduce<FillFee>(
    (a, f) => ({ insurance: a.insurance + f.fee.insurance, integrator: a.integrator + f.fee.integrator, total: a.total + f.fee.total }),
    { insurance: 0n, integrator: 0n, total: 0n },
  );
  const after = view(pos, mark, fundingIndex, rates);
  const filledTotal = fills.reduce((a, f) => a + f.size, 0n);
  const wasOpen = bucket.size > 0n;
  const flips = wasOpen && pos.size > 0n && pos.isLong !== bucket.isLong;
  const closes = wasOpen && pos.size === 0n;
  const reduces = wasOpen && bucket.isLong !== o.isLong && filledTotal > 0n;
  const opens = (!wasOpen && pos.size > 0n) || flips || (wasOpen && bucket.isLong === o.isLong && filledTotal > 0n);
  const retainedFloorBp = input.continuous ? rates.mmrBp : rates.imrBp;
  return {
    before: view(bucket, mark, fundingIndex, rates, beforeState),
    after,
    afterArrival: view(posArrival, mark, fundingIndex, rates),
    fills,
    triggersNow,
    takerSize,
    takerAvgPrice: takerSize > 0n ? (takerNotional * BAZAAR_SCALE) / takerSize : null,
    restingSize,
    laterFillOk,
    canceledSize,
    cancelReason: canceledSize > 0n || cancel === "PositionClosed" ? cancel : null,
    realizedPnl,
    settledFunding,
    fees: feeBreakdown(fee),
    opens,
    reduces,
    closes,
    flips,
    margin: {
      imrBp: rates.imrBp,
      mmrBp: rates.mmrBp,
      effectiveMmrBp: effectiveMmrBp(rates.mmrBp, rates.laggedMmrBp),
      initialMargin: mulDiv(rates.imrBp, after.notional, BP_SCALE),
      requiredCollateral: gate.required,
      collateral: bucket.collateral,
      ok: gate.ok,
      shortfall: gate.ok ? 0n : gate.required - bucket.collateral,
      retainedFloorBp,
      retainedFloor: mulDiv(retainedFloorBp, after.notional, BP_SCALE),
    },
    maxLeverage: maxLeverage(rates.imrBp),
    blockers,
  };
}

// =====================================================================================================
// Reading the pair
// =====================================================================================================

/** A price to judge at: the spot (and bracket) of the update the call will carry. */
export interface PriceInput {
  readonly spot: bigint;
  /** spot - confidence: what a long's withdrawal is valued at. */
  readonly low?: bigint;
  /** spot + confidence: what a short's withdrawal is valued at. */
  readonly high?: bigint;
  /** The update's publish time (seconds): on a market with trading hours, an old one means the venue is closed. */
  readonly publishTime?: number;
}

export interface PreviewOptions {
  /** The live price the call will carry. Default: the pair's last stored price. */
  readonly price?: PriceInput;
  /** Walk the current book (default true); false assumes one fill at `fillPrice`. */
  readonly walkBook?: boolean;
  /** The assumed fill price when the book is not walked. */
  readonly fillPrice?: bigint;
}

interface PairReads {
  rates: MarginRates;
  lastUpdateTs: number;
  fundingIndex: bigint;
  stored: { spot: bigint; low: bigint; high: bigint; updateTs: number };
  continuous: boolean;
  adlPending: boolean;
  terminated: boolean;
  settlementFixedTs: number;
  scheduledTs: number;
  bucket: Bucket;
  activeIds: bigint[];
  vault: { ledger: bigint; insurance: bigint; deficit: bigint };
  adlTerminationTs: number;
  now: number;
  block: number;
}

async function batchDecode(ctx: BazaarContext, calls: readonly { read: Read; decode: (d: `0x${string}`) => unknown; what: string }[]): Promise<unknown[]> {
  const res = await ctx.chain.batch(calls.map((c) => c.read));
  return res.map(([ok, data], i) => {
    if (!ok) throw new Error(`reading ${calls[i]!.what} failed`);
    return calls[i]!.decode(data);
  });
}

async function readPair(ctx: BazaarContext, pair: Address, account: Address, extra: { read: Read; decode: (d: `0x${string}`) => unknown; what: string }[] = []) {
  const P = pairCodec();
  const L = lensCodec();
  const p = (fn: string, ...args: unknown[]) => ({ read: { to: pair, data: P.encode(fn, ...args) }, decode: (d: `0x${string}`) => P.decode(fn, d), what: fn });
  const l = (fn: string, ...args: unknown[]) => ({ read: { to: ctx.lens, data: L.encode(fn, ...args) }, decode: (d: `0x${string}`) => L.decode(fn, d), what: fn });
  const [head, values] = await Promise.all([
    ctx.chain.block("latest"),
    batchDecode(ctx, [
      p("marginRequirements"),
      p("getLaggedMmr"),
      p("currentFundingIndex"),
      p("lastPairPrice"),
      p("isContinuouslyTraded"),
      p("isAdlPending"),
      p("isPairTerminated"),
      p("settlementPriceFixedTs"),
      p("scheduledTerminationTs"),
      p("pairVault"),
      l("getPositionBucket", pair, account),
      l("getUserActiveLimitOrders", pair, account),
      l("adlTerminationTs", pair),
      ...extra,
    ]),
  ]);
  const [mr, lagged, fi, lp, cont, adl, term, fixed, sched, vault, bucket, active, adlTs] = values as [
    { imrBp: bigint; mmrBp: bigint; lastUpdateTs: bigint },
    bigint,
    bigint,
    { spotPrice: bigint; updateTs: bigint; lowPrice: bigint; highPrice: bigint },
    boolean,
    boolean,
    boolean,
    bigint,
    bigint,
    { totalCollateralDeposited: bigint; insuranceFundBalance: bigint; deficit: bigint },
    Bucket,
    { orderIds: readonly bigint[] },
    bigint,
  ];
  const reads: PairReads = {
    rates: { imrBp: mr.imrBp, mmrBp: mr.mmrBp, laggedMmrBp: lagged },
    lastUpdateTs: Number(mr.lastUpdateTs),
    fundingIndex: fi,
    stored: { spot: lp.spotPrice, low: lp.lowPrice, high: lp.highPrice, updateTs: Number(lp.updateTs) },
    continuous: cont,
    adlPending: adl,
    terminated: term,
    settlementFixedTs: Number(fixed),
    scheduledTs: Number(sched),
    bucket: {
      isLong: bucket.isLong,
      size: BigInt(bucket.size),
      entryValue: BigInt(bucket.entryValue),
      collateral: BigInt(bucket.collateral),
      entryFundingIndex: BigInt(bucket.entryFundingIndex),
      takeProfitOrderId: BigInt(bucket.takeProfitOrderId ?? 0n),
      stopLossOrderId: BigInt(bucket.stopLossOrderId ?? 0n),
    },
    activeIds: [...active.orderIds],
    vault: { ledger: vault.totalCollateralDeposited, insurance: vault.insuranceFundBalance, deficit: vault.deficit },
    adlTerminationTs: Number(adlTs),
    now: head.timestamp,
    block: head.number,
  };
  return { reads, extra: values.slice(13) };
}

interface RawOrder {
  creator: Address;
  canceledBlock: bigint;
  orderType: number;
  isLong: boolean;
  integrator: Address;
  expiryBlock: bigint;
  inBook: boolean;
  triggerPrice: bigint;
  limitPrice: bigint;
  size: bigint;
  filledSize: bigint;
  filledBlock: bigint;
}

function orderReads(pair: Address, ids: readonly bigint[]) {
  const P = pairCodec();
  return ids.map((id) => ({ read: { to: pair, data: P.encode("orders", id) }, decode: (d: `0x${string}`) => P.decode<RawOrder>("orders", d), what: `orders(${id})` }));
}

/** Whether the call would resolve the stale fallback: a market with trading hours and no fresh price. */
function staleness(continuous: boolean, price: PriceInput | undefined, now: number): boolean | null {
  if (continuous) return false;
  if (!price || price.publishTime === undefined) return null;
  return price.publishTime + MAX_PRICE_STALENESS < now;
}

function pairHalts(r: PairReads): PreviewIssue[] {
  const out: PreviewIssue[] = [];
  if (r.terminated || r.adlPending) out.push(issue("BazaarPair__TradingHalted", {}, r.adlPending && r.adlTerminationTs ? r.adlTerminationTs : null));
  else if (r.scheduledTs !== 0 && r.now + LIMBO_LEAD >= r.scheduledTs) out.push(issue("BazaarPair__PairScheduledForTermination"));
  else if (r.settlementFixedTs !== 0) out.push(issue("BazaarPair__SweepWindowActive", {}, r.settlementFixedTs + TERMINAL_SETTLEMENT_ESCAPE));
  return out;
}

export interface OrderPreviewResult extends OrderPreview {
  /** The price the preview judged at. */
  readonly mark: bigint;
  /** null when it cannot be told without the live price's publish time. */
  readonly venueClosed: boolean | null;
  readonly feeRates: TakerFeeRates & { readonly coverageRatioBp: bigint; readonly targetRatioBp: bigint };
}

/**
 * Preview an order for `account` on `pair`: the resulting position (one net position per market; an
 * order larger than an opposite position flips it), the fills it meets in the current book with each
 * fill's fee, the collateral createOrder requires and whether the account has it, the liquidation
 * price of the result and the leverage the pair allows now, and every reason the pair would refuse it
 * (trading halted, validation, margin). Two batched reads; nothing is sent.
 *
 * Exact from the lens: the current state (checkBucketSolvency), the live resting set
 * (getUserActiveLimitOrders, each order then read for its reservation), and the fund's coverage and
 * target behind the fee rate (getInsuranceWithdrawalBudget). Estimated: everything that depends on the
 * state when the transaction lands (see the module notes).
 */
export async function previewOrder(
  ctx: BazaarContext,
  pair: Address,
  account: Address,
  order: OrderInput,
  opts: PreviewOptions = {},
): Promise<OrderPreviewResult> {
  pair = getAddress(pair);
  account = getAddress(account);
  const L = lensCodec();
  const walk = opts.walkBook !== false;
  const depth = (d: `0x${string}`) => L.decode<{ orderIds: readonly bigint[]; prices: readonly bigint[] }>("getBookDepth", d);
  const extra = walk
    ? [{ read: { to: ctx.lens, data: L.encode("getBookDepth", pair, !order.isLong, 0n, BigInt(MAX_WALK_STEPS + 1)) }, decode: depth, what: "getBookDepth" }]
    : [];
  const { reads: r, extra: ex } = await readPair(ctx, pair, account, extra);
  const mark = opts.price?.spot ?? r.stored.spot;
  if (mark <= 0n) throw new InputError("price", "the pair has no stored price yet: pass the live price");
  const bookIds = walk ? [...(ex[0] as { orderIds: readonly bigint[] }).orderIds] : [];
  const second = await batchDecode(ctx, [
    { read: { to: ctx.lens, data: L.encode("checkBucketSolvency", pair, account, mark) }, decode: (d) => L.decode("checkBucketSolvency", d), what: "checkBucketSolvency" },
    { read: { to: ctx.lens, data: L.encode("getInsuranceWithdrawalBudget", pair, mark) }, decode: (d) => L.decode("getInsuranceWithdrawalBudget", d), what: "getInsuranceWithdrawalBudget" },
    ...orderReads(pair, r.activeIds),
    ...orderReads(pair, bookIds),
  ]);
  const st = second[0] as {
    unrealizedPnl: bigint;
    fundingPnl: bigint;
    totalPnl: bigint;
    currentNotional: bigint;
    minRequiredCollateral: bigint;
    availableEquity: bigint;
    effectiveCollateral: bigint;
    isSolvent: boolean;
  };
  const budget = second[1] as { coverageRatioBp: bigint; targetRatioBp: bigint };
  const activeOrders = second.slice(2, 2 + r.activeIds.length) as RawOrder[];
  const bookOrders = second.slice(2 + r.activeIds.length) as RawOrder[];
  const resting = restingReserve(
    activeOrders.map((x) => ({
      orderType: x.orderType,
      isLong: x.isLong,
      remaining: x.size - x.filledSize,
      limitPrice: x.limitPrice,
      triggerPrice: x.triggerPrice,
      inBook: x.inBook,
      integrator: x.integrator,
    })),
    mark,
  );
  const book: BookMaker[] = bookOrders
    .map((x, i) => ({ orderId: bookIds[i]!, owner: x.creator, price: x.limitPrice, remaining: x.size - x.filledSize, expiryBlock: Number(x.expiryBlock) }))
    .filter((m, i) => bookOrders[i]!.canceledBlock === 0n && bookOrders[i]!.filledBlock === 0n && m.remaining > 0n);
  const fees = takerInsuranceFeeRates(budget.coverageRatioBp, budget.targetRatioBp);
  const venueClosed = staleness(r.continuous, opts.price, r.now);
  const beforeState: BucketState = {
    unrealizedPnl: st.unrealizedPnl,
    fundingPnl: st.fundingPnl,
    totalPnl: st.totalPnl,
    currentNotional: st.currentNotional,
    minRequiredCollateral: st.minRequiredCollateral,
    availableEquity: st.availableEquity,
    equity: st.effectiveCollateral + st.totalPnl,
    isSolvent: st.isSolvent,
  };
  const sim = simulateOrder({
    order,
    account,
    integrator: ctx.integrator,
    bucket: r.bucket,
    mark,
    fundingIndex: r.fundingIndex,
    rates: r.rates,
    fees,
    continuous: r.continuous,
    stale: venueClosed === true,
    ...(walk ? { book } : {}),
    currentBlock: r.block,
    resting,
    activeOrders: r.activeIds.length,
    ...(opts.fillPrice !== undefined ? { fillPrice: opts.fillPrice } : {}),
    beforeState,
  });
  return {
    ...sim,
    blockers: [...pairHalts(r), ...sim.blockers],
    mark,
    venueClosed,
    feeRates: { ...fees, coverageRatioBp: budget.coverageRatioBp, targetRatioBp: budget.targetRatioBp },
  };
}

// =====================================================================================================
// Withdrawal preview
// =====================================================================================================

export interface WithdrawalPreview {
  /**
   * The largest amount withdrawCollateral accepts now (BAZAAR precision), from
   * BazaarPairLens.getMaxWithdrawable at the conservative price (a long at the low edge of the
   * oracle's band, a short at the high edge). 0 while any freeze applies.
   */
  readonly maxWithdrawable: bigint;
  readonly collateral: bigint;
  /** The pair's deposits ledger: no withdrawal may exceed it (CollateralLib__LedgerShortfall). */
  readonly ledgerAvailable: bigint;
  readonly hasPosition: boolean;
  readonly activeOrders: number;
  /** The price the ceiling was computed at; null for an account the pair prices at nothing. */
  readonly priceUsed: bigint | null;
  /** null when it cannot be told without the live price's publish time. */
  readonly venueClosed: boolean | null;
  /** What stops withdrawals now, each with its message and, when known, when it lifts. */
  readonly freezes: readonly PreviewIssue[];
  /** For a requested amount: whether it would go through, and what would refuse it. */
  readonly amount: bigint | null;
  readonly ok: boolean | null;
  readonly blocker: PreviewIssue | null;
  /** After finalize: the lens's terminal entitlement. */
  readonly terminal: {
    readonly collateral: bigint;
    readonly registeredClaim: bigint;
    readonly principalRatio: bigint;
    readonly profitRatio: bigint;
    readonly payout: bigint;
  } | null;
}

/**
 * Preview a collateral withdrawal: the most `account` can withdraw from `pair` now, and the freezes
 * that stop it — ADL pending while it holds a position, a fixed settlement price before finalize (all
 * withdrawals), the limbo before a scheduled cutoff, a closed venue on a market with trading hours (a
 * position holder needs a fresh price), and a deposits ledger short of the request (take what it holds
 * now, the rest once the vault's inventory unwinds). With `amountBazaar`, also whether that amount goes
 * through and, if not, the error the pair would raise. The ceiling is the lens's; which ceiling binds is
 * re-derived here with the pair's arithmetic (an estimate when the price moves before the call lands).
 */
export async function previewWithdrawal(
  ctx: BazaarContext,
  pair: Address,
  account: Address,
  amountBazaar?: bigint,
  opts: { price?: PriceInput } = {},
): Promise<WithdrawalPreview> {
  pair = getAddress(pair);
  account = getAddress(account);
  if (amountBazaar !== undefined && amountBazaar < 0n) throw new InputError("amount", "cannot be negative");
  const L = lensCodec();
  const { reads: r } = await readPair(ctx, pair, account);
  const b = r.bucket;
  const hasPosition = b.size !== 0n;
  const spot = opts.price?.spot ?? r.stored.spot;
  const conservative = !hasPosition ? spot : b.isLong ? (opts.price?.low ?? (opts.price ? spot : r.stored.low)) : (opts.price?.high ?? (opts.price ? spot : r.stored.high));
  const priced = !r.terminated && (hasPosition || r.activeIds.length > 0);
  const second = await batchDecode(ctx, [
    { read: { to: ctx.lens, data: L.encode("getMaxWithdrawable", pair, account, conservative) }, decode: (d) => L.decode<bigint>("getMaxWithdrawable", d), what: "getMaxWithdrawable" },
    ...(r.terminated
      ? [{ read: { to: ctx.lens, data: L.encode("getTerminalEntitlement", pair, account) }, decode: (d: `0x${string}`) => L.decode("getTerminalEntitlement", d), what: "getTerminalEntitlement" }]
      : []),
    ...orderReads(pair, r.activeIds),
  ]);
  const maxWithdrawable = second[0] as bigint;
  const terminal = r.terminated
    ? (second[1] as { collateral: bigint; registeredClaim: bigint; principalRatio: bigint; profitRatio: bigint; payout: bigint })
    : null;
  const activeOrders = second.slice(r.terminated ? 2 : 1) as RawOrder[];
  const venueClosed = staleness(r.continuous, opts.price, r.now);

  const freezes: PreviewIssue[] = [];
  if (r.adlPending && !r.terminated && hasPosition) freezes.push(issue("BazaarPair__WithdrawalsFrozenAdlPending", {}, r.adlTerminationTs || null));
  if (r.settlementFixedTs !== 0 && !r.terminated) freezes.push(issue("BazaarPair__SweepWindowActive", {}, r.settlementFixedTs + TERMINAL_SETTLEMENT_ESCAPE));
  if (!r.terminated && r.scheduledTs !== 0 && r.now + LIMBO_LEAD >= r.scheduledTs) freezes.push(issue("CollateralLib__PairScheduledForTermination"));
  if (priced && r.vault.deficit !== 0n) freezes.push(issue("CollateralLib__WithdrawalBlockedVaultUnhealthy"));
  if (!r.terminated && hasPosition && venueClosed === true) freezes.push(issue("CollateralLib__WithdrawalRequiresFreshPrice"));

  let blocker: PreviewIssue | null = null;
  let ok: boolean | null = null;
  if (amountBazaar !== undefined) {
    if (amountBazaar === 0n) blocker = issue("CollateralLib__ZeroWithdrawalAmount");
    else if (freezes.length) blocker = freezes[0]!;
    else if (amountBazaar > maxWithdrawable) blocker = bindingCeiling(r, activeOrders, conservative, spot, amountBazaar, terminal);
    ok = blocker === null;
  }
  return {
    maxWithdrawable,
    collateral: b.collateral,
    ledgerAvailable: r.vault.ledger,
    hasPosition,
    activeOrders: r.activeIds.length,
    priceUsed: priced ? conservative : null,
    venueClosed,
    freezes,
    amount: amountBazaar ?? null,
    ok,
    blocker,
    terminal,
  };
}

/** Which of withdrawCollateral's ceilings an amount above the lens's maximum runs into, in the order the pair checks them. */
function bindingCeiling(
  r: PairReads,
  live: readonly RawOrder[],
  price: bigint,
  spot: bigint,
  amount: bigint,
  terminal: { collateral: bigint; payout: bigint } | null,
): PreviewIssue {
  const b = r.bucket;
  if (r.terminated) {
    const available = terminal ? terminal.collateral : b.collateral;
    if (amount > available) return issue("CollateralLib__InsufficientCollateral", { amount, available });
    return issue("CollateralLib__LedgerShortfall", { amount, available: r.vault.ledger });
  }
  const reserve = restingReserve(
    live.map((x) => ({ orderType: x.orderType, isLong: x.isLong, remaining: x.size - x.filledSize, limitPrice: x.limitPrice, triggerPrice: x.triggerPrice, inBook: x.inBook, integrator: x.integrator })),
    spot,
  );
  if (b.size === 0n) {
    if (amount > b.collateral) return issue("CollateralLib__InsufficientCollateral", { amount, available: b.collateral });
    const req = mulDiv(r.rates.imrBp, worstCaseNotional(false, 0n, reserve.longExposure, reserve.shortExposure), BP_SCALE) + reserve.fillDebit;
    if (b.collateral - amount < req) return issue("CollateralLib__InsufficientMarginAfterWithdrawal", { amount, available: req });
  } else {
    const st = positionState(b, price, r.fundingIndex, r.rates);
    if (!st.isSolvent) return issue("CollateralLib__InsolventPositionBucket", { availableEquity: st.availableEquity, minRequiredCollateral: st.minRequiredCollateral });
    if (amount > b.collateral) return issue("CollateralLib__InsufficientCollateral", { amount, available: b.collateral });
    const floorBp = r.continuous ? r.rates.mmrBp : r.rates.imrBp;
    const minRetained = mulDiv(floorBp, st.currentNotional, BP_SCALE);
    if (b.collateral - amount < minRetained) return issue("CollateralLib__MustRetainMinimumCollateral", { remaining: b.collateral - amount, minimum: minRetained });
    const imrReq = mulDiv(r.rates.imrBp, worstCaseNotional(b.isLong, st.currentNotional, reserve.longExposure, reserve.shortExposure), BP_SCALE) + reserve.fillDebit;
    if (st.availableEquity < imrReq + amount) return issue("CollateralLib__InsufficientMarginAfterWithdrawal", { amount, available: imrReq });
  }
  if (amount > r.vault.ledger) return issue("CollateralLib__LedgerShortfall", { amount, available: r.vault.ledger });
  // The lens refuses for a reason this preview does not model (e.g. the pair's USDC balance is short of its books).
  return issue("CollateralLib__WithdrawalBlockedVaultUnhealthy");
}
