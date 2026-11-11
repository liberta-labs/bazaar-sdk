/**
 * keeper.run.terminateScheduledPair, end to end but for the chain: the keeper's own Pyth Pro client
 * fetches the one-second updates from the mock price server, the SDK's builder picks and proves the
 * set the rule asks for, and the call the executor is handed carries exactly those updates.
 *
 * The chain is a fake whose oracle reads the updates it is given as BazaarOracle does (the tick's
 * price under UMA's rule, the median of the chained samples under the chain rule), so the price in a
 * result's summary is the price in the submitted bytes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Chain,
  SETTLE_CHAIN,
  SETTLE_NOTHING,
  SETTLE_TICK,
  ZERO_ADDRESS,
  bazaarPairTerminatorAbi,
  factory as factoryCodec,
  lazer,
  oracle as oracleCodec,
  pair as pairCodec,
  proFeedId,
  terminator as terminatorCodec,
} from "@liberta-labs/bazaar-sdk";
import { type Hex, decodeFunctionData } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeChain, Revert, stringError } from "../../sdk/test/termination-fakes.js";
import { MockPro, type MockProServer, startMockPro } from "../src/devtools/mock-pro.js";
import { type Action, ActionResult, type RunOptions } from "../src/exec/executor.js";
import type { ScheduledTerminationOptions } from "../src/keeper/ops/manual.js";
import { findOpportunities } from "../src/keeper/ops/opportunities.js";
import { DEP, FEED, ME, S, fake } from "./keeper-harness.js";

const NOW = 1_900_000_000;
const H = 3_600;
const D = 86_400;
const US = 1_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const FEED_N = proFeedId(FEED);
const P = pairCodec();
const T = terminatorCodec();
const O = oracleCodec();

/** The feed's entry in a one-second update, as the oracle reads it. */
function entry(update: Hex) {
  const u = lazer.readUpdate(update);
  const f = u.feeds.find((x) => x.id === FEED_N);
  if (u.channel !== 4 || u.timestampUs % US !== 0n || !f) throw new Revert(stringError("not a one-second update for the feed"));
  return { tick: u.timestampUs / US, price: f.price, generatedUs: f.feedUpdateTimestamp };
}

/** BazaarOracle.fetchPriceAtTick for one raw feed: the price the update stamped `tick` carries. */
function priceAtTick(updates: readonly Hex[], tick: bigint): bigint {
  if (updates.length !== 1) throw new Revert(stringError("one update per leg"));
  const e = entry(updates[0]!);
  if (e.tick !== tick || e.price <= 0n) throw new Revert(stringError("wrong tick, or no price"));
  return e.price * 10n ** 10n;
}

/** BazaarOracle.fetchChainedMedian for one raw feed: each sample is its target's tick, or a quiet tick and the next one. */
function chainedMedian(updates: readonly Hex[], firstTarget: bigint, latest: bigint, spacing: bigint, count: bigint): bigint {
  const prices: bigint[] = [];
  let target = firstTarget;
  let i = 0;
  for (let k = 0n; k < count; k++) {
    let e = entry(updates[i++]!);
    if (e.price <= 0n || e.generatedUs === 0n) throw new Revert(stringError("incomplete feed"));
    if (e.generatedUs < target * US) {
      const quiet = e;
      e = entry(updates[i++]!);
      if (quiet.tick < target || e.tick !== quiet.tick + 1n || e.generatedUs < target * US) throw new Revert(stringError("sample not proven"));
    } else if (e.tick !== target) {
      throw new Revert(stringError("sample not proven"));
    }
    if (e.tick > latest) throw new Revert(stringError("sample too late"));
    prices.push(e.price);
    target = e.tick + spacing;
  }
  if (i !== updates.length) throw new Revert(stringError("sample count mismatch"));
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return prices[Number(count / 2n)]! * 10n ** 10n;
}

