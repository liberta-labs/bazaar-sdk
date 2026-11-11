/**
 * The engine around the jobs: the tick and the print path share locks (never a double send), stop()
 * is prompt and finishes what is in flight, the status file keeps its keys, markets resolve
 * by label, address or pair id, events reach listeners, and keeper.run's one-shot calls.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMIT, bazaarPairAbi } from "@liberta-labs/bazaar-sdk";
import { decodeFunctionData } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/index.js";
import { type Action, ActionResult, type RunOptions, lockKey } from "../src/exec/executor.js";
import { Keeper, stateDirFor } from "../src/keeper/engine.js";
import { setupLogging } from "../src/observe/index.js";
import { FEE, FEED, marketAt, marketState, ME, S, acct, fake, order, position, update } from "./keeper-harness.js";

const logged: string[] = [];
beforeAll(() => {
  setupLogging("warning", "json", (line) => logged.push(line));
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const result = (a: Action, status: ActionResult["status"] = "skipped") =>
  new ActionResult({ status, job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "test" });

/** Replace the executor's pipeline: record each run, optionally held until `release()`. */
function recordRuns(k: Keeper, status: ActionResult["status"] = "skipped") {
  const runs: [Action, RunOptions][] = [];
  let open: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  k.executor.run = async (a: Action, opts: RunOptions = {}) => {
    runs.push([a, opts]);
    if (gate) await gate;
    return result(a, status);
  };
  return {
    runs,
    hold() {
      gate = new Promise<void>((r) => (open = r));
    },
    release() {
      gate = null;
      open?.();
    },
  };
}

describe("dispatch", () => {
  it("the tick and the print path never send the same candidate twice", async () => {
    const f = fake(dir, { jobs: { liquidation: {}, sweepExpired: { minBatch: 1 } } });
    const ALICE = acct(1);
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.k.store.ordersOf(f.m.address).set(1n, order(1n, { orderType: LIMIT, expiryBlock: 10 }));
    f.k.running = true;
    f.k.synced.set();
    f.printAt(1_940);
    const ex = recordRuns(f.k);
    ex.hold();
    await f.k.tick(); // liquidation through planSoon, the sweep through the tick's own plans
    await settle();
    expect(ex.runs.map(([a]) => a.job).sort()).toEqual(["liquidation", "sweepExpired"]);
    expect(f.k.executor.inflight).toEqual(new Set([`liq:${f.m.address}:${ALICE}`, `sweep:${f.m.address}`]));
    const loop = f.k.priceLoop();
    f.printAt(1_939, -1); // a newer print while the liquidation is in flight
    await settle();
    await f.k.tick();
    await settle();
    expect(ex.runs).toHaveLength(2);
    ex.release();
    await settle();
    expect(f.k.executor.inflight.size).toBe(0);
    // Both runs came back unsent: the jobs cool their candidates down, so a new tick re-reads nothing.
    f.calls.buckets.length = 0;
    await f.k.tick();
    await settle();
    expect(f.calls.buckets).toEqual([]);
    f.k.running = false;
    f.k.prices.stop();
    await loop;
    await f.k.close();
  });

  it("gates each job by scope, status and pauses", () => {
    const f = fake(dir, { jobs: { liquidation: { exclude: ["eth/usd"] }, triggers: { markets: ["M2"] }, refresh: {} } });
    const m2 = marketAt(2);
    m2.state = marketState(f.now);
    f.k.store.addMarket(m2);
    f.k.resolveScopes();
    const [liq, trig, refresh] = ["liquidation", "triggers", "refresh"].map((n) => f.k.jobs.get(n)!);
    expect([liq!.runnable(f.m), liq!.runnable(m2)]).toEqual([false, true]);
    expect([trig!.runnable(f.m), trig!.runnable(m2)]).toEqual([false, true]);
    expect(refresh!.runnable(f.m)).toBe(true);
    f.k.executor.pauses.set(lockKey("refresh", "ETH/USD"), { reverts: 0, until: Date.now() / 1000 + 60 });
    expect(refresh!.runnable(f.m)).toBe(false);
    expect(refresh!.runnable(m2)).toBe(true);
    m2.state = marketState(f.now, { settlementFixedTs: f.now });
    expect(refresh!.runnable(m2)).toBe(false); // settling
    m2.state = null;
    expect(refresh!.runnable(m2)).toBe(false);
    expect(f.k.watchedMarkets().map((m) => m.label)).toEqual(["ETH/USD", "M2"]);
  });
});

