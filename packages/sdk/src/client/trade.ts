/**
 * Trading writes on a pair, in their direct form: collateral in and out, orders created, amended,
 * canceled and fired, fees claimed. Each builder first confirms that `pair` is one of the
 * deployment's pairs (guard.ts `requirePair`: one cached factory read per pair), checks its inputs
 * against what it can read (the account's orders and position, the book, the live price), then
 * returns a {@link PreparedCall} with
 * an empty signature, `from` the trader, the Pyth Pro update attached where the function takes one
 * and the oracle would accept it (feeds.ts `priceUpdateFor`: `value` its fee, `priceTime` the second
 * its price was generated in; `noFreshPrice` saying why there is none) and `pullsUsdc` what the call
 * takes from the wallet.
 *
 * Build calls that carry a price update as late as possible, right before the wallet is asked to
 * send (calls.ts `buildAndSend`): the pair refuses a price generated more than 3 s from the block's
 * time, so a call older than that should be rebuilt. The gasless forms of the same actions are in
 * relay.ts.
 *
 * This module also reads the live price out of a signed update (`parsePriceUpdate`,
 * `pairPriceFromUpdate`, `livePairPrice`), composed as BazaarOracle composes it, so an order or a
 * quote is judged against the price the pair will see.
 */

import { type Address, type Hex, getAddress } from "viem";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import { MAX_WALK_STEPS, MIN_COLLATERAL_DEPOSIT, MIN_ORDER_AMOUNT, BAZAAR_SCALE, BP_SCALE, LIMIT, MAX_TRIGGER_EXECS_PER_CALL, STOP_LIMIT, ZERO_ADDRESS } from "../constants.js";
import { type PairPrice, pairPrice, triggerReached } from "../formulas/index.js";
import { type LazerPayload, MICROS_PER_SECOND, feedIdHex, legEntries, readUpdate } from "../prices/lazer.js";
import { isLivePrint } from "../prices/pro.js";
import { InputError, type PreparedCall } from "./calls.js";
import { type BazaarContext, requirePrices } from "./context.js";
import { type FreshUpdate, NoFreshPriceError, pairFeeds, priceUpdateFor } from "./feeds.js";
import { requirePair } from "./guard.js";
import {
  type AccountOrderState,
  type AmendInput,
  EXPIRY_LANDING_MARGIN_BLOCKS,
  MAX_CANCELS_PER_CALL,
  MAX_PLACEMENT_DEVIATION_BP,
  MIN_ORDER_LIFETIME_BLOCKS,
  type MatchHints,
  NO_HINTS,
  type OrderEnvironment,
  type OrderInput,
  type OrderSpec,
  TimeInForce,
  buildOrderSpec,
  canRest,
  describeOrder,
  encodeAmends,
  isTriggerType,
  readOrderState,
  specBounty,
} from "./orders.js";
import { DIRECT_META, encodePairWrite } from "./signing.js";
import { floorToUsdc, formatUnits18 } from "./units.js";

const usdc = (v: bigint) => formatUnits18(v, 6);
const px = (v: bigint) => formatUnits18(v, 6);
const MAX_UINT64 = (1n << 64n) - 1n;

// ---- the live price, from a signed update ----

export class PriceUpdateError extends Error {
  override readonly name = "PriceUpdateError";
}

/** One feed's live price as a signed update carries it. */
export interface UpdatePrice {
  readonly feedId: Hex;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  /** The second the price was generated in: what the pair's freshness window judges. */
  readonly publishTime: number;
  /** When the price was generated, in microseconds (the feed update timestamp). */
  readonly generatedUs: bigint;
}

/** Each update's payload, read from its bytes; throws PriceUpdateError on one that is not a Pyth Pro update. */
function readUpdates(update: readonly Hex[]): LazerPayload[] {
  return update.map((blob) => {
    try {
      return readUpdate(blob);
    } catch (e) {
      throw new PriceUpdateError(e instanceof Error ? e.message : String(e));
    }
  });
}

/**
 * The live prices a `priceUpdate: bytes[]` carries, read from each update's signed payload: one
 * entry per feed that holds a price a live call could use (prices/pro.ts `isLivePrint`), update by
 * update. The signatures are not checked here; the chain checks them. Throws PriceUpdateError on an
 * update that is not a Pyth Pro update.
 */
export function parsePriceUpdate(update: readonly Hex[]): UpdatePrice[] {
  const out: UpdatePrice[] = [];
  for (const u of readUpdates(update)) {
    for (const f of u.feeds) {
      if (f.id === 0 || !isLivePrint(f)) continue;
      out.push({
        feedId: feedIdHex(f.id),
        price: f.price,
        conf: f.confidence,
        expo: f.exponent,
        publishTime: Number(f.feedUpdateTimestamp / MICROS_PER_SECOND),
        generatedUs: f.feedUpdateTimestamp,
      });
    }
  }
  return out;
}

