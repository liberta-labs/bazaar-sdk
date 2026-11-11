/**
 * The price a planner judges a call at, and what follows a refusal.
 *
 * A pair judges a call at the update it carries only when that price was generated in a later second
 * than the price the pair holds; otherwise at the price it holds. The planners judge the same way,
 * and a call judged at the price the pair holds carries no update. A candidate the chain refuses
 * waits out engine.simCooldownSeconds and nothing else; one whose price aged before the send was not
 * refused. A print without a confidence is never attached. Fake clock throughout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bazaarPairAbi } from "@liberta-labs/bazaar-sdk";
import { decodeFunctionData, encodeAbiParameters } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, ActionResult } from "../src/exec/executor.js";
import { setupLogging } from "../src/observe/index.js";
import { FEE, FEED, FEED2, S, acct, fake, marketAt, marketState, order, position, print } from "./keeper-harness.js";

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

  it("leaves a closed session market on its stored price, with no update attached", async () => {
    const f = fake(dir, { jobs: { liquidation: {} } }, { continuous: false });
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.m.state = { ...f.m.state!, spot: 1_940n * S, updateTs: T0 - 100 };
    f.k.prices.ingest([print(FEED, 2_000, T0, { conf: 0n })]);
    const [a] = await f.k.jobs.get("liquidation")!.plan(f.m);
    expect(args(a!)).toEqual([[ALICE], []]); // judged at the stored 1940, as with no print at all
    expect(a!.value).toBe(0n);
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