describe("start and stop", () => {
  function running(cfg: Record<string, unknown> = {}) {
    const f = fake(dir, { engine: { tickSeconds: 0.05 }, ...cfg });
    f.addWallet();
    let ticks = 0;
    f.k.connect = async () => {
      f.k.connected = true;
    };
    f.k.syncStep = async () => {
      ticks += 1;
      f.k.synced.set();
    };
    f.k.prices.run = async () => {};
    f.k.chain.balance = async () => S;
    return { ...f, ticks: () => ticks };
  }

  it("stops promptly, waits for sends in flight, collects on shutdown and saves the snapshot", async () => {
    const f = running({ jobs: { collect: { intervalSeconds: 3_600 } } });
    f.claimable.set(f.m.address, 10n * S);
    const ex = recordRuns(f.k, "confirmed");
    const started = f.k.start();
    await until(() => f.ticks() >= 3);
    expect(f.k.running).toBe(true);
    expect(ex.runs.map(([a]) => [a.job, a.background])).toEqual([["collect", true]]); // the first tick's claim
    expect(existsSync(join(f.k.stateDir, "status.json"))).toBe(true);
    // A send in flight when stop() is called is waited for.
    ex.hold();
    const job = f.k.jobs.get("collect")!;
    const inflight = f.k.dispatch(job, job.action(f.m, f.m.address, "0x", "held", { locks: ["held"] }));
    expect(inflight).not.toBeNull();
    let stopped = false;
    const stopping = f.k.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false);
    expect(f.k.running).toBe(false);
    expect(f.k.dispatch(job, job.action(f.m, f.m.address, "0x", "late", { locks: ["late"] }))).toBeNull(); // nothing new
    const t0 = Date.now();
    ex.release();
    await stopping;
    await started;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(ex.runs.map(([a]) => [a.job, a.summary, a.background])).toEqual([
      ["collect", "claim $10.00", true],
      ["collect", "held", false],
      ["collect", "claim $10.00", false], // on shutdown
    ]);
    expect(existsSync(join(f.k.stateDir, "snapshot.json"))).toBe(true);
    await f.k.close();
  });

  it("stop({ collect: false, timeout }) gives up on a stuck send after the timeout", async () => {
    const f = running({ jobs: { collect: {} } });
    const ex = recordRuns(f.k);
    const started = f.k.start();
    await until(() => f.ticks() >= 1);
    ex.hold();
    const job = f.k.jobs.get("collect")!;
    f.k.dispatch(job, job.action(f.m, f.m.address, "0x", "stuck", { locks: ["stuck"] }));
    const t0 = Date.now();
    await f.k.stop({ collect: false, timeout: 0.2 });
    await started;
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(1_500);
    expect(ex.runs.filter(([a]) => a.summary.startsWith("claim")).length).toBeLessThanOrEqual(1); // no shutdown claim
    ex.release();
    await f.k.close();
  });

  it("warns at start while prices.checkSigners is off, and only then", async () => {
    for (const checkSigners of [false, true]) {
      logged.length = 0;
      const f = running({ prices: { endpoint: "http://127.0.0.1:1", checkSigners } });
      const started = f.k.start();
      await until(() => f.ticks() >= 1);
      await f.k.stop({ collect: false });
      await started;
      await f.k.close();
      const warned = logged.filter((l) => l.includes("prices.checkSigners is off"));
      expect(warned, String(checkSigners)).toHaveLength(checkSigners ? 0 : 1);
    }
  });

  it("start() refuses to run twice, and a failed connect rejects it", async () => {
    const f = running();
    const started = f.k.start();
    await until(() => f.k.running);
    await expect(f.k.start()).rejects.toThrow("already running");
    await f.k.stop();
    await started;
    const g = fake(dir);
    g.k.connect = async () => {
      throw new ConfigError("refusing to start: the lens belongs to a different factory");
    };
    await expect(g.k.start()).rejects.toThrow(ConfigError);
    await f.k.close();
    await g.k.close();
  });
});

