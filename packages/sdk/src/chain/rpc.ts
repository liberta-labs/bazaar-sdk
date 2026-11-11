/**
 * JSON-RPC transports.
 *
 * Everything in the SDK talks to the chain through a {@link Transport}: anything with an EIP-1193
 * `request({ method, params })`. That is a browser wallet's provider (`window.ethereum`), a viem
 * client, or this module's {@link JsonRpc}, a small HTTP client that rate limits, retries transient
 * failures (never a send: see {@link NEVER_RETRIED}), caps response sizes, keeps revert data, and never
 * puts its URL (which often holds a provider's key) or its headers' values into an error message.
 */

import type { Hex } from "viem";
import { redactUrl } from "../urls.js";

export interface RequestArgs {
  readonly method: string;
  readonly params?: readonly unknown[];
}

/** EIP-1193's request method: what a browser wallet, a viem client and JsonRpc all provide. */
export interface Transport {
  request(args: RequestArgs): Promise<unknown>;
}

export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
    readonly data?: unknown,
  ) {
    super(`${rpcMessage} (code ${code})`);
  }

  /** The revert payload of a failed eth_call or eth_estimateGas, in whichever shape the node uses. */
  get revertData(): Hex | null {
    return extractRevertData(this.data, this.rpcMessage);
  }
}

/** A non-2xx HTTP response. The message carries the URL redacted. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A response body over the reader's byte limit. Not retried: the same request gets the same answer. */
export class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";
  constructor(
    readonly limit: number,
    message: string,
  ) {
    super(message);
  }
}

const size = (n: number) => (n % 1_048_576 === 0 ? `${n / 1_048_576} MiB` : `${n} bytes`);

/**
 * A response's body as text, holding at most `maxBytes` of it: counted as the body arrives, after any
 * content-encoding is undone (so a compressed bomb is refused too), and refused at once when the
 * declared length is already over. `what` names the source in the error and must be fit to print (a
 * redacted URL). Throws {@link ResponseTooLargeError}.
 */