/**
 * The pair price an update proves, composed from the pair's legs exactly as BazaarOracle composes it
 * (formulas `pairPrice`): spot, the confidence bracket, the second the older leg's price was
 * generated in, and whether it clears the 2% confidence cap. Each leg is read from whichever update
 * carries its most recently generated price, as the oracle reads it. Null when the oracle would
 * refuse the update whatever the block time: a leg no update carries, or one whose entry lacks a
 * property a live price needs, holds no price, or has no confidence.
 */
export async function pairPriceFromUpdate(ctx: BazaarContext, pair: Address, update: readonly Hex[]): Promise<PairPrice | null> {
  const feeds = await pairFeeds(ctx, pair);
  readUpdates(update); // an update that cannot be read is a PriceUpdateError
  const legs = legEntries(update, feeds.legs).map((e) => e?.feed);
  if (legs.some((l) => !l || !isLivePrint(l))) return null;
  return pairPrice(
    legs.map((l) => ({ price: l!.price, conf: l!.confidence, expo: l!.exponent, publishTime: Number(l!.feedUpdateTimestamp / MICROS_PER_SECOND) })),
    feeds.invertQuote,
  );
}

/** The live pair price from the context's price source, with the update it came from. */
export async function livePairPrice(ctx: BazaarContext, pair: Address): Promise<{ price: PairPrice; update: Hex[]; publishTime: number }> {
  const source = requirePrices(ctx);
  const feeds = await pairFeeds(ctx, pair);
  const { update, publishTime } = await source.latest(feeds.legs);
  const price = await pairPriceFromUpdate(ctx, pair, update);
  if (!price) throw new PriceUpdateError("the price source's update does not carry every feed of this market");
  return { price, update, publishTime };
}

/** The price the pair last stored (`lastPairPrice`): what it falls back to on a closed market. */
export async function storedPairPrice(ctx: BazaarContext, pair: Address): Promise<{ spotPrice: bigint; lowPrice: bigint; highPrice: bigint; updateTs: number }> {
  const pc = pairCodec();
  const r = pc.decode<{ spotPrice: bigint; lowPrice: bigint; highPrice: bigint; updateTs: bigint }>("lastPairPrice", await ctx.chain.call(pair, pc.encode("lastPairPrice")));
  return { spotPrice: r.spotPrice, lowPrice: r.lowPrice, highPrice: r.highPrice, updateTs: Number(r.updateTs) };
}

/** The spot an order is checked against: from `update` when given, else live, else the stored mark. */
async function checkPrice(ctx: BazaarContext, pair: Address, update?: readonly Hex[]): Promise<bigint | null> {
  try {
    if (update) {
      const p = await pairPriceFromUpdate(ctx, pair, update);
      if (p) return p.spot;
    } else if (ctx.prices) {
      return (await livePairPrice(ctx, pair)).price.spot;
    }
  } catch {
    // No live price could be read (the source failed, or holds none for a leg): the order is
    // checked against the stored mark instead, and the pair judges it on whatever price it reads.
  }
  const s = await storedPairPrice(ctx, pair);
  return s.spotPrice > 0n ? s.spotPrice : null;
}

// ---- book position hints ----

const PRED_PAGE = 64n;
const PRED_PAGES = 8;

/**
 * The order a new entry at `limitPrice` on its side should rest directly behind (0 = the head):
 * `lens.findPredecessor` followed through budget-limited pages, as the keeper's Reader.predecessor
 * does (up to 8 pages of 64 nodes; past that, the last node reached, which the pair's repair walk
 * starts from).
 */
export async function findPredecessor(ctx: BazaarContext, pair: Address, isLong: boolean, limitPrice: bigint): Promise<bigint> {
  const lc = lensCodec();
  let start = 0n;
  for (let i = 0; i < PRED_PAGES; i++) {
    const r = lc.decode<{ pred: bigint; found: boolean }>(
      "findPredecessor",
      await ctx.chain.call(ctx.lens, lc.encode("findPredecessor", pair, isLong, limitPrice, start, PRED_PAGE)),
    );
    if (r.found) return r.pred;
    start = r.pred;
  }
  return start;
}

/**
 * MatchHints for an order: the predecessor on its own side at its limit price when it can rest (a
 * Limit GTC, or a StopLimit that arms on arrival), none otherwise. `maxSteps` bounds the arrival walk
 * of a direct order (0 = the protocol default of 32; a relayed order always walks the default).
 */
