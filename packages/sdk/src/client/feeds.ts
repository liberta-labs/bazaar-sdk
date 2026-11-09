/**
 * A pair's Pyth feeds, and a fresh signed update for them with its fee.
 *
 * A pair prices off one feed, or a composite of two: `pair.baseFeedId()` names the pair's price id,
 * and `oracle.composites(id)` resolves a composite into its base and quote feeds. A call verifies only
 * its own pair's feeds, so the update carries exactly those.
 */

import type { Address, Hex } from "viem";
import { oracle as oracleCodec, pair as pairCodec } from "../chain/codec.js";
import { type BazaarContext, requirePrices } from "./context.js";

export interface PairFeeds {
  /** The pair's price id (a feed id, or a composite id). */
  readonly baseFeedId: Hex;
  /** The raw Pyth feeds: one, or base then quote for a composite. */
  readonly legs: readonly Hex[];
  readonly invertQuote: boolean;
}

const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const cache = new WeakMap<BazaarContext, Map<Address, Promise<PairFeeds>>>();

/** The pair's feeds. Cached per context: they never change for a deployed pair. */
export function pairFeeds(ctx: BazaarContext, pair: Address): Promise<PairFeeds> {
  let byPair = cache.get(ctx);
  if (!byPair) cache.set(ctx, (byPair = new Map()));
  let p = byPair.get(pair);
  if (!p) {
    p = loadFeeds(ctx, pair);
    p.catch(() => byPair!.delete(pair));
    byPair.set(pair, p);
  }
  return p;
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

export interface FreshUpdate {
  /** What the call's `priceUpdate: bytes[]` takes. */
  readonly update: Hex[];
  /** The Pyth fee to send as the call's value. */
  readonly fee: bigint;
  /** Oldest publish time among the pair's feeds (seconds). */
  readonly publishTime: number;
}

/** The freshest signed update for the pair's feeds, and the ETH fee the oracle charges to verify it. */
export async function priceUpdateFor(ctx: BazaarContext, pair: Address): Promise<FreshUpdate> {
  const feeds = await pairFeeds(ctx, pair);
  const { update, publishTime } = await requirePrices(ctx).latest(feeds.legs);
  const fee = await updateFee(ctx, update);
  return { update, fee, publishTime };
}

export async function updateFee(ctx: BazaarContext, update: readonly Hex[]): Promise<bigint> {
  if (!update.length) return 0n;
  const oc = oracleCodec();
  return oc.decode<bigint>("getUpdateFee", await ctx.chain.call(ctx.oracle, oc.encode("getUpdateFee", update)));
}
