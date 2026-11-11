/**
 * The keeper on a live Pyth Pro stream: its own client and price service against the mock price
 * server, over a real WebSocket. Prints plan the price-driven jobs with the market's own signed
 * update; a dropped connection and a stream gone quiet are both reconnected; a feed Pyth reports no
 * confidence for makes no print, so nothing is planned on it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ETH_USD_FEED, bazaarPairAbi, lazer, proFeedId } from "@liberta-labs/bazaar-sdk";
import { type Hex, decodeFunctionData } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockPro, type MockProServer, startMockPro } from "../src/devtools/mock-pro.js";
import { type Action, ActionResult } from "../src/exec/executor.js";
import { setupLogging } from "../src/observe/index.js";
import { FEED, acct, fake, position } from "./keeper-harness.js";

const SIGNER = privateKeyToAddress(lazer.localSignerKey());
const ALICE = acct(1);

const warnings: string[] = [];
beforeAll(() => {
  setupLogging("warning", "json", (line) => warnings.push((JSON.parse(line) as { msg: string }).msg));
});

/** Wait until `cond` holds; fails after `ms`. */
async function until(cond: () => boolean, what: string, ms = 12_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let dir: string;
/** when set, the price server's clock stands still at it */
let frozen: number | null;
let mock: MockPro;
let srv: MockProServer;
let stop: (() => Promise<void>) | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-stream-"));
  warnings.length = 0;
  frozen = null;
  stop = null;
  mock = new MockPro({ clock: () => frozen ?? Date.now() / 1000, prices: { [FEED]: 1_940 } });
  srv = await startMockPro(mock, { port: 0 });
});
afterEach(async () => {
  await stop?.();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A keeper with the liquidation job on ETH/USD (priced by FEED) and one position that is below its
 * maintenance margin at 1,940, streaming from the mock; `runs` records what reaches the executor.
 */
function start() {
  const f = fake(dir, { jobs: { liquidation: {} }, prices: { endpoint: srv.url, checkSigners: false, streamIdleTimeoutSeconds: 1 } });
  const k = f.k;
  k.store.positionsOf(f.m.address).set(ALICE, position(ALICE, 150));
  const runs: Action[] = [];
  k.executor.run = async (a: Action) => {
    runs.push(a);
    return new ActionResult({ status: "skipped", job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "test" });
  };
  k.prices.watchMarkets([f.m]);
  k.running = true;
  k.synced.set(); // as after the first sync step
  const feed = k.prices.run();
  const loop = k.priceLoop();
  stop = async () => {
    k.running = false;
    k.prices.stop();
    k.synced.release();
    await Promise.all([feed, loop]);
    await Promise.all([...k.tasks]);
    await k.close();
  };
  const updatesOf = (a: Action) => decodeFunctionData({ abi: bazaarPairAbi, data: a.data }).args![1] as readonly Hex[];
  return { f, k, runs, updatesOf, generated: () => k.prices.latest.get(FEED)?.generatedUs ?? 0n };
}

describe("the keeper on the price stream", () => {
  it("plans a market on its prints, and attaches the one signed update that carries the market's feed", async () => {
    const s = start();
    await until(() => s.runs.length > 0, "a liquidation planned from a streamed print");
    const a = s.runs[0]!;
    expect(a.job).toBe("liquidation");
    const updates = s.updatesOf(a);
    expect(updates).toHaveLength(1);
    const u = await lazer.parseUpdate(updates[0]!);
    // Signed for the local verifier, on the configured channel, carrying the pair's feed alone with a confidence.
    expect([u.signer, u.channel]).toEqual([SIGNER, 3]);
    expect(u.feeds).toEqual([expect.objectContaining({ id: proFeedId(FEED), price: 194_000_000_000n, confidence: 194_000_000n, included: lazer.LIVE_PROPERTIES })]);
    expect(s.k.prices.fresh(s.f.m)).toBe(true);
    await until(() => s.k.prices.ethUsd() !== null, "the ETH/USD print that prices gas");
    expect(s.k.prices.ethUsd()).toBe(2_000);
    expect(s.k.prices.healthy).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("reconnects when the endpoint drops, and plans on the prints that follow", async () => {
    const s = start();
    await until(() => s.generated() > 0n, "a first print");
    const port = srv.port;
    await srv.close(); // every connection ends
    await until(() => warnings.some((w) => /price endpoint: price stream unreachable/.test(w)), "the failed reconnect to be reported");
    const before = s.generated();
    srv = await startMockPro(mock, { port });
    await until(() => s.generated() > before, "a print after the reconnect");
    expect(s.k.prices.healthy).toBe(true);
    expect(s.k.prices.fresh(s.f.m)).toBe(true);
    // What the keeper logged: the stream ending, then the endpoint unreachable until it is back.
    for (const w of warnings) {
      expect(w).toMatch(/^price endpoint: price stream (?:ended after [\d.]+ s|unreachable: .* \(check the stream URLs and the token\))$/);
    }
  });

  it("drops a stream that goes quiet for prices.streamIdleTimeoutSeconds, and picks up when updates resume", async () => {
    const s = start();
    await until(() => s.generated() > 0n, "a first print");
    frozen = Date.now() / 1000; // the server keeps its connections and sends nothing new
    await until(() => warnings.some((w) => /price stream went quiet: no new update for 1 s/.test(w)), "the quiet stream to be reported");
    const before = s.generated();
    // While nothing new arrives the print ages out: the keeper would attach nothing.
    await until(() => !s.k.prices.fresh(s.f.m), "the last print to age out", 5_000);
    expect(s.k.jobs.get("liquidation")!.priced(s.f.m)).toBeNull();
    frozen = null;
    await until(() => s.generated() > before, "a print after the stream resumed");
    expect(s.k.prices.fresh(s.f.m)).toBe(true);
  });

  it("plans nothing on a feed Pyth reports no confidence for, and plans again once it has one", async () => {
    mock.setConfidence(FEED, 0);
    const s = start();
    // The stream is alive (ETH/USD prints) and its updates carry the feed, but never as a usable price.
    await until(() => s.k.prices.latest.has(ETH_USD_FEED), "an ETH/USD print");
    await new Promise((r) => setTimeout(r, 700));
    expect(s.k.prices.latest.has(FEED)).toBe(false);
    expect(s.k.prices.fresh(s.f.m)).toBe(false);
    expect(await s.k.jobs.get("liquidation")!.plan(s.f.m)).toEqual([]);
    expect(s.runs).toEqual([]);
    expect(s.f.calls.buckets).toEqual([]);
    mock.setConfidence(FEED, null);
    await until(() => s.runs.length > 0, "a liquidation once the feed has a confidence");
    const u = lazer.readUpdate(s.updatesOf(s.runs[0]!)[0]!);
    expect(u.feeds[0]!.confidence).toBe(194_000_000n); // the feed's own, never one made up
  });

  it("with prices.stream off, polls the request API instead", async () => {
    const f = fake(dir, { prices: { endpoint: srv.url, checkSigners: false, stream: false, pollInterval: 0.1 } });
    f.k.prices.watchMarkets([f.m]);
    const feed = f.k.prices.run();
    stop = async () => {
      f.k.prices.stop();
      await feed;
      await f.k.close();
    };
    await until(() => f.k.prices.latest.has(FEED) && f.k.prices.latest.has(ETH_USD_FEED), "polled prints");
    const first = f.k.prices.latest.get(FEED)!.generatedUs;
    await until(() => f.k.prices.latest.get(FEED)!.generatedUs > first, "a later polled print");
    // One request brings every watched feed in one update: still one signed update for the call.
    expect(f.k.prices.updateFor(f.m)).toHaveLength(1);
    expect(lazer.readUpdate(f.k.prices.updateFor(f.m)[0]!).feeds.map((x) => x.id).sort((a, b) => a - b)).toEqual([2, proFeedId(FEED)]);
  });
});
