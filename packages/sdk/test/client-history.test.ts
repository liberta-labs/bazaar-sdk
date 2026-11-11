import { existsSync, readFileSync } from "node:fs";
import { type Address, type Hex, getAddress, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { Chain } from "../src/chain/client.js";
import type { RequestArgs, Transport } from "../src/chain/rpc.js";
import { InputError } from "../src/client/calls.js";
import type { BazaarContext, SubgraphSource } from "../src/client/context.js";
import * as H from "../src/client/history.js";

const PAIR = getAddress("0x00000000000000000000000000000000000000aa");
const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");
const pairLc = PAIR.toLowerCase();
const aliceLc = ALICE.toLowerCase();
const TX = ("0x" + "AB".repeat(32)) as Hex;

class FakeSubgraph implements SubgraphSource {
  readonly queries: string[] = [];
  constructor(private readonly answer: (q: string) => unknown) {}
  async query<T>(q: string): Promise<T> {
    this.queries.push(q);
    return this.answer(q) as T;
  }
}

class Head implements Transport {
  constructor(private readonly n: number, private readonly ts: number) {}
  async request({ method }: RequestArgs): Promise<unknown> {
    if (method === "eth_getBlockByNumber") return { number: toHex(this.n), timestamp: toHex(this.ts), hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32) };
    throw new Error(method);
  }
}

function ctxWith(sg: SubgraphSource | null, head = new Head(1000, 1_700_000_000)): BazaarContext {
  const z = getAddress("0x00000000000000000000000000000000000000f1");
  return { chain: new Chain(head), chainId: 42161, factory: z, lens: z, terminator: z, oracle: z, usdc: z, prices: null, subgraph: sg, integrator: z };
}

const tradeRow = (ts: number, i: number) => ({
  id: "0x" + "cd".repeat(32) + i.toString(16).padStart(8, "0"),
  pair: { id: pairLc },
  maker: { id: aliceLc },
  taker: "0x0000000000000000000000000000000000000b0b",
  isVaultFill: false,
  takerIsLong: true,
  makerOrder: { orderId: "7" },
  takerOrder: { orderId: "9" },
  size: "2000000000000000000",
  price: "3000000000000000000000",
  notional: "6000000000000000000000",
  makerFee: "150000000000000000",
  takerFee: "450000000000000000",
  makerRemaining: "0",
  takerRemaining: "1000000000000000000",
  makerIntegrator: "0x0000000000000000000000000000000000000000",
  takerIntegrator: "0x00000000000000000000000000000000001e7e67",
  txFrom: "0x0000000000000000000000000000000000000b0b",
  blockNumber: "123456",
  timestamp: String(ts),
  transactionHash: TX,
  logIndex: String(i),
});