describe("status", () => {
  it("writes status.json with the keys bazaar keeper status reads", () => {
    const f = fake(dir, { jobs: { liquidation: {}, collect: {} } });
    f.addWallet();
    f.k.store.positionsOf(f.m.address).set(acct(1), position(acct(1), 105)); // 5% over its requirement
    f.k.store.positionsOf(f.m.address).set(acct(2), position(acct(2), 102)); // 2% over: within the 3% watch buffer
    f.printAt(2_000, 4);
    const r = new ActionResult({ status: "confirmed", job: "liquidation", market: "ETH/USD", summary: "liquidate 1 account(s)" });
    f.k.emit("action", r);
    const s = f.k.statusDict();
    expect(Object.keys(s).sort()).toEqual(
      ["updated", "network", "factory", "official", "block", "indexed", "prices", "markets", "jobs", "wallets", "halted"].sort(),
    );
    expect(s).toMatchObject({
      network: "anvil",
      factory: f.k.net.factory,
      official: false,
      block: 1_000,
      indexed: -1,
      prices: { healthy: true, error: "", feeds: 1 },
      wallets: { default: ME },
      halted: "",
    });
    expect(s.markets).toEqual([
      { label: "ETH/USD", address: f.m.address, status: "live", positions: 2, orders: 0, inventory: 0, atRisk: 1, priceAge: 4 },
    ]);
    expect(s.jobs).toEqual({
      liquidation: { markets: 1, last: "ETH/USD liquidate 1 account(s) (confirmed)", today: {} },
      collect: { markets: "all", last: "", today: {} },
    });
    f.k.writeStatus();
    const disk = JSON.parse(readFileSync(join(stateDirFor(f.k.cfg), "status.json"), "utf8"));
    expect({ ...disk, updated: 0 }).toEqual({ ...s, updated: 0 });
    expect(stateDirFor(f.k.cfg)).toBe(join(dir, "keeper", "31337-12121212"));
  });
});

describe("markets and events", () => {
  it("resolves a market by label, description, address (any case) or pair id", () => {
    const f = fake(dir);
    const k = f.k;
    for (const ref of ["ETH/USD", " eth/usd ", "Market 1", f.m.address, f.m.address.toLowerCase(), f.m.address.slice(2), f.m.pairId]) {
      expect(k.resolveMarket(ref)).toBe(f.m);
    }
    expect(() => k.resolveMarket("BTC/USD")).toThrow("no market called 'BTC/USD'. Markets: ETH/USD");
    expect(() => k.resolveMarket(acct(9))).toThrow("is not a market of this factory");
    const twin = marketAt(3);
    twin.label = "ETH/USD";
    k.store.addMarket(twin);
    expect(() => k.resolveMarket("ETH/USD")).toThrow(/matches several markets .*; use an address/);
    expect(k.resolveMarket(twin.address)).toBe(twin);
  });

  it("delivers events to listeners; one that throws or rejects breaks nothing", async () => {
    const f = fake(dir);
    const got: string[] = [];
    f.k.on("action", () => {
      throw new Error("boom");
    });
    f.k.on("action", async () => {
      throw new Error("async boom");
    });
    const off = f.k.on("action", (r) => got.push(r.summary));
    f.k.on("alert", ([kind, msg]) => got.push(`${kind}: ${msg}`));
    const r = new ActionResult({ status: "confirmed", job: "liquidation", market: "ETH/USD", summary: "one" });
    f.k.emit("action", r);
    off();
    f.k.emit("action", r);
    f.k.emit("alert", ["lowBalance", "fund me"]);
    await settle();
    expect(got).toEqual(["one", "lowBalance: fund me"]);
    const failures = logged.map((l) => JSON.parse(l) as { msg: string; exc?: string }).filter((l) => l.msg === "listener for action failed");
    // two events, each failing both listeners
    expect(failures.map((l) => l.exc?.split(/\r?\n/)[0]).sort()).toEqual(["Error: async boom", "Error: async boom", "Error: boom", "Error: boom"]);
    expect(f.k.recent).toEqual([r, r]);
    await Promise.all([...f.k.tasks]);
  });
});

