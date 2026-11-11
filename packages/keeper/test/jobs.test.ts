/**
 * Each job's planning on hand-built store state: which candidates it picks locally, what it re-reads,
 * what the chain's answer changes, and the gates that keep it quiet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMIT,
  type ProbeResult,
  STOP_LIMIT,
  STOP_LOSS,
  TAKE_PROFIT,
  ZERO_ADDRESS,
  bazaarPairAbi,
  bucketState,
  effectiveMmrBp,
} from "@liberta-labs/bazaar-sdk";
import { type Hex, decodeFunctionData, encodeAbiParameters } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Action, ActionResult } from "../src/exec/executor.js";
import { Quote } from "../src/exec/policy.js";
import { AdlJob } from "../src/keeper/jobs/adl.js";
import { monotonic } from "../src/keeper/jobs/base.js";
import { CollectJob } from "../src/keeper/jobs/collect.js";
import { LiquidationJob, belowMaintenance } from "../src/keeper/jobs/liquidation.js";
import { RefreshJob } from "../src/keeper/jobs/refresh.js";
import { SweepExpiredJob } from "../src/keeper/jobs/sweep.js";
import { TerminalSettlementJob } from "../src/keeper/jobs/terminal.js";
import { TriggersJob } from "../src/keeper/jobs/triggers.js";
import { UnloadJob } from "../src/keeper/jobs/unload.js";
import { DEP, FEE, ME, S, acct, fake, order, position } from "./keeper-harness.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-jobs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const decode = (a: Action) => decodeFunctionData({ abi: bazaarPairAbi, data: a.data });
const skippedResult = (a: Action) => new ActionResult({ status: "skipped", job: a.job, market: "ETH/USD", summary: a.summary, reason: "unprofitable" });
const sim = (o: Partial<ProbeResult>): ProbeResult => ({
  ok: true,
  ret: "0x",
  claimBefore: 0n,
  claimAfter: 0n,
  gasUsed: 0n,
  adlPendingAfter: false,
  settlementFixedAfter: 0n,
  reward: 0n,
  ...o,
});

function setup(cfg: Record<string, unknown> = {}, opts: { continuous?: boolean } = {}) {
  const f = fake(dir, cfg, opts);
  const positions = f.k.store.positionsOf(f.m.address);
  const orders = f.k.store.ordersOf(f.m.address);
  return Object.assign(f, { positions, orders });
}

// ---- liquidation ----

describe("liquidation", () => {
  const ALICE = acct(1);
  const BOB = acct(2);

  function liq(cfg: Record<string, unknown> = {}, opts: { continuous?: boolean } = {}) {
    const f = setup({ jobs: { liquidation: cfg } }, opts);
    return Object.assign(f, { job: f.k.jobs.get("liquidation") as LiquidationJob });
  }

  it("liquidates who is below maintenance at the live price, never the keeper's own wallet", async () => {
    const f = liq();
    f.addWallet();
    f.positions.set(ALICE, position(ALICE, 150)); // solvent at the stored 2000, under at 1940
    f.positions.set(BOB, position(BOB, 300));
    f.positions.set(ME, position(ME, 50));
    f.printAt(2_000);
    expect(await f.job.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]); // nothing crossed: no RPC at all
    f.printAt(1_940);
    const actions = await f.job.plan(f.m);
    expect(f.calls.buckets).toEqual([[ALICE]]);
    expect(actions).toHaveLength(1);
    const a = actions[0]!;
    const d = decode(a);
    expect(d.functionName).toBe("liquidate");
    expect(d.args).toEqual([[ALICE], ["0xaa"]]);
    expect(a.value).toBe(FEE);
    expect(a.locks).toEqual([`liq:${f.m.address}:${ALICE}`]);
    expect(a.rewardPair).toBe(f.m.address);
    expect(a.job).toBe("liquidation");
    expect(a.summary).toBe("liquidate 1 account(s), $1,940 notional");
  });

  it("judges funding at the projected index, not the stored one", async () => {
    const f = liq();
    const CAROL = acct(3);
    const SHORTY = acct(4);
    f.positions.set(CAROL, position(CAROL, 150)); // a long pays funding
    f.positions.set(SHORTY, position(SHORTY, 50, { isLong: false })); // a short receives it
    f.printAt(2_000);
    f.m.state = { ...f.m.state!, fundingIndex: 0n, projectedFundingIndex: 60n * S };
    let actions = await f.job.plan(f.m);
    expect(f.calls.buckets).toEqual([[CAROL]]);
    expect(decode(actions[0]!).args[0]).toEqual([CAROL]);
    f.calls.buckets.length = 0;
    f.m.state = { ...f.m.state, fundingIndex: 60n * S, projectedFundingIndex: 0n };
    actions = await f.job.plan(f.m);
    expect(f.calls.buckets).toEqual([[SHORTY]]);
    expect(decode(actions[0]!).args[0]).toEqual([SHORTY]);
  });

  it("uses the effective maintenance rate: the lower of mmrBp and a non-zero lagged rate", async () => {
    const f = liq();
    const DAVE = acct(5);
    f.positions.set(DAVE, position(DAVE, 90)); // 90 of equity against 100 at 5%, 80 at 4%
    f.printAt(2_000);
    for (const [lagged, under] of [
      [0n, true],
      [400n, false],
      [600n, true],
    ] as const) {
      f.m.state = { ...f.m.state!, mmrBp: 500n, laggedMmrBp: lagged };
      f.calls.buckets.length = 0;
      const actions = await f.job.plan(f.m);
      expect(actions.length > 0, `lagged ${lagged}`).toBe(under);
      expect(f.calls.buckets.length > 0).toBe(under);
    }
  });

  it("re-reads the candidates: a closed or healthier position is not liquidated, and the store follows the chain", async () => {
    const f = liq();
    const ERIN = acct(6);
    f.positions.set(ALICE, position(ALICE, 150));
    f.positions.set(ERIN, position(ERIN, 150));
    f.chainBuckets.set(ALICE, { isLong: true, size: 0n, entryValue: 0n, collateral: 0n, entryFundingIndex: 0n, takeProfitOrderId: 0n, stopLossOrderId: 0n });
    f.chainBuckets.set(ERIN, {
      isLong: true,
      size: S,
      entryValue: 2_000n * S,
      collateral: 500n * S,
      entryFundingIndex: 0n,
      takeProfitOrderId: 0n,
      stopLossOrderId: 0n,
    });
    f.printAt(1_940);
    expect(await f.job.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([[ALICE, ERIN]]);
    expect(f.positions.has(ALICE)).toBe(false);
    expect(f.positions.get(ERIN)!.collateral).toBe(500n * S);
    f.calls.buckets.length = 0;
    expect(await f.job.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]); // ERIN no longer crosses locally
  });

  it("batches maxAccountsPerCall accounts a call", async () => {
    const f = liq({ maxAccountsPerCall: 2 });
    const accounts = [11, 12, 13, 14, 15].map(acct);
    for (const a of accounts) f.positions.set(a, position(a, 150));
    f.printAt(1_940);
    const actions = await f.job.plan(f.m);
    expect(actions.map((a) => decode(a).args[0])).toEqual([accounts.slice(0, 2), accounts.slice(2, 4), accounts.slice(4)]);
    expect(actions[0]!.summary).toBe("liquidate 2 account(s), $3,880 notional");
    expect(f.calls.buckets).toEqual([accounts]); // one re-read for the market
  });

  it("skips accounts in flight, and cools down accounts the chain refused", async () => {
    const f = liq();
    f.positions.set(ALICE, position(ALICE, 150));
    f.positions.set(BOB, position(BOB, 150));
    f.printAt(1_940);
    f.k.executor.inflight.add(`liq:${f.m.address}:${ALICE}`);
    const [a] = await f.job.plan(f.m);
    expect(decode(a!).args[0]).toEqual([BOB]);
    f.job.note(a!, skippedResult(a!));
    f.k.executor.inflight.clear();
    f.calls.buckets.length = 0;
    const again = await f.job.plan(f.m);
    expect(f.calls.buckets).toEqual([[ALICE]]); // BOB cools down
    expect(decode(again[0]!).args[0]).toEqual([ALICE]);
  });

  it("a closed session market liquidates at the stored price within 570 s, a 24/7 one never without a fresh print", async () => {
    const f = liq({}, { continuous: false });
    f.positions.set(ALICE, position(ALICE, 150));
    f.m.state = { ...f.m.state!, spot: 1_940n * S, updateTs: f.now - 100 };
    const [a] = await f.job.plan(f.m);
    expect(decode(a!).args).toEqual([[ALICE], []]);
    expect(a!.value).toBe(0n);
    f.m.state = { ...f.m.state, updateTs: f.k.now() - 571 };
    expect(await f.job.plan(f.m)).toEqual([]);
    const g = liq();
    g.positions.set(ALICE, position(ALICE, 150));
    g.m.state = { ...g.m.state!, spot: 1_940n * S };
    g.printAt(1_940, 10); // too old to send
    expect(await g.job.plan(g.m)).toEqual([]);
  });

  it("belowMaintenance is BucketLib's solvency test", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return BigInt(seed % n);
    };
    for (let i = 0; i < 2_000; i++) {
      const p = {
        ...position(acct(1), 0),
        isLong: rnd(2) === 1n,
        size: rnd(5) === 0n ? 0n : rnd(10_000) * 10n ** 15n,
        entryValue: rnd(3_000_000) * 10n ** 15n,
        collateral: rnd(500_000) * 10n ** 15n,
        entryFundingIndex: (rnd(2_000) - 1_000n) * 10n ** 16n,
      };
      const price = (rnd(4_000) + 1n) * 10n ** 17n;
      const fi = (rnd(2_000) - 1_000n) * 10n ** 16n;
      const mmr = effectiveMmrBp(rnd(1_000), rnd(1_000));
      const st = bucketState(p.isLong, p.size, p.entryValue, p.collateral, p.entryFundingIndex, price, fi, mmr);
      expect(belowMaintenance(p, price, fi, mmr)).toBe(!st.isSolvent);
    }
  });

  it("counts positions at risk within watchBufferPct", () => {
    const f = liq({ watchBufferPct: 10 });
    f.positions.set(ALICE, position(ALICE, 150)); // 150 vs 100 required at 2000: 50% over
    f.positions.set(BOB, position(BOB, 105)); // 5% over: within the 10% buffer
    f.printAt(2_000);
    expect(f.job.atRisk(f.m)).toBe(1);
  });
});

// ---- triggers ----

describe("triggers", () => {
  function trig(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { triggers: cfg } });
    return Object.assign(f, { job: f.k.jobs.get("triggers") as TriggersJob });
  }

  function book(f: ReturnType<typeof trig>) {
    const add = (o: ReturnType<typeof order>) => f.orders.set(o.orderId, o);
    add(order(1n, { orderType: STOP_LOSS, triggerPrice: 1_950n * S, bounty: S / 10n })); // 1940 <= 1950: fires
    add(order(2n, { orderType: TAKE_PROFIT, triggerPrice: 1_900n * S, bounty: S / 2n })); // 1940 >= 1900: fires
    add(order(3n, { orderType: TAKE_PROFIT, triggerPrice: 2_000n * S })); // not reached
    add(order(4n, { orderType: STOP_LIMIT, triggerPrice: 1_960n * S, limitPrice: 1_930n * S, bounty: (3n * S) / 10n })); // fires
    add(order(5n, { orderType: LIMIT })); // not a trigger order
    add(order(6n, { inBook: true }));
    add(order(7n, { expiryBlock: 1_000 })); // expires before the next block
    add(order(8n, { bounty: S / 1_000n })); // below minBountyUsd
    add(order(9n, { bounty: 0n }));
    add(order(10n, { known: false })); // a stub from a bounty event
    add(order(11n, { terminal: true }));
  }

  it("fires what the live price reached, highest bounty first, StopLimits with a predecessor hint", async () => {
    const f = trig();
    book(f);
    f.printAt(1_940);
    const actions = await f.job.plan(f.m);
    expect(f.calls.orders).toEqual([[1n, 2n, 4n]]);
    expect(f.calls.predecessors).toEqual([1_930n * S]);
    expect(actions).toHaveLength(1);
    const a = actions[0]!;
    const d = decode(a);
    expect(d.functionName).toBe("executeTriggeredOrders");
    const execs = d.args[0] as readonly { orderId: bigint; hints: { pred: bigint } }[];
    expect(execs.map((e) => [e.orderId, e.hints.pred])).toEqual([
      [2n, 0n],
      [4n, 77n],
      [1n, 0n],
    ]);
    expect(d.args[1]).toEqual(["0xaa"]);
    expect(a.value).toBe(FEE);
    expect(a.locks).toEqual([2n, 4n, 1n].map((id) => `trig:${f.m.address}:${id}`));
    expect(a.summary).toBe("execute 3 trigger order(s), up to $0.90 of bounty");
  });

  it("re-reads: drops orders the chain shows finished, in the book or rested this block, and masks the bounty bits", async () => {
    const f = trig();
    const add = (o: ReturnType<typeof order>) => f.orders.set(o.orderId, o);
    for (const id of [1n, 2n, 4n, 12n, 13n]) add(order(id));
    f.chainOrders.set(1n, { canceledBlock: 990 });
    f.chainOrders.set(2n, { inBook: true });
    f.chainOrders.set(4n, { restedBlock: 1_000 }); // a stale-price creation left it waiting in this block
    f.chainOrders.set(12n, { triggerPrice: (5n << 128n) | (1_950n * S), bounty: S / 5n });
    f.chainOrders.set(13n, { creator: ZERO_ADDRESS });
    f.printAt(1_940);
    const [a] = await f.job.plan(f.m);
    expect((decode(a!).args[0] as readonly { orderId: bigint }[]).map((e) => e.orderId)).toEqual([12n]);
    expect(f.orders.get(1n)!.terminal).toBe(true);
    expect(f.orders.get(13n)!.terminal).toBe(true);
    expect(f.orders.get(2n)!.inBook).toBe(true);
    expect(f.orders.get(12n)!.bounty).toBe(S / 5n);
    expect(a!.summary).toBe("execute 1 trigger order(s), up to $0.20 of bounty");
  });

  it("caps a call at 20 orders", async () => {
    const f = trig();
    for (let i = 1n; i <= 25n; i++) f.orders.set(i, order(i, { bounty: i * 10n ** 16n }));
    f.printAt(1_940);
    const [a] = await f.job.plan(f.m);
    const ids = (decode(a!).args[0] as readonly { orderId: bigint }[]).map((e) => e.orderId);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(25n);
    expect(ids.at(-1)).toBe(6n);
  });

  it("fires unbountied orders only with includeUnbountied", async () => {
    const f = trig({ includeUnbountied: true });
    book(f);
    f.printAt(1_940);
    await f.job.plan(f.m);
    expect(f.calls.orders).toEqual([[1n, 2n, 4n, 9n]]);
  });

  it("needs a fresh print, and skips orders in flight or cooling down", async () => {
    const f = trig();
    book(f);
    f.printAt(1_940, 10);
    expect(await f.job.plan(f.m)).toEqual([]);
    expect(f.calls.orders).toEqual([]);
    f.printAt(1_940);
    f.k.executor.inflight.add(`trig:${f.m.address}:2`);
    const [a] = await f.job.plan(f.m);
    expect(f.calls.orders).toEqual([[1n, 4n]]);
    f.job.note(a!, skippedResult(a!));
    f.k.executor.inflight.clear();
    f.calls.orders.length = 0;
    await f.job.plan(f.m);
    expect(f.calls.orders).toEqual([[2n]]);
  });
});

// ---- unload ----

describe("unload", () => {
  function unload(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { unload: cfg } });
    return Object.assign(f, { job: f.k.jobs.get("unload") as UnloadJob });
  }
  const inv = (size: bigint, seizedTs = 0) => ({ size, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs });

  it("plans only while the vault holds inventory, with a fresh print, and requires a sale", async () => {
    const f = unload();
    f.printAt(2_000);
    expect(await f.job.plan(f.m)).toEqual([]);
    f.m.state = { ...f.m.state!, longInv: inv(2n * S) };
    const [a] = await f.job.plan(f.m);
    const d = decode(a!);
    expect(d.functionName).toBe("unloadVault");
    expect(d.args).toEqual([32n, ["0xaa"]]);
    expect(a!.summary).toBe("unload inventory (2 units held)");
    expect(a!.locks).toEqual([`unload:${f.m.address}`]);
    const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
    expect(a!.requires!(sim({ ret: uint(0n) }))).toBe("the book has nothing the vault may sell into at this price");
    expect(a!.requires!(sim({ ret: uint(5n) }))).toBeNull();
  });

  it("re-simulates after recheckSeconds, on wake(), or when the floor slide ends", async () => {
    const f = unload({ recheckSeconds: 300 });
    f.printAt(2_000);
    f.m.state = { ...f.m.state!, longInv: inv(S, f.now - 170) }; // the slide ends in 10 s
    expect(await f.job.plan(f.m)).toHaveLength(1);
    const wait = f.job.nextCheck.get(f.m.address)! - monotonic();
    expect(wait).toBeGreaterThan(9);
    expect(wait).toBeLessThan(13);
    expect(await f.job.plan(f.m)).toEqual([]);
    f.job.wake(f.m.address);
    expect(await f.job.plan(f.m)).toHaveLength(1);
    f.k.executor.inflight.add(`unload:${f.m.address}`);
    f.job.wake(f.m.address);
    expect(await f.job.plan(f.m)).toEqual([]);
    f.k.executor.inflight.clear();
    f.k.prices.latest.delete(f.m.legs[0]!);
    f.printAt(2_000, 10); // stale: the walk would sell nothing
    expect(await f.job.plan(f.m)).toEqual([]);
  });

  it("plans again at the next tick when its call was held back for an aged price, not after recheckSeconds", async () => {
    const f = unload({ recheckSeconds: 300 });
    f.printAt(2_000);
    f.m.state = { ...f.m.state!, longInv: inv(S) };
    const [a] = await f.job.plan(f.m);
    expect(a!.priceTime).toBe(f.k.now());
    f.job.note(a!, skippedResult(a!)); // the book had nothing: wait for recheckSeconds
    expect(await f.job.plan(f.m)).toEqual([]);
    const aged = skippedResult(a!);
    aged.priceAged = true;
    f.job.note(a!, aged);
    expect(await f.job.plan(f.m)).toHaveLength(1);
  });
});

// ---- adl ----

describe("adl", () => {
  const [S1, S2, S3, L1] = [acct(21), acct(22), acct(23), acct(24)];

  function adl(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { adl: cfg } });
    const job = f.k.jobs.get("adl") as AdlJob;
    f.positions.set(S1, position(S1, 100, { isLong: false, entryValue: 2_100n * S })); // +100: score 1
    f.positions.set(S2, position(S2, 100, { isLong: false, entryValue: 2_200n * S })); // +200: score 2
    f.positions.set(S3, position(S3, 100, { isLong: false, entryValue: 1_900n * S })); // a loss
    f.positions.set(L1, position(L1, 100, { isLong: true, entryValue: 1_800n * S })); // +200, but its side is closed
    f.m.state = {
      ...f.m.state!,
      adlPending: true,
      adlAuctionStart: f.now - 600,
      longInv: { size: S, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs: 0 },
    };
    f.printAt(2_000);
    return Object.assign(f, { job });
  }

  it("runs only while an ADL window is open", () => {
    const f = adl();
    expect(f.job.runnable(f.m)).toBe(true);
    f.m.state = { ...f.m.state!, adlPending: false };
    expect(f.job.runnable(f.m)).toBe(false);
  });

  it("closes profitable accounts against the bucket that holds inventory, best score first", async () => {
    const f = adl();
    const [a] = await f.job.plan(f.m);
    expect(f.calls.deposits).toEqual([[S1, S2]]);
    const d = decode(a!);
    expect(d.functionName).toBe("executeAdl");
    expect(d.args).toEqual([[S2, S1], [], ["0xaa"]]);
    expect(a!.locks).toEqual([`adl:${f.m.address}`]);
    expect(a!.summary).toBe("ADL batch: 2 short(s) vs the long bucket, 0 long(s) vs the short bucket");
  });

  it("waits for the Dutch threshold to fall to the scores, and caps each side", async () => {
    const f = adl({ maxWinnersPerSide: 1 });
    f.m.state = { ...f.m.state!, adlAuctionStart: f.now }; // threshold 1 + 25e18
    expect(await f.job.plan(f.m)).toEqual([]);
    f.m.state = { ...f.m.state, adlAuctionStart: f.now - 600 };
    const [a] = await f.job.plan(f.m);
    expect(decode(a!).args[0]).toEqual([S2]);
  });

  it("skips while a batch is in flight or cooling down", async () => {
    const f = adl();
    f.k.executor.inflight.add(`adl:${f.m.address}`);
    expect(await f.job.plan(f.m)).toEqual([]);
    f.k.executor.inflight.clear();
    const [a] = await f.job.plan(f.m);
    f.job.note(a!, skippedResult(a!));
    expect(await f.job.plan(f.m)).toEqual([]);
  });
});

// ---- refresh ----

describe("refresh", () => {
  function refresh(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { refresh: cfg } });
    f.printAt(2_000);
    return Object.assign(f, { job: f.k.jobs.get("refresh") as RefreshJob });
  }
  const inv = (size: bigint) => ({ size, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs: 0 });

  it("refreshes when the bounty is due: a day's heartbeat, or 5 min with inventory and a large fund", async () => {
    const f = refresh();
    f.m.state = { ...f.m.state!, updateTs: f.now - 90_000, insurance: 2_000n * S };
    const [a] = await f.job.plan(f.m);
    expect(decode(a!).functionName).toBe("refreshPrice");
    expect(a!.summary).toBe("refresh a quiet market's price");
    expect(a!.paid).toBe(true);
    expect(a!.value).toBe(FEE);
    f.k.executor.inflight.clear();
    f.m.state = { ...f.m.state, updateTs: f.now - 400, insurance: 6_000n * S, longInv: inv(S) };
    expect(await f.job.plan(f.m)).toHaveLength(1);
    f.m.state = { ...f.m.state, updateTs: f.now - 200 };
    expect(await f.job.plan(f.m)).toEqual([]); // inside the 5 min gap, and health pokes are off
    f.m.state = { ...f.m.state, updateTs: f.now - 90_000, insurance: 900n * S };
    expect(await f.job.plan(f.m)).toEqual([]); // the fund is too small to pay
  });

  it("health pokes: unpaid, capped, and sent only when they change the vault's health", async () => {
    const f = refresh({ healthPokes: true, healthPokeIntervalSeconds: 60, healthPokeMaxCostUsd: 0.2 });
    f.m.state = { ...f.m.state!, longInv: inv(S) };
    const [a] = await f.job.plan(f.m);
    expect(a!.summary).toBe("health check (unpaid refresh)");
    expect(a!.paid).toBe(false);
    expect(a!.consentCapUsd).toBe(0.2);
    expect(a!.requires!(sim({ settlementFixedAfter: 123n }))).toBeNull();
    expect(a!.requires!(sim({ adlPendingAfter: true }))).toBeNull();
    expect(a!.requires!(sim({}))).toBe("the refresh would not change the vault's health state");
    expect(await f.job.plan(f.m)).toEqual([]); // once per interval
    const g = refresh({ healthPokes: true });
    expect(await g.job.plan(g.m)).toEqual([]); // no inventory: nothing to check
  });
});

// ---- terminal settlement ----

describe("terminalSettlement", () => {
  const [A1, A2, A3, A4] = [acct(31), acct(32), acct(33), acct(34)];

  function terminal(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { terminalSettlement: cfg } });
    f.m.state = { ...f.m.state!, settlementFixedTs: f.now - 100, longOi: 3n * S };
    return Object.assign(f, { job: f.k.jobs.get("terminalSettlement") as TerminalSettlementJob });
  }

  it("runs once the settlement price is fixed", () => {
    const f = terminal();
    expect(f.job.runnable(f.m)).toBe(true);
    f.m.state = { ...f.m.state!, settlementFixedTs: 0 };
    expect(f.job.runnable(f.m)).toBe(false);
  });

  it("settles other accounts' open positions, one batch at a time, after a re-read", async () => {
    const f = terminal({ maxAccountsPerCall: 2 });
    f.addWallet();
    for (const a of [A1, A2, A3, A4, ME]) f.positions.set(a, position(a, 100));
    f.chainBuckets.set(A2, { isLong: true, size: 0n, entryValue: 0n, collateral: 0n, entryFundingIndex: 0n, takeProfitOrderId: 0n, stopLossOrderId: 0n });
    const actions = await f.job.plan(f.m);
    expect(f.calls.buckets).toEqual([[A1, A2, A3, A4]]);
    expect(f.positions.has(A2)).toBe(false);
    expect(actions).toHaveLength(1);
    expect(decode(actions[0]!).args).toEqual([[A1, A3], []]);
    expect(actions[0]!.summary).toBe("settle 2 position(s) at the settlement price");
    expect(actions[0]!.locks).toEqual([`settle:${f.m.address}`]);
  });

  it("finalizes once open interest is zero or the escape hatch has opened", async () => {
    const f = terminal();
    expect(await f.job.plan(f.m)).toEqual([]); // open interest the index does not hold yet
    f.m.state = { ...f.m.state!, settlementFixedTs: f.now - 14 * 86_400 - 1 };
    let [a] = await f.job.plan(f.m);
    expect(decode(a!).functionName).toBe("finalizeTermination");
    expect(a!.paid).toBe(false);
    expect(a!.background).toBe(true);
    expect(a!.consentCapUsd).toBe(0.5);
    f.m.state = { ...f.m.state, settlementFixedTs: f.now - 100, longOi: 0n };
    [a] = await f.job.plan(f.m);
    expect(a!.summary).toBe("finalize the termination");
    f.m.state = { ...f.m.state, terminated: true };
    expect(await f.job.plan(f.m)).toEqual([]);
    const g = terminal({ finalize: false });
    g.m.state = { ...g.m.state!, longOi: 0n };
    expect(await g.job.plan(g.m)).toEqual([]);
  });
});

// ---- sweep ----

describe("sweepExpired", () => {
  function sweep(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { sweepExpired: cfg } });
    return Object.assign(f, { job: f.k.jobs.get("sweepExpired") as SweepExpiredJob });
  }

  it("waits for minBatch expired orders, then sweeps what the re-read confirms", async () => {
    const f = sweep({ minBatch: 3 });
    const add = (o: ReturnType<typeof order>) => f.orders.set(o.orderId, o);
    add(order(1n, { orderType: LIMIT, expiryBlock: 900 }));
    add(order(2n, { orderType: STOP_LIMIT, expiryBlock: 999 }));
    add(order(3n, { orderType: LIMIT, expiryBlock: 1_000 })); // not expired at block 1000
    add(order(4n, { orderType: STOP_LOSS, expiryBlock: 900 })); // trigger orders are not swept
    expect(await f.job.plan(f.m)).toEqual([]);
    expect(f.calls.orders).toEqual([]);
    add(order(5n, { orderType: LIMIT, expiryBlock: 500 }));
    f.chainOrders.set(5n, { filledBlock: 950, bounty: 0n });
    const [a] = await f.job.plan(f.m);
    expect(f.calls.orders).toEqual([[1n, 2n, 5n]]);
    expect(f.orders.has(5n)).toBe(false); // finished, nothing held: forgotten
    const d = decode(a!);
    expect(d.functionName).toBe("sweepExpired");
    expect(d.args).toEqual([[1n, 2n]]);
    expect(a!.paid).toBe(false);
    expect(a!.background).toBe(true);
    expect(a!.locks).toEqual([`sweep:${f.m.address}`]);
  });

  it("returns stranded bounties at once, unless includeBountyRefunds is off", async () => {
    const f = sweep({ minBatch: 10, maxOrdersPerCall: 1 });
    f.orders.set(6n, order(6n, { terminal: true, bounty: S / 10n }));
    f.orders.set(7n, order(7n, { terminal: true, bounty: S / 10n }));
    f.chainOrders.set(6n, { canceledBlock: 900 });
    f.chainOrders.set(7n, { canceledBlock: 900 });
    const [a] = await f.job.plan(f.m);
    expect(decode(a!).args).toEqual([[6n]]);
    const g = sweep({ minBatch: 10, includeBountyRefunds: false });
    g.orders.set(6n, order(6n, { terminal: true, bounty: S / 10n }));
    expect(await g.job.plan(g.m)).toEqual([]);
  });
});

// ---- collect ----

describe("collect", () => {
  function collect(cfg: Record<string, unknown> = {}) {
    const f = setup({ jobs: { collect: cfg } });
    f.addWallet();
    return Object.assign(f, { job: f.k.jobs.get("collect") as CollectJob });
  }

  it("claims each wallet's balance per market at the threshold, when it covers the gas", async () => {
    const f = collect({ thresholdUsd: 5 });
    f.claimable.set(f.m.address, 10n * S);
    f.claimable.set(acct(77), 50n * S); // not a market of this factory's index
    const [a, ...rest] = await f.job.claims(false);
    expect(rest).toEqual([]);
    expect(a!.target).toBe(f.m.address);
    expect(decode(a!).functionName).toBe("claimFees");
    expect(a!.wallet).toBe("default");
    expect(a!.probe).toBe(false);
    expect(a!.background).toBe(true);
    expect(a!.locks).toEqual([`claim:${ME}:${f.m.address}`]);
    expect(a!.decide!(new Quote(0, 0.01))).toEqual({ send: true, kind: "collect", reason: "claims $10.00 for $0.0100" });
    expect(a!.decide!(new Quote(0, 9)).send).toBe(false); // 10 < 9 × 1.25
    f.claimable.set(f.m.address, S);
    const [b] = await f.job.claims(false);
    expect(b!.decide!(new Quote(0, 0.01))).toEqual({ send: false, kind: "skip", reason: "$1.00 is below the $5 collect threshold" });
    const [c] = await f.job.claims(true); // on shutdown: anything that covers its gas
    expect(c!.background).toBe(false);
    expect(c!.decide!(new Quote(0, 0.01)).send).toBe(true);
    expect(c!.decide!(new Quote(0, 2))).toEqual({ send: false, kind: "skip", reason: "$1.0000 does not cover the claim's gas" });
    f.job.firstSeen.set(`${ME}:${f.m.address}`, Date.now() / 1000 - 8 * 86_400); // older than maxAgeDays
    const [d] = await f.job.claims(false);
    expect(d!.decide!(new Quote(0, 0.01)).send).toBe(true);
    f.job.note(d!, new ActionResult({ status: "confirmed", job: "collect", market: "ETH/USD", summary: "" }));
    expect(f.job.firstSeen.has(`${ME}:${f.m.address}`)).toBe(false);
  });

  it("respects the job's scope and in-flight claims", async () => {
    const f = collect({ exclude: ["ETH/USD"] });
    f.k.resolveScopes();
    f.claimable.set(f.m.address, 10n * S);
    expect(await f.job.claims(false)).toEqual([]);
    expect(await f.job.claims(false, new Set([f.m.address]))).toHaveLength(1); // a one-shot names its markets
    const g = collect();
    g.claimable.set(g.m.address, 10n * S);
    g.k.executor.inflight.add(`claim:${ME}:${g.m.address}`);
    expect(await g.job.claims(false)).toEqual([]);
  });

  it("runs every intervalSeconds, sooner after wake(), and forwards USDC above forwardMinUsd", async () => {
    const to = acct(5);
    const f = collect({ forwardTo: to, forwardMinUsd: 50, intervalSeconds: 600 });
    f.claimable.set(f.m.address, 10n * S);
    f.usdc = 100_000_000n;
    const actions = await f.job.planGlobal();
    expect(actions.map((a) => a.job)).toEqual(["collect", "forward"]);
    const fwd = actions[1]!;
    expect(fwd.target).toBe(DEP.usdc);
    expect(fwd.data).toBe(`0xa9059cbb${encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 100_000_000n]).slice(2)}` as Hex);
    expect(fwd.summary).toBe("forward $100.00 USDC");
    expect(fwd.decide!(new Quote(0, 1))).toEqual({ send: true, kind: "forward", reason: `forwards $100.00 to ${to}` });
    expect(await f.job.planGlobal()).toEqual([]);
    expect(f.job.nextRun - monotonic()).toBeGreaterThan(590);
    f.job.wake();
    expect(f.job.nextRun - monotonic()).toBeLessThanOrEqual(5);
    f.job.nextRun = 0;
    f.usdc = 10_000_000n;
    expect((await f.job.planGlobal()).map((a) => a.job)).toEqual(["collect"]);
  });
});
