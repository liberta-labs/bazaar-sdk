/**
 * The price a planner judges a call at, and what follows a refusal.
 *
 * A pair judges a call at the update it carries only when that price was generated in a later second
 * than the price the pair holds; otherwise at the price it holds. The planners judge the same way,
 * and a call judged at a fresh price the pair holds carries no update. A liquidation on a market with
 * trading hours and no fresh print carries Pyth's latest update instead, which the pair judges it at
 * unless the price it holds is strictly newer, and which must land within 3 s of when it was issued
 * (there a fresh print's update must too); one without an update is never judged at a stored price
 * older than that window. A candidate the chain refuses waits out engine.simCooldownSeconds and
 * nothing else; one whose price aged before the send was not refused. A print without a confidence is
 * never attached. Fake clock throughout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chain, type ProbeResult, type Receipt, bazaarPairAbi } from "@liberta-labs/bazaar-sdk";
import { type Hex, decodeFunctionData, encodeAbiParameters, keccak256 } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, ActionResult, Executor, Lane } from "../src/exec/executor.js";
import { Ledger } from "../src/exec/ledger.js";
import { LocalSigner } from "../src/exec/wallets.js";
import { setupLogging } from "../src/observe/index.js";
import { DEP, FEE, FEED, FEED2, KEY, ME, S, acct, fake, marketAt, marketState, order, position, print, update } from "./keeper-harness.js";

const T0 = 1_800_000_000; // a whole second
const ALICE = acct(1);

const logged: { level: string; logger: string; msg: string }[] = [];
beforeAll(() => {
  setupLogging("debug", "json", (line) => logged.push(JSON.parse(line) as (typeof logged)[number]));
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-judging-"));
  logged.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"], now: T0 * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Let spawned plans and sends run to their end (setImmediate is not faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** The executor answers every run unsent, as for a call whose simulation liquidated or fired nothing. */
function refuse(f: ReturnType<typeof fake>) {
  const runs: Action[] = [];
  f.k.executor.run = async (a: Action) => {
    runs.push(a);
    const r = new ActionResult({ status: "skipped", job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "below the profit rule" });
    r.returned = encodeAbiParameters([{ type: "uint256" }], [0n]);
    return r;
  };
  return runs;
}

const args = (a: Action) => decodeFunctionData({ abi: bazaarPairAbi, data: a.data }).args as readonly unknown[];

describe("a refused candidate", () => {
  it("waits out the fixed cooldown: no earlier retry is scheduled, even while the stored price is young", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    f.k.running = true;
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150)); // under at 1940, not at 2000
    f.m.state = { ...f.m.state!, updateTs: T0 - 1 }; // a priced call stored a price a second ago
    f.printAt(1_940);
    const runs = refuse(f);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0); // nothing waits to re-plan it
    // Time alone brings nothing back, and neither do prints and ticks inside the cooldown.
    await vi.advanceTimersByTimeAsync(1_900);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1);
    expect(f.calls.buckets).toHaveLength(1);
    // Past engine.simCooldownSeconds (2 s) the next plan simulates it again, and a refusal cools it again.
    await vi.advanceTimersByTimeAsync(200);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(2);
    expect(f.calls.buckets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(2);
    await f.k.stop({ collect: false });
  });

  it("is not one when only its price aged before the send: the next print plans it again at once", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    f.k.running = true;
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.printAt(1_940);
    const runs: Action[] = [];
    f.k.executor.run = async (a: Action) => {
      runs.push(a);
      const r = new ActionResult({ status: "skipped", job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "not sent: aged" });
      r.priceAged = true;
      return r;
    };
    await f.k.tick();
    await settle();
    expect(runs.map((a) => a.priceTime)).toEqual([T0]);
    await vi.advanceTimersByTimeAsync(1_000);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(runs.map((a) => a.priceTime)).toEqual([T0, T0 + 1]); // no cooldown in between
    await f.k.stop({ collect: false });
  });

  it("is the same for trigger orders, with the cooldown the config sets", async () => {
    const f = fake(dir, { jobs: { triggers: {} }, engine: { simCooldownSeconds: 5 } });
    f.k.running = true;
    f.k.store.ordersOf(f.m.address).set(1n, order(1n)); // a StopLoss at 1950
    f.printAt(1_940);
    const runs = refuse(f);
    await f.k.tick();
    await settle();
    expect(runs.map((a) => a.job)).toEqual(["triggers"]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4_900);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(f.calls.orders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(f.calls.orders).toHaveLength(2);
    expect(runs).toHaveLength(2);
    await f.k.stop({ collect: false });
  });
});

