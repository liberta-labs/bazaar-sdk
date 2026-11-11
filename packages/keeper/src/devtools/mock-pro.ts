/**
 * A Pyth Pro compatible price server for local chains.
 *
 *     bazaar mock-prices --rpc http://127.0.0.1:8545 --price 2=2000 --price 1=60000
 *
 * It serves what the keeper and the SDK's client use: the WebSocket stream (`/v1/stream`), the request
 * API (`POST /v1/latest_price`, `POST /v1/price`) and the symbols registry (`GET /v1/symbols`). Every
 * update is built by the SDK's encoder, signed with the local signing key (lazer.localSignerKey()),
 * which only a local deployment's mock verifier trusts, and stamped with the chain's time, so a local
 * Anvil accepts it as fresh. Point a keeper at it with `prices.endpoint: http://127.0.0.1:8787`. Set
 * prices while it runs:
 *
 *     curl -X POST localhost:8787/mock/price -H 'content-type: application/json' -d '{"id": 2, "price": 1850.5}'
 *
 * Add `"paused": true` (or false) to stop (or resume) the feed generating prices, imitating a closed
 * session: its updates keep coming and carry its last price forward with the time that price was
 * generated, as Pyth's do. Add `"confidence"` to fix the feed's confidence mantissa (0 imitates a
 * feed Pyth reports no confidence for; null returns to the default). A POST under `/mock` must be
 * JSON (`content-type: application/json`). It and a stream connection must name this machine in their
 * Host header (localhost, an IP address, or the --host it listens on) and come from no web page on
 * another origin: a site open in a browser here can neither set prices nor read the stream, directly
 * or through DNS rebinding.
 *
 * It listens on this machine only (localhost, 127.0.0.0/8 or ::1) unless it has a token, since anyone
 * who reaches it can set the prices a keeper acts on. With a token, every request but the symbols
 * registry must present it, the price controls included.
 *
 * Feeds are Pyth Pro feed numbers. Wherever one is taken it may also be given as decimal digits or as
 * the bytes32 a pair reports (its `baseFeedId`).
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { type AddressInfo, isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  AUTH_SUBPROTOCOL,
  CHANNEL_IDS,
  type Channel,
  Chain,
  DEFAULT_CHANNEL,
  ETH_USD_FEED,
  JsonRpc,
  type LazerFeedInput,
  PRO_PROPERTIES,
  type Transport,
  lazer,
  listings,
  proFeedId,
  redactUrl,
} from "@liberta-labs/bazaar-sdk";
import type { Hex } from "viem";
import { type WebSocket, WebSocketServer } from "ws";

/** The exponent every mock price is written at. */
export const EXPO = -8;
/** A feed's confidence unless one is set for it: this many basis points of its price, never less than one unit of the mantissa. */
export const DEFAULT_CONFIDENCE_BP = 10;

const MICROS = 1_000_000n;
/** Microseconds between a channel's updates. Real time has no fixed rate; here it runs as fast as the fastest fixed one. */
const INTERVAL_US: Readonly<Record<Channel, bigint>> = {
  real_time: 50_000n,
  "fixed_rate@50ms": 50_000n,
  "fixed_rate@200ms": 200_000n,
  "fixed_rate@1000ms": MICROS,
};
/** The longest request body, or message from a stream client, read: in bytes. */
const MAX_BODY = 1024 * 1024;
/** The most subscriptions one stream connection holds at once. */
const MAX_SUBSCRIPTIONS = 255;

type Property = (typeof PRO_PROPERTIES)[number];

/** A feed as a caller may name it: its Pyth Pro number, that number's decimal digits, or the bytes32 that holds it. */
export type FeedRef = number | bigint | string;

/** The Pyth Pro feed number `feed` names. Throws for anything that is not one (a composite id included). */
export function feedNumber(feed: FeedRef): number {
  return proFeedId(listings.asFeedId("feed", feed));
}

/** Feed -> value, as a record keyed by any spelling of the feed, a Map or entries. */
export type FeedEntries<V> = Readonly<Record<string, V>> | Iterable<readonly [FeedRef, V]>;

function entries<V>(e: FeedEntries<V> | null | undefined): [number, V][] {
  if (!e) return [];
  const pairs = Symbol.iterator in e ? [...(e as Iterable<readonly [FeedRef, V]>)] : Object.entries(e as Record<string, V>);
  return pairs.map(([k, v]) => [feedNumber(k), v]);
}

