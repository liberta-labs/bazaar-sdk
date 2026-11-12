/**
 * Orders: the `OrderSpec` a `createOrder` call carries, built and checked the way the pair checks it,
 * the packing of a trigger order's keeper bounty, amendment id words, and the per-user order caps.
 *
 * Everything here is pure except the two reads at the end ({@link readOrderState},
 * {@link readTriggerBounty}). The checks mirror `OrderManagementLib.createOrder` and
 * `_amendOne` rule for rule, so a frontend can refuse an order before the user signs it; the chain
 * still decides, so simulate before sending.
 *
 * Units: sizes and prices are BAZAAR precision (1e18 = one unit of the base asset, or $1). Bounties
 * are BAZAAR precision too, and must be a whole number of USDC's 6-decimal units (a multiple of 1e12).
 */

import type { Address } from "viem";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import {
  BAZAAR_SCALE,
  BP_SCALE,
  LIMIT,
  MARKET,
  MAX_UINT256,
  MIN_ORDER_AMOUNT,
  ORDER_TYPE_NAMES,
  type OrderType,
  STOP_LIMIT,
  STOP_LOSS,
  TAKE_PROFIT,
  TRIGGER_PRICE_MASK,
  USDC_TO_BAZAAR,
} from "../constants.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { formatUnits18 } from "./units.js";

// ---- BazaarTypes ----

/** BazaarTypes.TimeInForce: what an arriving order does with the size the book could not fill. */
export const TimeInForce = {
  /** Rest the remainder in the book (only Limit and StopLimit rest; the other types ignore it). */
  GTC: 0,
  /** Fill what crosses on arrival, cancel the rest. Limit only. */
  IOC: 1,
  /** Fill the whole size on arrival or revert the transaction. Limit and Market only. */
  FOK: 2,
} as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];
export const TIF_NAMES: Readonly<Record<number, string>> = { 0: "GTC", 1: "IOC", 2: "FOK" };

/** Slippage cap for Market, TakeProfit and StopLoss orders: 10%. */
export const MAX_SLIPPAGE_BP = 1000n;
/** A Limit price must sit within ±50% of the oracle price at creation or amendment. */
export const MAX_PLACEMENT_DEVIATION_BP = 5000n;
/** Minimum life of an order that can rest, in Arbitrum L2 blocks (~1 minute at 4 blocks a second). */
export const MIN_ORDER_LIFETIME_BLOCKS = 240;
/** Maximum life, in L2 blocks (~1 year); a later expiry is clamped to it by the pair. */
export const MAX_ORDER_LIFETIME_BLOCKS = 365 * 24 * 60 * 60 * 4;
/** The expiry the pair stamps on TakeProfit and StopLoss orders: they never expire. */
export const NEVER_EXPIRE_BLOCK = (1n << 64n) - 1n;
/** Active Limit + StopLimit orders one account may hold on one pair. */
export const MAX_ACTIVE_LIMIT_ORDERS_PER_USER = 32;
/** Amendments per amendOrders call (the per-user cap, so one batch can requote every order). */
export const MAX_AMENDS_PER_CALL = 32;
/**
 * Order ids per cancelOrders call (BazaarPair.MAX_CANCELS_PER_CALL): every order one account can hold
 * live on a pair, its Limit and StopLimit orders plus a take-profit and a stop-loss.
 */
export const MAX_CANCELS_PER_CALL = MAX_ACTIVE_LIMIT_ORDERS_PER_USER + 2;
/** Bit 192 of an amendment's id word: skip the amendment instead of reverting the batch. */
export const AMEND_BEST_EFFORT_BIT = 1n << 192n;
/** A TakeProfit or StopLoss of this size closes the whole position, whatever it is when it fires. */
export const CLOSE_POSITION = MAX_UINT256;
/** Arbitrum produces about four L2 blocks a second; expiries are counted in them. */
export const L2_BLOCKS_PER_SECOND = 4;
/**
 * Blocks of slack the SDK adds on top of the minimum lifetime when it checks an expiry: the pair
 * measures the lifetime from the block the transaction lands in, a few seconds after it is built.
 */
export const EXPIRY_LANDING_MARGIN_BLOCKS = 40;

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const TRIGGER_TYPES = new Set<number>([STOP_LIMIT, TAKE_PROFIT, STOP_LOSS]);
const usd = (v: bigint) => `$${formatUnits18(v, 2)}`;