export async function matchHintsFor(
  ctx: BazaarContext,
  pair: Address,
  order: { orderType: number; tif: number; isLong: boolean; limitPrice: bigint },
  maxSteps = 0,
): Promise<MatchHints> {
  if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > MAX_WALK_STEPS) {
    throw new InputError("maxSteps", `The walk budget is 0 (the default) to ${MAX_WALK_STEPS} resting orders.`);
  }
  if (!canRest(order.orderType, order.tif) || order.limitPrice <= 0n) return { ...NO_HINTS, maxSteps };
  return { ...NO_HINTS, pred: await findPredecessor(ctx, pair, order.isLong, order.limitPrice), maxSteps };
}

// ---- collateral ----

/**
 * Deposit collateral: the pair floors `amount` (BAZAAR precision) to whole micro-USDC, adds it to
 * the trader's position bucket and pulls it from the wallet, so the wallet needs that much USDC
 * approved to the pair (allowance.ts) or a permit (`permitData`, permits.ts). At least 5 USDC.
 * Refused once the market is terminated, in the seconds before a scheduled cutoff and while its
 * settlement window is open.
 */
export async function depositCollateral(
  ctx: BazaarContext,
  pair: Address,
  from: Address,
  amount: bigint,
  opts: { permitData?: Hex } = {},
): Promise<PreparedCall> {
  const floored = floorToUsdc(amount);
  if (floored < MIN_COLLATERAL_DEPOSIT) throw new InputError("amount", "The minimum deposit is 5 USDC.");
  const to = await requirePair(ctx, pair);
  const data = encodePairWrite({ action: "depositCollateral", amount: floored }, {}, { ...DIRECT_META, permitData: opts.permitData ?? "0x" });
  return { action: "depositCollateral", to, data, value: 0n, from: getAddress(from), summary: `Deposit ${usdc(floored)} USDC as collateral`, pullsUsdc: floored };
}

async function hasExposure(ctx: BazaarContext, pair: Address, user: Address): Promise<boolean> {
  const pc = pairCodec();
  const lc = lensCodec();
  const res = await ctx.chain.batch([
    { to: pair, data: pc.encode("positionBuckets", user) },
    { to: ctx.lens, data: lc.encode("getUserActiveLimitOrders", pair, user) },
    { to: pair, data: pc.encode("isPairTerminated") },
  ]);
  if (!res.every(([ok]) => ok)) return true;
  if (pc.decode<boolean>("isPairTerminated", res[2]![1])) return false;
  const b = pc.decode<{ size: bigint }>("positionBuckets", res[0]![1]);
  const a = lc.decode<{ count: bigint }>("getUserActiveLimitOrders", res[1]![1]);
  return b.size !== 0n || a.count !== 0n;
}

/**
 * On a terminated pair, what a withdrawal of `amount` (collateral, BAZAAR precision) pays out:
 * `amount × principalRatio` (CollateralLib's terminal branch), with the ratio from
 * `lens.getTerminalEntitlement`. Null on a live pair, where a withdrawal pays its amount. A payout of
 * 0 pays nothing, and a relayed withdrawal then takes its relayer fee from the signer's wallet.
 * @internal Not bound on the Bazaar facade (bindings.generated.ts); call it as `trade.terminalWithdrawal(ctx, ...)`.
 */
export async function terminalWithdrawal(
  ctx: BazaarContext,
  pair: Address,
  user: Address,
  amount: bigint,
): Promise<{ payout: bigint; principalRatio: bigint } | null> {
  const pc = pairCodec();
  const lc = lensCodec();
  const [[okT, t], [okE, e]] = await ctx.chain.batch([
    { to: pair, data: pc.encode("isPairTerminated") },
    { to: ctx.lens, data: lc.encode("getTerminalEntitlement", pair, getAddress(user)) },
  ]);
  if (!okT) throw new Error(`could not read whether ${pair} is terminated`);
  if (!pc.decode<boolean>("isPairTerminated", t!)) return null;
  if (!okE) throw new Error(`could not read ${getAddress(user)}'s terminal entitlement on ${pair}`);
  const { principalRatio } = lc.decode<{ principalRatio: bigint }>("getTerminalEntitlement", e!);
  return { payout: (amount * principalRatio) / BAZAAR_SCALE, principalRatio };
}

/** What a terminal payout of `payout` reads as on a confirmation screen. */
export const terminalPayoutNote = (payout: bigint, principalRatio: bigint) =>
  `the market is terminated: it pays ${usdc(payout)} USDC, ${formatUnits18(principalRatio * 100n, 2)}% of the amount`;

