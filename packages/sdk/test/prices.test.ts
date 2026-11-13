import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ETH_USD_FEED, MAX_LIQUIDATION_PRICE_AGE } from "../src/constants.js";
import { pairPrice } from "../src/formulas/index.js";
import type { Market } from "../src/models.js";
import {
  MAX_LATEST_PRICE_LAG,
  PriceService,
  type Print,
  ProClient,
  ProError,
  distinctBlobs,
  feedLabel,
  fetchFeedInfo,
  fetchSymbols,
  marketLabel,
  printsOf,
  readLatestPrice,
} from "../src/prices/index.js";
import type { PriceSource, ProSymbol } from "../src/prices/index.js";
import { readUpdate } from "../src/prices/lazer.js";
import { type FeedSpec, FakeSocket, SIGNER, US, fid, print as pr, settle, signed, streamUpdated, unsigned } from "./pro-fakes.js";

const [F1, F3, F4, F5] = [fid(1), fid(3), fid(4), fid(5)];

function market(legs: Hex[], address: Hex = `0x${"aa".repeat(20)}`, invertQuote = false): Market {
  return { address, pairId: legs[0]!, baseFeedId: legs[0]!, legs, invertQuote, continuous: true, description: "", label: "", state: null, dirty: false, lastRead: 0 };
}

/** The prints of one update carrying `ids`, generated in second `at` (plus `extraUs`), as a client would return them. */
function update(ids: number[], at: number, opts: { extraUs?: bigint; generated?: Record<number, number>; price?: bigint } = {}): Print[] {
  const blob = unsigned({ at, extraUs: opts.extraUs, feeds: ids.map((id) => ({ id, price: opts.price, generated: opts.generated?.[id] })) });
  return printsOf(readUpdate(blob), blob, null, 0);
}

