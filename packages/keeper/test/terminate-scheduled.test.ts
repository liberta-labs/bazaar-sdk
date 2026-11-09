/**
 * keeper.run.terminateScheduledPair (audit F4): a print set goes out as a print settlement only once
 * the pair's oracle has verified it with the terminator's own arguments. Past the grace or the last
 * resort the terminator settles at the stored price when the oracle refuses the prints, so the
 * call's simulation passes either way; these tests stand in for a terminator that always accepts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Print,
  RpcError,
  SETTLE_CHAIN,
  SETTLE_WINDOW,
  bazaarOracleAbi,
  bazaarPairTerminatorAbi,
  decodeError,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, decodeFunctionData, encodeAbiParameters, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Action, ActionResult, type RunOptions } from "../src/exec/executor.js";
import { FEED, ME, S, type Fake, fake, print } from "./keeper-harness.js";

const ORACLE_AT = getAddress(`0x${"0f".repeat(20)}`);
const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const VOTE = `0x${"ab".repeat(32)}` as Hex;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-terminate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Chain {
  rule: number;
  firstTarget: number;
  latestPublishTs: bigint;
  lastResortTs: number;
  scheduleId: Hex;
  claimBacked: boolean;
  verdict: number;
  cap: bigint;
  stored: bigint;
  /** whether the oracle verifies a set, by function */
  verifies: { fetchFirstPriceAtOrAfter: boolean; fetchChainedMedian: boolean };
  /** targets the archive has no print for */
  missing: Set<number>;
}

function setup(cutoff: number, o: Partial<Chain>) {
  const f: Fake = fake(dir);
  f.addWallet();
  const k = f.k;
  k.connected = true;
  k.updateBlock = async () => {};
  k.syncStep = async () => {};
  k.readStates = async () => {};
  k.prices.fetch = async () => {};
  const c: Chain = {
    rule: SETTLE_CHAIN,
    firstTarget: cutoff,
    latestPublishTs: U64_MAX,
    lastResortTs: cutoff + 21 * 86_400,
    scheduleId: ZERO32,
    claimBacked: false,
    verdict: 0,
    cap: 0n,
    stored: 2_000n * S,
    verifies: { fetchFirstPriceAtOrAfter: true, fetchChainedMedian: true },
    missing: new Set(),
    ...o,
  };
  const reads: string[] = [];
  k.reader.one = (async (_to: Address, _codec: unknown, fn: string) => {
    reads.push(fn);
    switch (fn) {
      case "settlementRule":
        return { rule: c.rule, firstTarget: BigInt(c.firstTarget), latestPublishTs: c.latestPublishTs, lastResortTs: BigInt(c.lastResortTs), verdictDeadline: 0n };
      case "insurerScheduleId":
        return c.scheduleId;
      case "oracle":
        return ORACLE_AT;
      case "scheduledTerminationTs":
        return BigInt(cutoff);
      case "umaCutoffCap":
        return c.cap;
      case "lastPairPrice":
        return { spotPrice: c.stored };
      case "insurerProposals":
        return { claimBacked: c.claimBacked, verdict: c.verdict };
      case "getUpdateFee":
        return 7n;
      case "getSampleSetFee":
        return 9n;
      default:
        throw new Error(`unexpected read ${fn}`);
    }
  }) as never;
  const targets: number[] = [];
  k.hermes.atOrAfter = (async (target: number) => {
    targets.push(target);
    return c.missing.has(target) ? [] : [print(FEED, 2_100, target)];
  }) as never;
  // the oracle, called as the terminator calls it
  const proofs: { fn: string; args: readonly unknown[]; from: Address | null; value: bigint }[] = [];
  k.chain.call = (async (to: Address, data: Hex, opts: { from?: Address | null; value?: bigint } = {}) => {
    expect(to).toBe(ORACLE_AT);
    const d = decodeFunctionData({ abi: bazaarOracleAbi, data });
    proofs.push({ fn: d.functionName, args: d.args ?? [], from: opts.from ?? null, value: opts.value ?? 0n });
    if (!c.verifies[d.functionName as keyof Chain["verifies"]]) throw new RpcError(3, "execution reverted", "0x");
    return encodeAbiParameters([{ type: "uint256" }], [d.functionName === "fetchChainedMedian" ? 2_150n * S : 2_100n * S]);
  }) as never;
  // a terminator that accepts every call (as one past its fallback does), unless told otherwise
  const runs: [Action, RunOptions][] = [];
  let accepts = (_a: Action) => true;
  k.executor.run = async (a: Action, opts: RunOptions = {}) => {
    runs.push([a, opts]);
    const res = new ActionResult({ status: opts.dryRun ? "simulated" : "confirmed", job: a.job, market: a.market?.label ?? "", summary: a.summary });
    if (!accepts(a)) {
      res.status = "skipped";
      res.error = decodeError("0x");
      res.reason = res.error.toString();
    }
    return res;
  };
  const updatesOf = (a: Action) => decodeFunctionData({ abi: bazaarPairTerminatorAbi, data: a.data }).args![1] as readonly Hex[];
  return { f, c, reads, targets, proofs, runs, updatesOf, accept: (fn: (a: Action) => boolean) => (accepts = fn) };
}

