import { type Hex, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectError } from "../src/client/context.js";
import { type MarketInfo, listMarkets } from "../src/client/markets.js";
import { LivePrices, type MarketPrice, isProPriceSource, livePrices, proPriceSource, updateFromPrints } from "../src/client/prices.js";
import { pairPrice } from "../src/formulas/index.js";
import { NoLivePriceError, type Print, ProClient, ProError, printsOf } from "../src/prices/index.js";
import type { PriceSource } from "../src/prices/index.js";
import { readUpdate } from "../src/prices/lazer.js";
import { FACTORY, FakeTransport, contextFor } from "./client-reads-fakes.js";
import { FakePro, SIGNER, type FeedSpec, evm, fakeFetch, fid, json, signed, unsigned } from "./pro-fakes.js";

const [F1, F2, F3] = [fid(1), fid(2), fid(3)];

/** The prints of one update carrying `feeds`, stamped at second `at`, as a client returns them. */
function update(feeds: FeedSpec[], at = 100, extraUs = 0n): Print[] {
  const blob = unsigned({ at, extraUs, feeds });
  return printsOf(readUpdate(blob), blob, null, 0);
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
    legFeeds: legs.map(() => null),
    index: 0,
  };
}

describe("proPriceSource", () => {
  it("latest: one request for exactly the asked feeds, one update, the oldest generation second", async () => {
    const pro = new FakePro();
    pro.now = 101;
    pro.set(1, 200_000_000_000n).set(2, 5n, { generated: 99 }).set(3, 7n, { generated: 100 });
    const src = proPriceSource(pro.client());
    const r = await src.latest([F3.toUpperCase().replace("0X", "0x") as Hex, F1, F3]);
    expect(pro.requests).toHaveLength(1);
    expect(pro.requests[0]).toMatchObject({ path: "/v1/latest_price", body: { priceFeedIds: [1, 3] } });
    expect(r.publishTime).toBe(100);
    expect(r.update).toHaveLength(1); // both feeds in one signed update
    expect(readUpdate(r.update[0]!).feeds.map((f) => f.id)).toEqual([1, 3]);
    await expect(src.latest([])).rejects.toBeInstanceOf(ProError);
    expect(isProPriceSource(src)).toBe(true);
    expect(isProPriceSource({ latest: src.latest })).toBe(false);
    expect((await src.prints([F2])).map((p) => [p.feedId, p.publishTime])).toEqual([[F2, 99]]);
    expect(await src.prints([])).toEqual([]);
  });

  it("latest: refuses when the endpoint has no live price for a feed", async () => {
    const pro = new FakePro().set(1, 1n);
    await expect(proPriceSource(pro.client()).latest([F1, F2])).rejects.toThrow(new ProError("the price endpoint has no live price for feed 2: the update does not carry it"));
    await expect(proPriceSource(pro.client()).latest([F1, F2])).rejects.toBeInstanceOf(NoLivePriceError);
    // a feed with no price yet is in the update, without a print
    pro.set(2, 0n);
    await expect(proPriceSource(pro.client()).latest([F1, F2])).rejects.toThrow("no live price for feed 2: Pyth has no price for it at the update's time");
    // a price without a confidence is never handed to a call: the oracle refuses it, and nothing stands in for it
    pro.set(2, 5n, { conf: 0n });
    await expect(proPriceSource(pro.client()).latest([F1, F2])).rejects.toThrow("no live price for feed 2: Pyth reports no confidence for it, and the oracle refuses a live price without one");
    pro.set(2, 5n, { expo: 80 });
    await expect(proPriceSource(pro.client()).latest([F2])).rejects.toThrow("no live price for feed 2: at exponent 80 its price is not above zero (or overflows) at the oracle's 18 decimals");
    // a source that is not a ProClient can only say which feed
    const bare = { latest: async () => [] };
    await expect(new LivePrices([], { ...bare, async *stream() {} }, { start: false }).latest([F1])).rejects.toThrow(new ProError("the price endpoint has no live price for feed 1"));
  });

  it("latest: asks once when the endpoint sends no update", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const e = await proPriceSource(new ProClient({ fetch })).latest([F1]).catch((x) => x);
    expect(e).toBeInstanceOf(NoLivePriceError);
    expect((e as Error).message).toBe("the price endpoint has no live price for feed 1: it sent no update");
    expect(calls).toHaveLength(1);
  });

  it("atTick: the one-second update for a past second, or null when there is none", async () => {
    const pro = new FakePro();
    pro.now = 2_000;
    pro.generate(1, 1_000, 5n).generate(2, 990, 6n);
    const src = proPriceSource(pro.client());
    const u = (await src.atTick([F2, F1, F1], 1_005))!;
    expect(pro.requests[0]).toMatchObject({ path: "/v1/price", body: { priceFeedIds: [1, 2], channel: "fixed_rate@1000ms", timestamp: 1_005_000_000 } });
    expect([u.channel, u.timestampUs]).toEqual([4, 1_005_000_000n]);
    expect([...u.feeds.entries()].map(([id, f]) => [id, f.price, f.feedUpdateTimestamp])).toEqual([
      [F1, 5n, 1_000_000_000n],
      [F2, 6n, 990_000_000n],
    ]);
    expect(await src.atTick([F1], 2_001)).toBeNull(); // not there yet
    pro.missing.add(1_500);
    expect(await src.atTick([F1], 1_500)).toBeNull();
  });

  it("takes the context's signer check unless the client has its own", async () => {
    const good = await signed({ at: 100, feeds: [{ id: 1 }] });
    const { fetch } = fakeFetch(() => json(evm(good)));
    const src = proPriceSource({ fetch });
    expect(src.client.isTrustedSigner).toBeNull();
    const refuse = vi.fn(() => false);
    src.useSignerCheck(refuse);
    await expect(src.latest([F1])).rejects.toThrow("not a signer Pyth's verifier trusts");
    expect(refuse).toHaveBeenCalledWith(SIGNER);
    // a client given its own check keeps it
    const own = proPriceSource({ fetch, isTrustedSigner: () => true });
    own.useSignerCheck(refuse);
    expect((await own.latest([F1])).update).toEqual([good]);
  });

  it("updateFromPrints lists each update once, in the prints' order", () => {
    const both = update([{ id: 1 }, { id: 2 }]);
    const own: Print = { ...both[0]!, feedId: F3, blob: "0xaabb" };
    expect(updateFromPrints([both[1]!, own, both[0]!])).toEqual([both[0]!.blob, "0xaabb"]);
    expect(updateFromPrints([])).toEqual([]);
  });
});

