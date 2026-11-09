import { type Abi, type Address, getAddress, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { bazaarPairTerminatorAbi } from "../src/abi/index.js";
import type { RawLog } from "../src/chain/codec.js";
import { RpcError, type RequestArgs } from "../src/chain/rpc.js";
import {
  type AccountUpdate,
  type FollowNotice,
  type LiveEvent,
  LogFollower,
  type MarketUpdate,
  decodeLiveLog,
  watchAccount,
  watchMarket,
} from "../src/client/live.js";
import { listMarkets } from "../src/client/markets.js";
import { E18, FACTORY, FakeTransport, LENS, TERMINATOR, USDC, addr, contextFor, h32, withMarket } from "./client-reads-fakes.js";

const A = addr("0a");
const B = addr("0b");
const ALICE = addr("aa");
const BOB = addr("bb");
const PAIR_ID = h32("a1");
const TS = 1_700_000_000;

const payload = (over: Record<string, unknown> = {}) => ({
  action: 0, orderType: 1, isLong: true, isPostOnly: false, size: E18, filledSize: 0n, triggerPrice: 0n, limitPrice: 1_900n * E18,
  maxSlippageBp: 0n, canceledBlock: 0n, filledBlock: 0n, expiryBlock: 2n ** 64n - 1n, prioritySeq: 41n, tif: 0, integrator: addr("1f"),
  cancelReason: 0, ...over,
});

const trade = (maker: Address, taker: Address) => ({
  pairId: PAIR_ID, maker, taker, makerOrderId: 1n, takerOrderId: 2n, takerIsLong: true, fillSize: E18, price: 2_000n * E18,
  makerFee: 1n, takerFee: 2n, makerRemaining: 0n, takerRemaining: 0n,
});

const toRaw = (t: FakeTransport): RawLog[] =>
  t.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: l.logIndex }));

function follower(t: FakeTransport, opts: ConstructorParameters<typeof LogFollower>[4] = {}) {
  const ctx = contextFor(t);
  const got: RawLog[][] = [];
  const notices: FollowNotice[] = [];
  const f = new LogFollower(ctx.chain, () => [A], (logs) => void got.push(logs), (n) => notices.push(n), { pollMs: 60_000, ...opts });
  return { f, got, notices, delivered: () => got.flat().map((l) => `${l.blockNumber}:${l.logIndex}`) };
}

