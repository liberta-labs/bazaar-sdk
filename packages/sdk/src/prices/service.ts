/** Live prints for every watched feed, and per-market prices and update payloads built from them. */

import type { Hex } from "viem";
import { ETH_USD_FEED, MAX_LIQUIDATION_PRICE_AGE, MAX_PRICE_STALENESS } from "../constants.js";
import { type Leg, type PairPrice, pairPrice } from "../formulas/index.js";
import type { Market } from "../models.js";
import { type LegEntry, MAX_FEEDS_PER_UPDATE, MICROS_PER_SECOND, isRawFeedId, legEntries, proFeedId, readUpdate } from "./lazer.js";
import { type Print, ProClient, ProError, type ProSymbol, STREAM_IDLE_TIMEOUT, type StreamOptions, monotonic, whyNotLive } from "./pro.js";

/** 'Crypto.BTC/USD' -> 'BTC/USD', 'Equity.US.AAPL/USD' -> 'AAPL/USD'. */
export function feedLabel(symbol: string | null | undefined): string {
  if (!symbol) return "";
  return symbol.slice(symbol.lastIndexOf(".") + 1);
}

/** A market's label from its legs' Pyth symbols; a composite (with a quote leg) is priced in USD. */
export function marketLabel(baseSymbol: string | null | undefined, quoteSymbol?: string | null): string {
  if (!baseSymbol) return "";
  const base = feedLabel(baseSymbol);
  if (quoteSymbol === null || quoteSymbol === undefined) return base;
  return `${base.split("/")[0]}/USD`;
}

/** Where a PriceService gets its prints: a {@link ProClient}, or anything shaped like one. */
export interface PriceSource {
  /** The latest prints for `ids`, all carried by one signed update. */
  latest(ids: readonly Hex[]): Promise<Print[]>;
  /**
   * Batches of prints, each set of `sets` streamed as updates that carry exactly that set, until the
   * connections drop; ends at once when `signal` aborts, and throws when no new update arrives for
   * `opts.idleTimeout` seconds.
   */
  stream(sets: readonly (readonly Hex[])[], signal?: AbortSignal, opts?: StreamOptions): AsyncIterable<Print[]>;
}

export interface PriceLogger {
  warn(message: string): void;
}

export interface PriceServiceOptions {
  /** follow the stream (falling back to polling when it fails); default true */
  stream?: boolean;
  /**
   * seconds the stream may bring no new update before it is dropped and reconnected like any failed
   * stream, with a warning; default 10, null or 0 to wait forever
   */
  streamIdleTimeout?: number | null;
  /** seconds between polls of `latest` when not streaming; default 1 */
  pollInterval?: number;
  /** the time freshness is judged at, in unix seconds; default the system clock */
  clock?: () => number;
  /** a print must be this many seconds younger than the 3 s limit to send; default 1 */
  sendMargin?: number;
  /**
   * seconds a print may be dated ahead of `clock` before it is ignored (with a warning, once per
   * feed); default 5. Without this, one print stamped far in the future would hold the feed until
   * a restart, since only a newer print replaces it.
   */
  maxFutureSkew?: number;
  /**
   * seconds after which {@link PriceService.ethUsd} stops trusting the newest ETH/USD print and
   * returns null (the keeper then prices gas at its `gas.ethUsdFallback`); default 60
   */
  ethUsdMaxAge?: number;
  /**
   * the range of ETH/USD prices {@link PriceService.ethUsd} accepts, as [min, max] dollars; outside
   * it, or not a finite number, it returns null; default [100, 1_000_000]. The ETH/USD print prices
   * gas without going through a contract, so nothing on chain verifies it: this only refuses absurd
   * ones.
   */
  ethUsdBounds?: readonly [min: number, max: number];
  /** where endpoint failures are reported; default `console`, null for silence */
  logger?: PriceLogger | null;
}

/** Default {@link PriceServiceOptions.maxFutureSkew}. */
export const MAX_FUTURE_SKEW = 5;
/** Default {@link PriceServiceOptions.ethUsdMaxAge}. */
export const ETH_USD_MAX_AGE = 60;
/** Default {@link PriceServiceOptions.ethUsdBounds}. */
export const ETH_USD_BOUNDS: readonly [min: number, max: number] = [100, 1_000_000];
/** Seconds a stream delivers before the watched feeds it has brought no print for are reported. */
const MISSING_AFTER = 30;
/**
 * How much later (in microseconds) another update's price for a leg must have been generated before
 * a market stops using its own set's update: one second, the unit the pair's freshness window counts in.
 */
export const SET_LAG_US = MICROS_PER_SECOND;
/** How many distinct stream notices are passed to the logger before the rest are dropped. */
const MAX_NOTICES = 256;
/**
 * Seconds a stream must have delivered for before it counts as healthy. One that ends by itself (every
 * endpoint dropped) sooner, or without delivering at all, is a failure like one that throws, so a
 * stream that keeps ending as soon as it starts is retried after a growing delay, not at once.
 */
const MIN_HEALTHY_STREAM = 10;
/**
 * Seconds a feed the request API refused, while it served the other feeds of the same poll, is left
 * out of the requests that poll it before it is asked for again.
 */
const REFUSED_RETRY = 300;
/** How many parts of a refused request are asked for at once. */
const SPLIT_BATCH = 8;

const short = (f: Hex) => `${f.slice(0, 10)}…`;

/** Called after each batch of prints with the feeds that got a newer print in it. */
export type PrintListener = (feeds: ReadonlySet<Hex>) => void;

/**
 * What a market's legs give while their prints stay the same: built on first use, and rebuilt as soon
 * as a newer print arrives for any leg or a newer update for the market's set.
 */
