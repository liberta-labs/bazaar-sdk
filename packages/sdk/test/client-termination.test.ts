import { type Abi, type Address, type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, padHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ContractCodec, factory as factoryCodec, lens as lensCodec, oracle as oracleCodec, pair as pairCodec, terminator as terminatorCodec } from "../src/chain/codec.js";
import { InputError } from "../src/client/calls.js";
import { ConnectError, type PriceUpdateSource } from "../src/client/context.js";
import {
  type PrintFetcher,
  type SettlementPrint,
  chainLastResort,
  chainPrints,
  executeInsurerTermination,
  finalizeTermination,
  getInsurerVote,
  getLockedShares,
  getTerminalEntitlement,
  insurerProposal,
  insurerProposalId,
  openProposals,
  printFetcher,
  proposalIdsFromReceipt,
  proposeInsurerTermination,
  proposeTermination,
  reasonProblem,
  settleTerminationProposal,
  settlementPrintProblem,
  settlementRule,
  terminateScheduledPair,
  terminateStalePair,
  terminationProposal,
  terminationStatus,
  terminatorConstants,
  unjudgedLevyBp,
  voteForInsurerTermination,
  windowPrints,
} from "../src/client/termination.js";
import {
  BondQuoteError,
  assertionPhase,
  assertionStatus,
  disputeAssertion,
  erc20Codec,
  ethText,
  optimisticOracleCodec,
  previewSettlement,
  settleAssertion,
  sharesText,
  statusOf,
  timeText,
  usdcText,
} from "../src/client/uma.js";
import { ADDR, FakeChain, Revert, b32, errorData, makeCtx, stringError } from "./termination-fakes.js";

