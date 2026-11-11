/**
 * Test helpers for Pyth Pro: signed and placeholder-signed updates, Print literals, a fake request
 * API and a fake WebSocket.
 */

import type { Address, Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { vi } from "vitest";
import { type Channel, type LazerFeedInput, buildUpdate, encodePayload, feedIdHex, localSignerKey, proFeedId } from "../src/prices/lazer.js";
import type { Print, ProUpdate, WebSocketLike } from "../src/prices/pro.js";
import { ProClient } from "../src/prices/pro.js";

export const KEY = localSignerKey();
export const SIGNER: Address = privateKeyToAddress(KEY);
export const US = 1_000_000n;

/** The bytes32 feed id of Pyth Pro feed `n`. */
export const fid = (n: number): Hex => feedIdHex(n);

export interface FeedSpec {
  /** the Pyth Pro feed number */
  id: number;
  /** price mantissa; default 2,000 at exponent -8 */
  price?: bigint;
  conf?: bigint;
  expo?: number;
  /** the second the price was generated in; default the update's own second */
  generated?: number;
  /** microseconds added to the generation second */
  generatedExtraUs?: bigint;
  /** leave these properties out of the payload */
  omit?: readonly ("price" | "exponent" | "confidence" | "feedUpdateTimestamp")[];
}

export interface UpdateSpec {
  /** the second the update is stamped with */
  at: number;
  /** microseconds added to it */
  extraUs?: bigint;
  channel?: Channel | number;
  feeds: readonly FeedSpec[];
}

function payloadOf(u: UpdateSpec) {
  const feeds: LazerFeedInput[] = u.feeds.map((f) => {
    const omit = new Set(f.omit ?? []);
    const generatedUs = f.generated === 0 ? 0n : BigInt(f.generated ?? u.at) * US + (f.generatedExtraUs ?? (f.generated === undefined ? (u.extraUs ?? 0n) : 0n));
    return {
      id: f.id,
      ...(omit.has("price") ? {} : { price: f.price ?? 200_000_000_000n }),
      ...(omit.has("exponent") ? {} : { exponent: f.expo ?? -8 }),
      ...(omit.has("confidence") ? {} : { confidence: f.conf ?? 1_000n }),
      ...(omit.has("feedUpdateTimestamp") ? {} : { feedUpdateTimestamp: generatedUs }),
    };
  });
  return { timestampUs: BigInt(u.at) * US + (u.extraUs ?? 0n), channel: u.channel ?? "fixed_rate@200ms", feeds };
}

/** An update signed with the local key. */
export function signed(u: UpdateSpec, key: Hex = KEY): Promise<Hex> {
  return buildUpdate(payloadOf(u), key);
}

/**
 * An update in the EVM envelope with a placeholder signature: readable by everything that reads the
 * payload, and recovering to no trusted signer. For tests that never check signatures.
 */
export function unsigned(u: UpdateSpec): Hex {
  const payload = encodePayload(payloadOf(u)).slice(2);
  const size = (payload.length / 2).toString(16).padStart(4, "0");
  return `0x2a22999a${"11".repeat(32)}${"22".repeat(32)}00${size}${payload}`;
}

/** The one-second channel's update for second `at`, placeholder-signed. */
export const tick = (at: number, feeds: readonly FeedSpec[]): Hex => unsigned({ at, channel: "fixed_rate@1000ms", feeds });

/** A Print literal for feed `feedId`, its price generated in second `at`. */
export function print(feedId: Hex, at: number, over: Partial<Print> = {}): Print {
  const generatedUs = over.generatedUs ?? BigInt(at) * US;
  return {
    feedId,
    price: 200_000_000_000n,
    conf: 1_000n,
    expo: -8,
    publishTime: at,
    generatedUs,
    timestampUs: generatedUs,
    channel: 3,
    signer: null,
    blob: "0x",
    received: 0,
    ...over,
  };
}

/** A fetch that answers through `routes`, recording each request. */
export function fakeFetch(routes: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; method: string; headers: Headers; body: any }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    return routes(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A JSON response. */
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The request API's answer carrying `blob` as its EVM update. */
export const evm = (blob: Hex, prefix = true) => ({ parsed: { timestampUs: "0", priceFeeds: [] }, evm: { encoding: "hex", data: prefix ? blob : blob.slice(2) } });

/** A stream message carrying `blob`. */
export const streamUpdated = (blob: Hex, subscriptionId = 1) => JSON.stringify({ type: "streamUpdated", subscriptionId, ...evm(blob) });

/** A fake WebSocket: tests open it, feed it messages and close it; it records what the client sent. */
export class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.all = [];
  }
  /** Sockets opened to `url`, oldest first. */
  static to(url: string): FakeSocket[] {
    return FakeSocket.all.filter((s) => s.url === url);
  }

  readonly sent: any[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();

  constructor(
    readonly url: string,
    readonly arg?: any,
  ) {
    FakeSocket.all.push(this);
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  /** The server accepts the connection. */
  open(): void {
    this.emit("open", {});
  }
  /** The server sends `data`. */
  message(data: unknown): void {
    this.emit("message", { data });
  }
  /** The connection drops. */
  drop(code = 1006, reason = ""): void {
    this.emit("close", { code, reason });
  }
  /** The connection fails. */
  error(message = "boom"): void {
    this.emit("error", { message });
  }
  /** The headers the client asked the constructor to send, when it used header auth. */
  get headers(): Record<string, string> | undefined {
    return this.arg && !Array.isArray(this.arg) ? this.arg.headers : undefined;
  }
  /** The subprotocols the client asked for, when it used subprotocol auth. */
  get protocols(): string[] | undefined {
    return Array.isArray(this.arg) ? this.arg : undefined;
  }
}

/** Let queued microtasks and zero-delay timers run. */
export const settle = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A Pyth Pro request API in memory: `latest` prices per feed, and the one-second channel's history
 * per feed as the seconds it generated a price in. Answers POST /v1/latest_price and POST /v1/price
 * with placeholder-signed updates carrying exactly the feeds asked for.
 */
export class FakePro {
  now = 1_700_000_000;
  readonly prices = new Map<number, { price: bigint; conf?: bigint; expo?: number; generated?: number }>();
  /** per feed: the seconds at which it generated a price, ascending, with the price it generated */
  readonly history = new Map<number, { at: number; price: bigint }[]>();
  /** per feed: stretches in which it generates a price every second */
  readonly stretches = new Map<number, { from: number; until: number; price: bigint }[]>();
  /** seconds the archive does not hold (answers 404) */
  readonly missing = new Set<number>();
  readonly requests: { path: string; body: any }[] = [];

  set(id: number, price: bigint, over: { conf?: bigint; expo?: number; generated?: number } = {}): this {
    this.prices.set(id, { price, ...over });
    return this;
  }

  /** `id` generated `price` at second `at`. */
  generate(id: number, at: number, price: bigint): this {
    const h = this.history.get(id) ?? [];
    h.push({ at, price });
    h.sort((a, b) => a.at - b.at);
    this.history.set(id, h);
    return this;
  }

  /** `id` generates `price` every second from `from` through `until` (default: for good). */
  printing(id: number, from: number, price: bigint, until = Number.MAX_SAFE_INTEGER): this {
    const s = this.stretches.get(id) ?? [];
    s.push({ from, until, price });
    this.stretches.set(id, s);
    return this;
  }

  /** The last price `id` generated as of `second`, or null when it has generated none. */
  lastGenerated(id: number, second: number): { at: number; price: bigint } | null {
    let last = (this.history.get(id) ?? []).filter((e) => e.at <= second).pop() ?? null;
    for (const s of this.stretches.get(id) ?? []) {
      if (second < s.from) continue;
      const at = Math.min(second, s.until);
      if (last === null || at >= last.at) last = { at, price: s.price };
    }
    return last;
  }

  /** The one-second update stamped `second` for `ids`: each feed's last generated price as of it. */
  tickAt(second: number, ids: readonly number[]): Hex {
    return tick(
      second,
      ids.map((id) => {
        const last = this.lastGenerated(id, second);
        return last ? { id, price: last.price, generated: last.at } : { id, price: 0n, generated: 0 };
      }),
    );
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    this.requests.push({ path: url.pathname, body });
    if (url.pathname === "/v1/latest_price") {
      const feeds: FeedSpec[] = [];
      for (const id of body.priceFeedIds as number[]) {
        const p = this.prices.get(id);
        if (p) feeds.push({ id, price: p.price, conf: p.conf, expo: p.expo, generated: p.generated ?? this.now });
      }
      return json(evm(unsigned({ at: this.now, channel: body.channel, feeds })));
    }
    if (url.pathname === "/v1/price") {
      const second = Number(body.timestamp) / 1_000_000;
      if (this.missing.has(second) || second > this.now) return new Response("no data", { status: 404 });
      return json(evm(this.tickAt(second, body.priceFeedIds)));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  /** A client over this API. */
  client(): ProClient {
    return new ProClient({ fetch: this.fetch, restUrl: "https://pro.test", symbolsUrl: "https://symbols.test", streamUrls: ["wss://pro-0.test/v1/stream"] });
  }
}

/** The feed numbers a set of bytes32 ids hold. */
export const numbers = (ids: readonly Hex[]): number[] => ids.map(proFeedId);

/** A ProUpdate's feed entry for `id`, for assertions. */
export const feedOf = (u: ProUpdate, id: Hex) => u.feeds.get(id);
