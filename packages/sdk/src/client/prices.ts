/**
 * Prices for a frontend: a Pyth Pro source for the signed updates calls carry, and a live price
 * stream for showing prices.
 *
 * {@link proPriceSource} implements the context's {@link PriceUpdateSource} on top of the SDK's
 * {@link ProClient}: `latest` returns the freshest update requested for exactly the asked feeds, and
 * `atTick` the one-second channel's update for a past second, which settlement proofs are made of.
 *
 * {@link livePrices} runs a {@link PriceService} in the browser (or Node): one subscription per
 * market on every stream endpoint, falling back to polling, and per market the composed price the
 * pair would compute (spot, low, high, confidence), the second it was generated in, whether it is
 * inside the pair's 3 s window, and whether a trading-hours market's venue is closed. Everything a
 * render needs is read from memory; subscribers are called when a market's price or flags change. It
 * is also a PriceUpdateSource that reuses the stream's updates for a call when they are fresh enough,
 * so building a trade needs no extra request.
 *
 * Pyth Pro serves only the holder of an API key, which must stay on a server. A web page instead
 * reads prices from a server that holds the key, and sends its trades through a relayer that attaches
 * the update to them.
 */

import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { MAX_PRICE_STALENESS } from "../constants.js";
import type { PairPrice } from "../formulas/index.js";
import { type Market, type MarketStatic, marketFromStatic } from "../models.js";
import { isRawFeedId, proFeedId } from "../prices/lazer.js";
import { NoLivePriceError, type Print, ProClient, type ProClientOptions, ProError, type ProUpdate, type SignerCheck, whyNotLive } from "../prices/pro.js";
import { PriceService, type PriceServiceOptions, type PriceSource, distinctBlobs } from "../prices/service.js";
import { ConnectError, type BazaarContext, type PriceUpdateSource } from "./context.js";
import { type LivePriceView, VENUE_CLOSED_AFTER, listMarkets } from "./markets.js";
import { verifierSignerCheck } from "./signers.js";

/** How far ahead of this device's clock a live print may be dated before it is ignored (seconds). */
export const BROWSER_FUTURE_SKEW = 120;

// =====================================================================================================
// Signed updates from Pyth Pro
// =====================================================================================================

/** A {@link PriceUpdateSource} over Pyth Pro, with the client and parsed prints exposed. */
export interface ProPriceSource extends PriceUpdateSource {
  readonly client: ProClient;
  latest(feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number }>;
  atTick(feedIds: readonly Hex[], second: number): Promise<ProUpdate | null>;
  useSignerCheck(check: SignerCheck): void;
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

/**
 * The signed updates a call attaches for these prints: each distinct update they came in, once, in
 * the prints' order. Prints requested together share one update.
 */
export function updateFromPrints(prints: readonly Print[]): Hex[] {
  return distinctBlobs(prints);
}

/** A feed for a message: a raw Pyth Pro id as its number, anything else as its short hex. */
const feedText = (f: Hex) => (isRawFeedId(f) ? String(proFeedId(f)) : `${f.slice(0, 10)}…`);

/**
 * The freshest update for `ids` (already normalized) from a source: one request, every feed's print
 * from the answer. Throws a NoLivePriceError naming the first feed without a usable live price, and
 * why when the source is a {@link ProClient} (whose answer holds the feed's entry): an update that
 * cannot price a live call is never handed to one.
 */
async function latestUpdate(source: Pick<PriceSource, "latest">, ids: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number; prints: Print[] }> {
  if (ids.length === 0) throw new ProError("no price feeds were asked for");
  const pro = source instanceof ProClient ? source : null;
  const answer = pro ? await pro.latestUpdate(ids) : null;
  const got = new Map<Hex, Print>();
  for (const p of pro ? (answer?.prints ?? []) : await source.latest(ids)) {
    const cur = got.get(p.feedId);
    if (!cur || p.generatedUs > cur.generatedUs) got.set(p.feedId, p);
  }
  const prints: Print[] = [];
  for (const id of ids) {
    const p = got.get(id);
    if (!p) {
      const entry = answer?.feeds.get(id);
      const why = entry ? whyNotLive(entry) : answer ? "the update does not carry it" : pro ? "it sent no update" : null;
      throw new NoLivePriceError(`the price endpoint has no live price for feed ${feedText(id)}${why ? `: ${why}` : ""}`);
    }
    prints.push(p);
  }
  return { update: updateFromPrints(prints), publishTime: Math.min(...prints.map((p) => p.publishTime)), prints };
}

/**
 * The context's price source over Pyth Pro (Pyth's own endpoints, a proxy, or a local mock).
 *
 * - `latest(feeds)`: one request for exactly these feeds, so the update carries them and nothing
 *   else, both legs of a composite in one. `publishTime` is the second the oldest of their prices was
 *   generated in, which is what the pair's 3 s window judges. Throws a NoLivePriceError when the
 *   endpoint has no live price for one of them, saying why (no price, no confidence, a property left
 *   out), and a ProError when it cannot be asked.
 * - `atTick(feeds, second)`: the one-second channel's update stamped exactly `second` (ProClient.atTick).
 * - `useSignerCheck(check)`: the client then refuses updates whose signer `check` does not accept,
 *   unless the client was given its own check.
 *
 * Pass a {@link ProClient} instead of options to share one with a {@link LivePrices}. Options for
 * Pyth's own endpoints without a token throw an InputError on `prices.token`, as the ProClient does.
 */
export function proPriceSource(source: ProClient | ProClientOptions = {}): ProPriceSource {
  const client = source instanceof ProClient ? source : new ProClient(source);
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
    atTick(feedIds, second) {
      return client.atTick(feedList(feedIds), second);
    },
    useSignerCheck(check) {
      client.isTrustedSigner ??= check;
    },
  };
}

