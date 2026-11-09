/**
 * Client for the Hermes v2 price API (Pyth's own, a proxy, or the keeper's mock in devtools).
 *
 * Browser-safe: requests go through `fetch`, and the live stream is read from `response.body` as
 * server-sent events rather than with `EventSource`, which cannot send the Authorization header.
 */

import { type Hex, decodeAbiParameters } from "viem";
import { isUrl, redactUrl, urlCredential } from "../urls.js";
import { MAX_EXPO, type Scan, isAccumulator, messageAt, normalizeHex, readCore, scan } from "./accumulator.js";

/**
 * One feed's print and a signed update that carries it. Every field but `received` is read from the
 * update itself (the bytes a call attaches and the chain verifies), never from the endpoint's JSON.
 */
export interface Print {
  readonly feedId: Hex;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: number;
  readonly prevPublishTime: number | null;
  /** the update data to attach to a call: a multi-feed accumulator update, or one feed's own */
  readonly blob: Hex;
  /** when it arrived, in seconds on a monotonic clock (`performance.now() / 1000`) */
  readonly received: number;
}

export class HermesError extends Error {
  override readonly name = "HermesError";
}

// ---- the wire format ----

export interface HermesPrice {
  readonly price: string | number;
  readonly conf: string | number;
  readonly expo: number | string;
  readonly publish_time: number | string;
}

export interface HermesParsedUpdate {
  readonly id: string;
  readonly price: HermesPrice;
  readonly ema_price?: HermesPrice;
  readonly metadata?: {
    readonly slot?: number;
    readonly proof_available_time?: number;
    readonly prev_publish_time?: number | null;
  } | null;
}

/** The body of `/v2/updates/price/...` and of each stream event. */
export interface HermesUpdates {
  readonly binary?: { readonly encoding?: string; readonly data?: readonly string[] | null } | null;
  readonly parsed?: readonly HermesParsedUpdate[] | null;
}

/** One entry of `/v2/price_feeds`. */
export interface PriceFeedMetadata {
  readonly id?: string;
  readonly attributes?: { readonly symbol?: string; readonly [key: string]: unknown } | null;
  readonly [key: string]: unknown;
}

/** @internal */
export function monotonic(): number {
  return performance.now() / 1000;
}

// The layouts of the most recent accumulator blobs, found when their response was parsed, so cutting
// a pair's update out of one later (PriceService.updateFor) needs no second parse. Every print of a
// response shares its blob string, so a lookup is a comparison of references, and recording one costs
// nothing per print (a WeakMap entry per print costs more than the rest of the parse).
const RECENT = 16;
const recent: (Scan | undefined)[] = new Array<Scan | undefined>(RECENT);
let recentNext = 0;

function remember(s: Scan): void {
  recent[recentNext] = s;
  recentNext = (recentNext + 1) % RECENT;
}

/**
 * The layout of an accumulator print's blob: the one its response was parsed with while it is among
 * the recent ones, or found now.
 * @internal
 */
export function scanOf(p: Print): Scan {
  const blob = p.blob;
  for (let k = 1; k <= RECENT; k++) {
    const s = recent[(recentNext - k + RECENT) % RECENT];
    if (s === undefined) break;
    if (s.hex === blob) return s;
  }
  const h = normalizeHex(blob);
  if (h === null) throw new HermesError("malformed update data: not hex");
  const s = scan(h);
  remember(s);
  return s;
}

function malformed(what: string): HermesError {
  return new HermesError(`malformed price update: ${what}`);
}

/** A value from the endpoint, short enough to quote in a message. */
function shown(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

const short = (f: Hex) => `${f.slice(0, 10)}…`;

function toBig(v: unknown, what: string): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    // an int64 or uint64 has at most 20 digits: a longer string is refused before BigInt parses it
    if (typeof v === "string" && v.length <= 32 && v.trim() !== "") return BigInt(v.trim());
  } catch {
    // fall through
  }
  throw malformed(`${what} is ${shown(v)}`);
}

function toInt(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.length <= 32 && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw malformed(`${what} is ${shown(v)}`);
  return Math.trunc(n);
}

/**
 * Whether the endpoint's JSON value (a decimal string or a number) is exactly `v`. Hermes' form, a
 * plain decimal string of up to 15 digits, is compared from its character codes; anything else is
 * parsed with {@link toBig}, which throws on a malformed one.
 */
