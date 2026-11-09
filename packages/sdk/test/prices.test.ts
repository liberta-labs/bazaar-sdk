import { type Hex, encodeAbiParameters } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Market } from "../src/models.js";
import { AccumulatorError, HermesClient, HermesError, PriceService, type Print, accumulator, feedLabel, fetchSymbols, marketLabel, parseResponse } from "../src/prices/index.js";
import type { HermesUpdates, PriceSource } from "../src/prices/index.js";

const feed = (i: number): Hex => `0x${i.toString(16).padStart(2, "0").repeat(32)}`;
const [F1, F2, F3, FA] = [feed(1), feed(2), feed(3), feed(0xab)];
const VAA = `01${"00".repeat(40)}`; // stand-in bytes: only its length is framed

function blob(feeds: Hex[], publish = 100): Hex {
  const prefix: Hex = `0x504e4155${"01000000"}${(VAA.length / 2).toString(16).padStart(4, "0")}${VAA}`;
  const msgs = feeds.map((f, i): [Hex, Hex[]] => {
    const m = { feedId: f, price: 200_000_000_000n + BigInt(i), conf: 1_000n, expo: -8, publishTime: publish, prevPublishTime: publish - 1, emaPrice: 200_000_000_000n, emaConf: 1_000n };
    const node: Hex = `0x${i.toString(16).padStart(2, "0").repeat(20)}`;
    return [accumulator.encodePriceMessage(m), [node, node, node]];
  });
  return accumulator.build(prefix, msgs);
}

function market(legs: Hex[], address: Hex = `0x${"aa".repeat(20)}`): Market {
  return { address, pairId: legs[0]!, baseFeedId: legs[0]!, legs, invertQuote: false, continuous: true, description: "", label: "", state: null, dirty: false, lastRead: 0 };
}

/** A Hermes response for blob `b` (made by `blob(feeds, publish)`), its parsed JSON agreeing with it. */
function body(b: Hex, feeds: Hex[], publish = 100): HermesUpdates {
  return {
    binary: { data: [b.slice(2)] },
    parsed: feeds.map((f, i) => ({ id: f.slice(2), price: { price: String(200_000_000_000n + BigInt(i)), conf: "1000", expo: -8, publish_time: publish } })),
  };
}

