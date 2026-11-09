import { type Hex, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectError } from "../src/client/context.js";
import { type MarketInfo, listMarkets } from "../src/client/markets.js";
import { LivePrices, type MarketPrice, hermesPriceSource, isHermesPriceSource, livePrices, updateFromPrints } from "../src/client/prices.js";
import { pairPrice } from "../src/formulas/index.js";
import { HermesClient, HermesError, type Print, accumulator, parseResponse } from "../src/prices/index.js";
import type { HermesUpdates, PriceSource } from "../src/prices/index.js";
import { FACTORY, FakeTransport, contextFor } from "./client-reads-fakes.js";

const feed = (i: number): Hex => `0x${i.toString(16).padStart(2, "0").repeat(32)}`;
const [F1, F2, F3] = [feed(1), feed(2), feed(3)];
const VAA = `01${"00".repeat(40)}`;

/**
 * An accumulator update carrying `feeds`, each at `publish` (or its own time) and its `prices` entry
 * (price, conf) if any. Prints are read from these signed messages, so `body` writes the same values.
 */
function blob(feeds: Hex[], publish: number | number[] = 100, prices: Record<string, [string, string]> = {}): Hex {
  const prefix: Hex = `0x504e4155${"01000000"}${(VAA.length / 2).toString(16).padStart(4, "0")}${VAA}`;
  const msgs = feeds.map((f, i): [Hex, Hex[]] => {
    const t = Array.isArray(publish) ? publish[i]! : publish;
    const [price, conf] = prices[f] ?? ["200000000000", "1000"];
    const m = { feedId: f, price: BigInt(price), conf: BigInt(conf), expo: -8, publishTime: t, prevPublishTime: t - 7, emaPrice: 200_000_000_000n, emaConf: 1_000n };
    const node: Hex = `0x${i.toString(16).padStart(2, "0").repeat(20)}`;
    return [accumulator.encodePriceMessage(m), [node]];
  });
  return accumulator.build(prefix, msgs);
}

function body(feeds: Hex[], publish: number | number[] = 100, prices: Record<string, [string, string]> = {}): HermesUpdates {
  return {
    binary: { data: [blob(feeds, publish, prices).slice(2)] },
    parsed: feeds.map((f, i) => ({
      id: f.slice(2),
      price: {
        price: prices[f]?.[0] ?? "200000000000",
        conf: prices[f]?.[1] ?? "1000",
        expo: -8,
        publish_time: Array.isArray(publish) ? publish[i]! : publish,
      },
      metadata: { prev_publish_time: (Array.isArray(publish) ? publish[i]! : publish) - 7 },
    })),
  };
}