const NOW = 1_900_000_000;
const H = 3_600;
const D = 86_400;
const ZERO32 = b32(0);
const FEED_A = b32(0xaaa1);
const FEED_Q = b32(0xf0f0);
const COMPOSITE = b32(0xc0c0);
const E18 = 10n ** 18n;
const T = () => terminatorCodec();
const P = () => pairCodec();
const registry = new ContractCodec([
  { type: "function", name: "getImplementationAddress", stateMutability: "view", inputs: [{ name: "n", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isIdentifierSupported", stateMutability: "view", inputs: [{ name: "i", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as unknown as Abi);

const blob = (feed: Hex, t: number) => ("0x" + feed.slice(-4) + t.toString(16).padStart(12, "0")) as Hex;

/** A hand-built archive: the first print at or after each target, prev = the print before it. */
function archive(series: Record<string, number[]>) {
  const asked: [Hex, number][] = [];
  const fetch: PrintFetcher = async (feed, target) => {
    asked.push([feed, target]);
    const ts = series[feed]!;
    const i = ts.findIndex((t) => t >= target);
    if (i < 0) return null;
    return { feedId: feed, update: blob(feed, ts[i]!), publishTime: ts[i]!, prevPublishTime: i > 0 ? ts[i - 1]! : ts[i]! - 1_000 };
  };
  return { fetch, asked };
}

interface Scene {
  fake: FakeChain;
  ctx: ReturnType<typeof makeCtx>;
  st: Record<string, any>;
}

function scene(): Scene {
  const fake = new FakeChain();
  fake.now = NOW;
  const ctx = makeCtx(fake);
  const st: Record<string, any> = {
    scheduled: 0n,
    fixedTs: 0n,
    terminated: false,
    settlementPrice: 0n,
    longOI: 0n,
    shortOI: 0n,
    lastPrice: { spotPrice: 100n * E18, updateTs: BigInt(NOW - 100) },
    created: BigInt(NOW - 100 * D),
    baseFeedId: FEED_A,
    composite: null as null | { baseId: Hex; quoteId: Hex; invertQuote: boolean },
    isPair: true,
    rule: { rule: 0, firstTarget: 0n, latestPublishTs: 0n, lastResortTs: 0n, verdictDeadline: 0n },
    scheduleId: ZERO32,
    cap: 0n,
    accepted: ZERO32,
    insurer: new Map<string, Record<string, unknown>>(),
    claims: new Map<string, Record<string, unknown>>(),
    bond: 1_000_000_000n,
    identifierLive: true,
    allowance: 0n,
    balance: 1_000_000_000_000n,
    sharesAsOf: (_u: Address, _ts: bigint) => 0n,
    epoch: 0n,
    totalShares: 0n,
    orphanShares: 0n,
    voted: 0n,
    locked: 0n,
    assertions: new Map<string, Record<string, unknown>>(),
    preview: new Revert(stringError("Assertion not resolved")) as unknown,
    probe: { found: false, spotPrice: 0n, lowPrice: 0n, highPrice: 0n, publishTime: 0n },
    accept: (_updates: readonly Hex[], _value: bigint): true | Hex => true,
    // The oracle's verification of a print set (fetchFirstPriceAtOrAfter / fetchChainedMedian): a price, or revert data.
    prove: (_fn: string, _args: readonly unknown[], _value: bigint): bigint | Hex => 2_000n * E18,
    whitelisted: (_id: Hex) => true,
  };
  const p = ADDR.pair;
  const t = ADDR.terminator;
  fake
    .on(p, P(), "scheduledTerminationTs", () => st.scheduled)
    .on(p, P(), "settlementPriceFixedTs", () => st.fixedTs)
    .on(p, P(), "isPairTerminated", () => st.terminated)
    .on(p, P(), "auxState", () => ({ pairCreatedTs: st.created, settlementPrice: st.settlementPrice }))
    .on(p, P(), "pairVault", () => ({ totalLongOI: st.longOI, totalShortOI: st.shortOI }))
    .on(p, P(), "lastPairPrice", () => st.lastPrice)
    .on(p, P(), "oracle", ADDR.oracle)
    .on(p, P(), "baseFeedId", () => st.baseFeedId)
    .on(p, P(), "extsload", () => b32(st.epoch))
    .on(p, P(), "getSharesAsOf", ([u, ts]) => st.sharesAsOf(u, ts))
    .on(p, P(), "totalInsuranceShares", () => st.totalShares)
    .on(p, P(), "insuranceShares", () => st.orphanShares)
    .on(t, T(), "isPair", () => st.isPair)
    .on(t, T(), "settlementRule", () => st.rule)
    .on(t, T(), "insurerScheduleId", () => st.scheduleId)
    .on(t, T(), "umaCutoffCap", () => st.cap)
    .on(t, T(), "acceptedTerminationAssertionId", () => st.accepted)
    .on(t, T(), "requiredTerminationBond", () => st.bond)
    .on(t, T(), "terminationProposals", ([id]) => st.claims.get(id) ?? {})
    .on(t, T(), "insurerProposals", ([id]) => st.insurer.get(id) ?? {})
    .on(t, T(), "getInsurerVote", () => st.voted)
    .on(t, T(), "getLockedShares", () => st.locked)
    .on(t, T(), "assertionOo", () => ADDR.oo)
    .on(t, T(), "terminateScheduledPair", ([, updates], tx) => {
      const r = st.accept(updates, tx.value);
      if (r !== true) throw new Revert(r);
    })
    .on(ADDR.factory, factoryCodec(), "umaIdentifierIsLive", () => st.identifierLive)
    .on(ADDR.factory, factoryCodec(), "oo", ADDR.oo)
    .on(ADDR.factory, factoryCodec(), "assertionOo", ADDR.oo)
    .on(ADDR.oracle, oracleCodec(), "composites", ([id]) => (id === st.baseFeedId && st.composite ? st.composite : {}))
    .on(ADDR.oracle, oracleCodec(), "getUpdateFee", ([u]) => 7n * BigInt(u.length))
    .on(ADDR.oracle, oracleCodec(), "getSampleSetFee", ([, u]) => 3n * BigInt(u.length))
    .on(ADDR.oracle, oracleCodec(), "tryReadStalePrice", () => st.probe)
    .on(ADDR.oracle, oracleCodec(), "fetchFirstPriceAtOrAfter", (a, tx) => {
      const r = st.prove("fetchFirstPriceAtOrAfter", a, tx.value);
      if (typeof r !== "bigint") throw new Revert(r);
      return r;
    })
    .on(ADDR.oracle, oracleCodec(), "fetchChainedMedian", (a, tx) => {
      const r = st.prove("fetchChainedMedian", a, tx.value);
      if (typeof r !== "bigint") throw new Revert(r);
      return r;
    })
    .on(ADDR.usdc, erc20Codec(), "allowance", () => st.allowance)
    .on(ADDR.usdc, erc20Codec(), "balanceOf", () => st.balance)
    .on(ADDR.oo, optimisticOracleCodec(), "getAssertion", ([id]) => st.assertions.get(id) ?? {})
    .on(ADDR.oo, optimisticOracleCodec(), "burnedBondPercentage", 5n * 10n ** 17n)
    .on(ADDR.oo, optimisticOracleCodec(), "finder", ADDR.finder)
    .on(ADDR.oo, optimisticOracleCodec(), "settleAndGetAssertionResult", () => {
      if (st.preview instanceof Revert) throw st.preview;
      return st.preview;
    })
    .on(ADDR.finder, registry, "getImplementationAddress", ADDR.whitelist)
    .on(ADDR.whitelist, registry, "isIdentifierSupported", ([id]) => st.whitelisted(id))
    .on(ADDR.lens, lensCodec(), "getTerminalEntitlement", () => ({ collateral: 10n * E18, registeredClaim: 4n * E18, principalRatio: E18, profitRatio: E18 / 2n, payout: 12n * E18 }));
  return { fake, ctx, st };
}

const decodeCall = (c: ContractCodec, fn: string, data: Hex) => decodeAbiParameters(c.fn(fn).inputs, ("0x" + data.slice(10)) as Hex);

async function inputError(p: Promise<unknown>, field?: string): Promise<InputError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InputError);
    if (field) expect((e as InputError).field).toBe(field);
    return e as InputError;
  }
  throw new Error("expected an InputError");
}

// ---------------------------------------------------------------------------------------------
// Settlement-print selection
// ---------------------------------------------------------------------------------------------

describe("settlementPrintProblem", () => {
  const pr = (publishTime: number, prevPublishTime: number | null): SettlementPrint => ({ feedId: FEED_A, update: "0x01", publishTime, prevPublishTime });
  const target = 1_000;

  it("accepts the first print at or after the target, inside the bound", () => {
    expect(settlementPrintProblem(pr(1_000, 999), target, 1_003)).toBeNull(); // published exactly at the target
    expect(settlementPrintProblem(pr(1_002, 990), target, 1_003)).toBeNull();
    expect(settlementPrintProblem(pr(1_003, 999), target, 1_003)).toBeNull(); // exactly at the bound
    expect(settlementPrintProblem(pr(5_000, 999), target, null)).toBeNull(); // unbounded chain
  });

  it("refuses a print published before its target", () => {
    expect(settlementPrintProblem(pr(999, 990), target, 1_003)).toMatch(/before its target/);
  });

  it("refuses a print whose predecessor is at or after the target (not the first)", () => {
    expect(settlementPrintProblem(pr(1_002, 1_000), target, 1_003)).toMatch(/not the first/); // prev == target
    expect(settlementPrintProblem(pr(1_002, 1_001), target, 1_003)).toMatch(/not the first/);
    expect(settlementPrintProblem(pr(1_002, 999), target, 1_003)).toBeNull(); // prev one second before
  });

  it("leaves an unreported prevPublishTime to Pyth", () => {
    expect(settlementPrintProblem(pr(1_002, null), target, 1_003)).toBeNull();
  });

  it("refuses a print published after latestPublishTs", () => {
    expect(settlementPrintProblem(pr(1_004, 999), target, 1_003)).toMatch(/after the latest publish time/);
  });
});

describe("windowPrints and chainPrints", () => {
  const C = 2_000_000; // cutoff

  it("UMA's rule takes each leg's first print at or after cutoff - 3", async () => {
    const a = archive({ [FEED_A]: [C - 10, C - 2, C - 1, C + 5], [FEED_Q]: [C - 4, C - 3, C + 1] });
    const prints = await windowPrints(a.fetch, [FEED_A, FEED_Q], C - 3, C);
    expect(prints.map((p) => p.publishTime)).toEqual([C - 2, C - 3]);
    expect(prints.map((p) => p.update)).toEqual([blob(FEED_A, C - 2), blob(FEED_Q, C - 3)]);
    expect(a.asked).toEqual([
      [FEED_A, C - 3],
      [FEED_Q, C - 3],
    ]);
  });

  it("UMA's rule fails when the window is empty (first print after the cutoff)", async () => {
    const a = archive({ [FEED_A]: [C - 10, C + 5] });
    await expect(windowPrints(a.fetch, [FEED_A], C - 3, C)).rejects.toThrow(/after the latest publish time/);
  });

  it("chains five samples, each target the previous print + 600 s", async () => {
    const a = archive({ [FEED_A]: [C - 1, C + 2, C + 300, C + 601, C + 700, C + 1_205, C + 1_810, C + 2_420, C + 3_100, C + 9_000] });
    const { prints, targets } = await chainPrints(a.fetch, [FEED_A], C, null);
    expect(targets).toEqual([C, C + 602, C + 1_300, C + 2_410, C + 3_020]);
    expect(prints.map((p) => p.publishTime)).toEqual([C + 2, C + 700, C + 1_810, C + 2_420, C + 3_100]);
  });

  it("measures a composite's next target from the later leg (a session close to the reopen)", async () => {
    // Friday 16:00 close at C, Monday 09:30 reopen at R; the FX leg prints every second.
    const R = C + 235_800;
    const equity: PrintFetcher = async (feed, target) => {
      const t = target <= C ? C : target <= R ? R : R + Math.ceil((target - R) / 60) * 60;
      const prev = t === C ? C - 5 : t === R ? C : t - 60;
      return { feedId: feed, update: blob(feed, t), publishTime: t, prevPublishTime: prev };
    };
    const fx: PrintFetcher = async (feed, target) => ({ feedId: feed, update: blob(feed, target), publishTime: target, prevPublishTime: target - 1 });
    const fetch: PrintFetcher = (feed, target) => (feed === FEED_A ? equity(feed, target) : fx(feed, target));
    const { prints, targets } = await chainPrints(fetch, [FEED_A, FEED_Q], C, null);
    expect(targets).toEqual([C, C + 600, R + 600, R + 1_200, R + 1_800]);
    expect(prints.filter((p) => p.feedId === FEED_A).map((p) => p.publishTime)).toEqual([C, R, R + 600, R + 1_200, R + 1_800]);
    // updates ordered sample by sample, legs in order
    expect(prints.map((p) => p.feedId)).toEqual([FEED_A, FEED_Q, FEED_A, FEED_Q, FEED_A, FEED_Q, FEED_A, FEED_Q, FEED_A, FEED_Q]);
  });

  it("refuses a chain whose sample lands past the UMA cap", async () => {
    const a = archive({ [FEED_A]: [C + 2, C + 700, C + 1_810, C + 2_420, C + 3_100] });
    await expect(chainPrints(a.fetch, [FEED_A], C, C + 1_000)).rejects.toThrow(/after the latest publish time allowed \(2001000\)/);
  });

  it("refuses a print the archive returns that is not the first at or after its target", async () => {
    const liar: PrintFetcher = async (feed) => ({ feedId: feed, update: "0x01", publishTime: C - 1, prevPublishTime: C - 2 });
    await expect(windowPrints(liar, [FEED_A], C - 3, C)).rejects.toThrow(/not the first/);
  });

  it("printFetcher asks the price source one feed at a time", async () => {
    const asked: [number, readonly Hex[]][] = [];
    const src: PriceUpdateSource = {
      latest: async () => ({ update: [], publishTime: 0 }),
      atOrAfter: async (t, feeds) => {
        asked.push([t, feeds]);
        return [{ update: ["0xbeef"], publishTime: t + 1, prevPublishTime: t - 1 }];
      },
    };
    const p = await printFetcher(src)(FEED_A, 500);
    expect(p).toEqual({ feedId: FEED_A, update: "0xbeef", publishTime: 501, prevPublishTime: 499 });
    expect(asked).toEqual([[500, [FEED_A]]]);
    const many: PriceUpdateSource = { latest: src.latest, atOrAfter: async () => [{ update: ["0x01", "0x02"], publishTime: 1, prevPublishTime: 0 }] };
    await expect(printFetcher(many)(FEED_A, 1)).rejects.toThrow(/exactly one update per leg/);
    expect(() => printFetcher(null)).toThrow(ConnectError);
    expect(() => printFetcher({ latest: src.latest })).toThrow(ConnectError);
  });

  it("chainLastResort is 21 days after the cutoff, or 12 h after a nearer UMA cap", () => {
    expect(chainLastResort(1_000, null)).toBe(1_000 + 21 * D);
    expect(chainLastResort(1_000, 1_000 + D)).toBe(1_000 + D + 12 * H);
    expect(chainLastResort(1_000, 1_000 + 30 * D)).toBe(1_000 + 21 * D);
  });
});

// ---------------------------------------------------------------------------------------------
// terminateScheduledPair
// ---------------------------------------------------------------------------------------------

describe("terminateScheduledPair", () => {
  let s: Scene;
  const C = NOW - 5_000;
  const U64_MAX = (1n << 64n) - 1n;
  beforeEach(() => {
    s = scene();
    s.st.scheduled = BigInt(C);
  });
  const windowRule = (lastResort = C + 12 * H) => ({ rule: 1, firstTarget: BigInt(C - 3), latestPublishTs: BigInt(C), lastResortTs: BigInt(lastResort), verdictDeadline: 0n });
  const chainRule = (latest = U64_MAX, lastResort = C + 21 * D) => ({ rule: 2, firstTarget: BigInt(C), latestPublishTs: latest, lastResortTs: BigInt(lastResort), verdictDeadline: 0n });
  const chainSeries = [C - 1, C + 2, C + 700, C + 1_400, C + 2_100, C + 2_800, C + 9_000];

  it("UMA's rule: one proven print per leg, with getUpdateFee as value", async () => {
    s.st.rule = windowRule();
    const a = archive({ [FEED_A]: [C - 10, C - 2, C - 1, C + 5] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.under).toBe("window");
    expect(plan.call).not.toBeNull();
    const [pair, updates] = decodeCall(T(), "terminateScheduledPair", plan.call!.data);
    expect(pair).toBe(ADDR.pair);
    expect(updates).toEqual([blob(FEED_A, C - 2)]);
    expect(plan.call!.value).toBe(7n);
    expect(plan.call!.costs).toEqual([expect.objectContaining({ kind: "fee", amount: 7n, unit: "ETH" })]);
    expect(plan.call!.summary).toMatch(/Pyth fee/);
    // simulated as the sender, with the fee
    const sim = s.fake.called("terminateScheduledPair");
    expect(sim).toHaveLength(1);
    expect(sim[0]!.from).toBe(ADDR.alice);
    expect(sim[0]!.value).toBe(7n);
  });

  it("composite pairs carry one update per leg", async () => {
    s.st.rule = windowRule();
    s.st.composite = { baseId: FEED_A, quoteId: FEED_Q, invertQuote: false };
    s.st.baseFeedId = COMPOSITE;
    const a = archive({ [FEED_A]: [C - 20, C - 1], [FEED_Q]: [C - 4, C - 3, C] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    const [, updates] = decodeCall(T(), "terminateScheduledPair", plan.call!.data);
    expect(updates).toEqual([blob(FEED_A, C - 1), blob(FEED_Q, C - 3)]);
    expect(plan.call!.value).toBe(14n);
  });

  it("an empty window waits for the stored-price fallback, then takes it", async () => {
    s.st.rule = windowRule();
    const a = archive({ [FEED_A]: [C - 10, C + 5] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.call).toBeNull();
    expect(plan.reason).toMatch(/after the latest publish time/);
    expect(plan.retryAt).toBe(C + 12 * H + 1);

    s.st.rule = windowRule(NOW - 1);
    const late = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(late.under).toBe("storedPrice");
    expect(decodeCall(T(), "terminateScheduledPair", late.call!.data)[1]).toEqual([]);
    expect(late.call!.value).toBe(0n);
    expect(late.call!.costs).toEqual([]);
  });

  it("past the last resort a proven print is still preferred", async () => {
    s.st.rule = windowRule(NOW - 1);
    const a = archive({ [FEED_A]: [C - 10, C - 1] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.under).toBe("window");
    expect(plan.call!.notes.join(" ")).toMatch(/if Pyth refused these prints when the call runs, the market would settle at its stored price \(100\)/);
  });

  // Audit F4: past the grace the terminator catches a failed fetch and settles at the stored price,
  // so the simulation alone accepts prints Pyth refuses.
  it("verifies the window print through the oracle as the terminator calls it, and shows its price", async () => {
    s.st.rule = windowRule();
    s.st.prove = () => 2_000_500_000_000_000_000_000n;
    const a = archive({ [FEED_A]: [C - 10, C - 2, C - 1, C + 5] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    const proof = s.fake.called("fetchFirstPriceAtOrAfter");
    expect(proof).toHaveLength(1);
    expect(proof[0]!.args).toEqual([FEED_A, [blob(FEED_A, C - 2)], BigInt(C - 3), BigInt(C)]);
    expect([proof[0]!.to, proof[0]!.from, proof[0]!.value]).toEqual([ADDR.oracle, ADDR.alice, 7n]);
    expect(plan.under).toBe("window");
    expect(plan.settlementPrice).toBe(2_000_500_000_000_000_000_000n);
    expect(plan.attempts).toEqual([expect.objectContaining({ under: "window", ok: true, price: 2_000_500_000_000_000_000_000n })]);
    expect(plan.call!.summary).toMatch(/at 2000\.5 under UMA's rule/);
    expect(plan.call!.notes[0]).toMatch(/^Settles at 2000\.5: .*which the oracle verified/);
  });

  it("past the grace, prints the oracle refuses are not offered as proof: the stored-price call is, with its price", async () => {
    s.st.rule = windowRule(NOW - 1);
    s.st.prove = () => stringError("PriceFeedNotFoundWithinRange");
    const a = archive({ [FEED_A]: [C - 10, C - 1] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.under).toBe("storedPrice");
    expect(plan.settlementPrice).toBe(100n * E18);
    expect(decodeCall(T(), "terminateScheduledPair", plan.call!.data)[1]).toEqual([]);
    expect(plan.call!.value).toBe(0n);
    expect(plan.call!.summary).toMatch(/at 100 under the stored price/);
    expect(plan.call!.notes[0]).toMatch(/settles at its last stored price, 100\./);
    expect(plan.attempts.map((x) => [x.under, x.ok, x.price])).toEqual([
      ["window", false, null],
      ["storedPrice", true, 100n * E18],
    ]);
    expect(plan.attempts[0]!.reason).toMatch(/would not verify these prints \(PriceFeedNotFoundWithinRange\).*would settle at the market's stored price \(100\) instead/);
    // The print set was never simulated as a settlement: only the empty call was.
    expect(s.fake.called("terminateScheduledPair").map((c) => c.args[1])).toEqual([[]]);
    // A pair that never stored a price settles at 1.
    s.st.lastPrice = { spotPrice: 0n, updateTs: 0n };
    expect((await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch })).settlementPrice).toBe(1n);
  });

  it("within the grace, prints the oracle refuses give no call", async () => {
    s.st.rule = windowRule();
    s.st.prove = () => stringError("PriceFeedNotFoundWithinRange");
    const a = archive({ [FEED_A]: [C - 10, C - 1] });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.call).toBeNull();
    expect(plan.settlementPrice).toBeNull();
    expect(plan.reason).toMatch(/would not verify these prints \(PriceFeedNotFoundWithinRange\)\. The terminator would refuse them too\./);
    expect(plan.retryAt).toBe(C + 12 * H + 1);
    expect(s.fake.called("terminateScheduledPair")).toEqual([]);
  });

  it("verifies a chain through fetchChainedMedian with the terminator's bounds, and falls back past its last resort", async () => {
    s.st.rule = chainRule(BigInt(C + 9_999), C + 9_999 + 12 * H);
    s.st.cap = BigInt(C + 9_999);
    s.st.prove = () => 1_234n * E18;
    const a = archive({ [FEED_A]: chainSeries });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    const proof = s.fake.called("fetchChainedMedian");
    expect(proof[0]!.args).toEqual([FEED_A, [C + 2, C + 700, C + 1_400, C + 2_100, C + 2_800].map((t) => blob(FEED_A, t)), BigInt(C), BigInt(C + 9_999), 600n, 5n]);
    expect(proof[0]!.value).toBe(15n);
    expect([plan.under, plan.settlementPrice]).toEqual(["chain", 1_234n * E18]);

    // No UMA cap: the terminator bounds the chain at uint64 max.
    s.st.cap = 0n;
    s.st.rule = chainRule();
    await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: archive({ [FEED_A]: chainSeries }).fetch });
    expect(s.fake.called("fetchChainedMedian").at(-1)!.args[3]).toBe(U64_MAX);

    // Past the last resort a refused chain is the stored price's.
    s.st.rule = chainRule(U64_MAX, NOW - 1);
    s.st.prove = () => stringError("SampleCountMismatch");
    const late = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: archive({ [FEED_A]: chainSeries }).fetch });
    expect([late.under, late.settlementPrice]).toEqual(["storedPrice", 100n * E18]);
  });

  it("the chain rule: five chained samples with getSampleSetFee as value", async () => {
    s.st.rule = chainRule();
    s.st.scheduleId = b32(0xb4e);
    s.st.insurer.set(b32(0xb4e), { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(C - D), cutoffTs: BigInt(C), claimBacked: false, resolved: true, scheduled: true });
    const a = archive({ [FEED_A]: chainSeries });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.under).toBe("chain");
    const [, updates] = decodeCall(T(), "terminateScheduledPair", plan.call!.data);
    expect(updates).toEqual([C + 2, C + 700, C + 1_400, C + 2_100, C + 2_800].map((t) => blob(FEED_A, t)));
    expect(plan.call!.value).toBe(15n);
    const fee = s.fake.called("getSampleSetFee");
    expect(fee[0]!.args[0]).toBe(FEED_A);
    // a bare vote never needs the window print
    expect(a.asked.every(([, t]) => t !== C - 3)).toBe(true);
  });

  it("a chain capped by a UMA cutoff that has no complete set waits for its last resort", async () => {
    s.st.rule = chainRule(BigInt(C + 1_000), C + 1_000 + 12 * H);
    const a = archive({ [FEED_A]: chainSeries });
    const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
    expect(plan.call).toBeNull();
    expect(plan.reason).toMatch(/latest publish time allowed/);
    expect(plan.retryAt).toBe(C + 1_000 + 12 * H + 1);
  });

  describe("a claim-backed vote with no recorded verdict", () => {
    const CLAIM = b32(0xc1a1);
    beforeEach(() => {
      s.st.scheduleId = CLAIM;
      s.st.cap = BigInt(C + 5_000);
      s.st.insurer.set(CLAIM, { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(C - D), cutoffTs: BigInt(C), claimBacked: true, verdict: 0, resolved: true, scheduled: true });
      s.st.rule = { rule: 3, firstTarget: 0n, latestPublishTs: 0n, lastResortTs: 0n, verdictDeadline: BigInt(C - D + 14 * D) };
      s.st.assertions.set(CLAIM, { asserter: ADDR.bob, assertionTime: BigInt(C - D), expirationTime: BigInt(C - D + 12 * H), currency: ADDR.usdc, bond: 1_000_000_000n, disputer: ADDR.alice });
    });
    const both = () => archive({ [FEED_A]: [C - 2, ...chainSeries] });

    it("settles under UMA's rule when the DVM upheld the claim", async () => {
      s.st.preview = true;
      const a = both();
      const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
      expect(plan.under).toBe("window");
      expect(decodeCall(T(), "terminateScheduledPair", plan.call!.data)[1]).toEqual([blob(FEED_A, C - 2)]);
      expect(plan.call!.notes.join(" ")).toMatch(/records UMA's verdict/);
      expect(a.asked).toEqual([[FEED_A, C - 3]]); // the chain is never fetched
    });

    it("settles under the chain rule, capped, when the DVM rejected it", async () => {
      s.st.preview = false;
      s.st.cap = BigInt(C + 1_500); // the third sample would be past it
      const a = both();
      const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
      expect(plan.call).toBeNull();
      expect(plan.reason).toMatch(/latest publish time allowed \(1899996500\)/);
      s.st.cap = 0n;
      const ok = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: both().fetch });
      expect(ok.under).toBe("chain");
    });

    it("builds both sets and returns the one the contract accepts when the verdict cannot be previewed", async () => {
      s.st.preview = new Revert(stringError("Assertion not resolved"));
      s.st.accept = (updates: readonly Hex[]) => (updates.length === 5 ? true : errorData(T(), "BazaarPairTerminator__InsurerVerdictPending", 1n));
      const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: both().fetch });
      expect(plan.under).toBe("chain");
      expect(plan.attempts.map((x) => [x.under, x.ok])).toEqual([
        ["window", false],
        ["chain", true],
      ]);
      expect(plan.attempts[0]!.error?.name).toBe("BazaarPairTerminator__InsurerVerdictPending");
    });

    it("reports the verdict deadline when the contract takes neither", async () => {
      s.st.accept = () => errorData(T(), "BazaarPairTerminator__InsurerVerdictPending", BigInt(C + 13 * D));
      const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: both().fetch });
      expect(plan.call).toBeNull();
      expect(plan.attempts).toHaveLength(2);
      expect(plan.retryAt).toBe(C - D + 14 * D);
      expect(plan.reason).toMatch(/waits for UMA's verdict/);
    });

    it("waits for an undisputed claim's liveness without fetching anything", async () => {
      s.st.assertions.set(CLAIM, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 600), currency: ADDR.usdc, bond: 1n });
      const a = both();
      const plan = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: a.fetch });
      expect(plan.call).toBeNull();
      expect(plan.retryAt).toBe(NOW + 600);
      expect(a.asked).toEqual([]);
    });
  });

  it("refuses up front before the cutoff, with no cutoff, and once fixed", async () => {
    s.st.rule = windowRule();
    s.st.scheduled = BigInt(NOW + 10);
    expect((await inputError(terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: archive({}).fetch }), "pair")).message).toMatch(/first block after it/);
    s.st.scheduled = 0n;
    await inputError(terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: archive({}).fetch }), "pair");
    s.st.scheduled = BigInt(C);
    s.st.fixedTs = BigInt(NOW - 1);
    await inputError(terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchPrint: archive({}).fetch }), "pair");
  });
});

