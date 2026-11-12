/**
 * Client for Pyth Pro: the latest signed update for a set of feeds, a live stream of them, the
 * one-second channel's update for any past second, and the symbols registry.
 *
 * Every price it returns is read from the signed update itself (the bytes a call attaches and the
 * chain verifies, parsed by lazer.ts). The JSON an endpoint sends beside an update is never read, and
 * every update is kept exactly as the verifier reads it (lazer.ts `canonicalUpdate`), so bytes an
 * endpoint appends to one never reach a call's calldata.
 *
 * Feed ids are bytes32 `Hex` everywhere in the SDK, as the contracts hold them; this client alone
 * converts them to Pyth's numbers. An id that is not a raw Pyth Pro id is left out of a request. A
 * stream leaves out a feed Pyth does not serve or the token does not cover, and names it in a notice;
 * the request API refuses a whole request naming one (HTTP 403), which the price service answers by
 * asking again in parts (prices/service.ts).
 *
 * Runs in a browser as on a server: requests go through `fetch` and the stream through a WebSocket. A
 * browser cannot set a WebSocket's request headers, so there a token travels in the subprotocol list;
 * elsewhere it is sent as an Authorization header. Pyth's own endpoints serve only the holder of a
 * Pyth Pro API key, which must stay on a server: a client for them is refused when it is made without
 * the key, and in a web page with it. A page reaches Pyth only through a custom endpoint, such as a
 * proxy that adds the key.
 *
 * Credentials stay out of sight: the client holds the token, the headers and the configured URLs in
 * private fields, so printing or serializing it shows none of them; every message it produces has
 * them masked, and every URL in it redacted; a request carrying one never follows a redirect; and
 * none (the token, the headers, or a user name, password or query inside an endpoint's URL) goes over
 * plain http or ws to another machine unless `allowInsecure` says so.
 */

import type { Address, Hex } from "viem";
import { deadline } from "../chain/rpc.js";
import { InputError } from "../client/calls.js";
import { BAZAAR_EXPONENT } from "../constants.js";
import { PYTH_PRO, isPythProPriceEndpoint } from "../networks.js";
import { isUrl, redactUrl, redactUrls, urlCredential, urlSecrets } from "../urls.js";
import {
  CHANNEL_FIXED_RATE_1000,
  CHANNEL_IDS,
  type Channel,
  HAS_CONFIDENCE,
  HAS_EXPONENT,
  HAS_FEED_UPDATE_TIMESTAMP,
  HAS_PRICE,
  type LazerFeed,
  LazerError,
  type LazerPayload,
  MAX_FEEDS_PER_UPDATE,
  MAX_UPDATE_BYTES,
  MICROS_PER_SECOND,
  canonicalUpdate,
  feedIdHex,
  isRawFeedId,
  normalizeHex,
  proFeedId,
  readUpdate,
  recoverSigner,
} from "./lazer.js";

/**
 * One feed's price and the signed update that carries it. Every field but `received` and `signer` is
 * read from the update's signed payload; `signer` is recovered from its signature.
 */
export interface Print {
  /** The feed, as the bytes32 the contracts hold it in. */
  readonly feedId: Hex;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  /**
   * The second the price was generated in: the feed update timestamp in whole seconds, rounded down.
   * This is what the pair's freshness window judges, not the update's own timestamp: a quiet feed's
   * updates carry its last price forward under each new timestamp.
   */
  readonly publishTime: number;
  /** When the price was generated, in microseconds (the feed update timestamp). */
  readonly generatedUs: bigint;
  /** The carrying update's own timestamp, in microseconds. */
  readonly timestampUs: bigint;
  /** The channel number the update was produced on (lazer.ts CHANNEL_IDS). */
  readonly channel: number;
  /** The address that signed the update, when the source checks signers; null when it does not. */
  readonly signer: Address | null;
  /** The signed update to attach to a call. */
  readonly blob: Hex;
  /** When it arrived, in seconds on a monotonic clock (`performance.now() / 1000`). */
  readonly received: number;
}

/** A signed update as the client read it. */
export interface ProUpdate {
  /** The signed update: one element of a call's `priceUpdate`. */
  readonly blob: Hex;
  /** The address that signed it, when the client checks signers; null when it does not. */
  readonly signer: Address | null;
  /** The update's own timestamp, in microseconds. */
  readonly timestampUs: bigint;
  readonly channel: number;
  /** Every feed the update carries, by bytes32 feed id, whether or not it holds a usable price. */
  readonly feeds: ReadonlyMap<Hex, LazerFeed>;
  /** The live prints among the feeds asked for (see {@link isLivePrint}). */
  readonly prints: readonly Print[];
}

