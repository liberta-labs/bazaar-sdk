import { type Address, type Hex, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/client/calls.js";
import type { BazaarContext } from "../src/client/context.js";
import {
  type LivePriceView,
  VENUE_CLOSED_AFTER,
  adlScoreThresholdAt,
  annualizedFunding,
  getBook,
  getBookDepth,
  getMarket,
  listMarkets,
  marketFlags,
  marketSnapshot,
  marketSnapshots,
  marketStatusAt,
  warmupOf,
} from "../src/client/markets.js";
import { ADL_MAX_SCORE, LIMBO_LEAD, MAX_UINT256 } from "../src/constants.js";
import type { MarketState } from "../src/models.js";
import type { Print, ProSymbol } from "../src/prices/pro.js";
import { E18, FACTORY, FakeTransport, LENS, type MarketFixture, addr, contextFor, h32, inventory, withMarket } from "./client-reads-fakes.js";
import { fid, print as proPrint } from "./pro-fakes.js";

const A = addr("0a");
const B = addr("0b");
const F1 = fid(1);
const F2 = fid(2_001);
const F3 = fid(327);
const TS = 1_700_000_000;

const entry = (id: number, symbol: string, assetType: string, minChannel: string): ProSymbol => ({
  id,
  feedId: fid(id),
  symbol,
  name: "",
  description: "",
  assetType,
  minChannel,
  state: "stable",
  schedule: "",
  sessions: {},
  exponent: -8,
  hermesId: null,
});
const META = [entry(1, "Crypto.BTC/USD", "crypto", "real_time"), entry(2_001, "Equity.GB.HSBA/GBP", "equity", "fixed_rate@200ms"), entry(327, "FX.GBP/USD", "fx", "fixed_rate@200ms")];

function metadata() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async symbols() {
      calls += 1;
      return META;
    },
  };
}

function fixtureA(over: Partial<MarketFixture> = {}): MarketFixture {
  return { address: A, pairId: h32("a1"), baseFeedId: F1, continuous: true, laggedMmrBp: 150n, ...over };
}

function fixtureB(over: Partial<MarketFixture> = {}): MarketFixture {
  return { address: B, pairId: h32("b1"), baseFeedId: h32("cc"), continuous: false, composite: { baseId: F2, quoteId: F3, invertQuote: false }, ...over };
}

function setup(opts: { a?: Partial<MarketFixture>; b?: Partial<MarketFixture>; ctx?: Partial<BazaarContext> } = {}) {
  const t = new FakeTransport(100, TS);
  withMarket(t, fixtureA(opts.a));
  withMarket(t, fixtureB(opts.b));
  t.answer(FACTORY, "getAllPairs", [A, B]);
  return { t, ctx: contextFor(t, opts.ctx) };
}