/** A fetch that serves Hermes routes from a table of path -> (ids) => [status, body]. */
function fakeFetch(routes: Record<string, (ids: string[]) => [number, unknown]>) {
  const urls: string[] = [];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    const ids = url.searchParams.getAll("ids[]");
    for (const [path, route] of Object.entries(routes)) {
      if (url.pathname.endsWith(path)) {
        const [status, b] = route(ids);
        return new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fn as typeof fetch, urls };
}

function info(address: string, legs: Hex[], continuous = true): MarketInfo {
  return {
    address: getAddress(`0x${address.repeat(20)}`),
    pairId: legs[0]!,
    baseFeedId: legs[0]!,
    legs,
    invertQuote: false,
    continuous,
    description: "",
    label: "",
    hours: continuous ? "24/7" : "trading-hours",
    composite: legs.length === 2,
    legSymbols: legs.map(() => ""),
    index: 0,
  } as MarketInfo;
}

describe("hermesPriceSource", () => {
  it("latest: one request, an update cut to exactly the asked feeds, the oldest publish time", async () => {
    const { fetch, urls } = fakeFetch({ "/v2/updates/price/latest": () => [200, body([F1, F2, F3], [101, 99, 100])] });
    const src = hermesPriceSource("https://hermes.example/", { apiKey: "k", fetch });
    const r = await src.latest([F3.toUpperCase().replace("0X", "0x") as Hex, F1, F3]);
    expect(urls).toHaveLength(1);
    expect(new URL(`https://x${urls[0]}`).searchParams.getAll("ids[]")).toEqual([F3, F1]);
    expect(r.publishTime).toBe(100);
    expect(r.update).toHaveLength(1);
    expect(accumulator.parse(r.update[0]!).feedIds()).toEqual([F1, F3]); // the blob's order
    await expect(src.latest([])).rejects.toBeInstanceOf(HermesError);
    expect(isHermesPriceSource(src)).toBe(true);
    expect(isHermesPriceSource({ latest: src.latest })).toBe(false);
  });

  it("latest: refuses when the endpoint has no price for a feed", async () => {
    const { fetch } = fakeFetch({ "/v2/updates/price/latest": () => [200, body([F1])] });
    await expect(hermesPriceSource("https://h", { fetch }).latest([F1, F2])).rejects.toThrow(/no price for feed 0x02020202/);
  });

  it("atOrAfter: one entry per feed, each its own one-update payload with the signed predecessor time", async () => {
    const seen: string[] = [];
    const { fetch } = fakeFetch({
      "/v2/updates/price/1700000000": (ids) => {
        seen.push(...ids);
        return [200, body([F1, F2], [1_700_000_001, 1_700_000_002])];
      },
    });
    const src = hermesPriceSource("https://h", { fetch });
    const r = await src.atOrAfter(1_700_000_000.7, [F1, F2, F3]);
    expect(seen).toEqual([F1, F2, F3]);
    expect(r.map((x) => [x.publishTime, x.prevPublishTime, x.update.length])).toEqual([
      [1_700_000_001, 1_699_999_994, 1],
      [1_700_000_002, 1_699_999_995, 1],
      [0, null, 0], // the archive had nothing for F3
    ]);
    expect(accumulator.parse(r[1]!.update[0]!).feedIds()).toEqual([F2]);
  });

  it("atOrAfter: a 404 means no print yet, other errors are thrown", async () => {
    const { fetch } = fakeFetch({ "/v2/updates/price/5": () => [500, "boom"] });
    const src = hermesPriceSource("https://h", { fetch });
    expect(await src.atOrAfter(7, [F1])).toEqual([{ update: [], publishTime: 0, prevPublishTime: null }]);
    await expect(src.atOrAfter(5, [F1])).rejects.toThrow("HTTP 500");
  });

  it("updateFromPrints keeps a single feed's own blob and groups an accumulator's feeds", () => {
    const acc = parseResponse(body([F1, F2]));
    const own: Print = { ...acc[0]!, feedId: F3, blob: "0xaabb" };
    const upd = updateFromPrints([acc[1]!, own, acc[0]!]);
    expect(upd).toHaveLength(2);
    expect(accumulator.parse(upd[0]!).feedIds()).toEqual([F1, F2]);
    expect(upd[1]).toBe("0xaabb");
  });
});

/** A source whose stream never yields until aborted, and whose latest serves the given prints. */
function source(latest: () => Print[]) {
  const asked: Hex[][] = [];
  const s: PriceSource = {
    async latest(ids) {
      asked.push([...ids]);
      return latest().filter((p) => ids.includes(p.feedId));
    },
    async *stream(_ids, signal) {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  return { s, asked };
}

describe("LivePrices", () => {
  afterEach(() => vi.useRealTimers());

  it("composes each market's price and reports freshness and confidence from memory", async () => {
    let now = 101;
    const m1 = info("a1", [F1]);
    const m2 = info("a2", [F2, F3]);
    const prints = parseResponse(body([F1, F2, F3], [100, 100, 99], { [F2]: ["50000000000", "10000000"], [F3]: ["125000000", "10000"] }));
    const { s } = source(() => prints);
    const live = new LivePrices([m1, m2], s, { clock: () => now, start: false, logger: null });
    expect(live.price(m1)).toBeNull();
    live.service.ingest(prints);
    const p1 = live.price(m1.address)!;
    expect(p1).toMatchObject({ spot: 2_000n * 10n ** 18n, publishTime: 100, age: 1, fresh: true, venueClosed: false, confidenceOk: true });
    expect(p1.confidence).toBe(10n ** 13n); // 1000e-8
    const p2 = live.price(m2)!;
    const expected = pairPrice(prints.slice(1), false)!;
    expect([p2.spot, p2.low, p2.high, p2.publishTime]).toEqual([expected.spot, expected.low, expected.high, 99]);
    expect(p2.spot).toBe(625n * 10n ** 18n); // 500 x 1.25
    expect(p2.confidenceBp).toBeCloseTo(((Number(expected.high - expected.spot) / Number(expected.spot)) * 10_000), 6);
    expect(live.fresh(m2)).toBe(true);
    now = 103; // the older leg is 4 s old: outside the pair's 3 s window
    expect(live.price(m2)!.fresh).toBe(false);
    expect(live.price(m1)!.fresh).toBe(true);
    expect(live.all().size).toBe(2);
    expect(live.updateFor(m2)!.publishTime).toBe(99);
    expect(accumulator.parse(live.updateFor(m2)!.update[0]!).feedIds()).toEqual([F2, F3]);
    live.stop();
  });

  it("marks a trading-hours market closed when its feed stops while others print", () => {
    let now = 100;
    const equity = info("b1", [F2], false);
    const crypto = info("b2", [F1], true);
    const { s } = source(() => []);
    const live = new LivePrices([equity, crypto], s, { clock: () => now, start: false, logger: null });
    live.service.ingest(parseResponse(body([F1, F2], 100)));
    expect(live.venueClosed(equity)).toBe(false);
    now = 120;
    live.service.ingest(parseResponse(body([F1], 120))); // crypto keeps printing, the equity feed stopped
    expect(live.venueClosed(equity)).toBe(true);
    expect(live.price(equity)!.venueClosed).toBe(true);
    expect(live.venueClosed(crypto)).toBe(false); // a 24/7 market is never "closed"
    live.stop();
  });

  it("notifies subscribers of the markets whose price changed, and of flags that flip as time passes", async () => {
    let now = 100;
    const m1 = info("c1", [F1]);
    const m2 = info("c2", [F2]);
    const { s } = source(() => parseResponse(body([F1, F2], 100)));
    const live = new LivePrices([m1, m2], s, { clock: () => now, tickMs: 5, logger: null });
    await live.ready;
    const all: string[][] = [];
    const only2: MarketPrice[] = [];
    live.subscribe((changed) => all.push([...changed.keys()]));
    const off = live.subscribe((changed) => only2.push(...changed.values()), [m2.address]);
    live.service.ingest(parseResponse(body([F1], 101)));
    expect(all).toEqual([[m1.address]]);
    expect(only2).toEqual([]);
    live.service.ingest(parseResponse(body([F2], 101)));
    expect(only2.map((p) => p.publishTime)).toEqual([101]);
    // Time passes with no print: m2 leaves the 3 s window, and the ticker says so.
    now = 105;
    await vi.waitFor(() => expect(only2.length).toBe(2));
    expect(only2[1]!.fresh).toBe(false);
    off();
    live.service.ingest(parseResponse(body([F2], 106)));
    expect(only2.length).toBe(2);
    live.stop();
  });

  it("is a price update source that reuses fresh stream prints and asks the endpoint otherwise", async () => {
    let now = 100;
    let served = parseResponse(body([F1, F2], 100));
    const { s, asked } = source(() => served);
    const live = new LivePrices([info("d1", [F1, F2])], s, { clock: () => now, start: false, logger: null, reuseAge: 1 });
    live.service.ingest(served);
    const r = await live.latest([F2, F1]);
    expect(asked).toEqual([]); // from the stream
    expect(r.publishTime).toBe(100);
    expect(accumulator.parse(r.update[0]!).feedIds()).toEqual([F1, F2]);
    now = 102;
    served = parseResponse(body([F1, F2], 102));
    const r2 = await live.latest([F1, F2]);
    expect(asked).toEqual([[F1, F2]]);
    expect(r2.publishTime).toBe(102);
    expect(live.service.latest.get(F1)!.publishTime).toBe(102); // what was fetched refreshed the display
    await expect(live.atOrAfter(1, [F1])).rejects.toThrow("no historical prints");
    live.stop();
  });

  it("seeds every leg's latest print before streaming", async () => {
    const { s, asked } = source(() => parseResponse(body([F1], 100)));
    const live = new LivePrices([info("e1", [F1])], s, { clock: () => 100, logger: null, tickMs: 0 });
    await live.ready;
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain(F1);
    expect(live.price(info("e1", [F1]).address)?.spot).toBe(2_000n * 10n ** 18n);
    live.add([info("e2", [F2])]);
    await live.ready;
    expect(asked[1]).toEqual([F2]);
    live.stop();
  });
});

describe("livePrices", () => {
  it("uses the context's Hermes client, or a given one, and refuses without either", async () => {
    const t = new FakeTransport();
    const { fetch } = fakeFetch({ "/v2/updates/price/latest": () => [200, body([F1], 100)] });
    const client = new HermesClient("https://h", null, null, { fetch });
    const ctx = contextFor(t, { prices: hermesPriceSource(client) });
    const m = info("f1", [F1]);
    const live = await livePrices([m], { client, start: false });
    expect(live.service.client).toBe(client);
    live.stop();
    await expect(livePrices([m])).rejects.toBeInstanceOf(ConnectError);
    // With a context, its markets come from listMarkets.
    t.answer(FACTORY, "getAllPairs", []);
    await listMarkets(ctx, { metadata: null });
    const fromCtx = await livePrices(ctx, { start: false });
    expect(fromCtx.service.client).toBe(client);
    expect(fromCtx.markets()).toEqual([]);
    fromCtx.stop();
  });
});