// ---------------------------------------------------------------------------------------------
// UMA-claim termination
// ---------------------------------------------------------------------------------------------

describe("proposeTermination", () => {
  let s: Scene;
  beforeEach(() => (s = scene()));
  const args = (o: Partial<{ category: number; lastTradingTs: number; reason: string }> = {}) => ({
    pair: ADDR.pair,
    category: 1,
    lastTradingTs: NOW + 13 * H,
    reason: "Pyth announced the feed is decommissioned on 2030-01-01: https://pyth.network/x?id=1",
    from: ADDR.alice,
    ...o,
  });

  it("encodes the claim and posts the live bond, with the USDC approval for the terminator", async () => {
    s.st.bond = 1_250_000_000n; // UMA's minimum above the floor
    const c = await proposeTermination(s.ctx, args());
    const [pair, category, ts, reason] = decodeCall(T(), "proposeTermination", c.data);
    expect([pair, category, ts, reason]).toEqual([ADDR.pair, 1, BigInt(NOW + 13 * H), args().reason]);
    expect(c.to).toBe(ADDR.terminator);
    expect(c.pullsUsdc).toBe(1_250_000_000n * 10n ** 12n);
    expect(c.costs).toEqual([expect.objectContaining({ kind: "bond", amount: 1_250_000_000n, unit: "USDC", token: ADDR.usdc })]);
    expect(c.summary).toMatch(/1,250 USDC UMA bond/);
    expect(c.approvals).toHaveLength(1);
    const [spender, amount] = decodeCall(erc20Codec(), "approve", c.approvals[0]!.data);
    expect([c.approvals[0]!.to, spender, amount]).toEqual([ADDR.usdc, ADDR.terminator, 1_250_000_000n]);
    expect(c.notes.join(" ")).not.toMatch(/less than 12 hours/);
  });

  it("skips the approval when the allowance covers the bond, and flags a short balance", async () => {
    s.st.allowance = 1_000_000_000n;
    s.st.balance = 10n;
    const c = await proposeTermination(s.ctx, args());
    expect(c.approvals).toEqual([]);
    expect(c.requires.join(" ")).toMatch(/at least 1,000 USDC/);
    expect(c.notes.join(" ")).not.toMatch(/Warning/); // exactly the bond: nothing to warn about
  });

  // Audit F10: the bond is quoted at build time and pulled at execution.
  it("refuses a bond quote below the terminator's floor, and warns when the allowance exceeds the quote", async () => {
    s.st.bond = 0n;
    await expect(proposeTermination(s.ctx, args())).rejects.toThrow(BondQuoteError);
    s.st.bond = 999_999_999n;
    await expect(proposeTermination(s.ctx, args())).rejects.toThrow(/termination bond of 999\.999999 USDC, below the 1,000 USDC the contract always charges/);
    s.st.bond = 1_000_000_000n;
    s.st.allowance = 3_000_000_000n;
    const c = await proposeTermination(s.ctx, args());
    expect(c.approvals).toEqual([]);
    expect(c.notes.join(" ")).toMatch(/Warning: this wallet already lets the Bazaar terminator .* take up to 3,000 USDC, more than the 1,000 USDC quoted for the termination bond.*approve exactly 1,000 USDC/);
    s.st.sharesAsOf = () => E18;
    const bare = await proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 3 * H, from: ADDR.alice });
    expect(bare.notes.join(" ")).toMatch(/Warning: this wallet already lets the Bazaar terminator .* more than the 1,000 USDC quoted for the insurer-vote bond/);
  });

  it("explains a cutoff nearer than the liveness", async () => {
    const c = await proposeTermination(s.ctx, args({ lastTradingTs: NOW + 3 * H }));
    expect(c.notes.join(" ")).toMatch(/less than 12 hours away/);
  });

  it("refuses what the terminator would refuse", async () => {
    await inputError(proposeTermination(s.ctx, args({ category: 0 })), "category");
    await inputError(proposeTermination(s.ctx, args({ category: 5 })), "category");
    await inputError(proposeTermination(s.ctx, args({ reason: "" })), "reason");
    await inputError(proposeTermination(s.ctx, args({ reason: "delisted [see]" })), "reason");
    await inputError(proposeTermination(s.ctx, args({ reason: "x".repeat(1_001) })), "reason");
    await inputError(proposeTermination(s.ctx, args({ lastTradingTs: NOW + 2 * H })), "lastTradingTs"); // needs slack for landing
    await proposeTermination(s.ctx, args({ lastTradingTs: NOW + 2 * H, slackSeconds: 0 } as never));
    s.st.accepted = b32(1);
    s.st.scheduled = BigInt(NOW + 13 * H);
    expect((await inputError(proposeTermination(s.ctx, args()), "lastTradingTs")).message).toMatch(/earlier one/);
    s.st.accepted = ZERO32;
    s.st.scheduled = 0n;
    s.st.identifierLive = false;
    await inputError(proposeTermination(s.ctx, args()), "pair");
    s.st.identifierLive = true;
    s.st.fixedTs = 1n;
    await inputError(proposeTermination(s.ctx, args()), "pair");
    s.st.fixedTs = 0n;
    s.st.isPair = false;
    await inputError(proposeTermination(s.ctx, args()), "pair");
  });

  it("an insurer schedule's UMA cap is the cutoff in force", async () => {
    s.st.accepted = b32(1);
    s.st.scheduleId = b32(2);
    s.st.scheduled = BigInt(NOW + 3 * H);
    s.st.cap = BigInt(NOW + 20 * H);
    await proposeTermination(s.ctx, args({ lastTradingTs: NOW + 19 * H }));
    await inputError(proposeTermination(s.ctx, args({ lastTradingTs: NOW + 20 * H })), "lastTradingTs");
  });

  it("reasonProblem follows the charset", () => {
    expect(reasonProblem("Delisted from NYSE on 2030-01-02, see https://x.y/z?a=1&b=2#c %20 _~+")).toBeNull();
    expect(reasonProblem("Café")).toMatch(/not allowed/);
    expect(reasonProblem('say "hi"')).toMatch(/not allowed/);
  });
});

