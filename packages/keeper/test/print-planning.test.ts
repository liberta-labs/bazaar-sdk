/**
 * The print path: a newer print plans the price-driven jobs at once, one plan per market at a time,
 * and the tick keeps planning them when no print arrives.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Market, type Print, PriceService, feedIdHex } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { CATCH_UP_BLOCKS, Keeper, Signal } from "../src/keeper/engine.js";
import { Job } from "../src/keeper/jobs/base.js";
import type { Action } from "../src/exec/executor.js";
import { Effects } from "../src/state/store.js";
import type { LogTail } from "../src/sync/tail.js";

const F1 = feedIdHex(101);
const F2 = feedIdHex(102);

/** A print whose price was generated at the start of second `publish`. */
const pr = (feed: Hex, publish: number): Print => ({
  feedId: feed,
  price: 200_000_000_000n,
  conf: 1_000n,
  expo: -8,
  publishTime: publish,
  generatedUs: BigInt(publish) * 1_000_000n,
  timestampUs: BigInt(publish) * 1_000_000n,
  channel: 3,
  signer: null,
  blob: "0x",
  received: 0,
});

function market(n: number, legs: Hex[]): Market {
  const b = n.toString(16).padStart(2, "0");
  return {
    address: getAddress(`0x${b.repeat(20)}`),
    pairId: `0x${b.repeat(32)}` as Hex,
    baseFeedId: legs[0]!,
    legs,
    invertQuote: false,
    continuous: true,
    description: "",
    label: "",
    state: null,
    dirty: true,
    lastRead: 0,
  };
}

/** Let the spawned tasks run until each one finishes or blocks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A price-driven job that records each plan, and holds it open while `hold` is unset. */
class Recorder extends Job {
  override readonly name = "recorder";
  override readonly onPrint = true;
  readonly calls: [Address, number | null][] = [];
  hold: Signal | null = null;

  override runnable(): boolean {
    return true;
  }