/** Round to the nearest integer, halves going to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

/** A USD price as a mantissa at {@link EXPO}. */
function mantissa(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`${String(usd)} is not a price`);
  return BigInt(roundHalfEven(usd * 10 ** -EXPO));
}

// ---- the clock ----

/** The time updates are stamped with. */
export interface MockClock {
  /** Unix seconds, fractions included. */
  now(): number;
  /**
   * Bring {@link now} up to date with its source, for a clock that has one to ask. `recent` lets an
   * answer read in the last moments do (the stream asks on every interval of every subscription);
   * without it the source is asked anew.
   */
  sync?(recent?: boolean): Promise<void>;
}

const systemClock: MockClock = { now: () => Date.now() / 1000 };

/** Milliseconds an answer of the chain's counts as recent. */
const CHAIN_SYNC_MS = 200;

/**
 * A local chain's clock: the latest block's timestamp plus the time since that block was first seen
 * here, which is about the timestamp the chain gives a block mined now. The latest block's timestamp
 * alone would date every update a block behind, and this machine's clock would miss a warp of the
 * chain's. A block with another number or timestamp restarts the count, whichever way it moved.
 *
 * A request reads the chain anew rather than joining a read already under way: a read that started
 * before a warp answers with the time before it, and an update dated then would be stale on the
 * warped chain. Of reads that overlap, the answer of the one started last stands.
 */
class ChainClock implements MockClock {
  private block = -1;
  private timestamp = 0;
  private seen = 0;
  private asked = Number.NEGATIVE_INFINITY;
  private started = 0;
  private taken = 0;
  private asking: Promise<void> | null = null;

  constructor(private readonly chain: Chain) {}

  now(): number {
    return this.block < 0 ? 0 : this.timestamp + (performance.now() / 1000 - this.seen);
  }

  sync(recent = false): Promise<void> {
    if (recent) {
      if (this.asking !== null) return this.asking;
      if (performance.now() - this.asked < CHAIN_SYNC_MS) return Promise.resolve();
    }
    const read = ++this.started;
    const asking = this.chain.block("latest").then((b) => {
      if (read < this.taken) return; // a read started later has answered already
      this.taken = read;
      this.asked = performance.now();
      if (b.number !== this.block || b.timestamp !== this.timestamp) {
        this.block = b.number;
        this.timestamp = b.timestamp;
        this.seen = performance.now() / 1000;
      }
    });
    this.asking = asking;
    void asking.finally(() => {
      if (this.asking === asking) this.asking = null;
    }).catch(() => undefined);
    return asking;
  }
}

// ---- the feeds ----

/** What a feed does from `atUs` on: generate `price` with every update, or stay quiet at it. */
interface Era {
  readonly atUs: bigint;
  /** the price mantissa at {@link EXPO} */
  readonly price: bigint;
  readonly live: boolean;
}

/** One feed as an update stamped at some instant carries it. */
export interface MockFeedState {
  readonly id: number;
  /** The price mantissa; zero when the feed had produced no price by then. */
  readonly price: bigint;
  readonly confidence: bigint;
  /** When that price was generated, in microseconds; zero when there is none. */
  readonly generatedUs: bigint;
}

export interface MockProOptions {
  /** Starting prices in USD, by feed. ETH/USD is added at $2,000 when left out: the keeper prices gas with it. */
  prices?: FeedEntries<number> | null;
  /** Pyth symbols by feed ("Crypto.BTC/USD"), for the symbols registry. */
  symbols?: FeedEntries<string> | null;
  /**
   * The local chain whose time updates are stamped with: a URL, any EIP-1193 transport, or a Chain.
   * Left out, `clock` is used, and without that this machine's clock.
   */
  rpc?: string | Transport | Chain | null;
  clock?: MockClock | (() => number) | null;
  /** The key updates are signed with; default the local signing key. */
  signerKey?: Hex;
  /** See {@link DEFAULT_CONFIDENCE_BP}. */
  confidenceBp?: number;
  /**
   * When set, every request but the symbols registry's (the price controls included) and every stream
   * connection must present it: a bearer header, or the stream's auth subprotocol. Without one, the
   * server listens on this machine only.
   */
  token?: string | null;
}