describe("PriceService", () => {
  it("prices a market from the one update that carries its legs, judged on when each price was generated", () => {
    let now = 101;
    const svc = new PriceService(null, { clock: () => now });
    const single = market([F1]);
    const composite = market([F3, F4], `0x${"bb".repeat(20)}`);
    svc.watchMarkets([single, composite]);
    expect(svc.updateFor(composite)).toEqual([]);
    expect(svc.price(composite)).toBeNull();
    const both = update([3, 4], 100);
    const alone = update([1], 100);
    svc.ingest([...both, ...alone]);
    // both legs of the composite in one update: one blob, one verification fee
    expect(svc.updateFor(composite)).toEqual([both[0]!.blob]);
    expect(svc.updateFor(single)).toEqual([alone[0]!.blob]);
    expect(svc.legs(composite)!.map((p) => p.feedId)).toEqual([F3, F4]);
    expect(svc.price(composite)!.publishTime).toBe(100);
    expect(svc.fresh(composite)).toBe(true);
    now = 104;
    expect(svc.fresh(composite)).toBe(false); // generated 4 s ago: past the window, with the sending margin
    now = 102;
    expect(svc.fresh(composite) && !svc.fresh(composite, null, 2.5)).toBe(true);
    // callers get their own arrays
    svc.updateFor(composite).push("0xdead");
    expect(svc.updateFor(composite)).toEqual([both[0]!.blob]);
    expect(svc.price(composite)).toBe(svc.price(composite)); // computed once per update
  });

  it("treats a price carried forward under a later update as old as when it was generated", () => {
    const now = 10_000;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    const m = market([F1]);
    svc.watchMarkets([m]);
    // a closed market: the update is stamped now, its price was generated an hour ago
    const carried = update([1], now, { generated: { 1: now - 3_600 } });
    svc.ingest(carried);
    expect(svc.latest.get(F1)!.timestampUs).toBe(BigInt(now) * US);
    expect(svc.latest.get(F1)!.publishTime).toBe(now - 3_600);
    expect(svc.fresh(m)).toBe(false);
    expect(svc.closed(m)).toBe(true);
    // the same price under the next update changes nothing: no newer print, the same view
    const view = svc.price(m);
    const seen: Hex[][] = [];
    svc.onPrints((f) => seen.push([...f]));
    svc.ingest(update([1], now + 1, { generated: { 1: now - 3_600 } }));
    expect(seen).toEqual([]);
    expect(svc.price(m)).toBe(view);
    expect(svc.updateFor(m)).toEqual([carried[0]!.blob]);
    // the reopen: a price generated now
    svc.ingest(update([1], now, { extraUs: 400_000n }));
    expect(seen).toEqual([[F1]]);
    expect(svc.fresh(m)).toBe(true);
    expect(svc.closed(m)).toBe(false);
  });

  it("uses each leg's newest print only while the market's own update is missing or a second behind", () => {
    const svc = new PriceService(null, { clock: () => 100, logger: null });
    const m = market([F3, F4]);
    svc.watchMarkets([m]);
    svc.watch([F4]); // the FX leg is also watched on its own (another market shares it)
    // only the single-feed updates so far: one update per leg
    const b3 = update([3], 100);
    const b4 = update([4], 100);
    svc.ingest([...b3, ...b4]);
    expect(svc.updateFor(m)).toEqual([b3[0]!.blob, b4[0]!.blob]);
    // the set's own update arrives, a tick behind the newest prints: it is used, whole
    const own = update([3, 4], 100, { extraUs: 200_000n });
    svc.ingest(own);
    svc.ingest(update([4], 100, { extraUs: 400_000n }));
    expect(svc.latest.get(F4)!.generatedUs).toBe(100_400_000n);
    expect(svc.updateFor(m)).toEqual([own[0]!.blob]);
    expect(svc.legs(m)!.map((p) => p.generatedUs)).toEqual([100_200_000n, 100_200_000n]);
    // its subscription falls a whole second behind: the freshest print per leg again
    const late = update([4], 101, { extraUs: 200_000n });
    svc.ingest(late);
    expect(svc.updateFor(m)).toEqual([own[0]!.blob, late[0]!.blob]);
    expect(svc.legs(m)!.map((p) => p.generatedUs)).toEqual([100_200_000n, 101_200_000n]);
    // and back once its own update catches up
    const caught = update([3, 4], 101, { extraUs: 400_000n });
    svc.ingest(caught);
    expect(svc.updateFor(m)).toEqual([caught[0]!.blob]);
    // an older update of the set, arriving late, replaces nothing
    svc.ingest(update([3, 4], 101));
    expect(svc.updateFor(m)).toEqual([caught[0]!.blob]);
    // printsFor answers the same question for feeds given as they come
    expect(svc.printsFor([F4, F3])!.map((p) => [p.feedId, p.blob === caught[0]!.blob])).toEqual([
      [F4, true],
      [F3, true],
    ]);
    // the FX leg on its own keeps its own update too, though the composite's carries a newer price for it
    expect(svc.latest.get(F4)!.generatedUs).toBe(101_400_000n);
    expect(svc.printsFor([F4.toUpperCase().replace("0X", "0x") as Hex])!.map((p) => [p.generatedUs, p.blob === late[0]!.blob])).toEqual([[101_200_000n, true]]);
    expect(svc.printsFor([F5])).toBeNull();
    expect(svc.printsFor([])).toEqual([]);
    expect(distinctBlobs([...caught, ...late, ...caught])).toEqual([caught[0]!.blob, late[0]!.blob]);
  });

  it("keeps an update only for a watched set, and only when it holds a live print for each of its feeds", () => {
    const svc = new PriceService(null, { clock: () => 100, logger: null });
    const m = market([F3, F4]);
    svc.watchMarkets([m]);
    svc.ingest(update([3, 4], 100));
    // the next update has no price for one leg: its one print is taken for that feed, not for the set
    const half = unsigned({ at: 100, extraUs: 200_000n, feeds: [{ id: 3 }, { id: 4, price: 0n }] });
    svc.ingest(printsOf(readUpdate(half), half, null, 0));
    expect(svc.latest.get(F3)!.generatedUs).toBe(100_200_000n);
    expect(svc.legs(m)!.map((p) => p.generatedUs)).toEqual([100_000_000n, 100_000_000n]); // still the last whole update
    // a big update carrying every feed (a poll) is nobody's set: its prints land per feed
    const big = update([1, 3, 4, 5], 101);
    svc.ingest(big);
    expect(svc.updateFor(m)).toEqual([big[0]!.blob]); // a second ahead of the set's own: one blob still, the big one
    expect(svc.updateFor(market([F1]))).toEqual([big[0]!.blob]);
  });

  it("judges closed sessions and prices gas from ETH/USD", () => {
    const svc = new PriceService(null, { clock: () => 200 });
    expect(ETH_USD_FEED).toBe(fid(2));
    expect([...svc.feeds]).toEqual([ETH_USD_FEED]); // watched from the start, on its own
    expect(svc.closed(market([F1]))).toBe(false); // nothing delivered yet: unknown, not closed
    const [f1, f3] = [update([1], 199), update([3], 150)];
    svc.ingest([...f1, ...f3]);
    expect(svc.updateFor(market([F1, F3]))).toEqual([f1[0]!.blob, f3[0]!.blob]);
    expect(svc.closed(market([F1]))).toBe(false);
    expect(svc.closed(market([F1, F3]))).toBe(true);
    expect(svc.closed(market([F4]))).toBe(true); // no print at all while others arrive
    expect(svc.ethUsd()).toBeNull();
    svc.ingest([pr(ETH_USD_FEED, 200, { price: 312_345_678_901n })]);
    expect(svc.ethUsd()).toBeCloseTo(3123.45678901, 8);
  });

  it("ethUsd trusts only a recent print within sane bounds, so the caller falls back otherwise", () => {
    let now = 1_000;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    expect([svc.ethUsdMaxAge, svc.ethUsdBounds]).toEqual([60, [100, 1_000_000]]);
    svc.ingest([pr(ETH_USD_FEED, 1_000, { price: 300_000_000_000n })]);
    expect(svc.ethUsd()).toBe(3000);
    now = 1_060;
    expect(svc.ethUsd()).toBe(3000); // 60 s old: still trusted
    now = 1_061;
    expect(svc.ethUsd()).toBeNull(); // older: the stream stopped bringing ETH/USD
    expect(svc.ethUsd(1_030)).toBe(3000);
    // $0.0001 (every cost would book as ~$0), $10,000,000, and conversions that overflow to Infinity or 0
    for (const [price, expo] of [[1n, -4], [10_000_000_000_000n, -6], [1n, 400], [1n, -400]] as const) {
      now += 10;
      svc.ingest([pr(ETH_USD_FEED, now, { price, expo })]);
      expect(svc.latest.get(ETH_USD_FEED)!.price).toBe(price);
      expect(svc.ethUsd()).toBeNull();
    }
    const custom = new PriceService(null, { clock: () => 10, ethUsdMaxAge: 5, ethUsdBounds: [1, 10], logger: null });
    custom.ingest([pr(ETH_USD_FEED, 10, { price: 5n, expo: 0 })]);
    expect(custom.ethUsd()).toBe(5);
    expect(custom.ethUsd(16)).toBeNull();
  });

  it("ethUsd prices gas only from a print whose signer is confirmed: one a stream took unchecked is checked first", async () => {
    const client = new ProClient({ restUrl: "https://pro.test", streamUrls: ["wss://pro-0.test/v1/stream"], isTrustedSigner: (s) => s === SIGNER });
    const notices: string[] = [];
    const svc = new PriceService(client, { clock: () => 1_000, logger: { warn: (m) => notices.push(m) } });
    // Prints as a stream takes them between sampled checks: no signer.
    const unchecked = async (at: number, price: bigint, key?: Hex) => {
      const blob = await signed({ at, feeds: [{ id: 2, price }] }, key);
      return printsOf(readUpdate(blob), blob, null);
    };
    svc.ingest(await unchecked(1_000, 30_000_000_000_000n, `0x${"11".repeat(32)}`)); // $300,000, signed by another key
    await settle();
    expect(svc.latest.get(ETH_USD_FEED)!.price).toBe(30_000_000_000_000n);
    expect(svc.ethUsd()).toBeNull();
    expect(notices).toContainEqual(expect.stringMatching(/^an ETH\/USD print was not used to price gas: .*not a signer Pyth's verifier trusts/));
    svc.ingest(await unchecked(1_001, 300_000_000_000n));
    await vi.waitFor(() => expect(svc.ethUsd()).toBe(3000));
  });

  it("ignores a print dated in the future instead of letting it hold the feed", () => {
    const warn = vi.fn();
    const now = 1_000;
    const svc = new PriceService(null, { clock: () => now, logger: { warn } });
    svc.ingest([pr(F1, now + 10 * 365 * 86_400)]); // one hostile print, ten years ahead
    svc.ingest([pr(F1, now + 6)]);
    expect(svc.latest.has(F1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1); // once per feed
    expect(warn.mock.calls[0]![0]).toMatch(/^ignored a print for feed 0x00000000… dated 315360000 s ahead of the clock \(more than 5 s\)/);
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
        return [pr(F1, 100), pr(F3, 100), pr(fid(0x77), 100)]; // F3 and 0x77 were not asked for
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { clock: () => 100, logger: { warn } });
    await svc.fetch([F1, F4]);
    expect(asked).toEqual([[F1, F4]]);
    expect([...svc.latest.keys()]).toEqual([F1]); // asked for (though not watched): kept; the rest dropped
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      `price endpoint sent no print for feed ${F4}: markets on it get no price until it does (check the feed id, that the token covers the feed and that the feed is served on this channel; a feed Pyth has no price or no confidence for has none). Other feeds are unaffected.`,
    ]);
    await svc.fetch([F4]);
    expect(warn).toHaveBeenCalledTimes(1); // once per feed
    svc.watch([F4]);
    expect(svc.missing()).toEqual([ETH_USD_FEED, F4]);
    svc.ingest([pr(F3, 100)]); // a caller's own prints are taken as given
    expect(svc.latest.has(F3)).toBe(true);
    await expect(new PriceService(null).fetch([F1])).rejects.toThrow(new ProError("this PriceService has no price source"));
  });

  it("next_prints reports each feed once per newly generated price, several a second", async () => {
    const svc = new PriceService(null, { clock: () => 100 });
    svc.ingest([pr(F1, 100), pr(F3, 100)]);
    expect(await svc.nextPrints()).toEqual(new Set([F1, F3]));
    svc.ingest([pr(F1, 100), pr(F3, 99)]); // the same price again, and an older one
    let done = false;
    const waiting = svc.nextPrints().then((s) => {
      done = true;
      return s;
    });
    await settle(10);
    expect(done).toBe(false);
    svc.ingest([pr(F1, 100, { generatedUs: 100_200_000n })]); // the same second, 200 ms later: a newer price
    svc.ingest([pr(F1, 100, { generatedUs: 100_400_000n })]);
    expect(await waiting).toEqual(new Set([F1]));
    expect(svc.latest.get(F1)!.generatedUs).toBe(100_400_000n);
    svc.stop();
    expect(await svc.nextPrints()).toEqual(new Set());
  });

  it("tells every listener about each batch's newer prints", () => {
    const warn = vi.fn();
    const svc = new PriceService(null, { clock: () => 100, logger: { warn } });
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
    svc.ingest([pr(F1, 100), pr(F3, 100)]);
    svc.ingest([pr(F1, 100)]); // nothing newer: no call
    svc.ingest([pr(F3, 101)]);
    expect(seen).toEqual([[F1, F3], [F3]]);
    expect(sets[0]).toBe(sets[1]); // one set per batch, shared
    expect(warn).toHaveBeenCalledWith("price listener failed: boom");
    off();
    svc.ingest([pr(F1, 105)]);
    expect(seen).toHaveLength(2);
  });
});

