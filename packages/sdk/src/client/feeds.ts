/**
 * A pair's Pyth Pro feeds, and a signed update for them that the oracle would accept, with its fee.
 *
 * A pair prices off one feed, or a composite of two: `pair.baseFeedId()` names the pair's price id,
 * and `oracle.composites(id)` resolves a composite into its base and quote feeds. A call reads only
 * its own pair's feeds, so the update is requested for exactly those, both legs of a composite in one.
 *
 * A call that carries an update is judged on it: the oracle verifies it and reverts the whole call
 * when it refuses the price (too old, too uncertain, incomplete). A call without one runs on the
 * pair's stored price while that is at most 3 s old and, on a market that is not continuously traded,
 * at any age where the call accepts an old price. So an update is attached only when the oracle would
 * accept it; otherwise a market that keeps trading hours gets none, and a continuously traded one,
 * which has no such fallback, fails here rather than in a transaction that must revert.
 *
 * A liquidation without an update never accepts a stored price older than 3 s. On a market that keeps
 * trading hours it reads an attached update as Pyth's latest price instead, so its update comes from
 * {@link liquidationUpdateFor}.
 */

import type { Address, Hex } from "viem";
import { oracle as oracleCodec, pair as pairCodec } from "../chain/codec.js";
import { MAX_PRICE_STALENESS } from "../constants.js";
import { pairPrice } from "../formulas/index.js";
import { MICROS_PER_SECOND, isRawFeedId, legEntries, proFeedId } from "../prices/lazer.js";
import { NoLivePriceError, ProError, whyNotLive } from "../prices/pro.js";
import { readLatestPrice } from "../prices/service.js";
import { type BazaarContext, requirePrices } from "./context.js";

export interface PairFeeds {
  /** The pair's price id (a feed id, or a composite id). */
  readonly baseFeedId: Hex;
  /** The raw Pyth Pro feed ids: one, or base then quote for a composite. */
  readonly legs: readonly Hex[];
  readonly invertQuote: boolean;
}

const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const cache = new WeakMap<BazaarContext, Map<Address, Promise<PairFeeds>>>();
const continuity = new WeakMap<BazaarContext, Map<Address, Promise<boolean>>>();

/** A value read once per pair per context, kept unless the read fails. */
function cached<T>(store: WeakMap<BazaarContext, Map<Address, Promise<T>>>, ctx: BazaarContext, pair: Address, load: () => Promise<T>): Promise<T> {
  let byPair = store.get(ctx);
  if (!byPair) store.set(ctx, (byPair = new Map()));
  let p = byPair.get(pair);
  if (!p) {
    p = load();
    p.catch(() => byPair!.delete(pair));
    byPair.set(pair, p);
  }
  return p;
}

/** The pair's feeds. Cached per context: they never change for a deployed pair. */
export function pairFeeds(ctx: BazaarContext, pair: Address): Promise<PairFeeds> {
  return cached(cache, ctx, pair, () => loadFeeds(ctx, pair));
}

async function loadFeeds(ctx: BazaarContext, pair: Address): Promise<PairFeeds> {
  const pc = pairCodec();
  const oc = oracleCodec();
  const baseFeedId = pc.decode<Hex>("baseFeedId", await ctx.chain.call(pair, pc.encode("baseFeedId")));
  const comp = oc.decode<{ baseId: Hex; quoteId: Hex; invertQuote: boolean }>(
    "composites",
    await ctx.chain.call(ctx.oracle, oc.encode("composites", baseFeedId)),
  );
  // As the keeper's Reader.describe: a registered composite has a non-zero base; anything else is a plain feed.
  if (comp.baseId.toLowerCase() === ZERO32) return { baseFeedId, legs: [baseFeedId], invertQuote: false };
  return { baseFeedId, legs: [comp.baseId, comp.quoteId], invertQuote: comp.invertQuote };
}

/** Whether the pair is continuously traded (`isContinuouslyTraded`). Cached per context: it is set when the pair is deployed. */
export function pairContinuous(ctx: BazaarContext, pair: Address): Promise<boolean> {
  return cached(continuity, ctx, pair, async () => {
    const pc = pairCodec();
    return pc.decode<boolean>("isContinuouslyTraded", await ctx.chain.call(pair, pc.encode("isContinuouslyTraded")));
  });
}

export interface FreshUpdate {
  /** What the call's `priceUpdate: bytes[]` takes; empty when no update is attached. */
  readonly update: Hex[];
  /** Pyth's verification fee to send as the call's value (wei); 0 when no update is attached. */
  readonly fee: bigint;
  /** The second the oldest of the pair's feeds' prices was generated in; null when no update is attached. */
  readonly publishTime: number | null;
  /** Whether an update is attached. */
  readonly attached: boolean;
  /**
   * Why no update is attached for want of one the oracle would accept; null when one is attached, and
   * when none was wanted (the caller asked for none, or the call reads no price).
   */
  readonly reason: string | null;
}