/** What an update is asked to hold. */
export interface MockUpdateSpec {
  /** The instant it is stamped with, in microseconds. */
  timestampUs: bigint;
  /**
   * The instant its feeds are read at; default the stamp. A live update passes the clock's time: its
   * stamp is the start of the channel's interval, and a price set since then belongs in it.
   */
  asOfUs?: bigint;
  channel?: Channel;
  /** The properties each feed carries; default the four the SDK's client asks for. */
  properties?: readonly string[] | null;
}

/** A signed update and what it carries. */
export interface MockUpdate {
  /** The signed update, as 0x-prefixed hex. */
  readonly blob: Hex;
  readonly timestampUs: bigint;
  readonly channel: Channel;
  readonly feeds: readonly MockFeedState[];
}

export class MockPro {
  readonly clock: MockClock;
  /** Pyth symbols by feed number. */
  readonly symbols = new Map<number, string>();
  readonly confidenceBp: number;
  /** The token clients must present, or null (or empty) to accept any client. */
  token: string | null;

  private readonly signerKey: Hex;
  private readonly eras = new Map<number, Era[]>();
  private readonly confidences = new Map<number, bigint>();

  constructor(opts: MockProOptions = {}) {
    const rpc = opts.rpc ?? null;
    if (rpc !== null) {
      this.clock = new ChainClock(rpc instanceof Chain ? rpc : new Chain(typeof rpc === "string" ? new JsonRpc(rpc, { perSecond: 500 }) : rpc));
    } else {
      this.clock = typeof opts.clock === "function" ? { now: opts.clock } : (opts.clock ?? systemClock);
    }
    this.signerKey = opts.signerKey ?? lazer.localSignerKey();
    this.confidenceBp = opts.confidenceBp ?? DEFAULT_CONFIDENCE_BP;
    this.token = opts.token ?? null;
    // Starting prices hold since the beginning of time, so the archive answers for any past second.
    for (const [id, usd] of entries(opts.prices)) this.eras.set(id, [{ atUs: 0n, price: mantissa(usd), live: true }]);
    const eth = proFeedId(ETH_USD_FEED);
    if (!this.eras.has(eth)) this.eras.set(eth, [{ atUs: 0n, price: mantissa(2000), live: true }]);
    for (const [id, symbol] of entries(opts.symbols)) this.symbols.set(id, symbol);
    if (!this.symbols.has(eth)) this.symbols.set(eth, "Crypto.ETH/USD");
  }

  /**
   * Bring the clock up to date with the chain, when it follows one: asked anew, or, with `recent`, an
   * answer from the last moments will do (see {@link MockClock.sync}).
   */
  async sync(recent = false): Promise<void> {
    await this.clock.sync?.(recent);
  }

  /** The clock's time in microseconds. */
  nowUs(): bigint {
    return BigInt(Math.floor(this.clock.now() * 1e6));
  }

  // ---- controls ----

  /** The feeds the mock serves, ascending. */
  feeds(): number[] {
    return [...this.eras.keys()].sort((a, b) => a - b);
  }

  private last(id: number): Era | undefined {
    return this.eras.get(id)?.at(-1);
  }

  private push(id: number, price: bigint, live: boolean): void {
    const list = this.eras.get(id) ?? [];
    // Never before the era it follows: a clock that stepped back must not reorder the feed's history.
    const prev = list.at(-1);
    const now = this.nowUs();
    list.push({ atUs: prev !== undefined && now < prev.atUs ? prev.atUs : now, price, live });
    this.eras.set(id, list);
  }

  /** The feed's current price in USD, or undefined for a feed the mock does not serve. */
  price(feed: FeedRef): number | undefined {
    const e = this.last(feedNumber(feed));
    return e === undefined ? undefined : Number(e.price) * 10 ** EXPO;
  }