describe("PriceService.run", () => {
  beforeEach(() => FakeSocket.reset());
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A source whose stream yields `batches` and then waits until aborted. */
  function source(batches: (sets: readonly (readonly Hex[])[]) => Print[][]) {
    const streams: (readonly (readonly Hex[])[])[] = [];
    let latest = 0;
    const src: PriceSource = {
      async latest() {
        latest++;
        return [];
      },
      async *stream(sets, signal) {
        streams.push(sets);
        for (const b of batches(sets)) yield b;
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    return { src, streams, polls: () => latest };
  }

  it("streams each watched set on its own, resubscribes when the sets change, and stops at once", async () => {
    const { src, streams } = source((sets) => [sets.flat().map((f) => pr(f, 100 + streams.length))]);
    const svc = new PriceService(src, { clock: () => 100, logger: null });
    const done = svc.run();
    expect(await svc.nextPrints()).toEqual(new Set([ETH_USD_FEED]));
    svc.watchMarkets([market([F1]), market([F3, F4]), market([F1])]);
    svc.watch([F4, F4.toUpperCase().replace("0X", "0x") as Hex]);
    expect(await svc.nextPrints()).toEqual(new Set([F1, F3, F4, ETH_USD_FEED]));
    expect(streams).toHaveLength(2);
    expect(streams[0]).toEqual([[ETH_USD_FEED]]);
    expect(streams[1]).toEqual([[ETH_USD_FEED], [F1], [F3, F4], [F4]]); // a composite's legs together; a set once
    expect([...svc.feeds]).toEqual([ETH_USD_FEED, F1, F3, F4]);
    expect(svc.healthy).toBe(true);
    svc.watchMarkets([market([F4, F3])]); // the same set in another order: nothing to resubscribe
    await settle(10);
    expect(streams).toHaveLength(2);
    svc.stop();
    await done; // without waiting for another print
  });

  it("keeps only the watched feeds' prints from the stream", async () => {
    const strangers = Array.from({ length: 1_000 }, (_, i) => fid(i + 0x1000));
    const { src } = source((sets) => [[...sets.flat().map((f) => pr(f, 100)), ...strangers.map((f) => pr(f, 100))]]);
    const svc = new PriceService(src, { clock: () => 100, logger: null });
    svc.watch([F1]);
    const done = svc.run();
    expect(await svc.nextPrints()).toEqual(new Set([F1, ETH_USD_FEED]));
    expect(svc.latest.size).toBe(2);
    svc.stop();
    await done;
  });

  it("reports, once each, the watched feeds a poll brings no print for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked: (readonly Hex[])[] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push(ids);
        return ids.filter((f) => f !== F4).map((f) => pr(f, 100));
      },
      async *stream() {},
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { stream: false, clock: () => 100, logger: { warn } });
    svc.watch([F1, F4]);
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(3_500); // four polls
    expect(asked[0]).toEqual([F1, ETH_USD_FEED, F4]); // one request for every watched feed
    expect(warn.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(new RegExp(`^price endpoint sent no print for feed ${F4}: `))]);
    expect(svc.missing()).toEqual([F4]);
    expect(svc.latest.has(F1)).toBe(true); // the other feeds are unaffected
    svc.stop();
    await done;
  });

  it("reconnects a stream that goes quiet through the backoff path, with a warning", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const warn = vi.fn();
      const client = new ProClient({ restUrl: "https://pro.test", WebSocket: FakeSocket, streamUrls: ["wss://pro.test/v1/stream"] });
      const svc = new PriceService(client, { streamIdleTimeout: 0.2, clock: () => 100, logger: { warn } });
      expect(new PriceService(null).streamIdleTimeout).toBe(10);
      svc.watch([F1]);
      const done = svc.run();
      await settle(10);
      const first = FakeSocket.all[0]!;
      first.open();
      expect(first.sent.map((m) => m.priceFeedIds)).toEqual([[2], [1]]);
      first.message(streamUpdated(unsigned({ at: 100, feeds: [{ id: 1 }] }))); // one update, then silence
      expect(await svc.nextPrints()).toEqual(new Set([F1]));
      // the second connection: after 0.2 s of silence and the first failure's 1 s backoff
      const waiting = svc.nextPrints();
      const before = performance.now();
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 10_000, interval: 20 });
      expect(performance.now() - before).toBeGreaterThan(1_000);
      expect(first.closed).toBe(true);
      FakeSocket.all[1]!.open();
      FakeSocket.all[1]!.message(streamUpdated(unsigned({ at: 100, extraUs: 200_000n, feeds: [{ id: 1 }] })));
      expect(await waiting).toEqual(new Set([F1]));
      expect(svc.latest.get(F1)!.generatedUs).toBe(100_200_000n);
      expect(warn).toHaveBeenCalledWith("price endpoint: price stream went quiet: no new update for 0.2 s");
      expect(svc.lastError).toBe("price stream went quiet: no new update for 0.2 s");
      expect(svc.healthy).toBe(true); // one failure, then prints again
      svc.stop();
      await done;
      expect(FakeSocket.all[1]!.closed).toBe(true);
      await settle(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("logs what a stream reports, once", async () => {
    const warn = vi.fn();
    let streams = 0;
    const src: PriceSource = {
      async latest() {
        return [];
      },
      async *stream(sets, signal, opts) {
        streams++;
        opts?.onNotice?.("price stream refused the subscription for feed(s) 4 on fixed_rate@200ms: not entitled");
        opts?.onNotice?.("price stream refused the subscription for feed(s) 4 on fixed_rate@200ms: not entitled");
        yield sets.flat().map((f) => pr(f, 100 + streams));
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    const svc = new PriceService(src, { clock: () => 100, logger: { warn } });
    const done = svc.run();
    await svc.nextPrints();
    svc.watch([F1]); // a second stream, reporting the same thing
    await svc.nextPrints();
    expect(streams).toBe(2);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["price stream refused the subscription for feed(s) 4 on fixed_rate@200ms: not entitled"]);
    svc.stop();
    await done;
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
        throw new ProError("price stream unreachable: connection closed (code 1006) (check the stream URLs and the token)");
      },
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { logger: { warn } });
    svc.healthy = true;
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 10); // backoff after the first and the second failure
    expect(attempts).toBe(3);
    expect(svc.healthy).toBe(false);
    expect(svc.lastError).toBe("price stream unreachable: connection closed (code 1006) (check the stream URLs and the token)");
    expect(warn).toHaveBeenCalledWith("price endpoint: price stream unreachable: connection closed (code 1006) (check the stream URLs and the token)");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(polls.n).toBe(1);
    expect(attempts).toBe(3);
    svc.stop();
    await done;
  });
});

