/** Live prints for every watched feed, and per-market prices and update payloads built from them. */

import type { Hex } from "viem";
import { ETH_USD_FEED, MAX_PRICE_STALENESS } from "../constants.js";
import { type PairPrice, pairPrice } from "../formulas/index.js";
import type { Market } from "../models.js";
import { isAccumulator, subsetOf } from "./accumulator.js";
import {
  type HermesClient,
  HermesError,
  type PriceFeedMetadata,
  type Print,
  STREAM_IDLE_TIMEOUT,
  type StreamOptions,
  monotonic,
  scanOf,
} from "./hermes.js";

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

/** Where a PriceService gets its prints: a {@link HermesClient}, or anything shaped like one. */
export interface PriceSource {
  latest(ids: readonly Hex[]): Promise<Print[]>;
  /**
   * Batches of prints until the connection drops; ends at once when `signal` aborts, and throws when
   * the stream stays silent for `opts.idleTimeout` seconds.
   */
  stream(ids: readonly Hex[], signal?: AbortSignal, opts?: StreamOptions): AsyncIterable<Print[]>;
}

export interface PriceLogger {
  warn(message: string): void;
}

export interface PriceServiceOptions {
  /** follow the server-sent stream (falling back to polling when it fails); default true */
  stream?: boolean;
  /**
   * seconds the stream may send nothing (no print, no keep-alive) before it is dropped and reconnected
   * like any failed stream, with a warning; default 10, null or 0 to wait forever
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
   * it, or not a finite number, it returns null; default [100, 1_000_000]. ETH/USD never goes on
   * chain, so nothing verifies the endpoint's print: this only refuses absurd ones.
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

const short = (f: Hex) => `${f.slice(0, 10)}…`;

/** Called after each batch of prints with the feeds that got a newer print in it. */
export type PrintListener = (feeds: ReadonlySet<Hex>) => void;

/**
 * What a market's legs give while each leg's newest print stays the same: built on first use, and
 * dropped by identity as soon as a newer print arrives for any leg.
 */
interface View {
  readonly prints: Print[];
  invert: boolean;
  /** undefined until computed */
  price: PairPrice | null | undefined;
  update: Hex[] | undefined;
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
  readonly feeds = new Set<Hex>([ETH_USD_FEED]);
  readonly latest = new Map<Hex, Print>();
  healthy = false;
  lastError = "";
  /** when a print last arrived, in seconds on a monotonic clock (`performance.now() / 1000`) */
  lastUpdate = 0;

  private readonly logger: PriceLogger | null;
  private changed = false; // the watched feeds changed: restart the stream
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

  watch(feeds: Iterable<Hex>): void {
    let added = false;
    for (const f of feeds) {
      const id = f.toLowerCase() as Hex;
      if (!this.feeds.has(id)) {
        this.feeds.add(id);
        added = true;
      }
    }
    if (added) {
      this.changed = true;
      this.streamCtl?.abort(); // resubscribe now, with the new feeds
    }
  }

  watchMarkets(markets: Iterable<Market>): void {
    const legs: Hex[] = [];
    for (const m of markets) for (const leg of m.legs) legs.push(leg);
    this.watch(legs);
  }