  /** Every feed's current price in USD, by feed number. */
  prices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.feeds()) out[String(id)] = Number(this.last(id)!.price) * 10 ** EXPO;
    return out;
  }

  /**
   * From the clock's time on, `feed` is priced at `usd`. A paused feed stays paused: it generates
   * this one price now and carries it forward. A feed the mock did not serve is added, live.
   */
  setPrice(feed: FeedRef, usd: number): void {
    const id = feedNumber(feed);
    this.push(id, mantissa(Number(usd)), this.last(id)?.live ?? true);
  }

  /** Stop `feed` generating prices: its updates carry the current price forward, generated now. */
  pause(feed: FeedRef): void {
    const id = feedNumber(feed);
    const e = this.last(id);
    if (e === undefined) throw new Error(`no price for feed ${id}`);
    if (e.live) this.push(id, e.price, false);
  }

  /** Have a paused `feed` generate a price with every update again. */
  resume(feed: FeedRef): void {
    const id = feedNumber(feed);
    const e = this.last(id);
    if (e === undefined) throw new Error(`no price for feed ${id}`);
    if (!e.live) this.push(id, e.price, true);
  }

  isPaused(feed: FeedRef): boolean {
    return this.last(feedNumber(feed))?.live === false;
  }

  /**
   * Fix the confidence mantissa every update carries for `feed` (zero included: what Pyth writes for
   * a feed it has no confidence for), or return to the default with null.
   */
  setConfidence(feed: FeedRef, confidence: bigint | number | null): void {
    const id = feedNumber(feed);
    if (confidence === null) this.confidences.delete(id);
    else this.confidences.set(id, BigInt(confidence));
  }

  // ---- updates ----

  /**
   * `id` as an update stamped `timestampUs` carries it, read at `asOfUs` (default the stamp), or null
   * for a feed the mock does not serve.
   */
  stateAt(id: number, timestampUs: bigint, asOfUs: bigint = timestampUs): MockFeedState | null {
    const list = this.eras.get(id);
    if (list === undefined) return null;
    let era: Era | undefined;
    for (const e of list) {
      if (e.atUs > asOfUs) break;
      era = e;
    }
    // Before its first price the feed has none, which Pyth writes as a zero price with no generation time.
    if (era === undefined) return { id, price: 0n, confidence: 0n, generatedUs: 0n };
    let confidence = this.confidences.get(id);
    if (confidence === undefined) {
      confidence = (era.price * BigInt(this.confidenceBp)) / 10_000n;
      if (confidence < 1n) confidence = 1n;
    }
    // A live feed generates a price with every update; a quiet one last did when it went quiet (never
    // later than the update's own stamp, which may lie a little before the instant it is read at).
    return { id, price: era.price, confidence, generatedUs: era.live || era.atUs > timestampUs ? timestampUs : era.atUs };
  }

  /**
   * A signed update for the feeds among `feeds` the mock serves, in the order given, each once. A
   * feed it does not serve is left out, as Pyth leaves out one it does not know.
   */
  async update(feeds: readonly FeedRef[], spec: MockUpdateSpec): Promise<MockUpdate> {
    const channel = spec.channel ?? DEFAULT_CHANNEL;
    const want = new Set<string>(spec.properties ?? PRO_PROPERTIES);
    const has = (p: Property) => want.has(p);
    const states: MockFeedState[] = [];
    const seen = new Set<number>();
    for (const f of feeds) {
      const id = feedNumber(f);
      if (seen.has(id)) continue;
      seen.add(id);
      const s = this.stateAt(id, spec.timestampUs, spec.asOfUs);
      if (s !== null) states.push(s);
    }
    if (states.length > lazer.MAX_FEEDS_PER_UPDATE) throw new Error(`an update carries at most ${lazer.MAX_FEEDS_PER_UPDATE} feeds`);
    const payload: LazerFeedInput[] = states.map((s) => ({
      id: s.id,
      ...(has("price") ? { price: s.price } : {}),
      ...(has("exponent") ? { exponent: EXPO } : {}),
      ...(has("confidence") ? { confidence: s.confidence } : {}),
      ...(has("feedUpdateTimestamp") ? { feedUpdateTimestamp: s.generatedUs } : {}),
    }));
    const blob = await lazer.buildUpdate({ timestampUs: spec.timestampUs, channel, feeds: payload }, this.signerKey);
    return { blob, timestampUs: spec.timestampUs, channel, feeds: states };
  }

  /** The newest update `channel` has issued by the clock's time: stamped on the channel's last interval. */
  async latest(feeds: readonly FeedRef[], channel: Channel = DEFAULT_CHANNEL, properties?: readonly string[] | null): Promise<MockUpdate> {
    await this.sync();
    const now = this.nowUs();
    return this.update(feeds, { timestampUs: now - (now % INTERVAL_US[channel]), asOfUs: now, channel, properties });
  }

  /**
   * The one-second channel's update stamped `second`, or null for a second that has not come yet. A
   * quiet feed's entry holds its last price with the earlier time it was generated.
   */
  async tick(feeds: readonly FeedRef[], second: number, properties?: readonly string[] | null): Promise<MockUpdate | null> {
    await this.sync();
    const timestampUs = BigInt(second) * MICROS;
    if (timestampUs > this.nowUs()) return null;
    return this.update(feeds, { timestampUs, channel: "fixed_rate@1000ms", properties });
  }

  /** The symbols registry's entries, as Pyth's `/v1/symbols` words them. */
  registry(): Record<string, unknown>[] {
    return this.feeds().map((id) => {
      const symbol = this.symbols.get(id) ?? "";
      const dot = symbol.indexOf(".");
      return {
        pyth_lazer_id: id,
        name: symbol.slice(symbol.lastIndexOf(".") + 1).replace("/", ""),
        symbol,
        description: symbol.slice(symbol.lastIndexOf(".") + 1),
        asset_type: dot > 0 ? symbol.slice(0, dot).toLowerCase() : "",
        exponent: EXPO,
        min_channel: "real_time",
        state: "stable",
        schedule: "",
      };
    });
  }
}