/**
 * Withdraw collateral (BAZAAR precision; the wallet receives it floored to micro-USDC). A trader with
 * a position or resting orders is priced fresh: the pair keeps the position's margin, its resting
 * orders' reservation and a minimum behind, and refuses the stale fallback for a position holder. A
 * flat account reads no price. The update is attached when a price source is connected and holds one
 * the oracle would accept (feeds.ts `priceUpdateFor`; the pair refunds the fee of an update it does
 * not read). Otherwise the call carries none, which a flat account does not need; for an account that
 * does, it is refused here when no price source is connected or the market is continuously traded
 * (NoFreshPriceError), and on a market that keeps trading hours it is left to the pair, which judges
 * it on its stored price. Frozen for a position holder while an ADL window is
 * open, and for everyone while the settlement window is. On a terminated pair the wallet receives
 * `amount × principalRatio` ({@link terminalWithdrawal}), which the summary shows; a withdrawal that
 * would pay nothing is refused.
 */
export async function withdrawCollateral(
  ctx: BazaarContext,
  pair: Address,
  from: Address,
  amount: bigint,
  opts: { withPrice?: boolean } = {},
): Promise<PreparedCall> {
  if (amount <= 0n) throw new InputError("amount", "Enter an amount to withdraw.");
  pair = await requirePair(ctx, pair);
  const [fresh, terminal] = await Promise.all([
    optionalUpdate(ctx, pair, opts.withPrice, () => hasExposure(ctx, pair, from)),
    terminalWithdrawal(ctx, pair, from, amount),
  ]);
  if (terminal && terminal.payout === 0n) {
    throw new InputError("amount", "This market is terminated and, at its payout ratio, this withdrawal pays nothing.");
  }
  const data = encodePairWrite({ action: "withdrawCollateral", amount }, { priceUpdate: fresh.update }, DIRECT_META);
  return {
    action: "withdrawCollateral",
    to: pair,
    data,
    value: fresh.fee,
    from: getAddress(from),
    summary: `Withdraw ${usdc(amount)} USDC of collateral${terminal ? ` (${terminalPayoutNote(terminal.payout, terminal.principalRatio)})` : ""}`,
    ...priceFields(fresh),
    pullsUsdc: 0n,
  };
}

/** No update, and why. */
const noUpdate = (reason: string | null): FreshUpdate => ({ update: [], fee: 0n, publishTime: null, attached: false, reason });

/**
 * A price update for a call that reads a price only sometimes: none when `withPrice` is false; when a
 * price source is connected, the update feeds.ts `priceUpdateFor` gives (the pair refunds the fee of
 * an update it does not read), or none where it has no fresh price and the call reads none
 * (`withPrice` not true and `needed()` false); otherwise none, and a ConnectError when `withPrice` is
 * true or `needed()` says the call will read one.
 */
export async function optionalUpdate(ctx: BazaarContext, pair: Address, withPrice: boolean | undefined, needed: () => Promise<boolean>): Promise<FreshUpdate> {
  if (withPrice === false) return noUpdate(null);
  if (ctx.prices) {
    try {
      return await priceUpdateFor(ctx, pair);
    } catch (e) {
      // A continuously traded market without a fresh price fails only a call that reads one.
      if (!(e instanceof NoFreshPriceError) || withPrice === true || (await needed())) throw e;
      return noUpdate(e.reason);
    }
  }
  if (withPrice === true || (await needed())) requirePrices(ctx); // throws: no price source
  return noUpdate(null);
}

/** A call's price fields: when its update's price was generated, or why it carries none for want of a fresh one. */
export function priceFields(fresh: FreshUpdate): { priceTime?: number; noFreshPrice?: string } {
  if (fresh.publishTime !== null) return { priceTime: fresh.publishTime };
  return fresh.reason !== null ? { noFreshPrice: fresh.reason } : {};
}

// ---- orders ----

/** An order checked against the chain: the spec to send or sign, and what it was checked against. */
export interface PreparedOrder {
  readonly spec: OrderSpec;
  readonly account: AccountOrderState;
  readonly currentBlock: number;
  /** The oracle spot it was checked against: live when a price source is connected, else the stored mark. */
  readonly price: bigint | null;
}

const envOf = (e: { currentBlock: number; account: AccountOrderState; price: bigint | null }): OrderEnvironment => ({
  currentBlock: e.currentBlock,
  account: e.account,
  ...(e.price !== null ? { price: e.price } : {}),
});

async function orderEnvironment(ctx: BazaarContext, pair: Address, owner: Address, price: Promise<bigint | null>) {
  const [currentBlock, account, p] = await Promise.all([ctx.chain.blockNumber(), readOrderState(ctx, pair, owner), price]);
  return { currentBlock, account, price: p };
}

/**
 * Check an order against the account's position and order slots, the current L2 block and the
 * oracle price, and build its spec with the context's integrator (orders.ts `buildOrderSpec` has
 * the rules). For the gasless path: a relayer attaches the price and hints later.
 */