interface View {
  /** the legs it was built for, and their set's key */
  legs: readonly Hex[];
  key: string;
  /** the set's update and each leg's newest print when it was built: what it is checked against */
  own: readonly Print[] | undefined;
  newest: (Print | undefined)[];
  /** the prints it prices from, one per leg; null while a leg has none */
  prints: Print[] | null;
  invert: boolean;
  /** undefined until computed */
  price: PairPrice | null | undefined;
  update: Hex[] | undefined;
  /** why the oracle would refuse the updates the prints come in, null when it would not; undefined until computed */
  refused: string | null | undefined;
}

/** The key of a set of feeds: its lowercase ids, sorted. */
function setKey(feeds: readonly Hex[]): string {
  return feeds.length === 1 ? feeds[0]! : [...feeds].sort().join(",");
}

/**
 * Why BazaarOracle would refuse the updates `prints` come in for `legs` (one print per leg, in their
 * order), or null when it would read each leg's print. From one update the oracle reads each leg from
 * the entry its print came from. From several it reads each leg from whichever update holds the leg's
 * most recently generated price, complete or not (lazer.ts `legEntries`), so another update's later
 * entry for a leg, one that gave no print because it lacks a confidence say, is what it reads, and
 * refuses.
 */
function oracleRefusal(legs: readonly Hex[], prints: readonly Print[]): string | null {
  const blobs = distinctBlobs(prints);
  if (blobs.length < 2) return null;
  let entries: (LegEntry | null)[];
  try {
    entries = legEntries(blobs, legs);
  } catch (e) {
    return `an update cannot be read (${e instanceof Error ? e.message : String(e)})`;
  }
  for (let i = 0; i < legs.length; i++) {
    const e = entries[i];
    const p = prints[i]!;
    if (!e) return `no update carries feed ${short(legs[i]!)}`;
    const why = whyNotLive(e.feed);
    if (why !== null) return `the oracle would read feed ${short(legs[i]!)} from an entry where ${why}`;
    if (e.feed.feedUpdateTimestamp !== p.generatedUs || e.feed.price !== p.price || e.feed.confidence !== p.conf || e.feed.exponent !== p.expo) {
      return `the oracle would read feed ${short(legs[i]!)} from another update than its print's`;
    }
  }
  return null;
}

/**
 * `ids` in requests of at most {@link MAX_FEEDS_PER_UPDATE} feeds (the most one update carries),
 * sorted within each, every one of `sets` kept within one request where it fits, so a market's legs
 * still share an update.
 */
function inRequests(ids: readonly Hex[], sets: Iterable<readonly Hex[]>): Hex[][] {
  const wanted = new Set(ids);
  const placed = new Set<Hex>();
  const out: Hex[][] = [];
  let cur: Hex[] = [];
  const flush = () => {
    if (cur.length > 0) out.push(cur.sort());
    cur = [];
  };
  const place = (group: readonly Hex[]) => {
    const add = group.filter((f) => wanted.has(f) && !placed.has(f));
    if (cur.length + add.length > MAX_FEEDS_PER_UPDATE) flush();
    for (const f of add) {
      if (cur.length === MAX_FEEDS_PER_UPDATE) flush();
      cur.push(f);
      placed.add(f);
    }
  };
  for (const set of sets) place(set);
  for (const f of ids) place([f]);
  flush();
  return out;
}

/** A feed for a message: a raw Pyth Pro id as its number, anything else as its short hex. */
const feedText = (f: Hex) => (isRawFeedId(f) ? String(proFeedId(f)) : short(f));

/**
 * Seconds for a message: rounded up to the millisecond, so a time past a limit never prints as the
 * limit itself, without trailing zeros.
 */
const secs = (x: number) => String(Number((Math.ceil(x * 1000 - 1e-6) / 1000).toFixed(3)));

/**
 * The most seconds a liquidation's price may have been generated before the earliest update carrying
 * it was issued: the age the pair accepts for that price at the block (MAX_LIQUIDATION_PRICE_AGE) less
 * the 3 s the block may follow the update's issue (MAX_PRICE_STALENESS). A price within it is never too
 * old in a block the updates' own issue times admit.
 */
export const MAX_LATEST_PRICE_LAG = MAX_LIQUIDATION_PRICE_AGE - MAX_PRICE_STALENESS;

/**
 * Pyth's latest price for a market's legs, as BazaarOracle.verifyAndFetchLatestPrice reads it out of the
 * updates that carry it: what a liquidation on a market with trading hours is judged at when no fresh
 * price exists.
 */
export interface LatestPrice {
  /** The signed updates a call attaches, in order: normally one, carrying every leg. */
  readonly update: Hex[];
  /**
   * The second the earliest of the updates was issued in (its own timestamp, in whole seconds). The
   * oracle refuses the call unless every update was issued within 3 s of the block's time, either way.
   * The updates were issued no more than 3 s apart, so a call landing from this second to 3 s after it
   * meets that for each of them.
   */
  readonly issuedAt: number;
  /** The second each leg's price was generated in, in the legs' order (base first for a composite). */
  readonly generated: readonly number[];
  /**
   * The price the oracle composes from the legs. Its `publishTime`, the older leg's generation second,
   * is what the pair stores the price under when it is newer than the one it holds.
   */
  readonly price: PairPrice;
}

/**
 * Pyth's latest price for `legs` (raw feed ids, base first) as BazaarOracle.verifyAndFetchLatestPrice
 * reads it out of `update`, or why the oracle would refuse it in any block. Each leg is read from the
 * update holding its most recently generated price (lazer.ts `legEntries`) and needs a usable live
 * price (prices/pro.ts `whyNotLive`), and the composed price must clear the 2% confidence cap: a wider
 * latest price is refused, never passed over for an older one.
 *
 * No block time is known here, so the updates are held to having been issued no more than 3 s apart,
 * and each leg's price to having been generated no more than {@link MAX_LATEST_PRICE_LAG} seconds
 * before the earliest update was issued and no later than the second the newest one was. In any block
 * within 3 s of every update's issue time (the oracle's own check, which the caller judges by
 * `issuedAt`) the price is then at most MAX_LIQUIDATION_PRICE_AGE seconds old and at most 3 s ahead,
 * the bounds the oracle holds each leg to.
 */