export class ProError extends Error {
  override readonly name: string = "ProError";
  constructor(
    message: string,
    /** The HTTP status the endpoint answered with, when the error is its refusal. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** The endpoint answered, but its update holds no price a live call could use for a feed asked for. */
export class NoLivePriceError extends ProError {
  override readonly name: string = "NoLivePriceError";
}

/** The signer check itself failed, so nothing is known about the update's signer. */
class UnconfirmedSigner extends ProError {}

/** Says whether updates signed by `signer` may be used. */
export type SignerCheck = (signer: Address) => boolean | Promise<boolean>;

/** @internal */
export function monotonic(): number {
  return performance.now() / 1000;
}

/** The properties every request asks for: the four BazaarOracle requires of a live price, which cover what settlement reads. */
export const PRO_PROPERTIES = ["price", "exponent", "confidence", "feedUpdateTimestamp"] as const;

/** The channel a client streams and reads the latest price on unless told otherwise. */
export const DEFAULT_CHANNEL: Channel = "fixed_rate@200ms";

/** The subprotocol that marks the next entry of a WebSocket's subprotocol list as the token. */
export const AUTH_SUBPROTOCOL = "pyth-lazer-auth";

/** What a web page that gives Pyth's own price endpoints a token is told. */
const PRO_KEY_IN_PAGE =
  "Anything a web page holds is public, so a page must not hold a Pyth Pro API key: keep the key on a server, and have the page read prices from that server and send its trades through a relayer that attaches them, or point restUrl and streamUrls at a proxy that adds the key.";

/** What a client for Pyth's own price endpoints is told when it is given no token. */
const PRO_KEY_REQUIRED =
  "Pyth's own price endpoints serve only the holder of a Pyth Pro API key. On a server, give the key as the token (an Authorization header among the headers does not count); never give it to a web page. Without a token, the request API (restUrl) and every stream endpoint (streamUrls) must be custom ones, such as a proxy that adds the key or a local mock: both default to Pyth's.";

const INT256_MAX = (1n << 255n) - 1n;
const INT256_MIN = -(1n << 255n);

/**
 * `value` scaled from `exponent` to BAZAAR precision as BazaarMathLib.convertExponent computes it on
 * chain, or null where that reverts. The scale, ten to the power of the exponents' distance, is
 * computed in uint256 (a distance above 77 overflows it) and then read as an int256, so ten to the 77th
 * reads as a negative number; a product outside int256 overflows; a quotient truncates toward zero.
 */
function oracleScaled(value: bigint, exponent: number): bigint | null {
  if (exponent === BAZAAR_EXPONENT) return value;
  const distance = Math.abs(exponent - BAZAAR_EXPONENT);
  if (distance > 77) return null;
  let scale = 10n ** BigInt(distance);
  if (scale > INT256_MAX) scale -= 1n << 256n;
  if (exponent < BAZAAR_EXPONENT) return value / scale;
  const out = value * scale;
  return out > INT256_MAX || out < INT256_MIN ? null : out;
}

/**
 * Why a feed entry holds no price a live call could use, or null when it holds one. BazaarOracle
 * refuses a live price unless all four live properties are in the payload; the price is above zero
 * (Pyth encodes "no price" as zero); the confidence and the generation time are not zero (Pyth writes
 * a property it has no value for as zero); and, once scaled to BAZAAR precision as the oracle scales
 * them, the price is still above zero and neither value overflows. The reason reads after "feed N: ".
 */
export function whyNotLive(f: LazerFeed): string | null {
  const missing: string[] = [];
  if (!(f.included & HAS_PRICE)) missing.push("price");
  if (!(f.included & HAS_EXPONENT)) missing.push("exponent");
  if (!(f.included & HAS_CONFIDENCE)) missing.push("confidence");
  if (!(f.included & HAS_FEED_UPDATE_TIMESTAMP)) missing.push("feedUpdateTimestamp");
  if (missing.length > 0) return `the update was requested without its ${missing.join(", ")}`;
  if (f.price === 0n) return "Pyth has no price for it at the update's time";
  if (f.price < 0n) return `its price ${f.price} is below zero, and the oracle refuses a price at or below zero`;
  if (f.confidence === 0n) return "Pyth reports no confidence for it, and the oracle refuses a live price without one";
  if (f.feedUpdateTimestamp === 0n) return "the update does not say when its price was generated";
  const scaled = oracleScaled(f.price, f.exponent);
  if (scaled === null || scaled <= 0n) return `at exponent ${f.exponent} its price is not above zero (or overflows) at the oracle's 18 decimals`;
  if (oracleScaled(f.confidence, f.exponent) === null) return `at exponent ${f.exponent} its confidence overflows at the oracle's 18 decimals`;
  return null;
}

/** Whether a feed entry holds a price a live call could use ({@link whyNotLive} says why not). */
export function isLivePrint(f: LazerFeed): boolean {
  return whyNotLive(f) === null;
}

/**
 * The prints a parsed update carries: one per feed that holds a live price ({@link isLivePrint}),
 * only for the feeds in `want` when given. A feed without a usable price yields no print.
 */
export function printsOf(u: LazerPayload, blob: Hex, signer: Address | null, received: number = monotonic(), want?: ReadonlySet<Hex> | null): Print[] {
  const out: Print[] = [];
  for (const f of u.feeds) {
    if (f.id === 0 || !isLivePrint(f)) continue;
    const feedId = feedIdHex(f.id);
    if (want && !want.has(feedId)) continue;
    out.push({
      feedId,
      price: f.price,
      conf: f.confidence,
      expo: f.exponent,
      publishTime: Number(f.feedUpdateTimestamp / MICROS_PER_SECOND),
      generatedUs: f.feedUpdateTimestamp,
      timestampUs: u.timestampUs,
      channel: u.channel,
      signer,
      blob,
      received,
    });
  }
  return out;
}

// ---- the stream's limits ----

/**
 * Seconds a price stream may bring no new update before it is abandoned and reconnected. Every
 * fixed-rate channel issues an update per interval whether or not a price changed, so silence this
 * long means the connections are dead, not quiet.
 */
export const STREAM_IDLE_TIMEOUT = 10;

/**
 * The longest message a price stream may send: this many characters of text, or bytes of a binary
 * frame (counted before it is decoded). An endpoint that sends a longer one is dropped.
 */
export const MAX_STREAM_MESSAGE = 1024 * 1024;

/** The largest response body a request may return, in bytes (16 MiB). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Seconds an update's own timestamp may lie ahead of the client's clock before the endpoint that
 * sent it is dropped. Per set of feeds the stream takes only updates stamped later than the last it
 * took, so one stamped far ahead would otherwise shut out every genuine update until that time.
 */
export const MAX_UPDATE_AHEAD = 60;

/**
 * How many messages in a row that are not price updates (not JSON, or of a type the client does not
 * know) drop the endpoint that sends them; it is reconnected with a growing delay.
 */
export const MAX_STRAY_MESSAGES = 64;

/** Seconds before a dropped stream endpoint is reconnected the first time; doubles per failure up to RECONNECT_MAX. */
const RECONNECT_BASE = 0.5;
const RECONNECT_MAX = 30;
/** How many distinct notices one stream passes to its `onNotice` before it drops the rest. */
export const MAX_STREAM_NOTICES = 64;
/** The longest piece of endpoint text (a response body, a close reason, an error) a message quotes. */
const MAX_QUOTED = 200;
/** The longest piece of text a ProSymbol field keeps from the registry. */
const MAX_SYMBOL_TEXT = 256;
/**
 * The shortest header value or URL part masked in messages: nothing shorter can hold a credential,
 * and masking a value of a character or two would garble every message.
 */
const MIN_SECRET = 4;

export interface StreamOptions {
  /**
   * Seconds without a new update from any endpoint (or without any endpoint connecting) after which
   * the stream throws a ProError; default {@link STREAM_IDLE_TIMEOUT}, null or 0 to wait forever.
   */
  idleTimeout?: number | null;
  /**
   * Told what an operator should see but that does not end the stream: a subscription the endpoint
   * refused, feeds it left out, an endpoint that dropped and is being reconnected. Each distinct
   * message is passed once per stream, up to {@link MAX_STREAM_NOTICES} of them.
   */
  onNotice?: (message: string) => void;
}

/** The parts of a WebSocket the client uses: any standard implementation fits. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/**
 * A WebSocket constructor: the global one of browsers and recent Node, or a package's (`ws`). Its
 * second argument is the subprotocol list or, where the runtime allows request headers, an options
 * object carrying `headers`.
 */
export type WebSocketConstructor = new (url: string, protocolsOrOptions?: any) => WebSocketLike;

export interface ProClientOptions {
  /**
   * The token every request and connection presents: the Pyth Pro API key. Required whenever the
   * request API or a stream endpoint is one of Pyth's own, as by default; omit it only for an endpoint
   * that needs none, such as a proxy that adds it or a local mock. Refused in a web page for Pyth's own
   * endpoints, since anything a page holds is public.
   */
  token?: string | null;
  /** WebSocket stream endpoints; the stream connects to all of them. Default Pyth's three. */
  streamUrls?: readonly string[];
  /** Base URL of the request API, without a query or a fragment. Default Pyth's. */
  restUrl?: string;
  /** Base URL of the symbols registry, without a query or a fragment. Default Pyth's. */
  symbolsUrl?: string;
  /** The channel streamed and read by {@link ProClient.latest}; default {@link DEFAULT_CHANNEL}. */
  channel?: Channel;
  /**
   * Extra request headers for the request API and the stream connections, for endpoints behind a
   * proxy. A stream connection carries them wherever the runtime lets a WebSocket set request
   * headers: under "header" auth, which a browser does not allow. Never sent to the symbols registry,
   * which is a different host and needs no credentials.
   */
  headers?: Readonly<Record<string, string>> | null;
  /** Seconds a request may take (not the stream, which has no limit); default 10. */
  timeout?: number;
  fetch?: typeof fetch;
  /** The WebSocket constructor to stream with; default the runtime's global one. */
  WebSocket?: WebSocketConstructor | null;
  /**
   * How a stream connection presents the token: "header" (an Authorization header, where the runtime
   * lets a WebSocket set one) or "subprotocol" (the subprotocol list, the only way in a browser).
   * Default "subprotocol" in a browser or a web worker, "header" elsewhere.
   */
  streamAuth?: "header" | "subprotocol";
  /**
   * When set, the signer of each update the client takes is recovered and passed to it, and an update
   * it does not accept yields no print: a response carrying one is refused, and a stream endpoint
   * sending one is dropped. Left unset, signatures are not checked here (the chain still verifies every
   * update a call carries).
   */
  isTrustedSigner?: SignerCheck | null;
  /**
   * Send credentials over plain http or ws to an endpoint that is not this machine: the token and the
   * headers, and a user name, password or query string inside an endpoint's URL (a proxy may read a key
   * from any of them). Refused by default, since anyone on the path could read them. Only an endpoint
   * whose host is exactly `localhost`, an address in 127.0.0.0/8 or [::1] counts as this machine: a
   * name under `.localhost` does not, since it is resolved through the system's resolver, which on some
   * systems asks DNS.
   */
  allowInsecure?: boolean;
  /** The clock a streamed update's own timestamp is judged against, in unix seconds; default the system clock. */
  clock?: () => number;
  /** Seconds a streamed update's own timestamp may lie ahead of `clock`; default {@link MAX_UPDATE_AHEAD}. */
  maxUpdateAhead?: number;
}

/** One entry of Pyth Pro's symbols registry. Fields the registry leaves out read as "" (or null). */
export interface ProSymbol {
  /** The Pyth Pro feed number. */
  readonly id: number;
  /** The same id as the bytes32 the contracts hold. */
  readonly feedId: Hex;
  /** "Crypto.BTC/USD", "Equity.US.AAPL/USD". */
  readonly symbol: string;
  readonly name: string;
  readonly description: string;
  /** "crypto", "fx", "equity", "metal", "rates", "nav", "commodity", "funding-rate". */
  readonly assetType: string;
  /** The fastest channel the feed is served on; it is also served on every slower one. */
  readonly minChannel: string;
  /** The feed's lifecycle state, as the registry words it. */
  readonly state: string;
  /** The feed's trading schedule, as the registry words it. */
  readonly schedule: string;
  readonly exponent: number | null;
  /** The feed's Pyth Core id, when it has one. */
  readonly hermesId: Hex | null;
}

/** Control characters, line breaks included, and the bidirectional controls that reorder what a terminal shows. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;

/**
 * `text` fit to print in one line: each run of control characters replaced by a space, and cut to
 * `max` characters. Text an endpoint or a registry sends passes through this before any message
 * quotes it.
 * @internal
 */
export function printable(text: string, max = MAX_QUOTED): string {
  const clean = text.replace(CONTROL, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const c = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const msg = e.message || e.name;
  return c && !msg.includes(c) ? `${msg} (${c})` : msg;
}

function noop(): void {}

const longestFirst = (a: string, b: string) => b.length - a.length;

/**
 * What a subscription's `ignoredInvalidFeedIds` left out, as text: its lists that name a feed, or null
 * when none does. An answer whose every list is empty left nothing out, so it is not worth a notice.
 */
function leftOut(ignored: unknown): string | null {
  if (ignored === undefined || ignored === null) return null;
  if (typeof ignored !== "object" || Array.isArray(ignored)) return shown(ignored);
  const named = Object.entries(ignored).filter(([, v]) => !(Array.isArray(v) && v.length === 0));
  return named.length === 0 ? null : shown(Object.fromEntries(named));
}

/** A value from the endpoint, short enough to quote in a message. */
function shown(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return printable(s, 40);
}

function tooBig(): ProError {
  return new ProError(`price endpoint's response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB: refusing it`);
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

// A header value fetch accepts: no control characters but tab, nothing past Latin-1. A token with a
// stray line break would otherwise fail inside fetch, whose error quotes the whole value.
const BAD_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// What a WebSocket subprotocol may be made of (an HTTP token). A browser throws on anything else,
// and its error quotes the value.
const SUBPROTOCOL = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Characters the hex of the largest possible update takes, with its 0x. */
const MAX_UPDATE_HEX = 2 + MAX_UPDATE_BYTES * 2;
/** Characters the base64 of the largest possible update takes. */
const MAX_UPDATE_BASE64 = Math.ceil(MAX_UPDATE_BYTES / 3) * 4;

/**
 * The signed update a response or a stream message carries, as lowercase hex, or null when it carries
 * none. Update data longer than the largest possible update is refused before it is decoded.
 */
function evmData(body: unknown): Hex | null {
  if (body === null || typeof body !== "object") return null;
  const evm = (body as { evm?: unknown }).evm;
  if (evm === undefined || evm === null) return null;
  const data = typeof evm === "string" ? evm : (evm as { data?: unknown }).data;
  const encoding = typeof evm === "string" ? undefined : (evm as { encoding?: unknown }).encoding;
  if (typeof data !== "string") throw new ProError(`price endpoint sent update data that is not a string (${shown(data)}): refusing it`);
  if (data.length > (encoding === "base64" ? MAX_UPDATE_BASE64 : MAX_UPDATE_HEX)) {
    throw new ProError(`price endpoint sent update data longer than the largest update there can be (${MAX_UPDATE_BYTES} bytes): refusing it`);
  }
  if (encoding === "base64") {
    let raw: string;
    try {
      raw = atob(data);
    } catch {
      throw new ProError("price endpoint sent update data that is not base64: refusing it");
    }
    let hex = "0x";
    for (let i = 0; i < raw.length; i++) hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
    return hex as Hex;
  }
  const hex = normalizeHex(data);
  if (hex === null) throw new ProError("price endpoint sent update data that is not hex: refusing it");
  return hex;
}

/** Refuses a token no request could carry, without quoting it. */
function checkToken(token: unknown): void {
  if (typeof token !== "string") throw new ProError("the price token (prices.token) must be the Pyth Pro API key, as a string");
  if (token.trim() === "") throw new ProError("the price token is empty: set it (prices.token)");
  if (BAD_HEADER_VALUE.test(token)) {
    throw new ProError("the price token (prices.token) holds a line break or another character a request header cannot carry: re-enter it");
  }
}

/** Whether this code runs in a web page, where everything it holds is public. */
function inPage(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}

function defaultStreamAuth(): "header" | "subprotocol" {
  const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown };
  return typeof g.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined" ? "subprotocol" : "header";
}

/**
 * Whether `host` (a URL's hostname, as the URL parser writes it) is this machine: exactly `localhost`,
 * an address in 127.0.0.0/8, or [::1]. A name under `.localhost` does not count: Node resolves names
 * through the system's resolver, which on musl, on glibc without nss-myhostname and on Windows asks DNS
 * for it, so a hostile resolver could send the credential to another host.
 */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Whether `url` carries a credential of its own: a user name or password, or a query string (a proxy may read a key from it). */
function urlBearsSecret(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.username !== "" || u.password !== "" || u.search !== "";
  } catch {
    return /[@?]/.test(url);
  }
}

/** The scheme (http or ws) `url` would send a credential over unencrypted to another machine, or null when it would not. */
function cleartext(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    const m = /^\s*(https?|wss?):/i.exec(url);
    return m && !m[1]!.toLowerCase().endsWith("s") ? m[1]!.toLowerCase() : null;
  }
  if (u.protocol !== "http:" && u.protocol !== "ws:") return null;
  return isLoopback(u.hostname) ? null : u.protocol.slice(0, -1);
}

/** A registry field as text fit to show: printable, and bounded. */
const text = (v: unknown): string => (typeof v === "string" ? printable(v, MAX_SYMBOL_TEXT) : "");

function toSymbol(item: unknown): ProSymbol | null {
  if (item === null || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const rawId = o.pyth_lazer_id;
  const id = typeof rawId === "number" ? rawId : typeof rawId === "string" && /^\d{1,10}$/.test(rawId) ? Number(rawId) : Number.NaN;
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) return null;
  const hermes = typeof o.hermes_id === "string" ? normalizeHex(o.hermes_id) : null;
  const expo = typeof o.exponent === "number" && Number.isInteger(o.exponent) ? o.exponent : null;
  return {
    id,
    feedId: feedIdHex(id),
    symbol: text(o.symbol),
    name: text(o.name),
    description: text(o.description),
    assetType: text(o.asset_type),
    minChannel: text(o.min_channel),
    state: text(o.state),
    schedule: text(o.schedule),
    exponent: expo,
    hermesId: hermes !== null && hermes.length === 66 ? hermes : null,
  };
}

interface Subscription {
  readonly subscriptionId: number;
  readonly priceFeedIds: number[];
}

export class ProClient {
  readonly channel: Channel;
  readonly streamAuth: "header" | "subprotocol";
  /** See {@link ProClientOptions.isTrustedSigner}. May be set after construction, before the first request. */
  isTrustedSigner: SignerCheck | null;