describe("listMarkets", () => {
  it("describes the factory's markets once, labels them from feed symbols and caches them", async () => {
    const queries: unknown[] = [];
    const subgraph = {
      async query<T>(_q: string, vars?: Record<string, unknown>): Promise<T> {
        queries.push(vars);
        return { pairs: [{ id: A.toLowerCase(), description: "Bitcoin perpetual" }] } as T;
      },
    };
    const { t, ctx } = setup({ ctx: { subgraph } });
    const meta = metadata();
    const list = await listMarkets(ctx, { metadata: meta });
    expect(list.map((m) => [m.address, m.label, m.hours, m.composite, m.index])).toEqual([
      [A, "BTC/USD", "24/7", false, 0],
      [B, "HSBA/USD", "trading-hours", true, 1], // a composite is priced in USD
    ]);
    expect(list[0]).toMatchObject({ pairId: h32("a1"), legs: [F1], description: "Bitcoin perpetual", legSymbols: ["Crypto.BTC/USD"] });
    expect(list[0]!.legFeeds).toEqual([META[0]]); // the registry's entry: asset type, fastest channel, state, schedule
    expect(list[1]).toMatchObject({ legs: [F2, F3], invertQuote: false, continuous: false, description: "", legSymbols: ["Equity.GB.HSBA/GBP", "FX.GBP/USD"] });
    expect(list[1]!.legFeeds.map((f) => [f?.assetType, f?.minChannel])).toEqual([
      ["equity", "fixed_rate@200ms"],
      ["fx", "fixed_rate@200ms"],
    ]);
    expect(queries).toEqual([{ ids: [A.toLowerCase(), B.toLowerCase()] }]);
    expect(meta.calls).toBe(1);

    const before = t.requests.length;
    expect(await listMarkets(ctx)).toBe(list); // cached: no request at all
    expect(t.requests.length).toBe(before);

    // A refresh describes only what the factory listed since.
    const C = addr("0d");
    withMarket(t, { address: C, pairId: h32("d1"), baseFeedId: h32("99") });
    t.answer(FACTORY, "getAllPairs", [A, B, C]);
    t.calls.length = 0;
    const again = await listMarkets(ctx, { refresh: true });
    expect(again.map((m) => m.address)).toEqual([A, B, C]);
    expect(again[0]).toBe(list[0]);
    expect(t.calls.filter((c) => c.endsWith(":pairId"))).toEqual([`${C}:pairId`]);
    expect(again[2]!.label).toBe(C.slice(0, 10)); // no symbol and no description: the address
    expect(again[2]!.legFeeds).toEqual([null]);
  });

  it("labels by the address when the metadata has no symbol, and survives a subgraph outage", async () => {
    const subgraph = {
      async query<T>(): Promise<T> {
        throw new Error("subgraph down");
      },
    };
    const { ctx } = setup({ ctx: { subgraph } });
    const list = await listMarkets(ctx, { metadata: null });
    expect(list.map((m) => [m.label, m.description, m.legSymbols])).toEqual([
      [A.slice(0, 10), "", [""]],
      [B.slice(0, 10), "", ["", ""]],
    ]);
  });
});

describe("getMarket", () => {
  // A description is the subgraph's unverified text, so it never resolves a name.
  it("finds a market by address, pair id or label, and reports an ambiguous label", async () => {
    const subgraph = {
      async query<T>(): Promise<T> {
        return { pairs: [{ id: A.toLowerCase(), description: "Perp" }, { id: B.toLowerCase(), description: "perp" }] } as T;
      },
    };
    const { ctx } = setup({ ctx: { subgraph } });
    await listMarkets(ctx, { metadata: metadata() });
    expect((await getMarket(ctx, A.toLowerCase())).address).toBe(A);
    expect((await getMarket(ctx, h32("b1").toUpperCase().replace("0X", "0x"))).address).toBe(B);
    expect((await getMarket(ctx, " btc/usd ")).address).toBe(A);
    const info = await getMarket(ctx, "HSBA/USD");
    expect(await getMarket(ctx, info)).toBe(info);

    const byDescription = await getMarket(ctx, "PERP").catch((e) => e);
    expect(byDescription).toBeInstanceOf(InputError);
    expect(byDescription.message).toContain('There is no market called "PERP"');

    const missing = await getMarket(ctx, "ETH/USD").catch((e) => e);
    expect(missing).toBeInstanceOf(InputError);
    expect(missing.message).toContain('There is no market called "ETH/USD". Markets: BTC/USD, HSBA/USD.');

    // Two markets with the same feed label (a relisting) are ambiguous, never a silent pick.
    const twin = setup({ b: { baseFeedId: F1, composite: undefined } });
    await listMarkets(twin.ctx, { metadata: metadata() });
    const ambiguous = await getMarket(twin.ctx, "BTC/USD").catch((e) => e);
    expect(ambiguous).toBeInstanceOf(InputError);
    expect(ambiguous.field).toBe("market");
    expect(ambiguous.message).toContain("matches several markets");
  });

  // An unverified subgraph description never becomes a label or a name, and a non-string does not throw.
  it("never lets a subgraph description name a market or impersonate another's label", async () => {
    const subgraph = {
      async query<T>(): Promise<T> {
        return {
          pairs: [
            { id: A.toLowerCase(), description: { evil: true } }, // not a string
            { id: B.toLowerCase(), description: "BTC/USD" }, // passes the charset: kept as text, never as a label
            { id: addr("0e").toLowerCase(), description: "Not asked about" },
            { id: 7, description: "x" },
          ],
        } as T;
      },
    };
    const { ctx } = setup({ ctx: { subgraph } });
    const list = await listMarkets(ctx, { metadata: null });
    expect(list.map((m) => [m.label, m.description])).toEqual([
      [A.slice(0, 10), ""],
      [B.slice(0, 10), "BTC/USD"],
    ]);
    expect((await getMarket(ctx, "BTC/USD").catch((e) => e)).message).toContain('There is no market called "BTC/USD"');

    // A description outside the factory's charset (control characters, quotes, colons, accents) is dropped.
    for (const d of ["BTC/USD‮", 'say "hi"', "Pair: BTC", "Café", "", "x".repeat(201)]) {
      const s = setup({ ctx: { subgraph: { query: async <T>() => ({ pairs: [{ id: A.toLowerCase(), description: d }] }) as T } } });
      expect((await listMarkets(s.ctx, { metadata: null }))[0]!.description).toBe("");
    }
  });
});