export function readLatestPrice(update: readonly Hex[], legs: readonly Hex[], invertQuote: boolean): LatestPrice | { readonly problem: string } {
  if (update.length === 0) return { problem: "no update was given" };
  const issued: number[] = [];
  let entries: (LegEntry | null)[];
  try {
    for (const u of update) issued.push(Number(readUpdate(u).timestampUs / MICROS_PER_SECOND));
    entries = legEntries(update, legs);
  } catch (e) {
    return { problem: `an update cannot be read (${message(e)})` };
  }
  const first = Math.min(...issued);
  const last = Math.max(...issued);
  if (last - first > MAX_PRICE_STALENESS) return { problem: `the updates were issued ${last - first} s apart, more than the pair's ${MAX_PRICE_STALENESS} s window` };
  const one = update.length === 1;
  const generated: number[] = [];
  const read: Leg[] = [];
  for (let i = 0; i < legs.length; i++) {
    const e = entries[i];
    const name = feedText(legs[i]!);
    if (!e) return { problem: `no update carries feed ${name}` };
    const why = whyNotLive(e.feed);
    if (why !== null) return { problem: `feed ${name}: ${why}` };
    const gen = Number(e.feed.feedUpdateTimestamp / MICROS_PER_SECOND);
    if (gen > last) return { problem: `feed ${name}'s price is dated ${gen - last} s after ${one ? "the update carrying it was" : "the updates were"} issued` };
    if (first - gen > MAX_LATEST_PRICE_LAG) {
      return {
        problem: `feed ${name}'s latest price was generated ${first - gen} s before ${one ? "the update carrying it" : "the earliest of the updates"} was issued, more than the ${MAX_LATEST_PRICE_LAG} s that keeps it within the ${MAX_LIQUIDATION_PRICE_AGE} s a liquidation's price may be old`,
      };
    }
    generated.push(gen);
    read.push({ price: e.feed.price, conf: e.feed.confidence, expo: e.feed.exponent, publishTime: gen });
  }
  const price = pairPrice(read, invertQuote);
  if (price === null) return { problem: "the composed price is not above zero" };
  if (!price.confidenceOk) return { problem: "Pyth's confidence interval for the latest price is wider than the oracle's 2% cap" };
  return { update: [...update], issuedAt: first, generated, price };
}

/** What a liquidation on a market can attach now ({@link PriceService.liquidationUpdate}). */
export interface LiquidationUpdate {
  /**
   * "fresh": every leg's price was generated within the pair's 3 s window, as any priced call needs.
   * "latest": Pyth's latest price, proven by when the updates carrying it were issued (a market with
   * trading hours only). null: nothing can be attached now.
   */
  readonly kind: "fresh" | "latest" | null;
  /** The signed updates to attach; empty when `kind` is null. */
  readonly update: Hex[];
  /** The price the oracle reads from them, composed as it composes it; null when `kind` is null. */
  readonly price: PairPrice | null;
  /** The second each leg's price was generated in, base first; empty when `kind` is null. */
  readonly generated: readonly number[];
  /**
   * The second the call must land within 3 s of: the older leg's generation second for a fresh price,
   * so the call is sent only while that price is fresh; the earliest update's issue second for Pyth's
   * latest; null when `kind` is null.
   */
  readonly priceTime: number | null;
  /** Why nothing can be attached; null when something can. */
  readonly reason: string | null;
}

const noLiquidation = (reason: string): LiquidationUpdate => ({ kind: null, update: [], price: null, generated: [], priceTime: null, reason });

/** When a print's price was generated: what a feed's newest price is chosen by. */
const generatedAt = (p: Print) => p.generatedUs;
/** When a print's update was issued: what Pyth's latest price, for a liquidation, is chosen by. */
const issuedAt = (p: Print) => p.timestampUs;

export class PriceService {
  readonly client: PriceSource | null;
  useStream: boolean;
  /** seconds of silence after which the stream is dropped and reconnected; null to wait forever */
  streamIdleTimeout: number | null;
  pollInterval: number;
  clock: () => number;
  /** a print must be this much younger than the 3 s limit to send */
  sendMargin: number;
  /** seconds a print may be dated ahead of `clock` before it is ignored */
  maxFutureSkew: number;
  /** seconds after which ethUsd() stops trusting the ETH/USD print */
  ethUsdMaxAge: number;
  /** the ETH/USD prices ethUsd() accepts, [min, max] */
  ethUsdBounds: readonly [min: number, max: number];
  /** Every watched feed. */
  readonly feeds = new Set<Hex>([ETH_USD_FEED]);
  /** Each feed's most recently generated print, whichever update brought it. */
  readonly latest = new Map<Hex, Print>();
  healthy = false;
  lastError = "";
  /** when a print last arrived, in seconds on a monotonic clock (`performance.now() / 1000`) */
  lastUpdate = 0;

  private readonly logger: PriceLogger | null;
  /** the watched sets by key: each is streamed as updates that carry exactly its feeds */
  private readonly sets = new Map<string, Hex[]>([[ETH_USD_FEED, [ETH_USD_FEED]]]);
  /** per watched set, the prints of the freshest update that carried a live print for each of its feeds */
  private readonly updates = new Map<string, readonly Print[]>();
  /** Each feed's print from the most recently issued update that carried a live print for it. */
  private readonly issued = new Map<Hex, Print>();
  /** The newest ETH/USD print whose signer is confirmed, or that needs no check: what ethUsd() reads. */
  private ethUsdPrint: Print | null = null;
  /** per watched set, the prints of the most recently issued update that carried a live print for each of its feeds */
  private readonly issuedUpdates = new Map<string, readonly Print[]>();
  private readonly notices = new Set<string>(); // stream notices already logged
  private changed = false; // the watched sets changed: restart the stream
  private newFeeds = new Set<Hex>(); // feeds with a print newer than the last nextPrints() handed out
  private printed: Promise<void> | null = null;
  private wakePrinted: (() => void) | null = null;
  private stopped = false;
  private streamCtl: AbortController | null = null;
  private readonly sleepers = new Set<() => void>();
  private readonly listeners = new Set<PrintListener>();
  private readonly views = new WeakMap<Market, View>();
  private readonly warnedFuture = new Set<Hex>(); // feeds already warned about, once each
  private readonly warnedMissing = new Set<Hex>();
  /** Feeds the request API refused while it served others, each with the monotonic time it is asked for again. */
  private readonly refused = new Map<Hex, number>();
  /** The monotonic time before which a refused request is not split again, after a split that served nothing. */
  private splitAfter = 0;