describe("labels", () => {
  const entry = (id: number, symbol: string, over: Partial<ProSymbol> = {}): ProSymbol => ({
    id,
    feedId: fid(id),
    symbol,
    name: "",
    description: "",
    assetType: "crypto",
    minChannel: "real_time",
    state: "stable",
    schedule: "",
    exponent: -8,
    hermesId: null,
    ...over,
  });

  it("names feeds and markets from Pyth symbols", () => {
    expect(feedLabel("Crypto.BTC/USD")).toBe("BTC/USD");
    expect(feedLabel("Equity.US.AAPL/USD")).toBe("AAPL/USD");
    expect(marketLabel("Equity.JP.7203/JPY", "FX.USD/JPY")).toBe("7203/USD");
    expect(marketLabel("Crypto.ETH/USD", null)).toBe("ETH/USD");
    expect(marketLabel(null, null)).toBe("");
  });

  it("finds feeds in the symbols registry, and none when it cannot be read", async () => {
    const registry = { symbols: async () => [entry(1, "Crypto.BTC/USD"), entry(2, "Crypto.ETH/USD"), entry(1, "Crypto.BTC/USD.DUP"), entry(1304, "Equity.US.NFLX/USD", { assetType: "equity" })] };
    expect(await fetchSymbols(registry, [F1, fid(1304).toUpperCase().replace("0X", "0x") as Hex, fid(99)])).toEqual(
      new Map([
        [F1, "Crypto.BTC/USD"],
        [fid(1304), "Equity.US.NFLX/USD"],
      ]),
    );
    expect((await fetchFeedInfo(registry, [fid(1304)])).get(fid(1304))).toMatchObject({ id: 1304, assetType: "equity", minChannel: "real_time", state: "stable" });
    const down = {
      symbols: async (): Promise<ProSymbol[]> => {
        throw new ProError("price endpoint unreachable: fetch failed");
      },
    };
    expect(await fetchSymbols(down, [F1])).toEqual(new Map());
    const broken = {
      symbols: async (): Promise<ProSymbol[]> => {
        throw new TypeError("a bug");
      },
    };
    await expect(fetchSymbols(broken, [F1])).rejects.toThrow("a bug");
  });
});