/** A source whose stream never yields until aborted, and whose latest serves the given prints. */
function source(latest: () => Print[]) {
  const asked: Hex[][] = [];
  const sets: (readonly (readonly Hex[])[])[] = [];
  const s: PriceSource = {
    async latest(ids) {
      asked.push([...ids]);
      return latest().filter((p) => ids.includes(p.feedId));
    },
    async *stream(streamed, signal) {
      sets.push(streamed);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  return { s, asked, sets };
}

describe("LivePrices", () => {
  afterEach(() => vi.useRealTimers());

  it("composes each market's price and reports freshness and confidence from memory", async () => {
    let now = 101;
    const m1 = info("a1", [F1]);
    const m2 = info("a2", [F2, F3]);
    const p1s = update([{ id: 1 }]);
    const p2s = update([{ id: 2, price: 50_000_000_000n, conf: 10_000_000n }, { id: 3, price: 125_000_000n, conf: 10_000n, generated: 99 }]);
    const { s } = source(() => []);
    const live = new LivePrices([m1, m2], s, { clock: () => now, start: false, logger: null });
    expect(live.price(m1)).toBeNull();
    live.service.ingest([...p1s, ...p2s]);
    const p1 = live.price(m1.address)!;
    expect(p1).toMatchObject({ spot: 2_000n * 10n ** 18n, publishTime: 100, age: 1, fresh: true, venueClosed: false, confidenceOk: true });
    expect(p1.confidence).toBe(10n ** 13n); // 1000e-8
    const p2 = live.price(m2)!;
    const expected = pairPrice(p2s, false)!;
    expect([p2.spot, p2.low, p2.high, p2.publishTime]).toEqual([expected.spot, expected.low, expected.high, 99]);
    expect(p2.spot).toBe(625n * 10n ** 18n); // 500 x 1.25
    expect(p2.confidenceBp).toBeCloseTo((Number(expected.high - expected.spot) / Number(expected.spot)) * 10_000, 6);
    expect(live.fresh(m2)).toBe(true);
    now = 103; // the older leg's price was generated 4 s ago: outside the pair's 3 s window
    expect(live.price(m2)!.fresh).toBe(false);
    expect(live.price(m1)!.fresh).toBe(true);
    expect(live.all().size).toBe(2);
    // the composite's call carries the one update that holds both its legs
    expect(live.updateFor(m2)).toEqual({ update: [p2s[0]!.blob], publishTime: 99 });
    live.stop();
  });

  it("marks a trading-hours market closed when its feed generates no price while the endpoint delivers", () => {
    let now = 100;
    const equity = info("b1", [F2], false);
    const crypto = info("b2", [F1], true);
    const { s } = source(() => []);
    const live = new LivePrices([equity, crypto], s, { clock: () => now, start: false, logger: null });
    live.service.ingest([...update([{ id: 1 }]), ...update([{ id: 2 }])]);
    expect(live.venueClosed(equity)).toBe(false);
    now = 120;
    // crypto keeps printing; the equity's updates keep coming too, carrying the price from second 100
    live.service.ingest([...update([{ id: 1 }], 120), ...update([{ id: 2, generated: 100 }], 120)]);
    expect(live.venueClosed(equity)).toBe(true);
    expect(live.price(equity)!).toMatchObject({ venueClosed: true, fresh: false, publishTime: 100, age: 20 });
    expect(live.venueClosed(crypto)).toBe(false); // a 24/7 market is never "closed"
    live.stop();
  });

  it("notifies subscribers of the markets whose price changed, and of flags that flip as time passes", async () => {
    let now = 100;
    const m1 = info("c1", [F1]);
    const m2 = info("c2", [F2]);
    const { s } = source(() => [...update([{ id: 1 }]), ...update([{ id: 2 }])]);
    const live = new LivePrices([m1, m2], s, { clock: () => now, tickMs: 5, logger: null });
    await live.ready;
    const all: string[][] = [];
    const only2: MarketPrice[] = [];
    live.subscribe((changed) => all.push([...changed.keys()]));
    const off = live.subscribe((changed) => only2.push(...changed.values()), [m2.address]);
    live.service.ingest(update([{ id: 1 }], 101));
    expect(all).toEqual([[m1.address]]);
    expect(only2).toEqual([]);
    live.service.ingest(update([{ id: 2 }], 101));
    expect(only2.map((p) => p.publishTime)).toEqual([101]);
    // Time passes with no new price: m2 leaves the 3 s window, and the ticker says so.
    now = 105;
    await vi.waitFor(() => expect(only2.length).toBe(2));
    expect(only2[1]!.fresh).toBe(false);
    off();
    live.service.ingest(update([{ id: 2 }], 106));
    expect(only2.length).toBe(2);
    live.stop();
  });

  it("is a price update source that reuses the stream's update for a market and asks the endpoint otherwise", async () => {
    let now = 100;
    let served = update([{ id: 1 }, { id: 2 }]);
    const { s, asked } = source(() => served);
    const live = new LivePrices([info("d1", [F1, F2])], s, { clock: () => now, start: false, logger: null, reuseAge: 1 });
    live.service.ingest(served);
    const r = await live.latest([F2, F1]);
    expect(asked).toEqual([]); // from the stream
    expect(r).toEqual({ update: [served[0]!.blob], publishTime: 100 }); // one update holding both legs
    now = 102;
    served = update([{ id: 1 }, { id: 2 }], 102);
    const r2 = await live.latest([F1, F2]);
    expect(asked).toEqual([[F1, F2]]);
    expect(r2).toEqual({ update: [served[0]!.blob], publishTime: 102 });
    expect(live.service.latest.get(F1)!.publishTime).toBe(102); // what was fetched refreshed the display
    await expect(live.atTick([F1], 1)).rejects.toThrow("this price source serves no past updates");
    await expect(live.latest([])).rejects.toThrow("no price feeds were asked for");
    live.stop();
  });

  it("serves past updates and takes a signer check when its source is a Pyth Pro client", async () => {
    const pro = new FakePro();
    pro.now = 500;
    pro.generate(1, 100, 9n);
    const client = pro.client();
    const live = new LivePrices([info("d2", [F1])], client, { clock: () => 500, start: false, logger: null });
    expect((await live.atTick([F1], 200))!.feeds.get(F1)).toMatchObject({ price: 9n, feedUpdateTimestamp: 100_000_000n });
    const check = () => true;
    live.useSignerCheck(check);
    expect(client.isTrustedSigner).toBe(check);
    live.stop();
  });

  it("seeds every leg's latest print before streaming, then streams each market as its own set", async () => {
    const { s, asked, sets } = source(() => [...update([{ id: 1 }]), ...update([{ id: 2 }, { id: 3 }])]);
    const live = new LivePrices([info("e1", [F1])], s, { clock: () => 100, logger: null, tickMs: 0 });
    await live.ready;
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain(F1);
    expect(live.price(info("e1", [F1]).address)?.spot).toBe(2_000n * 10n ** 18n);
    live.add([info("e2", [F2, F3])]);
    await live.ready;
    expect(asked[1]).toEqual([F2, F3]);
    await vi.waitFor(() => expect(sets.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(sets[sets.length - 1]).toEqual([[fid(2)], [F1], [F2, F3]])); // ETH/USD for gas, then one set per market
    live.stop();
  });
});

describe("livePrices", () => {
  it("uses the context's Pyth Pro client, or a given one, and refuses without either", async () => {
    const t = new FakeTransport();
    const client = new FakePro().client();
    const ctx = contextFor(t, { prices: proPriceSource(client) });
    const m = info("f1", [F1]);
    const live = await livePrices([m], { client, start: false });
    expect(live.service.client).toBe(client);
    live.stop();
    await expect(livePrices([m])).rejects.toBeInstanceOf(ConnectError);
    await expect(livePrices([m])).rejects.toThrow("live prices need a Pyth Pro source");
    const own = await livePrices([m], { pro: { token: "t0ken", restUrl: "https://pro.test" }, start: false });
    expect(own.service.client).toBeInstanceOf(ProClient);
    expect((own.service.client as ProClient).restUrl).toBe("https://pro.test");
    own.stop();
    // With a context, its markets come from listMarkets.
    t.answer(FACTORY, "getAllPairs", []);
    await listMarkets(ctx, { metadata: null });
    const fromCtx = await livePrices(ctx, { start: false });
    expect(fromCtx.service.client).toBe(client);
    expect(fromCtx.markets()).toEqual([]);
    fromCtx.stop();
  });
});

describe("livePrices and signer checks", () => {
  it("gives a client without a signer check the deployment's, with a context that checks signers", async () => {
    const t = new FakeTransport();
    t.answer(FACTORY, "getAllPairs", []);
    const ctx = contextFor(t);
    const own = await livePrices(ctx, { pro: { restUrl: "https://pro.test" }, start: false });
    expect((own.service.client as ProClient).isTrustedSigner).toBeTypeOf("function");
    own.stop();
    const given = new ProClient({ restUrl: "https://pro.test" });
    (await livePrices(ctx, { client: given, start: false })).stop();
    expect(given.isTrustedSigner).toBeTypeOf("function");
    // a check of its own is kept, and a context that does not check signers installs none
    const kept = () => true;
    const mine = new ProClient({ isTrustedSigner: kept });
    (await livePrices(ctx, { client: mine, start: false })).stop();
    expect(mine.isTrustedSigner).toBe(kept);
    const off = await livePrices({ ...ctx, checkSigners: false }, { pro: {}, start: false });
    expect((off.service.client as ProClient).isTrustedSigner).toBeNull();
    off.stop();
  });
});
