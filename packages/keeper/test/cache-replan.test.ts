/**
 * A move within MAX_PRICE_STALENESS of the pair's last stored price: the pair judges by Pyth's cached
 * price, so the candidate's simulation crosses nothing. The keeper then re-plans once just after the
 * cache ages out (updateTs + MAX_PRICE_STALENESS + CACHE_REPLAN_MARGIN) instead of waiting out the
 * fixed cooldown, and falls back to that cooldown for every other refusal and a second one. Fake
 * clock throughout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, ActionResult } from "../src/exec/executor.js";
import { CACHE_REPLAN_MARGIN } from "../src/keeper/jobs/base.js";
import { acct, fake, order, position } from "./keeper-harness.js";

const T0 = 1_800_000_000; // a whole second, so the chain clock's fraction is 0 at the start
const count = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-cache-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"], now: T0 * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Let spawned plans and sends run to their end (setImmediate is not faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** The executor answers every run with `returned` (a count) and no send. */
function refuse(f: ReturnType<typeof fake>, returned: () => `0x${string}` = () => count(0n)) {
  const runs: Action[] = [];
  f.k.executor.run = async (a: Action) => {
    runs.push(a);
    const r = new ActionResult({ status: "skipped", job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "below the profit rule" });
    r.returned = returned();
    return r;
  };
  return runs;
}

const ALICE = acct(1);
const BOB = acct(2);

function liquidation(updateAge: number) {
  const f = fake(dir, { jobs: { liquidation: {}, triggers: {} } });
  f.k.running = true;
  f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150)); // under at 1940, not at 2000
  f.m.state = { ...f.m.state!, updateTs: T0 - updateAge };
  f.printAt(1_940);
  return f;
}

describe("a refusal Pyth's cache explains", () => {
  it("re-plans once just after the cache ages out, then falls back to the fixed cooldown", async () => {
    const f = liquidation(1); // a priced call stored a price 1 s ago: the cache serves until T0 + 2
    const runs = refuse(f);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1);
    expect(f.k.pendingReplans).toBe(1);
    const due = (3 - 1 + CACHE_REPLAN_MARGIN) * 1000; // 3.2 s from now
    await vi.advanceTimersByTimeAsync(due - 100);
    f.printAt(1_940); // prints keep coming; nothing plans the cooling candidate before its time
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1);
    expect(f.calls.buckets).toHaveLength(1);
    // Another priced call has meanwhile stored a newer price: the retry is refused again.
    f.m.state = { ...f.m.state!, updateTs: T0 + 1 };
    await vi.advanceTimersByTimeAsync(110); // the timer runs a millisecond past the due time
    await settle();
    expect(runs).toHaveLength(2);
    expect(f.calls.buckets).toHaveLength(2);
    expect(f.k.pendingReplans).toBe(0); // the backstop: no second early retry in a row
    // The fixed cooldown (engine.simCooldownSeconds, 2 s) now holds the candidate.
    await vi.advanceTimersByTimeAsync(1_890);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(f.calls.buckets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    f.printAt(1_940);
    f.m.state = { ...f.m.state!, updateTs: T0 + 4 }; // the cache was refreshed once more, just now
    await f.k.tick();
    await settle();
    expect(f.calls.buckets).toHaveLength(3);
    expect(runs).toHaveLength(3);
    expect(f.k.pendingReplans).toBe(1); // a new refusal chain may take its one early retry again
    await f.k.stop({ collect: false });
  });

  it("does not re-plan early for a stored price already older than the cache window", async () => {
    const f = liquidation(10);
    const runs = refuse(f);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1);
    expect(f.k.pendingReplans).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    f.printAt(1_940);
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(1); // still in the fixed 2 s cooldown
  });

  it("does not re-plan early for any other refusal: something crossed, or the simulation failed", async () => {
    for (const returned of [() => count(1n), () => "0x" as const]) {
      const f = liquidation(1);
      refuse(f, returned);
      await f.k.tick();
      await settle();
      expect(f.k.pendingReplans).toBe(0);
      await f.k.stop({ collect: false });
    }
    const g = liquidation(1);
    g.k.executor.run = async (a: Action) => {
      const r = new ActionResult({ status: "skipped", job: a.job, market: "ETH/USD", summary: a.summary, reason: "reverted" });
      r.returned = count(0n);
      r.error = { name: "BazaarPair__LiquidationPriceTooOld" } as ActionResult["error"];
      return r;
    };
    await g.k.tick();
    await settle();
    expect(g.k.pendingReplans).toBe(0);
  });

  it("works the same for trigger orders", async () => {
    const f = fake(dir, { jobs: { triggers: {} } });
    f.k.running = true;
    f.k.store.ordersOf(f.m.address).set(1n, order(1n)); // a StopLoss at 1950
    f.m.state = { ...f.m.state!, updateTs: T0 - 2 }; // the cache serves until T0 + 1
    f.printAt(1_940);
    const runs = refuse(f);
    await f.k.tick();
    await settle();
    expect(runs.map((a) => a.job)).toEqual(["triggers"]);
    expect(f.k.pendingReplans).toBe(1);
    await vi.advanceTimersByTimeAsync((1 + CACHE_REPLAN_MARGIN) * 1000 - 50);
    f.printAt(1_940);
    await settle();
    expect(f.calls.orders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    await settle();
    expect(f.calls.orders).toHaveLength(2);
    expect(runs).toHaveLength(2);
  });

  it("keeps one pending re-plan per job and market, at the later time, and stop() cancels it", async () => {
    const f = liquidation(2); // ALICE: due at T0 + 1.2
    f.k.store.positionsOf(f.m.address).set(BOB, position(BOB, 150));
    const runs = refuse(f);
    f.k.executor.inflight.add(`liq:${f.m.address}:${BOB}`); // BOB is planned on its own, later
    await f.k.tick();
    await settle();
    expect(runs.map((a) => a.locks.length)).toEqual([1]);
    f.k.executor.inflight.clear();
    f.m.state = { ...f.m.state!, updateTs: T0 }; // a newer stored price: BOB's retry is due at T0 + 4.2
    await f.k.tick();
    await settle();
    expect(runs).toHaveLength(2);
    expect(f.k.pendingReplans).toBe(1);
    await vi.advanceTimersByTimeAsync(1_300);
    f.printAt(1_940);
    await settle();
    expect(f.calls.buckets).toHaveLength(2); // nothing at T0 + 2.2: the one timer moved to T0 + 4.2
    await f.k.stop({ collect: false });
    expect(f.k.pendingReplans).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(f.calls.buckets).toHaveLength(2);
    expect(runs).toHaveLength(2);
  });

  it("schedules nothing while the keeper is not running", async () => {
    const f = liquidation(1);
    f.k.running = false;
    const runs = refuse(f);
    const job = f.k.jobs.get("liquidation")!;
    const [a] = await job.plan(f.m);
    await f.k.dispatch(job, a!);
    expect(runs).toHaveLength(1);
    expect(f.k.pendingReplans).toBe(0);
  });
});