describe("PriceService, as the oracle reads its updates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports no fresh price and attaches nothing when the oracle would read a leg from another of the updates", () => {
    let now = 100;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    const m = market([F1, F3], `0x${"cc".repeat(20)}`);
    svc.watchMarkets([m]);
    // The market's own update is missing, so each leg's newest print is used, one update each. The
    // first also carries F3, generated later but without a confidence: no print, yet the newest entry.
    const a = unsigned({ at: 100, feeds: [{ id: 1 }, { id: 3, conf: 0n, generatedExtraUs: 500_000n }] });
    const b = unsigned({ at: 100, feeds: [{ id: 3 }] });
    svc.ingest([...printsOf(readUpdate(a), a, null, 0), ...printsOf(readUpdate(b), b, null, 0)]);
    expect(svc.legs(m)!.map((p) => p.blob)).toEqual([a, b]);
    expect(svc.price(m)).not.toBeNull(); // still shown
    expect(svc.fresh(m)).toBe(false); // the oracle prices F3 from a's entry, and refuses it
    expect(svc.updateFor(m)).toEqual([]);
    expect(svc.printsFor([F1, F3])).toBeNull();
    // updates that carry only their own leg are read as their prints say
    now = 101;
    const c = unsigned({ at: 101, feeds: [{ id: 1 }] });
    const d = unsigned({ at: 101, feeds: [{ id: 3 }] });
    svc.ingest([...printsOf(readUpdate(c), c, null, 0), ...printsOf(readUpdate(d), d, null, 0)]);
    expect(svc.fresh(m)).toBe(true);
    expect(svc.updateFor(m)).toEqual([c, d]);
    expect(svc.printsFor([F1, F3])!.map((p) => p.blob)).toEqual([c, d]);
  });

  it("backs off a stream that keeps ending as soon as it starts, as it does one that throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let attempts = 0;
    const src: PriceSource = {
      async latest() {
        return [];
      },
      // every endpoint dropped right after connecting: the stream ends without a print
      async *stream() {
        attempts++;
      },
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { logger: { warn } });
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(attempts).toBe(2); // at once, then after the first failure's 1 s; the next waits 2 s
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^price endpoint: price stream ended after \d+\.\d s without delivering an update$/));
    svc.stop();
    await done;
    // one that delivers but ends within seconds is no healthier
    let starts = 0;
    const flaky: PriceSource = {
      async latest() {
        return [];
      },
      async *stream(sets) {
        starts++;
        yield sets.flat().map((f) => pr(f, 100));
      },
    };
    const svc2 = new PriceService(flaky, { clock: () => 100, logger: null });
    const done2 = svc2.run();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(starts).toBe(2);
    svc2.stop();
    await done2;
  });

  it("polls in requests of at most 255 feeds, each market's legs in one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked: (readonly Hex[])[] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push(ids);
        return [];
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { stream: false, logger: null });
    svc.watch(Array.from({ length: 300 }, (_, i) => fid(i + 100)));
    svc.watchSets([[fid(10), fid(11)]]);
    const done = svc.run();
    await vi.advanceTimersByTimeAsync(10);
    expect(asked).toHaveLength(2);
    for (const r of asked) expect(r.length).toBeLessThanOrEqual(255);
    expect(new Set(asked.flat()).size).toBe(303); // ETH/USD, the 300 feeds and the pair's two legs, each once
    expect(asked.some((r) => r.includes(fid(10)) && r.includes(fid(11)))).toBe(true);
    svc.stop();
    await done;
    // fetch, as LivePrices seeds with, asks in parts too
    asked.length = 0;
    await svc.fetch();
    expect(asked.map((r) => r.length)).toEqual([255, 48]);
  });
});