describe("a print from the second the pair's stored price is from", () => {
  function liquidation(stored: { spot: number; updateTs: number }) {
    const f = fake(dir, { jobs: { liquidation: {}, triggers: {} } });
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150)); // under at 1940, not at 2000
    f.m.state = { ...f.m.state!, spot: BigInt(stored.spot) * S, updateTs: stored.updateTs };
    return Object.assign(f, { liq: f.k.jobs.get("liquidation")!, trig: f.k.jobs.get("triggers")! });
  }

  it("is judged at the stored price: what crosses only at the print waits for the next second's print", async () => {
    const f = liquidation({ spot: 2_000, updateTs: T0 }); // the pair stored 2000 earlier this second
    f.printAt(1_940); // a later print of the same second: the pair would not store it
    expect(await f.liq.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]); // not a candidate: nothing read, nothing simulated
    // A print generated in the next second is one the pair stores and judges at.
    await vi.advanceTimersByTimeAsync(1_000);
    f.printAt(1_940);
    const [a] = await f.liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], ["0xaa"]]);
    expect(a!.value).toBe(FEE);
    expect(a!.priceTime).toBe(T0 + 1); // the print's own second, which the executor checks before signing
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
  });

  it("is judged at the stored price: what crosses there is planned although the print has moved back", async () => {
    const f = liquidation({ spot: 1_940, updateTs: T0 }); // the pair stored 1940 this second
    f.printAt(2_000); // the price recovered within the second; the pair still holds 1940
    const [a] = await f.liq.plan(f.m);
    // No update travels: the pair could never store this print, so attaching it would only cost its fee.
    // The call runs on the stored price, which the executor holds to the window before signing.
    expect(args(a!)).toEqual([[ALICE], []]);
    expect(a!.value).toBe(0n);
    expect(a!.priceTime).toBe(T0);
    expect(f.calls.fees).toEqual([[]]);
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
  });

  it("counts from the stored price's own second: an earlier one leaves the print in charge, a later one does not", async () => {
    const earlier = liquidation({ spot: 2_000, updateTs: T0 - 1 });
    earlier.printAt(1_940);
    expect(await earlier.liq.plan(earlier.m)).toHaveLength(1);
    // A stored price stamped ahead of the print (another caller's newer update, or a block ahead of this clock).
    const later = liquidation({ spot: 2_000, updateTs: T0 + 2 });
    later.printAt(1_940);
    expect(await later.liq.plan(later.m)).toEqual([]);
    // A pair that never stored a price has nothing to judge at but the print.
    const never = liquidation({ spot: 0, updateTs: 0 });
    never.printAt(1_940);
    expect(await never.liq.plan(never.m)).toHaveLength(1);
  });

  it("goes by a composite's older leg, as the pair does", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    const liq = f.k.jobs.get("liquidation")!;
    const m = marketAt(2, [FEED, FEED2]);
    f.k.store.addMarket(m);
    f.k.store.positionsOf(m.address).set(ALICE, position(ALICE, 150));
    m.state = marketState(T0, { spot: 2_000n * S, updateTs: T0 });
    // The base leg printed in the next second, the quote leg (at 1.0) has not: the pair's price is still from T0.
    f.k.prices.ingest([print(FEED, 1_940, T0 + 1), print(FEED2, 1, T0, { conf: 1_000n })]);
    expect(f.k.prices.price(m)).toMatchObject({ spot: 1_940n * S, publishTime: T0 });
    expect(f.k.prices.fresh(m)).toBe(true);
    expect(await liq.plan(m)).toEqual([]);
    f.k.prices.ingest([print(FEED2, 1, T0 + 1, { conf: 1_000n })]);
    expect(await liq.plan(m)).toHaveLength(1);
  });

  it("fires or holds a trigger order by the same price", async () => {
    const held = liquidation({ spot: 2_000, updateTs: T0 });
    held.k.store.ordersOf(held.m.address).set(1n, order(1n)); // a StopLoss at 1950
    held.printAt(1_940);
    expect(await held.trig.plan(held.m)).toEqual([]);
    expect(held.calls.orders).toEqual([]);
    const fired = liquidation({ spot: 1_940, updateTs: T0 });
    fired.k.store.ordersOf(fired.m.address).set(1n, order(1n));
    fired.printAt(2_000);
    const [a] = await fired.trig.plan(fired.m);
    expect(decodeFunctionData({ abi: bazaarPairAbi, data: a!.data }).functionName).toBe("executeTriggeredOrders");
  });

  it("earns no refresh bounty, since the pair would store nothing", async () => {
    const f = fake(dir, { jobs: { refresh: {} } });
    const refresh = f.k.jobs.get("refresh")!;
    f.m.state = { ...f.m.state!, updateTs: T0 - 90_000, insurance: 2_000n * S }; // a day quiet: the bounty is due
    f.printAt(2_000);
    expect(await refresh.plan(f.m)).toHaveLength(1);
    f.m.state = { ...f.m.state, updateTs: T0 }; // someone refreshed it this second
    expect(await refresh.plan(f.m)).toEqual([]);
  });
});