// MockPyth.createPriceFeedUpdateData's output: abi.encode(PriceFeed(id, price, emaPrice), prevPublishTime)
const MOCK_WORDS = [
  { type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint256" },
  { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint256" }, { type: "uint64" },
] as const;

function mockBlob(f: Hex, price: bigint, publish: number, expo = -8): Hex {
  return encodeAbiParameters(MOCK_WORDS, [f, price, 1_000n, expo, BigInt(publish), price, 1_000n, expo, BigInt(publish), BigInt(publish - 1)]);
}

/** A price message for `f` (the blob() defaults, with `over` applied). */
function msg(f: Hex, over: Partial<accumulator.PriceMessage> = {}): Hex {
  return accumulator.encodePriceMessage({ feedId: f, price: 200_000_000_000n, conf: 1_000n, expo: -8, publishTime: 100, prevPublishTime: 99, emaPrice: 1n, emaConf: 1n, ...over });
}

const PREFIX: Hex = `0x504e4155${"01000000"}${(VAA.length / 2).toString(16).padStart(4, "0")}${VAA}`;

function pr(f: Hex, publish: number, b: Hex = "0x"): Print {
  return { feedId: f, price: 200_000_000_000n, conf: 1_000n, expo: -8, publishTime: publish, prevPublishTime: publish - 1, blob: b, received: 0 };
}

describe("accumulator updates", () => {
  it("parse and subset keep the signed prefix", () => {
    const b = blob([F1, F2, F3]);
    const acc = accumulator.parse(b);
    expect(acc.feedIds()).toEqual([F1, F2, F3]);
    const sub = accumulator.subset(b, [F3, F1]);
    const acc2 = accumulator.parse(sub);
    expect(acc2.prefix).toBe(acc.prefix);
    expect(acc2.feedIds()).toEqual([F1, F3]); // the blob's own order
    expect(acc2.updates[1]!.raw).toBe(acc.updates[2]!.raw); // the update bytes are copied unchanged
    expect(() => accumulator.subset(b, [feed(9)])).toThrow(AccumulatorError);
    expect(() => accumulator.parse(b.slice(0, -10) as Hex)).toThrow(AccumulatorError);
  });

  it("subset requires every asked feed, not just as many updates", () => {
    const dup = accumulator.build(PREFIX, [[msg(FA), []], [msg(FA), []]]); // FA twice, no F2
    expect(() => accumulator.subset(dup, [FA, F2])).toThrow(new AccumulatorError(`update does not carry feed(s) ${F2.slice(2)}`));
    expect(accumulator.parse(accumulator.subset(dup, [FA])).feedIds()).toEqual([FA]); // cut once
  });

  it("decodes the price messages it carries", () => {
    const msg = accumulator.parse(blob([F1, F2], 1_700_000_000)).updates[1]!.message!;
    expect(msg).toEqual({
      feedId: F2, price: 200_000_000_001n, conf: 1_000n, expo: -8, publishTime: 1_700_000_000,
      prevPublishTime: 1_699_999_999, emaPrice: 200_000_000_000n, emaConf: 1_000n,
    });
    const neg = { ...msg, price: -5n, expo: -12, publishTime: 1 };
    expect(accumulator.parsePriceMessage(accumulator.encodePriceMessage(neg))).toEqual(neg);
    expect(accumulator.isAccumulator(blob([F1]))).toBe(true);
    expect(accumulator.isAccumulator(`0x${"504E4155"}00`)).toBe(true);
    expect(accumulator.isAccumulator("0x504e41")).toBe(false);
  });
});

describe("Hermes responses", () => {
  it("parse_response reads each print from its blob's signed message", () => {
    const b = blob([F1, F2]);
    const prints = parseResponse({
      binary: { encoding: "hex", data: [b.slice(2)] },
      parsed: [
        // Hermes' metadata is not compared: the signed predecessor time is the blob's
        { id: F1.slice(2), price: { price: "200000000000", conf: "1000", expo: -8, publish_time: 100 }, metadata: { prev_publish_time: 42 } },
        { id: F2.slice(2), price: { price: "200000000001", conf: 1000, expo: "-8", publish_time: "100" } },
      ],
    });
    expect(prints.map((p) => p.feedId)).toEqual([F1, F2]);
    expect(prints[0]!.blob).toBe(b);
    expect(prints.map((p) => [p.price, p.conf, p.expo, p.publishTime, p.prevPublishTime])).toEqual([
      [200_000_000_000n, 1_000n, -8, 100, 99],
      [200_000_000_001n, 1_000n, -8, 100, 99],
    ]);
    // without parsed JSON at all, the blob alone gives the same prints
    expect(parseResponse({ binary: { data: [b] } }).map((p) => [p.feedId, p.price])).toEqual(prints.map((p) => [p.feedId, p.price]));
    // a feed the blob carries twice counts once, its first message (the one subset() cuts)
    const twice = accumulator.build(PREFIX, [[msg(F1, { price: 7n }), []], [msg(F1, { price: 8n }), []]]);
    expect(parseResponse({ binary: { data: [twice] } }).map((p) => p.price)).toEqual([7n]);
  });

  it("refuses a response whose JSON disagrees with its signed update, or names a feed no update carries", () => {
    // the repro: the JSON says 50,000 now, the signed message says 100 an hour ago
    const b = accumulator.build(PREFIX, [[msg(FA, { price: 100_00000000n, publishTime: 1_000 }), [`0x${"11".repeat(20)}`]]]);
    const json = (over: Partial<{ price: string; conf: string; expo: number; publish_time: number }>, id = FA) => ({
      binary: { data: [b.slice(2)] },
      parsed: [{ id: id.slice(2), price: { price: "10000000000", conf: "1000", expo: -8, publish_time: 1_000, ...over } }],
    });
    expect(parseResponse(json({}))[0]!.price).toBe(100_00000000n);
    for (const [over, field] of [
      [{ price: "5000000000000" }, "price"],
      [{ conf: "1" }, "conf"],
      [{ expo: -6 }, "expo"],
      [{ publish_time: 4_600 }, "publish time"],
    ] as const) {
      expect(() => parseResponse(json(over))).toThrow(new HermesError(`price endpoint's ${field} for feed 0xabababab… disagrees with its signed update: refusing the response`));
    }
    // a feed the (single) blob does not carry is never paired with it: ETH/USD here
    const eth: Hex = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    expect(() => parseResponse(json({}, eth))).toThrow("price endpoint sent a print for feed 0xff61491a… without update data that carries it");
    // a huge number string is refused before BigInt parses it
    const t0 = performance.now();
    expect(() => parseResponse(json({ price: "9".repeat(1_000_000) }))).toThrow(HermesError);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("reads MockPyth updates from their own bytes, and refuses update data in any other format", () => {
    const m1 = mockBlob(FA, 185_050_000_000n, 1_700_000_000);
    const prints = parseResponse({
      binary: { data: [m1.slice(2), mockBlob(F2, 2n, 1_700_000_001)] },
      parsed: [
        { id: `0X${FA.slice(2).toUpperCase()}`, price: { price: "185050000000", conf: "1000", expo: -8, publish_time: 1_700_000_000 } },
        { id: F2, price: { price: 2, conf: 1000, expo: -8, publish_time: 1_700_000_001 } },
      ],
    });
    expect(prints.map((p) => [p.feedId, p.blob, p.price, p.prevPublishTime])).toEqual([
      [FA, m1, 185_050_000_000n, 1_699_999_999],
      [F2, prints[1]!.blob, 2n, 1_700_000_000],
    ]);
    expect(() => parseResponse({ binary: { data: [m1] }, parsed: [{ id: FA, price: { price: "1", conf: "1000", expo: -8, publish_time: 1_700_000_000 } }] })).toThrow("disagrees");
    expect(() => parseResponse({ binary: { data: ["AABB", "0xccdd"] }, parsed: [] })).toThrow("price endpoint sent update data the SDK cannot read");
    expect(() => parseResponse({ binary: { data: ["zz"] }, parsed: [] })).toThrow("malformed update data: not hex");
    expect(() => parseResponse({ binary: { data: [mockBlob(FA, 1n, 1, 31)] } })).toThrow("holds values out of range");
  });

  it("refuses exponents past ±30 before any conversion", () => {
    const t0 = performance.now();
    for (const expo of [31, -31, -30_000_000, 1_000_000_000]) {
      const b = accumulator.build(PREFIX, [[msg(F1, { expo }), []]]);
      expect(() => parseResponse({ binary: { data: [b] } })).toThrow(HermesError);
      expect(() => accumulator.parse(b)).toThrow(AccumulatorError);
      expect(() => parseResponse(body(b, [F1]))).toThrow(`exponent ${expo}, outside ±30`);
    }
    expect(() => accumulator.parsePriceMessage(msg(F1, { expo: -31 }))).toThrow(AccumulatorError);
    expect(performance.now() - t0).toBeLessThan(200);
    for (const expo of [30, -30]) expect(parseResponse({ binary: { data: [accumulator.build(PREFIX, [[msg(F1, { expo }), []]])] } })[0]!.expo).toBe(expo);
    // negative prices and large values survive the fast field reader exactly
    const odd = [-5n, -(2n ** 53n), -(2n ** 63n), 2n ** 63n - 1n, 2n ** 53n + 1n];
    const b = accumulator.build(PREFIX, odd.map((price, i) => [msg(feed(i + 1), { price, conf: price < 0n ? -price : price }), []]));
    expect(parseResponse({ binary: { data: [b] } }).map((p) => [p.price, p.conf])).toEqual(odd.map((p) => [p, p < 0n ? -p : p]));
    expect(() => parseResponse({ binary: { data: [accumulator.build(PREFIX, [[msg(F1, { publishTime: -1 }), []]])] } })).toThrow("publish time out of range");
  });

  it("keeps only the feeds asked for", () => {
    const b = blob([F1, F2, F3]);
    const prints = parseResponse(body(b, [F1, F2, F3]), 0, new Set([F3, F1]));
    expect(prints.map((p) => p.feedId)).toEqual([F1, F3]);
  });
});

describe("PriceService", () => {
  it("update_for cuts each market out of the shared stream", () => {
    let now = 101;
    const svc = new PriceService(null, { clock: () => now });
    const b = blob([F1, F2, F3]);
    svc.ingest(parseResponse(body(b, [F1, F2, F3])));
    const m = market([F1, F3]);
    const upd = svc.updateFor(m);
    expect(upd).toHaveLength(1);
    expect(accumulator.parse(upd[0]!).feedIds()).toEqual([F1, F3]);
    expect(svc.fresh(m)).toBe(true);
    now = 104;
    expect(svc.fresh(m)).toBe(false); // 4 s old: past the window, with the sending margin
    now = 102;
    expect(svc.fresh(m) && !svc.fresh(m, null, 2.5)).toBe(true);
  });

  it("keeps a market's update until a newer print arrives for one of its legs", () => {
    const svc = new PriceService(null, { clock: () => 101, logger: null });
    const m = market([F1, F3]);
    expect(svc.updateFor(m)).toEqual([]);
    expect(svc.price(m)).toBeNull();
    svc.ingest(parseResponse(body(blob([F1, F2, F3]), [F1, F2, F3])));
    const first = svc.updateFor(m);
    first.push("0xdead"); // callers get their own array
    expect(svc.updateFor(m)).toEqual(first.slice(0, 1));
    expect(svc.price(m)).toBe(svc.price(m)); // computed once per print
    // F3 prints again on its own: the market's update now comes in two parts, one per blob.
    const b3 = blob([F3], 101);
    svc.ingest(parseResponse(body(b3, [F3], 101)));
    const second = svc.updateFor(m);
    expect(second.map((u) => accumulator.parse(u).feedIds())).toEqual([[F1], [F3]]);
    expect(second[1]).toBe(b3);
    expect(svc.legs(m)!.map((p) => p.publishTime)).toEqual([100, 101]);
  });

  it("passes single-feed updates through, judges closed sessions and prices gas", () => {
    const svc = new PriceService(null, { clock: () => 200 });
    expect(svc.closed(market([F1]))).toBe(false); // nothing delivered yet: unknown, not closed
    svc.ingest([pr(F1, 199, "0xaa"), pr(F2, 150, "0xbb")]);
    expect(svc.updateFor(market([F1, F2]))).toEqual(["0xaa", "0xbb"]);
    expect(svc.closed(market([F1]))).toBe(false);
    expect(svc.closed(market([F1, F2]))).toBe(true);
    expect(svc.closed(market([F3]))).toBe(true); // no print at all while others arrive
    expect(svc.ethUsd()).toBeNull();
    svc.ingest([{ ...pr("0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", 200), price: 312_345_678_901n }]);
    expect(svc.ethUsd()).toBeCloseTo(3123.45678901, 8);
  });

  it("ethUsd trusts only a recent print within sane bounds, so the caller falls back otherwise", () => {
    const ETH: Hex = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    let now = 1_000;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    expect([svc.ethUsdMaxAge, svc.ethUsdBounds]).toEqual([60, [100, 1_000_000]]);
    svc.ingest([{ ...pr(ETH, 1_000), price: 300_000_000_000n }]);
    expect(svc.ethUsd()).toBe(3000);
    now = 1_060;
    expect(svc.ethUsd()).toBe(3000); // 60 s old: still trusted
    now = 1_061;
    expect(svc.ethUsd()).toBeNull(); // older: the stream stopped bringing ETH/USD
    expect(svc.ethUsd(1_030)).toBe(3000);
    // $0.0001 (every cost would book as ~$0), $10,000,000, and conversions that overflow to Infinity or 0
    for (const [price, expo] of [[1n, -4], [10_000_000_000_000n, -6], [1n, 400], [1n, -400]] as const) {
      now += 10;
      svc.ingest([{ ...pr(ETH, now), price, expo }]);
      expect(svc.latest.get(ETH)!.price).toBe(price);
      expect(svc.ethUsd()).toBeNull();
    }
    const custom = new PriceService(null, { clock: () => 10, ethUsdMaxAge: 5, ethUsdBounds: [1, 10], logger: null });
    custom.ingest([{ ...pr(ETH, 10), price: 5n, expo: 0 }]);
    expect(custom.ethUsd()).toBe(5);
    expect(custom.ethUsd(16)).toBeNull();
  });

  it("ignores a print dated in the future instead of letting it hold the feed", () => {
    const warn = vi.fn();
    const now = 1_000;
    const svc = new PriceService(null, { clock: () => now, logger: { warn } });
    svc.ingest([pr(F1, now + 10 * 365 * 86_400)]); // one hostile print, ten years ahead
    svc.ingest([pr(F1, now + 6)]);
    expect(svc.latest.has(F1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1); // once per feed
    expect(warn.mock.calls[0]![0]).toMatch(/^ignored a print for feed 0x01010101… dated 315360000 s ahead of the clock \(more than 5 s\)/);
    svc.ingest([pr(F1, now + 5)]); // within the skew
    svc.ingest([pr(F1, now + 1)]); // older: does not replace it
    expect(svc.latest.get(F1)!.publishTime).toBe(now + 5);
    expect(svc.fresh(market([F1]), now + 5)).toBe(true);
    const lax = new PriceService(null, { clock: () => now, maxFutureSkew: 60, logger: null });
    lax.ingest([pr(F1, now + 30)]);
    expect(lax.latest.get(F1)!.publishTime).toBe(now + 30);
  });

  it("fetch keeps only the asked feeds, and reports each one the endpoint has no print for", async () => {
    const warn = vi.fn();
    const asked: (readonly Hex[])[] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push(ids);
        return [pr(F1, 100), pr(F2, 100), pr(feed(0x77), 100)]; // F2 and 0x77 were not asked for
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { clock: () => 100, logger: { warn } });
    await svc.fetch([F1, F3]);
    expect(asked).toEqual([[F1, F3]]);
    expect([...svc.latest.keys()]).toEqual([F1]); // asked for (though not watched): kept; the rest dropped
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      `price endpoint sent no print for feed ${F3}: markets on it get no price until it does (check the feed id and that the endpoint serves it; a trading-hours feed may be closed). Other feeds are unaffected.`,
    ]);
    await svc.fetch([F3]);
    expect(warn).toHaveBeenCalledTimes(1); // once per feed
    svc.watch([F3]);
    expect(svc.missing()).toEqual(["0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", F3]);
    svc.ingest([pr(F2, 100)]); // a caller's own prints are taken as given
    expect(svc.latest.has(F2)).toBe(true);
  });

  it("next_prints reports each feed once per newer print", async () => {
    const svc = new PriceService(null);
    svc.ingest([pr(F1, 100), pr(F2, 100)]);
    expect(await svc.nextPrints()).toEqual(new Set([F1, F2]));
    svc.ingest([pr(F1, 100), pr(F2, 99)]); // the same print again, and an older one
    let done = false;
    const waiting = svc.nextPrints().then((s) => {
      done = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    svc.ingest([pr(F1, 101)]);
    svc.ingest([pr(F1, 102)]);
    expect(await waiting).toEqual(new Set([F1]));
    expect(svc.latest.get(F1)!.publishTime).toBe(102);
    svc.stop();
    expect(await svc.nextPrints()).toEqual(new Set());
  });

  it("tells every listener about each batch's newer prints", () => {
    const warn = vi.fn();
    const svc = new PriceService(null, { logger: { warn } });
    const seen: Hex[][] = [];
    const sets: ReadonlySet<Hex>[] = [];
    svc.onPrints(() => {
      throw new Error("boom");
    });
    const off = svc.onPrints((feeds) => {
      seen.push([...feeds]);
      sets.push(feeds);
    });
    svc.onPrints((feeds) => sets.push(feeds));
    svc.ingest([pr(F1, 100), pr(F2, 100)]);
    svc.ingest([pr(F1, 100)]); // nothing newer: no call
    svc.ingest([pr(F2, 101)]);
    expect(seen).toEqual([[F1, F2], [F2]]);
    expect(sets[0]).toBe(sets[1]); // one set per batch, shared
    expect(warn).toHaveBeenCalledWith("price listener failed: boom");
    off();
    svc.ingest([pr(F1, 105)]);
    expect(seen).toHaveLength(2);
  });
});

/** A fetch that serves `routes` by path, recording each request. */
function fakeFetch(routes: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init.headers) });
    return routes(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A response whose body arrives as `chunks`, then stays open until the request is aborted. */
function sse(chunks: string[], init: RequestInit, end = false): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (end) c.close();
      else init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("HermesClient", () => {
  const KEYED = "https://hermes.example.com/7f6e5d4c3b2a19087f6e5d4c3b2a1908";

  it("asks for hex updates with parsed prints, with the key as a bearer token", async () => {
    const b = blob([F1]);
    const { fetch, calls } = fakeFetch(() => Response.json(body(b, [F1])));
    const c = new HermesClient("http://hermes.test/", "k3y", { "x-extra": "1" }, { fetch });
    expect(c.base).toBe("http://hermes.test");
    const prints = await c.latest([F1, F2]);
    expect(prints[0]!.blob).toBe(b);
    const { url, headers } = calls[0]!;
    expect(url.pathname).toBe("/v2/updates/price/latest");
    expect(url.searchParams.getAll("ids[]")).toEqual([F1, F2]);
    expect(url.searchParams.get("encoding")).toBe("hex");
    expect(url.searchParams.get("parsed")).toBe("true");
    expect(url.searchParams.get("ignore_invalid_price_ids")).toBe("true"); // one unknown feed must not 404 them all
    expect(headers.get("authorization")).toBe("Bearer k3y");
    expect(headers.get("x-extra")).toBe("1");
    await c.atOrAfter(1_700_000_000, [F1]);
    expect(calls[1]!.url.pathname).toBe("/v2/updates/price/1700000000");
    expect(calls[1]!.url.searchParams.get("ignore_invalid_price_ids")).toBe("true");
  });

  it("returns only the feeds asked for, whatever else the response carries", async () => {
    const b = blob([F1, F2, F3]);
    const { fetch } = fakeFetch(() => Response.json(body(b, [F1, F2, F3])));
    const c = new HermesClient("http://hermes.test", null, null, { fetch });
    expect((await c.latest([F3])).map((p) => p.feedId)).toEqual([F3]);
    expect((await c.atOrAfter(1, [F2, F1])).map((p) => p.feedId)).toEqual([F1, F2]);
  });

  it("refuses a key or header a request cannot carry, and never prints the key", async () => {
    const KEY = "sk_live_SECRETKEY1234";
    for (const bad of [`${KEY}\u0000x`, `${KEY}\r\n`, `${KEY} `]) {
      let err: unknown;
      try {
        new HermesClient("http://hermes.test", bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HermesError);
      expect((err as Error).message).toMatch(/prices\.apiKey/);
      expect((err as Error).message).not.toContain("SECRET");
    }
    expect(() => new HermesClient("http://hermes.test", null, { "x-api-key": `${KEY}\n` })).toThrow(
      new HermesError("price endpoint header x-api-key has a value a request header cannot carry (a line break or control character?): re-enter it"),
    );
    expect(() => new HermesClient("http://hermes.test", null, { "bad name": "1" })).toThrow("is not a valid HTTP header name");
    // a fetch failure that quotes the key (or a secret header) has it masked
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`Headers.append: "Bearer ${KEY}" and "${KEY}-h" are invalid`);
    });
    const c = new HermesClient("http://hermes.test", KEY, { "x-api-key": `${KEY}-h` }, { fetch });
    const msg = await c.latest([F1]).then(() => "", (e: Error) => e.message);
    expect(msg).toBe('price endpoint unreachable: Headers.append: "Bearer ***" and "***" are invalid');
  });

  it("refuses a response body over 16 MiB, declared or streamed", async () => {
    const MiB = new Uint8Array(1024 * 1024).fill(0x20);
    const declared = fakeFetch(() => new Response("{}", { headers: { "content-length": String(17 * 1024 * 1024) } }));
    await expect(new HermesClient("http://hermes.test", null, null, { fetch: declared.fetch }).latest([F1])).rejects.toThrow(
      new HermesError("price endpoint's response is larger than 16 MiB: refusing it"),
    );
    let sent = 0;
    let canceled = false;
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent++ < 64) c.enqueue(MiB);
              else c.close();
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    );
    await expect(new HermesClient("http://hermes.test", null, null, { fetch: streamed.fetch }).latest([F1])).rejects.toThrow("larger than 16 MiB");
    expect(sent).toBeLessThan(20); // stopped reading at the cap
    expect(canceled).toBe(true);
  });

  it("drops a stream whose line runs past 4 MiB without a line break", async () => {
    const chunk = "x".repeat(1024 * 1024);
    let sent = 0;
    let signal: AbortSignal | undefined;
    const { fetch } = fakeFetch((_, init) => {
      signal = init.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new TextEncoder().encode(sent++ === 0 ? `data: ${chunk}` : chunk));
          },
        }),
      );
    });
    const c = new HermesClient("http://hermes.test", null, null, { fetch });
    await expect(c.stream([F1]).next()).rejects.toThrow(new HermesError("price stream sent a line longer than 4 MiB: dropping the stream"));
    expect(sent).toBeLessThanOrEqual(6);
    expect(signal?.aborted).toBe(true);
    // a long line that ends in time is read
    const event = `data:${JSON.stringify(body(blob([F1]), [F1]))}`;
    const ok = fakeFetch((_, init) => sse([`: ${"y".repeat(3 * 1024 * 1024)}\n`, `${event}\n\n`], init, true));
    const got: Hex[][] = [];
    for await (const prints of new HermesClient("http://hermes.test", null, null, { fetch: ok.fetch }).stream([F1])) got.push(prints.map((p) => p.feedId));
    expect(got).toEqual([[F1]]);
  });

  it("explains refusals and failures without the endpoint's URL", async () => {
    const statuses = [401, 404, 500];
    const { fetch } = fakeFetch((url) => {
      const s = statuses.shift();
      if (s === undefined) throw new TypeError(`fetch failed: ${url.href}`);
      return new Response(`no route for ${url.href}`, { status: s });
    });
    const c = new HermesClient(KEYED, null, null, { fetch });
    const errors: string[] = [];
    for (let i = 0; i < 4; i++) errors.push(await c.latest([F1]).then(() => "", (e: Error) => (e instanceof HermesError ? e.message : `not HermesError: ${e}`)));
    expect(errors[0]).toBe("price endpoint refused the request (HTTP 401); check prices.apiKey");
    expect(errors[1]).toMatch(/^price endpoint has no data for this request \(HTTP 404\)/);
    expect(errors[2]).toMatch(/^price endpoint returned HTTP 500/);
    expect(errors[3]).toMatch(/^price endpoint unreachable: fetch failed: https:\/\/hermes\.example\.com\/\*\*\*\/v2/);
    for (const e of errors) expect(e).not.toContain("7f6e5d4c3b2a19087f6e5d4c3b2a1908");
  });

  it("streams server-sent prints however the events are split", async () => {
    const b = blob([F1, F2]);
    const event = `data:${JSON.stringify(body(b, [F1, F2]))}`;
    const cut = Math.floor(event.length / 2);
    const { fetch, calls } = fakeFetch((_, init) =>
      sse([": hello\r\n\r\n", event.slice(0, cut), `${event.slice(cut)}\r`, "\n\r\ndata:not json\n\n", `${event}\n\n`, event], init, true),
    );
    const c = new HermesClient("http://hermes.test", "k3y", null, { fetch });
    const got: Hex[][] = [];
    for await (const prints of c.stream([F1, F2])) got.push(prints.map((p) => p.feedId));
    expect(got).toEqual([[F1, F2], [F1, F2], [F1, F2]]); // the last event ends without a newline
    expect(calls[0]!.url.pathname).toBe("/v2/updates/price/stream");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k3y");
  });

  it("stops a stream when its signal aborts", async () => {
    const event = `data:${JSON.stringify(body(blob([F1]), [F1]))}\n\n`;
    const { fetch } = fakeFetch((_, init) => sse([event], init));
    const c = new HermesClient("http://hermes.test", null, null, { fetch });
    const ctl = new AbortController();
    const it = c.stream([F1], ctl.signal)[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    const pending = it.next();
    ctl.abort();
    await expect(pending).rejects.toThrow();
  });

  it("drops a stream that goes quiet, once its keep-alive comments stop", async () => {
    const event = `data:${JSON.stringify(body(blob([F1]), [F1]))}\n\n`;
    let signal: AbortSignal | undefined;
    const { fetch } = fakeFetch((_, init) => {
      signal = init.signal ?? undefined;
      const enc = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(event));
          let n = 0;
          timer = setInterval(() => {
            if (++n > 6) return clearInterval(timer); // 300 ms of keep-alives, then silence
            c.enqueue(enc.encode(":\n"));
          }, 50);
          init.signal?.addEventListener("abort", () => {
            clearInterval(timer);
            c.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const c = new HermesClient("http://hermes.test", null, null, { fetch });
    const t0 = performance.now();
    const it = c.stream([F1], undefined, { idleTimeout: 0.2 })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await expect(it.next()).rejects.toThrow(new HermesError("price stream went quiet: no data for 0.2 s"));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(400); // the comments kept it alive past 0.2 s
    expect(signal?.aborted).toBe(true); // the request itself was aborted
  });

  it("counts a response that never comes as silence, and a slow consumer as none", async () => {
    const hang = fakeFetch(
      (_, init) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const hung = new HermesClient("http://hermes.test", null, null, { fetch: hang.fetch });
    await expect(hung.stream([F1], undefined, { idleTimeout: 0.05 }).next()).rejects.toThrow("price stream went quiet");

    const event = `data:${JSON.stringify(body(blob([F1]), [F1]))}\n\n`;
    const two = fakeFetch((_, init) => sse([event, event], init));
    const c = new HermesClient("http://hermes.test", null, null, { fetch: two.fetch });
    const it = c.stream([F1], undefined, { idleTimeout: 0.1 })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await new Promise((r) => setTimeout(r, 250)); // longer than the timeout, between batches
    expect((await it.next()).done).toBe(false);
    await expect(it.next()).rejects.toThrow("price stream went quiet");
  });

  it("finds Pyth symbols, and none when the endpoint has no metadata", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json([{ id: F1.slice(2).toUpperCase(), attributes: { symbol: "Crypto.BTC/USD" } }, { id: F2, attributes: {} }, { id: F3 }]),
    );
    const symbols = await fetchSymbols(new HermesClient("http://hermes.test", null, null, { fetch }), [F1, F2]);
    expect(symbols).toEqual(new Map([[F1, "Crypto.BTC/USD"], [F2, ""]]));
    const down = fakeFetch(() => new Response("", { status: 503 }));
    expect(await fetchSymbols(new HermesClient("http://hermes.test", null, null, { fetch: down.fetch }), [F1])).toEqual(new Map());
  });
});

describe("PriceService.run", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A source whose stream yields `batches` and then waits until aborted. */
  function source(batches: (ids: readonly Hex[]) => Print[][]) {
    const streams: (readonly Hex[])[] = [];
    let latest = 0;
    const src: PriceSource = {
      async latest() {
        latest++;
        return [];
      },
      async *stream(ids, signal) {
        streams.push(ids);
        for (const b of batches(ids)) yield b;
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    return { src, streams, polls: () => latest };
  }

  it("follows the stream, resubscribes when the feeds change, and stops at once", async () => {
    const { src, streams } = source((ids) => [ids.map((f) => pr(f, 100 + streams.length))]);
    const svc = new PriceService(src, { logger: null });
    const done = svc.run();
    const first = await svc.nextPrints();
    expect(first).toEqual(new Set(["0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"]));
    svc.watchMarkets([market([F1])]);
    expect(await svc.nextPrints()).toEqual(new Set([F1, ...first]));
    expect(streams).toHaveLength(2);
    expect(streams[1]).toContain(F1);
    expect(svc.healthy).toBe(true);
    svc.stop();
    await done; // without waiting for another print
  });

  it("keeps only the watched feeds' prints from the stream", async () => {
    const strangers = Array.from({ length: 1_000 }, (_, i) => `0x${(i + 0x1000).toString(16).padStart(64, "0")}` as Hex);
    const { src } = source((ids) => [[...ids.map((f) => pr(f, 100)), ...strangers.map((f) => pr(f, 100))]]);
    const svc = new PriceService(src, { logger: null });
    svc.watch([F1]);
    const done = svc.run();
    expect(await svc.nextPrints()).toEqual(new Set([F1, "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"]));
    expect(svc.latest.size).toBe(2);
    svc.stop();
    await done;
  });

  it("reports, once each, the watched feeds a poll brings no print for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const src: PriceSource = {
      async latest(ids) {
        return ids.filter((f) => f !== F3).map((f) => pr(f, 100));
      },
      async *stream() {},
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { stream: false, logger: { warn } });
    svc.watch([F1, F3]);
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(3_500); // four polls
    expect(warn.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(new RegExp(`^price endpoint sent no print for feed ${F3}: `))]);
    expect(svc.missing()).toEqual([F3]);
    expect(svc.latest.has(F1)).toBe(true); // the other feeds are unaffected
    svc.stop();
    await done;
  });

  it("reconnects a stream that goes quiet through the backoff path, with a warning", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const signals: AbortSignal[] = [];
      const { fetch } = fakeFetch((_, init) => {
        signals.push(init.signal!);
        const t = 100 + signals.length;
        return sse([`data:${JSON.stringify(body(blob([F1], t), [F1], t))}\n\n`], init); // one event, then silence
      });
      const warn = vi.fn();
      const svc = new PriceService(new HermesClient("http://hermes.test", null, null, { fetch }), {
        streamIdleTimeout: 0.2,
        logger: { warn },
      });
      expect(new PriceService(null).streamIdleTimeout).toBe(10);
      svc.watch([F1]);
      const done = svc.run();
      expect(await svc.nextPrints()).toEqual(new Set([F1]));
      // the second connection's print: after 0.2 s of silence and the first failure's 1 s backoff
      expect(await svc.nextPrints()).toEqual(new Set([F1]));
      expect(svc.latest.get(F1)!.publishTime).toBe(102);
      expect(signals).toHaveLength(2);
      expect(signals[0]!.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith("price endpoint: price stream went quiet: no data for 0.2 s");
      expect(svc.lastError).toBe("price stream went quiet: no data for 0.2 s");
      expect(svc.healthy).toBe(true); // one failure, then prints again
      svc.stop();
      await done;
      expect(signals[1]!.aborted).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("falls back to polling after three failures in a row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let attempts = 0;
    const polls = { n: 0 };
    const src: PriceSource = {
      async latest() {
        polls.n++;
        return [];
      },
      async *stream() {
        attempts++;
        throw new HermesError("price stream refused (HTTP 502)");
      },
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { logger: { warn } });
    svc.healthy = true;
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 10); // backoff after the first and the second failure
    expect(attempts).toBe(3);
    expect(svc.healthy).toBe(false);
    expect(svc.lastError).toBe("price stream refused (HTTP 502)");
    expect(warn).toHaveBeenCalledWith("price endpoint: price stream refused (HTTP 502)");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(polls.n).toBe(1);
    expect(attempts).toBe(3);
    svc.stop();
    await done;
  });
});

describe("labels", () => {
  it("names feeds and markets from Pyth symbols", () => {
    expect(feedLabel("Crypto.BTC/USD")).toBe("BTC/USD");
    expect(feedLabel("Equity.US.AAPL/USD")).toBe("AAPL/USD");
    expect(marketLabel("Equity.JP.7203/JPY", "FX.USD/JPY")).toBe("7203/USD");
    expect(marketLabel("Crypto.ETH/USD", null)).toBe("ETH/USD");
    expect(marketLabel(null, null)).toBe("");
  });
});