describe("warmupOf", () => {
  it("holds the cap until the market is 15 days old and has stored 25,000 prices, both", () => {
    const D = 86_400;
    expect(warmupOf(true, 0, 25_000, 15 * D)).toMatchObject({ active: false, floorImrBp: 2_000n, maxLeverage: 5 });
    expect(warmupOf(true, 0, 25_000, 15 * D - 1)).toMatchObject({ active: true });
    expect(warmupOf(true, 0, 24_999, 100 * D)).toMatchObject({ active: true });
    expect(warmupOf(false, 0, 0, 0)).toMatchObject({ active: true, ageClearsAt: 15 * D, pricesNeeded: 25_000, floorImrBp: 4_000n, maxLeverage: 2.5 });
  });
});

describe("marketSnapshot", () => {
  it("reads a market's live state at one block in two batched calls", async () => {
    const { t, ctx } = setup({ a: { fundingIndex: 5n, projectedFundingIndex: 9n, longOi: 10n * E18, shortOi: 8n * E18 } });
    const [a] = await listMarkets(ctx, { metadata: null });
    t.batches.length = 0;
    const blocksBefore = t.count("eth_getBlockByNumber");
    const s = await marketSnapshot(ctx, a!);
    expect(t.count("eth_getBlockByNumber") - blocksBefore).toBe(1);
    expect(t.batches.map((b) => b.block)).toEqual([toHex(100), toHex(100)]);
    expect(t.batches.map((b) => b.size).sort((x, y) => x - y)).toEqual([8, 12]); // the snapshot's reads, Reader.marketStates

    const spot = 2_000n * E18;
    expect(s).toMatchObject({
      block: 100,
      timestamp: TS,
      status: "live",
      markPrice: spot + 3n * E18,
      deficit: 0n,
      venueClosed: false,
      marketOrdersDisabled: false,
      positionWithdrawalsFrozen: false,
      allWithdrawalsPaused: false,
      reasons: { venueClosed: null, marketOrdersDisabled: null, positionWithdrawalsFrozen: null, allWithdrawalsPaused: null },
    });
    expect(s.price).toEqual({ spot, low: spot - E18, high: spot + E18, updateTs: TS - 2, age: 2, emaVarianceBp: 7n, updateCount: 1234 });
    expect(s.funding).toEqual({
      currentRatePerHour: 10n ** 14n,
      accruingRatePerHour: 5n * 10n ** 13n,
      index: 5n,
      projectedIndex: 9n,
      lastAccrualTs: 1_699_999_990,
      maxRatePerHour: E18 / 1000n,
    });
    expect(s.margin).toEqual({ imrBp: 400n, mmrBp: 200n, laggedMmrBp: 150n, effectiveMmrBp: 150n, maxLeverage: 25, withdrawalFloorBp: 200n });
    // Created long ago, but 1,234 stored prices are short of the 25,000 that lift the cap.
    expect(s.warmup).toEqual({ active: true, createdTs: 1_690_000_000, ageClearsAt: 1_690_000_000 + 15 * 86_400, pricesStored: 1234, pricesNeeded: 25_000, floorImrBp: 2_000n, maxLeverage: 5 });
    expect(s.openInterest).toEqual({
      long: 10n * E18,
      short: 8n * E18,
      longNotional: 20_000n * E18,
      shortNotional: 16_000n * E18,
      longInventory: E18,
      shortInventory: 0n,
    });
    expect(s.insurance).toEqual({
      fund: 10_000n * E18,
      freeCapital: 9_900n * E18,
      seized: 100n * E18,
      targetRatioBp: 300n,
      ledgerArrears: 0n,
      depositsLedger: 50_000n * E18,
    });
    expect(s.adl).toEqual({
      pending: false,
      epoch: 3,
      pendingSince: 0,
      auctionStart: 0,
      auctionEndsAt: 0,
      timeoutAt: 0,
      terminationTs: 0,
      scoreThreshold: MAX_UINT256,
    });
    expect(s.termination).toMatchObject({ scheduledTs: 0, haltsAt: 0, settlementFixedTs: 0, finalizeBy: 0, terminated: false });
    expect(s.book).toEqual({ bidHead: 5n, askHead: 6n, bidCount: 3, askCount: 2 });

    // A watcher's head needs no block read.
    const n = t.count("eth_getBlockByNumber");
    await marketSnapshot(ctx, a!, { block: { number: 99, timestamp: TS - 1 } });
    expect(t.count("eth_getBlockByNumber")).toBe(n);
    expect(t.batches.slice(-2).map((b) => b.block)).toEqual([toHex(99), toHex(99)]);
  });

  it("reports ADL, its clocks and the freezes it brings", async () => {
    const { ctx } = setup({ a: { adlPending: true, adlAuctionStart: TS - 300, adlPendingSince: TS - 1_000, adlTerminationTs: 0 } });
    const [a] = await listMarkets(ctx, { metadata: null });
    const s = await marketSnapshot(ctx, a!);
    expect(s.status).toBe("adl");
    expect(s.adl).toMatchObject({ pending: true, auctionStart: TS - 300, auctionEndsAt: TS + 300, pendingSince: TS - 1_000, timeoutAt: TS - 1_000 + 86_400 });
    // quadratic decay from 25 to 1 over the 10-minute auction: half way, a quarter of the way down
    expect(s.adl.scoreThreshold).toBe(1n + ADL_MAX_SCORE / 4n);
    expect(adlScoreThresholdAt(s, TS + 300)).toBe(1n);
    expect(s.marketOrdersDisabled).toBe(true);
    expect(s.reasons.marketOrdersDisabled).toContain("auto-deleverages");
    expect(s.positionWithdrawalsFrozen).toBe(true);
    expect(s.reasons.positionWithdrawalsFrozen).toContain("flat accounts can still withdraw");
    expect(s.allWithdrawalsPaused).toBe(false);
  });

  it("judges a trading-hours market's venue with live prices, or one Pyth Pro request", async () => {
    const view: LivePriceView = { price: () => null, venueClosed: (m) => m === B };
    const { ctx } = setup();
    await listMarkets(ctx, { metadata: null });
    const snaps = await marketSnapshots(ctx, [A, B], { prices: view });
    const b = snaps.get(B)!;
    expect([snaps.get(A)!.venueClosed, b.venueClosed]).toEqual([false, true]);
    expect(b.marketOrdersDisabled && b.positionWithdrawalsFrozen && !b.allWithdrawalsPaused).toBe(true);
    expect(b.reasons.marketOrdersDisabled).toContain("Limit orders still work");
    expect(b.reasons.positionWithdrawalsFrozen).toContain("first fresh price at the reopen");
    expect(b.status).toBe("live"); // a closed venue is not a halt
    expect(b.margin.withdrawalFloorBp).toBe(400n); // trading-hours markets keep the IMR as cash
    expect(b.funding.maxRatePerHour).toBe(E18 / 200n);

    // Without a view: nothing can judge it...
    expect((await marketSnapshot(ctx, B)).venueClosed).toBeNull();
    // ...unless the context's source serves prints: only the trading-hours market's legs are asked for.
    const asked: Hex[][] = [];
    const now = Math.floor(Date.now() / 1000);
    const print = (feedId: Hex, publishTime: number): Print => proPrint(feedId, publishTime, { price: 100_000_000n });
    const prices = {
      async latest() {
        return { update: [], publishTime: 0 };
      },
      async prints(ids: readonly Hex[]) {
        asked.push([...ids]);
        return [print(F2, now - VENUE_CLOSED_AFTER - 5), print(F3, now)];
      },
    };
    const ctx2 = { ...ctx, prices };
    await listMarkets(ctx2, { metadata: null });
    const both = await marketSnapshots(ctx2, [A, B]);
    expect(asked).toEqual([[F2, F3]]);
    expect([both.get(A)!.venueClosed, both.get(B)!.venueClosed]).toEqual([false, true]);
    expect((await marketSnapshots(ctx2, [B], { fetchPrices: false })).get(B)!.venueClosed).toBeNull();
  });

  it("leaves out a market whose core reads fail", async () => {
    const { t, ctx } = setup();
    await listMarkets(ctx, { metadata: null });
    t.answer(B, "pairVault", new Error("revert"));
    const snaps = await marketSnapshots(ctx, [A, B]);
    expect([...snaps.keys()]).toEqual([A]);
    await expect(marketSnapshot(ctx, B)).rejects.toThrow("could not read the state of market");
  });
});