describe("decodeLiveLog", () => {
  it("types pair events by the SDK's units and terminator events by the pair they name", () => {
    const t = new FakeTransport(10, TS);
    t.emit(A, "OrderUpdated", { pairId: PAIR_ID, orderId: 41n, owner: ALICE, payload: payload({ action: 2, cancelReason: 1, canceledBlock: 9n }) });
    t.emit(A, "Trade", trade(ALICE, BOB));
    t.emit(A, "NewPriceUpdateAdded", { pairId: PAIR_ID, targetPublishTs: BigInt(TS), spotPrice: 2_000n * E18, exponent: -18, fundingIndex: -5n });
    t.emit(A, "AdlTriggered", { pairId: PAIR_ID, adlEpoch: 4n, price: E18, fundingIndex: 0n });
    t.emit(TERMINATOR, "SettlementPriceFixed", { pair: A, settlementPrice: 7n }, 10, bazaarPairTerminatorAbi as unknown as Abi);
    t.emit(TERMINATOR, "TerminationProposalDisputed", { assertionId: h32("ee") }, 10, bazaarPairTerminatorAbi as unknown as Abi);
    const [upd, tr, price, adl, fixed, disputed] = toRaw(t).map((l) => decodeLiveLog(l, TERMINATOR));
    expect(upd).toMatchObject({ source: "pair", name: "OrderUpdated", market: A, blockNumber: 10, logIndex: 0 });
    expect((upd as Extract<LiveEvent, { name: "OrderUpdated" }>).args).toMatchObject({
      orderId: 41n,
      owner: ALICE,
      payload: { action: 2, cancelReason: 1, canceledBlock: 9, expiryBlock: 2 ** 64, prioritySeq: 41, size: E18, maxSlippageBp: 0n },
    });
    expect(tr).toMatchObject({ name: "Trade", args: { maker: ALICE, taker: BOB, fillSize: E18, takerIsLong: true } });
    expect(price!.args).toMatchObject({ targetPublishTs: TS, exponent: -18, fundingIndex: -5n });
    expect(adl!.args).toMatchObject({ adlEpoch: 4 });
    expect(fixed).toMatchObject({ source: "terminator", name: "SettlementPriceFixed", market: A, args: { settlementPrice: 7n } });
    expect(disputed).toBeNull(); // names no pair
    expect(decodeLiveLog({ ...toRaw(t)[0]!, topics: [h32("99")] })).toBeNull();
  });

  // Audit F14: the event's ABI calls the payout usdcAmount, but it is BAZAAR precision.
  it("names InsuranceWithdrawalExecuted's 18-decimal payout `amount`", () => {
    const t = new FakeTransport(10, TS);
    t.emit(A, "InsuranceWithdrawalExecuted", { pairId: PAIR_ID, user: ALICE, shareAmount: 3n * E18, usdcAmount: 1_234_500_000_000_000_000n });
    const e = decodeLiveLog(toRaw(t)[0]!) as Extract<LiveEvent, { name: "InsuranceWithdrawalExecuted" }>;
    expect(e.args).toEqual({ pairId: PAIR_ID, user: ALICE, shareAmount: 3n * E18, amount: 1_234_500_000_000_000_000n });
    expect("usdcAmount" in e.args).toBe(false);
  });
});