/** BazaarTypes.OrderSpec, field for field: what createOrder takes and the CreateOrder signature covers. */
export interface OrderSpec {
  readonly orderType: OrderType;
  readonly isLong: boolean;
  readonly isPostOnly: boolean;
  readonly tif: TimeInForce;
  /** BAZAAR precision; `CLOSE_POSITION` (type(uint256).max) on a TP/SL closes the whole position. */
  readonly size: bigint;
  /** The trigger price in the low 128 bits and the keeper bounty in the high 128: `(bounty << 128) | price`. */
  readonly triggerPrice: bigint;
  readonly limitPrice: bigint;
  readonly maxSlippageBp: bigint;
  /**
   * Absolute L2 block. A bigint, unlike other block numbers in the SDK, because the field is the
   * contract's uint64 and TP/SL carry {@link NEVER_EXPIRE_BLOCK}, which a JS number cannot hold.
   */
  readonly expirationBlock: bigint;
  readonly integrator: Address;
}

/**
 * BazaarTypes.MatchHints: execution aids for the arrival walk and book insertion, outside every
 * signature. `pred` is the order the new one should rest directly behind (0 = at the head of its
 * side), `pred2..pred4` fallbacks tried when earlier ones have left the book; every hint is verified
 * against the real neighbours, so a wrong one can only fail a placement, never misplace an order.
 * `maxSteps` caps the nodes the walk visits (0 = the protocol default, 32); a relayed order always
 * walks the default, since only its signer may bound how much of it executes.
 */
export interface MatchHints {
  readonly pred: bigint;
  readonly pred2: bigint;
  readonly pred3: bigint;
  readonly pred4: bigint;
  readonly maxSteps: number;
}

export const NO_HINTS: MatchHints = { pred: 0n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 };

/** An order as a trader describes it. Fields a type does not use are ignored for it. */
export interface OrderInput {
  readonly orderType: OrderType;
  /** true buys (goes long or reduces a short), false sells. */
  readonly isLong: boolean;
  /** Base units, BAZAAR precision. For a TakeProfit or StopLoss, `CLOSE_POSITION` closes it all. */
  readonly size: bigint;
  /** Limit and StopLimit: the price the order fills at or better. */
  readonly limitPrice?: bigint;
  /** StopLimit, TakeProfit, StopLoss: the oracle price that fires the order (the price alone). */
  readonly triggerPrice?: bigint;
  /**
   * StopLimit, TakeProfit, StopLoss: what the order pays whoever fires it, BAZAAR precision, a
   * whole number of micro-USDC. Pulled from the wallet (not collateral) at creation. 0 means you will
   * fire it yourself ({@link executeTriggeredOrders} in trade.ts).
   */
  readonly bounty?: bigint;
  /** Market, TakeProfit, StopLoss: the worst fill allowed, in bp of the oracle price (1..1000). */
  readonly maxSlippageBp?: bigint;
  /** Default GTC. */
  readonly tif?: TimeInForce;
  /** Limit GTC only: cancel instead of taking liquidity. */
  readonly isPostOnly?: boolean;
  /** Limit GTC and StopLimit: the absolute L2 block the order expires after. */
  readonly expirationBlock?: number | bigint;
}

/** What the pair knows that an order is judged against. Every field is optional: a check that needs a missing one is skipped. */
export interface OrderEnvironment {
  /** The current L2 block (checks the expiry against the minimum lifetime). */
  readonly currentBlock?: number;
  /** The live oracle spot, BAZAAR precision (the Limit placement band; a Market order's notional). */
  readonly price?: bigint;
  /** The owner's order slots and position on the pair ({@link readOrderState}). */
  readonly account?: AccountOrderState;
}

/** The account facts the creation checks need: its position and its order slots. */
export interface AccountOrderState {
  /** The net position: `size` 0 when flat. */
  readonly position: { readonly isLong: boolean; readonly size: bigint };
  /** Live (unexpired) Limit GTC and StopLimit orders, which share the 32-order cap. */
  readonly activeLimitOrderIds: readonly bigint[];
  /** The position's TakeProfit order id, 0n for none. */
  readonly takeProfitOrderId: bigint;
  /** The position's StopLoss order id, 0n for none. */
  readonly stopLossOrderId: bigint;
}