  constructor(client: PriceSource | null, opts: PriceServiceOptions = {}) {
    this.client = client;
    this.useStream = opts.stream ?? true;
    this.streamIdleTimeout = opts.streamIdleTimeout === undefined ? STREAM_IDLE_TIMEOUT : opts.streamIdleTimeout;
    this.pollInterval = opts.pollInterval ?? 1.0;
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
    this.sendMargin = opts.sendMargin ?? 1.0;
    this.maxFutureSkew = opts.maxFutureSkew ?? MAX_FUTURE_SKEW;
    this.ethUsdMaxAge = opts.ethUsdMaxAge ?? ETH_USD_MAX_AGE;
    this.ethUsdBounds = opts.ethUsdBounds ?? ETH_USD_BOUNDS;
    this.logger = opts.logger === undefined ? console : opts.logger;
  }

  // ---- feeds ----

  /** Watch each of `feeds` on its own: its updates carry that feed alone. */
  watch(feeds: Iterable<Hex>): void {
    const sets: Hex[][] = [];
    for (const f of feeds) sets.push([f]);
    this.watchSets(sets);
  }

  /**
   * Watch each of `sets` as one: the signed updates streamed for a set carry exactly its feeds, so a
   * composite's two legs watched together arrive in one update. A set already watched is left alone.
   */
  watchSets(sets: Iterable<readonly Hex[]>): void {
    let added = false;
    for (const set of sets) {
      const ids = [...new Set(set.map((f) => f.toLowerCase() as Hex))];
      if (ids.length === 0) continue;
      const key = setKey(ids);
      if (this.sets.has(key)) continue;
      this.sets.set(key, ids);
      for (const id of ids) this.feeds.add(id);
      added = true;
    }
    if (added) {
      this.changed = true;
      this.streamCtl?.abort(); // resubscribe now, with the new sets
    }
  }

  /** Watch each market's legs as one set. */
  watchMarkets(markets: Iterable<Market>): void {
    const sets: Hex[][] = [];
    for (const m of markets) sets.push(m.legs);
    this.watchSets(sets);
  }

  /**
   * Take in prints from any source (the background loop, {@link fetch}, or a caller's own): one
   * whose price was generated later than the feed's current print replaces it and wakes
   * {@link nextPrints} and the {@link onPrints} listeners. A print that only carries the same price
   * forward under a later update changes nothing there, but is kept as the feed's most recently
   * issued one ({@link latestFor}). A print whose price, or whose update, is dated more than
   * {@link maxFutureSkew} seconds ahead of the clock is ignored, with a warning once per feed.
   *
   * The endpoint's prints (the background loop's and {@link fetch}'s) are kept only for the feeds
   * asked for, so a response naming other feeds cannot grow memory; a caller's own are taken as given.
   */
  ingest(prints: readonly Print[]): void {
    this.take(prints, null);
  }

  /** {@link ingest}, keeping only the prints of `only` when given. */
  private take(prints: readonly Print[], only: ReadonlySet<Hex> | null): void {
    let batch: Set<Hex> | null = null;
    let fresh: Print[] | null = null; // the prints not dated ahead of the clock
    const limit = prints.length > 0 ? this.clock() + this.maxFutureSkew : 0;
    for (const p of prints) {
      if (only !== null && !only.has(p.feedId)) continue;
      // An update stamped far ahead would hold the feed's most recently issued print until that time.
      const dated = Math.max(p.publishTime, Number(p.timestampUs / MICROS_PER_SECOND));
      if (dated > limit) {
        this.future(p, dated, limit - this.maxFutureSkew);
        continue;
      }
      const cur = this.latest.get(p.feedId);
      if (cur === undefined || p.generatedUs > cur.generatedUs) {
        this.newFeeds.add(p.feedId);
        if (this.listeners.size > 0) (batch ??= new Set()).add(p.feedId);
        this.latest.set(p.feedId, p);
        if (p.feedId === ETH_USD_FEED) this.confirmEthUsd(p);
      }
      const was = this.issued.get(p.feedId);
      if (was === undefined || p.timestampUs > was.timestampUs) this.issued.set(p.feedId, p);
      (fresh ??= []).push(p);
    }
    if (fresh !== null) this.takeUpdates(fresh);
    if (prints.length > 0) {
      this.healthy = true;
      this.lastUpdate = monotonic();
    }
    if (this.newFeeds.size > 0) this.notify();
    if (batch !== null) {
      for (const listener of this.listeners) {
        try {
          listener(batch);
        } catch (e) {
          this.logger?.warn(`price listener failed: ${message(e)}`);
        }
      }
    }
  }