// ---- the server ----

function json(res: ServerResponse, code: number, obj: unknown): void {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class BadRequest extends Error {}

const UNAUTHORIZED = "authentication required: pass the access token as a bearer credential";

/**
 * Whether `host` (a URL's hostname as the URL parser writes it, or an address to listen on) is this
 * machine: exactly `localhost`, an address in 127.0.0.0/8, or ::1. A name under `.localhost` does not
 * count: a resolver that answers for it (Node's on some systems, and some browsers') can point it at
 * any address, which is how DNS rebinding gets in.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Why the server must not listen on `host` with this token, or null when it may: an address other
 * machines can reach needs a token, since anyone who reaches the server can set the prices a keeper
 * acts on.
 */
export function listenRefusal(host: string, token: string | null): string | null {
  if (isLoopbackHost(host) || (token !== null && token !== "")) return null;
  return (
    `not listening on ${host}: other machines may reach the mock there, and anyone who reaches it can set the prices a keeper acts on. ` +
    "Listen on 127.0.0.1, or give the mock a token (bazaar mock-prices --token-env)"
  );
}

/** A Host header's name that DNS rebinding cannot produce: a loopback name, an IP address, or the host the server listens on. */
function trustedHostName(name: string, listenHost: string): boolean {
  const h = name.toLowerCase();
  return isLoopbackHost(h) || isIP(h.replace(/^\[(.*)\]$/, "$1")) !== 0 || h === listenHost.toLowerCase();
}

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Why a request a browser page may have made is refused, as [status, message], or null to serve it.
 * The price controls change what a keeper sees and the stream is the keeper's, so both are for this
 * machine's clients only: the Host must be a loopback name, an IP address or the host the server
 * listens on (any other name means DNS rebinding), and an Origin, if sent, must be a loopback one
 * (any other is a web page from elsewhere). `what` is what such a page cannot do, for the message.
 */
function refuseForeign(req: IncomingMessage, listenHost: string, what: string): [number, string] | null {
  const host = hostnameOf(req.headers.host ?? "");
  if (host === null || !trustedHostName(host, listenHost)) {
    return [403, "refused: the Host header must be localhost or an IP address (this is a local test server)"];
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // "null" (a sandboxed page, a file) or garbage: not local
    }
    if (originHost === null || !isLoopbackHost(originHost)) return [403, `refused: a web page on another origin cannot ${what}`];
  }
  return null;
}

/**
 * Why a POST under /mock is refused, as [status, message], or null to serve it: a request from a
 * page elsewhere ({@link refuseForeign}), or a body not declared JSON, which a page cannot send
 * cross-origin without a preflight this server never answers.
 */