describe("terminateScheduledPair verifies the prints before it sends them (F4)", () => {
  it("chain rule: a verified set goes out with the price the oracle returns, and the proof uses the terminator's arguments", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 3_600;
    const s = setup(cutoff, { cap: BigInt(cutoff + 7_200), latestPublishTs: BigInt(cutoff + 7_200) });
    const r = await s.f.k.run.terminateScheduledPair("ETH/USD", { dryRun: true });
    expect(r.status).toBe("simulated");
    expect(r.summary).toBe("terminate ETH/USD at its cutoff under the chain rule (five chained prints), settling at 2150");
    expect(s.runs).toHaveLength(1);
    const [a] = s.runs[0]!;
    expect(a.value).toBe(9n);
    expect(s.updatesOf(a)).toHaveLength(5);
    expect(s.proofs).toEqual([
      { fn: "fetchChainedMedian", args: [FEED, s.updatesOf(a), BigInt(cutoff), BigInt(cutoff + 7_200), 600n, 5n], from: ME, value: 9n },
    ]);
    // without a UMA cap, the latest publish time is uint64's maximum
    const u = setup(cutoff, {});
    await u.f.k.run.terminateScheduledPair("ETH/USD", { dryRun: true });
    expect(u.proofs[0]!.args[3]).toBe(U64_MAX);
  });

  it("chain rule past its last resort: a set the oracle refuses is not sent as a print settlement; the stored-price call is", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 22 * 86_400;
    const s = setup(cutoff, { lastResortTs: cutoff + 21 * 86_400, verifies: { fetchFirstPriceAtOrAfter: true, fetchChainedMedian: false } });
    const r = await s.f.k.run.terminateScheduledPair("ETH/USD");
    expect(s.runs).toHaveLength(1); // only the empty call
    expect(s.updatesOf(s.runs[0]![0])).toEqual([]);
    expect(s.runs[0]![0].value).toBe(0n);
    expect(r.status).toBe("confirmed");
    expect(r.summary).toBe("terminate ETH/USD at its cutoff at its stored price, 2000 (the last resort is open)");
    expect(r.reason).toContain(
      "under the chain rule (five chained prints), the oracle would not verify the prints (execution reverted); the stored-price " +
        "fallback is open, so a call carrying them would settle at the stored price (2000) instead: not sent as a print settlement",
    );
  });

  it("UMA's rule within its grace: a refused set is reported, nothing is sent, and the proof uses cutoff − 3 and the cutoff", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 600;
    const s = setup(cutoff, {
      rule: SETTLE_WINDOW,
      firstTarget: cutoff - 3,
      latestPublishTs: BigInt(cutoff),
      lastResortTs: cutoff + 12 * 3_600,
      verifies: { fetchFirstPriceAtOrAfter: false, fetchChainedMedian: true },
    });
    const r = await s.f.k.run.terminateScheduledPair("ETH/USD");
    expect(s.runs).toHaveLength(0);
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe(
      "under UMA's rule (the window's first print), the oracle would not verify the prints (execution reverted), and the terminator " +
        `would refuse them too; the stored-price fallback opens at ${cutoff + 12 * 3_600}`,
    );
    expect(s.proofs.map((p) => [p.fn, p.args[2], p.args[3], p.value])).toEqual([["fetchFirstPriceAtOrAfter", BigInt(cutoff - 3), BigInt(cutoff), 7n]]);
  });

  it("a vote with no claim settles under the chain rule only: UMA-rule prints are never tried", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 22 * 86_400;
    const s = setup(cutoff, { scheduleId: VOTE, claimBacked: false, verifies: { fetchFirstPriceAtOrAfter: true, fetchChainedMedian: false } });
    const r = await s.f.k.run.terminateScheduledPair("ETH/USD", { dryRun: true });
    expect(s.targets).not.toContain(cutoff - 3);
    expect(s.proofs.map((p) => p.fn)).toEqual(["fetchChainedMedian"]);
    expect(r.summary).toMatch(/at its stored price, 2000/); // never "under UMA's rule"
  });

  it("an unrecorded verdict past the chain rule's last resort: chain set first; UMA-rule prints only once the chain rule is ruled out", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 22 * 86_400;
    const base = { scheduleId: VOTE, claimBacked: true, verdict: 0, lastResortTs: cutoff + 21 * 86_400 };
    // No chain prints: whether UMA's rule applies is unknown, and the chain rule's fallback is open.
    const a = setup(cutoff, { ...base, missing: new Set([cutoff]) });
    a.accept((x) => a.updatesOf(x).length === 0); // the empty call settles (the chain rule's fallback)
    const r = await a.f.k.run.terminateScheduledPair("ETH/USD");
    expect(a.runs.map(([x]) => a.updatesOf(x).length)).toEqual([0]); // the UMA-rule set was verified but not sent
    expect(r.summary).toMatch(/at its stored price/);
    expect(r.reason).toContain(`Record the verdict first (settleTerminationProposal ${VOTE}), then run this again`);
    // The terminator reverts on a verified chain set: the chain rule does not apply, so UMA's does.
    const b = setup(cutoff, base);
    b.accept((x) => b.updatesOf(x).length === 1);
    const r2 = await b.f.k.run.terminateScheduledPair("ETH/USD");
    expect(b.runs.map(([x]) => b.updatesOf(x).length)).toEqual([5, 1]);
    expect(r2.status).toBe("confirmed");
    expect(r2.summary).toBe("terminate ETH/USD at its cutoff under UMA's rule (the window's first print), settling at 2100");
    expect(b.runs[1]![0].value).toBe(7n);
  });
});