export const isTriggerType = (t: number) => TRIGGER_TYPES.has(t);
const isTpSl = (t: number) => t === TAKE_PROFIT || t === STOP_LOSS;

/** Whether the order joins the account's active set and its 32-order cap (OrderManagementLib._joinsActiveSet). */
export function joinsActiveSet(orderType: number, tif: number): boolean {
  return (orderType === LIMIT && tif === TimeInForce.GTC) || orderType === STOP_LIMIT;
}

/** Whether the order can rest in the book and so wants an insertion hint: a Limit GTC, or a StopLimit once armed. */
export function canRest(orderType: number, tif: number): boolean {
  return joinsActiveSet(orderType, tif);
}

// ---- trigger price and bounty ----

/** `(bounty << 128) | price`: the OrderSpec.triggerPrice word of a trigger order. */
export function packTriggerPrice(price: bigint, bounty = 0n): bigint {
  if (price < 0n || price > TRIGGER_PRICE_MASK) throw new InputError("triggerPrice", "That trigger price is out of range.");
  if (bounty < 0n || bounty > TRIGGER_PRICE_MASK) throw new InputError("bounty", "That bounty is out of range.");
  return (bounty << 128n) | price;
}

/**
 * Split a triggerPrice word into its price (low 128 bits) and bounty (high 128 bits). An order the
 * pair has stored (`orders(id)`, `OrderUpdated`) keeps only the price: its bounty lives in the fee
 * escrow, read with {@link readTriggerBounty}, and shrinks as executions pay it out.
 */
export function unpackTriggerPrice(word: bigint): { price: bigint; bounty: bigint } {
  return { price: word & TRIGGER_PRICE_MASK, bounty: word >> 128n };
}

/** The bounty a spec carries: what createOrder pulls from the wallet on top of any relayer fee. */
export function specBounty(spec: Pick<OrderSpec, "orderType" | "triggerPrice">): bigint {
  return isTriggerType(spec.orderType) ? spec.triggerPrice >> 128n : 0n;
}

/** L2 blocks in `seconds` (about four a second), for an expiry `currentBlock + blocksIn(s)`. */
export function blocksIn(seconds: number): number {
  return Math.ceil(seconds * L2_BLOCKS_PER_SECOND);
}

// ---- validation ----

function req(v: bigint | undefined, field: string, message: string): bigint {
  if (v === undefined || v === 0n) throw new InputError(field, message);
  if (v < 0n) throw new InputError(field, "It cannot be negative.");
  return v;
}

function slippage(v: bigint | undefined): bigint {
  if (v === undefined || v <= 0n || v > MAX_SLIPPAGE_BP) {
    throw new InputError("maxSlippageBp", "Set a slippage limit between 0.01% and 10%.");
  }
  return v;
}

/**
 * Check an order the way `OrderManagementLib.createOrder` will, and return the spec to send or
 * sign. Throws {@link InputError} naming the field for anything the pair would refuse that `env`
 * lets it know: a missing or zero size or price, a type/time-in-force/post-only combination the pair
 * rejects, a stop-limit on the wrong side of its trigger, a slippage outside 0.01%-10%, a bounty on
 * a type that cannot carry one or one that is not whole micro-USDC, a Limit price outside ±50% of
 * the oracle price, a notional under $5 that is not a full close, an expiry under the minimum
 * lifetime, a TP/SL without an opposite position, and the per-user caps (32 active Limit + StopLimit
 * orders, one TakeProfit and one StopLoss per position).
 *
 * Fields a type ignores are written as 0 (the pair ignores them too), so the signed payload carries
 * no stray values: a Limit's trigger and slippage, a Market's prices, a StopLimit's slippage, a
 * TP/SL's limit price. TP/SL expire never ({@link NEVER_EXPIRE_BLOCK}); Market, IOC and FOK orders
 * end within their own transaction, so their expiry is 0.
 */
