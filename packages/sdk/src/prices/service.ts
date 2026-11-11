/** Live prints for every watched feed, and per-market prices and update payloads built from them. */

import type { Hex } from "viem";
import { ETH_USD_FEED, MAX_PRICE_STALENESS } from "../constants.js";
import { type PairPrice, pairPrice } from "../formulas/index.js";
import type { Market } from "../models.js";
import { type LegEntry, MAX_FEEDS_PER_UPDATE, MICROS_PER_SECOND, legEntries } from "./lazer.js";
import { type Print, type ProClient, ProError, type ProSymbol, STREAM_IDLE_TIMEOUT, type StreamOptions, monotonic, whyNotLive } from "./pro.js";

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
   * forward under a later update changes nothing. A print dated more than {@link maxFutureSkew}
   * seconds ahead of the clock is ignored, with a warning once per feed.
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
      if (p.publishTime > limit) {
        this.future(p, limit - this.maxFutureSkew);
        continue;
      }
      const cur = this.latest.get(p.feedId);
      if (cur === undefined || p.generatedUs > cur.generatedUs) {
        this.newFeeds.add(p.feedId);
        if (this.listeners.size > 0) (batch ??= new Set()).add(p.feedId);
        this.latest.set(p.feedId, p);
      }
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
   * Keep, per watched set, the update that carries a live print for each of its feeds and nothing
   * else: the prints of `prints` that share a signed update are one candidate, taken when no leg's
   * price is older than the kept one's and some leg's is newer.
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
   * fits. A feed the endpoint serves no print for is reported, once.
   */
  async fetch(feeds?: Iterable<Hex> | null): Promise<void> {
    const ids = [...new Set(feeds ? [...feeds].map((f) => f.toLowerCase() as Hex) : this.feeds)].sort();
    if (ids.length === 0) return;
    await this.poll(this.source(), inRequests(ids, this.sets.values()), new Set(ids));
    this.reportMissing(ids);
  }

  /** Ask for each request's latest prints at once and take them (only `keep`'s); the first failure is thrown once the others are taken. */
  private async poll(source: PriceSource, requests: readonly Hex[][], keep: ReadonlySet<Hex>): Promise<void> {
    const results = await Promise.allSettled(requests.map((r) => source.latest(r)));
    let failed: { reason: unknown } | null = null;
    for (const r of results) {
      if (r.status === "fulfilled") this.take(r.value, keep);
      else failed ??= { reason: r.reason };
    }
    if (failed !== null) throw failed.reason;
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

  /** Warn, once per feed, about a print dated ahead of the clock. */
  private future(p: Print, now: number): void {
    if (this.warnedFuture.has(p.feedId)) return;
    this.warnedFuture.add(p.feedId);
    this.logger?.warn(
      `ignored a print for feed ${short(p.feedId)} dated ${p.publishTime - now} s ahead of the clock (more than ${this.maxFutureSkew} s): check the price endpoint, or this machine's clock`,
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
    v.prints = this.select(legs, own, v.newest);
    return v.prints === null ? null : v;
  }

  /**
   * The prints `legs` price from, given their set's update and each leg's newest print: the set's
   * own, unless it lacks a leg or lags one by {@link SET_LAG_US}; else the newest per leg; null while
   * a leg has none.
   */
  private select(legs: readonly Hex[], own: readonly Print[] | undefined, newest: readonly (Print | undefined)[]): Print[] | null {
    if (own !== undefined) {
      const mine: Print[] = [];
      for (let i = 0; i < legs.length; i++) {
        const p = own.find((x) => x.feedId === legs[i]);
        const other = newest[i];
        if (p === undefined || (other !== undefined && other.generatedUs - p.generatedUs >= SET_LAG_US)) break;
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
    const prints = this.select(legs, this.updates.get(setKey(legs)), legs.map((l) => this.latest.get(l)));
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
   * USD per ETH from the newest ETH/USD print, for pricing gas; null when there is none, when it is
   * older than {@link ethUsdMaxAge} seconds at `now` (default the clock), or when it is not a finite
   * number within {@link ethUsdBounds}. The caller then uses its own fallback (the keeper's
   * `gas.ethUsdFallback`). No contract checks this print: it prices gas, not a call.
   */
  ethUsd(now?: number | null): number | null {
    const p = this.latest.get(ETH_USD_FEED);
    if (p === undefined || p.price <= 0n) return null;
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