export async function readTextCapped(r: Response, maxBytes: number, what: string): Promise<string> {
  const tooLarge = () => new ResponseTooLargeError(maxBytes, `${what} answered with more than ${size(maxBytes)}; refused`);
  const body = r.body;
  if (Number(r.headers?.get("content-length") ?? Number.NaN) > maxBytes) {
    await body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!body) {
    const text = typeof r.text === "function" ? await r.text() : "";
    if (text.length > maxBytes) throw tooLarge();
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function extractRevertData(data: unknown, message: string): Hex | null {
  let d: unknown = data;
  for (let i = 0; i < 4 && d && typeof d === "object"; i++) {
    const o = d as Record<string, unknown>;
    d = o.data ?? o.result ?? o.originalError;
  }
  if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d.toLowerCase() as Hex;
  if (message.toLowerCase().includes("execution reverted")) return "0x";
  return null;
}

/**
 * Normalize whatever a transport threw into an RpcError when it carries a JSON-RPC error. EIP-1193
 * providers and viem nest the node's error at different depths; this walks `cause` to find it.
 */
export function toRpcError(e: unknown): RpcError | null {
  if (e instanceof RpcError) return e;
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    // A DOMException's numeric `code` is a legacy DOM code (a fetch timeout's is 23), not the node's.
    if (typeof DOMException !== "undefined" && cur instanceof DOMException) return null;
    const o = cur as { code?: unknown; message?: unknown; data?: unknown; details?: unknown; cause?: unknown };
    if (typeof o.code === "number" && (o.data !== undefined || typeof o.message === "string")) {
      const msg = typeof o.details === "string" ? o.details : typeof o.message === "string" ? o.message : "";
      // viem reports the revert under `data` on the innermost error; providers under data.data.
      return new RpcError(o.code, msg, o.data);
    }
    cur = o.cause;
  }
  return null;
}

class RateLimiter {
  private nextAt = 0;
  private readonly interval: number;
  constructor(perSecond: number) {
    this.interval = 1000 / perSecond;
  }
  /** Reserves the next slot synchronously, so concurrent callers queue in call order. */
  async wait(): Promise<void> {
    const now = performance.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.interval;
    if (at > now) await sleep(at - now);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface JsonRpcOptions {
  /** Requests per second this client allows itself. */
  perSecond?: number;
  timeoutMs?: number;
  /**
   * Retries after a failed request (HTTP errors, connection errors, timeouts, unreadable answers),
   * with doubling delays from 500 ms; 3 by default. Never for the methods in {@link NEVER_RETRIED}.
   */
  retries?: number;
  /** Sent with every request. A value HTTP cannot carry (a line break, NUL, ...) is refused at once. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** The most bytes one response may hold; 64 MiB by default. A larger one is refused, not retried. */
  maxResponseBytes?: number;
}

/** Per-request options of {@link JsonRpc.request}. */
export interface RequestOptions {
  /** Retries for this request instead of the client's; ignored (0) for the methods in {@link NEVER_RETRIED}. */
  retries?: number;
}

/**
 * Methods JsonRpc sends at most once, whatever `retries` says. A lost answer to one of them does not
 * mean it was not done: the node may hold the transaction, and sending it again (or, worse, signing it
 * again) could do it twice. {@link Chain.sendRaw} settles such an outcome by the transaction's hash.
 */
export const NEVER_RETRIED: ReadonlySet<string> = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sendRawTransactionConditional",
  "eth_sendRawTransactionSync",
  "eth_sendPrivateTransaction",
  "eth_sendBundle",
]);

const MAX_RESPONSE_BYTES = 64 * 1_048_576;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What an HTTP header value may hold: no NUL, CR, LF or other control character, nothing above U+00FF. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

interface JsonRpcAnswer {
  result?: unknown;
  error?: unknown;
}

let nextId = 1;

/**
 * A small JSON-RPC client over HTTP(S): rate limited, retried on transient failures except for sends,
 * with response bodies capped. Its errors never show the raw URL or a header's value, and neither does
 * printing or serializing it: the URL and the headers are private fields.
 */
export class JsonRpc implements Transport {
  /** The URL as it may be printed: with any key in it masked. */
  readonly displayUrl: string;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxResponseBytes: number;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  /** Text that must not reach an error message, longest first, with what replaces it. */
  readonly #secrets: readonly (readonly [string, string])[];

  constructor(url: string, opts: JsonRpcOptions = {}) {
    const extra = opts.headers ?? {};
    // Checked here, not left to fetch: fetch's own error would quote the offending value.
    for (const [name, value] of Object.entries(extra)) {
      if (!HEADER_NAME.test(name)) throw new TypeError("JsonRpc: a header name holds characters HTTP header names cannot; check the headers option");
      if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
        throw new TypeError(
          `JsonRpc: the ${name} header's value holds a line break, NUL or other character HTTP headers cannot carry; check where it comes from (an .env value, say)`,
        );
      }
    }
    this.#url = url;
    this.displayUrl = redactUrl(url);
    this.limiter = new RateLimiter(opts.perSecond ?? 25);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = Math.max(0, opts.retries ?? 3);
    this.maxResponseBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.#headers = { "content-type": "application/json", ...extra };
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const secrets = new Map<string, string>();
    for (const v of Object.values(extra)) {
      for (const s of [v.trim(), ...v.split(/\s+/).filter((p) => p.length >= 8)]) if (s.length >= 4) secrets.set(s, "***");
    }
    secrets.set(url, this.displayUrl);
    try {
      const href = new URL(url).href;
      if (href !== url) secrets.set(href, this.displayUrl);
    } catch {
      // not a URL fetch can read: it fails with the text as given, which is covered
    }
    this.#secrets = [...secrets].sort((a, b) => b[0].length - a[0].length);
  }

  /** The URL as given. It often holds a provider's key: print {@link displayUrl}. */
  get url(): string {
    return this.#url;
  }

  /** `text` with the URL redacted and every header value masked. */
  private safe(text: string): string {
    let out = text;
    for (const [s, by] of this.#secrets) if (out.includes(s)) out = out.split(s).join(by);
    return out;
  }

  /** A transport failure as it may be re-thrown: its message and its cause's without a secret. */
  private scrub(e: unknown): unknown {
    if (e instanceof HttpError || e instanceof ResponseTooLargeError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? e.cause : undefined;
    const causeMsg = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    const safeMsg = this.safe(msg);
    const safeCause = this.safe(causeMsg);
    if (e instanceof Error && safeMsg === msg && safeCause === causeMsg) return e;
    let c: Error | undefined;
    if (cause !== undefined) {
      c = new Error(safeCause);
      if (cause instanceof Error) c.name = cause.name;
      const code = (cause as { code?: unknown } | null)?.code;
      if (typeof code === "string") Object.assign(c, { code });
    }
    const err = new Error(safeMsg, c ? { cause: c } : undefined);
    err.name = e instanceof Error ? e.name : "Error";
    return err;
  }

  /**
   * One JSON-RPC call; its `result`. A JSON-RPC error throws {@link RpcError}, a non-2xx answer
   * {@link HttpError}, an answer over the byte limit {@link ResponseTooLargeError}; anything else that
   * fails (connection, timeout, unreadable answer) is retried and then thrown with its text scrubbed.
   */
  async request({ method, params = [] }: RequestArgs, opts: RequestOptions = {}): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
    const retries = NEVER_RETRIED.has(method) ? 0 : Math.max(0, opts.retries ?? this.retries);
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait();
      let out: JsonRpcAnswer;
      try {
        const r = await this.#fetch(this.#url, {
          method: "POST",
          headers: this.#headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!r.ok) {
          await r.body?.cancel().catch(() => {});
          // Never the raw URL: it often holds the provider's key.
          const hint = r.status === 401 || r.status === 403 ? ": the provider refused the request; check the key in the URL" : "";
          throw new HttpError(r.status, `HTTP ${r.status} from ${this.displayUrl}${hint}`);
        }
        const parsed: unknown = JSON.parse(await readTextCapped(r, this.maxResponseBytes, this.displayUrl));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`${this.displayUrl} answered with something that is not a JSON-RPC response`);
        }
        out = parsed as JsonRpcAnswer;
      } catch (e) {
        if (e instanceof ResponseTooLargeError || attempt >= retries) throw this.scrub(e);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      if (out.error !== undefined && out.error !== null) {
        const err = (typeof out.error === "object" ? out.error : { message: String(out.error) }) as { code?: unknown; message?: unknown; data?: unknown };
        const message = typeof err.message === "string" ? this.safe(err.message) : "";
        throw new RpcError(typeof err.code === "number" ? err.code : 0, message, err.data);
      }
      return out.result;
    }
  }
}