  override async plan(m: Market): Promise<Action[]> {
    const p = this.k.prices.latest.get(m.legs[0]!);
    this.calls.push([m.address, p ? p.publishTime : null]);
    if (this.hold !== null) await this.hold.wait();
    return [];
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-print-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make(): { k: Keeper; job: Recorder; a: Market; b: Market } {
  const cfg = parseConfig({
    network: "anvil",
    factory: `0x${"12".repeat(20)}`,
    rpc: { http: "http://127.0.0.1:1" },
    prices: { endpoint: "http://127.0.0.1:1" },
    subgraph: { url: "none" },
    state: { dir },
  });
  const k = new Keeper(cfg, { loadWallets: false });
  const job = new Recorder(k);
  k.jobs = new Map([[job.name, job]]);
  const a = market(1, [F1]);
  const b = market(2, [F2]);
  k.store.addMarket(a);
  k.store.addMarket(b);
  k.running = true;
  k.synced.set(); // as after the first sync step
  return { k, job, a, b };
}

async function shut(k: Keeper, ...loops: Promise<unknown>[]): Promise<void> {
  k.running = false;
  k.prices.stop();
  k.synced.release();
  await Promise.all(loops);
  await Promise.all([...k.tasks]);
  await k.close();
}

describe("the print path", () => {
  it("nextPrints reports each feed once per newer print", async () => {
    const svc = new PriceService(null, { logger: null });
    svc.ingest([pr(F1, 100), pr(F2, 100)]);
    expect(await svc.nextPrints()).toEqual(new Set([F1, F2]));
    svc.ingest([pr(F1, 100), pr(F2, 99)]); // the same print again, and an older one
    let done = false;
    const waiting = svc.nextPrints().then((s) => {
      done = true;
      return s;
    });
    await settle();
    expect(done).toBe(false);
    svc.ingest([pr(F1, 101)]);
    svc.ingest([pr(F1, 102)]);
    expect(await waiting).toEqual(new Set([F1]));
    expect(svc.latest.get(F1)!.publishTime).toBe(102);
    svc.stop();
    expect(await svc.nextPrints()).toEqual(new Set());
  });

  it("a new print plans only the markets that use its feed", async () => {
    const { k, job, a, b } = make();
    const loop = k.priceLoop();
    try {
      k.prices.ingest([pr(F1, 100)]);
      await settle();
      expect(job.calls).toEqual([[a.address, 100]]);
      k.prices.ingest([pr(F2, 100)]);
      await settle();
      expect(job.calls).toEqual([
        [a.address, 100],
        [b.address, 100],
      ]);
    } finally {
      await shut(k, loop);
    }
  });

  it("prints during a plan cost one more plan, with the newest", async () => {
    const { k, job, a } = make();
    job.hold = new Signal();
    const loop = k.priceLoop();
    try {
      for (const t of [100, 101, 102]) {
        k.prices.ingest([pr(F1, t)]);
        await settle();
      }
      expect(job.calls).toEqual([[a.address, 100]]); // the first plan is still running
      job.hold.set();
      await settle();
      expect(job.calls).toEqual([
        [a.address, 100],
        [a.address, 102],
      ]);
      expect(k.planning.size).toBe(0);
      expect(k.replan.size).toBe(0);
    } finally {
      await shut(k, loop);
    }
  });

  it("the tick plans without a print and shares the running plan", async () => {
    const { k, job, a, b } = make();
    try {
      await k.tick();
      await settle();
      expect([...job.calls].sort()).toEqual(
        [
          [a.address, null],
          [b.address, null],
        ].sort(),
      ); // no print has arrived
      job.calls.length = 0;
      job.hold = new Signal();
      await k.tick();
      await settle();
      await k.tick(); // while both plans run: no second plan at once, one more queued for each
      await settle();
      expect(job.calls).toHaveLength(2);
      job.hold.set();
      await settle();
      expect(job.calls).toHaveLength(4);
      expect(k.planning.size).toBe(0);
    } finally {
      await shut(k);
    }
  });

  it("the print path waits while the index catches up", async () => {
    const { k, job, a } = make();
    k.synced.clear();
    const loop = k.priceLoop();
    try {
      k.prices.ingest([pr(F1, 100)]);
      await settle();
      expect(job.calls).toEqual([]);
      k.synced.set(); // the catch-up ends
      await settle();
      expect(job.calls).toEqual([[a.address, 100]]);
    } finally {
      await shut(k, loop);
    }
  });

  it("prints that arrive once a catch-up has begun wait for it to end", async () => {
    const { k, job, a } = make();
    const loop = k.priceLoop(); // synced: waiting for a print
    try {
      await settle();
      k.synced.clear(); // a sync step far behind the head begins
      k.prices.ingest([pr(F1, 100)]);
      await settle();
      expect(job.calls).toEqual([]);
      k.synced.set();
      await settle();
      expect(job.calls).toEqual([[a.address, 100]]);
    } finally {
      await shut(k, loop);
    }
  });

  it("only a sync step far behind the head holds the print path", async () => {
    const { k } = make();
    let release = new Signal();
    const slowTail = {
      hasPending: false,
      async advance(toBlock: number): Promise<Effects> {
        await release.wait();
        k.store.head = toBlock;
        return new Effects();
      },
    };
    k.tail = slowTail as unknown as LogTail;
    k.updateBlock = async () => {
      k.head = 1_000;
    };
    k.readStates = async () => {};
    try {
      for (const [behind, holds] of [
        [3, false],
        [CATCH_UP_BLOCKS, true],
      ] as const) {
        release = new Signal();
        k.store.head = 1_000 - behind;
        const step = k.syncStep();
        await settle();
        expect(k.synced.isSet, `${behind} behind`).toBe(!holds);
        release.set();
        await step;
        expect(k.synced.isSet).toBe(true);
      }
    } finally {
      await shut(k);
    }
  });

  it("stop() releases a print path parked on the catch-up gate or on the next print", async () => {
    const { k } = make();
    k.synced.clear();
    const parked = k.priceLoop();
    const { k: k2 } = make();
    const waiting = k2.priceLoop();
    await settle();
    k.running = false;
    k.synced.release();
    k2.running = false;
    k2.prices.stop();
    await expect(Promise.all([parked, waiting])).resolves.toBeDefined();
    await k.close();
    await k2.close();
  });
});