describe("a print's age", () => {
  it("is judged on the chain's clock to the fraction of a second, when planning and again before signing", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    const liq = f.k.jobs.get("liquidation")!;
    const AT = T0 - 10; // the chain runs 10 s behind this machine
    Object.assign(f.k, { blockTs: AT, seen: performance.now() / 1000 });
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.m.state = { ...f.m.state!, updateTs: AT - 5 };
    f.k.prices.ingest([print(FEED, 1_940, AT)]);
    // 1.9 s old (a call may carry a price up to 2 s old at the default margin): planned at the print.
    await vi.advanceTimersByTimeAsync(1_900);
    const [a] = await liq.plan(f.m);
    expect(a!.priceTime).toBe(AT);
    expect(f.k.executor.clock() - AT).toBeCloseTo(1.9);
    // 2.4 s old: a whole-second clock still reads 2 s, which would pass it.
    await vi.advanceTimersByTimeAsync(500);
    expect(f.k.now() - AT).toBe(2);
    expect(f.k.prices.fresh(f.m)).toBe(false);
    expect(await liq.plan(f.m)).toEqual([]);
    expect(f.k.executor.clock() - AT).toBeCloseTo(2.4);
  });
});

describe("a print without a confidence", () => {
  const debug = () => logged.filter((l) => l.level === "debug" && l.logger === "bazaar_sdk.prices").map((l) => l.msg);

  it("is never attached: the market is planned as one without a fresh print, and the reason is logged at debug level", async () => {
    const f = fake(dir, { jobs: { liquidation: {}, triggers: {}, refresh: {}, unload: {} } });
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.k.store.ordersOf(f.m.address).set(1n, order(1n));
    f.m.state = { ...f.m.state!, updateTs: T0 - 90_000, insurance: 2_000n * S };
    f.k.prices.ingest([print(FEED, 1_940, T0, { conf: 0n })]);
    // By time and by the 2% cap the print passes: only its missing confidence rules it out.
    expect(f.k.prices.fresh(f.m)).toBe(true);
    for (const name of ["liquidation", "triggers", "refresh", "unload"]) {
      const job = f.k.jobs.get(name)!;
      expect(job.priced(f.m), name).toBeNull();
      expect(await job.plan(f.m), name).toEqual([]);
    }
    expect(f.calls.buckets).toEqual([]);
    expect(f.calls.fees).toEqual([]); // no update was built, no fee read
    expect(debug()).toEqual([
      `ETH/USD: the print for feed ${FEED} carries no confidence, and the oracle refuses a live price without one; skipping it`,
    ]); // once a minute per market, however many plans ask
    await vi.advanceTimersByTimeAsync(61_000);
    f.k.prices.ingest([print(FEED, 1_940, T0 + 61, { conf: 0n })]);
    expect(f.k.jobs.get("liquidation")!.priced(f.m)).toBeNull();
    expect(debug()).toHaveLength(2);
    // The next print with a confidence is used as any other, at the confidence it carries.
    f.k.prices.ingest([print(FEED, 1_940, T0 + 62)]);
    const [a] = await f.k.jobs.get("liquidation")!.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], ["0xaa"]]);
  });

  it("leaves a liquidation on a market with trading hours to a stored price still inside the window, with no update attached", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } }, { continuous: false });
    const liq = f.k.jobs.get("liquidation")!;
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.k.prices.ingest([print(FEED, 2_000, T0, { conf: 0n })]);
    // A stored 1940 a minute and a half old decides nothing, and the print cannot be attached.
    f.m.state = { ...f.m.state!, spot: 1_940n * S, updateTs: T0 - 100 };
    expect(await liq.plan(f.m)).toEqual([]);
    expect(f.calls.fees).toEqual([]);
    // Stored a second ago, it decides the call without an update, as with no print at all.
    f.m.state = { ...f.m.state, updateTs: T0 - 1 };
    const [a] = await liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], []]);
    expect(a!.value).toBe(0n);
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0 - 1, false]);
  });

  it("on one leg rules out the composite it prices", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    const m = marketAt(2, [FEED, FEED2]);
    f.k.store.addMarket(m);
    m.state = marketState(T0);
    f.k.prices.ingest([print(FEED, 1_940, T0), print(FEED2, 1, T0, { conf: 0n })]);
    expect(f.k.jobs.get("liquidation")!.priced(m)).toBeNull();
    expect(debug()).toEqual([`M2: the print for feed ${FEED2} carries no confidence, and the oracle refuses a live price without one; skipping it`]);
  });
});