function refusePost(req: IncomingMessage, listenHost: string): [number, string] | null {
  const foreign = refuseForeign(req, listenHost, "set prices");
  if (foreign !== null) return foreign;
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return [415, "send the body as JSON, with content-type: application/json"];
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BadRequest("the body is too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)) || "{}");
  } catch (e) {
    throw new BadRequest(errorText(e));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Whether a request's headers present the mock's token (always, when it asks for none: null or empty). */
function authorized(mock: MockPro, req: IncomingMessage): boolean {
  if (!mock.token) return true;
  if (req.headers.authorization === `Bearer ${mock.token}`) return true;
  // The stream's other way in: the subprotocol list names the auth subprotocol, then the token.
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const at = offered.indexOf(AUTH_SUBPROTOCOL);
  return at >= 0 && offered[at + 1] === mock.token;
}

/** What a request or a subscription asks for, read from its JSON as Pyth's API names it. */
interface Query {
  feeds: number[];
  /** feed ids that are not Pyth Pro feed numbers, or that the mock does not serve */
  unknown: unknown[];
  channel: Channel;
  properties: string[] | null;
  base64: boolean;
}

function query(mock: MockPro, body: Record<string, unknown>): Query {
  const ids = body.priceFeedIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new BadRequest("'priceFeedIds' must be a list of Pyth Pro feed ids");
  if (ids.length > lazer.MAX_FEEDS_PER_UPDATE) {
    throw new BadRequest(`'priceFeedIds' names ${ids.length} feeds, and one update carries at most ${lazer.MAX_FEEDS_PER_UPDATE}`);
  }
  const channel = body.channel === undefined ? DEFAULT_CHANNEL : body.channel;
  if (typeof channel !== "string" || !Object.hasOwn(CHANNEL_IDS, channel)) throw new BadRequest(`'channel' must be one of ${Object.keys(CHANNEL_IDS).join(", ")}`);
  const formats = body.formats;
  if (formats !== undefined && !(Array.isArray(formats) && formats.includes("evm"))) throw new BadRequest("'formats' must include \"evm\": this server signs nothing else");
  const properties = body.properties;
  if (properties !== undefined && !(Array.isArray(properties) && properties.every((p) => typeof p === "string"))) {
    throw new BadRequest("'properties' must be a list of property names");
  }
  const served = new Set(mock.feeds());
  const feeds: number[] = [];
  const unknown: unknown[] = [];
  for (const raw of ids) {
    const id = typeof raw === "number" && Number.isInteger(raw) ? raw : Number.NaN;
    if (served.has(id)) feeds.push(id);
    else unknown.push(raw);
  }
  return { feeds, unknown, channel: channel as Channel, properties: (properties as string[] | undefined) ?? null, base64: body.jsonBinaryEncoding === "base64" };
}

/** An update as the request API and the stream send it: the decoded prices beside the signed bytes. */
function message(u: MockUpdate, base64: boolean): Record<string, unknown> {
  const hex = u.blob.slice(2);
  return {
    parsed: {
      timestampUs: u.timestampUs.toString(),
      priceFeeds: u.feeds.map((f) => ({
        priceFeedId: f.id,
        price: f.price.toString(),
        exponent: EXPO,
        confidence: Number(f.confidence),
        feedUpdateTimestamp: Number(f.generatedUs),
      })),
    },
    evm: base64 ? { encoding: "base64", data: Buffer.from(hex, "hex").toString("base64") } : { encoding: "hex", data: hex },
  };
}

async function handle(mock: MockPro, req: IncomingMessage, res: ServerResponse, listenHost: string): Promise<void> {
  const u = new URL(req.url ?? "/", "http://mock");
  const path = u.pathname.replace(/\/+$/, "");
  if (req.method === "GET") {
    if (path === "/mock/price") return authorized(mock, req) ? json(res, 200, mock.prices()) : json(res, 401, { error: UNAUTHORIZED });
    if (path === "/v1/symbols") {
      // The registry needs no token, as Pyth's needs none.
      const text = (u.searchParams.get("query") ?? "").toLowerCase();
      const type = u.searchParams.get("asset_type");
      return json(
        res,
        200,
        mock.registry().filter((s) => (!text || String(s.symbol).toLowerCase().includes(text)) && (!type || s.asset_type === type)),
      );
    }
    return json(res, 404, { error: "not found" });
  }
  if (req.method !== "POST") {
    res.writeHead(501, { "content-type": "text/plain" });
    res.end(`Unsupported method (${req.method ?? ""})`);
    return;
  }
  if (path === "/mock/price") {
    const refused = refusePost(req, listenHost) ?? (authorized(mock, req) ? null : ([401, UNAUTHORIZED] as const));
    if (refused !== null) {
      req.resume(); // the body is not read: drain it
      return json(res, refused[0], { error: refused[1] });
    }
    try {
      const body = await jsonBody(req);
      const price = body.price;
      const usd = typeof price === "number" ? price : typeof price === "string" && price.trim() !== "" ? Number(price) : Number.NaN;
      const conf = body.confidence;
      if (typeof body.id !== "number" && typeof body.id !== "string") throw new BadRequest("'id' must be a feed id");
      if (!Number.isFinite(usd) || usd < 0) throw new BadRequest("'price' must be a number");
      if (conf !== undefined && conf !== null && !(typeof conf === "number" && Number.isSafeInteger(conf) && conf >= 0)) {
        throw new BadRequest("'confidence' must be a whole number (the mantissa at exponent -8) or null");
      }
      let id: number;
      try {
        id = feedNumber(body.id);
      } catch {
        throw new BadRequest("'id' must be a Pyth Pro feed id: a number, or the bytes32 that holds it");
      }
      await mock.sync(); // the change is dated with the chain's time
      mock.setPrice(id, usd);
      if ("paused" in body) {
        if (body.paused) mock.pause(id);
        else mock.resume(id);
      }
      if (conf !== undefined) mock.setConfidence(id, conf);
      return json(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof BadRequest) return json(res, 400, { error: e.message });
      throw e;
    }
  }
  if (path === "/v1/latest_price" || path === "/v1/price") {
    if (!authorized(mock, req)) {
      req.resume();
      return json(res, 401, { error: UNAUTHORIZED });
    }
    try {
      const body = await jsonBody(req);
      const q = query(mock, body);
      if (path === "/v1/latest_price") return json(res, 200, message(await mock.latest(q.feeds, q.channel, q.properties), q.base64));
      const ts = body.timestamp;
      if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) throw new BadRequest("'timestamp' must be a unix time in microseconds, as a number");
      if (q.channel !== "fixed_rate@1000ms" || ts % 1_000_000 !== 0) {
        throw new BadRequest("this server archives only the fixed_rate@1000ms channel: 'timestamp' must be a whole second on it");
      }
      const tick = await mock.tick(q.feeds, ts / 1_000_000, q.properties);
      if (tick === null) return json(res, 404, { error: "no update for that timestamp yet" });
      return json(res, 200, message(tick, q.base64));
    } catch (e) {
      if (e instanceof BadRequest) return json(res, 400, { error: e.message });
      throw e;
    }
  }
  return json(res, 404, { error: "not found" });
}

/** One stream connection: a timer per subscription, each sending an update at once and then one per interval of its channel. */
function serveStream(mock: MockPro, socket: WebSocket, open: Set<() => void>): void {
  const timers = new Map<number, ReturnType<typeof setInterval>>();
  let closed = false;
  const say = (obj: unknown) => {
    if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    open.delete(stop);
    // At once, without a closing handshake: a server that is shutting down must not wait on its clients.
    socket.terminate();
  };
  open.add(stop);
  socket.on("close", stop);
  socket.on("error", stop);

  const subscribe = (subscriptionId: number, q: Query): void => {
    const old = timers.get(subscriptionId);
    if (old !== undefined) clearInterval(old);
    const interval = INTERVAL_US[q.channel];
    let last = -1n;
    let busy = false;
    const send = async (): Promise<void> => {
      if (busy || closed) return; // a tick that outlasts its interval is not overtaken
      busy = true;
      try {
        await mock.sync(true);
        const now = mock.nowUs();
        const timestampUs = now - (now % interval);
        // Only a later instant than the last one sent: a client takes nothing else.
        if (timestampUs <= last) return;
        last = timestampUs;
        const u = await mock.update(q.feeds, { timestampUs, asOfUs: now, channel: q.channel, properties: q.properties });
        say({ type: "streamUpdated", subscriptionId, ...message(u, q.base64) });
      } catch (e) {
        say({ type: "error", error: errorText(e) });
      } finally {
        busy = false;
      }
    };
    timers.set(subscriptionId, setInterval(() => void send(), Number(interval / 1000n)));
    void send();
  };

  socket.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      msg = parsed as Record<string, unknown>;
    } catch {
      return say({ type: "error", error: "a message must be a JSON object" });
    }
    const subscriptionId = msg.subscriptionId;
    if (typeof subscriptionId !== "number" || !Number.isInteger(subscriptionId)) return say({ type: "error", error: "'subscriptionId' must be a whole number" });
    if (msg.type === "unsubscribe") {
      const t = timers.get(subscriptionId);
      if (t !== undefined) clearInterval(t);
      timers.delete(subscriptionId);
      return say({ type: "unsubscribed", subscriptionId });
    }
    if (msg.type !== "subscribe") return say({ type: "error", error: "'type' must be subscribe or unsubscribe" });
    if (!timers.has(subscriptionId) && timers.size >= MAX_SUBSCRIPTIONS) {
      return say({ type: "subscriptionError", subscriptionId, error: `a connection holds at most ${MAX_SUBSCRIPTIONS} subscriptions: unsubscribe one first` });
    }
    let q: Query;
    try {
      q = query(mock, msg);
    } catch (e) {
      return say({ type: "subscriptionError", subscriptionId, error: errorText(e) });
    }
    if (q.feeds.length === 0) return say({ type: "subscriptionError", subscriptionId, error: `no feed among ${JSON.stringify(q.unknown)} is served here` });
    if (q.unknown.length > 0) {
      say({ type: "subscribedWithInvalidFeedIdsIgnored", subscriptionId, subscribedFeedIds: q.feeds, ignoredInvalidFeedIds: { unknownIds: q.unknown } });
    } else {
      say({ type: "subscribed", subscriptionId });
    }
    subscribe(subscriptionId, q);
  });
}