describe("settleTerminationProposal", () => {
  it("refuses during liveness and builds once settleable", async () => {
    const s = scene();
    const id = b32(0xc1);
    s.st.claims.set(id, { pair: ADDR.pair, proposer: ADDR.bob, lastTradingTs: BigInt(NOW + D), reason: "r", proposalTs: BigInt(NOW - 100), resolved: false, category: 2 });
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 500), currency: ADDR.usdc, bond: 1n });
    expect((await inputError(settleTerminationProposal(s.ctx, { assertionId: id }), "assertionId")).message).toMatch(/2030-03-17 17:55:00 UTC/);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n });
    const c = await settleTerminationProposal(s.ctx, { assertionId: id });
    expect(decodeCall(T(), "settleTerminationProposal", c.data)[0]).toBe(id);
    expect(c.costs).toEqual([]);
    s.st.claims.set(id, { ...s.st.claims.get(id), resolved: true });
    await inputError(settleTerminationProposal(s.ctx, { assertionId: id }), "assertionId");
  });
});

// ---------------------------------------------------------------------------------------------
// Insurer votes
// ---------------------------------------------------------------------------------------------

describe("insurer votes", () => {
  let s: Scene;
  const ID = b32(0x1d);
  beforeEach(() => {
    s = scene();
    s.st.insurer.set(ID, {
      pair: ADDR.pair,
      proposer: ADDR.bob,
      proposalTs: BigInt(NOW - H),
      shareEpoch: 0n,
      cutoffTs: BigInt(NOW + 5 * H),
      windowOpenTs: BigInt(NOW - H),
      yesShares: 500n * E18,
      snapshotTotalShares: 1_000n * E18,
      snapshotTaken: true,
      claimBacked: false,
    });
    s.st.sharesAsOf = () => 300n * E18;
  });

  it("proposeInsurerTermination posts the fixed bond and checks the cutoff bounds and maturity", async () => {
    s.st.sharesAsOf = (_u: Address, ts: bigint) => (ts === BigInt(NOW - 4 * D) ? 1n : 0n);
    const c = await proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 3 * H, from: ADDR.alice });
    expect(decodeCall(T(), "proposeInsurerTermination", c.data)).toEqual([ADDR.pair, BigInt(NOW + 3 * H)]);
    expect(c.costs[0]).toEqual(expect.objectContaining({ kind: "bond", amount: 1_000_000_000n }));
    expect(c.approvals).toHaveLength(1);
    expect(c.summary).toMatch(/1,000 USDC bond/);
    await inputError(proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 2 * H, from: ADDR.alice }), "cutoffTs");
    await inputError(proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 14 * D + 1, from: ADDR.alice }), "cutoffTs");
    s.st.scheduled = BigInt(NOW + 3 * H);
    await inputError(proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 3 * H, from: ADDR.alice }), "cutoffTs");
    s.st.scheduled = 0n;
    s.st.sharesAsOf = () => 0n;
    await inputError(proposeInsurerTermination(s.ctx, { pair: ADDR.pair, cutoffTs: NOW + 3 * H, from: ADDR.alice }), "from");
  });

  it("voteForInsurerTermination costs the lock and the worst-case levy of a bare vote", async () => {
    const c = await voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 100n * E18, from: ADDR.alice });
    expect(decodeCall(T(), "voteForInsurerTermination", c.data)).toEqual([ADDR.pair, ID, 100n * E18]);
    // 600 of 1,000 voted: dissent 40% -> levy 20% of the 100 voted
    expect(c.costs).toEqual([
      expect.objectContaining({ kind: "lock", amount: 100n * E18, unit: "shares" }),
      expect.objectContaining({ kind: "levy", amount: 20n * E18, contingent: true }),
    ]);
    expect(c.summary).toMatch(/up to 20 shares may be forfeited/);
    expect(c.notes.join(" ")).toMatch(/threshold is met/);
    // eligibility is read at the window's maturity cutoff
    expect(s.fake.called("getSharesAsOf")[0]!.args[1]).toBe(BigInt(NOW - H - 4 * D));
  });

  it("a claim-backed vote's worst case is half the voted shares", async () => {
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), claimBacked: true });
    const c = await voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 10n * E18, from: ADDR.alice });
    expect(c.costs[1]).toEqual(expect.objectContaining({ kind: "levy", amount: 5n * E18 }));
  });

  it("a vote meeting a cutoff UMA accepted owes no unjudged levy", async () => {
    s.st.cap = BigInt(NOW + 5 * H + D);
    const c = await voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 10n * E18, from: ADDR.alice });
    expect(c.costs.map((x) => x.kind)).toEqual(["lock"]);
  });

  it("refuses votes the terminator would refuse", async () => {
    await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 0n, from: ADDR.alice }), "shares");
    s.st.voted = 250n * E18;
    expect((await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 51n * E18, from: ADDR.alice }), "shares")).message).toMatch(/at most 50 shares/);
    s.st.voted = 0n;
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), windowOpenTs: BigInt(NOW + 10) });
    expect((await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 1n, from: ADDR.alice }), "id")).message).toMatch(/opens at/);
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), windowOpenTs: BigInt(NOW - H), cutoffTs: BigInt(NOW + H - 1) });
    expect((await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 1n, from: ADDR.alice }), "id")).message).toMatch(/closed/);
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), cutoffTs: BigInt(NOW + 5 * H) });
    s.st.epoch = 1n;
    expect((await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 1n, from: ADDR.alice }), "id")).message).toMatch(/void/);
    s.st.epoch = 0n;
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), resolved: true });
    await inputError(voteForInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID, shares: 1n, from: ADDR.alice }), "id");
  });

  it("executeInsurerTermination says what it will do, and refuses below the threshold", async () => {
    expect((await inputError(executeInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID }), "id")).message).toMatch(/500 shares of the 600 shares/);
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), yesShares: 600n * E18 });
    const c = await executeInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID });
    expect(c.outcome).toBe("schedule");
    expect(decodeCall(T(), "executeInsurerTermination", c.data)).toEqual([ADDR.pair, ID]);
    s.st.scheduled = BigInt(NOW + 4 * H);
    expect((await executeInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID })).outcome).toBe("preempted");
    s.st.scheduled = 0n;
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), yesShares: 100n * E18, cutoffTs: BigInt(NOW + 10) });
    const f = await executeInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID });
    expect(f.outcome).toBe("failedForfeit");
    expect(f.notes[0]).toMatch(/forfeited to the insurance fund/);
    s.st.epoch = 3n;
    expect((await executeInsurerTermination(s.ctx, { pair: ADDR.pair, id: ID })).outcome).toBe("voided");
  });

  it("insurerProposal decodes the record with names", async () => {
    s.st.insurer.set(ID, { ...s.st.insurer.get(ID), claimBacked: true, verdict: 2, outcome: 2, costed: true, levyBp: 5_000, resolved: true, scheduled: true });
    const p = (await insurerProposal(s.ctx, ID))!;
    expect(p).toEqual(
      expect.objectContaining({
        thresholdShares: 600n * E18,
        thresholdMet: false,
        verdictName: "false",
        outcomeName: "false",
        levyBp: 5_000,
        state: "scheduled",
        votingClosesAt: NOW + 4 * H,
      }),
    );
    expect(await insurerProposal(s.ctx, b32(0x999))).toBeNull();
  });

  it("unjudgedLevyBp is half the dissent, at least a tenth", () => {
    expect(unjudgedLevyBp(1_000n, 600n)).toBe(2_000n);
    expect(unjudgedLevyBp(1_000n, 900n)).toBe(1_000n);
    expect(unjudgedLevyBp(1_000n, 1_000n)).toBe(1_000n);
    expect(unjudgedLevyBp(0n, 0n)).toBe(1_000n);
  });

  it("insurerProposalId hashes (pair, proposer, second)", () => {
    expect(insurerProposalId(ADDR.pair, ADDR.alice, 123)).toBe(
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint64" }], [ADDR.pair, ADDR.alice, 123n])),
    );
  });

  it("vote and lock reads", async () => {
    s.st.voted = 7n;
    s.st.locked = 9n;
    expect(await getInsurerVote(s.ctx, { pair: ADDR.pair, voter: ADDR.alice, id: ID })).toBe(7n);
    expect(await getLockedShares(s.ctx, { pair: ADDR.pair, user: ADDR.alice })).toBe(9n);
  });
});