describe("Pyth's latest price, as a liquidation on a market with trading hours proves it", () => {
  /** A market with trading hours over `legs`. */
  const hours = (legs: Hex[], address: Hex = `0x${"dd".repeat(20)}`): Market => ({ ...market(legs, address), continuous: false });
  /** An update stamped at second `at` (plus `extraUs`) carrying `feeds`. */
  const blob = (at: number, feeds: FeedSpec[], extraUs = 0n): Hex => unsigned({ at, extraUs, feeds });
  /** The prints a client returns for update `b`. */
  const prints = (b: Hex): Print[] => printsOf(readUpdate(b), b, null, 0);
  /** The price the oracle composes from one leg at the fakes' default price, generated in second `at`. */
  const priceAt = (at: number) => pairPrice([{ price: 200_000_000_000n, conf: 1_000n, expo: -8, publishTime: at }], false);
  /** Why a price generated `s` seconds before `carrying` was issued cannot decide a liquidation. */
  const tooOld = (feed: number, s: number, carrying = "the update carrying it") =>
    `feed ${feed}'s latest price was generated ${s} s before ${carrying} was issued, more than the 57 s that keeps it within the 60 s a liquidation's price may be old`;

  it("is read as the oracle reads it: when each update was issued, when each price was generated, inside the cap", () => {
    expect([MAX_LIQUIDATION_PRICE_AGE, MAX_LATEST_PRICE_LAG]).toEqual([60, 57]);
    const quiet = blob(1_000, [{ id: 1, generated: 943 }]);
    expect(readLatestPrice([quiet], [F1], false)).toEqual({ update: [quiet], issuedAt: 1_000, generated: [943], price: priceAt(943) });
    // a second older, and a block 3 s after the update would find it 61 s old
    expect(readLatestPrice([blob(1_000, [{ id: 1, generated: 942 }])], [F1], false)).toEqual({ problem: tooOld(1, 58) });
    // a composite's legs in one update: the price is as old as its older leg
    const both = blob(1_000, [{ id: 3, generated: 990 }, { id: 4, generated: 980 }]);
    expect(readLatestPrice([both], [F3, F4], false)).toMatchObject({ update: [both], issuedAt: 1_000, generated: [990, 980], price: { publishTime: 980 } });
    // in two updates, each of which the block must be within 3 s of: the earliest bounds how late the block can
    // be, so each price's age counts from it, whichever update carries the price
    const base = blob(1_000, [{ id: 3, generated: 990 }]);
    expect(readLatestPrice([base, blob(1_002, [{ id: 4, generated: 943 }])], [F3, F4], false)).toMatchObject({ issuedAt: 1_000, generated: [990, 943] });
    expect(readLatestPrice([base, blob(1_002, [{ id: 4, generated: 942 }])], [F3, F4], false)).toEqual({ problem: tooOld(4, 58, "the earliest of the updates") });
    // a price dated after the updates were issued would be ahead of every block that admits them
    expect(readLatestPrice([blob(1_000, [{ id: 1, generated: 1_001 }])], [F1], false)).toEqual({ problem: "feed 1's price is dated 1 s after the update carrying it was issued" });
    // each leg is read from the update holding its most recently generated price, usable or not
    const later = blob(1_001, [{ id: 1, generated: 950, conf: 0n }]);
    expect(readLatestPrice([quiet, later], [F1], false)).toEqual({ problem: "feed 1: Pyth reports no confidence for it, and the oracle refuses a live price without one" });
    // a wider latest price is refused, never passed over for an older one
    expect(readLatestPrice([blob(1_000, [{ id: 1, generated: 990, conf: 5_000_000_000n }])], [F1], false)).toEqual({
      problem: "Pyth's confidence interval for the latest price is wider than the oracle's 2% cap",
    });
    expect(readLatestPrice([quiet], [F1, F3], false)).toEqual({ problem: "no update carries feed 3" });
    expect(readLatestPrice([], [F1], false)).toEqual({ problem: "no update was given" });
    expect(readLatestPrice(["0x1234"], [F1], false)).toEqual({ problem: expect.stringMatching(/^an update cannot be read \(malformed Pyth Pro update/) });
  });

  it("gives a liquidation a fresh price, else Pyth's latest one issued within the window, else nothing and why", () => {
    let now = 1_000.5;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    const m = hours([F1]);
    svc.watchMarkets([m]);
    expect(svc.latestFor(m)).toBeNull();
    expect(svc.liquidationUpdate(m)).toEqual({ kind: null, update: [], price: null, generated: [], priceTime: null, reason: "the price source holds no update carrying every leg of the market yet" });
    // a fresh price: its update, judged at it
    const live = blob(1_000, [{ id: 1 }]);
    svc.ingest(prints(live));
    expect(svc.liquidationUpdate(m)).toEqual({ kind: "fresh", update: [live], price: priceAt(1_000), generated: [1_000], priceTime: 1_000, reason: null });
    // the venue closes: updates keep coming, each carrying the last price forward
    let last = live;
    for (let at = 1_001; at <= 1_030; at++) {
      now = at + 0.2;
      svc.ingest(prints((last = blob(at, [{ id: 1, generated: 1_000 }]))));
    }
    expect(svc.fresh(m)).toBe(false);
    expect(svc.updateFor(m)).toEqual([live]); // no newer price arrived for a fresh-price call to carry
    expect(svc.latestFor(m)!.map((p) => [p.timestampUs, p.generatedUs, p.blob])).toEqual([[1_030n * US, 1_000n * US, last]]);
    expect(svc.liquidationUpdate(m)).toEqual({ kind: "latest", update: [last], price: priceAt(1_000), generated: [1_000], priceTime: 1_030, reason: null });
    // the source falls behind: its newest update is past the window less the send margin
    now = 1_032.5;
    expect(svc.liquidationUpdate(m)).toMatchObject({
      kind: null,
      update: [],
      reason: "the newest update the price source holds was issued 2.5 s before the clock, past the pair's 3 s window less the 1 s send margin",
    });
    expect(svc.liquidationUpdate(m, null, 0).kind).toBe("latest");
    // the last price ages: 57 s before its update is the last second it can decide a liquidation
    for (let at = 1_031; at <= 1_058; at++) {
      now = at + 0.2;
      svc.ingest(prints((last = blob(at, [{ id: 1, generated: 1_000 }]))));
      expect(svc.liquidationUpdate(m).kind, String(at)).toBe(at - 1_000 <= 57 ? "latest" : null);
    }
    expect(svc.liquidationUpdate(m).reason).toBe(tooOld(1, 58));
    // the reopen: a fresh price again
    now = 1_100.2;
    const reopen = blob(1_100, [{ id: 1 }]);
    svc.ingest(prints(reopen));
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "fresh", update: [reopen], priceTime: 1_100 });
    // a continuously traded market is liquidated only at a fresh price
    now = 1_105.2;
    svc.ingest(prints(blob(1_105, [{ id: 1, generated: 1_100 }])));
    expect(svc.liquidationUpdate(m).kind).toBe("latest");
    expect(svc.liquidationUpdate(market([F1]))).toMatchObject({
      kind: null,
      reason: "no fresh price: a continuously traded market is liquidated only at a price generated within the pair's 3 s window less the send margin, inside the oracle's confidence cap",
    });
  });

  it("refuses an update issued ahead of the clock past the window, and ignores one stamped past the skew", () => {
    const warn = vi.fn();
    let now = 2_000;
    const svc = new PriceService(null, { clock: () => now, logger: { warn } });
    const m = hours([F1]);
    svc.watchMarkets([m]);
    // an endpoint whose clock runs ahead: inside the skew, but no block within the window would admit it now
    svc.ingest(prints(blob(2_003, [{ id: 1, generated: 1_990 }])));
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: null, reason: "an update the price source holds was issued 3 s ahead of the clock, past the pair's 3 s window less the 1 s send margin" });
    // stamped an hour ahead, whatever its price's age: ignored, so it holds neither the feed's newest price nor
    // its most recently issued update
    svc.ingest(prints(blob(5_600, [{ id: 1, generated: 1_995 }])));
    expect(warn).toHaveBeenCalledWith("ignored a print for feed 0x00000000… dated 3600 s ahead of the clock (more than 5 s): check the price endpoint, or this machine's clock");
    expect(svc.latest.get(F1)!.publishTime).toBe(1_990);
    now = 2_003.4;
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "latest", priceTime: 2_003, generated: [1_990] });
  });

  it("takes a market's own update, unless another carrying one of its legs was issued a second later", () => {
    let now = 3_000.1;
    const svc = new PriceService(null, { clock: () => now, logger: null });
    const m = hours([F3, F4]);
    svc.watchMarkets([m]);
    svc.watch([F4]); // the FX leg is also watched on its own
    const own = blob(3_000, [{ id: 3, generated: 2_990 }, { id: 4, generated: 2_980 }]);
    svc.ingest(prints(own));
    svc.ingest(prints(blob(3_000, [{ id: 4, generated: 2_980 }], 400_000n)));
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "latest", update: [own], generated: [2_990, 2_980], priceTime: 3_000 });
    // its subscription falls a second behind: each leg's most recently issued update, one per leg, and the call
    // must land within 3 s of the earlier one
    now = 3_001.3;
    const alone = blob(3_001, [{ id: 4, generated: 2_980 }], 200_000n);
    svc.ingest(prints(alone));
    expect(svc.latestFor(m)!.map((p) => p.blob)).toEqual([own, alone]);
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "latest", update: [own, alone], priceTime: 3_000 });
    expect(svc.liquidationUpdate(m, 3_003.5)).toMatchObject({
      kind: null,
      reason: "the earliest of the newest updates the price source holds was issued 3.5 s before the clock, past the pair's 3 s window less the 1 s send margin",
    });
    // a poll's update carrying every feed, issued later still, serves both legs in one
    now = 3_002.2;
    const poll = blob(3_002, [{ id: 1 }, { id: 3, generated: 2_990 }, { id: 4, generated: 2_980 }]);
    svc.ingest(prints(poll));
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "latest", update: [poll], priceTime: 3_002 });
  });

  it("holds a fresh price on a market with trading hours to its update's issue window as well", () => {
    const svc = new PriceService(null, { clock: () => 1_000, logger: null });
    const m = hours([F1]);
    const c = market([F1], `0x${"ee".repeat(20)}`);
    svc.watchMarkets([m, c]);
    // an endpoint whose clock runs ahead: the price is fresh by when it was generated, but its update was
    // issued past the window the oracle holds every update a liquidation there carries to
    const ahead = blob(1_005, [{ id: 1, generated: 1_002 }]);
    svc.ingest(prints(ahead));
    expect(svc.fresh(m)).toBe(true);
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: null, reason: "an update the price source holds was issued 5 s ahead of the clock, past the pair's 3 s window less the 1 s send margin" });
    // a continuously traded market's oracle reads the price's generation time alone
    expect(svc.liquidationUpdate(c)).toMatchObject({ kind: "fresh", update: [ahead], priceTime: 1_002 });
  });

  it("holds every attached update to the window by its own issue time, the newest included", () => {
    const svc = new PriceService(null, { clock: () => 3_000.1, logger: null });
    const m = hours([F3, F4]);
    svc.watchMarkets([m]);
    svc.watch([F4]);
    const own = blob(3_000, [{ id: 3, generated: 2_990 }, { id: 4, generated: 2_980 }]);
    svc.ingest(prints(own));
    // the FX leg's own subscription runs ahead: inside the skew, but past the window
    const alone = blob(3_003, [{ id: 4, generated: 2_980 }]);
    svc.ingest(prints(alone));
    expect(svc.latestFor(m)!.map((p) => p.blob)).toEqual([own, alone]);
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: null, reason: "an update the price source holds was issued 2.9 s ahead of the clock, past the pair's 3 s window less the 1 s send margin" });
  });

  it("composes an inverted composite as the oracle does, from each leg's latest price", () => {
    const fx = blob(1_000, [{ id: 3, generated: 990 }, { id: 4, generated: 980, price: 15_000_000_000n }]);
    const legsAt = [
      { price: 200_000_000_000n, conf: 1_000n, expo: -8, publishTime: 990 },
      { price: 15_000_000_000n, conf: 1_000n, expo: -8, publishTime: 980 },
    ];
    expect(pairPrice(legsAt, true)).not.toEqual(pairPrice(legsAt, false));
    expect(readLatestPrice([fx], [F3, F4], true)).toMatchObject({ price: pairPrice(legsAt, true) });
    expect(readLatestPrice([fx], [F3, F4], false)).toMatchObject({ price: pairPrice(legsAt, false) });
    const svc = new PriceService(null, { clock: () => 1_000.2, logger: null });
    const m: Market = { ...market([F3, F4], `0x${"cc".repeat(20)}`, true), continuous: false };
    svc.watchMarkets([m]);
    svc.ingest(prints(fx));
    expect(svc.liquidationUpdate(m)).toMatchObject({ kind: "latest", update: [fx], price: pairPrice(legsAt, true), priceTime: 1_000 });
  });

  it("takes a price generated between two updates' issue times, and refuses updates issued too far apart", () => {
    const early = blob(1_000, [{ id: 3, generated: 990 }]);
    // generated after the earlier update was issued but not after the later one: inside every block both admit
    expect(readLatestPrice([early, blob(1_002, [{ id: 4, generated: 1_001 }])], [F3, F4], false)).toMatchObject({ issuedAt: 1_000, generated: [990, 1_001] });
    // 3 s apart at most: every block in the 3 s after the earlier one is then within 3 s of both
    expect(readLatestPrice([early, blob(1_003, [{ id: 4, generated: 1_001 }])], [F3, F4], false)).toMatchObject({ issuedAt: 1_000 });
    expect(readLatestPrice([early, blob(1_004, [{ id: 4, generated: 1_001 }])], [F3, F4], false)).toEqual({ problem: "the updates were issued 4 s apart, more than the pair's 3 s window" });
  });
});