  /**
   * Take in prints from any source (the background loop, {@link fetch}, or a caller's own): each
   * replaces the feed's print unless it is older, and one newer than the feed had wakes
   * {@link nextPrints} and the {@link onPrints} listeners. A print dated more than
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
    const limit = prints.length > 0 ? this.clock() + this.maxFutureSkew : 0;
    for (const p of prints) {
      if (only !== null && !only.has(p.feedId)) continue;
      if (p.publishTime > limit) {
        this.future(p, limit - this.maxFutureSkew);
        continue;
      }
      const cur = this.latest.get(p.feedId);
      if (cur === undefined || p.publishTime >= cur.publishTime) {
        if (cur === undefined || p.publishTime > cur.publishTime) {
          this.newFeeds.add(p.feedId);
          if (this.listeners.size > 0) (batch ??= new Set()).add(p.feedId);
        }
        this.latest.set(p.feedId, p);
      }
    }
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
   * One request for the latest prints, outside the background loop: of `feeds` (lowercase), or the
   * watched ones. A feed the endpoint serves no print for is reported, once.
   */
  async fetch(feeds?: Iterable<Hex> | null): Promise<void> {
    const ids = [...new Set(feeds ? [...feeds].map((f) => f.toLowerCase() as Hex) : this.feeds)].sort();
    if (ids.length === 0) return;
    this.take(await this.source().latest(ids), new Set(ids));
    this.reportMissing(ids);
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
        `price endpoint sent no print for feed ${f}: markets on it get no price until it does (check the feed id and that the endpoint serves it; a trading-hours feed may be closed). Other feeds are unaffected.`,
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
   * Follow the stream (or poll) until {@link stop}, through any endpoint failure: three in a row mark
   * the service unhealthy and switch a streaming service to polling for a minute. Never rejects.
   */
  async run(): Promise<void> {
    let failures = 0;
    let pollUntil = 0;
    while (!this.stopped) {
      const ids = [...this.feeds].sort();
      this.changed = false;
      try {
        const source = this.source();
        if (this.useStream && monotonic() >= pollUntil) {
          const ctl = new AbortController();
          this.streamCtl = ctl;
          const since = monotonic();
          let checked = false;
          try {
            // A stream gone quiet throws (the source aborts its request): counted below as a failure.
            for await (const prints of source.stream(ids, ctl.signal, { idleTimeout: this.streamIdleTimeout })) {
              this.take(prints, this.feeds);
              failures = 0;
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
          await this.sleep(0.2);
        } else {
          this.take(await source.latest(ids), this.feeds);
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
    if (this.client === null) throw new HermesError("this PriceService has no price source");
    return this.client;
  }

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
   * The market's view: the cached one while each leg's newest print is the one it was built from,
   * else rebuilt in place; null while a leg has no print. A stored view always holds every leg.
   */
  private view(m: Market): View | null {
    const legs = m.legs;
    let v = this.views.get(m);
    if (v !== undefined && v.prints.length === legs.length && v.invert === m.invertQuote) {
      let same = true;
      for (let i = 0; same && i < legs.length; i++) same = this.latest.get(legs[i]!) === v.prints[i];
      if (same) return v;
    }
    for (const leg of legs) if (!this.latest.has(leg)) return null;
    if (v === undefined || v.prints.length !== legs.length) {
      v = { prints: new Array<Print>(legs.length), invert: m.invertQuote, price: undefined, update: undefined };
      this.views.set(m, v);
    }
    for (let i = 0; i < legs.length; i++) v.prints[i] = this.latest.get(legs[i]!)!;
    v.invert = m.invertQuote;
    v.price = undefined;
    v.update = undefined;
    return v;
  }

  private priceOf(v: View): PairPrice | null {
    if (v.price === undefined) v.price = pairPrice(v.prints, v.invert);
    return v.price;
  }

  legs(m: Market): Print[] | null {
    const v = this.view(m);
    return v === null ? null : v.prints.slice();
  }

  price(m: Market): PairPrice | null {
    const v = this.view(m);
    return v === null ? null : this.priceOf(v);
  }

  /** Whether every leg's print is recent enough to send now and clears the confidence cap. */
  fresh(m: Market, now?: number | null, margin?: number | null): boolean {
    const v = this.view(m);
    if (v === null) return false;
    const t = now ?? this.clock();
    const limit = MAX_PRICE_STALENESS - (margin ?? this.sendMargin);
    for (const p of v.prints) if (Math.abs(t - p.publishTime) > limit) return false;
    const pp = this.priceOf(v);
    return pp !== null && pp.confidenceOk;
  }

  /** No print for `after` seconds while the endpoint is otherwise delivering: a closed session. */
  closed(m: Market, now?: number | null, after = 15): boolean {
    const v = this.view(m);
    const t = now ?? this.clock();
    if (v === null) return this.healthy;
    return this.healthy && v.prints.some((p) => t - p.publishTime > after);
  }

  /**
   * Signed update data covering exactly this market's legs: per blob its legs' prints came in, the
   * accumulator update cut down to those legs, or the blob itself when it is a single feed's.
   */
  updateFor(m: Market): Hex[] {
    const v = this.view(m);
    if (v === null) return [];
    v.update ??= buildUpdate(v.prints);
    return v.update.slice();
  }

  /**
   * USD per ETH from the newest ETH/USD print, for pricing gas; null when there is none, when it is
   * older than {@link ethUsdMaxAge} seconds at `now` (default the clock), or when it is not a finite
   * number within {@link ethUsdBounds}. The caller then uses its own fallback (the keeper's
   * `gas.ethUsdFallback`). ETH/USD never goes on chain, so no contract checks this print.
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

function buildUpdate(prints: readonly Print[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < prints.length; i++) {
    const blob = prints[i]!.blob;
    let seen = false;
    for (let j = 0; j < i && !seen; j++) seen = prints[j]!.blob === blob;
    if (seen) continue; // grouped with the first print that came in it
    if (!isAccumulator(blob)) {
      out.push(blob);
      continue;
    }
    const feeds: Hex[] = [];
    for (let j = i; j < prints.length; j++) if (prints[j]!.blob === blob) feeds.push(prints[j]!.feedId);
    out.push(subsetOf(scanOf(prints[i]!), feeds));
  }
  return out;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

/** Pyth symbols for `feeds`, from the endpoint's feed metadata; empty when it serves none. */
export async function fetchSymbols(client: Pick<HermesClient, "priceFeeds">, feeds: Iterable<Hex>): Promise<Map<Hex, string>> {
  let meta: PriceFeedMetadata[];
  try {
    meta = await client.priceFeeds();
  } catch (e) {
    if (e instanceof HermesError) return new Map();
    throw e;
  }
  const want = new Set<string>();
  for (const f of feeds) want.add(f.toLowerCase().replace(/^0x/, ""));
  const out = new Map<Hex, string>();
  for (const item of meta) {
    const fid = String(item?.id ?? "").replace(/^0x/, "").toLowerCase();
    if (want.has(fid)) {
      const symbol = item?.attributes?.symbol;
      out.set(`0x${fid}`, typeof symbol === "string" ? symbol : "");
    }
  }
  return out;
}