describe("market flags", () => {
  const state = (over: Partial<MarketState> = {}): MarketState => ({
    block: 1, timestamp: TS, spot: E18, updateTs: TS, imrBp: 400n, mmrBp: 200n, laggedMmrBp: 0n, fundingIndex: 0n, projectedFundingIndex: 0n,
    adlPending: false, adlAuctionStart: 0, adlTerminationTs: 0, settlementFixedTs: 0, scheduledTs: 0, terminated: false, longOi: 0n,
    shortOi: 0n, insurance: 0n, deficit: 0n, longInv: { ...inventory(), seizedTs: 0 }, shortInv: { ...inventory(), seizedTs: 0 }, ...over,
  });
  const cont = { continuous: true };
  const hours = { continuous: false };

  it("follow the pair's gates", () => {
    // Limbo starts LIMBO_LEAD before the cutoff: every withdrawal and every order stops.
    const limbo = marketFlags(cont, state({ scheduledTs: TS + LIMBO_LEAD }), TS, false);
    expect(limbo).toMatchObject({ marketOrdersDisabled: true, positionWithdrawalsFrozen: true, allWithdrawalsPaused: true });
    expect(limbo.reasons.allWithdrawalsPaused).toContain("scheduled termination");
    expect(marketFlags(cont, state({ scheduledTs: TS + LIMBO_LEAD + 1 }), TS, false).allWithdrawalsPaused).toBe(false);
    expect(marketStatusAt({ state: state({ scheduledTs: TS + LIMBO_LEAD + 1 }) }, TS + 1)).toBe("limbo");

    // The settlement window pauses every withdrawal until finalize.
    const settling = marketFlags(cont, state({ settlementFixedTs: TS - 10, scheduledTs: TS - 100 }), TS, false);
    expect(settling.allWithdrawalsPaused).toBe(true);
    expect(settling.reasons.allWithdrawalsPaused).toContain("at most 14 days");
    expect(settling.reasons.marketOrdersDisabled).toContain("settlement price is fixed");

    // Terminated: nothing trades, withdrawals are open again (the terminal path), ADL is cleared.
    const done = marketFlags(cont, state({ terminated: true, settlementFixedTs: TS - 10, adlPending: true }), TS, false);
    expect(done).toMatchObject({ marketOrdersDisabled: true, positionWithdrawalsFrozen: false, allWithdrawalsPaused: false });

    // A 24/7 market never reads closed; an unknown venue is null and gates nothing.
    expect(marketFlags(cont, state(), TS, true).venueClosed).toBe(false);
    expect(marketFlags(hours, state(), TS, null)).toMatchObject({ venueClosed: null, marketOrdersDisabled: false, positionWithdrawalsFrozen: false });
    expect(marketFlags(hours, state(), TS, true).reasons.venueClosed).toContain("within 10%");
  });

  it("helpers", () => {
    expect(annualizedFunding(10n ** 14n)).toBeCloseTo(0.876); // 0.01%/h
    expect(annualizedFunding(-(10n ** 14n), 1_700)).toBeCloseTo(-0.17);
  });
});

