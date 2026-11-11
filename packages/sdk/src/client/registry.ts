/**
 * Pyth Pro's symbols registry, as the client modules read it: which feed a number names, its asset
 * type, the fastest channel it is served on, its state and its schedule.
 *
 * The registry is public and lists every feed, so a listing is shared by every context reading the
 * same registry URL, and read again once it is {@link REGISTRY_TTL} seconds old. A read that fails, or
 * lists no feed, is not kept.
 */

import type { Hex } from "viem";
import { PYTH_PRO } from "../networks.js";
import { ProClient, type ProSymbol, monotonic } from "../prices/pro.js";
import { fetchFeedInfo } from "../prices/service.js";
import type { BazaarContext } from "./context.js";

/** Where feed symbols come from: a symbols registry's base URL, or anything that lists its entries. */
export interface SymbolSource {
  /** What its answers are cached under; a source without one is asked every time. */
  readonly base?: string;
  symbols(): Promise<ProSymbol[]>;
}

/** Seconds a registry listing is used before it is read again, so a feed listed meanwhile shows up. */
export const REGISTRY_TTL = 600;

interface Held {
  readonly listing: Promise<ProSymbol[]>;
  /** when it was read, on the cache's clock; null while the read is under way */
  at: number | null;
}

const registryCache = new Map<string, Held>();

/**
 * `src` with its listing cached under its base URL for `ttl` seconds (default {@link REGISTRY_TTL},
 * on a monotonic `clock`). A read that fails, or lists no feed, is not kept.
 * @internal
 */
export function cachedRegistry(src: string | SymbolSource, opts: { ttl?: number; clock?: () => number } = {}): SymbolSource {
  const client: SymbolSource = typeof src === "string" ? new ProClient({ symbolsUrl: src }) : src;
  const key = typeof src === "string" ? src.replace(/\/+$/, "") : (src.base ?? null);
  if (key === null) return client; // nothing to key a cache on: the caller's source caches, or not
  const ttl = opts.ttl ?? REGISTRY_TTL;
  const clock = opts.clock ?? monotonic;
  return {
    base: key,
    symbols() {
      const held = registryCache.get(key);
      if (held && (held.at === null || clock() - held.at < ttl)) return held.listing;
      const entry: Held = { listing: client.symbols(), at: null };
      registryCache.set(key, entry);
      entry.listing.then(
        (list) => {
          if (registryCache.get(key) !== entry) return;
          if (list.length === 0) registryCache.delete(key);
          else entry.at = clock();
        },
        () => {
          if (registryCache.get(key) === entry) registryCache.delete(key);
        },
      );
      return entry.listing;
    },
  };
}

/**
 * The symbols registry of the ProClient behind the context's price source, when the source exposes
 * one (a `proPriceSource`); null otherwise.
 * @internal
 */
export function contextRegistry(ctx: BazaarContext): SymbolSource | null {
  const c = (ctx.prices as { client?: unknown } | null)?.client;
  return c instanceof ProClient ? { base: c.symbolsUrl, symbols: () => c.symbols() } : null;
}

/**
 * Pyth Pro's registry entries for `feeds`: from `opt` when given; else from the registry of the
 * context's Pyth Pro source when it has one, and no other (a registry configured there may number its
 * feeds its own way, as a local chain's mock does, so Pyth's entries would name the wrong feeds);
 * else from Pyth's. Empty for `null`, and where the registry cannot be read.
 * @internal
 */
export async function feedInfoFor(ctx: BazaarContext, feeds: readonly Hex[], opt: string | SymbolSource | null | undefined): Promise<Map<Hex, ProSymbol>> {
  if (opt === null || feeds.length === 0) return new Map();
  if (opt !== undefined) return fetchFeedInfo(cachedRegistry(opt), feeds);
  return fetchFeedInfo(cachedRegistry(contextRegistry(ctx) ?? PYTH_PRO.symbolsUrl), feeds);
}