describe("history queries", () => {
  it("needs a subgraph", async () => {
    await expect(H.trades(ctxWith(null))).rejects.toThrow(/subgraph/);
  });

  it("reads the trade tape newest first, filtered, typed, and pages with a time cursor", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [tradeRow(150, 1), tradeRow(150, 2)] }));
    const ctx = ctxWith(sg);
    const page = await H.trades(ctx, { pair: PAIR, account: ALICE, from: 100, to: 200, first: 2 });
    const q = sg.queries[0]!;
    expect(q).toContain("rows: trades(first: 2, orderBy: timestamp, orderDirection: desc");
    expect(q).toContain(
      `where: {or: [{pair: "${pairLc}", timestamp_gte: "100", timestamp_lt: "200", maker: "${aliceLc}"}, {pair: "${pairLc}", timestamp_gte: "100", timestamp_lt: "200", taker: "${aliceLc}"}]}`,
    );
    expect(q).toContain("makerOrder { orderId }");
    const t = page.items[0]!;
    expect(t.pair).toBe(PAIR);
    expect(t.maker).toBe(ALICE);
    expect(t.taker).toBe(getAddress("0x0000000000000000000000000000000000000b0b"));
    expect(t.size).toBe(2n * 10n ** 18n);
    expect(t.takerFee).toBe(45n * 10n ** 16n);
    expect(t.makerOrderId).toBe(7n);
    expect(t.takerOrderId).toBe(9n);
    expect(t.timestamp).toBe(150);
    expect(t.blockNumber).toBe(123456);
    expect(t.logIndex).toBe(1);
    expect(t.transactionHash).toBe(TX.toLowerCase());
    expect(page.next).toBe("150:2");

    await H.trades(ctx, { pair: PAIR, first: 2, after: page.next });
    const q2 = sg.queries[1]!;
    expect(q2).toContain("skip: 2");
    expect(q2).toContain(`where: {pair: "${pairLc}", timestamp_lte: "150"}`);
    // a page whose rows all share the cursor's time carries the skip forward
    await H.trades(ctx, { pair: PAIR, first: 2, after: "150:2" }).then((p) => expect(p.next).toBe("150:4"));
  });

  it("ends a list with a short page", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [tradeRow(150, 1)] }));
    expect((await H.trades(ctxWith(sg), { first: 2 })).next).toBeNull();
  });

  it("reads candles oldest first with a unique cursor, and validates the interval", async () => {
    const row = (t: number) => ({
      id: `${pairLc}-3600-${t}`,
      pair: { id: pairLc },
      interval: 3600,
      periodStart: String(t),
      open: "1",
      high: "3",
      low: "1",
      close: "2",
      volumeSize: "10",
      volumeNotional: "20",
      tradeCount: 4,
    });
    const sg = new FakeSubgraph(() => ({ rows: [row(3600), row(7200)] }));
    const ctx = ctxWith(sg);
    const p = await H.candles(ctx, PAIR, 3600, { from: 0, first: 2 });
    expect(sg.queries[0]).toContain(`rows: candles(first: 2, orderBy: periodStart, orderDirection: asc, where: {pair: "${pairLc}", interval: 3600, periodStart_gte: "0"}`);
    expect(p.items[1]).toMatchObject({ periodStart: 7200, close: 2n, tradeCount: 4, interval: 3600 });
    expect(p.next).toBe("7200");
    await H.candles(ctx, PAIR, 3600, { after: p.next, to: 99999 });
    expect(sg.queries[1]).toContain("periodStart_lt: \"99999\", periodStart_gt: \"7200\"");
    await expect(H.candles(ctx, PAIR, 120)).rejects.toThrow(InputError);
  });

  it("fills candle gaps with the previous close", () => {
    const c = (t: number, close: bigint): H.Candle => ({ id: `x-60-${t}`, pair: PAIR, interval: 60, periodStart: t, open: close, high: close, low: close, close, volumeSize: 1n, volumeNotional: 1n, tradeCount: 1 });
    const out = H.fillCandleGaps([c(60, 5n), c(240, 7n)], 60, 0, 300);
    expect(out.map((x) => [x.periodStart, x.close, x.tradeCount])).toEqual([
      [60, 5n, 1],
      [120, 5n, 0],
      [180, 5n, 0],
      [240, 7n, 1],
    ]);
  });

  // Without bounds the fill would allocate one candle per period, and loop forever on interval <= 0.
  it("refuses gap fills it cannot bound: unknown intervals, off-grid or unsafe starts, too long a span", () => {
    const c = (t: number, interval = 60): H.Candle => ({ id: `x-${interval}-${t}`, pair: PAIR, interval, periodStart: t, open: 1n, high: 1n, low: 1n, close: 1n, volumeSize: 0n, volumeNotional: 0n, tradeCount: 1 });
    const refused = (f: () => unknown, field: string, msg: RegExp) => {
      let err: unknown = null;
      try {
        f();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).field).toBe(field);
      expect((err as InputError).message).toMatch(msg);
    };
    for (const bad of [0, -60, 61, 1.5, Number.NaN]) refused(() => H.fillCandleGaps([c(60)], bad), "interval", /must be one of 60, 300/);
    refused(() => H.fillCandleGaps([c(60), c(90)], 60), "rows", /whole 60-second period; one starts at 90/);
    refused(() => H.fillCandleGaps([c(1e300)], 60), "rows", /whole 60-second period/);
    refused(() => H.fillCandleGaps([c(-60)], 60), "rows", /whole 60-second period/);
    refused(() => H.fillCandleGaps([c(60)], 60, 1.5), "from", /whole seconds/);
    refused(() => H.fillCandleGaps([c(60)], 60, 0, Number.POSITIVE_INFINITY), "to", /whole seconds/);
    // 200,000 empty minutes between two candles: refused before anything is allocated.
    const t0 = 1_700_000_040;
    refused(() => H.fillCandleGaps([c(t0), c(t0 + 60 * 200_000)], 60), "rows", /200001 candles of 60 seconds, more than the 100000/);
    refused(() => H.fillCandleGaps([c(t0)], 60, t0, t0 + 60 * 100_001), "to", /more than the 100000/);
    expect(H.fillCandleGaps([c(t0)], 60, t0, t0 + 60 * H.MAX_FILLED_CANDLES)).toHaveLength(H.MAX_FILLED_CANDLES);
  });

  it("reads an account's open orders with names decoded", async () => {
    const row = {
      id: `${pairLc}-7`,
      pair: { id: pairLc },
      orderId: "7",
      owner: { id: aliceLc },
      orderType: "StopLoss",
      isLong: false,
      isPostOnly: false,
      timeInForce: "GTC",
      integrator: "0x0000000000000000000000000000000000000000",
      size: (2n ** 128n - 1n).toString(),
      filledSize: "0",
      remaining: "1000",
      triggerPrice: "2900000000000000000000",
      limitPrice: "0",
      maxSlippageBp: "100",
      expiryBlock: "18446744073709551615",
      prioritySeq: "7",
      status: "Canceled",
      inBook: false,
      cancelReason: "Margin",
      createdBlock: "10",
      createdTimestamp: "1000",
      createdTx: TX,
      triggerCount: 0,
      lastTriggeredTimestamp: null,
      canceledBlock: "12",
      canceledTimestamp: "1010",
      filledBlock: null,
      filledTimestamp: null,
      updatedTimestamp: "1010",
      amendCount: 0,
      fillCount: 0,
      bountyEscrowed: "1000000000000000000",
      bountyHeld: "0",
      bountyPaidToKeepers: "0",
      bountyRefunded: "1000000000000000000",
    };
    const sg = new FakeSubgraph(() => ({ rows: [row] }));
    const p = await H.orders(ctxWith(sg), { account: ALICE, openOnly: true });
    expect(sg.queries[0]).toContain(`where: {owner: "${aliceLc}", status_in: [Waiting, Resting, Fired]}`);
    expect(sg.queries[0]).toContain("orderBy: createdTimestamp, orderDirection: desc");
    const o = p.items[0]!;
    expect(o).toMatchObject({ orderId: 7n, owner: ALICE, cancelReason: "Margin", orderType: "StopLoss", maxSlippageBp: 100n, lastTriggeredTimestamp: null, canceledBlock: 12 });
    expect(o.expiryBlock).toBe(Number(2n ** 64n - 1n));
    expect(H.CANCEL_REASON_TEXT[o.cancelReason]).toMatch(/collateral/);
    expect(H.cancelReasonName(8)).toBe("Margin");
    expect(H.cancelReasonName(12)).toBe("Deleveraged");
    expect(() => H.cancelReasonName(13)).toThrow(RangeError);
    await expect(H.orders(ctxWith(sg), { status: ["Bogus" as H.OrderStatus] })).rejects.toThrow(InputError);
  });

  it("looks up one order and its events", async () => {
    const sg = new FakeSubgraph(() => ({ row: null, rows: [] }));
    const ctx = ctxWith(sg);
    expect(await H.order(ctx, PAIR, 7n)).toBeNull();
    expect(sg.queries[0]).toContain(`row: order(id: "${pairLc}-7")`);
    await H.orderEvents(ctx, { pair: PAIR, orderId: 7n, action: ["Canceled"] });
    expect(sg.queries[1]).toContain(`where: {pair: "${pairLc}", order: "${pairLc}-7", action_in: [Canceled]}`);
    await expect(H.orderEvents(ctx, { orderId: 7n })).rejects.toThrow(/pair/);
  });

  it("pages id-ordered lists with id_gt", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [] }));
    const ctx = ctxWith(sg);
    await H.positions(ctx, { account: ALICE, openOnly: true, after: `${pairLc}-${aliceLc}` });
    expect(sg.queries[0]).toContain(`orderBy: id, orderDirection: asc, where: {account: "${aliceLc}", isOpen: true, id_gt: "${pairLc}-${aliceLc}"}`);
    await H.feeBalances(ctx, { recipient: ALICE, claimableOnly: true });
    expect(sg.queries[1]).toContain(`where: {recipient: "${aliceLc}", claimable_gt: "0"}`);
    await H.insuranceProviders(ctx, { pair: PAIR, activeOnly: true, atBlock: 99 });
    expect(sg.queries[2]).toContain(`where: {pair: "${pairLc}", shares_gt: "0"}, block: {number: 99}`);
  });

  it("orders the book best price first", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [{ id: `${pairLc}-bid-1`, pair: { id: pairLc }, isBid: true, price: "1", size: "2", orderCount: 3 }] }));
    const ctx = ctxWith(sg);
    const p = await H.bookLevels(ctx, PAIR, { side: "bid" });
    expect(sg.queries[0]).toContain(`rows: bookLevels(first: 100, orderBy: price, orderDirection: desc, where: {pair: "${pairLc}", isBid: true}`);
    expect(p.items[0]).toMatchObject({ isBid: true, price: 1n, size: 2n, orderCount: 3 });
    await H.bookLevels(ctx, PAIR, { side: "ask" });
    expect(sg.queries[1]).toContain("orderDirection: asc");
  });

  it("refuses bad inputs before querying", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [] }));
    const ctx = ctxWith(sg);
    await expect(H.trades(ctx, { pair: "0x123" as Address })).rejects.toThrow(InputError);
    await expect(H.trades(ctx, { first: 0 })).rejects.toThrow(/first/);
    await expect(H.trades(ctx, { first: 1001 })).rejects.toThrow(/first/);
    await expect(H.trades(ctx, { after: '1"} injected' })).rejects.toThrow(/cursor/);
    await expect(H.trades(ctx, { from: -1 })).rejects.toThrow(/from/);
    await expect(H.adlBatches(ctx, { window: "x" })).rejects.toThrow(/window/);
    await expect(H.adlFills(ctx, { transactionHash: "0x12" as Hex })).rejects.toThrow(/transactionHash/);
    expect(sg.queries).toEqual([]);
  });

  it("converts insurer proposals, listings and the USDC-denominated fields", async () => {
    const sg = new FakeSubgraph((q) =>
      q.includes("insurerProposals")
        ? {
            rows: [
              {
                id: TX,
                pair: { id: pairLc },
                proposer: { id: aliceLc },
                cutoffTs: "2000",
                windowOpenTs: "1500",
                claimBacked: true,
                snapshotTotalShares: null,
                snapshotShareEpoch: null,
                yesShares: "5",
                status: "Open",
                thresholdMet: null,
                outcome: null,
                costed: null,
                levyBp: 2500,
                bondRefundFailed: false,
                createdAt: "1400",
                resolvedAt: null,
                transactionHash: TX,
              },
            ],
          }
        : {
            row: {
              id: aliceLc,
              firstSeenTimestamp: "1",
              tradeCount: "3",
              makerVolumeNotional: "1",
              takerVolumeNotional: "2",
              feesPaid: "3",
              realizedPnl: "-4",
              liquidationCount: 0,
              liquidationsExecuted: 1,
              triggerBountiesEarned: "5",
              triggerExecutions: 2,
              adlBatchesExecuted: 0,
              feesAccrued: "6",
              feesClaimed: "7",
              seedRefundOwedUsdc: "3000000000",
            },
          },
    );
    const ctx = ctxWith(sg);
    const ip = (await H.insurerProposals(ctx, { status: ["Open"] })).items[0]!;
    expect(ip).toMatchObject({ id: TX.toLowerCase(), levyBp: 2500n, snapshotTotalShares: null, cutoffTs: 2000, claimBacked: true });
    expect(sg.queries[0]).toContain("orderBy: createdAt");
    const a = (await H.accountStats(ctx, ALICE))!;
    expect(a).toMatchObject({ account: ALICE, tradeCount: 3, realizedPnl: -4n, seedRefundOwedUsdc: 3_000_000_000n });
  });

  it("measures how far the subgraph trails the chain", async () => {
    const sg = new FakeSubgraph(() => ({ _meta: { block: { number: 990, timestamp: 1_699_999_990 }, hasIndexingErrors: false } }));
    const lag = await H.subgraphLag(ctxWith(sg, new Head(1000, 1_700_000_000)));
    expect(lag).toEqual({
      indexedBlock: 990,
      indexedTimestamp: 1_699_999_990,
      chainBlock: 1000,
      chainTimestamp: 1_700_000_000,
      blocksBehind: 10,
      secondsBehind: 10,
      hasIndexingErrors: false,
    });
    const sg2 = new FakeSubgraph(() => ({ _meta: { block: { number: 1005 }, hasIndexingErrors: true } }));
    const lag2 = await H.subgraphLag(ctxWith(sg2));
    expect(lag2).toMatchObject({ blocksBehind: 0, secondsBehind: null, indexedTimestamp: null, hasIndexingErrors: true });
  });
});