// ---------------------------------------------------------------------------------------------
// Status, stale, finalize, reads
// ---------------------------------------------------------------------------------------------

describe("terminationStatus", () => {
  it("reads the market's termination state and its open proposals", async () => {
    const s = scene();
    const claim = b32(0xc1);
    const vote = b32(0x1d);
    s.st.scheduled = BigInt(NOW + 4);
    s.st.accepted = claim;
    s.st.longOI = 5n;
    s.st.rule = { rule: 1, firstTarget: BigInt(NOW + 1), latestPublishTs: BigInt(NOW + 4), lastResortTs: BigInt(NOW + 4 + 12 * H), verdictDeadline: 0n };
    s.st.claims.set(claim, { pair: ADDR.pair, proposer: ADDR.bob, lastTradingTs: BigInt(NOW + 4), reason: "r", proposalTs: BigInt(NOW - D), resolved: false, category: 2 });
    s.st.insurer.set(vote, { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(NOW - 10), cutoffTs: BigInt(NOW + 3 * H), windowOpenTs: BigInt(NOW - 10) });
    const st = await terminationStatus(s.ctx, ADDR.pair, { ids: [claim, vote] });
    expect(st.phase).toBe("limbo");
    expect(st.haltsAt).toBe(NOW - 2);
    expect(st.settlementRule.key).toBe("window");
    expect(st.settlementRule.meaning).toMatch(/UMA's rule/);
    expect(st.acceptedTerminationAssertionId).toBe(claim);
    expect(st.insurerScheduled).toBe(false);
    expect(st.finalizeOpensAt).toBeNull();
    expect(st.openProposals.source).toBe("ids");
    expect(st.openProposals.termination.map((p) => [p.assertionId, p.categoryName])).toEqual([[claim, "Asset cessation"]]);
    expect(st.openProposals.insurer.map((p) => [p.id, p.state])).toEqual([[vote, "voting"]]);
  });

  it("finds proposal ids in the terminator's logs", async () => {
    const s = scene();
    const vote = b32(0x1d);
    const ev = T().eventByName.get("InsurerTerminationProposed")!;
    s.fake.rawLogs = [
      {
        address: ADDR.terminator,
        topics: [ev.topic0, padHex(ADDR.pair, { size: 32 }), vote, padHex(ADDR.bob, { size: 32 })],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], [BigInt(NOW + 3 * H), BigInt(NOW), false]),
        blockNumber: "0x5",
        blockHash: b32(5),
        transactionHash: b32(6),
        logIndex: "0x0",
      },
    ];
    s.st.insurer.set(vote, { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(NOW - 10), cutoffTs: BigInt(NOW + 3 * H), windowOpenTs: BigInt(NOW - 10) });
    const open = await openProposals(s.ctx, ADDR.pair, { fromBlock: 1 });
    expect(open.source).toBe("logs");
    expect(open.insurer.map((p) => p.id)).toEqual([vote]);
  });

  it("queries the subgraph when the context has one", async () => {
    const s = scene();
    const asked: unknown[] = [];
    const ctx = { ...s.ctx, subgraph: { query: async (_q: string, v?: Record<string, unknown>) => (asked.push(v), { terminationProposals: [], insurerProposals: [] }) as never } };
    const open = await openProposals(ctx, ADDR.pair);
    expect(open.source).toBe("subgraph");
    expect(asked).toEqual([{ pair: ADDR.pair.toLowerCase() }]);
  });

  // Audit F14: the subgraph's ids were not validated, bounded or paged (only the first 100 were read).
  it("pages the subgraph's ids and refuses ids it cannot use", async () => {
    const s = scene();
    const votes = Array.from({ length: 101 }, (_, i) => b32(0x1000 + i));
    for (const id of votes) s.st.insurer.set(id, { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(NOW - 10), cutoffTs: BigInt(NOW + 3 * H), windowOpenTs: BigInt(NOW - 10) });
    const queries: string[] = [];
    const sg = (answer: (q: string) => unknown) => ({ ...s.ctx, subgraph: { query: async (q: string) => (queries.push(q), answer(q)) as never } });
    const paged = sg((q) => {
      const after = /insurerProposals\([^)]*id_gt: "(0x[0-9a-f]{64})"/.exec(q)?.[1];
      const rows = votes.filter((v) => !after || v > after).slice(0, 100).map((id) => ({ id }));
      return { ...(q.includes("terminationProposals(") ? { terminationProposals: [] } : {}), insurerProposals: rows };
    });
    const open = await openProposals(paged, ADDR.pair);
    expect(open.insurer.map((p) => p.id)).toEqual(votes);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain(`id_gt: "${votes[99]}"`);
    expect(queries[1]).not.toContain("terminationProposals("); // that list ended on the first page

    const bad = async (rows: unknown, why: RegExp) => {
      await expect(openProposals(sg(() => ({ terminationProposals: rows, insurerProposals: [] })), ADDR.pair)).rejects.toThrow(why);
    };
    await bad([{ id: 7 }], /not 32 bytes of hex.*pass the proposal ids you know/);
    await bad([{ id: "0x1234" }], /not 32 bytes of hex/);
    await bad([{ id: b32(2) }, { id: b32(1) }], /out of id order/);
    await bad([{ id: b32(2) }, { id: b32(2) }], /out of id order/);
    await bad({ id: b32(2) }, /no list of UMA termination claims/);
    await bad(Array.from({ length: 101 }, (_, i) => ({ id: b32(i + 1) })), /more UMA termination claims in one page than asked for/);
    // A subgraph that keeps paging past the cap is refused, not followed.
    let n = 0;
    const endless = sg(() => ({ terminationProposals: Array.from({ length: 100 }, () => ({ id: b32(++n) })), insurerProposals: [] }));
    await expect(openProposals(endless, ADDR.pair)).rejects.toThrow(/more than 1000 open UMA termination claims/);
    expect(n).toBe(1_100);
  });

  it("settling and finalize timing", async () => {
    const s = scene();
    s.st.fixedTs = BigInt(NOW - D);
    s.st.scheduled = BigInt(NOW - D);
    s.st.settlementPrice = 42n;
    s.st.shortOI = 1n;
    const st = await terminationStatus(s.ctx, ADDR.pair);
    expect(st.phase).toBe("settling");
    expect(st.settlementPrice).toBe(42n);
    expect(st.finalizeOpensAt).toBe(NOW - D + 14 * D);
    expect(st.openProposals.source).toBe("none");
  });
});