export async function prepareOrder(ctx: BazaarContext, pair: Address, owner: Address, order: OrderInput, opts: { integrator?: Address } = {}): Promise<PreparedOrder> {
  const integrator = getAddress(opts.integrator ?? ctx.integrator ?? ZERO_ADDRESS);
  buildOrderSpec(order, integrator); // input errors first, before any read
  const env = await orderEnvironment(ctx, pair, owner, checkPrice(ctx, pair));
  return { spec: buildOrderSpec(order, integrator, envOf(env)), ...env };
}

export interface CreateOrderOptions {
  /** Hints to use instead of the ones the SDK finds. */
  readonly hints?: MatchHints;
  /** Walk budget for this order's arrival (0 = the protocol default of 32). */
  readonly maxSteps?: number;
  /** An ERC-2612 permit covering the trigger bounty (permits.ts), executed before the pull. */
  readonly permitData?: Hex;
}

/**
 * Create an order, matched against the book in the same transaction: it fills whatever crosses at
 * each resting maker's price, then rests the remainder (a Limit GTC, placed using the hints found
 * here) or cancels it (Market, IOC, post-only violation, self-match, walk budget, dust); a
 * fill-or-kill order reverts unless it fills completely. A trigger order waits outside the book for
 * its trigger (or arms at once if the price already meets it), and its keeper bounty is pulled from
 * the wallet at creation (`pullsUsdc`). The order names `ctx.integrator`, which earns the referral
 * fee on its fills.
 */
export async function createOrder(ctx: BazaarContext, pair: Address, from: Address, order: OrderInput, opts: CreateOrderOptions = {}): Promise<PreparedCall> {
  const integrator = getAddress(ctx.integrator ?? ZERO_ADDRESS);
  buildOrderSpec(order, integrator);
  pair = await requirePair(ctx, pair);
  const tif = order.tif ?? TimeInForce.GTC;
  const hintsP = opts.hints
    ? Promise.resolve(opts.hints)
    : matchHintsFor(ctx, pair, { orderType: order.orderType, tif, isLong: order.isLong, limitPrice: order.limitPrice ?? 0n }, opts.maxSteps ?? 0);
  const freshP = priceUpdateFor(ctx, pair);
  const envP = orderEnvironment(ctx, pair, from, freshP.then((f) => checkPrice(ctx, pair, f.update)));
  const [fresh, env, hints] = await Promise.all([freshP, envP, hintsP]);
  const spec = buildOrderSpec(order, integrator, envOf(env));
  const data = encodePairWrite({ action: "createOrder", spec }, { priceUpdate: fresh.update, hints }, { ...DIRECT_META, permitData: opts.permitData ?? "0x" });
  return {
    action: "createOrder",
    to: pair,
    data,
    value: fresh.fee,
    from: getAddress(from),
    summary: describeOrder(spec),
    ...priceFields(fresh),
    pullsUsdc: specBounty(spec),
  };
}

// ---- amendments ----

interface StoredOrder {
  creator: Address;
  canceledBlock: bigint;
  orderType: number;
  isLong: boolean;
  tif: number;
  expiryBlock: bigint;
  inBook: boolean;
  triggerPrice: bigint;
  limitPrice: bigint;
  size: bigint;
  filledSize: bigint;
  filledBlock: bigint;
  prevInBook: number;
  nextInBook: number;
}

async function readOrders(ctx: BazaarContext, pair: Address, ids: readonly bigint[]): Promise<Map<bigint, StoredOrder>> {
  const pc = pairCodec();
  const res = await ctx.chain.batch(ids.map((id) => ({ to: pair, data: pc.encode("orders", id) })));
  const out = new Map<bigint, StoredOrder>();
  res.forEach(([ok, d], i) => {
    if (!ok) throw new Error(`could not read order ${ids[i]} on ${pair}`);
    out.set(ids[i]!, pc.decode<StoredOrder>("orders", d));
  });
  return out;
}

const isLive = (o: StoredOrder, block: number) => o.canceledBlock === 0n && o.filledBlock === 0n && BigInt(block) <= o.expiryBlock;

/** Amendments checked against the orders, the book and the price, with insertion hints filled in. */
export interface PreparedAmends {
  readonly amends: readonly AmendInput[];
  /** The flat array amendOrders takes and AmendOrders signs. */
  readonly words: readonly bigint[];
  readonly price: bigint | null;
  readonly currentBlock: number;
}

/**
 * Check amendments the way `OrderManagementLib._amendOne` will and fill in hints for the ones that
 * move. Each must name one of `owner`'s resting Limit GTC orders; its new price must sit within ±50%
 * of the oracle price; its new total size must exceed what has filled and leave at least $5 (or the
 * whole position); a move (new price, or larger size) needs at least ~1 minute of life left. A price
 * at or through the best order on the other side is refused (send a new order to trade instead).
 * For a `bestEffort` amendment the checks the pair skips rather than reverts on (filled, canceled,
 * expired, size at or below filled, under $5, would cross) are not raised here either.
 *
 * Hints: when an amendment gives none, the predecessor at its new price is found on its side
 * (excluding the order itself). Hints are part of the signed words, so for a gasless amendment they
 * are fixed at signing.
 */