/** Whether a context's price source is a {@link proPriceSource} (it then exposes its client). */
export function isProPriceSource(source: unknown): source is ProPriceSource {
  return !!source && (source as ProPriceSource).client instanceof ProClient && typeof (source as ProPriceSource).prints === "function";
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
  /** The second the older leg's price was generated in (unix seconds): what the pair's 3 s window judges. */
  readonly publishTime: number;
  /** Seconds since publishTime at the service's clock. */
  readonly age: number;
  /**
   * Within the pair's window: every leg's price was generated at most 3 s from now and the confidence
   * clears the cap, so a call carrying this print would be accepted by the oracle if it landed now.
   */
  readonly fresh: boolean;
  /**
   * A trading-hours market whose feed has generated no price for {@link VENUE_CLOSED_AFTER} s while
   * the endpoint delivers: its venue is closed. Always false for a 24/7 market.
   */
  readonly venueClosed: boolean;
  /** The legs' prints (base first for a composite). */
  readonly legs: readonly Print[];
}

/** Called with the markets whose price or flags changed (one map per batch; do not keep it). */
export type PriceListener = (changed: ReadonlyMap<Address, MarketPrice>) => void;

export interface LivePricesOptions extends PriceServiceOptions {
  /** Where prints come from when no context source is given: options for a {@link ProClient} of its own... */
  readonly pro?: ProClientOptions;
  /** ...or a client (or any PriceSource) to share. */
  readonly client?: PriceSource;
  /** Seconds without a newly generated price after which a trading-hours market reads closed; default 15. */
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
    // A browser's clock can run seconds or a minute slow; the service's default 5 s future-print bound
    // would then drop every live print. Allow two minutes instead, still bounded.
    this.service = new PriceService(source, { maxFutureSkew: BROWSER_FUTURE_SKEW, ...opts });
    this.closedAfter = opts.closedAfter ?? VENUE_CLOSED_AFTER;
    this.tickMs = opts.tickMs ?? 1000;
    this.reuseAge = opts.reuseAge ?? 1;
    this.source = source;
    this.ready = Promise.resolve();
    this.add(markets, false);
    if (opts.start !== false) this.start();
  }

  /** Stream these markets too, each as its own set of legs (already watched markets are ignored). */
  add(markets: readonly MarketStatic[], fetch = true): void {
    const added: Hex[] = [];
    const sets: Hex[][] = [];
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
      sets.push(market.legs);
    }
    if (added.length === 0) return;
    this.service.watchSets(sets);
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
    // One request for every leg's latest print first, so every market shows a price before its own
    // subscription has delivered.
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
   * The freshest signed update for these feeds: the stream's own (a watched market's legs come in
   * one update) when every feed's price was generated at most `reuseAge` seconds ago, with no
   * request; else one request to the endpoint for exactly these feeds.
   */
  async latest(feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number }> {
    const ids = feedList(feedIds);
    const now = this.now();
    const prints = ids.length > 0 ? this.service.printsFor(ids) : null;
    if (prints !== null && prints.every((p) => now - p.publishTime <= this.reuseAge)) {
      return { update: updateFromPrints(prints), publishTime: Math.min(...prints.map((p) => p.publishTime)) };
    }
    const r = await latestUpdate(this.source, ids);
    this.service.ingest(r.prints); // what was fetched also refreshes the display
    return { update: r.update, publishTime: r.publishTime };
  }

  /** The one-second channel's update stamped `second`, through the source (see {@link proPriceSource}). */
  async atTick(feedIds: readonly Hex[], second: number): Promise<ProUpdate | null> {
    const src = this.source as Partial<Pick<ProClient, "atTick">>;
    if (typeof src.atTick !== "function") throw new ProError("this price source serves no past updates");
    return src.atTick(feedList(feedIds), second);
  }

  /** Has the source refuse updates whose signer `check` does not accept, when it is a {@link ProClient} without a check of its own. */
  useSignerCheck(check: SignerCheck): void {
    if (this.source instanceof ProClient) this.source.isTrustedSigner ??= check;
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
 * With a context, prints come from its {@link proPriceSource}'s client unless `client` or `pro` says
 * otherwise; with markets, one of those is required. Streams at once (one subscription per market on
 * every stream endpoint, polling while the stream fails) after one request for every leg's latest
 * print. Stop it with `stop()`.
 *
 * With a context whose `checkSigners` is not false, a Pyth Pro client without a signer check of its
 * own is given the deployment's ({@link verifierSignerCheck}). Markets alone name no chain to ask, so
 * a client used with them checks signers only when given its own `isTrustedSigner`.
 */
export async function livePrices(source: BazaarContext | readonly MarketStatic[], opts: LivePricesOptions = {}): Promise<LivePrices> {
  const isCtx = !Array.isArray(source);
  const markets = isCtx ? await listMarkets(source as BazaarContext) : (source as readonly MarketStatic[]);
  let client: PriceSource | null = opts.client ?? null;
  if (!client && opts.pro) client = new ProClient(opts.pro);
  if (!client && isCtx) {
    const p = (source as BazaarContext).prices;
    if (isProPriceSource(p)) client = p.client;
  }
  if (!client) {
    throw new ConnectError("live prices need a Pyth Pro source: connect with prices: proPriceSource({ token }), or pass pro or client");
  }
  if (isCtx && client instanceof ProClient && client.isTrustedSigner === null && (source as BazaarContext).checkSigners !== false) {
    const ctx = source as BazaarContext;
    client.isTrustedSigner = verifierSignerCheck(ctx.chain, ctx.oracle);
  }
  return new LivePrices(markets, client, opts);
}