describe("LogFollower", () => {
  it("delivers what lands after the head it started at, in chain order, once", async () => {
    const t = new FakeTransport(100, TS);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: E18 }); // before the start: not delivered
    const { f, got, notices, delivered } = follower(t);
    await f.start();
    expect(got).toEqual([[]]);
    expect(f.cursor).toBe(101);
    t.mine(3);
    t.emit(A, "CollateralWithdrawn", { pairId: PAIR_ID, user: ALICE, amount: 2n }, 103);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 3n }, 102);
    t.emit(B, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 3n }, 102); // not followed
    await f.tick();
    expect(delivered()).toEqual(["102:0", "103:0"]);
    expect(f.cursor).toBe(104);
    await f.tick(); // same head: nothing, and no head notice
    expect(got.length).toBe(3);
    expect(notices.filter((n) => n.type === "head").map((n) => (n as { block: number }).block)).toEqual([100, 103]);
    f.stop();
  });

  it("rewinds on a reorg, re-reads, and does not deliver surviving logs twice", async () => {
    const t = new FakeTransport(100, TS);
    const { f, notices, delivered } = follower(t, { reorgDepth: 4 });
    await f.start();
    t.mine(4);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 1n }, 101);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 2n }, 104);
    await f.tick();
    expect(delivered()).toEqual(["101:0", "104:0"]);

    // Block 104 is replaced, and the new 104 carries a different log; the head moves one block on.
    t.reorg(104, 1);
    t.emit(A, "CollateralWithdrawn", { pairId: PAIR_ID, user: ALICE, amount: 9n }, 104);
    await f.tick();
    expect(notices.find((n) => n.type === "reorg")).toEqual({ type: "reorg", fromBlock: 101, head: 105 });
    expect(delivered()).toEqual(["101:0", "104:0", "104:0"]); // 101 survived and is not re-delivered; the new 104 is
    expect(f.cursor).toBe(106);

    // A gap of several blocks is checked against the last head (read beside the logs).
    t.mine(1);
    t.reorg(105, 3);
    t.emit(A, "CollateralWithdrawn", { pairId: PAIR_ID, user: ALICE, amount: 10n }, 107);
    await f.tick();
    expect(notices.filter((n) => n.type === "reorg").length).toBe(2);
    expect(delivered().at(-1)).toBe("107:0");
    f.stop();
  });

  it("ignores a lagging node's older head", async () => {
    const t = new FakeTransport(100, TS);
    const { f, notices } = follower(t);
    await f.start();
    t.mine(2);
    await f.tick();
    const real = t.blocks;
    t.blocks = real.slice(0, 102); // the node answers one block behind
    await f.tick();
    t.blocks = real;
    expect(notices.some((n) => n.type === "reorg")).toBe(false);
    expect(f.cursor).toBe(103);
    f.stop();
  });

  it("backs off on errors without losing logs, and halves a refused range", async () => {
    const t = new FakeTransport(100, TS);
    const { f, notices, delivered } = follower(t, { pollMs: 1_000, fromBlock: 90 });
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 1n }, 95);
    t.failLogs = new RpcError(-32005, "query returned more than 10000 results");
    await f.start();
    expect(delivered()).toEqual(["95:0"]); // the 11-block range was refused, then read 5 blocks at a time
    expect(t.count("eth_getLogs")).toBe(4);

    t.mine(1);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 2n }, 101);
    t.failMethod = "eth_getLogs";
    await f.tick();
    const errors = notices.filter((n) => n.type === "error") as Extract<FollowNotice, { type: "error" }>[];
    expect(errors.map((e) => e.retryInMs)).toEqual([2_000]);
    t.failMethod = null;
    await f.tick();
    expect(delivered()).toEqual(["95:0", "101:0"]);
    f.stop();
  });

  // Audit F14: one bogus head number sent the follower through every block up to it (5e8 eth_getLogs for 1e12).
  it("does not follow a head far ahead of what it has read until the node serves the blocks before it", async () => {
    class Bogus extends FakeTransport {
      fake: number | null = null;
      override async request(args: RequestArgs): Promise<unknown> {
        const tag = (args.params as unknown[] | undefined)?.[0];
        if (this.fake !== null && args.method === "eth_getBlockByNumber" && tag === "latest") {
          this.requests.push(args);
          return { number: toHex(this.fake), hash: h32("ee"), parentHash: h32("ed"), timestamp: toHex(TS), baseFeePerGas: "0x1" };
        }
        return super.request(args);
      }
    }
    const t = new Bogus(100, TS);
    const { f, notices, delivered } = follower(t, { logChunk: 100 });
    await f.start();
    t.fake = 1_000_000;
    const logsBefore = t.count("eth_getLogs");
    await f.tick();
    expect(t.count("eth_getLogs")).toBe(logsBefore); // not one range read
    expect(f.cursor).toBe(101);
    const err = notices.find((n) => n.type === "error") as Extract<FollowNotice, { type: "error" }>;
    expect(String((err.error as Error).message)).toMatch(/reports block 1000000 as its head, 999900 blocks past the last one read, but cannot serve block 1100: not following that head/);
    expect(notices.some((n) => n.type === "head" && n.block === 1_000_000)).toBe(false);

    // The node recovers: the follower carries on from where it was.
    t.fake = null;
    t.mine(2);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 1n }, 102);
    await f.tick();
    expect(delivered()).toEqual(["102:0"]);
    expect(f.cursor).toBe(103);
    f.stop();
  });

  it("catches up with a far head in bounded steps, each checked and delivered with the block it reached", async () => {
    const t = new FakeTransport(100, TS);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 1n }, 5);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 2n }, 55);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 3n }, 99);
    const ctx = contextFor(t);
    const heads: number[] = [];
    const got: number[][] = [];
    const notices: FollowNotice[] = [];
    const f = new LogFollower(ctx.chain, () => [A], (logs, head) => void (heads.push(head.number), got.push(logs.map((l) => l.blockNumber))), (n) => notices.push(n), {
      pollMs: 60_000,
      fromBlock: 0,
      logChunk: 10,
      maxBlocksPerTick: 40,
    });
    await f.start();
    expect(heads).toEqual([39, 79, 100]);
    expect(got).toEqual([[5], [55], [99]]);
    expect(f.cursor).toBe(101);
    expect(notices.filter((n) => n.type === "head").map((n) => (n as { block: number }).block)).toEqual([39, 79, 100]);
    expect(t.count("eth_getLogs")).toBe(11); // 4 + 4 + 3 chunks of 10 blocks
    f.stop();
  });

  it("wakes on eth_subscribe notifications when the transport pushes them", async () => {
    class Pushing extends FakeTransport {
      listeners = new Set<(m: unknown) => void>();
      unsubscribed: unknown[] = [];
      on(event: string, l: (m: unknown) => void) {
        if (event === "message") this.listeners.add(l);
      }
      removeListener(event: string, l: (m: unknown) => void) {
        if (event === "message") this.listeners.delete(l);
      }
      override async request(args: RequestArgs): Promise<unknown> {
        if (args.method === "eth_subscribe") return "0xsub";
        if (args.method === "eth_unsubscribe") return this.unsubscribed.push(args.params?.[0]);
        return super.request(args);
      }
      push(subscription: string) {
        for (const l of this.listeners) l({ type: "eth_subscription", data: { subscription, result: {} } });
      }
    }
    const t = new Pushing(100, TS);
    const { f, delivered } = follower(t);
    await f.start();
    expect(f.subscribed).toBe(true);
    t.mine(1);
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 1n }, 101);
    t.push("0xother"); // not ours
    t.push("0xsub");
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered()).toEqual(["101:0"]);
    f.stop();
    expect(t.listeners.size).toBe(0);
    expect(t.unsubscribed).toEqual(["0xsub"]);

    const plain = follower(new FakeTransport(100, TS), { subscribe: true });
    await plain.f.start();
    expect(plain.f.subscribed).toBe(false); // no "message" events: polling
    plain.f.stop();
  });
});