  /**
   * Keep, per watched set, the updates that carry a live print for each of its feeds and nothing
   * else: the prints of `prints` that share a signed update are one candidate. The freshest is taken
   * when no leg's price is older than the kept one's and some leg's is newer; the most recently issued
   * when it was issued later than the kept one.
   */
  private takeUpdates(prints: readonly Print[]): void {
    for (let i = 0; i < prints.length; i++) {
      const blob = prints[i]!.blob;
      let first = true;
      for (let j = 0; j < i && first; j++) first = prints[j]!.blob !== blob;
      if (!first) continue; // grouped with the first print that came in it
      const group: Print[] = [];
      for (let j = i; j < prints.length; j++) if (prints[j]!.blob === blob) group.push(prints[j]!);
      const key = setKey(group.map((p) => p.feedId));
      if (!this.sets.has(key)) continue;
      const was = this.issuedUpdates.get(key);
      if (was === undefined || group[0]!.timestampUs > was[0]!.timestampUs) this.issuedUpdates.set(key, group);
      const cur = this.updates.get(key);
      if (cur !== undefined) {
        let newer = false;
        let older = false;
        for (const p of group) {
          const c = cur.find((x) => x.feedId === p.feedId);
          if (c === undefined || p.generatedUs > c.generatedUs) newer = true;
          else if (p.generatedUs < c.generatedUs) older = true;
        }
        if (!newer || older) continue;
      }
      this.updates.set(key, group);
    }
  }

  /**
   * Wait for a print newer than any handed out before, and return the feeds that have one.
   *
   * A feed counts once per call however many prints arrived for it meanwhile: the caller reads the
   * newest from `latest`. Returns an empty set once the service is stopped. Meant for one consumer
   * (the keeper's print loop); for several, use {@link onPrints}.
   */
  async nextPrints(): Promise<Set<Hex>> {
    while (this.newFeeds.size === 0 && !this.stopped) {
      this.printed ??= new Promise<void>((resolve) => {
        this.wakePrinted = resolve;
      });
      await this.printed;
    }
    const out = this.newFeeds;
    this.newFeeds = new Set();
    return out;
  }