function sameBig(j: unknown, v: bigint, what: string): boolean {
  if (typeof j === "string" && j.length > 0 && j.length <= 16) {
    let i = j.charCodeAt(0) === 45 ? 1 : 0; // "-"
    const digits = j.length - i;
    if (digits > 0 && digits <= 15) {
      let x = 0;
      for (; i < j.length; i++) {
        const c = j.charCodeAt(i) - 48;
        if (c < 0 || c > 9) break;
        x = x * 10 + c;
      }
      // below 10^15 the number is exact, and a bigint past 2^53 converts to a larger one
      if (i === j.length) return Number(v) === (j.charCodeAt(0) === 45 ? -x : x);
    }
  }
  return toBig(j, what) === v;
}

/** Whether the endpoint's JSON value (a number, or a numeric string) is exactly `v`. */
function sameInt(j: unknown, v: number, what: string): boolean {
  return typeof j === "number" ? j === v : toInt(j, what) === v;
}

// MockPyth.createPriceFeedUpdateData: abi.encode(PriceFeed(id, price, emaPrice), prevPublishTime),
// the update data of local deployments (the keeper's mock Hermes serves it).
const PRICE_STRUCT = [
  { name: "price", type: "int64" },
  { name: "conf", type: "uint64" },
  { name: "expo", type: "int32" },
  { name: "publishTime", type: "uint256" },
] as const;
const MOCK_FEED = [
  {
    type: "tuple",
    components: [
      { name: "id", type: "bytes32" },
      { name: "price", type: "tuple", components: PRICE_STRUCT },
      { name: "emaPrice", type: "tuple", components: PRICE_STRUCT },
    ],
  },
  { type: "uint64" },
] as const;
const MOCK_FEED_HEX = 2 + 2 * 320;
const I64 = 1n << 63n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The print a MockPyth update carries, checked as an accumulator's price message is. */
function mockPrint(b: Hex, received: number): Print {
  if (b.length !== MOCK_FEED_HEX) {
    throw new HermesError("price endpoint sent update data the SDK cannot read (neither a Pyth accumulator update nor MockPyth's): refusing the response");
  }
  const [feed, prev] = decodeAbiParameters(MOCK_FEED, b);
  const p = feed.price;
  const feedId = feed.id.toLowerCase() as Hex;
  // the words hold any 256-bit value; MockPyth's types are int64, uint64 and int32
  if (p.price < -I64 || p.price >= I64 || p.conf < 0n || p.conf >= 1n << 64n || p.expo > MAX_EXPO || p.expo < -MAX_EXPO || p.publishTime > SAFE || prev > SAFE) {
    throw new HermesError(`price endpoint's update for feed ${short(feedId)} holds values out of range: refusing the response`);
  }
  return { feedId, price: p.price, conf: p.conf, expo: p.expo, publishTime: Number(p.publishTime), prevPublishTime: Number(prev), blob: b, received };
}

/**
 * The prints a Hermes response's update data carries, each read from the data itself: every price
 * message of a Pyth accumulator update (a feed it carries twice counts once, its first), or the one
 * feed of a MockPyth update. The response's `parsed` JSON is only checked against them: a parsed
 * print that disagrees with its update (price, conf, expo or publish time), or names a feed no update
 * carries, makes the whole response refused with a HermesError, as does update data in another format.
 *
 * With `want`, only those feeds' prints are kept (and checked): the rest of the response is ignored.
 */