describe("httpSubgraph", () => {
  const KEYED = "https://gateway.thegraph.com/api/0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d/subgraphs/id/Bazaar";

  function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch;
    return { f, calls };
  }

  it("posts the query as JSON with a bearer key", async () => {
    const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 }));
    const sg = H.httpSubgraph("https://example.org/subgraphs/bazaar", "secret-key", { fetch: f });
    expect(await sg.query("{ x }", { a: 1 })).toEqual({ ok: 1 });
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "{ x }", variables: { a: 1 } });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
  });

  it("never puts the raw URL or the key in an error", async () => {
    const http = H.httpSubgraph(KEYED, null, { fetch: fakeFetch(() => new Response("nope", { status: 401 })).f });
    const e1 = (await http.query("{ x }").then(() => null, (e: unknown) => e)) as H.SubgraphError;
    expect(e1).toBeInstanceOf(H.SubgraphError);
    expect(e1.status).toBe(401);
    expect(e1.message).toContain("HTTP 401");
    expect(e1.message).not.toContain("0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d");

    const down = H.httpSubgraph(KEYED, null, {
      fetch: fakeFetch(() => {
        throw new TypeError(`request to ${KEYED} failed, reason: ECONNREFUSED`);
      }).f,
    });
    const e2 = (await down.query("{ x }").then(() => null, (e: unknown) => e)) as Error;
    expect(e2.message).toMatch(/unreachable/);
    expect(e2.message).not.toContain("0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d");

    const gql = H.httpSubgraph(KEYED, null, { fetch: fakeFetch(() => new Response(JSON.stringify({ errors: [{ message: "Type `Query` has no field `nope`" }] }))).f });
    await expect(gql.query("{ nope }")).rejects.toThrow(/refused the query: Type `Query` has no field `nope`/);
  });
});

