/**
 * Prices for a frontend: a Pyth (Hermes) source for the signed updates calls carry, and a live price
 * stream for showing prices.
 *
 * {@link hermesPriceSource} implements the context's {@link PriceUpdateSource} on top of the SDK's
 * {@link HermesClient}: `latest` returns the freshest update cut to exactly the asked feeds, and
 * `atOrAfter` uses Hermes' historical route for settlement prints.
 *
 * {@link livePrices} runs a {@link PriceService} in the browser (or Node): one server-sent stream for
 * every market's legs, falling back to polling, and per market the composed price the pair would
 * compute (spot, low, high, confidence), its publish time, whether it is inside the pair's 3 s window,
 * and whether a trading-hours market's venue is closed. Everything a render needs is read from memory;
 * subscribers are called when a market's price or flags change. It is also a PriceUpdateSource that
 * reuses the stream's prints for a call's update when they are fresh enough, so building a trade
 * needs no extra request.
 */

import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { MAX_PRICE_STALENESS } from "../constants.js";
import type { PairPrice } from "../formulas/index.js";
import { type Market, type MarketStatic, marketFromStatic } from "../models.js";
import { isAccumulator, subsetOf } from "../prices/accumulator.js";
import { HermesClient, type HermesClientOptions, HermesError, type Print, scanOf } from "../prices/hermes.js";
import { PriceService, type PriceServiceOptions, type PriceSource } from "../prices/service.js";
import { ConnectError, type BazaarContext, type PriceUpdateSource } from "./context.js";
import { type LivePriceView, VENUE_CLOSED_AFTER, listMarkets } from "./markets.js";

/** How far ahead of this device's clock a live print may be dated before it is ignored (seconds). */
export const BROWSER_FUTURE_SKEW = 120;

// =====================================================================================================
// Signed updates from Hermes
// =====================================================================================================

export interface HermesSourceOptions extends HermesClientOptions {
  /** Sent as "Authorization: Bearer <key>". */
  readonly apiKey?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
}

/** A {@link PriceUpdateSource} over a Hermes endpoint, with the client and parsed prints exposed. */
export interface HermesPriceSource extends PriceUpdateSource {
  readonly client: HermesClient;
  latest(feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number }>;
  atOrAfter(publishTime: number, feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number; prevPublishTime: number | null }[]>;
  /** The latest prints for these feeds, parsed (for showing a price without a stream). */
  prints(feedIds: readonly Hex[]): Promise<Print[]>;
}