/**
 * No update the oracle would accept is available for a continuously traded market, which has no
 * stored-price fallback for an old price: a call that needs a price would revert now.
 */
export class NoFreshPriceError extends ProError {
  override readonly name: string = "NoFreshPriceError";
  constructor(
    readonly pair: Address,
    /** Why no update could be attached. */
    readonly reason: string,
  ) {
    super(`No fresh Pyth price is available for market ${pair} (${reason}): a call that needs one would revert, so try again shortly.`);
  }
}

/**
 * No update can decide a liquidation on a market that keeps trading hours now: there is no fresh
 * price, and Pyth's latest one is older than a liquidation accepts or would be refused by the oracle.
 * A call without an update runs only on a stored price at most 3 s old, which a market without a
 * fresh price seldom has: positions wait for the market's next price.
 */
export class NoLiquidationPriceError extends ProError {
  override readonly name: string = "NoLiquidationPriceError";
  constructor(
    readonly pair: Address,
    /** Why no update can be attached. */
    readonly reason: string,
  ) {
    super(`No price can decide a liquidation on market ${pair} now (${reason}): positions wait for its next price.`);
  }
}

/** A feed for a message: a raw Pyth Pro id as its number, anything else as its short hex. */
const feedText = (f: Hex) => (isRawFeedId(f) ? String(proFeedId(f)) : `${f.slice(0, 10)}…`);

/** The second the update's oldest leg price was generated in, or why the oracle would refuse it. */
function assess(update: readonly Hex[], feeds: Pick<PairFeeds, "legs" | "invertQuote">): { publishTime: number } | { problem: string } {
  if (update.length === 0) return { problem: "the price source returned no update" };
  let entries: ReturnType<typeof legEntries>;
  try {
    entries = legEntries(update, feeds.legs);
  } catch (e) {
    return { problem: `the price source's update cannot be read (${e instanceof Error ? e.message : String(e)})` };
  }
  const legs = [];
  for (let i = 0; i < feeds.legs.length; i++) {
    const e = entries[i];
    const name = feedText(feeds.legs[i]!);
    if (!e) return { problem: `no update carries feed ${name}` };
    const why = whyNotLive(e.feed);
    if (why !== null) return { problem: `feed ${name}: ${why}` };
    const behind = e.timestampUs - e.feed.feedUpdateTimestamp;
    if (behind > BigInt(MAX_PRICE_STALENESS) * MICROS_PER_SECOND) {
      return {
        problem: `feed ${name}'s price was generated ${behind / MICROS_PER_SECOND} s before the update carrying it: Pyth is carrying an older price forward (a closed venue, or a quiet feed)`,
      };
    }
    legs.push({ price: e.feed.price, conf: e.feed.confidence, expo: e.feed.exponent, publishTime: Number(e.feed.feedUpdateTimestamp / MICROS_PER_SECOND) });
  }
  const price = pairPrice(legs, feeds.invertQuote);
  if (price === null) return { problem: "the composed price is not above zero" };
  if (!price.confidenceOk) return { problem: "Pyth's confidence interval is wider than the oracle's 2% cap" };
  return { publishTime: Math.min(...legs.map((l) => l.publishTime)) };
}

/**
 * Why BazaarOracle would refuse `update` for these legs whenever the call carrying it lands, or null
 * when it would accept it in a block close enough to when its prices were generated. Each leg is read
 * as the oracle reads it (lazer.ts `legEntries`) and needs a usable live price (prices/pro.ts
 * `whyNotLive`) generated at most MAX_PRICE_STALENESS seconds before the update carrying it was
 * stamped. Both times are Pyth's: a price further behind is one Pyth carries forward (a closed venue,
 * a quiet feed), already too old for any block once the update exists. The composed price must clear
 * the 2% confidence cap. Whether the price is still fresh when the call lands is the caller's to
 * judge, by its generation time.
 */
export function updateProblem(update: readonly Hex[], feeds: Pick<PairFeeds, "legs" | "invertQuote">): string | null {
  const a = assess(update, feeds);
  return "problem" in a ? a.problem : null;
}

/**
 * A signed update for the pair's feeds that the oracle would accept ({@link updateProblem}), and the
 * ETH fee it charges to verify it. When the price source has none (its update would be refused, or it
 * has no live price for a feed): on a market that is not continuously traded, no update (`attached`
 * false, fee 0, `reason` saying why), so the call runs on the pair's stored price; on a continuously
 * traded market, a {@link NoFreshPriceError}. Any other failure of the source (unreachable, refused)
 * is thrown as it is. Not for a liquidation, which without an update never runs on a stored price older than 3 s:
 * {@link liquidationUpdateFor}.
 */