  /**
   * Call `listener` synchronously after each batch of prints that brings a newer print for some feed,
   * with those feeds (one set, shared by every listener: do not keep or change it). Returns the
   * function that removes the listener.
   */
  onPrints(listener: PrintListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The latest prints, outside the background loop: of `feeds` (lowercase), or the watched ones. One
   * request per {@link MAX_FEEDS_PER_UPDATE} feeds, each watched set within one request where it
   * fits, and a refused one asked again in parts. A feed the endpoint serves no print for is reported,
   * once.
   */
  async fetch(feeds?: Iterable<Hex> | null): Promise<void> {
    const ids = [...new Set(feeds ? [...feeds].map((f) => f.toLowerCase() as Hex) : this.feeds)].sort();
    if (ids.length === 0) return;
    await this.poll(this.source(), inRequests(ids, this.sets.values()), new Set(ids));
    this.reportMissing(ids);
  }

  /**
   * Ask for each request's latest prints at once and take them (only `keep`'s); the first failure is
   * thrown once the others are taken.
   *
   * Pyth's request API refuses a whole request (HTTP 403) that names one feed it does not know or the
   * token does not cover, so a refused request of several feeds is asked again in parts,
   * {@link SPLIT_BATCH} at a time: each watched set of two or more feeds inside it, then each other
   * feed alone, and a refused set's feeds alone. A feed still refused while others were served is
   * logged once and left out of these requests for {@link REFUSED_RETRY} seconds: it has no print
   * meanwhile, which {@link reportMissing} reports. When nothing was served the refusal is the poll's
   * failure, as for a token refused on every feed, and a refused request is not split again for
   * {@link REFUSED_RETRY} seconds, so such a token costs one request per poll, not one per feed.
   */
  private async poll(source: PriceSource, requests: readonly Hex[][], keep: ReadonlySet<Hex>): Promise<void> {
    const now = monotonic();
    const asked = requests.map((r) => r.filter((f) => !((this.refused.get(f) ?? 0) > now))).filter((r) => r.length > 0);
    const failures: unknown[] = [];
    const refusals: { feeds: readonly Hex[]; reason: unknown }[] = [];
    const got = { served: false, split: false };
    const ask = async (rs: readonly (readonly Hex[])[], depth: number): Promise<void> => {
      const size = depth === 0 ? rs.length : SPLIT_BATCH;
      for (let start = 0; start < rs.length; start += size) {
        const batch = rs.slice(start, start + size);
        const results = await Promise.allSettled(batch.map((r) => source.latest(r)));
        const parts: Hex[][] = [];
        for (let i = 0; i < batch.length; i++) {
          const r = results[i]!;
          const feeds = batch[i]!;
          if (r.status === "fulfilled") {
            this.take(r.value, keep);
            got.served = true;
          } else if (!(r.reason instanceof ProError && r.reason.status === 403)) failures.push(r.reason);
          else if (feeds.length > 1 && depth < 2 && now >= this.splitAfter) parts.push(...(depth === 0 ? this.parts(feeds) : feeds.map((f) => [f])));
          else refusals.push({ feeds, reason: r.reason });
        }
        if (parts.length > 0) {
          got.split = true;
          await ask(parts, depth + 1);
        }
      }
    };
    await ask(asked, 0);
    if (got.served) {
      this.splitAfter = 0;
      // Recorded before any other failure is thrown, so the next poll leaves these feeds out.
      for (const { feeds, reason } of refusals) {
        if (feeds.length !== 1) continue; // a request not split: its feeds are asked for again
        this.refused.set(feeds[0]!, now + REFUSED_RETRY);
        this.onNotice(
          `price endpoint refused feed ${feedText(feeds[0]!)} while serving the others: left out of its requests for ${REFUSED_RETRY / 60} min (${message(reason)})`,
        );
      }
    } else if (got.split) this.splitAfter = now + REFUSED_RETRY;
    if (failures.length > 0) throw failures[0];
    if (!got.served && refusals.length > 0) throw refusals[0]!.reason;
  }

  /**
   * A refused request's parts, to ask for again: each watched set of two or more feeds inside it, then
   * each other feed alone. A request that is one watched set is split into its feeds.
   */
  private parts(request: readonly Hex[]): Hex[][] {
    const inRequest = new Set(request);
    const covered = new Set<Hex>();
    const seen = new Set<string>();
    const out: Hex[][] = [];
    for (const set of this.sets.values()) {
      if (set.length < 2 || set.length >= request.length || !set.every((f) => inRequest.has(f))) continue;
      const part = [...set].sort();
      if (seen.has(part.join())) continue;
      seen.add(part.join());
      out.push(part);
      for (const f of part) covered.add(f);
    }
    for (const f of request) if (!covered.has(f)) out.push([f]);
    return out;
  }

  /** The watched feeds without any print yet (one the endpoint does not serve stays here). */
  missing(): Hex[] {
    const out: Hex[] = [];
    for (const f of this.feeds) if (!this.latest.has(f)) out.push(f);
    return out;
  }

  /** Warn, once per feed, about each of `ids` without a print. */
  private reportMissing(ids: readonly Hex[]): void {
    for (const f of ids) {
      if (this.latest.has(f) || this.warnedMissing.has(f)) continue;
      this.warnedMissing.add(f);
      this.logger?.warn(
        `price endpoint sent no print for feed ${f}: markets on it get no price until it does (check the feed id, that the token covers the feed and that the feed is served on this channel; a feed Pyth has no price or no confidence for has none). Other feeds are unaffected.`,
      );
    }
  }

  /** Warn, once per feed, about a print dated (its price or its update) `dated`, ahead of the clock. */
  private future(p: Print, dated: number, now: number): void {
    if (this.warnedFuture.has(p.feedId)) return;
    this.warnedFuture.add(p.feedId);
    this.logger?.warn(
      `ignored a print for feed ${short(p.feedId)} dated ${dated - now} s ahead of the clock (more than ${this.maxFutureSkew} s): check the price endpoint, or this machine's clock`,
    );
  }

  /**
   * Follow the stream (or poll) until {@link stop}, through any endpoint failure. A stream that throws,
   * or ends by itself before it has delivered for {@link MIN_HEALTHY_STREAM} seconds, is a failure: it
   * is retried after a delay that doubles with each failure in a row (up to 30 s), and three in a row
   * mark the service unhealthy and switch a streaming service to polling for a minute. Never rejects.
   */
  async run(): Promise<void> {
    let failures = 0;
    let pollUntil = 0;
    while (!this.stopped) {
      const ids = [...this.feeds].sort();
      const sets = [...this.sets.values()];
      this.changed = false;
      try {
        const source = this.source();
        if (this.useStream && monotonic() >= pollUntil) {
          const ctl = new AbortController();
          this.streamCtl = ctl;
          const since = monotonic();
          let delivered = false;
          let checked = false;
          try {
            // A stream gone quiet throws: counted below as a failure.
            for await (const prints of source.stream(sets, ctl.signal, { idleTimeout: this.streamIdleTimeout, onNotice: this.onNotice })) {
              this.take(prints, this.feeds);
              delivered = true;
              if (monotonic() - since >= MIN_HEALTHY_STREAM) failures = 0;
              if (!checked && this.lastUpdate - since >= MISSING_AFTER) {
                checked = true; // the stream has delivered a while: the feeds it never brought are reported
                this.reportMissing(ids);
              }
              if (this.changed || this.stopped) break;
            }
          } catch (e) {
            if (!ctl.signal.aborted) throw e; // aborted by watch() or stop(): not a failure
          } finally {
            if (this.streamCtl === ctl) this.streamCtl = null;
          }
          if (!ctl.signal.aborted && !this.changed && !this.stopped) {
            const lived = monotonic() - since;
            if (!delivered || lived < MIN_HEALTHY_STREAM) {
              throw new ProError(`price stream ended after ${lived.toFixed(1)} s${delivered ? "" : " without delivering an update"}`);
            }
            failures = 0;
          }
          await this.sleep(0.2);
        } else {
          await this.poll(source, inRequests(ids, sets), this.feeds);
          this.reportMissing(ids);
          await this.sleep(this.pollInterval);
        }
      } catch (e) {
        failures += 1;
        this.lastError = message(e);
        if (failures >= 3) this.healthy = false;
        if (this.useStream && failures >= 3) pollUntil = monotonic() + 60; // fall back to polling for a minute
        this.logger?.warn(`price endpoint: ${this.lastError}`);
        await this.sleep(Math.min(30, 0.5 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  /** End {@link run} (at once, closing its stream) and release {@link nextPrints}. */
  stop(): void {
    this.stopped = true;
    this.changed = true;
    this.notify();
    this.streamCtl?.abort();
    for (const wake of [...this.sleepers]) wake();
  }

  private source(): PriceSource {
    if (this.client === null) throw new ProError("this PriceService has no price source");
    return this.client;
  }

  /** Log a stream's notice, once per distinct message. */
  private readonly onNotice = (message: string): void => {
    if (this.notices.has(message) || this.notices.size >= MAX_NOTICES) return;
    this.notices.add(message);
    this.logger?.warn(message);
  };

  private notify(): void {
    const wake = this.wakePrinted;
    if (wake !== null) {
      this.printed = null;
      this.wakePrinted = null;
      wake();
    }
  }

  /** Wait `seconds`, or less if the service stops meanwhile. */
  private sleep(seconds: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, seconds * 1000);
      this.sleepers.add(wake);
    });
  }

  // ---- per market ----

  /**
   * The market's view: the cached one while its set's update and each leg's newest print are the
   * ones it was built from, else rebuilt in place; null while a leg has no print.
   *
   * A market prices from its own set's update, the one signed update that carries exactly its legs,
   * so a call attaches one update and pays one verification fee. It falls back to each leg's newest
   * print, one update per leg, only while its set has no update or another update holds a price for
   * one of its legs generated a second or more later (the set's subscription is lagging).
   */
  private view(m: Market): View | null {
    const legs = m.legs;
    let v = this.views.get(m);
    if (v === undefined || v.legs.length !== legs.length || v.legs.some((l, i) => l !== legs[i])) {
      v = { legs: [...legs], key: setKey(legs), own: undefined, newest: [], prints: null, invert: m.invertQuote, price: undefined, update: undefined, refused: undefined };
      v.newest.length = legs.length + 1; // a length no built view has: forces the first build
      this.views.set(m, v);
    }
    const own = this.updates.get(v.key);
    let same = v.own === own && v.invert === m.invertQuote && v.newest.length === legs.length;
    for (let i = 0; same && i < legs.length; i++) same = this.latest.get(legs[i]!) === v.newest[i];
    if (same) return v.prints === null ? null : v;

    v.own = own;
    v.newest.length = legs.length;
    for (let i = 0; i < legs.length; i++) v.newest[i] = this.latest.get(legs[i]!);
    v.invert = m.invertQuote;
    v.price = undefined;
    v.update = undefined;
    v.refused = undefined;
    v.prints = this.select(legs, own, v.newest, generatedAt);
    return v.prints === null ? null : v;
  }

  /**
   * The prints `legs` price from, given their set's update and each leg's newest print by `at` (when
   * its price was generated, or when its update was issued): the set's own, unless it lacks a leg or
   * lags one by {@link SET_LAG_US}; else the newest per leg; null while a leg has none.
   */
  private select(legs: readonly Hex[], own: readonly Print[] | undefined, newest: readonly (Print | undefined)[], at: (p: Print) => bigint): Print[] | null {
    if (own !== undefined) {
      const mine: Print[] = [];
      for (let i = 0; i < legs.length; i++) {
        const p = own.find((x) => x.feedId === legs[i]);
        const other = newest[i];
        if (p === undefined || (other !== undefined && at(other) - at(p) >= SET_LAG_US)) break;
        mine.push(p);
      }
      if (mine.length === legs.length) return mine;
    }
    const out: Print[] = [];
    for (const p of newest) {
      if (p === undefined) return null;
      out.push(p);
    }
    return out;
  }

  /**
   * The prints a call reading `feeds` together would attach, one per feed in the order given: those
   * of the set's own update when `feeds` is a watched set that has one, else each feed's newest
   * print. Null while a feed has no print, and while the oracle would refuse the updates those prints
   * come in (see {@link fresh}).
   */
  printsFor(feeds: readonly Hex[]): Print[] | null {
    const legs = feeds.map((f) => f.toLowerCase() as Hex);
    if (legs.length === 0) return [];
    const prints = this.select(legs, this.updates.get(setKey(legs)), legs.map((l) => this.latest.get(l)), generatedAt);
    return prints !== null && oracleRefusal(legs, prints) === null ? prints : null;
  }

  private priceOf(v: View): PairPrice | null {
    if (v.price === undefined) v.price = pairPrice(v.prints!, v.invert);
    return v.price;
  }

  private refusal(v: View): string | null {
    if (v.refused === undefined) v.refused = oracleRefusal(v.legs, v.prints!);
    return v.refused;
  }

  /** The prints the market prices from, one per leg (base first for a composite); null while a leg has none. */
  legs(m: Market): Print[] | null {
    const v = this.view(m);
    return v === null ? null : v.prints!.slice();
  }

  price(m: Market): PairPrice | null {
    const v = this.view(m);
    return v === null ? null : this.priceOf(v);
  }

  /**
   * Whether every leg's price was generated recently enough to send now and clears the confidence
   * cap, and the oracle would read those prices from the updates {@link updateFor} attaches. Judged
   * on the second each price was generated in, as the pair judges it: a price carried forward under a
   * later update is as old as when it was generated.
   */
  fresh(m: Market, now?: number | null, margin?: number | null): boolean {
    const v = this.view(m);
    if (v === null) return false;
    const t = now ?? this.clock();
    const limit = MAX_PRICE_STALENESS - (margin ?? this.sendMargin);
    for (const p of v.prints!) if (Math.abs(t - p.publishTime) > limit) return false;
    const pp = this.priceOf(v);
    return pp !== null && pp.confidenceOk && this.refusal(v) === null;
  }

  /** No price generated for `after` seconds while the endpoint is otherwise delivering: a closed session. */
  closed(m: Market, now?: number | null, after = 15): boolean {
    const v = this.view(m);
    const t = now ?? this.clock();
    if (v === null) return this.healthy;
    return this.healthy && v.prints!.some((p) => t - p.publishTime > after);
  }

  /**
   * The signed updates a call on this market attaches: the one update that carries its legs, or one
   * per leg while its set has none of its own (see {@link view}). Empty while a leg has no print, and
   * while the oracle would read a leg from another of those updates than its print's and refuse it.
   */
  updateFor(m: Market): Hex[] {
    const v = this.view(m);
    if (v === null || this.refusal(v) !== null) return [];
    v.update ??= distinctBlobs(v.prints!);
    return v.update.slice();
  }

  /**
   * The prints of the most recently issued update the service holds for the market's legs, one per leg
   * (base first for a composite), however old their prices: the market's own set's update, unless it
   * lacks a leg or another update carrying one was issued a second or more later; else each leg's most
   * recently issued print. A print's `timestampUs` is when its update was issued, its `generatedUs`
   * when its price was generated. Null while a leg has none. Whether a liquidation can attach them is
   * {@link liquidationUpdate}'s to judge.
   */
  latestFor(m: Market): Print[] | null {
    const legs = m.legs.map((l) => l.toLowerCase() as Hex);
    return this.select(legs, this.issuedUpdates.get(setKey(legs)), legs.map((l) => this.issued.get(l)), issuedAt);
  }

  /**
   * The update a liquidation on the market attaches now, and the price the oracle reads from it, as
   * BazaarPair resolves a liquidation's price (the pair judges the call at its own stored price instead
   * when that is newer, or, on a continuously traded market, from the same second):
   *
   * - a fresh price ({@link fresh}, {@link updateFor}) on any market, provided, on a market with
   *   trading hours, that each update carrying it was issued within the pair's 3 s window less
   *   `margin` of `now`: the oracle reads every update a liquidation there carries as Pyth's latest
   *   price, by when it was issued;
   * - otherwise, on a market with trading hours, Pyth's latest price ({@link latestFor}, read by
   *   {@link readLatestPrice}) when every update carrying it was issued within the pair's 3 s window
   *   less `margin` of `now`. An update carries each feed's most recent price as of when it was
   *   issued, so the oracle takes one issued that close to the block as proof that no newer price
   *   existed, and a quiet feed's last price decides the call for up to MAX_LIQUIDATION_PRICE_AGE
   *   seconds after it was generated;
   * - otherwise nothing (`kind` null, `reason` saying why). A continuously traded market is liquidated
   *   only at a fresh price, and a call without an update runs only while the pair stored a price
   *   within the last 3 s, which this service cannot see.
   *
   * Judged at `now` (default the clock) with `margin` (default {@link sendMargin}). The call must land
   * within 3 s of the result's `priceTime`: check it again just before sending.
   */
  liquidationUpdate(m: Market, now?: number | null, margin?: number | null): LiquidationUpdate {
    const t = now ?? this.clock();
    const mg = margin ?? this.sendMargin;
    const limit = MAX_PRICE_STALENESS - mg;
    if (this.fresh(m, t, mg)) {
      const v = this.view(m)!;
      if (m.continuous || v.prints!.every((p) => Math.abs(Number(p.timestampUs / MICROS_PER_SECOND) - t) <= limit)) {
        const price = this.priceOf(v)!;
        return { kind: "fresh", update: this.updateFor(m), price, generated: v.prints!.map((p) => p.publishTime), priceTime: price.publishTime, reason: null };
      }
    }
    if (m.continuous) {
      return noLiquidation(
        "no fresh price: a continuously traded market is liquidated only at a price generated within the pair's 3 s window less the send margin, inside the oracle's confidence cap",
      );
    }
    const prints = this.latestFor(m);
    if (prints === null) return noLiquidation("the price source holds no update carrying every leg of the market yet");
    const blobs = distinctBlobs(prints);
    const latest = readLatestPrice(blobs, prints.map((p) => p.feedId), m.invertQuote);
    if ("problem" in latest) return noLiquidation(latest.problem);
    const behind = t - latest.issuedAt;
    if (behind > limit) {
      const which = blobs.length > 1 ? "the earliest of the newest updates" : "the newest update";
      return noLiquidation(`${which} the price source holds was issued ${secs(behind)} s before the clock, past the pair's 3 s window less the ${secs(mg)} s send margin`);
    }
    const ahead = Math.max(...prints.map((p) => Number(p.timestampUs / MICROS_PER_SECOND))) - t;
    if (ahead > limit) {
      return noLiquidation(`an update the price source holds was issued ${secs(ahead)} s ahead of the clock, past the pair's 3 s window less the ${secs(mg)} s send margin`);
    }
    return { kind: "latest", update: latest.update, price: latest.price, generated: latest.generated, priceTime: latest.issuedAt, reason: null };
  }

  /**
   * Make `p` the print {@link ethUsd} reads once its signer is confirmed. No contract checks this
   * print, so one a stream took without its signer check (ProClientOptions.signerCheckInterval) is
   * checked here first: one signature recovery per ETH/USD update, whatever the number of markets. A
   * print refused, or whose check fails, is never read; the last confirmed one stands meanwhile.
   */
  private confirmEthUsd(p: Print): void {
    const use = () => {
      if (this.ethUsdPrint === null || p.generatedUs > this.ethUsdPrint.generatedUs) this.ethUsdPrint = p;
    };
    const client = this.client;
    if (p.signer !== null || !(client instanceof ProClient) || client.isTrustedSigner === null) return use();
    client.verifySigner(p.blob).then(use, (e: unknown) => this.onNotice(`an ETH/USD print was not used to price gas: ${message(e)}`));
  }

  /**
   * USD per ETH from the newest ETH/USD print whose signer is confirmed (when the source checks
   * signers), for pricing gas; null when there is none, when it is older than {@link ethUsdMaxAge}
   * seconds at `now` (default the clock), or when it is not a finite number within
   * {@link ethUsdBounds}. The caller then uses its own fallback (the keeper's `gas.ethUsdFallback`).
   * No contract checks this print: it prices gas, not a call.
   */
  ethUsd(now?: number | null): number | null {
    const p = this.ethUsdPrint;
    if (p === null || p.price <= 0n) return null;
    if ((now ?? this.clock()) - p.publishTime > this.ethUsdMaxAge) return null;
    const v = p.expo < 0 ? Number(p.price) / 10 ** -p.expo : Number(p.price) * 10 ** p.expo;
    const [min, max] = this.ethUsdBounds;
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  }
}

/** The distinct signed updates `prints` came in, in the prints' order. */
export function distinctBlobs(prints: readonly Print[]): Hex[] {
  const out: Hex[] = [];
  for (const p of prints) if (!out.includes(p.blob)) out.push(p.blob);
  return out;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

/** Pyth Pro's registry entries for `feeds`, by feed id; empty when the registry cannot be read. */
export async function fetchFeedInfo(client: Pick<ProClient, "symbols">, feeds: Iterable<Hex>): Promise<Map<Hex, ProSymbol>> {
  let all: ProSymbol[];
  try {
    all = await client.symbols();
  } catch (e) {
    if (e instanceof ProError) return new Map();
    throw e;
  }
  const want = new Set<Hex>();
  for (const f of feeds) want.add(f.toLowerCase() as Hex);
  const out = new Map<Hex, ProSymbol>();
  for (const item of all) if (want.has(item.feedId) && !out.has(item.feedId)) out.set(item.feedId, item);
  return out;
}

/** Pyth symbols for `feeds` ("Crypto.BTC/USD"), from the symbols registry; empty when it cannot be read. */
export async function fetchSymbols(client: Pick<ProClient, "symbols">, feeds: Iterable<Hex>): Promise<Map<Hex, string>> {
  const out = new Map<Hex, string>();
  for (const [id, info] of await fetchFeedInfo(client, feeds)) out.set(id, info.symbol);
  return out;
}