export function parseResponse(body: HermesUpdates, received: number = monotonic(), want?: ReadonlySet<Hex> | null): Print[] {
  if (body === null || typeof body !== "object") throw new HermesError("malformed price response");
  const data = body.binary?.data ?? [];
  if (!Array.isArray(data)) throw new HermesError("malformed update data: not a list");
  const out: Print[] = [];
  const byFeed = new Map<Hex, Print>();
  for (const d of data) {
    const b = typeof d === "string" ? normalizeHex(d) : null;
    if (b === null) throw new HermesError("malformed update data: not hex");
    if (!isAccumulator(b)) {
      const p = mockPrint(b, received);
      if (want && !want.has(p.feedId)) continue;
      out.push(p);
      byFeed.set(p.feedId, p);
      continue;
    }
    try {
      const s = scan(b);
      remember(s);
      for (const u of s.updates) {
        const feedId = u.feedId;
        if (feedId === null || (want && !want.has(feedId))) continue;
        if (byFeed.get(feedId)?.blob === b) continue; // carried twice: the first counts, as subsetOf cuts it
        const c = readCore(b, messageAt(u));
        const p: Print = { feedId, price: c.price, conf: c.conf, expo: c.expo, publishTime: c.publishTime, prevPublishTime: c.prevPublishTime, blob: b, received };
        out.push(p);
        byFeed.set(feedId, p);
      }
    } catch (e) {
      throw new HermesError(`malformed update data: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const parsed = body.parsed ?? [];
  if (!Array.isArray(parsed)) throw malformed("parsed is not a list");
  let next = 0; // Hermes lists the parsed prints in the update's order: try that one first
  for (const j of parsed) {
    const id: unknown = j?.id;
    let p: Print | undefined = out[next];
    if (p !== undefined && typeof id === "string" && id.length === 64 && p.feedId.endsWith(id)) {
      next++;
    } else {
      const feedId = typeof id === "string" ? normalizeHex(id) : null;
      if (feedId === null) throw malformed(`feed id ${shown(id)}`);
      if (want && !want.has(feedId)) continue;
      p = byFeed.get(feedId);
      if (p === undefined) {
        throw new HermesError(`price endpoint sent a print for feed ${short(feedId)} without update data that carries it: refusing the response`);
      }
    }
    const price = j.price;
    if (price === null || typeof price !== "object") throw malformed(`no price for ${p.feedId}`);
    const off = !sameBig(price.price, p.price, "price")
      ? "price"
      : !sameBig(price.conf, p.conf, "conf")
        ? "conf"
        : !sameInt(price.expo, p.expo, "expo")
          ? "expo"
          : !sameInt(price.publish_time, p.publishTime, "publish_time")
            ? "publish time"
            : null;
    if (off !== null) {
      throw new HermesError(`price endpoint's ${off} for feed ${short(p.feedId)} disagrees with its signed update: refusing the response`);
    }
  }
  return out;
}

// ---- the client ----

/**
 * Seconds a price stream may stay silent before it is abandoned and reconnected. Hermes sends prints
 * several times a second, so silence this long means the connection is dead, not quiet.
 */
export const STREAM_IDLE_TIMEOUT = 10;

export interface StreamOptions {
  /**
   * Seconds without any data (an event or a keep-alive comment, or the response itself) after which
   * the stream is aborted with a HermesError; default {@link STREAM_IDLE_TIMEOUT}, null or 0 to wait
   * forever.
   */
  idleTimeout?: number | null;
}

export interface HermesClientOptions {
  /** seconds a request may take (not the stream, which has no limit); default 10 */
  timeout?: number;
  fetch?: typeof fetch;
}

function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const c = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const msg = e.message || e.name;
  return c && !msg.includes(c) ? `${msg} (${c})` : msg;
}

function noop(): void {}

/**
 * The longest line a price stream may send, in characters (4 MiB). A Hermes event for every feed a
 * keeper watches is well under 1 MiB; a stream that sends more without a line break is dropped.
 */
export const MAX_STREAM_LINE = 4 * 1024 * 1024;

/** The largest response body a price request may return, in bytes (16 MiB). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function lineTooLong(): HermesError {
  return new HermesError(`price stream sent a line longer than ${MAX_STREAM_LINE / 1024 / 1024} MiB: dropping the stream`);
}

/**
 * Splits text into lines at \n, \r\n or \r as its chunks arrive, as server-sent events are read.
 * Throws a HermesError once a line grows past {@link MAX_STREAM_LINE} characters.
 */
class LineBuffer {
  private partial = "";
  private afterCr = false;
  private readonly out: string[] = [];

  /** The lines this chunk completes (the array is reused by the next call). */
  push(text: string, final: boolean): readonly string[] {
    const out = this.out;
    out.length = 0;
    const n = text.length;
    let i = 0;
    if (this.afterCr && n > 0) {
      if (text.charCodeAt(0) === 10) i = 1; // the \n of a \r\n split across chunks
      this.afterCr = false;
    }
    let cr = text.indexOf("\r", i);
    while (i < n) {
      if (cr !== -1 && cr < i) cr = text.indexOf("\r", i);
      const nl = text.indexOf("\n", i);
      let end: number;
      let next: number;
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        end = cr;
        if (cr + 1 < n) {
          next = text.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
        } else {
          next = n;
          this.afterCr = true;
        }
      } else if (nl !== -1) {
        end = nl;
        next = nl + 1;
      } else {
        break;
      }
      if (end - i + this.partial.length > MAX_STREAM_LINE) throw lineTooLong();
      const piece = text.slice(i, end);
      out.push(this.partial ? this.partial + piece : piece);
      this.partial = "";
      i = next;
    }
    if (i < n) {
      if (n - i + this.partial.length > MAX_STREAM_LINE) throw lineTooLong();
      this.partial += text.slice(i);
    }
    if (final && this.partial) {
      out.push(this.partial);
      this.partial = "";
    }
    return out;
  }
}