describe("terminateStalePair and finalizeTermination", () => {
  it("terminateStalePair opens 21 days after the newest print", async () => {
    const s = scene();
    s.st.lastPrice = { spotPrice: 5n, updateTs: BigInt(NOW - 20 * D) };
    expect((await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair")).message).toMatch(/opens at/);
    s.st.lastPrice = { spotPrice: 5n, updateTs: BigInt(NOW - 22 * D) };
    s.st.probe = { found: true, spotPrice: 1n, lowPrice: 1n, highPrice: 1n, publishTime: BigInt(NOW - D) };
    await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair");
    s.st.probe = { found: false };
    const c = await terminateStalePair(s.ctx, { pair: ADDR.pair });
    expect(decodeCall(T(), "terminateStalePair", c.data)).toEqual([ADDR.pair]);
    // a never-priced pair is aged from its creation
    s.st.lastPrice = { spotPrice: 0n, updateTs: 0n };
    s.st.created = BigInt(NOW - 3 * D);
    await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair");
    s.st.created = BigInt(NOW - 30 * D);
    expect((await terminateStalePair(s.ctx, { pair: ADDR.pair })).notes[0]).toMatch(/nominal price of 1/);
    // a passed vote-set cutoff settles through terminateScheduledPair
    s.st.scheduleId = b32(1);
    s.st.scheduled = BigInt(NOW - 1);
    expect((await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair")).message).toMatch(/terminateScheduledPair/);
  });

  it("finalizeTermination waits for the sweep or the escape hatch", async () => {
    const s = scene();
    await inputError(finalizeTermination(s.ctx, { pair: ADDR.pair }), "pair");
    s.st.fixedTs = BigInt(NOW - D);
    s.st.longOI = 3n;
    expect((await inputError(finalizeTermination(s.ctx, { pair: ADDR.pair }), "pair")).message).toMatch(/settle them first/);
    s.st.fixedTs = BigInt(NOW - 14 * D);
    const hatch = await finalizeTermination(s.ctx, { pair: ADDR.pair });
    expect(hatch.to).toBe(ADDR.pair);
    expect(hatch.data).toBe(P().selector("finalizeTermination"));
    expect(hatch.notes[0]).toMatch(/escape hatch/);
    s.st.fixedTs = BigInt(NOW - D);
    s.st.longOI = 0n;
    expect((await finalizeTermination(s.ctx, { pair: ADDR.pair })).notes[0]).toMatch(/exact/);
    s.st.terminated = true;
    await inputError(finalizeTermination(s.ctx, { pair: ADDR.pair }), "pair");
  });
});

describe("reads", () => {
  it("terminatorConstants, settlementRule, terminationProposal, getTerminalEntitlement", async () => {
    const s = scene();
    const tc = terminatorCodec();
    const consts: Record<string, number | bigint> = {
      CATEGORY_ORACLE_DECOMMISSION: 1,
      CATEGORY_ASSET_CESSATION: 2,
      CATEGORY_STRUCTURAL_CHANGE: 3,
      CATEGORY_PYTH_CONTRACT_MIGRATION: 4,
      OUTCOME_NONE: 0,
      OUTCOME_TRUE: 1,
      OUTCOME_FALSE: 2,
      OUTCOME_UNJUDGED: 3,
      VERDICT_PENDING: 0,
      VERDICT_TRUE: 1,
      VERDICT_FALSE: 2,
      SETTLE_NOTHING: 0,
      SETTLE_WINDOW: 1,
      SETTLE_CHAIN: 2,
      SETTLE_AWAIT_VERDICT: 3,
      TERMINATION_PROPOSAL_BOND: 1_000_000_000n,
      TERMINATION_PROPOSAL_LIVENESS: 43_200n,
      MAX_REASON_LENGTH: 1_000n,
      SETTLEMENT_SAMPLE_COUNT: 5n,
      SETTLEMENT_SAMPLE_SPACING: 600n,
    };
    for (const [k, v] of Object.entries(consts)) s.fake.on(ADDR.terminator, tc, k, v);
    const c = await terminatorConstants(s.ctx);
    expect(c.categories).toEqual({ oracleDecommission: 1, assetCessation: 2, structuralChange: 3, pythContractMigration: 4 });
    expect(c.settleRules).toEqual({ nothing: 0, window: 1, chain: 2, awaitVerdict: 3 });
    expect([c.terminationProposalLiveness, c.maxReasonLength, c.settlementSampleCount, c.settlementSampleSpacing]).toEqual([43_200, 1_000, 5, 600]);
    expect(c.requiredTerminationBondUsdc).toBe(1_000_000_000n);

    s.st.rule = { rule: 2, firstTarget: 100n, latestPublishTs: (1n << 64n) - 1n, lastResortTs: (1n << 256n) - 1n, verdictDeadline: 0n };
    expect(await settlementRule(s.ctx, ADDR.pair)).toEqual(expect.objectContaining({ key: "chain", firstTarget: 100, latestPublishTs: null, lastResortTs: null }));

    const id = b32(0xc1);
    s.st.claims.set(id, { pair: ADDR.pair, proposer: ADDR.bob, lastTradingTs: 5n, reason: "gone", proposalTs: 10n, resolved: false, category: 4 });
    expect(await terminationProposal(s.ctx, id)).toEqual(
      expect.objectContaining({ proposer: ADDR.bob, categoryName: "Pyth contract migration", livenessEndsAt: 10 + 12 * H, reason: "gone" }),
    );
    expect(await terminationProposal(s.ctx, b32(2))).toBeNull();

    expect(await getTerminalEntitlement(s.ctx, { pair: ADDR.pair, account: ADDR.alice })).toEqual({
      collateral: 10n * E18,
      registeredClaim: 4n * E18,
      principalRatio: E18,
      profitRatio: E18 / 2n,
      payout: 12n * E18,
      finalized: false,
    });
  });

  it("proposalIdsFromReceipt picks the ids out of the terminator's events", () => {
    const s = scene();
    const ev = T().eventByName.get("InsurerTerminationProposed")!;
    const r = proposalIdsFromReceipt(s.ctx, {
      transactionHash: b32(1),
      blockNumber: 1,
      status: "success",
      gasUsed: 1n,
      effectiveGasPrice: 1n,
      from: ADDR.alice,
      to: ADDR.terminator,
      logs: [
        {
          address: ADDR.terminator,
          topics: [ev.topic0, padHex(ADDR.pair, { size: 32 }), b32(77), padHex(ADDR.alice, { size: 32 })],
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], [1n, 1n, false]),
          blockNumber: 1,
          blockHash: b32(1),
          transactionHash: b32(1),
          logIndex: 0,
        },
      ],
    });
    expect(r).toEqual({ assertionId: null, insurerProposalId: b32(77) });
  });
});

// ---------------------------------------------------------------------------------------------
// UMA's oracle
// ---------------------------------------------------------------------------------------------

describe("UMA assertions", () => {
  it("assertionPhase covers liveness, settleable, disputed and settled", () => {
    const base = {
      assertionId: b32(1),
      oo: ADDR.oo,
      asserter: ADDR.bob,
      assertionTime: 0,
      settled: false,
      currency: ADDR.usdc,
      expirationTime: 100,
      settlementResolution: false,
      domainId: ZERO32,
      identifier: ZERO32,
      bond: 1n,
      callbackRecipient: ADDR.factory,
      disputer: null,
      escalationManager: null,
    };
    expect(assertionPhase(null, 0)).toBe("notFound");
    expect(assertionPhase(base, 99)).toBe("liveness");
    expect(statusOf(base, 99)).toEqual(expect.objectContaining({ canSettleAt: 100, disputableUntil: 99 }));
    expect(assertionPhase(base, 100)).toBe("settleable");
    expect(assertionPhase({ ...base, disputer: ADDR.alice }, 50)).toBe("disputed");
    expect(assertionPhase({ ...base, settled: true, settlementResolution: true }, 50)).toBe("settledTrue");
    expect(assertionPhase({ ...base, settled: true }, 50)).toBe("settledFalse");
  });

  it("disputeAssertion approves the bond currency for the oracle and names the disputer", async () => {
    const s = scene();
    const id = b32(0xd1);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 1_000_000_000n, identifier: b32(9) });
    const c = await disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice, home: "terminator" });
    expect(c.to).toBe(ADDR.oo);
    expect(decodeCall(optimisticOracleCodec(), "disputeAssertion", c.data)).toEqual([id, ADDR.alice]);
    const [spender, amount] = decodeCall(erc20Codec(), "approve", c.approvals[0]!.data);
    expect([c.approvals[0]!.to, spender, amount]).toEqual([ADDR.usdc, ADDR.oo, 1_000_000_000n]);
    expect(c.costs[0]).toEqual(expect.objectContaining({ kind: "bond", amount: 1_000_000_000n, payee: ADDR.oo }));
    expect(c.notes.join(" ")).toMatch(/receives 1,500 USDC/);
    s.st.whitelisted = () => false;
    expect((await disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice, home: "terminator" })).notes.join(" ")).toMatch(/Warning/);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW), currency: ADDR.usdc, bond: 1n });
    expect((await inputError(disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice }), "assertionId")).message).toMatch(/dispute window closed/);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 1n, disputer: ADDR.bob });
    await inputError(disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice }), "assertionId");
  });

  // Audit F9: an `oo` override was trusted as the call's target and the bond's spender.
  it("accepts an oo override only when it is factory.oo() or the assertion's recorded oracle", async () => {
    const s = scene();
    const EVIL = getAddress("0x000000000000000000000000000000000000e5e1");
    const id = b32(0xd1);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 50_000_000_000n });
    s.fake.on(EVIL, optimisticOracleCodec(), "getAssertion", { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 50_000_000_000n });
    for (const p of [
      disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice, oo: EVIL }),
      settleAssertion(s.ctx, { assertionId: id, oo: EVIL }),
      assertionStatus(s.ctx, id, { oo: EVIL }),
      previewSettlement(s.ctx, id, { oo: EVIL }),
    ]) {
      expect((await inputError(p, "oo")).message).toMatch(/neither Bazaar's Optimistic Oracle/);
    }
    expect(s.fake.calls.some((c) => c.to === EVIL)).toBe(false);
    // factory.oo() is accepted, and so is the oracle the terminator recorded for the assertion.
    expect((await disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice, oo: ADDR.oo })).to).toBe(ADDR.oo);
    const OTHER = getAddress("0x00000000000000000000000000000000000000f4");
    s.fake.on(ADDR.factory, factoryCodec(), "oo", OTHER).on(ADDR.factory, factoryCodec(), "assertionOo", "0x0000000000000000000000000000000000000000");
    expect((await assertionStatus(s.ctx, id, { oo: ADDR.oo })).phase).toBe("liveness"); // the terminator's record
    s.fake.on(OTHER, optimisticOracleCodec(), "getAssertion", { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n });
    expect((await assertionStatus(s.ctx, id, { oo: OTHER.toLowerCase() as Address })).phase).toBe("settleable"); // factory.oo()
  });

  // Audit F10: a bond quote is pulled at execution, so a node answering 0 must not yield a "0 USDC" dispute.
  it("disputeAssertion refuses a bond below every Bazaar claim's floor and warns of a larger allowance", async () => {
    const s = scene();
    const id = b32(0xd2);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 0n });
    await expect(disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice, home: "terminator" })).rejects.toThrow(BondQuoteError);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 999_999_999n });
    await expect(disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice })).rejects.toThrow(/dispute bond of 999\.999999 USDC, below the 1,000 USDC/);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: ADDR.usdc, bond: 1_000_000_000n });
    s.st.allowance = (1n << 256n) - 1n;
    const c = await disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice });
    expect(c.approvals).toEqual([]);
    expect(c.notes.join(" ")).toMatch(/already lets UMA's Optimistic Oracle .* take up to an unlimited amount, more than the 1,000 USDC quoted/);
  });

  // Audit F14: the dispute bond's unit came from a hard-coded "USDC".
  it("disputeAssertion names a non-USDC bond in its own token", async () => {
    const s = scene();
    const id = b32(0xd3);
    const WETH = getAddress("0x00000000000000000000000000000000000000e7");
    s.fake
      .on(WETH, erc20Codec(), "decimals", 18)
      .on(WETH, erc20Codec(), "allowance", 0n)
      .on(WETH, erc20Codec(), "balanceOf", 10n ** 20n);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: WETH, bond: 5n * 10n ** 17n });
    const c = await disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice });
    expect(c.costs[0]).toEqual(expect.objectContaining({ unit: "token", token: WETH, decimals: 18, amount: 5n * 10n ** 17n }));
    expect(c.summary).toContain(`posts a 0.5 tokens of ${WETH} bond`);
    expect(c.pullsUsdc).toBeUndefined();
    expect(c.notes.join(" ")).toMatch(/not USDC, so it is not a claim Bazaar made/);
    s.st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 100), currency: WETH, bond: 0n });
    await expect(disputeAssertion(s.ctx, { assertionId: id, from: ADDR.alice })).rejects.toThrow(BondQuoteError);
  });

  // Audit F13 and F14: costs were shown rounded down, and a uint256 time threw.
  it("prints amounts exactly and contract-time sentinels without throwing", () => {
    expect(usdcText(1_000_009_999n)).toBe("1,000.009999 USDC");
    expect(usdcText(4_000_999_999n)).toBe("4,000.999999 USDC");
    expect(usdcText(1_000n * 10n ** 6n)).toBe("1,000 USDC");
    expect(sharesText(123_456_789_999_999_999_999n)).toBe("123.456789999999999999 shares");
    expect(ethText(7n)).toBe("0.000000000000000007 ETH");
    expect(timeText(1_900_000_000)).toBe("2030-03-17 17:46:40 UTC");
    expect(timeText(1_900_000_000n)).toBe("2030-03-17 17:46:40 UTC");
    for (const t of [(1n << 256n) - 1n, (1n << 64n) - 1n, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(timeText(t)).toBe("a time beyond any calendar date");
    }
  });

  it("proposeTermination explains a UMA cutoff past any date instead of throwing", async () => {
    const s = scene();
    s.st.accepted = b32(0xacc);
    s.st.scheduled = 9_000_000_000_000n; // a proposer-chosen cutoff past the Date range
    const e = await inputError(
      proposeTermination(s.ctx, { pair: ADDR.pair, category: 1, lastTradingTs: 9_000_000_000_001, reason: "Pyth decommission notice", from: ADDR.alice }),
      "lastTradingTs",
    );
    expect(e.message).toMatch(/accepted a cutoff for this market at a time beyond any calendar date/);
  });

  it("previewSettlement simulates settleAndGetAssertionResult", async () => {
    const s = scene();
    s.st.preview = true;
    expect(await previewSettlement(s.ctx, b32(1), { oo: ADDR.oo })).toEqual({ settleable: true, result: true, error: null });
    s.st.preview = new Revert(stringError("Assertion not expired"));
    const p = await previewSettlement(s.ctx, b32(1), { oo: ADDR.oo });
    expect([p.settleable, p.result, p.error?.message]).toEqual([false, null, "Assertion not expired"]);
  });
});

void getAddress;