describe("keeper.run", () => {
  function oneShot(cfg: Record<string, unknown> = {}, opts: { continuous?: boolean } = {}) {
    const f = fake(dir, cfg, opts);
    f.addWallet();
    f.k.connected = true;
    f.k.updateBlock = async () => {};
    f.k.syncStep = async () => {};
    f.k.readStates = async () => {};
    f.k.prices.fetch = async () => {};
    const ex = recordRuns(f.k, "simulated");
    return { ...f, ex };
  }

  it("liquidate: the planner's picks with options only, or the accounts given", async () => {
    const f = oneShot();
    const ALICE = acct(1);
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    f.printAt(1_940);
    let res = await f.k.run.liquidate("ETH/USD", { dryRun: true });
    expect(res.map((r) => r.status)).toEqual(["simulated"]);
    expect(f.ex.runs[0]![1]).toMatchObject({ dryRun: true, force: false });
    expect(decodeFunctionData({ abi: bazaarPairAbi, data: f.ex.runs[0]![0].data }).args[0]).toEqual([ALICE]);
    const BOB = acct(2);
    res = await f.k.run.liquidate("eth/usd", [BOB.toLowerCase()], { force: true });
    expect(f.ex.runs[1]![1]).toMatchObject({ dryRun: false, force: true });
    const a = f.ex.runs[1]![0];
    expect(a.summary).toBe("liquidate 1 account(s)");
    expect(a.locks).toEqual([lockKey("liq", f.m.address, BOB)]); // the liquidation job's key
    expect(decodeFunctionData({ abi: bazaarPairAbi, data: a.data }).args).toEqual([[BOB], ["0xaa"]]);
    await f.k.run.liquidate(f.m.address, { accounts: [BOB], dryRun: true });
    expect(f.ex.runs[2]![1]).toMatchObject({ dryRun: true });
    f.k.store.positionsOf(f.m.address).clear();
    res = await f.k.run.liquidate("ETH/USD");
    expect(res.map((r) => [r.status, r.reason])).toEqual([["skipped", "no position is below its maintenance margin"]]);
  });

  it("liquidate: skipped with the reason, nothing simulated, while no price can decide a liquidation", async () => {
    const f = oneShot(); // a 24/7 market: no print, and a stored price 10 s old
    const ALICE = acct(1);
    f.k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
    const why =
      "no price can decide a liquidation now (no fresh price: a continuously traded market is liquidated only at a price generated " +
      "within the pair's 3 s window less the send margin, inside the oracle's confidence cap): positions wait for the market's next price";
    const [listed] = await f.k.run.liquidate("ETH/USD", [ALICE]);
    expect([listed!.status, listed!.reason]).toEqual(["skipped", why]);
    const [planned] = await f.k.run.liquidate("ETH/USD");
    expect([planned!.status, planned!.reason]).toEqual(["skipped", why]);
    expect(f.ex.runs).toEqual([]);
    // With no position at all, the plan simply found nothing.
    f.k.store.positionsOf(f.m.address).clear();
    const [none] = await f.k.run.liquidate("ETH/USD");
    expect(none!.reason).toBe("no position is below its maintenance margin");
  });

  it("liquidate with accounts on a closed market carries Pyth's latest update, re-checked by its issue second", async () => {
    const f = oneShot({}, { continuous: false });
    const BOB = acct(2);
    const now = Math.floor(f.k.chainTime());
    const latest = update(now, [{ feed: FEED, usd: 1_940, generated: now - 30 }]);
    f.k.prices.ingest(latest.prints);
    await f.k.run.liquidate("ETH/USD", [BOB], { dryRun: true });
    const [a] = f.ex.runs[0]!;
    expect(decodeFunctionData({ abi: bazaarPairAbi, data: a.data }).args).toEqual([[BOB], [latest.blob]]);
    expect([a.value, a.priceTime, a.priceIssued]).toEqual([FEE, now, true]);
  });

  it("reports a market whose status the job does not run in", async () => {
    const f = oneShot();
    f.m.state = marketState(f.now, { settlementFixedTs: f.now - 10 });
    const [r] = await f.k.run.executeTriggers("ETH/USD", { dryRun: true });
    expect(r!.reason).toBe("the market is settling; this job runs while it is live");
    const [l] = await f.k.run.liquidate("ETH/USD");
    expect(l!.reason).toBe("the market is settling; this job runs while it is adl, live");
    const [u] = await f.k.run.unload("ETH/USD");
    expect(u!.job).toBe("unload");
  });

  it("manual operations run unpaid and forced from the default wallet", async () => {
    const f = oneShot();
    const r = await f.k.run.finalizeTermination("ETH/USD", { dryRun: true });
    expect(r.status).toBe("simulated");
    const [a, opts] = f.ex.runs[0]!;
    expect(a.job).toBe("finalizeTermination");
    expect(a.paid).toBe(false);
    expect(a.wallet).toBe("default");
    expect(a.summary).toBe("finalize ETH/USD");
    expect(opts).toMatchObject({ dryRun: true, force: true });
    await f.k.run.factory.settleDeploymentProposal(`0x${"ab".repeat(32)}`, { dryRun: true });
    expect(f.ex.runs[1]![0].target).toBe(f.k.dep!.factory);
    await expect(f.k.run.settleTerminationProposal("0x1234")).rejects.toThrow("expected a 32-byte id");
  });

  it("one-shots honour the running keeper's in-flight keys, and hold their own while they send", async () => {
    const f = oneShot();
    f.printAt(1_940); // a price the liquidations below can carry
    const BOB = acct(2);
    const key = lockKey("liq", f.m.address, BOB);
    f.k.executor.inflight.add(key); // the running keeper is sending this liquidation
    let [r] = await f.k.run.liquidate("ETH/USD", [BOB]);
    expect(r!.status).toBe("skipped");
    expect(r!.reason).toMatch(/^already in flight/);
    expect(f.ex.runs).toHaveLength(0);
    // a dry run sends nothing, so it needs no key
    [r] = await f.k.run.liquidate("ETH/USD", [BOB], { dryRun: true });
    expect(f.ex.runs).toHaveLength(1);
    f.k.executor.inflight.delete(key);
    // while a one-shot sends, the keeper cannot dispatch the same call; the keys go once it ends
    f.ex.hold();
    const running = f.k.run.liquidate("ETH/USD", [BOB]);
    await new Promise((res) => setTimeout(res, 20));
    expect(f.k.executor.inflight.has(key)).toBe(true);
    expect(f.k.executor.tryLock([key])).toBe(false);
    f.ex.release();
    await running;
    expect(f.k.executor.inflight.size).toBe(0);
    // manual operations take a key of their own, and finalizing takes the terminal job's
    await f.k.run.finalizeTermination("ETH/USD");
    expect(f.ex.runs.at(-1)![0].locks).toEqual([lockKey("manual", "finalizeTermination", f.m.address), lockKey("settle", f.m.address)]);
  });
});