function tooBig(): HermesError {
  return new HermesError(`price endpoint's response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB: refusing it`);
}

/** A response's body as text, refusing one larger than {@link MAX_RESPONSE_BYTES}. */
async function bodyText(r: Response): Promise<string> {
  if (Number(r.headers.get("content-length") ?? Number.NaN) > MAX_RESPONSE_BYTES) {
    r.body?.cancel().catch(noop);
    throw tooBig();
  }
  if (r.body === null) return "";
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw tooBig();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (e) {
    reader.cancel().catch(noop);
    throw e;
  }
}

// A header value fetch accepts: no control characters but tab, nothing past Latin-1. A key with a
// stray line break would otherwise fail inside fetch, whose error quotes the whole value.
const BAD_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class HermesClient {
  readonly base: string;
  private readonly headers: Record<string, string>;
  /** values masked in every message: the key, and header values long enough to be secrets */
  private readonly secrets: string[] = [];
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly streams = new Set<AbortController>();

  /**
   * `apiKey` is sent as "Authorization: Bearer <key>". Throws a HermesError (naming the setting,
   * never the value) when the key or a header holds a line break or another character a request
   * header cannot carry.
   */
  constructor(
    baseUrl: string,
    apiKey?: string | null,
    headers?: Readonly<Record<string, string>> | null,
    opts: HermesClientOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    const h: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!HEADER_NAME.test(name)) throw new HermesError(`price endpoint header ${shown(name)} is not a valid HTTP header name`);
      if (typeof value !== "string" || BAD_HEADER_VALUE.test(value)) {
        throw new HermesError(`price endpoint header ${name} has a value a request header cannot carry (a line break or control character?): re-enter it`);
      }
      h[name] = value;
      if (value.trim().length >= 8) this.secrets.push(value.trim());
    }
    if (apiKey) {
      if (BAD_HEADER_VALUE.test(apiKey)) {
        throw new HermesError("the price endpoint's API key (prices.apiKey) holds a line break or another character a request header cannot carry: re-enter it");
      }
      h.Authorization = `Bearer ${apiKey}`;
      if (apiKey.trim()) this.secrets.push(apiKey.trim());
    }
    this.secrets.sort((a, b) => b.length - a.length); // a secret containing another is masked whole
    this.headers = h;
    this.timeoutMs = (opts.timeout ?? 10) * 1000;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The base URL as it may be printed: with any key in it masked. */
  get displayUrl(): string {
    return redactUrl(this.base);
  }

  /** Ends any open streams. */
  async close(): Promise<void> {
    for (const c of this.streams) c.abort();
    this.streams.clear();
  }

  /**
   * The query for `ids`. `ignore_invalid_price_ids` keeps one feed Hermes does not know from failing
   * the whole request with a 404: the response then leaves that feed out (PriceService reports it).
   */
  private static query(ids: readonly Hex[]): string {
    const q = new URLSearchParams();
    for (const f of ids) q.append("ids[]", f.toLowerCase());
    q.append("encoding", "hex");
    q.append("parsed", "true");
    q.append("ignore_invalid_price_ids", "true");
    return q.toString();
  }

  /** The feeds a response may bring: those asked for (anything else it names is ignored). */
  private static wanted(ids: readonly Hex[]): Set<Hex> {
    const out = new Set<Hex>();
    for (const f of ids) out.add(f.toLowerCase() as Hex);
    return out;
  }

  /** A message with the request URL and the base URL in it masked, and the key and secrets. */
  private scrub(msg: string, url: string): string {
    let out = msg;
    for (const raw of [url, this.base]) {
      if (raw && out.includes(raw)) out = out.split(raw).join(isUrl(raw) ? redactUrl(raw) : "<price endpoint>");
    }
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join("***");
    return out;
  }

  /** The start of an error response's body, unless the endpoint's URL holds a key it might echo. */
  private excerpt(text: string, url: string): string {
    return urlCredential(this.base) ? "(response withheld: the endpoint URL holds a key)" : this.scrub(text.slice(0, 200), url);
  }

  private async get(path: string, query: string | null): Promise<unknown> {
    const url = this.base + path + (query ? `?${query}` : "");
    let r: Response;
    let text: string;
    try {
      r = await this.fetchFn(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      text = await bodyText(r);
    } catch (e) {
      if (e instanceof HermesError) throw e;
      throw new HermesError(`price endpoint unreachable: ${this.scrub(reason(e), url)}`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new HermesError(`price endpoint refused the request (HTTP ${r.status}); check prices.apiKey`);
    }
    if (r.status === 404) {
      throw new HermesError(`price endpoint has no data for this request (HTTP 404): ${this.excerpt(text, url)}`);
    }
    if (r.status >= 400) throw new HermesError(`price endpoint returned HTTP ${r.status}: ${this.excerpt(text, url)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new HermesError(`price endpoint returned a body that is not JSON: ${this.excerpt(text, url)}`);
    }
  }

  /** The latest prints for `ids` (only those: a feed the endpoint does not serve is left out). */
  async latest(ids: readonly Hex[]): Promise<Print[]> {
    const body = await this.get("/v2/updates/price/latest", HermesClient.query(ids));
    return parseResponse(body as HermesUpdates, monotonic(), HermesClient.wanted(ids));
  }

  /** The prints Hermes serves for a historical timestamp (used for settlement prints). */
  async atOrAfter(publishTime: number, ids: readonly Hex[]): Promise<Print[]> {
    const body = await this.get(`/v2/updates/price/${publishTime}`, HermesClient.query(ids));
    return parseResponse(body as HermesUpdates, monotonic(), HermesClient.wanted(ids));
  }

  async priceFeeds(): Promise<PriceFeedMetadata[]> {
    const out = await this.get("/v2/price_feeds", null);
    return Array.isArray(out) ? (out as PriceFeedMetadata[]) : [];
  }

  /**
   * Server-sent prints for `ids`, one batch per event, until the connection drops (then it returns).
   * Aborting `signal`, breaking out of the loop or {@link close} ends it at once. A stream that sends
   * nothing for `opts.idleTimeout` seconds (no event, no keep-alive comment, no response yet) is
   * abandoned: the request is aborted and the stream throws a HermesError, as it does when a line
   * runs past {@link MAX_STREAM_LINE} or an event fails {@link parseResponse}'s checks.
   */
  async *stream(ids: readonly Hex[], signal?: AbortSignal, opts: StreamOptions = {}): AsyncGenerator<Print[], void, undefined> {
    const url = `${this.base}/v2/updates/price/stream?${HermesClient.query(ids)}`;
    const want = HermesClient.wanted(ids);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal?.reason);
    if (signal?.aborted) ctl.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.streams.add(ctl);

    // The idle watchdog runs only while waiting on the endpoint (for the response, then for each
    // chunk), so a consumer that takes its time between batches is never mistaken for silence.
    const idleSeconds = opts.idleTimeout === undefined ? STREAM_IDLE_TIMEOUT : opts.idleTimeout;
    const idleMs = idleSeconds !== null && idleSeconds > 0 && Number.isFinite(idleSeconds) ? idleSeconds * 1000 : 0;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onIdle = () => {
      timer = undefined;
      idle = true;
      ctl.abort(); // rejects the pending fetch or read, which is awaited below
    };
    const arm = () => {
      if (idleMs > 0) timer = setTimeout(onIdle, idleMs);
    };
    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const quiet = () => new HermesError(`price stream went quiet: no data for ${idleSeconds} s`);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      let r: Response;
      arm();
      try {
        r = await this.fetchFn(url, { headers: this.headers, signal: ctl.signal });
      } catch (e) {
        if (idle) throw quiet();
        if (ctl.signal.aborted) throw e;
        throw new HermesError(`price stream unreachable: ${this.scrub(reason(e), url)}`);
      } finally {
        disarm();
      }
      if (r.status >= 400) {
        r.body?.cancel().catch(noop);
        throw new HermesError(`price stream refused (HTTP ${r.status})`);
      }
      if (!r.body) throw new HermesError("price stream has no body");
      reader = r.body.getReader();
      const decoder = new TextDecoder();
      const lines = new LineBuffer();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        arm();
        try {
          chunk = await reader.read();
        } catch (e) {
          if (idle) throw quiet();
          if (ctl.signal.aborted) throw e;
          throw new HermesError(`price stream interrupted: ${this.scrub(reason(e), url)}`);
        } finally {
          disarm();
        }
        const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        for (const line of lines.push(text, chunk.done)) {
          if (!line.startsWith("data:")) continue;
          let body: unknown;
          try {
            body = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          yield parseResponse(body as HermesUpdates, monotonic(), want);
        }
        if (chunk.done) return;
      }
    } finally {
      disarm();
      signal?.removeEventListener("abort", onAbort);
      this.streams.delete(ctl);
      reader?.cancel().catch(noop);
      ctl.abort();
    }
  }
}