  // Everything that may hold a credential is a private field, which neither util.inspect nor
  // JSON.stringify shows.
  readonly #streamUrls: readonly string[];
  readonly #restUrl: string;
  readonly #symbolsUrl: string;
  readonly #apiToken: string | null;
  readonly #headers: Readonly<Record<string, string>>;
  /** everything masked in a message: the token, header values and the parts of the configured URLs that may hold a key, longest first so a secret containing another is masked whole */
  readonly #secrets: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #ws: WebSocketConstructor | null;
  readonly #clock: () => number;
  readonly #maxAheadUs: bigint;
  readonly #streams = new Set<AbortController>();

  /**
   * Throws a ProError naming the setting at fault, and never quoting a token, a header's value or a
   * URL, when a URL is not one (or a base URL holds a query or a fragment), the channel is unknown,
   * the token or a header holds a character a request cannot carry, or a credential would travel
   * unencrypted to another machine without `allowInsecure`. Throws an InputError on `prices.token` when
   * the request API or a stream endpoint is one of Pyth's own and no token is given.
   */
  constructor(opts: ProClientOptions = {}) {
    const url = (u: string, what: string, base: boolean) => {
      if (typeof u !== "string" || !isUrl(u)) throw new ProError(`${what} is not an http(s) or ws(s) URL`);
      const out = u.trim().replace(/\/+$/, "");
      // Request paths are appended to a base URL, so a query or a fragment in it would end up in the
      // middle of every request's URL.
      if (base && /[?#]/.test(out)) throw new ProError(`${what} holds a query or a fragment: give the base URL alone (a key goes in the token or the headers)`);
      return out;
    };
    this.#streamUrls = Object.freeze((opts.streamUrls ?? PYTH_PRO.streamUrls).map((u) => url(u, "a price stream URL", false)));
    this.#restUrl = url(opts.restUrl ?? PYTH_PRO.restUrl, "the price request URL", true);
    this.#symbolsUrl = url(opts.symbolsUrl ?? PYTH_PRO.symbolsUrl, "the symbols registry URL", true);
    const channel = opts.channel ?? DEFAULT_CHANNEL;
    if (typeof channel !== "string" || !Object.hasOwn(CHANNEL_IDS, channel)) throw new ProError(`unknown Pyth Pro channel ${shown(opts.channel)}`);
    this.channel = channel;
    this.streamAuth = opts.streamAuth ?? defaultStreamAuth();
    this.isTrustedSigner = opts.isTrustedSigner ?? null;
    const h: Record<string, string> = {};
    const fixed = new Set<string>();
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      if (!HEADER_NAME.test(name)) throw new ProError(`price endpoint header ${shown(name)} is not a valid HTTP header name`);
      if (typeof value !== "string" || BAD_HEADER_VALUE.test(value)) {
        throw new ProError(`price endpoint header ${name} has a value a request header cannot carry (a line break or control character?): re-enter it`);
      }
      h[name] = value;
      for (const part of [value.trim(), ...value.trim().split(/\s+/)]) if (part.length >= MIN_SECRET) fixed.add(part);
    }
    for (const u of [this.#restUrl, this.#symbolsUrl, ...this.#streamUrls]) for (const part of urlSecrets(u)) if (part.length >= MIN_SECRET) fixed.add(part);
    this.#headers = Object.freeze(h);
    this.#apiToken = opts.token ?? null;
    if (this.#apiToken !== null) {
      checkToken(this.#apiToken);
      fixed.add(this.#apiToken.trim());
    }
    this.#secrets = [...fixed].filter((s) => s.length > 0).sort(longestFirst);
    if (opts.allowInsecure !== true) {
      // The token and the headers go to the request API and the stream; a URL's own user name,
      // password or query goes wherever that URL is used, the symbols registry included. No message
      // quotes the URL.
      const carries = this.#apiToken !== null || Object.keys(h).length > 0;
      const endpoints: [string, string, boolean][] = [
        [this.#restUrl, "the price request URL", carries],
        [this.#symbolsUrl, "the symbols registry URL", false],
        ...this.#streamUrls.map((u): [string, string, boolean] => [u, "a price stream URL", carries]),
      ];
      for (const [u, what, sendsToken] of endpoints) {
        const scheme = cleartext(u);
        if (scheme === null) continue;
        if (sendsToken) {
          throw new ProError(
            `${what} uses ${scheme}://, which would send the price token and headers unencrypted to another machine: use https:// or wss://, or set allowInsecure for an endpoint on a network you trust`,
          );
        }
        if (urlBearsSecret(u)) {
          throw new ProError(
            `${what} holds a user name, a password or a query and uses ${scheme}://, which would send them unencrypted to another machine: use https:// or wss://, or set allowInsecure for an endpoint on a network you trust`,
          );
        }
      }
    }
    this.#timeoutMs = (opts.timeout ?? 10) * 1000;
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#ws = opts.WebSocket ?? null;
    this.#clock = opts.clock ?? (() => Date.now() / 1000);
    const ahead = opts.maxUpdateAhead ?? MAX_UPDATE_AHEAD;
    if (typeof ahead !== "number" || !Number.isFinite(ahead) || ahead < 0) throw new ProError("maxUpdateAhead is not a number of seconds");
    this.#maxAheadUs = BigInt(Math.round(ahead * 1_000_000));
    // Checked after every other setting, so a malformed or insecure endpoint is reported as such first.
    const pyths = [this.#restUrl, ...this.#streamUrls].some(isPythProPriceEndpoint);
    if (this.#apiToken === null && pyths) throw new InputError("prices.token", PRO_KEY_REQUIRED);
    if (this.#apiToken !== null && pyths && inPage()) throw new InputError("prices.token", PRO_KEY_IN_PAGE);
  }

  /** The WebSocket stream endpoints, as configured. They may hold a key: print them through `redactUrl`. */
  get streamUrls(): readonly string[] {
    return this.#streamUrls;
  }

  /** The request API's base URL, as configured. It may hold a key: print {@link displayUrl}. */
  get restUrl(): string {
    return this.#restUrl;
  }

  /** The symbols registry's base URL, as configured. */
  get symbolsUrl(): string {
    return this.#symbolsUrl;
  }

  /** The request API's base URL as it may be printed: with any key in it masked. */
  get displayUrl(): string {
    return redactUrl(this.#restUrl);
  }

  /** Ends any open streams. */
  async close(): Promise<void> {
    for (const c of this.#streams) c.abort();
    this.#streams.clear();
  }

  // ---- tokens and messages ----

  /** The token every request and connection presents, or null when the client has none. */
  #token(): string | null {
    return this.#apiToken;
  }

  /**
   * A message with the given URLs and the configured ones redacted, every token, header value and
   * key-bearing URL part masked wherever it appears, and any other URL in it redacted.
   */
  #scrub(msg: string, ...urls: string[]): string {
    let out = msg;
    for (const raw of [...urls, this.#restUrl, this.#symbolsUrl, ...this.#streamUrls]) {
      if (raw && out.includes(raw)) out = out.split(raw).join(isUrl(raw) ? redactUrl(raw) : "<price endpoint>");
    }
    for (const s of this.#secrets) if (out.includes(s)) out = out.split(s).join("***");
    return redactUrls(out);
  }

  /**
   * Text from outside the client (an endpoint's answer, an error a transport raised), fit to quote: cut
   * well past the quoted length first, so a secret near the start is still whole when it is masked,
   * then scrubbed, made printable and cut to the quoted length.
   */
  #quote(text: string, ...urls: string[]): string {
    return printable(this.#scrub(text.slice(0, MAX_QUOTED + 4096), ...urls));
  }

  /** The start of an error response's body, unless the endpoint's URL holds a key it might echo. */
  #excerpt(body: string, url: string): string {
    return urlCredential(url) ? "(response withheld: the endpoint URL holds a key)" : this.#quote(body, url);
  }

  // ---- requests ----

  async #request(url: string, body: string | null, auth: boolean): Promise<unknown> {
    let r: Response;
    let answer: string;
    try {
      const headers: Record<string, string> = {};
      if (auth) {
        Object.assign(headers, this.#headers);
        const token = await this.#token();
        if (token !== null) headers.Authorization = `Bearer ${token}`;
      }
      // A request carrying a credential never follows a redirect, which would hand the headers to
      // whatever host the answer names.
      const redirect: RequestRedirect = Object.keys(headers).length > 0 ? "error" : "follow";
      if (body !== null) headers["Content-Type"] = "application/json";
      const limit = deadline(this.#timeoutMs);
      try {
        r = await limit.race(this.#fetch(url, { method: body === null ? "GET" : "POST", headers, body: body ?? undefined, redirect, signal: limit.signal }));
        answer = await limit.race(bodyText(r));
      } finally {
        limit.clear();
      }
    } catch (e) {
      if (e instanceof ProError) throw e;
      throw new ProError(`price endpoint unreachable: ${this.#quote(reason(e), url)}`);
    }
    if (r.status === 401 || r.status === 403) {
      // Pyth's answer names the cause (an invalid key, a feed it does not know, a feed the token does
      // not cover), so it is quoted, scrubbed like any other answer.
      const said = answer.trim() === "" ? "" : `. The endpoint said: ${this.#excerpt(answer, url)}`;
      throw new ProError(`price endpoint refused the request (HTTP ${r.status}); check the token (prices.token) and that it covers these feeds and this channel${said}`, r.status);
    }
    if (r.status === 404) throw new ProError(`price endpoint has no data for this request (HTTP 404): ${this.#excerpt(answer, url)}`, 404);
    if (r.status >= 400) throw new ProError(`price endpoint returned HTTP ${r.status}: ${this.#excerpt(answer, url)}`, r.status);
    try {
      return JSON.parse(answer);
    } catch {
      throw new ProError(`price endpoint returned a body that is not JSON: ${this.#excerpt(answer, url)}`);
    }
  }

  /** The raw feeds among `ids`, as Pyth's numbers (ascending, each once) and as the set of bytes32 ids. */
  private static feeds(ids: readonly Hex[]): { numbers: number[]; want: Set<Hex> } {
    const want = new Set<Hex>();
    for (const f of ids) {
      const id = typeof f === "string" ? (f.toLowerCase() as Hex) : f;
      if (isRawFeedId(id)) want.add(id);
    }
    const numbers = [...want].map(proFeedId).sort((a, b) => a - b);
    return { numbers, want };
  }

  /** Refuses a request for more feeds than one update can carry. */
  private static fitsOneUpdate(numbers: readonly number[]): void {
    if (numbers.length > MAX_FEEDS_PER_UPDATE) {
      throw new ProError(`${numbers.length} feeds were asked for in one request, but one update carries at most ${MAX_FEEDS_PER_UPDATE}: ask for them in parts`);
    }
  }

  /**
   * A REST request's body: the feeds, the four properties BazaarOracle reads, the EVM format in hex,
   * the channel, and no parsed copy of the update (only the signed update is read). Pyth's REST API
   * refuses the whole request (HTTP 403) when it names a feed Pyth does not know or the token does not
   * cover, and leaves a feed that is not active out of the update.
   */
  private static query(numbers: readonly number[], channel: Channel): Record<string, unknown> {
    return {
      priceFeedIds: numbers,
      properties: PRO_PROPERTIES,
      formats: ["evm"],
      channel,
      jsonBinaryEncoding: "hex",
      parsed: false,
    };
  }

  /**
   * A subscription's parameters: a REST request's, delivered as JSON text, with `ignoreInvalidFeeds`
   * so a feed Pyth does not serve, or the token does not cover, does not fail the others: Pyth
   * subscribes the rest and names the feeds it left out (a notice).
   */
  private static subscription(numbers: readonly number[], channel: Channel): Record<string, unknown> {
    return { ...ProClient.query(numbers, channel), deliveryFormat: "json", ignoreInvalidFeeds: true };
  }

  /** The signer of `blob` when signers are checked (throwing a ProError for one that is not trusted), else null. */
  async #signerOf(blob: Hex): Promise<Address | null> {
    const check = this.isTrustedSigner;
    if (!check) return null;
    const signer = await recoverSigner(blob);
    let ok: boolean;
    try {
      ok = await check(signer);
    } catch (e) {
      // The check reads a chain through a transport whose errors may quote its URL, key and all: only a
      // scrubbed, short summary is kept, since this reaches notices, logs and errors.
      throw new UnconfirmedSigner(`could not confirm that Pyth trusts the signer of a price update: ${this.#quote(reason(e))}`);
    }
    if (ok !== true) throw new ProError(`a price update is signed by ${signer}, which is not a signer Pyth's verifier trusts: refusing it`);
    return signer;
  }

  /** Reads a signed update: cut to what the verifier reads, its payload, its signer when signers are checked, its prints for `want`. */
  async #read(raw: Hex, received: number, want: ReadonlySet<Hex> | null): Promise<ProUpdate> {
    let blob: Hex;
    let parsed: LazerPayload;
    let signer: Address | null;
    try {
      blob = canonicalUpdate(raw);
      parsed = readUpdate(blob);
      signer = await this.#signerOf(blob);
    } catch (e) {
      if (e instanceof LazerError) throw new ProError(`price endpoint sent an update the SDK cannot read (${e.message}): refusing it`);
      throw e;
    }
    const feeds = new Map<Hex, LazerFeed>();
    for (const f of parsed.feeds) if (f.id !== 0) feeds.set(feedIdHex(f.id), f);
    return { blob, signer, timestampUs: parsed.timestampUs, channel: parsed.channel, feeds, prints: printsOf(parsed, blob, signer, received, want) };
  }

  /**
   * The latest update carrying `ids` together, on the client's channel, or null when none of them is
   * a raw feed id or the endpoint sends no update. One request, one update: a composite's two legs
   * asked for together arrive in one. Throws a ProError for more feeds than one update carries.
   */
  async latestUpdate(ids: readonly Hex[]): Promise<ProUpdate | null> {
    const { numbers, want } = ProClient.feeds(ids);
    if (numbers.length === 0) return null;
    ProClient.fitsOneUpdate(numbers);
    const url = `${this.#restUrl}/v1/latest_price`;
    const blob = evmData(await this.#request(url, JSON.stringify(ProClient.query(numbers, this.channel)), true));
    return blob === null ? null : this.#read(blob, monotonic(), want);
  }

  /** The latest prints for `ids` (only those: a feed the endpoint has no live price for is left out), all from one update. */
  async latest(ids: readonly Hex[]): Promise<Print[]> {
    const u = await this.latestUpdate(ids);
    return u === null ? [] : [...u.prints];
  }

  /**
   * The one-second channel's update stamped exactly `second`, carrying `ids` together: the update a
   * settlement proof is made of. Null when the endpoint has none for that second (HTTP 404, or an
   * answer without update data) or none of `ids` is a raw feed id. Throws a ProError when the
   * endpoint answers with an update from another channel or another instant.
   */
  async atTick(ids: readonly Hex[], second: number): Promise<ProUpdate | null> {
    if (!Number.isSafeInteger(second) || second <= 0 || !Number.isSafeInteger(second * 1_000_000)) {
      throw new ProError(`${shown(second)} is not a unix time in whole seconds`);
    }
    const { numbers, want } = ProClient.feeds(ids);
    if (numbers.length === 0) return null;
    ProClient.fitsOneUpdate(numbers);
    const url = `${this.#restUrl}/v1/price`;
    let body: unknown;
    try {
      body = await this.#request(url, JSON.stringify({ ...ProClient.query(numbers, "fixed_rate@1000ms"), timestamp: second * 1_000_000 }), true);
    } catch (e) {
      if (e instanceof ProError && e.status === 404) return null;
      throw e;
    }
    const blob = evmData(body);
    if (blob === null) return null;
    const u = await this.#read(blob, monotonic(), want);
    if (u.channel !== CHANNEL_FIXED_RATE_1000 || u.timestampUs !== BigInt(second) * MICROS_PER_SECOND) {
      throw new ProError(`price endpoint answered the one-second tick at ${second} with another update (channel ${u.channel}, stamped ${u.timestampUs} µs): refusing it`);
    }
    return u;
  }

  /**
   * Pyth Pro's symbols registry: every feed, or those matching `query` (a text filter on symbol
   * names) and `assetType`. Needs no token. Entries without a valid feed number are left out, and
   * every text field is made printable and bounded. Throws a ProError when the registry cannot be
   * read or answers with something that is not a list.
   */
  async symbols(filter: { query?: string; assetType?: string } = {}): Promise<ProSymbol[]> {
    const q = new URLSearchParams();
    if (filter.query) q.set("query", filter.query);
    if (filter.assetType) q.set("asset_type", filter.assetType);
    const qs = q.toString();
    const body = await this.#request(`${this.#symbolsUrl}/v1/symbols${qs ? `?${qs}` : ""}`, null, false);
    if (!Array.isArray(body)) throw new ProError("the symbols registry answered with something that is not a list of feeds");
    const out: ProSymbol[] = [];
    for (const item of body) {
      const s = toSymbol(item);
      if (s) out.push(s);
    }
    return out;
  }

  // ---- the stream ----

  /** One subscription per distinct set of raw feeds, and every feed asked for. */
  private static plan(feeds: readonly Hex[] | readonly (readonly Hex[])[]): { subscriptions: Subscription[]; want: Set<Hex> } {
    const sets = feeds.length > 0 && Array.isArray(feeds[0]) ? (feeds as readonly (readonly Hex[])[]) : [feeds as readonly Hex[]];
    const subscriptions: Subscription[] = [];
    const want = new Set<Hex>();
    const seen = new Set<string>();
    for (const set of sets) {
      const f = ProClient.feeds(set);
      const key = f.numbers.join(",");
      if (f.numbers.length === 0 || seen.has(key)) continue;
      ProClient.fitsOneUpdate(f.numbers);
      seen.add(key);
      for (const id of f.want) want.add(id);
      subscriptions.push({ subscriptionId: subscriptions.length + 1, priceFeedIds: f.numbers });
    }
    return { subscriptions, want };
  }

  /**
   * Live prints for `feeds`, one batch per new update, from every stream endpoint at once.
   *
   * `feeds` is one set of feeds or a list of sets. Each distinct set is its own subscription, so the
   * signed update its prints share carries exactly that set: both legs of a composite asked for
   * together arrive in one update, and a market's update holds no other market's feeds. The same
   * subscriptions run on every endpoint, and an update is yielded once: per set of feeds a payload
   * carries, only an update stamped later than the last one taken is taken, whichever endpoint brings
   * it first. A batch holds the prints of every update taken since the last batch, the newest per set,
   * so a slow consumer skips to the latest prices.
   *
   * With a signer check, each set keeps only its newest update waiting for the check, and the sets
   * take turns: however slow the checks, every set's newest update is checked in its turn, and an
   * update superseded while it waits is never checked. Nothing counts as taken before its check passes,
   * so an update that fails it holds back neither another endpoint's copy of the same instant nor any
   * later one.
   *
   * An endpoint that drops, sends an update it cannot read, one stamped more than `maxUpdateAhead`
   * seconds ahead of the client's clock, one from an untrusted signer (when signers are checked), or
   * {@link MAX_STRAY_MESSAGES} messages in a row that are not price updates, is closed and reconnected
   * with a growing delay while the others keep delivering. The stream returns when every endpoint has
   * dropped after at least one had connected, and when `signal` aborts, the consumer breaks out of the
   * loop or {@link close} is called. It throws a ProError when no endpoint can be reached, and when no
   * new update arrives for `opts.idleTimeout` seconds while the consumer waits.
   */
  async *stream(feeds: readonly Hex[] | readonly (readonly Hex[])[], signal?: AbortSignal, opts: StreamOptions = {}): AsyncGenerator<Print[], void, undefined> {
    const { subscriptions, want } = ProClient.plan(feeds);
    if (subscriptions.length === 0) return;
    const ctor = this.#ws ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ?? null;
    if (typeof ctor !== "function") {
      throw new ProError("this runtime has no WebSocket (Node before 22 has none): pass a WebSocket constructor, for example the `ws` package's, as the client's WebSocket option");
    }
    const idleSeconds = opts.idleTimeout === undefined ? STREAM_IDLE_TIMEOUT : opts.idleTimeout;
    const idleMs = idleSeconds !== null && idleSeconds > 0 && Number.isFinite(idleSeconds) ? idleSeconds * 1000 : 0;

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.#streams.add(ctl);

    interface Endpoint {
      readonly url: string;
      socket: WebSocketLike | null;
      state: "connecting" | "open" | "waiting";
      /** failures since it last delivered an update that was taken */
      failures: number;
      /** whether it has failed since the stream began */
      failed: boolean;
      timer: ReturnType<typeof setTimeout> | undefined;
      /** messages that were not price updates since its last price update */
      stray: number;
    }
    /** An update an endpoint sent, read, waiting for its signer check. */
    interface Candidate {
      readonly ep: Endpoint;
      readonly socket: WebSocketLike;
      readonly blob: Hex;
      readonly parsed: LazerPayload;
    }
    const endpoints: Endpoint[] = this.#streamUrls.map((url) => ({ url, socket: null, state: "connecting", failures: 0, failed: false, timer: undefined, stray: 0 }));
    // Per set of feeds a payload carries (its key): the timestamp of the newest update taken, the
    // newest update waiting for its check, and the prints taken that the consumer has not had yet.
    const taken = new Map<string, bigint>();
    const waiting = new Map<string, Candidate>();
    // The keys with an update waiting, each once, in the order their checks run. A key whose update
    // arrives after its turn goes to the back, so the sets take turns.
    const turns: string[] = [];
    let checking = false;
    const pending = new Map<string, Print[]>();
    const noticed = new Set<string>();
    let everOpen = false;
    let ended = false;
    let failure: ProError | null = null;
    let lastRefusal = "";
    let wake: (() => void) | null = null;
    const over = () => ended || failure !== null || ctl.signal.aborted;

    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const notice = (message: string) => {
      if (noticed.has(message) || noticed.size >= MAX_STREAM_NOTICES) return;
      noticed.add(message);
      try {
        opts.onNotice?.(message);
      } catch {
        // a listener's failure must not end the stream
      }
    };
    const fail = (e: ProError) => {
      failure ??= e;
      notify();
    };
    const sever = (ep: Endpoint) => {
      const s = ep.socket;
      ep.socket = null;
      if (s) {
        try {
          s.close();
        } catch {
          // already closed
        }
      }
    };
    /** The endpoint is gone (dropped, refused, or dropped by us): end the stream, fail it, or reconnect. */
    const down = (ep: Endpoint, socket: WebSocketLike | null, why: string) => {
      if (ep.socket !== socket || over()) return; // an event of a socket already replaced
      sever(ep);
      ep.state = "waiting";
      ep.failed = true;
      ep.failures += 1;
      const said = printable(this.#scrub(why, ep.url), 2 * MAX_QUOTED);
      lastRefusal = said;
      if (!everOpen) {
        if (endpoints.every((e) => e.failed)) return fail(new ProError(`price stream unreachable: ${said} (check the stream URLs and the token)`));
      } else if (!endpoints.some((e) => e.state !== "waiting")) {
        ended = true;
        return notify();
      }
      notice(`price stream endpoint ${redactUrl(ep.url)} dropped (${said}): reconnecting`);
      const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** Math.min(ep.failures - 1, 10));
      ep.timer = setTimeout(() => {
        ep.timer = undefined;
        void connect(ep);
      }, delay * 1000);
    };
    /** Check the waiting updates' signers, the sets in turn, and take each update whose check passes. */
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        while (turns.length > 0 && !over()) {
          const key = turns.shift()!;
          const c = waiting.get(key)!;
          waiting.delete(key);
          const last = taken.get(key);
          if (last !== undefined && c.parsed.timestampUs <= last) continue; // another endpoint's copy was taken meanwhile
          let signer: Address | null;
          try {
            signer = await this.#signerOf(c.blob);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            if (e instanceof UnconfirmedSigner) {
              // The check failing says nothing against the endpoint: only its update is left unused.
              lastRefusal = why;
              notice(why);
            } else down(c.ep, c.socket, why);
            continue;
          }
          if (over()) return;
          taken.set(key, c.parsed.timestampUs);
          if (c.ep.socket === c.socket) c.ep.failures = 0;
          const prints = printsOf(c.parsed, c.blob, signer, monotonic(), want);
          if (prints.length > 0) pending.set(key, prints);
          // An update without a live print still shows the stream is alive.
          notify();
        }
      } finally {
        checking = false;
      }
    };
    /** A message that is not a price update: one too many in a row drops the endpoint. */
    const stray = (ep: Endpoint, socket: WebSocketLike) => {
      ep.stray += 1;
      if (ep.stray >= MAX_STRAY_MESSAGES) down(ep, socket, `it sent ${MAX_STRAY_MESSAGES} messages in a row that are not price updates`);
    };
    const onMessage = (ep: Endpoint, socket: WebSocketLike, data: unknown) => {
      if (ep.socket !== socket) return;
      let raw: string;
      if (typeof data === "string") raw = data;
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const frame = data as ArrayBuffer | ArrayBufferView;
        if (frame.byteLength > MAX_STREAM_MESSAGE) return down(ep, socket, `it sent a message longer than ${MAX_STREAM_MESSAGE} bytes`);
        raw = new TextDecoder().decode(frame);
      } else return stray(ep, socket);
      if (raw.length > MAX_STREAM_MESSAGE) return down(ep, socket, `it sent a message longer than ${MAX_STREAM_MESSAGE} characters`);
      let msg: { type?: unknown; error?: unknown; subscriptionId?: unknown; [k: string]: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return stray(ep, socket);
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return stray(ep, socket);
      if (msg.type === "streamUpdated") {
        let blob: Hex;
        let parsed: LazerPayload;
        try {
          const got = evmData(msg);
          if (got === null) return down(ep, socket, "it sent an update without signed EVM data");
          blob = canonicalUpdate(got);
          parsed = readUpdate(blob);
        } catch (e) {
          return down(ep, socket, `it sent an update the SDK cannot read (${e instanceof Error ? e.message : String(e)})`);
        }
        ep.stray = 0;
        const ts = parsed.timestampUs;
        const ahead = ts - BigInt(Math.floor(this.#clock() * 1_000_000));
        if (ahead > this.#maxAheadUs) {
          return down(
            ep,
            socket,
            `it sent an update stamped ${ahead / MICROS_PER_SECOND} s ahead of this machine's clock, more than the ${Number(this.#maxAheadUs) / 1_000_000} s allowed: check the endpoint, or this machine's clock`,
          );
        }
        const key = `${parsed.channel}:${parsed.feeds.map((f) => f.id).sort((a, b) => a - b).join(",")}`;
        const last = taken.get(key);
        if (last !== undefined && ts <= last) return; // taken already, from whichever endpoint brought it first, or older
        const held = waiting.get(key);
        if (held !== undefined && ts <= held.parsed.timestampUs) return; // this instant (or a later one) waits for its check
        if (held === undefined) turns.push(key);
        waiting.set(key, { ep, socket, blob, parsed }); // replaces an older one, whose check never runs
        void check().catch((e) => fail(e instanceof ProError ? e : new ProError(`price stream failed: ${this.#quote(reason(e))}`)));
        return;
      }
      if (msg.type === "subscriptionError" || msg.type === "error") {
        const about = typeof msg.subscriptionId === "number" ? subscriptions.find((s) => s.subscriptionId === msg.subscriptionId) : undefined;
        const said = this.#quote(typeof msg.error === "string" ? msg.error : shown(msg.error), ep.url);
        lastRefusal = said;
        notice(
          about
            ? `price stream refused the subscription for feed(s) ${about.priceFeedIds.join(", ")} on ${this.channel}: ${said}`
            : `price stream reported an error: ${said}`,
        );
        return;
      }
      if (msg.type === "subscribedWithInvalidFeedIdsIgnored") {
        const left = leftOut(msg.ignoredInvalidFeedIds);
        if (left !== null) notice(`price stream left out feeds it does not serve on ${this.channel}: ${this.#quote(left)}`);
        return;
      }
      if (msg.type === "subscribed") return;
      stray(ep, socket);
    };
    const connect = async (ep: Endpoint): Promise<void> => {
      if (over()) return;
      ep.state = "connecting";
      ep.stray = 0;
      let socket: WebSocketLike;
      try {
        const token = await this.#token();
        if (over()) return;
        if (this.streamAuth === "header") {
          const headers: Record<string, string> = { ...this.#headers };
          if (token !== null) headers.Authorization = `Bearer ${token}`;
          socket = Object.keys(headers).length > 0 ? new ctor(ep.url, { headers }) : new ctor(ep.url);
        } else if (token === null) socket = new ctor(ep.url);
        else {
          if (!SUBPROTOCOL.test(token)) {
            throw new ProError('the price token holds a character a WebSocket subprotocol cannot carry: use streamAuth "header" where the runtime lets a WebSocket set request headers');
          }
          socket = new ctor(ep.url, [AUTH_SUBPROTOCOL, token]);
        }
      } catch (e) {
        return down(ep, null, reason(e));
      }
      ep.socket = socket;
      socket.addEventListener("open", () => {
        if (ep.socket !== socket) return;
        ep.state = "open";
        everOpen = true;
        try {
          for (const s of subscriptions) socket.send(JSON.stringify({ type: "subscribe", subscriptionId: s.subscriptionId, ...ProClient.subscription(s.priceFeedIds, this.channel) }));
        } catch (e) {
          down(ep, socket, reason(e));
        }
      });
      socket.addEventListener("message", (ev: { data?: unknown }) => onMessage(ep, socket, ev?.data));
      socket.addEventListener("error", (ev: { message?: unknown; error?: unknown }) => {
        const m = typeof ev?.message === "string" && ev.message ? ev.message : ev?.error instanceof Error ? ev.error.message : "";
        down(ep, socket, m ? printable(m, MAX_QUOTED) : "connection error");
      });
      socket.addEventListener("close", (ev: { code?: unknown; reason?: unknown }) => {
        const why = typeof ev?.reason === "string" && ev.reason ? `: ${printable(ev.reason, MAX_QUOTED)}` : "";
        down(ep, socket, `connection closed${typeof ev?.code === "number" ? ` (code ${ev.code})` : ""}${why}`);
      });
    };

    ctl.signal.addEventListener(
      "abort",
      () => {
        ended = true;
        notify();
      },
      { once: true },
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (ctl.signal.aborted) return;
      for (const ep of endpoints) void connect(ep);
      for (;;) {
        if (pending.size > 0) {
          const batch: Print[] = [];
          for (const prints of pending.values()) for (const p of prints) batch.push(p);
          pending.clear();
          yield batch;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        // The watchdog runs only while the consumer waits, so one that takes its time between
        // batches is never mistaken for silence. Any update taken wakes this, with or without a
        // live print in it, and the next wait starts the count again.
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (idleMs > 0) {
            idleTimer = setTimeout(() => {
              fail(new ProError(`price stream went quiet: no new update for ${idleSeconds} s${lastRefusal ? ` (last endpoint message: ${lastRefusal})` : ""}`));
            }, idleMs);
          }
        });
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    } finally {
      ended = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      for (const ep of endpoints) {
        if (ep.timer !== undefined) clearTimeout(ep.timer);
        sever(ep);
      }
      signal?.removeEventListener("abort", onAbort);
      this.#streams.delete(ctl);
      ctl.abort();
    }
  }
}