export async function prepareAmends(
  ctx: BazaarContext,
  pair: Address,
  owner: Address,
  amends: readonly AmendInput[],
  opts: { price?: Promise<bigint | null> } = {},
): Promise<PreparedAmends> {
  encodeAmends(amends); // shape errors first
  const me = getAddress(owner);
  const ids = [...new Set(amends.map((a) => a.orderId))];
  const pc = pairCodec();
  const [orders, currentBlock, price, extra] = await Promise.all([
    readOrders(ctx, pair, ids),
    ctx.chain.blockNumber(),
    opts.price ?? checkPrice(ctx, pair),
    ctx.chain.batch([
      { to: pair, data: pc.encode("positionBuckets", me) },
      { to: pair, data: pc.encode("book") },
    ]),
  ]);
  if (!extra.every(([ok]) => ok)) throw new Error(`could not read ${pair}'s book`);
  const bucket = pc.decode<{ isLong: boolean; size: bigint }>("positionBuckets", extra[0]![1]);
  const book = pc.decode<{ bidHead: bigint; askHead: bigint }>("book", extra[1]![1]);
  const heads = [book.bidHead, book.askHead].filter((h) => h !== 0n);
  const headOrders = heads.length ? await readOrders(ctx, pair, heads) : new Map<bigint, StoredOrder>();
  const best = (side: "bid" | "ask") => {
    const id = side === "bid" ? book.bidHead : book.askHead;
    return id === 0n ? null : { id, price: headOrders.get(id)!.limitPrice };
  };

  // Each amendment sees the order as the earlier ones in the batch left it.
  const local = new Map<bigint, { limitPrice: bigint; size: bigint }>();
  const moved = new Set<bigint>();
  const needsHint: number[] = [];
  amends.forEach((a, i) => {
    const o = orders.get(a.orderId)!;
    const tag = `Order #${a.orderId}`;
    if (o.creator === ZERO_ADDRESS) throw new InputError("orderId", `${tag} does not exist.`);
    if (getAddress(o.creator) !== me) throw new InputError("orderId", `${tag} is not yours.`);
    if (o.orderType !== LIMIT || o.tif !== TimeInForce.GTC) {
      throw new InputError("orderId", `${tag} is not a resting limit order; only those can be amended. Cancel it and place a new one.`);
    }
    const be = a.bestEffort ?? false;
    if (o.canceledBlock !== 0n || o.filledBlock !== 0n || !o.inBook) {
      if (be) return;
      throw new InputError("orderId", `${tag} is no longer open.`);
    }
    if (BigInt(currentBlock) > o.expiryBlock) {
      if (be) return;
      throw new InputError("orderId", `${tag} has expired.`);
    }
    if (price !== null) {
      const lo = (price * (BP_SCALE - MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
      const hi = (price * (BP_SCALE + MAX_PLACEMENT_DEVIATION_BP)) / BP_SCALE;
      if (a.limitPrice < lo || a.limitPrice > hi) {
        throw new InputError("limitPrice", `A limit price must be within 50% of the market price: between ${px(lo)} and ${px(hi)}.`);
      }
    }
    if (a.size <= o.filledSize) {
      if (be) return;
      throw new InputError("size", `${tag}: the new size must be more than the ${px(o.filledSize)} already filled.`);
    }
    const remaining = a.size - o.filledSize;
    if ((remaining * a.limitPrice) / BAZAAR_SCALE < MIN_ORDER_AMOUNT) {
      const fullClose = bucket.size > 0n && bucket.isLong !== o.isLong && remaining === bucket.size;
      if (!fullClose) {
        if (be) return;
        throw new InputError("size", `${tag}: what is left to fill must be worth at least $5.`);
      }
    }
    // The opposite best, unless one of this batch's own moves may have changed it.
    const opp = best(o.isLong ? "ask" : "bid");
    if (opp && !moved.has(opp.id) && (o.isLong ? a.limitPrice >= opp.price : a.limitPrice <= opp.price)) {
      if (!be) throw new InputError("limitPrice", `${tag}: that price would cross the book (best ${o.isLong ? "ask" : "bid"} ${px(opp.price)}). Place a new order to trade now.`);
      return;
    }
    const cur = local.get(a.orderId) ?? { limitPrice: o.limitPrice, size: o.size };
    const isMove = a.limitPrice !== cur.limitPrice || a.size > cur.size;
    if (isMove) {
      if (o.expiryBlock < BigInt(currentBlock + MIN_ORDER_LIFETIME_BLOCKS + EXPIRY_LANDING_MARGIN_BLOCKS)) {
        throw new InputError("orderId", `${tag} expires too soon to be moved. Cancel it and place a new one.`);
      }
      moved.add(a.orderId);
      if (a.pred === undefined && a.pred2 === undefined) needsHint.push(i);
    }
    local.set(a.orderId, { limitPrice: a.limitPrice, size: a.size });
  });

  const hinted = [...amends];
  await Promise.all(
    needsHint.map(async (i) => {
      const a = amends[i]!;
      const o = orders.get(a.orderId)!;
      let pred = await findPredecessor(ctx, pair, o.isLong, a.limitPrice);
      // The walk passes the order itself while it still rests: the slot behind it is then the slot
      // behind its own predecessor once it is unlinked.
      if (pred === a.orderId) pred = BigInt(o.prevInBook);
      hinted[i] = { ...a, pred: pred & MAX_UINT64 };
    }),
  );
  return { amends: hinted, words: encodeAmends(hinted), price, currentBlock };
}

/**
 * Amend resting Limit (GTC) orders in place: each gets a new price and total size and keeps its id,
 * expiry and integrator. A new price, or a larger size, sends the order to the back of its new
 * level; a smaller size at the same price keeps its place. All or nothing, except best-effort
 * amendments, which the pair skips (`OrderAmendSkipped`) when the order filled, was canceled or
 * expired, the size is at or below what filled or leaves under $5, or the price would cross. Margin
 * is judged once on the set the batch leaves. Up to 32 amendments.
 */
export async function amendOrders(ctx: BazaarContext, pair: Address, from: Address, amends: readonly AmendInput[]): Promise<PreparedCall> {
  encodeAmends(amends);
  pair = await requirePair(ctx, pair);
  const freshP = priceUpdateFor(ctx, pair);
  const prepP = prepareAmends(ctx, pair, from, amends, { price: freshP.then((f) => checkPrice(ctx, pair, f.update)) });
  const [fresh, prep] = await Promise.all([freshP, prepP]);
  const data = encodePairWrite({ action: "amendOrders", amends: prep.words }, { priceUpdate: fresh.update }, DIRECT_META);
  const n = amends.length;
  return {
    action: "amendOrders",
    to: pair,
    data,
    value: fresh.fee,
    from: getAddress(from),
    summary: n === 1 ? `Amend order #${amends[0]!.orderId} to ${px(amends[0]!.size)} at ${px(amends[0]!.limitPrice)}` : `Amend ${n} orders`,
    ...priceFields(fresh),
    pullsUsdc: 0n,
  };
}

// ---- cancellation ----

/** 1 to 200 distinct order ids, as cancelOrders takes them. */
export function checkCancelIds(orderIds: readonly bigint[]): void {
  if (orderIds.length === 0) throw new InputError("orderIds", "Choose at least one order to cancel.");
  if (orderIds.length > MAX_CANCELS_PER_CALL) throw new InputError("orderIds", `At most ${MAX_CANCELS_PER_CALL} orders can be canceled at once.`);
  const seen = new Set<bigint>();
  for (const id of orderIds) {
    if (id <= 0n) throw new InputError("orderIds", "That is not an order id.");
    if (seen.has(id)) throw new InputError("orderIds", `Order #${id} is listed twice.`);
    seen.add(id);
  }
}

/**
 * Cancel the trader's orders (up to 200): each is unlinked from the book in the same write and its
 * remaining keeper bounty returns to the trader's claimable balance (claimFees). An order that
 * already ended (filled, expired, auto-canceled) but still holds a bounty can be "canceled" to
 * reclaim it; one with nothing left is refused here, as the pair would refuse it. No margin gate.
 */
export async function cancelOrders(ctx: BazaarContext, pair: Address, from: Address, orderIds: readonly bigint[]): Promise<PreparedCall> {
  checkCancelIds(orderIds);
  const me = getAddress(from);
  pair = await requirePair(ctx, pair);
  const lc = lensCodec();
  const [orders, bounties, currentBlock] = await Promise.all([
    readOrders(ctx, pair, orderIds),
    ctx.chain.batch(orderIds.map((id) => ({ to: ctx.lens, data: lc.encode("triggerBounty", pair, id) }))),
    ctx.chain.blockNumber(),
  ]);
  let reclaim = 0;
  orderIds.forEach((id, i) => {
    const o = orders.get(id)!;
    if (o.creator === ZERO_ADDRESS) throw new InputError("orderIds", `Order #${id} does not exist.`);
    if (getAddress(o.creator) !== me) throw new InputError("orderIds", `Order #${id} is not yours.`);
    if (!isLive(o, currentBlock)) {
      const [ok, d] = bounties[i]!;
      const bounty = ok ? lc.decode<bigint>("triggerBounty", d) : 0n;
      if (bounty === 0n) {
        throw new InputError("orderIds", o.canceledBlock === 0n && o.filledBlock === 0n ? `Order #${id} has already expired.` : `Order #${id} is already closed.`);
      }
      reclaim++;
    }
  });
  const data = encodePairWrite({ action: "cancelOrders", orderIds }, {}, DIRECT_META);
  const what = orderIds.length === 1 ? `order #${orderIds[0]}` : `${orderIds.length} orders`;
  return {
    action: "cancelOrders",
    to: pair,
    data,
    value: 0n,
    from: me,
    summary: `Cancel ${what}${reclaim ? ` (reclaiming ${reclaim === 1 && orderIds.length === 1 ? "its" : `${reclaim}`} bounty)` : ""}`,
    pullsUsdc: 0n,
  };
}

// ---- fees ----

/**
 * Pay the caller everything the pair owes it: refunded trigger bounties, keeper rewards, relayer and
 * integrator fees. Always available, in any pair state. It has no gasless form: the caller pays gas.
 */
export async function claimFees(ctx: BazaarContext, pair: Address, from: Address): Promise<PreparedCall> {
  const lc = lensCodec();
  const me = getAddress(from);
  const to = await requirePair(ctx, pair);
  const { owed } = lc.decode<{ owed: bigint }>("claimableFees", await ctx.chain.call(ctx.lens, lc.encode("claimableFees", to, me)));
  if (owed === 0n) throw new InputError("pair", "You have nothing to claim on this market.");
  return { action: "claimFees", to, data: pairCodec().encode("claimFees"), value: 0n, from: me, summary: `Claim ${usdc(owed)} USDC`, pullsUsdc: 0n };
}

// ---- firing one's own trigger orders ----

/**
 * Fire the trader's own trigger orders (StopLimit, TakeProfit, StopLoss) whose trigger the live price
 * has reached: how a zero-bounty order is executed, by its owner. Up to 20 per call. Each must be
 * live and waiting outside the book; a StopLimit gets a hint for the slot it rests in. The pair
 * evaluates each trigger against the price this call carries and skips, without reverting, any that
 * is not eligible then; this builder refuses one the price has not reached. An execution of your own
 * order pays its bounty share to you.
 */
export async function executeTriggeredOrders(ctx: BazaarContext, pair: Address, from: Address, orderIds: readonly bigint[]): Promise<PreparedCall> {
  if (orderIds.length === 0) throw new InputError("orderIds", "Choose at least one order to execute.");
  if (orderIds.length > MAX_TRIGGER_EXECS_PER_CALL) throw new InputError("orderIds", `At most ${MAX_TRIGGER_EXECS_PER_CALL} orders can be executed at once.`);
  if (new Set(orderIds).size !== orderIds.length) throw new InputError("orderIds", "An order is listed twice.");
  const me = getAddress(from);
  pair = await requirePair(ctx, pair);
  const freshP = priceUpdateFor(ctx, pair);
  const [fresh, orders, currentBlock, spot] = await Promise.all([
    freshP,
    readOrders(ctx, pair, orderIds),
    ctx.chain.blockNumber(),
    freshP.then((f) => pairPriceFromUpdate(ctx, pair, f.update).catch(() => null)),
  ]);
  const execs = await Promise.all(
    orderIds.map(async (id) => {
      const o = orders.get(id)!;
      if (o.creator === ZERO_ADDRESS) throw new InputError("orderIds", `Order #${id} does not exist.`);
      if (getAddress(o.creator) !== me) throw new InputError("orderIds", `Order #${id} is not yours.`);
      if (!isTriggerType(o.orderType)) throw new InputError("orderIds", `Order #${id} is not a stop or take-profit order.`);
      if (!isLive(o, currentBlock)) throw new InputError("orderIds", `Order #${id} is no longer open.`);
      if (o.inBook) throw new InputError("orderIds", `Order #${id} has already been triggered and is resting in the book.`);
      if (spot && !triggerReached(o.orderType, o.isLong, o.triggerPrice, spot.spot)) {
        throw new InputError("orderIds", `Order #${id}'s trigger (${px(o.triggerPrice)}) has not been reached; the price is ${px(spot.spot)}.`);
      }
      const pred = o.orderType === STOP_LIMIT ? await findPredecessor(ctx, pair, o.isLong, o.limitPrice) : 0n;
      return { orderId: id, hints: { ...NO_HINTS, pred } };
    }),
  );
  return {
    action: "executeTriggeredOrders",
    to: pair,
    data: pairCodec().encode("executeTriggeredOrders", execs, fresh.update),
    value: fresh.fee,
    from: me,
    summary: orderIds.length === 1 ? `Execute your order #${orderIds[0]}` : `Execute ${orderIds.length} of your orders`,
    ...priceFields(fresh),
    pullsUsdc: 0n,
  };
}
