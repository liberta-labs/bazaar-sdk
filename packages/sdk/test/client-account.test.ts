import { type Address, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { accountHealth, accountSnapshot, portfolio } from "../src/client/account.js";
import { type LivePriceView, listMarkets, marketSnapshot } from "../src/client/markets.js";
import { TAKE_PROFIT } from "../src/constants.js";
import { E18, FACTORY, FakeTransport, LENS, type MarketFixture, USDC, addr, contextFor, h32, withMarket } from "./client-reads-fakes.js";

const A = addr("0a");
const B = addr("0b");
const ALICE = addr("aa");
const TS = 1_700_000_000;
const UINT128_MAX = (1n << 128n) - 1n;

const order = (over: Record<string, unknown> = {}) => ({
  creator: ALICE, canceledBlock: 0n, orderType: 1, isLong: true, isPostOnly: false, tif: 0, integrator: addr("1f"),
  expiryBlock: 400n, inBook: true, maxSlippageBp: 0, triggerPrice: 0n, limitPrice: 1_900n * E18, size: E18, filledSize: 0n,
  prioritySeq: 21, filledBlock: 0n, restedBlock: 0, restedPremiumPpm: 0, prevInBook: 0, nextInBook: 0, ...over,
});

interface AccountFixture {
  bucket?: Record<string, unknown>;
  orderIds?: bigint[];
  orders?: Map<bigint, Record<string, unknown>>;
  bounties?: Map<bigint, bigint>;
  claimable?: bigint;
  allowance?: bigint;
  terminal?: Record<string, bigint>;
}

/** Answers for ALICE's reads on `m`; records the prices the lens was asked at. */
function withAccount(t: FakeTransport, m: Address, f: AccountFixture = {}) {
  const asked = { solvency: [] as bigint[], maxWithdrawable: [] as bigint[] };
  const bucket = { isLong: true, size: 0n, entryValue: 0n, collateral: 0n, entryFundingIndex: 0n, takeProfitOrderId: 0n, stopLossOrderId: 0n, ...f.bucket };
  const orders = f.orders ?? new Map();
  const bounties = f.bounties ?? new Map();
  t.answer(LENS, "getPositionBucket", bucket, m)
    .answer(LENS, "getUserActiveLimitOrders", { orderIds: f.orderIds ?? [], count: BigInt(f.orderIds?.length ?? 0), longExposure: 0n, shortExposure: 0n }, m)
    .answer(m, "orders", (args: readonly unknown[]) => orders.get(args[0] as bigint) ?? new Error("revert"))
    .answer(LENS, "triggerBounty", (args: readonly unknown[]) => bounties.get(args[1] as bigint) ?? 0n, m)
    .answer(LENS, "checkBucketSolvency", (args: readonly unknown[]) => {
      asked.solvency.push(args[2] as bigint);
      return {
        unrealizedPnl: 1n, fundingPnl: 2n, totalPnl: 3n, adjustedSize: 4n, currentNotional: 5n, entryValue: 6n, minRequiredCollateral: 7n,
        availableEquity: 8n, effectiveCollateral: 9n, adjustedEntryFundingIndex: 10n, isSolvent: true,
      };
    }, m)
    .answer(LENS, "getMaxWithdrawable", (args: readonly unknown[]) => {
      asked.maxWithdrawable.push(args[2] as bigint);
      return 123n * E18;
    }, m)
    .answer(LENS, "outstandingOrderExposure", { longExposure: 1_900n * E18, shortExposure: 0n, longSize: E18, shortSize: 0n }, m)
    .answer(m, "metaTxNonces", 7n)
    .answer(LENS, "getTerminalEntitlement", f.terminal ?? { collateral: 0n, registeredClaim: 0n, principalRatio: 0n, profitRatio: 0n, payout: 0n }, m)
    .answer(USDC, "allowance", (args: readonly unknown[]) => (args[1] === m ? (f.allowance ?? 1_000_000n) : 0n));
  return asked;
}

function setup(a: Partial<MarketFixture> = {}, b: Partial<MarketFixture> = {}) {
  const t = new FakeTransport(100, TS);
  withMarket(t, { address: A, pairId: h32("a1"), baseFeedId: h32("f1"), laggedMmrBp: 150n, ...a });
  withMarket(t, { address: B, pairId: h32("b1"), baseFeedId: h32("f2"), continuous: false, ...b });
  t.answer(FACTORY, "getAllPairs", [A, B]);
  t.answer(USDC, "balanceOf", 25_000_000n);
  t.answer(LENS, "getClaimableFees", (args: readonly unknown[]) => (args[0] as Address[]).map((p) => (p === A ? 4n * E18 : 0n)));
  return { t, ctx: contextFor(t) };
}

const LONG = {
  bucket: { isLong: true, size: 2n * E18, entryValue: 3_900n * E18, collateral: 500n * E18, takeProfitOrderId: 31n },
  orderIds: [21n, 22n],
  orders: new Map<bigint, Record<string, unknown>>([
    [21n, order()],
    [22n, order({ orderType: 2, isLong: false, inBook: false, triggerPrice: 1_800n * E18, limitPrice: 1_790n * E18, size: 3n * E18, filledSize: E18 })],
    [31n, order({ orderType: TAKE_PROFIT, isLong: false, inBook: false, triggerPrice: 2_500n * E18, limitPrice: 0n, size: UINT128_MAX, expiryBlock: 2n ** 64n - 1n })],
  ]),
  bounties: new Map([[22n, 3n * E18], [31n, 2n * E18]]),
};

describe("accountSnapshot", () => {
  it("reads a position, its health, its orders and what it can withdraw in two batches", async () => {
    const { t, ctx } = setup();
    const asked = withAccount(t, A, LONG);
    const [a] = await listMarkets(ctx, { metadata: null });
    t.batches.length = 0;
    const s = await accountSnapshot(ctx, a!, ALICE.toLowerCase() as Address);
    // phase 1, then phase 2 with the market's state read beside it, all at the head
    expect(t.batches.map((b) => b.block)).toEqual([toHex(100), toHex(100), toHex(100)]);

    expect(s).toMatchObject({ user: ALICE, block: 100, timestamp: TS, status: "live", hasPosition: true, nonce: 7n, claimableFees: 4n * E18 });
    expect(s.position).toEqual({
      isLong: true, size: 2n * E18, entryValue: 3_900n * E18, entryPrice: 1_950n * E18, collateral: 500n * E18, entryFundingIndex: 0n,
      takeProfitOrderId: 31n, stopLossOrderId: 0n,
    });
    // No live price: the pair's stored one; the lens values a long's withdrawal at the low side.
    expect(s.price).toEqual({ spot: 2_000n * E18, low: 1_999n * E18, high: 2_001n * E18, publishTime: TS - 2, source: "stored" });
    expect(asked).toEqual({ solvency: [2_000n * E18], maxWithdrawable: [1_999n * E18] });
    expect(s.health).toMatchObject({
      price: 2_000n * E18, notional: 4_000n * E18, unrealizedPnl: 100n * E18, fundingPnl: 0n, equity: 600n * E18,
      maintenanceRequired: 60n * E18, // the lagged 1.5% beats the current 2%
      marginRatio: 10, isSolvent: true,
    });
    expect(s.health!.leverage).toBeCloseTo(6.667, 3);
    expect(s.solvency).toMatchObject({ effectiveCollateral: 9n, isSolvent: true });
    expect(s.maxWithdrawable).toBe(123n * E18);
    expect(s.withdrawalBlocked).toBeNull();
    expect(s.exposure).toEqual({ longNotional: 1_900n * E18, shortNotional: 0n, longSize: E18, shortSize: 0n });
    expect(s.wallet).toEqual({ usdcBalance: 25_000_000n, usdcAllowance: 1_000_000n });
    expect(s.terminal).toBeNull();

    expect(s.orders.map((o) => [o.orderId, o.typeName, o.attached])).toEqual([
      [21n, "Limit", null],
      [22n, "StopLimit", null],
      [31n, "TakeProfit", "takeProfit"],
    ]);
    const [limit, stop, tp] = s.orders;
    expect(limit).toMatchObject({ remaining: E18, inBook: true, blocksLeft: 300, neverExpires: false, bounty: 0n, integrator: addr("1f") });
    expect(stop).toMatchObject({ triggerPrice: 1_800n * E18, limitPrice: 1_790n * E18, remaining: 2n * E18, inBook: false, bounty: 3n * E18 });
    // A TP sized "everything" closes the position as it is: its remaining is the position's size.
    expect(tp).toMatchObject({ remaining: 2n * E18, closesWholePosition: true, neverExpires: true, blocksLeft: null, bounty: 2n * E18 });
    expect(s.takeProfit).toBe(tp);
    expect(s.stopLoss).toBeNull();

    // Revalued at a new price without any read.
    const n = t.requests.length;
    expect(accountHealth(s, 2_100n * E18)).toMatchObject({ unrealizedPnl: 300n * E18, equity: 800n * E18 });
    expect(t.requests.length).toBe(n);
  });

  it("values at the live price, short side at the high edge, and drops orders that are no longer live", async () => {
    const { t, ctx } = setup();
    const asked = withAccount(t, A, {
      bucket: { isLong: false, size: E18, entryValue: 2_050n * E18, collateral: 200n * E18 },
      orderIds: [21n, 23n],
      orders: new Map([[21n, order()], [23n, order({ canceledBlock: 99n })]]),
    });
    await listMarkets(ctx, { metadata: null });
    const view: LivePriceView = { price: () => ({ spot: 2_100n * E18, low: 2_095n * E18, high: 2_105n * E18, publishTime: TS }), venueClosed: () => false };
    const s = await accountSnapshot(ctx, A, ALICE, { prices: view });
    expect(s.price).toMatchObject({ spot: 2_100n * E18, source: "live" });
    expect(asked).toEqual({ solvency: [2_100n * E18], maxWithdrawable: [2_105n * E18] });
    expect(s.health).toMatchObject({ unrealizedPnl: -50n * E18, equity: 150n * E18 });
    expect(s.orders.map((o) => o.orderId)).toEqual([21n]);

    // A price the caller holds wins over the live one.
    const given = await accountSnapshot(ctx, A, ALICE, { prices: view, price: { spot: 2_000n * E18 } });
    expect(given.price).toMatchObject({ spot: 2_000n * E18, low: 2_000n * E18, high: 2_000n * E18, source: "given" });
  });

  it("without live prices, asks the context's Hermes source for the legs (beside the first read)", async () => {
    const { t, ctx } = setup();
    withAccount(t, A, { bucket: { isLong: true, size: E18, entryValue: 2_000n * E18, collateral: 300n * E18 } });
    const now = Math.floor(Date.now() / 1000);
    const prices = {
      async latest() {
        return { update: [], publishTime: 0 };
      },
      async prints(ids: readonly `0x${string}`[]) {
        expect(ids).toEqual([h32("f1")]);
        return [{ feedId: h32("f1"), price: 210_000_000_000n, conf: 100_000_000n, expo: -8, publishTime: now, prevPublishTime: null, blob: "0x" as const, received: 0 }];
      },
    };
    const ctx2 = { ...ctx, prices };
    await listMarkets(ctx2, { metadata: null });
    const s = await accountSnapshot(ctx2, A, ALICE);
    expect(s.price).toEqual({ spot: 2_100n * E18, low: 2_099n * E18, high: 2_101n * E18, publishTime: now, source: "hermes" });
    expect(s.health).toMatchObject({ unrealizedPnl: 100n * E18 });
    expect((await accountSnapshot(ctx2, A, ALICE, { fetchPrices: false })).price?.source).toBe("stored");
  });

  it("reuses a market snapshot: no block read and no second state read", async () => {
    const { t, ctx } = setup();
    withAccount(t, A, LONG);
    await listMarkets(ctx, { metadata: null });
    const snap = await marketSnapshot(ctx, A);
    const blocks = t.count("eth_getBlockByNumber");
    t.batches.length = 0;
    const s = await accountSnapshot(ctx, A, ALICE, { market: snap });
    expect(t.count("eth_getBlockByNumber")).toBe(blocks);
    expect(t.batches.length).toBe(2);
    expect(s.state).toBe(snap.state);
  });

  it("says why a position cannot withdraw: a closed venue blocks a holder, not a flat account", async () => {
    const { t, ctx } = setup();
    withAccount(t, B, { bucket: { isLong: true, size: E18, entryValue: 2_000n * E18, collateral: 400n * E18 } });
    await listMarkets(ctx, { metadata: null });
    const closed: LivePriceView = { price: () => null, venueClosed: () => true };
    const s = await accountSnapshot(ctx, B, ALICE, { prices: closed });
    expect(s.flags.venueClosed).toBe(true);
    expect(s.withdrawalBlocked).toContain("venue is closed");
    expect(s.price?.source).toBe("stored"); // no live print: the stored price

    const t2 = setup();
    withAccount(t2.t, B, { bucket: { collateral: 400n * E18 } });
    await listMarkets(t2.ctx, { metadata: null });
    const flat = await accountSnapshot(t2.ctx, B, ALICE, { prices: closed });
    expect(flat.hasPosition).toBe(false);
    expect(flat.health).toBeNull();
    expect(flat.withdrawalBlocked).toBeNull();
    expect(flat.solvency).not.toBeNull();
  });

  it("shows the terminal entitlement while the market settles", async () => {
    const { t, ctx } = setup({ settlementFixedTs: TS - 60, scheduledTs: TS - 600 });
    withAccount(t, A, {
      bucket: { collateral: 300n * E18 },
      terminal: { collateral: 300n * E18, registeredClaim: 50n * E18, principalRatio: E18, profitRatio: E18 / 2n, payout: 325n * E18 },
    });
    await listMarkets(ctx, { metadata: null });
    const s = await accountSnapshot(ctx, A, ALICE);
    expect(s.status).toBe("settling");
    expect(s.terminal).toEqual({ collateral: 300n * E18, registeredClaim: 50n * E18, principalRatio: E18, profitRatio: E18 / 2n, payout: 325n * E18 });
    expect(s.withdrawalBlocked).toContain("Withdrawals are paused");
  });
});

describe("portfolio", () => {
  it("reads 50 markets in a handful of calls and keeps the ones the account uses", async () => {
    const t = new FakeTransport(100, TS);
    const markets: Address[] = [];
    for (let i = 0; i < 50; i++) {
      const a = addr((0x10 + i).toString(16).padStart(2, "0"));
      markets.push(a);
      withMarket(t, { address: a, pairId: h32((0x10 + i).toString(16)), baseFeedId: h32("f1") });
      withAccount(t, a);
    }
    const [m0, m1] = [markets[0]!, markets[1]!];
    withAccount(t, m0, LONG);
    t.answer(FACTORY, "getAllPairs", markets);
    t.answer(USDC, "balanceOf", 9_000_000n);
    t.answer(LENS, "getClaimableFeesAll", { pairs: markets, owed: markets.map((a) => (a === m1 ? 5n * E18 : 0n)) });
    const ctx = contextFor(t);
    await listMarkets(ctx, { metadata: null });
    t.batches.length = 0;
    const requests = t.requests.length;
    const p = await portfolio(ctx, ALICE);
    expect(p.accounts.map((a) => a.market.address)).toEqual([m0, m1]);
    expect(t.batches.length).toBe(3); // every market's position, then the two markets' details beside their state read
    expect(t.requests.length - requests).toBe(4); // + the head
    expect(p.walletUsdc).toBe(9_000_000n);
    expect(p.accounts[1]).toMatchObject({ hasPosition: false, claimableFees: 5n * E18, health: null });
    expect(p.totals).toEqual({
      collateral: 500n * E18,
      equity: 600n * E18,
      unrealizedPnl: 100n * E18,
      fundingPnl: 0n,
      claimableFees: 5n * E18,
      maxWithdrawable: 246n * E18,
    });
  });

  it("picks up a market listed since the list was cached when it owes the account fees", async () => {
    const { t, ctx } = setup();
    withAccount(t, A);
    withAccount(t, B);
    await listMarkets(ctx, { metadata: null });
    const C = addr("0d");
    withMarket(t, { address: C, pairId: h32("d1"), baseFeedId: h32("f3") });
    withAccount(t, C);
    t.answer(FACTORY, "getAllPairs", [A, B, C]);
    t.answer(LENS, "getClaimableFeesAll", { pairs: [A, B, C], owed: [0n, 0n, 2n * E18] });
    t.answer(LENS, "getClaimableFees", (args: readonly unknown[]) => (args[0] as Address[]).map((x) => (x === C ? 2n * E18 : 0n)));
    const p = await portfolio(ctx, ALICE);
    expect(p.accounts.map((a) => [a.market.address, a.claimableFees])).toEqual([[C, 2n * E18]]);

    // With explicit markets, only those are read (getClaimableFees on them).
    const only = await portfolio(ctx, ALICE, [A, B]);
    expect(only.accounts).toEqual([]);
  });
});