function marketSetup() {
  const t = new FakeTransport(100, TS);
  withMarket(t, { address: A, pairId: PAIR_ID, baseFeedId: h32("f1") });
  withMarket(t, { address: B, pairId: h32("b1"), baseFeedId: h32("f2") });
  t.answer(FACTORY, "getAllPairs", [A, B]);
  return { t, ctx: contextFor(t) };
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("watchMarket", () => {
  it("delivers the market's events and a snapshot after them", async () => {
    const { t, ctx } = marketSetup();
    await listMarkets(ctx, { metadata: null });
    const updates: MarketUpdate[] = [];
    const h = watchMarket(ctx, "0x" + A.slice(2).toLowerCase(), (u) => updates.push(u), { pollMs: 10, minSnapshotMs: 0, refreshMs: 0 });
    await h.ready;
    expect(updates.filter((u) => u.type === "snapshot").map((u) => (u as { cause: string }).cause)).toEqual(["initial"]);

    t.mine(1);
    t.emit(A, "Trade", trade(ALICE, BOB));
    t.emit(B, "Trade", trade(ALICE, BOB)); // another market
    t.emit(TERMINATOR, "TerminationProposalAccepted", { pair: A, assertionId: h32("ee"), lastTradingTs: BigInt(TS + 3_600) }, 101, bazaarPairTerminatorAbi as unknown as Abi);
    t.answer(A, "scheduledTerminationTs", BigInt(TS + 3_600));
    await waitFor(() => updates.filter((u) => u.type === "snapshot").length === 2);
    h.stop();
    const events = updates.filter((u) => u.type === "event").map((u) => (u as { event: LiveEvent }).event);
    expect(events.map((e) => [e.source, e.name, e.market])).toEqual([
      ["pair", "Trade", A],
      ["terminator", "TerminationProposalAccepted", A],
    ]);
    const snap = updates.filter((u) => u.type === "snapshot").at(-1) as Extract<MarketUpdate, { type: "snapshot" }>;
    expect(snap).toMatchObject({ cause: "events", bookChanged: true });
    expect(snap.snapshot.block).toBe(101);
    expect(snap.snapshot.termination.scheduledTs).toBe(TS + 3_600);
    const n = updates.length;
    t.mine(1);
    t.emit(A, "Trade", trade(ALICE, BOB));
    await new Promise((r) => setTimeout(r, 40));
    expect(updates.length).toBe(n); // stopped: nothing more
    expect(h.stopped).toBe(true);
  });

  // Audit F14: one log that failed to decode rejected the whole batch, and the rest of it was never delivered.
  it("reports a log it cannot decode and still delivers the rest of its batch", async () => {
    const { t, ctx } = marketSetup();
    await listMarkets(ctx, { metadata: null });
    const updates: MarketUpdate[] = [];
    const h = watchMarket(ctx, A, (u) => updates.push(u), { pollMs: 10, minSnapshotMs: 0, refreshMs: 0, initial: false });
    await h.ready;
    t.mine(1);
    const good = t.emit(A, "Trade", trade(ALICE, BOB));
    t.logs.push({ ...good, data: "0x1234", logIndex: 1 }); // Trade's topic, truncated data
    t.emit(A, "CollateralDeposited", { pairId: PAIR_ID, user: ALICE, amount: 5n });
    await waitFor(() => updates.some((u) => u.type === "snapshot"));
    h.stop();
    const events = updates.filter((u) => u.type === "event").map((u) => (u as { event: LiveEvent }).event);
    expect(events.map((e) => [e.name, e.logIndex])).toEqual([
      ["Trade", 0],
      ["CollateralDeposited", 2],
    ]);
    const bad = updates.filter((u) => u.type === "undecodable") as Extract<MarketUpdate, { type: "undecodable" }>[];
    expect(bad.map((u) => [u.log.blockNumber, u.log.logIndex])).toEqual([[101, 1]]);
    expect(bad[0]!.error).toBeInstanceOf(Error);
    expect(updates.some((u) => u.type === "error")).toBe(false);
  });

  it("refreshes on demand and on its timer, and reports a market it cannot find", async () => {
    const { ctx } = marketSetup();
    await listMarkets(ctx, { metadata: null });
    const updates: MarketUpdate[] = [];
    const h = watchMarket(ctx, A, (u) => updates.push(u), { pollMs: 60_000, initial: false, refreshMs: 0 });
    await h.ready;
    expect(updates.some((u) => u.type === "snapshot")).toBe(false);
    await h.refresh();
    expect(updates.filter((u) => u.type === "snapshot").map((u) => (u as { cause: string }).cause)).toEqual(["manual"]);
    h.stop();

    const timed: MarketUpdate[] = [];
    const h2 = watchMarket(ctx, A, (u) => timed.push(u), { pollMs: 5, initial: false, refreshMs: 1 });
    await waitFor(() => timed.some((u) => u.type === "snapshot"));
    h2.stop();
    expect((timed.find((u) => u.type === "snapshot") as { cause: string }).cause).toBe("timer");

    const lost: MarketUpdate[] = [];
    const h3 = watchMarket(ctx, "DOGE/USD", (u) => lost.push(u));
    await h3.ready;
    expect(lost).toMatchObject([{ type: "error", retryInMs: null }]);
    expect(h3.stopped).toBe(true);
  });
});

describe("watchAccount", () => {
  function accountSetup() {
    const s = marketSetup();
    for (const m of [A, B]) {
      s.t.answer(LENS, "getPositionBucket", { isLong: true, size: 0n, entryValue: 0n, collateral: 10n * E18, entryFundingIndex: 0n, takeProfitOrderId: 0n, stopLossOrderId: 0n }, m)
        .answer(LENS, "getUserActiveLimitOrders", { orderIds: [], count: 0n, longExposure: 0n, shortExposure: 0n }, m)
        .answer(LENS, "checkBucketSolvency", {
          unrealizedPnl: 0n, fundingPnl: 0n, totalPnl: 0n, adjustedSize: 0n, currentNotional: 0n, entryValue: 0n, minRequiredCollateral: 0n,
          availableEquity: 0n, effectiveCollateral: 0n, adjustedEntryFundingIndex: 0n, isSolvent: true,
        }, m)
        .answer(LENS, "getMaxWithdrawable", 10n * E18, m)
        .answer(LENS, "outstandingOrderExposure", { longExposure: 0n, shortExposure: 0n, longSize: 0n, shortSize: 0n }, m)
        .answer(m, "metaTxNonces", 0n)
        .answer(LENS, "getTerminalEntitlement", { collateral: 0n, registeredClaim: 0n, principalRatio: 0n, profitRatio: 0n, payout: 0n }, m);
    }
    s.t.answer(LENS, "getClaimableFees", (args: readonly unknown[]) => (args[0] as Address[]).map(() => 0n));
    s.t.answer(USDC, "balanceOf", 0n).answer(USDC, "allowance", 0n);
    return s;
  }

  it("delivers the account's events and the market-wide ones, and refreshes the markets they touched", async () => {
    const { t, ctx } = accountSetup();
    await listMarkets(ctx, { metadata: null });
    const updates: AccountUpdate[] = [];
    const h = watchAccount(ctx, ALICE, [A, B], (u) => updates.push(u), { pollMs: 10, minSnapshotMs: 0, refreshMs: 0 });
    await h.ready;
    const accounts = () => updates.filter((u) => u.type === "account") as Extract<AccountUpdate, { type: "account" }>[];
    expect(accounts().map((u) => [u.snapshot.market.address, u.cause])).toEqual([[A, "initial"], [B, "initial"]]);

    t.mine(1);
    t.emit(A, "Trade", trade(BOB, addr("cc"))); // not ALICE's
    t.emit(A, "OrderUpdated", { pairId: PAIR_ID, orderId: 77n, owner: ALICE, payload: payload({ orderType: 4 }) });
    t.emit(A, "TriggerBountyEscrowed", { pairId: PAIR_ID, orderId: 77n, amount: E18 }); // her new order's bounty
    t.emit(A, "TriggerBountyEscrowed", { pairId: PAIR_ID, orderId: 78n, amount: E18 }); // someone else's
    t.emit(B, "AdlTriggered", { pairId: h32("b1"), adlEpoch: 1n, price: E18, fundingIndex: 0n });
    t.emit(B, "NewPriceUpdateAdded", { pairId: h32("b1"), targetPublishTs: BigInt(TS), spotPrice: E18, exponent: -18, fundingIndex: 0n });
    await waitFor(() => accounts().length === 4);
    h.stop();
    const events = updates.filter((u) => u.type === "event").map((u) => (u as { event: LiveEvent }).event);
    expect(events.map((e) => [e.name, e.market])).toEqual([
      ["OrderUpdated", A],
      ["TriggerBountyEscrowed", A],
      ["AdlTriggered", B],
    ]);
    expect(accounts().slice(2).map((u) => [u.snapshot.market.address, u.cause, u.snapshot.block])).toEqual([
      [A, "events", 101],
      [B, "events", 101],
    ]);
    expect(getAddress(accounts()[2]!.snapshot.user)).toBe(ALICE);
  });

  it("retries a refresh that failed", async () => {
    const { t, ctx } = accountSetup();
    await listMarkets(ctx, { metadata: null });
    const updates: AccountUpdate[] = [];
    t.answer(A, "pairVault", new Error("revert")); // the market's state read fails
    const h = watchAccount(ctx, ALICE, [A], (u) => updates.push(u), { pollMs: 5, maxBackoffMs: 10 });
    await waitFor(() => updates.some((u) => u.type === "error"));
    expect(updates.some((u) => u.type === "account")).toBe(false);
    withMarket(t, { address: A, pairId: PAIR_ID, baseFeedId: h32("f1") });
    await waitFor(() => updates.some((u) => u.type === "account"));
    h.stop();
    expect((updates.find((u) => u.type === "account") as { cause: string }).cause).toBe("initial");
  });
});