export function buildOrderSpec(input: OrderInput, integrator: Address, env: OrderEnvironment = {}): OrderSpec {
  const ot = input.orderType;
  if (!(ot in ORDER_TYPE_NAMES)) throw new InputError("orderType", "Unknown order type.");
  const tif = (input.tif ?? TimeInForce.GTC) as TimeInForce;
  if (!(tif in TIF_NAMES)) throw new InputError("tif", "Unknown time in force.");
  const postOnly = input.isPostOnly ?? false;
  const size = req(input.size, "size", "Enter a size greater than zero.");
  if (!isTpSl(ot) && size > MAX_UINT128) throw new InputError("size", "That size is too large.");

  const bounty = input.bounty ?? 0n;
  if (bounty < 0n) throw new InputError("bounty", "A bounty cannot be negative.");
  if (bounty !== 0n) {
    if (!isTriggerType(ot)) throw new InputError("bounty", "Only stop and take-profit orders carry a keeper bounty.");
    if (bounty % USDC_TO_BAZAAR !== 0n) throw new InputError("bounty", "The bounty must be a whole amount of USDC (at most 6 decimals).");
    if (bounty > TRIGGER_PRICE_MASK) throw new InputError("bounty", "That bounty is too large.");
  }

  // Both non-default time-in-force values demand an immediate taking fill, which post-only forbids;
  // IOC is Limit-only, FOK Limit or Market.
  if (tif !== TimeInForce.GTC) {
    if (postOnly) throw new InputError("isPostOnly", "A post-only order must be good-till-cancelled.");
    const ok = ot === LIMIT || (tif === TimeInForce.FOK && ot === MARKET);
    if (!ok) {
      throw new InputError("tif", tif === TimeInForce.IOC ? "Immediate-or-cancel is for limit orders only." : "Fill-or-kill is for limit and market orders only.");
    }
  }
  if (postOnly && ot !== LIMIT) throw new InputError("isPostOnly", "Only limit orders can be post-only.");

  let triggerPrice = 0n;
  let limitPrice = 0n;
  let maxSlippageBp = 0n;
  if (ot === LIMIT) {
    limitPrice = req(input.limitPrice, "limitPrice", "Enter a limit price.");
    if (limitPrice > MAX_UINT128) throw new InputError("limitPrice", "That limit price is too large.");
    if (env.price !== undefined && env.price > 0n) {
      const lo = (env.price * (BP_SCALE - MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
      const hi = (env.price * (BP_SCALE + MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
      if (limitPrice < lo || limitPrice > hi) {
        throw new InputError("limitPrice", `A limit price must be within 50% of the market price: between ${formatUnits18(lo, 6)} and ${formatUnits18(hi, 6)}.`);
      }
    }
  } else if (ot === MARKET) {
    maxSlippageBp = slippage(input.maxSlippageBp);
  } else if (ot === STOP_LIMIT) {
    const t = req(input.triggerPrice, "triggerPrice", "Enter a trigger price.");
    limitPrice = req(input.limitPrice, "limitPrice", "Enter a limit price.");
    if (limitPrice > MAX_UINT128) throw new InputError("limitPrice", "That limit price is too large.");
    // A buy fires at price >= trigger and must be able to fill there, so its limit sits at or above
    // the trigger; a sell the mirror. The other configurations can never fill.
    if (input.isLong && limitPrice < t) throw new InputError("limitPrice", "A buy stop-limit's limit price must be at or above its trigger price.");
    if (!input.isLong && limitPrice > t) throw new InputError("limitPrice", "A sell stop-limit's limit price must be at or below its trigger price.");
    triggerPrice = packTriggerPrice(t, bounty);
  } else {
    const t = req(input.triggerPrice, "triggerPrice", "Enter a trigger price.");
    maxSlippageBp = slippage(input.maxSlippageBp);
    triggerPrice = packTriggerPrice(t, bounty);
  }

  const acct = env.account;
  const pos = acct?.position;
  if (isTpSl(ot) && pos) {
    if (pos.size === 0n) throw new InputError("orderType", "Take-profit and stop-loss orders need an open position.");
    if (pos.isLong === input.isLong) throw new InputError("isLong", "A take-profit or stop-loss must be on the opposite side of your position.");
  }

  // The $5 notional floor, on the price the pair uses: the limit, else the trigger, else the oracle
  // price (Market). A TP/SL is measured on what it could close; a full close is always allowed.
  const refPrice = limitPrice > 0n ? limitPrice : triggerPrice > 0n ? triggerPrice & TRIGGER_PRICE_MASK : env.price;
  const sizeForMin = isTpSl(ot) ? (pos ? (size > pos.size ? pos.size : size) : undefined) : size;
  if (refPrice !== undefined && sizeForMin !== undefined) {
    const notional = (sizeForMin * refPrice) / BAZAAR_SCALE;
    if (notional < MIN_ORDER_AMOUNT) {
      const fullClose = pos !== undefined && pos.size > 0n && pos.isLong !== input.isLong && sizeForMin === pos.size;
      if (!fullClose) throw new InputError("size", `This order is worth ${usd(notional)}; the minimum is $5 (closing your whole position is exempt).`);
    }
  }

  let expirationBlock = 0n;
  if (isTpSl(ot)) {
    expirationBlock = NEVER_EXPIRE_BLOCK;
  } else if (joinsActiveSet(ot, tif)) {
    if (input.expirationBlock === undefined) throw new InputError("expirationBlock", "Choose when the order expires.");
    expirationBlock = BigInt(input.expirationBlock);
    if (expirationBlock <= 0n || expirationBlock > MAX_UINT64) throw new InputError("expirationBlock", "That expiry is out of range.");
    if (env.currentBlock !== undefined) {
      const min = BigInt(env.currentBlock + MIN_ORDER_LIFETIME_BLOCKS + EXPIRY_LANDING_MARGIN_BLOCKS);
      if (expirationBlock < min) throw new InputError("expirationBlock", "An order must stay open for at least about a minute.");
    }
  }

  if (acct) checkOrderCaps({ orderType: ot, tif }, acct);

  return { orderType: ot, isLong: input.isLong, isPostOnly: postOnly, tif, size, triggerPrice, limitPrice, maxSlippageBp, expirationBlock, integrator };
}

/**
 * The per-user caps a UI must respect, against an account's live orders: 32 active Limit (GTC) +
 * StopLimit orders per pair, and one TakeProfit and one StopLoss per position. IOC and FOK limits
 * and Market orders never rest, so they take no slot and are always allowed.
 */
export function checkOrderCaps(order: { orderType: number; tif?: number }, account: AccountOrderState): void {
  const tif = order.tif ?? TimeInForce.GTC;
  if (joinsActiveSet(order.orderType, tif) && account.activeLimitOrderIds.length >= MAX_ACTIVE_LIMIT_ORDERS_PER_USER) {
    throw new InputError("orderType", `You already have ${MAX_ACTIVE_LIMIT_ORDERS_PER_USER} open limit and stop-limit orders on this market, the most allowed. Cancel one first.`);
  }
  if (order.orderType === TAKE_PROFIT && account.takeProfitOrderId !== 0n) {
    throw new InputError("orderType", "This position already has a take-profit order. Cancel it before placing another.");
  }
  if (order.orderType === STOP_LOSS && account.stopLossOrderId !== 0n) {
    throw new InputError("orderType", "This position already has a stop-loss order. Cancel it before placing another.");
  }
}

/** The order a spec describes, for re-validation (a relayer checking a signed spec) or display. */
export function orderInputFromSpec(spec: OrderSpec): OrderInput {
  const { price, bounty } = unpackTriggerPrice(spec.triggerPrice);
  return {
    orderType: spec.orderType,
    isLong: spec.isLong,
    size: spec.size,
    limitPrice: spec.limitPrice,
    triggerPrice: price,
    bounty,
    maxSlippageBp: spec.maxSlippageBp,
    tif: spec.tif,
    isPostOnly: spec.isPostOnly,
    expirationBlock: spec.expirationBlock,
  };
}

/**
 * Check a spec built elsewhere (or received for relaying) against the same rules, including the
 * one the builder enforces by construction: a non-trigger type must leave the bounty bits clear.
 */
export function validateOrderSpec(spec: OrderSpec, env: OrderEnvironment = {}): void {
  if (!isTriggerType(spec.orderType) && spec.triggerPrice >> 128n !== 0n) {
    throw new InputError("bounty", "Only stop and take-profit orders carry a keeper bounty.");
  }
  buildOrderSpec(orderInputFromSpec(spec), spec.integrator, env);
}

/**
 * One line for a confirmation screen: "Buy 1.5 at 2000 (limit, GTC, post-only)". Every amount prints
 * exactly (trailing zeros trimmed), never rounded down: the bounty the wallet pays, and the size and
 * prices the user signs.
 */
export function describeOrder(spec: OrderSpec): string {
  const side = spec.isLong ? "Buy" : "Sell";
  const exact = (v: bigint) => formatUnits18(v);
  const size = isTpSl(spec.orderType) && spec.size >= MAX_UINT128 ? "the whole position" : exact(spec.size);
  const { price: trig, bounty } = unpackTriggerPrice(spec.triggerPrice);
  const slip = `${Number(spec.maxSlippageBp) / 100}% max slippage`;
  const b = bounty > 0n ? `, $${exact(bounty)} keeper bounty` : "";
  switch (spec.orderType) {
    case MARKET:
      return `${side} ${size} at market (${slip}${spec.tif === TimeInForce.FOK ? ", fill-or-kill" : ""})`;
    case LIMIT:
      return `${side} ${size} at ${exact(spec.limitPrice)} (limit, ${TIF_NAMES[spec.tif]}${spec.isPostOnly ? ", post-only" : ""})`;
    case STOP_LIMIT:
      return `${side} ${size} at ${exact(spec.limitPrice)} once the price reaches ${exact(trig)} (stop-limit${b})`;
    case TAKE_PROFIT:
      return `Take profit: ${side.toLowerCase()} ${size} when the price reaches ${exact(trig)} (${slip}${b})`;
    default:
      return `Stop loss: ${side.toLowerCase()} ${size} when the price reaches ${exact(trig)} (${slip}${b})`;
  }
}

// ---- amendments ----

/** One amendment of a resting Limit (GTC) order: its new price and new TOTAL size (filled part included). */
export interface AmendInput {
  readonly orderId: bigint;
  /** BAZAAR precision. */
  readonly limitPrice: bigint;
  /** The new total size, filled part included: it must exceed what has filled. */
  readonly size: bigint;
  /** The order to rest directly behind at the new price (0 = none; trade.ts finds it when omitted). */
  readonly pred?: bigint;
  /** A second candidate, tried when the first has left the book. */
  readonly pred2?: bigint;
  /**
   * Skip this amendment, rather than revert the whole batch, when the order has been filled,
   * canceled or has expired, the size is at or below what has filled or leaves under $5, or the
   * new price would cross. Every other refusal still reverts the batch.
   */
  readonly bestEffort?: boolean;
}

function u64(v: bigint, field: string): bigint {
  if (v < 0n || v > MAX_UINT64) throw new InputError(field, "That order id is out of range.");
  return v;
}

/**
 * An amendment's id word, exactly as BazaarPairLens.amendIdWord / bestEffortAmendIdWord pack it:
 * the order id in bits 0-63, hints in bits 64-127 and 128-191, the best-effort flag in bit 192.
 */
export function amendIdWord(orderId: bigint, pred = 0n, pred2 = 0n, bestEffort = false): bigint {
  const w = u64(orderId, "orderId") | (u64(pred, "pred") << 64n) | (u64(pred2, "pred2") << 128n);
  return bestEffort ? w | AMEND_BEST_EFFORT_BIT : w;
}

/** BazaarPairLens.bestEffortAmendIdWord. */
export const bestEffortAmendIdWord = (orderId: bigint, pred = 0n, pred2 = 0n) => amendIdWord(orderId, pred, pred2, true);

/** The fields of an id word. Throws on bits above the flag, which the pair refuses. */
export function unpackAmendIdWord(word: bigint): { orderId: bigint; pred: bigint; pred2: bigint; bestEffort: boolean } {
  if (word < 0n || word >> 193n !== 0n) throw new InputError("amends", "An amendment's id word has bits set above the best-effort flag.");
  return { orderId: word & MAX_UINT64, pred: (word >> 64n) & MAX_UINT64, pred2: (word >> 128n) & MAX_UINT64, bestEffort: (word & AMEND_BEST_EFFORT_BIT) !== 0n };
}

/**
 * The flat `amends` array amendOrders takes and AmendOrders signs: per amendment its id word, its new
 * price, its new total size. 1 to {@link MAX_AMENDS_PER_CALL} amendments; prices and sizes must fit
 * the order's 128-bit fields and be non-zero. The same order may appear more than once (each
 * amendment applies in turn).
 */
export function encodeAmends(amends: readonly AmendInput[]): bigint[] {
  if (amends.length === 0) throw new InputError("amends", "Choose at least one order to amend.");
  if (amends.length > MAX_AMENDS_PER_CALL) throw new InputError("amends", `At most ${MAX_AMENDS_PER_CALL} orders can be amended at once.`);
  const out: bigint[] = [];
  for (const a of amends) {
    if (a.orderId <= 0n) throw new InputError("orderId", "Choose an order to amend.");
    if (a.limitPrice <= 0n) throw new InputError("limitPrice", "Enter a limit price.");
    if (a.limitPrice > MAX_UINT128) throw new InputError("limitPrice", "That limit price is too large.");
    if (a.size <= 0n) throw new InputError("size", "Enter a size greater than zero.");
    if (a.size > MAX_UINT128) throw new InputError("size", "That size is too large.");
    out.push(amendIdWord(a.orderId, a.pred ?? 0n, a.pred2 ?? 0n, a.bestEffort ?? false), a.limitPrice, a.size);
  }
  return out;
}

/** The amendments a flat `amends` array holds (for a relayer showing or checking a signed batch). */
export function decodeAmends(words: readonly bigint[]): AmendInput[] {
  if (words.length === 0 || words.length % 3 !== 0 || words.length / 3 > MAX_AMENDS_PER_CALL) {
    throw new InputError("amends", "An amendment batch is 1 to 32 triples of words.");
  }
  const out: AmendInput[] = [];
  for (let i = 0; i < words.length; i += 3) {
    const { orderId, pred, pred2, bestEffort } = unpackAmendIdWord(words[i]!);
    out.push({ orderId, pred, pred2, bestEffort, limitPrice: words[i + 1]!, size: words[i + 2]! });
  }
  return out;
}

// ---- reads ----

/**
 * The account facts the creation checks need, in one batched read: the position (pair
 * `positionBuckets`, which also names its TP and SL order ids) and the live Limit + StopLimit
 * orders (`lens.getUserActiveLimitOrders`, which leaves out expired ones, as the pair prunes them
 * before judging the cap).
 */
export async function readOrderState(ctx: BazaarContext, pair: Address, user: Address): Promise<AccountOrderState> {
  const pc = pairCodec();
  const lc = lensCodec();
  const [[okB, b], [okA, a]] = await ctx.chain.batch([
    { to: pair, data: pc.encode("positionBuckets", user) },
    { to: ctx.lens, data: lc.encode("getUserActiveLimitOrders", pair, user) },
  ]);
  if (!okB || !okA) throw new Error(`could not read ${user}'s orders on ${pair}`);
  const bucket = pc.decode<{ isLong: boolean; size: bigint; takeProfitOrderId: bigint; stopLossOrderId: bigint }>("positionBuckets", b!);
  const active = lc.decode<{ orderIds: readonly bigint[] }>("getUserActiveLimitOrders", a!);
  return {
    position: { isLong: bucket.isLong, size: bucket.size },
    activeLimitOrderIds: [...active.orderIds],
    takeProfitOrderId: BigInt(bucket.takeProfitOrderId),
    stopLossOrderId: BigInt(bucket.stopLossOrderId),
  };
}

/** What a trigger order's escrow still holds for whoever fires it (BAZAAR precision): lens.triggerBounty. */
export async function readTriggerBounty(ctx: BazaarContext, pair: Address, orderId: bigint): Promise<bigint> {
  const lc = lensCodec();
  return lc.decode<bigint>("triggerBounty", await ctx.chain.call(ctx.lens, lc.encode("triggerBounty", pair, orderId)));
}

/** The lifetime constants as the lens reports them (pure there; useful to confirm the SDK's copy). */
export async function readOrderLifetimeConstants(ctx: BazaarContext): Promise<{ minOrderLifetimeBlocks: number; maxOrderLifetimeBlocks: number }> {
  const lc = lensCodec();
  const r = lc.decode<{ minOrderLifetimeBlocks: bigint; maxOrderLifetimeBlocks: bigint }>(
    "getOrderLifetimeConstants",
    await ctx.chain.call(ctx.lens, lc.encode("getOrderLifetimeConstants")),
  );
  return { minOrderLifetimeBlocks: Number(r.minOrderLifetimeBlocks), maxOrderLifetimeBlocks: Number(r.maxOrderLifetimeBlocks) };
}