/** A chain on which every call simulates as paying $0.10 and every transaction sent confirms. */
class SendingChain {
  readonly overridesSupported = true;
  readonly sent: Hex[] = [];
  async probe(): Promise<ProbeResult> {
    return { ok: true, ret: "0x", claimBefore: 0n, claimAfter: S / 10n, gasUsed: 100_000n, adlPendingAfter: false, settlementFixedAfter: 0n, reward: S / 10n };
  }
  async estimateGas(): Promise<bigint> {
    return 200_000n;
  }
  async gasPrice(): Promise<bigint> {
    return 100_000_000n;
  }
  async balance(): Promise<bigint> {
    return S;
  }
  async nonce(): Promise<number> {
    return 0;
  }
  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    return keccak256(raw);
  }
  async receipt(hash: Hex): Promise<Receipt | null> {
    return { transactionHash: hash, blockNumber: 1, status: "success", gasUsed: 150_000n, effectiveGasPrice: 100_000_000n, from: ME, to: DEP.lens, logs: [] };
  }
}

describe("a liquidation without a fresh print", () => {
  const debug = () => logged.filter((l) => l.level === "debug" && l.logger === "bazaar_sdk.prices").map((l) => l.msg);

  /** ETH/USD with a position under at 1940 and not at 2000, and the price the pair holds. */
  function liquidation(stored: { spot: number; updateTs: number }, continuous = false) {
    const f = fake(dir, { jobs: { liquidation: {} } }, { continuous });
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.m.state = { ...f.m.state!, spot: BigInt(stored.spot) * S, updateTs: stored.updateTs };
    return Object.assign(f, { liq: f.k.jobs.get("liquidation")! });
  }

  it("on a market with trading hours carries Pyth's latest update and is judged at its price, timed by its issue second", async () => {
    const f = liquidation({ spot: 2_000, updateTs: T0 - 100 });
    // The venue closed 30 s ago at 1940: the update issued then, and the one issued this second carrying that price forward.
    f.k.prices.ingest(update(T0 - 30, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]).prints);
    const latest = update(T0, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]);
    f.k.prices.ingest(latest.prints);
    expect(f.k.prices.fresh(f.m)).toBe(false);
    const [a] = await f.liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], [latest.blob]]);
    expect(a!.value).toBe(FEE);
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0, true]);
  });

  it("is judged at the latest update's price in the stored price's own second", async () => {
    // The pair stored 2000 in second T0 - 30; 1940, generated later in that second, is Pyth's latest price.
    const f = liquidation({ spot: 2_000, updateTs: T0 - 30 });
    const latest = update(T0, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]);
    f.k.prices.ingest(latest.prints);
    const [a] = await f.liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], [latest.blob]]);
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
  });

  it("is judged at the stored price when that is strictly newer, and still carries the update", async () => {
    // The pair stored 1940 in second T0 - 20; Pyth's latest price, 2000, is from T0 - 30.
    const f = liquidation({ spot: 1_940, updateTs: T0 - 20 });
    const latest = update(T0, [{ feed: FEED, usd: 2_000, generated: T0 - 30 }]);
    f.k.prices.ingest(latest.prints);
    const [a] = await f.liq.plan(f.m);
    // Without the update the call reverts: the stored price is 20 s old.
    expect(args(a!)).toEqual([[ALICE], [latest.blob]]);
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0, true]);
    // The other way round: 2000 stored in T0 - 20 outranks a latest 1940 from T0 - 30, so nothing crosses.
    const g = liquidation({ spot: 2_000, updateTs: T0 - 20 });
    g.k.prices.ingest(update(T0, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]).prints);
    expect(await g.liq.plan(g.m)).toEqual([]);
    expect(g.calls.buckets).toEqual([]);
  });

  it("on a composite dated by its quiet leg, is judged at a stored price strictly newer though older than 3 s", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } });
    const m = marketAt(2, [FEED, FEED2], false);
    f.k.store.addMarket(m);
    f.k.store.positionsOf(m.address).set(ALICE, position(ALICE, 150));
    // The pair stored 1940 in second T0 - 20. Pyth's latest update, issued now, has the base at 2000 a
    // second ago, but its price is dated by the quote leg, quiet at 1.0 since T0 - 30.
    m.state = marketState(T0, { spot: 1_940n * S, updateTs: T0 - 20 });
    const latest = update(T0, [
      { feed: FEED, usd: 2_000, generated: T0 - 1 },
      { feed: FEED2, usd: 1, generated: T0 - 30, conf: 1_000n },
    ]);
    f.k.prices.ingest(latest.prints);
    expect(f.k.prices.liquidationUpdate(m)).toMatchObject({ kind: "latest", price: { spot: 2_000n * S, publishTime: T0 - 30 } });
    const [a] = await f.k.jobs.get("liquidation")!.plan(m);
    // Judged at the stored 1940, with the update attached: without one the call reverts, the stored
    // price being 20 s old.
    expect(args(a!)).toEqual([[ALICE], [latest.blob]]);
    expect(a!.summary).toBe("liquidate 1 account(s), $1,940 notional");
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0, true]);
  });

  it("plans nothing when no update can be attached, and logs why at debug level", async () => {
    const f = liquidation({ spot: 1_940, updateTs: T0 - 100 });
    // Pyth's newest update was issued 5 s ago, past the 2 s a call may carry at the default margin.
    f.k.prices.ingest(update(T0 - 5, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]).prints);
    expect(await f.liq.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]);
    expect(f.calls.fees).toEqual([]);
    expect(debug()).toEqual([
      "ETH/USD: no price can decide a liquidation now (the newest update the price source holds was issued 5 s before the clock, " +
        "past the pair's 3 s window less the 1 s send margin); skipping it",
    ]);
    // A minute on, an update issued now whose price was generated 58 s before it: older than a minute in
    // a block 3 s later.
    await vi.advanceTimersByTimeAsync(61_000);
    f.k.prices.ingest(update(T0 + 61, [{ feed: FEED, usd: 1_940, generated: T0 + 3 }]).prints);
    expect(await f.liq.plan(f.m)).toEqual([]);
    expect(debug()[1]).toBe(
      "ETH/USD: no price can decide a liquidation now (feed 101's latest price was generated 58 s before the update carrying it was issued, " +
        "more than the 57 s that keeps it within the 60 s a liquidation's price may be old); skipping it",
    );
  });

  it("never plans a call without an update on a stored price older than the window less the send margin", async () => {
    const f = liquidation({ spot: 1_940, updateTs: T0 - 4 }); // and no print at all
    expect(await f.liq.plan(f.m)).toEqual([]);
    f.m.state = { ...f.m.state!, updateTs: T0 - 3 };
    expect(await f.liq.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]);
    // Two seconds old at the default 1 s margin: still within the pair's 3 s as the call lands.
    f.m.state = { ...f.m.state, updateTs: T0 - 2 };
    const [a] = await f.liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], []]);
    expect(a!.value).toBe(0n);
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0 - 2, false]);
  });

  it("on a continuously traded market plans nothing, whatever update Pyth issued", async () => {
    const f = liquidation({ spot: 1_940, updateTs: T0 - 4 }, true);
    f.k.prices.ingest(update(T0, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]).prints);
    expect(await f.liq.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]);
    expect(debug()).toEqual([
      "ETH/USD: no price can decide a liquidation now (no fresh price: a continuously traded market is liquidated only at a price " +
        "generated within the pair's 3 s window less the send margin, inside the oracle's confidence cap); skipping it",
    ]);
  });

  it("is checked again just before signing against when the update was issued, not how old its price is", async () => {
    const f = liquidation({ spot: 2_000, updateTs: T0 - 100 });
    f.k.prices.ingest(update(T0, [{ feed: FEED, usd: 1_940, generated: T0 - 30 }]).prints);
    const [a] = await f.liq.plan(f.m);
    const chain = new SendingChain();
    const lanes = new Map([["default", new Lane("default", new LocalSigner(KEY))]]);
    const ex = new Executor(chain as unknown as Chain, f.k.cfg, new Ledger(null), lanes, 31337, DEP.lens, () => 2_000);
    const jobCfg = f.k.cfg.jobs.liquidation;
    // 1.5 s after the update was issued (its price is 31.5 s old): signed.
    ex.clock = () => T0 + 1.5;
    expect((await ex.run(a!, { jobCfg })).status).toBe("confirmed");
    // 2.5 s after: past the 2 s a call may carry at the default margin, where the oracle would refuse it.
    ex.clock = () => T0 + 2.5;
    const r = await ex.run(a!, { jobCfg });
    expect([r.status, r.priceAged]).toEqual(["skipped", true]);
    expect(r.reason).toBe(
      `not sent: the price update it carries was issued in second ${T0}, 2.5 s before the chain's time now, past the 2 s a call may carry ` +
        "(the pair's 3 s window less prices.sendMarginSeconds); planned again with a newer price",
    );
    expect(chain.sent).toHaveLength(1);
  });
});