export async function priceUpdateFor(ctx: BazaarContext, pair: Address): Promise<FreshUpdate> {
  const source = requirePrices(ctx);
  const feeds = await pairFeeds(ctx, pair);
  let reason: string;
  try {
    const { update } = await source.latest(feeds.legs);
    const a = assess(update, feeds);
    if ("publishTime" in a) return { update, fee: await updateFee(ctx, update), publishTime: a.publishTime, attached: true, reason: null };
    reason = a.problem;
  } catch (e) {
    if (!(e instanceof NoLivePriceError)) throw e;
    reason = e.message;
  }
  if (await pairContinuous(ctx, pair)) throw new NoFreshPriceError(pair, reason);
  return { update: [], fee: 0n, publishTime: null, attached: false, reason };
}

/** The update a liquidation attaches ({@link liquidationUpdateFor}). */
export interface LiquidationPriceUpdate {
  /** What the call's `priceUpdate: bytes[]` takes: never empty. */
  readonly update: Hex[];
  /** Pyth's verification fee to send as the call's value (wei). */
  readonly fee: bigint;
  /**
   * "fresh": each leg's price was generated at most 3 s before the update carrying it was issued.
   * "latest": Pyth's latest price, older than that, on a market that keeps trading hours.
   */
  readonly kind: "fresh" | "latest";
  /** The second the older leg's price was generated in. */
  readonly publishTime: number;
  /**
   * The second the call must land within 3 s of: on a continuously traded market `publishTime`; on one
   * that keeps trading hours the second the update was issued in, fresh price or not, since the oracle
   * judges every update a liquidation there carries by when it was issued. Rebuild a call that would
   * land later.
   */
  readonly priceTime: number;
}

/**
 * The update a liquidation on `pair` attaches, and the ETH fee to verify it, as BazaarPair resolves a
 * liquidation's price. On a continuously traded market the price source's latest update for the pair's
 * feeds is attached when its price is fresh ({@link updateProblem} finds nothing). On a market that
 * keeps trading hours the oracle reads any update a liquidation carries as Pyth's latest price
 * (prices/service.ts `readLatestPrice`), fresh or not: it accepts the update when it was issued within
 * 3 s of the block and its price was generated at most a minute before it, which a price generated
 * MAX_LATEST_PRICE_LAG seconds or less before the update meets in any such block.
 *
 * A liquidation without an update never runs on a stored price older than 3 s, so this never returns an empty update. It
 * throws a {@link NoFreshPriceError} on a continuously traded market without a fresh price, a
 * {@link NoLiquidationPriceError} on one that keeps trading hours when Pyth's latest price cannot
 * decide the call either, and any other failure of the source as it is.
 */
export async function liquidationUpdateFor(ctx: BazaarContext, pair: Address): Promise<LiquidationPriceUpdate> {
  const source = requirePrices(ctx);
  const feeds = await pairFeeds(ctx, pair);
  const continuous = await pairContinuous(ctx, pair);
  let update: Hex[] = [];
  let fresh: { publishTime: number } | null = null;
  let reason = "";
  try {
    update = (await source.latest(feeds.legs)).update;
    const a = assess(update, feeds);
    if ("publishTime" in a) fresh = a;
    else reason = a.problem;
  } catch (e) {
    if (!(e instanceof NoLivePriceError)) throw e;
    reason = e.message;
  }
  if (continuous) {
    if (fresh === null) throw new NoFreshPriceError(pair, reason);
    return { update, fee: await updateFee(ctx, update), kind: "fresh", publishTime: fresh.publishTime, priceTime: fresh.publishTime };
  }
  if (update.length === 0) throw new NoLiquidationPriceError(pair, reason);
  const latest = readLatestPrice(update, feeds.legs, feeds.invertQuote);
  if ("problem" in latest) throw new NoLiquidationPriceError(pair, latest.problem);
  return { update, fee: await updateFee(ctx, update), kind: fresh === null ? "latest" : "fresh", publishTime: latest.price.publishTime, priceTime: latest.issuedAt };
}

/**
 * The ETH fee (wei) for having `update` verified: Pyth's fee per update times their number
 * (BazaarOracle.getUpdateFee). Zero for no updates, without a read.
 */
export async function updateFee(ctx: BazaarContext, update: readonly Hex[]): Promise<bigint> {
  if (!update.length) return 0n;
  const oc = oracleCodec();
  return oc.decode<bigint>("getUpdateFee", await ctx.chain.call(ctx.oracle, oc.encode("getUpdateFee", BigInt(update.length))));
}