describe("getBookDepth", () => {
  interface Node {
    id: bigint;
    price: bigint;
    size: bigint;
    filled?: bigint;
    expiry?: bigint;
    canceled?: bigint;
  }
  const order = (n: Node) => ({
    creator: addr("aa"), canceledBlock: n.canceled ?? 0n, orderType: 1, isLong: true, isPostOnly: false, tif: 0, integrator: addr("00"),
    expiryBlock: n.expiry ?? 2n ** 64n - 1n, inBook: true, maxSlippageBp: 0, triggerPrice: 0n, limitPrice: n.price, size: n.size,
    filledSize: n.filled ?? 0n, prioritySeq: Number(n.id), filledBlock: 0n, restedBlock: 0, restedPremiumPpm: 0, prevInBook: 0, nextInBook: 0,
  });

  function book(t: FakeTransport, bids: Node[], asks: Node[] = []) {
    const pages: Address[] = [];
    t.answer(LENS, "getBookDepth", (args: readonly unknown[]) => {
      const [pairAt, isLong, startId, maxN] = args as [Address, boolean, bigint, bigint];
      pages.push(pairAt);
      const side = isLong ? bids : asks;
      let i = startId === 0n ? 0 : side.findIndex((n) => n.id === startId);
      const ids: bigint[] = [];
      const prices: bigint[] = [];
      while (i >= 0 && i < side.length && ids.length < Number(maxN)) {
        ids.push(side[i]!.id);
        prices.push(side[i]!.price);
        i++;
      }
      return { orderIds: ids, prices, nextId: i < side.length ? side[i]!.id : 0n };
    });
    const all = new Map([...bids, ...asks].map((n) => [n.id, n]));
    t.answer(A, "orders", (args: readonly unknown[]) => order(all.get(args[0] as bigint)!));
    return pages;
  }

  const BIDS: Node[] = [
    { id: 5n, price: 101n * E18, size: 2n * E18 },
    { id: 7n, price: 101n * E18, size: E18, filled: E18 / 2n },
    { id: 9n, price: 100n * E18, size: 3n * E18, expiry: 50n }, // expired, not swept yet
    { id: 11n, price: 99n * E18, size: E18 },
    { id: 12n, price: 98n * E18, size: 4n * E18 },
  ];

  it("pages the side until enough live levels are seen, and sums them", async () => {
    const { t, ctx } = setup();
    await listMarkets(ctx, { metadata: null });
    const pages = book(t, BIDS);
    t.batches.length = 0;
    const d = await getBookDepth(ctx, A, "bids", 2, { pageSize: 2 });
    expect(pages.length).toBe(3); // the expired level forced a third page
    expect(d).toEqual({
      market: A,
      side: "bids",
      block: 100,
      complete: false,
      levels: [
        { price: 101n * E18, size: 5n * E18 / 2n, notional: 252n * E18 + E18 / 2n, orders: 2, cumulative: 5n * E18 / 2n },
        { price: 99n * E18, size: E18, notional: 99n * E18, orders: 1, cumulative: 7n * E18 / 2n },
      ],
    });
    expect(t.batches.every((b) => b.block === toHex(100))).toBe(true);
  });

  it("reports a side it read to the end as complete, and validates its inputs", async () => {
    const { t, ctx } = setup();
    await listMarkets(ctx, { metadata: null });
    book(t, BIDS, [{ id: 20n, price: 102n * E18, size: E18, canceled: 90n }, { id: 21n, price: 103n * E18, size: E18 }]);
    const { bids, asks } = await getBook(ctx, A, 10);
    expect(bids.complete).toBe(true);
    expect(bids.levels.map((l) => [l.price / E18, l.orders])).toEqual([[101n, 2], [99n, 1], [98n, 1]]);
    expect(asks.levels.map((l) => l.price / E18)).toEqual([103n]); // the canceled one is gone
    await expect(getBookDepth(ctx, A, "up" as never)).rejects.toBeInstanceOf(InputError);
    await expect(getBookDepth(ctx, A, "bids", 0)).rejects.toThrow("levels");
  });
});