let dir: string;
/** the price server's clock, in seconds */
let now: number;
let mock: MockPro;
let srv: MockProServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-terminate-"));
  now = NOW - 30 * D;
  mock = new MockPro({ clock: () => now });
  mock.setPrice(FEED, 2_000); // priced from a month before: any tick the tests ask for has a price
  now = NOW;
  srv = await startMockPro(mock, { port: 0 });
});
afterEach(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Scene {
  rule: number;
  latestPublishTs: bigint;
  lastResortTs: number;
  scheduled: number;
  fixedTs: bigint;
  cap: bigint;
  stored: bigint;
  /** whether the oracle verifies what it is given (a retired signer, say, would not) */
  verifies: boolean;
}

function setup(cutoff: number, over: Partial<Scene> = {}, wallet = true) {
  const f = fake(dir, { prices: { endpoint: srv.url, checkSigners: false } });
  if (wallet) f.addWallet();
  const k = f.k;
  k.connected = true;
  k.updateBlock = async () => {};
  k.syncStep = async () => {};
  k.readStates = async () => {};
  k.prices.fetch = async () => {};
  const c: Scene = { rule: SETTLE_CHAIN, latestPublishTs: U64_MAX, lastResortTs: cutoff + 21 * D, scheduled: cutoff, fixedTs: 0n, cap: 0n, stored: 2_000n * S, verifies: true, ...over };
  const chain = new FakeChain();
  chain.now = NOW;
  const pairAt = f.m.address;
  const proven = (price: () => bigint) => {
    if (!c.verifies) throw new Revert(stringError("invalid signer"));
    return price();
  };
  chain
    .on(pairAt, P, "scheduledTerminationTs", () => BigInt(c.scheduled))
    .on(pairAt, P, "settlementPriceFixedTs", () => c.fixedTs)
    .on(pairAt, P, "oracle", DEP.oracle)
    .on(pairAt, P, "baseFeedId", FEED)
    .on(pairAt, P, "lastPairPrice", () => ({ spotPrice: c.stored, updateTs: BigInt(NOW - 100) }))
    .on(DEP.terminator, T, "isPair", true)
    .on(DEP.terminator, T, "settlementRule", () => ({
      rule: c.rule,
      firstTarget: c.rule === SETTLE_NOTHING ? 0n : BigInt(cutoff),
      latestPublishTs: c.rule === SETTLE_TICK ? BigInt(cutoff) : c.rule === SETTLE_CHAIN ? c.latestPublishTs : 0n,
      lastResortTs: c.rule === SETTLE_NOTHING ? 0n : BigInt(c.lastResortTs),
      verdictDeadline: 0n,
    }))
    .on(DEP.terminator, T, "insurerScheduleId", ZERO32)
    .on(DEP.terminator, T, "umaCutoffCap", () => c.cap)
    .on(DEP.terminator, T, "terminateScheduledPair", () => undefined) // accepts what the oracle proved, and the empty call
    .on(DEP.oracle, O, "composites", {})
    .on(DEP.oracle, O, "getUpdateFee", ([n]) => 7n * BigInt(n))
    .on(DEP.oracle, O, "fetchPriceAtTick", ([, updates, tick]) => proven(() => priceAtTick(updates, tick)))
    .on(DEP.oracle, O, "fetchChainedMedian", ([, updates, first, latest, spacing, count]) => proven(() => chainedMedian(updates, first, latest, spacing, count)));
  (k as unknown as { chain: Chain }).chain = new Chain(chain.transport);
  // The executor: every call it is handed goes through, as a dry run or as a send.
  const runs: [Action, RunOptions][] = [];
  k.executor.run = async (a: Action, opts: RunOptions = {}) => {
    runs.push([a, opts]);
    return new ActionResult({ status: opts.dryRun ? "simulated" : "confirmed", job: a.job, market: a.market?.label ?? "", summary: a.summary });
  };
  const updatesOf = (a: Action) => decodeFunctionData({ abi: bazaarPairTerminatorAbi, data: a.data }).args![1] as readonly Hex[];
  const run = (o: boolean | ScheduledTerminationOptions = false) => k.run.terminateScheduledPair("ETH/USD", typeof o === "boolean" ? { dryRun: o } : o);
  return { f, c, chain, runs, updatesOf, run, close: () => k.close() };
}

describe("terminateScheduledPair", () => {
  it("UMA's rule: the cutoff's update settles the pair at the price it carries, generated two hours earlier", async () => {
    const cutoff = NOW - 600;
    // The feed's session closed two hours before the cutoff, at 2,100: every later tick carries that price forward.
    now = cutoff - 2 * H;
    mock.setPrice(FEED, 2_100);
    mock.pause(FEED);
    now = NOW;
    const s = setup(cutoff, { rule: SETTLE_TICK, lastResortTs: cutoff + 12 * H });
    const r = await s.run();
    expect(r.status).toBe("confirmed");
    expect(r.summary).toBe("terminate ETH/USD at its cutoff under UMA's rule (the one-second update stamped at the cutoff), settling at 2100");
    expect(r.reason).toBe("");
    expect(s.runs).toHaveLength(1);
    const [a, opts] = s.runs[0]!;
    expect([a.target, a.value, a.job, opts.force]).toEqual([DEP.terminator, 7n, "terminateScheduledPair", true]);
    // The one update sent: the one-second channel's, stamped on the cutoff, its price generated at the close.
    const updates = s.updatesOf(a);
    expect(updates).toHaveLength(1);
    const u = lazer.readUpdate(updates[0]!);
    expect([u.channel, u.timestampUs]).toEqual([4, BigInt(cutoff) * US]);
    expect(u.feeds).toEqual([expect.objectContaining({ id: FEED_N, price: 210_000_000_000n, feedUpdateTimestamp: BigInt(cutoff - 2 * H) * US })]);
    // Proven by the oracle as the terminator calls it, as the wallet that sends, with the fee for one update.
    expect(s.chain.called("fetchPriceAtTick").map((p) => [p.to, p.args, p.from, p.value])).toEqual([[DEP.oracle, [FEED, updates, BigInt(cutoff)], ME, 7n]]);
    expect(s.chain.called("getUpdateFee").map((p) => p.args)).toEqual([[1n]]);
    expect(s.chain.called("terminateScheduledPair").map((p) => [p.args[1], p.from, p.value])).toEqual([[updates, ME, 7n]]);
    expect(s.chain.called("fetchChainedMedian")).toEqual([]);
    await s.close();
  });

  it("the chain rule: five samples chained from the cutoff, a quiet stretch proven by the tick before it, settling at their median", async () => {
    const cutoff = NOW - H;
    // Quiet from nine seconds before the cutoff until two seconds after it, then printing, with two moves on the way.
    for (const [at, usd, live] of [[cutoff - 9, 2_050, false], [cutoff + 2, 2_060, true], [cutoff + 1_000, 2_070, true], [cutoff + 2_000, 2_080, true]] as const) {
      now = at;
      mock.setPrice(FEED, usd);
      if (live) mock.resume(FEED);
      else mock.pause(FEED);
    }
    now = NOW;
    const s = setup(cutoff, { cap: BigInt(cutoff + 7_200), latestPublishTs: BigInt(cutoff + 7_200) });
    const r = await s.run(true);
    expect(r.status).toBe("simulated");
    expect(r.summary).toBe("terminate ETH/USD at its cutoff under the chain rule (the median of five chained prices), settling at 2070");
    const [a, opts] = s.runs[0]!;
    expect(opts.dryRun).toBe(true);
    const updates = s.updatesOf(a);
    // The first sample is two updates: the second before the feed printed again, still at 2,050, then that second's.
    expect(updates.map((x) => entry(x)).map((e) => [Number(e.tick) - cutoff, e.price / 100_000_000n])).toEqual([
      [1, 2_050n],
      [2, 2_060n],
      [602, 2_060n],
      [1_202, 2_070n],
      [1_802, 2_070n],
      [2_402, 2_080n],
    ]);
    expect(a.value).toBe(42n); // six updates, each verified on its own
    expect(s.chain.called("fetchChainedMedian").map((p) => [p.args, p.from, p.value])).toEqual([
      [[FEED, updates, BigInt(cutoff), BigInt(cutoff + 7_200), 600n, 5n], ME, 42n],
    ]);
    expect(s.chain.called("fetchPriceAtTick")).toEqual([]);
    await s.close();
    // With no UMA cutoff capping it, the chain is bounded at uint64's maximum.
    const u = setup(cutoff);
    await u.run(true);
    expect(u.chain.called("fetchChainedMedian")[0]!.args[3]).toBe(U64_MAX);
    await u.close();
  });

  it("a watch-only keeper proves as the zero address and only ever simulates", async () => {
    const cutoff = NOW - 600;
    const s = setup(cutoff, { rule: SETTLE_TICK, lastResortTs: cutoff + 12 * H }, false);
    const r = await s.run(true);
    expect(r.summary).toMatch(/settling at 2000$/);
    expect(s.chain.called("fetchPriceAtTick")[0]!.from).toBe(ZERO_ADDRESS);
    await s.close();
  });

  it("within the grace nothing goes out without the cutoff's update: the result says why, and when the fallback opens", async () => {
    const cutoff = NOW - 600;
    const s = setup(cutoff, { rule: SETTLE_TICK, lastResortTs: cutoff + 12 * H });
    now = cutoff - 1; // the price server has not reached the cutoff: it has no update for it
    const none = await s.run();
    expect(none.status).toBe("skipped");
    expect(none.reason).toMatch(/Under UMA's rule \(the one-second update stamped at the cutoff\): Pyth's archive has no one-second update for feed .* at second \d+ yet\. The stored-price fallback opens after /);
    // The update is there, but the oracle refuses it (a signer Pyth has retired): the terminator would too.
    now = NOW;
    s.c.verifies = false;
    const refused = await s.run();
    expect(refused.status).toBe("skipped");
    expect(refused.reason).toMatch(/The oracle would not verify these updates \(.*\)\. The terminator would refuse them too\./);
    expect(s.runs).toHaveLength(0);
    expect(s.chain.called("terminateScheduledPair")).toEqual([]); // never simulated as a settlement
    await s.close();
  });

  it("past the last resort a set the oracle refuses withholds the stored-price call: a proven price may still exist", async () => {
    const cutoff = NOW - 22 * D;
    const s = setup(cutoff, { lastResortTs: cutoff + 21 * D, verifies: false });
    const r = await s.run();
    expect(r.status).toBe("skipped");
    expect(r.summary).toBe("terminate ETH/USD at its cutoff");
    expect(s.runs).toHaveLength(0);
    expect(r.reason).toMatch(/The oracle would not verify these updates \(.*\)\./);
    // The way to settle anyway is named as the keeper's operator sets it, not as the SDK's option.
    expect(r.reason).toContain("The stored-price fallback is open but not offered: a proven settlement may still exist (chain: refused): try again later, or run with --stored-price always to settle at the stored price anyway.");
    expect(r.reason).not.toContain("storedPrice");
    // A set the oracle verifies is still preferred to the stored price once the fallback is open.
    s.c.verifies = true;
    const proven = await s.run(true);
    expect(proven.summary).toMatch(/under the chain rule \(the median of five chained prices\), settling at 2000$/);
    expect(s.updatesOf(s.runs[0]![0])).toHaveLength(5);
    await s.close();
  });

  it("a settlement at the stored price is sent only when the caller accepts it, and says it is irreversible and how old the price is", async () => {
    const cutoff = NOW - 22 * D;
    const s = setup(cutoff, { lastResortTs: cutoff + 21 * D, verifies: false });
    // Asked for (storedPrice: "always"), the plan settles at the stored price; it is not sent unaccepted.
    const unaccepted = await s.run({ storedPrice: "always" });
    expect([unaccepted.status, unaccepted.summary]).toEqual(["skipped", "terminate ETH/USD at its cutoff at its stored price, 2000 (the last resort is open)"]);
    expect(unaccepted.reason).toMatch(
      /^this settles the market irreversibly at its stored price, 2000, stored \d+ s ago \(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\): no Pyth update proves it; not sent without acceptStoredPrice \(the CLI's --accept-stored-price\); under the chain rule/,
    );
    expect(s.runs).toHaveLength(0);
    // A dry run shows it, saying the same.
    const shown = await s.run({ storedPrice: "always", dryRun: true });
    expect(shown.status).toBe("simulated");
    expect(shown.reason).toContain("this settles the market irreversibly at its stored price, 2000");
    // Accepted, it goes out: no updates, no fee.
    const sent = await s.run({ storedPrice: "always", acceptStoredPrice: true });
    expect(sent.status).toBe("confirmed");
    const [a] = s.runs.at(-1)!;
    expect([s.updatesOf(a), a.value]).toEqual([[], 0n]);
    // "never" plans no stored-price call at all.
    const never = await s.run({ storedPrice: "never", acceptStoredPrice: true });
    expect(never.status).toBe("skipped");
    expect(never.reason).toContain("The stored-price fallback is open but not offered: --stored-price is never.");
    await s.close();
  });

  it("sends only the settlement that was previewed: a plan that changed meanwhile sends nothing", async () => {
    const cutoff = NOW - 22 * D;
    const s = setup(cutoff, { lastResortTs: cutoff + 21 * D, verifies: false });
    const k = s.f.k;
    const planned = await k.run.planScheduledTermination("ETH/USD", { storedPrice: "always" });
    if (planned instanceof ActionResult) throw new Error(planned.reason);
    expect([planned.plan.under, planned.plan.settlementPrice]).toEqual(["storedPrice", 2_000n * S]);
    // Someone moves the stored price before the operator's yes arrives.
    s.c.stored = 1_990n * S;
    const changed = await s.run({ storedPrice: "always", acceptStoredPrice: true, expect: planned });
    expect(changed.status).toBe("skipped");
    expect(changed.reason).toBe("the settlement changed since the preview (it settles at 1990, not 2000): nothing was sent; run the command again");
    // The archive now proves a price: another rule than the one approved.
    s.c.verifies = true;
    const proven = await s.run({ storedPrice: "always", acceptStoredPrice: true, expect: planned });
    expect(proven.reason).toMatch(/^the settlement changed since the preview \(it settles under the chain rule \(the median of five chained prices\), not the stored price/);
    expect(s.runs).toHaveLength(0);
    // Unchanged, the very call previewed is sent.
    s.c.verifies = false;
    s.c.stored = 2_000n * S;
    const same = await s.run({ storedPrice: "always", acceptStoredPrice: true, expect: planned });
    expect(same.status).toBe("confirmed");
    expect([s.runs[0]![0].target, s.runs[0]![0].data, s.runs[0]![0].value]).toEqual([planned.call.to, planned.call.data, planned.call.value]);
    await s.close();
  });

  it("a feed with no price at the cutoff builds no chain: the keeper waits for the last resort, then settles at the stored price", async () => {
    const cutoff = NOW - H;
    const fresh = new MockPro({ clock: () => now });
    now = cutoff + 100;
    fresh.setPrice(FEED, 2_000); // its first price ever, after the cutoff
    now = NOW;
    await srv.close();
    srv = await startMockPro(fresh, { port: 0 });
    const s = setup(cutoff);
    const waiting = await s.run();
    expect(waiting.status).toBe("skipped");
    expect(waiting.reason).toMatch(/Under the chain rule \(the median of five chained prices\): .*carries no price for feed/);
    expect(waiting.reason).toMatch(/The stored-price fallback opens after /);
    expect(s.runs).toHaveLength(0);
    expect(s.chain.called("fetchChainedMedian")).toEqual([]); // nothing to prove
    s.c.lastResortTs = NOW - 1;
    // The archive answers (ETH/USD a minute ago) and has no price for the feed: the stored-price call is
    // planned, and sent once accepted.
    const late = await s.run();
    expect([late.status, late.summary]).toEqual(["skipped", "terminate ETH/USD at its cutoff at its stored price, 2000 (the last resort is open)"]);
    expect(late.reason).toContain("not sent without acceptStoredPrice");
    expect(s.runs).toHaveLength(0);
    const accepted = await s.run({ acceptStoredPrice: true });
    expect(accepted.status).toBe("confirmed");
    expect(s.updatesOf(s.runs[0]![0])).toEqual([]);
    await s.close();
  });

  it("the opportunity alert names the rule and the price, and says so when it is only the stored-price fallback", async () => {
    const ZERO = `0x${"00".repeat(32)}` as Hex;
    const scan = async (s: ReturnType<typeof setup>, cutoff: number) => {
      s.chain.on(DEP.factory, factoryCodec(), "pendingIdentifierUpgradeAssertionId", ZERO).on(DEP.factory, factoryCodec(), "queuedIdentifierUpgrade", {});
      s.f.m.state = { ...s.f.m.state!, scheduledTs: cutoff };
      Object.assign(s.f.k, { blockTs: NOW }); // the keeper's clock on the scene's chain
      return findOpportunities(s.f.k);
    };
    const cutoff = NOW - H;
    const proven = setup(cutoff);
    const [o] = await scan(proven, cutoff);
    expect(o!.describe()).toMatch(
      /^terminateScheduledPair ETH\/USD: its scheduled cutoff has passed; it settles under the chain rule at 2000, the median of five chained Pyth prices \(ready now\) — bazaar keeper run terminate-scheduled --market 0x/,
    );
    expect(proven.runs.length).toBeGreaterThan(0);
    expect(proven.runs.every(([, opts]) => opts.dryRun === true)).toBe(true); // simulated, never sent
    await proven.close();
    // A feed that never priced before the cutoff: past the last resort only the stored price is left.
    const fresh = new MockPro({ clock: () => now });
    now = cutoff + 100;
    fresh.setPrice(FEED, 2_000);
    now = NOW;
    await srv.close();
    srv = await startMockPro(fresh, { port: 0 });
    const stored = setup(cutoff, { lastResortTs: NOW - 1 });
    const [p] = await scan(stored, cutoff);
    expect(p!.detail).toBe(
      "its scheduled cutoff has passed and no Pyth update proves a settlement price: only the stored-price fallback is open, at 2000. " +
        "It is irreversible: the command shows the plan, and sends it only with --accept-stored-price",
    );
    expect(p!.command).not.toContain("--accept-stored-price");
    await stored.close();
  });

  it("refuses up front what cannot be settled: no cutoff, a cutoff still ahead, a price already fixed, nothing to settle", async () => {
    const reasons: string[] = [];
    for (const over of [{ scheduled: 0 }, { scheduled: NOW + 60 }, { fixedTs: 5n }, { rule: SETTLE_NOTHING }] as Partial<Scene>[]) {
      const s = setup(NOW - 600, over);
      const r = await s.run();
      expect(r.status).toBe("skipped");
      expect(s.runs).toHaveLength(0);
      reasons.push(r.reason);
      await s.close();
    }
    expect(reasons[0]).toBe("This market has no scheduled cutoff.");
    expect(reasons[1]).toMatch(/^The market's cutoff is .*: it can be settled from the first block after it\.$/);
    expect(reasons[2]).toBe("This market's settlement price is already fixed.");
    expect(reasons[3]).not.toBe("");
  });
});