/** Lowercase, deduplicated, in the order given. */
function feedList(feedIds: readonly Hex[]): Hex[] {
  const out: Hex[] = [];
  const seen = new Set<string>();
  for (const f of feedIds) {
    const id = f.toLowerCase() as Hex;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The newest print per feed. */
function byFeed(prints: readonly Print[]): Map<Hex, Print> {
  const out = new Map<Hex, Print>();
  for (const p of prints) {
    const cur = out.get(p.feedId);
    if (!cur || p.publishTime >= cur.publishTime) out.set(p.feedId, p);
  }
  return out;
}

/**
 * Signed update data covering exactly these prints' feeds: per blob they came in, an accumulator cut
 * down to those feeds, or the blob itself when it is one feed's own (as PriceService.updateFor builds it).
 */
export function updateFromPrints(prints: readonly Print[]): Hex[] {
  const out: Hex[] = [];
  const done = new Set<Hex>();
  for (let i = 0; i < prints.length; i++) {
    const blob = prints[i]!.blob;
    if (done.has(blob)) continue;
    done.add(blob);
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

const short = (f: Hex) => `${f.slice(0, 10)}…`;

function isNotFound(e: unknown): boolean {
  return e instanceof HermesError && e.message.includes("(HTTP 404)");
}

/** The freshest update for `ids` (already normalized) from a source's latest prints. */
async function latestUpdate(source: Pick<PriceSource, "latest">, ids: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number; prints: Print[] }> {
  if (ids.length === 0) throw new HermesError("no price feeds were asked for");
  const got = byFeed(await source.latest(ids));
  const prints: Print[] = [];
  for (const id of ids) {
    const p = got.get(id);
    if (!p) throw new HermesError(`the price endpoint has no price for feed ${short(id)}`);
    prints.push(p);
  }
  return { update: updateFromPrints(prints), publishTime: Math.min(...prints.map((p) => p.publishTime)), prints };
}

/** Hermes' historical route for `ids` (already normalized): one entry per feed, empty where it has none. */
async function historicalUpdates(
  source: Pick<HermesClient, "atOrAfter">,
  publishTime: number,
  ids: readonly Hex[],
): Promise<{ update: Hex[]; publishTime: number; prevPublishTime: number | null }[]> {
  if (ids.length === 0) return [];
  let got: Map<Hex, Print>;
  try {
    got = byFeed(await source.atOrAfter(Math.floor(publishTime), ids));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    got = new Map();
  }
  return ids.map((id) => {
    const p = got.get(id);
    return p
      ? { update: updateFromPrints([p]), publishTime: p.publishTime, prevPublishTime: p.prevPublishTime }
      : { update: [], publishTime: 0, prevPublishTime: null };
  });
}

/**
 * The context's price source over a Hermes endpoint (Pyth's own, a proxy, or the keeper's mock).
 *
 * - `latest(feeds)`: one request to `/v2/updates/price/latest`; the update carries exactly these
 *   feeds (an accumulator cut to them), and `publishTime` is the oldest among them, which is what the
 *   pair's 3 s window judges. Throws HermesError when the endpoint has no price for one of them.
 * - `atOrAfter(time, feeds)`: Hermes' historical route (`/v2/updates/price/{time}`), one entry per
 *   feed in the order asked, each with that feed's own one-update payload and the `prevPublishTime`
 *   the update signs. A feed the archive has nothing for yet (or a 404) gets an empty `update`.
 *
 * Pass a {@link HermesClient} instead of a URL to share one with a {@link LivePrices}.
 */
export function hermesPriceSource(baseUrl: string | HermesClient, opts: HermesSourceOptions = {}): HermesPriceSource {
  const client =
    typeof baseUrl === "string"
      ? new HermesClient(baseUrl, opts.apiKey ?? null, opts.headers ?? null, { timeout: opts.timeout, fetch: opts.fetch })
      : baseUrl;
  return {
    client,
    async prints(feedIds) {
      const ids = feedList(feedIds);
      return ids.length ? client.latest(ids) : [];
    },
    async latest(feedIds) {
      const { update, publishTime } = await latestUpdate(client, feedList(feedIds));
      return { update, publishTime };
    },
    atOrAfter(publishTime, feedIds) {
      return historicalUpdates(client, publishTime, feedList(feedIds));
    },
  };
}

/** Whether a context's price source is a {@link hermesPriceSource} (it then exposes its client). */
export function isHermesPriceSource(source: unknown): source is HermesPriceSource {
  return !!source && (source as HermesPriceSource).client instanceof HermesClient && typeof (source as HermesPriceSource).prints === "function";
}

// =====================================================================================================
// Live prices for a UI
// =====================================================================================================

/** One market's live price, composed as BazaarOracle composes it (BAZAAR precision). */
export interface MarketPrice {
  readonly market: Address;
  readonly spot: bigint;
  /** Spot less the confidence: what a long is valued at when it withdraws. */
  readonly low: bigint;
  /** Spot plus the confidence: what a short is valued at when it withdraws. */
  readonly high: bigint;
  /** The band's wider half: max(high − spot, spot − low). */
  readonly confidence: bigint;
  /** confidence / spot in basis points (display only). */
  readonly confidenceBp: number;
  /** Every leg, and the composed band, sit inside the oracle's 2% confidence cap. */
  readonly confidenceOk: boolean;
  /** The older leg's publish time (unix seconds): what the pair's 3 s window judges. */
  readonly publishTime: number;
  /** Seconds since publishTime at the service's clock. */
  readonly age: number;
  /**
   * Within the pair's window: every leg published at most 3 s from now and the confidence clears the
   * cap, so a call carrying this print would be accepted by the oracle if it landed now.
   */
  readonly fresh: boolean;
  /**
   * A trading-hours market whose feed has not printed for {@link VENUE_CLOSED_AFTER} s while the
   * endpoint delivers others: its venue is closed. Always false for a 24/7 market.
   */
  readonly venueClosed: boolean;
  /** The legs' prints (base first for a composite). */
  readonly legs: readonly Print[];
}

/** Called with the markets whose price or flags changed (one map per batch; do not keep it). */
export type PriceListener = (changed: ReadonlyMap<Address, MarketPrice>) => void;

export interface LivePricesOptions extends PriceServiceOptions {
  /** Where prints come from when no context source is given: a Hermes base URL... */
  readonly baseUrl?: string;
  readonly apiKey?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  /** ...or a client (or any PriceSource) to share. */
  readonly client?: PriceSource;
  /** Seconds without a print after which a trading-hours market reads closed; default 15. */
  readonly closedAfter?: number;
  /** Milliseconds between re-checks of freshness and venue state for subscribers; default 1000 (0: never). */
  readonly tickMs?: number;
  /**
   * A stream print at most this many seconds old is reused for a call's update ({@link LivePrices.latest});
   * older ones are fetched again. Default 1.
   */
  readonly reuseAge?: number;
  /** Start streaming at once; default true. */
  readonly start?: boolean;
}

interface Watched {
  readonly address: Address;
  readonly info: MarketStatic;
  readonly market: Market;
}

interface Subscriber {
  readonly listener: PriceListener;
  /** null: every market */
  readonly markets: ReadonlySet<Address> | null;
}

const toAddress = (m: Address | MarketStatic): Address => getAddress(typeof m === "string" ? m : m.address);

/**
 * Live prices for a set of markets. Construct with {@link livePrices}, or directly with markets and a
 * price source. Call {@link stop} when the view unmounts.
 */
export class LivePrices implements LivePriceView, PriceUpdateSource {
  /** The service underneath: its `healthy`, `lastError` and raw `latest` prints are public. */
  readonly service: PriceService;
  /** Settles once the first request for every market's latest print has answered (or failed). */
  ready: Promise<void>;

  private readonly watched = new Map<Address, Watched>();
  private readonly byLeg = new Map<Hex, Address[]>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly flags = new Map<Address, string>(); // last notified "fresh|closed" per market
  private readonly closedAfter: number;
  private readonly tickMs: number;
  private readonly reuseAge: number;
  private readonly source: PriceSource;
  private unlisten: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ended = false;

  constructor(markets: readonly MarketStatic[], source: PriceSource, opts: LivePricesOptions = {}) {
    // A browser's clock can run seconds or a minute slow; the keeper's 5 s future-print bound would then drop
    // every live print. Allow the same skew the signing check does (MAX_CLOCK_SKEW), still bounded.
    this.service = new PriceService(source, { maxFutureSkew: BROWSER_FUTURE_SKEW, ...opts });
    this.closedAfter = opts.closedAfter ?? VENUE_CLOSED_AFTER;
    this.tickMs = opts.tickMs ?? 1000;
    this.reuseAge = opts.reuseAge ?? 1;
    this.source = source;
    this.ready = Promise.resolve();
    this.add(markets, false);
    if (opts.start !== false) this.start();
  }

  /** Stream these markets' legs too (already watched markets are ignored). */
  add(markets: readonly MarketStatic[], fetch = true): void {
    const added: Hex[] = [];
    for (const info of markets) {
      const a = getAddress(info.address);
      if (this.watched.has(a)) continue;
      const market = marketFromStatic(info);
      market.legs = market.legs.map((l) => l.toLowerCase() as Hex);
      this.watched.set(a, { address: a, info, market });
      for (const leg of market.legs) {
        const list = this.byLeg.get(leg);
        if (list) list.push(a);
        else this.byLeg.set(leg, [a]);
        added.push(leg);
      }
    }
    if (added.length === 0) return;
    this.service.watch(added);
    if (fetch && this.running) this.ready = this.seed(added);
  }

  /** The markets being streamed. */
  markets(): MarketStatic[] {
    return [...this.watched.values()].map((w) => w.info);
  }

  /** Start streaming (constructing does this unless `start: false`). A stopped LivePrices stays stopped. */
  start(): void {
    if (this.running || this.ended) return;
    this.running = true;
    this.unlisten = this.service.onPrints((feeds) => this.onPrints(feeds));
    // One request for every leg's latest print first: the stream sends only new prints, so a closed
    // venue's market would otherwise show no price at all until it reopens.
    this.ready = this.seed(null);
    void this.ready.then(() => {
      if (this.running) void this.service.run();
    });
    if (this.tickMs > 0) this.ticker = setInterval(() => this.onTick(), this.tickMs);
  }

  /** End the stream, the ticker and every subscription, for good. */
  stop(): void {
    this.running = false;
    this.ended = true;
    this.service.stop();
    this.unlisten?.();
    this.unlisten = null;
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    this.subscribers.clear();
  }

  private async seed(feeds: readonly Hex[] | null): Promise<void> {
    try {
      await this.service.fetch(feeds);
    } catch (e) {
      this.service.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private now(): number {
    return this.service.clock();
  }

  /** The market's live price, or null while a leg has no print (or it is not watched). Reads memory only. */
  price(market: Address | MarketStatic): MarketPrice | null {
    const w = this.watched.get(toAddress(market));
    if (!w) return null;
    return this.quote(w, this.now());
  }

  /** Every watched market's live price that has one. */
  all(): Map<Address, MarketPrice> {
    const now = this.now();
    const out = new Map<Address, MarketPrice>();
    for (const [a, w] of this.watched) {
      const q = this.quote(w, now);
      if (q) out.set(a, q);
    }
    return out;
  }

  /** Whether a trading-hours market's venue is closed (see {@link MarketPrice.venueClosed}). */
  venueClosed(market: Address | MarketStatic): boolean {
    const w = this.watched.get(toAddress(market));
    if (!w || w.info.continuous) return false;
    return this.service.closed(w.market, this.now(), this.closedAfter);
  }

  /** Whether the market's price is inside the pair's 3 s window and clears the confidence cap. */
  fresh(market: Address | MarketStatic): boolean {
    const w = this.watched.get(toAddress(market));
    return !!w && this.service.fresh(w.market, this.now(), 0);
  }

  private quote(w: Watched, now: number): MarketPrice | null {
    const pp: PairPrice | null = this.service.price(w.market);
    const legs = this.service.legs(w.market);
    if (!pp || !legs) return null;
    const up = pp.high - pp.spot;
    const down = pp.spot - pp.low;
    const confidence = up > down ? up : down;
    let fresh = pp.confidenceOk;
    for (const p of legs) if (Math.abs(now - p.publishTime) > MAX_PRICE_STALENESS) fresh = false;
    return {
      market: w.address,
      spot: pp.spot,
      low: pp.low,
      high: pp.high,
      confidence,
      confidenceBp: pp.spot > 0n ? (Number(confidence) / Number(pp.spot)) * 10_000 : 0,
      confidenceOk: pp.confidenceOk,
      publishTime: pp.publishTime,
      age: now - pp.publishTime,
      fresh,
      venueClosed: !w.info.continuous && this.service.closed(w.market, now, this.closedAfter),
      legs,
    };
  }

  /**
   * Call `listener` with the markets whose price changed after each batch of prints, and whose
   * `fresh` or `venueClosed` flag flipped as time passed (checked every `tickMs`). Only `markets`
   * when given, else every watched market. Returns the function that unsubscribes.
   */
  subscribe(listener: PriceListener, markets?: readonly (Address | MarketStatic)[]): () => void {
    const sub: Subscriber = { listener, markets: markets ? new Set(markets.map(toAddress)) : null };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  private onPrints(feeds: ReadonlySet<Hex>): void {
    if (this.subscribers.size === 0) return;
    const touched = new Set<Address>();
    for (const f of feeds) for (const a of this.byLeg.get(f) ?? []) touched.add(a);
    this.notify(touched);
  }

  private onTick(): void {
    if (this.subscribers.size === 0) return;
    const now = this.now();
    const flipped = new Set<Address>();
    for (const [a, w] of this.watched) {
      const key = this.flagKey(w, now);
      if (this.flags.get(a) !== key) flipped.add(a);
    }
    if (flipped.size) this.notify(flipped);
  }

  private flagKey(w: Watched, now: number): string {
    const fresh = this.service.fresh(w.market, now, 0);
    const closed = !w.info.continuous && this.service.closed(w.market, now, this.closedAfter);
    return `${fresh ? 1 : 0}${closed ? 1 : 0}`;
  }

  private notify(markets: ReadonlySet<Address>): void {
    if (markets.size === 0) return;
    const now = this.now();
    const quotes = new Map<Address, MarketPrice>();
    for (const a of markets) {
      const w = this.watched.get(a);
      if (!w) continue;
      this.flags.set(a, this.flagKey(w, now));
      const q = this.quote(w, now);
      if (q) quotes.set(a, q);
    }
    if (quotes.size === 0) return;
    for (const sub of [...this.subscribers]) {
      let view: ReadonlyMap<Address, MarketPrice> = quotes;
      if (sub.markets) {
        const mine = new Map<Address, MarketPrice>();
        for (const [a, q] of quotes) if (sub.markets.has(a)) mine.set(a, q);
        if (mine.size === 0) continue;
        view = mine;
      }
      try {
        sub.listener(view);
      } catch {
        // A subscriber's failure must not stop the others or the stream.
      }
    }
  }

  // ---- PriceUpdateSource ----

  /**
   * The freshest signed update for these feeds: the stream's own prints when every feed has one at
   * most `reuseAge` seconds old (no request), else one request to the endpoint.
   */
  async latest(feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number }> {
    const ids = feedList(feedIds);
    const now = this.now();
    const prints: Print[] = [];
    for (const id of ids) {
      const p = this.service.latest.get(id);
      if (!p || now - p.publishTime > this.reuseAge) break;
      prints.push(p);
    }
    if (ids.length > 0 && prints.length === ids.length) {
      return { update: updateFromPrints(prints), publishTime: Math.min(...prints.map((p) => p.publishTime)) };
    }
    const r = await latestUpdate(this.source, ids);
    this.service.ingest(r.prints); // what was fetched also refreshes the display
    return { update: r.update, publishTime: r.publishTime };
  }

  /** Hermes' historical route, through the endpoint (see {@link hermesPriceSource}). */
  async atOrAfter(publishTime: number, feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number; prevPublishTime: number | null }[]> {
    const hist = this.source as Partial<Pick<HermesClient, "atOrAfter">>;
    if (typeof hist.atOrAfter !== "function") throw new HermesError("this price source serves no historical prints");
    return historicalUpdates(hist as Pick<HermesClient, "atOrAfter">, publishTime, feedList(feedIds));
  }

  /** The stream's current update for one market's legs (null while a leg has no print). */
  updateFor(market: Address | MarketStatic): { update: Hex[]; publishTime: number } | null {
    const w = this.watched.get(toAddress(market));
    if (!w) return null;
    const legs = this.service.legs(w.market);
    if (!legs) return null;
    return { update: this.service.updateFor(w.market), publishTime: Math.min(...legs.map((p) => p.publishTime)) };
  }
}

/**
 * Live prices for every market of a context ({@link listMarkets}), or for the markets given.
 *
 * With a context, prints come from its {@link hermesPriceSource}'s client unless `client` or
 * `baseUrl` says otherwise; with markets, one of those is required. Streams at once (one SSE
 * connection for all the legs, polling while the stream fails) after one request for every leg's
 * latest print. Stop it with `stop()`.
 */
export async function livePrices(source: BazaarContext | readonly MarketStatic[], opts: LivePricesOptions = {}): Promise<LivePrices> {
  const isCtx = !Array.isArray(source);
  const markets = isCtx ? await listMarkets(source as BazaarContext) : (source as readonly MarketStatic[]);
  let client: PriceSource | null = opts.client ?? null;
  if (!client && opts.baseUrl) client = new HermesClient(opts.baseUrl, opts.apiKey ?? null, opts.headers ?? null);
  if (!client && isCtx) {
    const p = (source as BazaarContext).prices;
    if (isHermesPriceSource(p)) client = p.client;
  }
  if (!client) {
    throw new ConnectError("live prices need a Hermes endpoint: connect with prices: hermesPriceSource(url), or pass baseUrl or client");
  }
  return new LivePrices(markets, client, opts);
}