describe("a fresh print a liquidation carries", () => {
  const debug = () => logged.filter((l) => l.level === "debug" && l.logger === "bazaar_sdk.prices").map((l) => l.msg);

  it("on a market with trading hours, only while each update carrying it was issued within the window", async () => {
    // Issued 5 s ahead of the chain's clock (an endpoint running ahead, inside the price service's 5 s
    // skew), its price generated 2 s ahead: fresh by its price, but there the oracle reads a
    // liquidation's update as Pyth's latest price and refuses one issued that far from the block
    // (BazaarOracle__StaleUpdate).
    const ahead = update(T0 + 5, [{ feed: FEED, usd: 1_940, generated: T0 + 2 }]);
    const f = fake(dir, { jobs: { liquidation: {} } }, { continuous: false });
    const liq = f.k.jobs.get("liquidation")!;
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.m.state = { ...f.m.state!, spot: 2_000n * S, updateTs: T0 - 100 };
    f.k.prices.ingest(ahead.prints);
    expect(f.k.prices.fresh(f.m)).toBe(true);
    expect(await liq.plan(f.m)).toEqual([]);
    expect(f.calls.buckets).toEqual([]);
    expect(debug()).toEqual([
      "ETH/USD: no price can decide a liquidation now (an update the price source holds was issued 5 s ahead of the clock, " +
        "past the pair's 3 s window less the 1 s send margin); skipping it",
    ]);
    // A continuously traded market's oracle reads the price alone: the same print is attached at once.
    const g = fake(dir, { jobs: { liquidation: {} } });
    g.k.store.positionsOf(g.m.address).set(ALICE, position(ALICE, 150));
    g.m.state = { ...g.m.state!, spot: 2_000n * S, updateTs: T0 - 100 };
    g.k.prices.ingest(ahead.prints);
    const [b] = await g.k.jobs.get("liquidation")!.plan(g.m);
    expect(args(b!)).toEqual([[ALICE], [ahead.blob]]);
    expect([b!.priceTime, b!.priceIssued]).toEqual([T0 + 2, false]);
    // Three seconds on, the update was issued 2 s ahead, inside the window: attached, timed by its price.
    await vi.advanceTimersByTimeAsync(3_000);
    const [a] = await liq.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], [ahead.blob]]);
    expect([a!.priceTime, a!.priceIssued]).toEqual([T0 + 2, false]);
  });
});