export interface MockProServer {
  /** where to point `prices.endpoint`: the request API and the symbols registry */
  readonly url: string;
  /** the stream's WebSocket URL, which `prices.endpoint` implies */
  readonly streamUrl: string;
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  /** Ends the open streams and stops listening. */
  close(): Promise<void>;
}

/** Serve `mock` in the background (port 0 picks a free one); resolves once it listens. */
export async function startMockPro(mock: MockPro, opts: { host?: string; port?: number } = {}): Promise<MockProServer> {
  const host = opts.host ?? "127.0.0.1";
  const refusal = listenRefusal(host, mock.token);
  if (refusal !== null) throw new Error(refusal);
  const open = new Set<() => void>();
  const server = createServer((req, res) => {
    handle(mock, req, res, host).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: errorText(e) });
      else res.destroy();
    });
  });
  // A client that authenticates through the subprotocol list expects the auth subprotocol back.
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY,
    handleProtocols: (offered) => (offered.has(AUTH_SUBPROTOCOL) ? AUTH_SUBPROTOCOL : false),
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://mock").pathname.replace(/\/+$/, "");
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (path !== "/v1/stream") return refuse("404 Not Found");
    if (refuseForeign(req, host, "read the price stream") !== null) return refuse("403 Forbidden");
    if (!authorized(mock, req)) return refuse("401 Unauthorized");
    sockets.handleUpgrade(req, socket, head, (ws) => serveStream(mock, ws, open));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}`,
    streamUrl: `ws://${shown}:${port}/v1/stream`,
    host,
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const stop of [...open]) stop();
        sockets.close();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/**
 * `bazaar mock-prices`: serve in the foreground until Ctrl-C (or SIGTERM). `token`, when set, is what
 * every client must present; without one the server listens on this machine only.
 */
export async function serveMockPro(
  rpcUrl: string,
  prices: FeedEntries<number>,
  opts: { host?: string; port?: number; token?: string | null } = {},
): Promise<void> {
  const refusal = listenRefusal(opts.host ?? "127.0.0.1", opts.token ?? null);
  if (refusal !== null) throw new Error(refusal);
  const mock = new MockPro({ rpc: rpcUrl, prices, token: opts.token ?? null });
  await mock.sync(); // fails here, before listening, when the chain does not answer
  const srv = await startMockPro(mock, { host: opts.host, port: opts.port });
  // The chain's URL is shown masked: even a local one may hold a provider's key.
  console.log(`mock Pyth Pro on ${srv.url} (stream ${srv.streamUrl}), on the clock of ${redactUrl(rpcUrl)}; feeds: ${mock.feeds().join(", ")}`);
  if (!isLoopbackHost(srv.host)) {
    console.warn(
      `warning: listening on ${srv.host}, where other machines may reach the mock: every request but the symbols registry must present its token. ` +
        "Its updates are signed with a public test key, which only a local deployment trusts",
    );
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await srv.close();
}