describe("PriceService, when the request API refuses a feed", () => {
  const refusal = () =>
    new ProError("price endpoint refused the request (HTTP 403); check the token (prices.token) and that it covers these feeds and this channel. The endpoint said: not entitled", 403);

  it("asks again in parts, serves every other feed, and leaves the refused one out for a while", async () => {
    const BAD = fid(99);
    const asked: Hex[][] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push([...ids]);
        if (ids.includes(BAD)) throw refusal();
        return ids.map((f) => pr(f, 100));
      },
      async *stream() {},
    };
    const warn = vi.fn();
    const svc = new PriceService(src, { stream: false, clock: () => 100, logger: { warn } });
    svc.watchMarkets([market([F3, F4]), market([F1], `0x${"bb".repeat(20)}`), market([BAD, F4], `0x${"cc".repeat(20)}`)]);
    await svc.fetch();
    for (const f of [ETH_USD_FEED, F1, F3, F4]) expect(svc.latest.has(f), f).toBe(true);
    expect(svc.latest.has(BAD)).toBe(false);
    // the whole request first; the refused market's legs were last asked for one by one
    expect(asked[0]).toEqual([ETH_USD_FEED, F1, F3, F4, BAD].sort());
    expect(asked.filter((r) => r.length === 1 && r[0] === BAD)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^price endpoint refused feed 99 while serving the others: left out of its requests for 5 min \(price endpoint refused the request \(HTTP 403\)/),
    );
    // the next poll leaves it out, and is served whole
    asked.length = 0;
    await svc.fetch();
    expect(asked).toEqual([[ETH_USD_FEED, F1, F3, F4].sort()]);
  });

  it("fails the poll when every feed is refused, leaves none out, and splits again only after a while", async () => {
    const asked: Hex[][] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push([...ids]);
        throw refusal();
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { stream: false, clock: () => 100, logger: null });
    svc.watchMarkets([market([F3, F4])]);
    await expect(svc.fetch()).rejects.toThrow(/HTTP 403/);
    expect(asked).toHaveLength(5); // the request, the market's legs and ETH/USD, then each leg alone
    asked.length = 0;
    await expect(svc.fetch()).rejects.toThrow(/HTTP 403/);
    expect(asked).toEqual([[ETH_USD_FEED, F3, F4].sort()]);
  });

  it("leaves a refused feed out although another part of the poll failed otherwise", async () => {
    const BAD = fid(99);
    let busy = true;
    const asked: Hex[][] = [];
    const src: PriceSource = {
      async latest(ids) {
        asked.push([...ids]);
        if (ids.includes(BAD)) throw refusal();
        if (busy && ids.length === 1 && ids[0] === F1) throw new ProError("price endpoint returned HTTP 429: slow down", 429);
        return ids.map((f) => pr(f, 100));
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { stream: false, clock: () => 100, logger: null });
    svc.watchMarkets([market([F1]), market([BAD], `0x${"bb".repeat(20)}`)]);
    await expect(svc.fetch()).rejects.toThrow(/HTTP 429/);
    busy = false;
    asked.length = 0;
    await svc.fetch();
    expect(asked).toEqual([[ETH_USD_FEED, F1].sort()]);
  });

  it("asks a refused request's parts at most 8 at a time", async () => {
    const BAD = fid(99);
    let inFlight = 0;
    let most = 0;
    const src: PriceSource = {
      async latest(ids) {
        inFlight++;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight--;
        if (ids.includes(BAD)) throw refusal();
        return ids.map((f) => pr(f, 100));
      },
      async *stream() {},
    };
    const svc = new PriceService(src, { stream: false, clock: () => 100, logger: null });
    const many = Array.from({ length: 20 }, (_, i) => market([fid(200 + i)], `0x${(i + 1).toString(16).padStart(40, "0")}`));
    svc.watchMarkets([...many, market([BAD], `0x${"bb".repeat(20)}`)]);
    await svc.fetch();
    expect(most).toBe(8);
    for (const m of many) expect(svc.latest.has(m.legs[0]!)).toBe(true);
  });
});