// The selections must name fields Bazaar's schema has. Checked against the schema when the Bazaar
// checkout is next to this one (it is not shipped with the SDK).
const SCHEMA = "C:/projects/bazaar/subgraph/schema.graphql";

describe.skipIf(!existsSync(SCHEMA))("selections match schema.graphql", () => {
  const types = new Map<string, Map<string, string>>();
  for (const m of readFileSync(SCHEMA, "utf8").matchAll(/type (\w+) @entity[^{]*\{([^}]*)\}/g)) {
    const fields = new Map<string, string>();
    for (const line of m[2]!.split("\n")) {
      const f = /^\s*(\w+):\s*\[?(\w+)/.exec(line);
      if (f) fields.set(f[1]!, f[2]!);
    }
    types.set(m[1]!, fields);
  }
  const ENTITY: Record<string, string> = {
    trades: "Trade", candles: "Candle", pairDayDatas: "PairDayData", protocolDayDatas: "ProtocolDayData", bookLevels: "BookLevel",
    orders: "Order", order: "Order", orderEvents: "OrderEvent", positions: "Position", positionChanges: "PositionChange",
    positionSnapshots: "PositionSnapshot", collateralTransfers: "CollateralTransfer", feeBalances: "FeeBalance", feeAccruals: "FeeAccrual",
    feeClaims: "FeeClaim", integratorStats: "IntegratorStats", account: "Account", accountDayDatas: "AccountDayData",
    metaTransactions: "MetaTransaction", permitFailures: "PermitFailure", liquidations: "Liquidation", adlWindows: "AdlWindow",
    adlBatches: "AdlBatch", adlFills: "AdlFill", insuranceProviders: "InsuranceProvider", insuranceEvents: "InsuranceEvent",
    pairTerminations: "PairTermination", terminalRatioUpdates: "TerminalRatioUpdate", terminationProposals: "TerminationProposal",
    insurerProposals: "InsurerProposal", insurerVotes: "InsurerVote", insurerLevies: "InsurerLevy", listingProposals: "ListingProposal",
    identifierUpgradeProposals: "IdentifierUpgradeProposal",
  };

  it("for every query", async () => {
    const sg = new FakeSubgraph(() => ({ rows: [], row: null }));
    const ctx = ctxWith(sg);
    await Promise.all([
      H.trades(ctx), H.candles(ctx, PAIR, 60), H.pairDayData(ctx, PAIR), H.protocolDayData(ctx), H.bookLevels(ctx, PAIR, { side: "ask" }),
      H.orders(ctx), H.order(ctx, PAIR, 1n), H.orderEvents(ctx), H.positions(ctx), H.positionChanges(ctx), H.positionSnapshots(ctx),
      H.collateralTransfers(ctx), H.feeBalances(ctx), H.feeAccruals(ctx), H.feeClaims(ctx), H.integratorStats(ctx, ALICE),
      H.accountStats(ctx, ALICE), H.accountDayData(ctx, ALICE), H.metaTransactions(ctx), H.permitFailures(ctx), H.liquidations(ctx),
      H.adlWindows(ctx), H.adlBatches(ctx), H.adlFills(ctx), H.insuranceProviders(ctx), H.insuranceEvents(ctx), H.pairTerminations(ctx),
      H.terminalRatioUpdates(ctx), H.terminationProposals(ctx), H.insurerProposals(ctx), H.insurerVotes(ctx), H.insurerLevies(ctx),
      H.listingProposals(ctx), H.identifierUpgradeProposals(ctx),
    ]);
    expect(sg.queries).toHaveLength(Object.keys(ENTITY).length);
    for (const q of sg.queries) {
      const m = /\{ (?:rows|row): (\w+)\(([^)]*)\) \{ (.*) \} \}$/.exec(q)!;
      expect(m, q).toBeTruthy();
      const typeName = ENTITY[m[1]!]!;
      const fields = types.get(typeName)!;
      expect(fields, m[1]).toBeTruthy();
      const orderBy = /orderBy: (\w+)/.exec(m[2]!);
      if (orderBy) expect(fields.has(orderBy[1]!), `${typeName}.${orderBy[1]}`).toBe(true);
      const where = /where: \{(.*)\}/.exec(m[2]!);
      for (const k of where ? [...where[1]!.matchAll(/(\w+):/g)].map((x) => x[1]!.replace(/_(gte|gt|lte|lt|in|not)$/, "")) : []) {
        if (k !== "or") expect(fields.has(k), `${typeName} filter ${k}`).toBe(true);
      }
      for (const sel of m[3]!.matchAll(/(\w+)(?: \{ (\w+) \})?/g)) {
        const [, field, sub] = sel;
        expect(fields.has(field!), `${typeName}.${field}`).toBe(true);
        if (sub) expect(types.get(fields.get(field!)!)!.has(sub), `${typeName}.${field}.${sub}`).toBe(true);
      }
    }
  });
});
