import { type Abi, type Address, type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, padHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ContractCodec, factory as factoryCodec, lens as lensCodec, oracle as oracleCodec, pair as pairCodec, terminator as terminatorCodec } from "../src/chain/codec.js";
import { InputError } from "../src/client/calls.js";
import { ConnectError, type PriceUpdateSource } from "../src/client/context.js";
import {
  SETTLEMENT_RULE_TEXT,
  SettlementPrintError,
  type StoredPricePolicy,
  TERMINATION_CATEGORY_INFO,
  type TickFetcher,
  TerminationCategory,
  chainLastResort,
  chainPrints,
  chainSample,
  executeInsurerTermination,
  finalizeTermination,
  getInsurerVote,
  getLockedShares,
  getTerminalEntitlement,
  insurerProposal,
  insurerProposalId,
  generatedAtOrAfter,
  openProposals,
  proposalIdsFromReceipt,
  proposeInsurerTermination,
  proposeTermination,
  reasonProblem,
  settleTerminationProposal,
  settlementPrint,
  settlementRule,
  terminateScheduledPair,
  terminateStalePair,
  terminationProposal,
  terminationStatus,
  terminatorConstants,
  tickFetcher,
  tickPrints,
  unjudgedLevyBp,
  voteForInsurerTermination,
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
import { SETTLE_AWAIT_VERDICT, SETTLE_CHAIN, SETTLE_NOTHING, SETTLE_TICK } from "../src/constants.js";
import { readUpdate } from "../src/prices/lazer.js";
import { ProError, type ProUpdate } from "../src/prices/pro.js";
import { FakePro, tick, unsigned } from "./pro-fakes.js";
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

const A_ID = 0xaaa1;
const Q_ID = 0xf0f0;
const ETH_ID = 2;

/**
 * Pyth's one-second archive over a FakePro: every request goes through a real ProClient, so what the
 * settlement helpers read is parsed from update bytes. `asked` records each (feeds, second) request.
 */
function archive(pro: FakePro) {
  const asked: [number[], number][] = [];
  const client = pro.client();
  const fetch: TickFetcher = (feeds, second) => {
    asked.push([feeds.map((f) => Number(BigInt(f))), second]);
    return client.atTick(feeds, second);
  };
  return { fetch, asked, pro, blob: (second: number, ids: number[] = [A_ID]) => pro.tickAt(second, ids) };
}

/** The seconds asked for, in order. */
const seconds = (asked: [number[], number][]) => asked.map(([, t]) => t);

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
    accept: (_updates: readonly Hex[], _value: bigint): true | Hex => true,
    // The oracle's verification of a set of updates (fetchPriceAtTick / fetchChainedMedian): a price, or revert data.
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
    .on(ADDR.oracle, oracleCodec(), "getUpdateFee", ([n]) => 7n * BigInt(n))
    .on(ADDR.oracle, oracleCodec(), "fetchPriceAtTick", (a, tx) => {
      const r = st.prove("fetchPriceAtTick", a, tx.value);
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
// Settlement updates
// ---------------------------------------------------------------------------------------------

describe("settlement updates", () => {
  const C = 2_000_000; // cutoff
  const update = (blob: Hex): ProUpdate => {
    const u = readUpdate(blob);
    return { blob, signer: null, timestampUs: u.timestampUs, channel: u.channel, feeds: new Map(u.feeds.map((f) => [b32(f.id), f])), prints: [] };
  };

  it("reads one feed out of a one-second update, and refuses what the oracle refuses", () => {
    const u = update(tick(C, [{ id: A_ID, price: 5n, generated: C - 40 }, { id: Q_ID, price: 0n, generated: 0 }]));
    expect(settlementPrint(u, FEED_A.toUpperCase().replace("0X", "0x") as Hex, C)).toEqual({ feedId: FEED_A, update: u.blob, tick: C, included: 15, priced: true, price: 5n, generatedUs: BigInt(C - 40) * 1_000_000n, publishTime: C - 40 });
    expect(settlementPrint(u, FEED_Q, C)).toMatchObject({ priced: false, price: 0n, generatedUs: 0n, publishTime: 0 });
    // what it refuses says the archive's answer cannot be relied on, not that no price exists
    const missing = (() => {
      try {
        settlementPrint(u, b32(9), C);
      } catch (e) {
        return e as SettlementPrintError;
      }
      return null;
    })();
    expect(missing?.kind).toBe("unreachable");
    // not the one-second update stamped on that second
    expect(() => settlementPrint(u, FEED_A, C + 1)).toThrow("The update offered for second 2000001 is not Pyth's one-second update stamped on it.");
    expect(() => settlementPrint(update(unsigned({ at: C, channel: "fixed_rate@200ms", feeds: [{ id: A_ID }] })), FEED_A, C)).toThrow(SettlementPrintError);
    // a feed it does not carry, and one without its exponent
    expect(() => settlementPrint(u, b32(9), C)).toThrow("does not carry feed 0x00000000…");
    expect(() => settlementPrint(update(tick(C, [{ id: A_ID, omit: ["exponent"] }])), FEED_A, C)).toThrow("without its price or its exponent");
    // a confidence is not needed, nor (for the cutoff's price) a generation time
    expect(settlementPrint(update(tick(C, [{ id: A_ID, omit: ["confidence", "feedUpdateTimestamp"] }])), FEED_A, C)).toMatchObject({ priced: true, generatedUs: 0n, included: 3 });
  });

  it("places a price before or after a target as the oracle does", () => {
    const at = (spec: Parameters<typeof tick>[1][number]) => settlementPrint(update(tick(C + 5, [spec])), FEED_A, C + 5);
    expect(generatedAtOrAfter(at({ id: A_ID, generated: C }), C)).toBe(true);
    expect(generatedAtOrAfter(at({ id: A_ID, generated: C + 5 }), C)).toBe(true);
    expect(generatedAtOrAfter(at({ id: A_ID, generated: C - 1, generatedExtraUs: 999_999n }), C)).toBe(false); // carried forward from before
    // the readings the oracle refuses as incomplete: none says when the feed last priced
    expect(() => generatedAtOrAfter(at({ id: A_ID, price: 0n, generated: 0 }), C)).toThrow("carries no price for feed 0x00000000…");
    expect(() => generatedAtOrAfter(at({ id: A_ID, price: 0n, generated: C - 9 }), C)).toThrow("carries no price for feed 0x00000000…");
    expect(() => generatedAtOrAfter(at({ id: A_ID, generated: 0 }), C)).toThrow("carries a price for feed 0x00000000… without saying when it was generated");
    expect(() => generatedAtOrAfter(at({ id: A_ID, price: 0n, generated: C + 1 }), C)).toThrow("carries no price for feed 0x00000000…");
    expect(() => generatedAtOrAfter(at({ id: A_ID, omit: ["feedUpdateTimestamp"] }), C)).toThrow("without its feed update timestamp");
  });

  it("treats a price below zero as no price to settle at", async () => {
    const pro = new FakePro();
    pro.now = C + 5_000;
    pro.generate(A_ID, C - 10, -5n);
    const e = (await tickPrints(archive(pro).fetch, [FEED_A], C).catch((x) => x)) as SettlementPrintError;
    expect(e).toBeInstanceOf(SettlementPrintError);
    expect([e.kind, e.message]).toEqual(["absent", `Pyth's one-second update stamped at the cutoff (${C}) carries a price below zero for feed 0x00000000…, which the oracle refuses: it cannot settle the market.`]);
    // a chain sample's price too, though the quiet second before it may carry any price
    const chain = new FakePro();
    chain.now = C + 5_000;
    chain.generate(A_ID, C - 10, -5n).generate(A_ID, C + 3, -7n);
    const e2 = (await chainSample(archive(chain).fetch, FEED_A, C, { latest: null, newest: C + 5_000 }).catch((x) => x)) as SettlementPrintError;
    expect([e2.kind, e2.message]).toEqual(["absent", `Pyth's one-second update for second ${C + 3} gives feed 0x00000000… a price at or below zero for the target ${C}, which the oracle refuses: no chain can be proven.`]);
  });

  it("UMA's rule takes the update stamped at the cutoff, whenever its price was generated", async () => {
    const pro = new FakePro();
    pro.now = C + 100;
    pro.generate(A_ID, C - 3_600, 77n); // quiet for an hour before the cutoff: the price is carried forward
    const a = archive(pro);
    const proof = await tickPrints(a.fetch, [FEED_A], C);
    expect(proof.updates).toEqual([a.blob(C)]);
    expect(proof.prints).toEqual([expect.objectContaining({ feedId: FEED_A, tick: C, priced: true, publishTime: C - 3_600 })]);
    expect(a.asked).toEqual([[[A_ID], C]]);
  });

  it("UMA's rule settles a composite with one update holding both legs, or one per leg when they cannot be asked for together", async () => {
    const pro = new FakePro();
    pro.now = C + 100;
    pro.generate(A_ID, C - 10, 5n).printing(Q_ID, C - 500, 9n);
    const a = archive(pro);
    const proof = await tickPrints(a.fetch, [FEED_A, FEED_Q], C);
    expect(proof.updates).toEqual([a.blob(C, [A_ID, Q_ID])]);
    expect(proof.prints.map((p) => [p.feedId, p.publishTime, p.update === proof.updates[0]])).toEqual([
      [FEED_A, C - 10, true],
      [FEED_Q, C, true],
    ]);
    expect(a.asked).toEqual([[[A_ID, Q_ID], C]]);
    // the archive will not answer for the two together
    const alone: TickFetcher = async (feeds, second) => (feeds.length > 1 ? null : a.fetch(feeds, second));
    const split = await tickPrints(alone, [FEED_A, FEED_Q], C);
    expect(split.updates).toEqual([a.blob(C, [A_ID]), a.blob(C, [Q_ID])]);
    const failing: TickFetcher = async (feeds, second) => {
      if (feeds.length > 1) throw new Error("400 bad request");
      return a.fetch(feeds, second);
    };
    expect((await tickPrints(failing, [FEED_A, FEED_Q], C)).updates).toHaveLength(2);
  });

  it("UMA's rule has nothing to settle with when the archive lacks the cutoff's update, or it carries no price", async () => {
    const pro = new FakePro();
    pro.now = C + 100;
    pro.generate(A_ID, C + 50, 5n); // its first price ever comes after the cutoff
    const a = archive(pro);
    await expect(tickPrints(a.fetch, [FEED_A], C)).rejects.toThrow("Pyth's one-second update stamped at the cutoff (2000000) carries no price for feed 0x00000000…: it cannot settle the market.");
    pro.missing.add(C);
    const e = (await tickPrints(a.fetch, [FEED_A], C).catch((x) => x)) as SettlementPrintError;
    expect(e).toBeInstanceOf(SettlementPrintError);
    expect([e.message, e.feedId, e.target]).toEqual(["Pyth's archive has no one-second update for feed 0x00000000… at second 2000000 yet.", FEED_A, C]);
    const down: TickFetcher = async () => {
      throw new Error("price endpoint unreachable: fetch failed");
    };
    await expect(tickPrints(down, [FEED_A], C)).rejects.toThrow("Pyth's archive could not serve feed 0x00000000… at second 2000000: price endpoint unreachable: fetch failed");
  });

  it("a chain sample is the target's own update when it carries a price generated at or after the target", async () => {
    const pro = new FakePro();
    pro.now = C + 10_000;
    pro.printing(A_ID, C - 100, 5n);
    const a = archive(pro);
    const sample = await chainSample(a.fetch, FEED_A, C, { latest: null, newest: pro.now });
    expect(sample.map((p) => [p.tick, p.publishTime, p.update])).toEqual([[C, C, a.blob(C)]]);
    expect(a.asked).toEqual([[[A_ID], C]]);
  });

  it("a chain sample after a quiet stretch is the first second with a new price, and the quiet second before it", async () => {
    const pro = new FakePro();
    pro.now = C + 10_000;
    pro.generate(A_ID, C - 5, 5n).printing(A_ID, C + 37, 6n);
    const a = archive(pro);
    const sample = await chainSample(a.fetch, FEED_A, C, { latest: null, newest: pro.now });
    expect(sample.map((p) => [p.tick, p.publishTime])).toEqual([
      [C + 36, C - 5], // still carrying the price from before the target
      [C + 37, C + 37],
    ]);
    expect(sample.map((p) => p.update)).toEqual([a.blob(C + 36), a.blob(C + 37)]);
    // the step doubles from the target until a new price shows, then the gap is bisected
    expect(seconds(a.asked).map((t) => t - C)).toEqual([0, 1, 3, 7, 15, 31, 63, 47, 39, 35, 37, 36]);
    // a feed with no price at all at the target proves nothing: its updates do not say when it last priced
    const fresh = new FakePro();
    fresh.now = C + 10_000;
    fresh.printing(A_ID, C + 3, 6n);
    const b = archive(fresh);
    await expect(chainSample(b.fetch, FEED_A, C, { latest: null, newest: fresh.now })).rejects.toThrow("carries no price for feed");
    // new price on the very next second
    const next = new FakePro();
    next.now = C + 10_000;
    next.generate(A_ID, C - 5, 5n).printing(A_ID, C + 1, 6n);
    const n = archive(next);
    expect((await chainSample(n.fetch, FEED_A, C, { latest: null, newest: next.now })).map((p) => p.tick)).toEqual([C, C + 1]);
    expect(seconds(n.asked).map((t) => t - C)).toEqual([0, 1]);
  });

  it("finds a reopen days later in a few dozen requests", async () => {
    const R = C + 235_800; // Friday's close to Monday's open
    const pro = new FakePro();
    pro.now = R + 10_000;
    pro.generate(A_ID, C, 5n).printing(A_ID, R, 6n);
    const a = archive(pro);
    const sample = await chainSample(a.fetch, FEED_A, C + 600, { latest: null, newest: pro.now });
    expect(sample.map((p) => [p.tick, p.publishTime])).toEqual([
      [R - 1, C],
      [R, R],
    ]);
    expect(a.asked.length).toBeLessThan(45);
  });

  it("respects the bound on a sample's second, and the present", async () => {
    const pro = new FakePro();
    pro.now = C + 10_000;
    pro.generate(A_ID, C - 5, 5n).printing(A_ID, C + 60, 6n);
    const a = archive(pro);
    // capped before the feed's next price: no chain exists under the bound, and nothing past it is asked for
    await expect(chainSample(a.fetch, FEED_A, C, { latest: C + 50, newest: pro.now })).rejects.toThrow(
      "Feed 0x00000000… produced no price from 2000000 up to the latest second a sample may be stamped with (2000050): no chain exists under that bound.",
    );
    expect(Math.max(...seconds(a.asked))).toBe(C + 50);
    expect((await chainSample(a.fetch, FEED_A, C, { latest: C + 60, newest: pro.now })).map((p) => p.tick)).toEqual([C + 59, C + 60]); // exactly at the bound
    await expect(chainSample(a.fetch, FEED_A, C + 100, { latest: C + 60, newest: pro.now })).rejects.toThrow("lies after the latest second a sample may be stamped with (2000060)");
    // the feed has not produced its next price yet: the sample does not exist
    const early = archive(pro);
    await expect(chainSample(early.fetch, FEED_A, C, { latest: null, newest: C + 20 })).rejects.toThrow("Feed 0x00000000… has produced no price since 2000000 yet (looked up to 2000020): its sample does not exist.");
    expect(Math.max(...seconds(early.asked))).toBe(C + 20);
    await expect(chainSample(early.fetch, FEED_A, C + 21, { latest: null, newest: C + 20 })).rejects.toThrow("The sample's target 2000021 has not been reached yet: its update does not exist.");
    // a second the archive does not hold
    pro.missing.add(C + 7);
    await expect(chainSample(archive(pro).fetch, FEED_A, C, { latest: null, newest: pro.now })).rejects.toThrow("Pyth's archive has no one-second update for feed 0x00000000… at second 2000007 yet.");
  });

  it("chains five samples, each target 600 s past the second of the sample before", async () => {
    const pro = new FakePro();
    pro.now = C + 10_000;
    // prices at C+2, then every 700 s
    for (const t of [C - 1, C + 2, C + 700, C + 1_400, C + 2_100, C + 2_800, C + 9_000]) pro.generate(A_ID, t, BigInt(t));
    const a = archive(pro);
    const chain = await chainPrints(a.fetch, [FEED_A], C, { latest: null, newest: pro.now });
    expect(chain.targets).toEqual([C, C + 602, C + 1_300, C + 2_000, C + 2_700]);
    expect(chain.ticks).toEqual([C + 2, C + 700, C + 1_400, C + 2_100, C + 2_800]);
    // every sample came after a quiet second: two updates each, the quiet one first
    expect(chain.prints.map((p) => p.tick)).toEqual([C + 1, C + 2, C + 699, C + 700, C + 1_399, C + 1_400, C + 2_099, C + 2_100, C + 2_799, C + 2_800]);
    expect(chain.updates).toEqual(chain.prints.map((p) => a.blob(p.tick)));
    // a feed printing every second proves each sample with its target's own update
    const live = new FakePro();
    live.now = C + 10_000;
    live.printing(A_ID, C - 100, 5n);
    const l = await chainPrints(archive(live).fetch, [FEED_A], C, { latest: null, newest: live.now });
    expect(l.ticks).toEqual([C, C + 600, C + 1_200, C + 1_800, C + 2_400]);
    expect(l.updates).toHaveLength(5);
    // fewer samples, another spacing
    const two = await chainPrints(archive(live).fetch, [FEED_A], C, { latest: null, newest: live.now }, 2, 60);
    expect(two.targets).toEqual([C, C + 60]);
  });

  it("measures a composite's next target from the later leg, base leg first (a session close to the reopen)", async () => {
    // Friday 16:00 close at C, Monday 09:30 reopen at R; the FX leg prints every second.
    const R = C + 235_800;
    const pro = new FakePro();
    pro.now = R + 10_000;
    pro.printing(A_ID, C - 1_000, 5n, C).printing(A_ID, R, 6n).printing(Q_ID, C - 1_000, 9n);
    const a = archive(pro);
    const chain = await chainPrints(a.fetch, [FEED_A, FEED_Q], C, { latest: null, newest: pro.now });
    expect(chain.targets).toEqual([C, C + 600, R + 600, R + 1_200, R + 1_800]);
    expect(chain.ticks).toEqual([C, R, R + 600, R + 1_200, R + 1_800]);
    // sample by sample: the base leg's one or two updates, then the quote leg's
    expect(chain.prints.map((p) => [p.feedId === FEED_A ? "A" : "Q", p.tick])).toEqual([
      ["A", C],
      ["Q", C],
      ["A", R - 1], // the equity's quiet second before the reopen
      ["A", R],
      ["Q", C + 600], // the FX leg's own earliest second for the same target
      ["A", R + 600],
      ["Q", R + 600],
      ["A", R + 1_200],
      ["Q", R + 1_200],
      ["A", R + 1_800],
      ["Q", R + 1_800],
    ]);
    // each leg is proven with an update of its own
    expect(chain.updates[0]).toBe(a.blob(C, [A_ID]));
    expect(chain.updates[1]).toBe(a.blob(C, [Q_ID]));
    expect(a.asked.every(([feeds]) => feeds.length === 1)).toBe(true);
  });

  it("refuses a chain whose sample lands past the UMA cap", async () => {
    const pro = new FakePro();
    pro.now = C + 10_000;
    pro.printing(A_ID, C - 100, 5n);
    const a = archive(pro);
    await expect(chainPrints(a.fetch, [FEED_A], C, { latest: C + 1_000, newest: pro.now })).rejects.toThrow("The sample's target 2001200 lies after the latest second a sample may be stamped with (2001000): no chain exists under that bound.");
    expect((await chainPrints(a.fetch, [FEED_A], C, { latest: C + 2_400, newest: pro.now })).ticks.at(-1)).toBe(C + 2_400);
  });

  it("tickFetcher is the price source's atTick", async () => {
    const asked: [readonly Hex[], number][] = [];
    const src: PriceUpdateSource = {
      latest: async () => ({ update: [], publishTime: 0 }),
      atTick: async (feeds, second) => {
        asked.push([feeds, second]);
        return null;
      },
    };
    expect(await tickFetcher(src)([FEED_A], 500)).toBeNull();
    expect(asked).toEqual([[[FEED_A], 500]]);
    expect(() => tickFetcher(null)).toThrow(ConnectError);
    expect(() => tickFetcher({ latest: src.latest })).toThrow("connect with a Pyth Pro price source");
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
  let pro: FakePro;
  const C = NOW - 5_000;
  const U64_MAX = (1n << 64n) - 1n;
  beforeEach(() => {
    s = scene();
    s.st.scheduled = BigInt(C);
    pro = new FakePro();
    pro.now = NOW;
    pro.printing(ETH_ID, NOW - 30 * D, 3_000n); // ETH/USD, which the archive must serve when it works
  });
  const tickRule = (lastResort = C + 12 * H) => ({ rule: 1, firstTarget: BigInt(C), latestPublishTs: BigInt(C), lastResortTs: BigInt(lastResort), verdictDeadline: 0n });
  const chainRule = (latest = U64_MAX, lastResort = C + 21 * D) => ({ rule: 2, firstTarget: BigInt(C), latestPublishTs: latest, lastResortTs: BigInt(lastResort), verdictDeadline: 0n });
  /** The base feed prints every second around the cutoff and after it. */
  const printing = () => pro.printing(A_ID, C - 1_000, 5n);
  const chainTicks = [C, C + 600, C + 1_200, C + 1_800, C + 2_400];
  const plan = (a = archive(pro), more: { storedPrice?: StoredPricePolicy } = {}) => terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchTick: a.fetch, ...more });

  it("UMA's rule: the cutoff's update, with getUpdateFee as value", async () => {
    s.st.rule = tickRule();
    pro.generate(A_ID, C - 7_200, 5n); // quiet for two hours before the cutoff: its last price settles it
    const a = archive(pro);
    const p = await plan(a);
    expect(p.under).toBe("tick");
    expect(p.call).not.toBeNull();
    const [pair, updates] = decodeCall(T(), "terminateScheduledPair", p.call!.data);
    expect(pair).toBe(ADDR.pair);
    expect(updates).toEqual([a.blob(C)]);
    expect(p.updates).toEqual([a.blob(C)]);
    expect(p.prints).toEqual([expect.objectContaining({ feedId: FEED_A, tick: C, publishTime: C - 7_200 })]);
    expect(p.call!.value).toBe(7n);
    expect(p.call!.costs).toEqual([expect.objectContaining({ kind: "fee", amount: 7n, unit: "ETH" })]);
    expect(p.call!.summary).toMatch(/Pyth fee/);
    expect(s.fake.called("getUpdateFee").map((c) => c.args)).toEqual([[1n]]); // the fee is per update
    // simulated as the sender, with the fee
    const sim = s.fake.called("terminateScheduledPair");
    expect(sim).toHaveLength(1);
    expect(sim[0]!.from).toBe(ADDR.alice);
    expect(sim[0]!.value).toBe(7n);
    expect(a.asked).toEqual([[[A_ID], C]]);
  });

  it("a composite pair settles with one update holding both legs", async () => {
    s.st.rule = tickRule();
    s.st.composite = { baseId: FEED_A, quoteId: FEED_Q, invertQuote: false };
    s.st.baseFeedId = COMPOSITE;
    pro.generate(A_ID, C - 20, 5n).printing(Q_ID, C - 100, 9n);
    const a = archive(pro);
    const p = await plan(a);
    const [, updates] = decodeCall(T(), "terminateScheduledPair", p.call!.data);
    expect(updates).toEqual([a.blob(C, [A_ID, Q_ID])]);
    expect(p.call!.value).toBe(7n);
    expect(p.prints.map((x) => x.feedId)).toEqual([FEED_A, FEED_Q]);
    expect(s.fake.called("fetchPriceAtTick")[0]!.args).toEqual([COMPOSITE, updates, BigInt(C)]);
  });

  it("without the cutoff's update it waits for the stored-price fallback, then takes it", async () => {
    s.st.rule = tickRule();
    pro.missing.add(C);
    const a = archive(pro);
    const p = await plan(a);
    expect(p.call).toBeNull();
    expect(p.reason).toMatch(/Under UMA's rule \(the one-second update stamped at the cutoff\): Pyth's archive has no one-second update for feed 0x00000000… at second \d+ yet\./);
    expect(p.retryAt).toBe(C + 12 * H + 1);
    expect([p.attempts.map((x) => x.kind), p.storedPriceWithheld]).toEqual([["absent"], null]); // not open yet: nothing withheld
    // the same when the update is there but carries no price for the feed
    pro.missing.clear();
    const empty = await plan();
    expect(empty.call).toBeNull();
    expect(empty.reason).toMatch(/carries no price for feed/);

    s.st.rule = tickRule(NOW - 1);
    const late = await plan();
    expect(late.under).toBe("storedPrice");
    expect(late.attempts.map((x) => [x.under, x.kind])).toEqual([
      ["tick", "absent"],
      ["storedPrice", null],
    ]);
    expect(late.storedPriceWithheld).toBeNull();
    expect(decodeCall(T(), "terminateScheduledPair", late.call!.data)[1]).toEqual([]);
    expect(late.updates).toEqual([]);
    expect(late.call!.value).toBe(0n);
    expect(late.call!.costs).toEqual([]);
    expect(s.fake.called("getUpdateFee")).toEqual([]); // no update, no fee read
  });

  it("past the last resort a proven update is still preferred", async () => {
    s.st.rule = tickRule(NOW - 1);
    printing();
    const p = await plan();
    expect(p.under).toBe("tick");
    expect(p.call!.notes.join(" ")).toMatch(/if Pyth refused these updates when the call runs, the market would settle at its stored price \(100\)/);
  });

  // Past the grace the terminator catches a failed fetch and settles at the stored price,
  // so the simulation alone accepts updates Pyth refuses.
  it("verifies the cutoff's update through the oracle as the terminator calls it, and shows its price", async () => {
    s.st.rule = tickRule();
    s.st.prove = () => 2_000_500_000_000_000_000_000n;
    printing();
    const a = archive(pro);
    const p = await plan(a);
    const proof = s.fake.called("fetchPriceAtTick");
    expect(proof).toHaveLength(1);
    expect(proof[0]!.args).toEqual([FEED_A, [a.blob(C)], BigInt(C)]);
    expect([proof[0]!.to, proof[0]!.from, proof[0]!.value]).toEqual([ADDR.oracle, ADDR.alice, 7n]);
    expect(p.under).toBe("tick");
    expect(p.settlementPrice).toBe(2_000_500_000_000_000_000_000n);
    expect(p.attempts).toEqual([expect.objectContaining({ under: "tick", ok: true, price: 2_000_500_000_000_000_000_000n })]);
    expect(p.call!.summary).toMatch(/at 2000\.5 under UMA's rule/);
    expect(p.call!.notes[0]).toBe(`Settles at 2000.5: the price in Pyth's one-second update stamped at the cutoff (${C}), which the oracle verified (fetchPriceAtTick, as the terminator calls it).`);
  });

  it("past the grace, updates the oracle refuses are not offered as proof, nor by default the stored-price call", async () => {
    s.st.rule = tickRule(NOW - 1);
    s.st.prove = () => stringError("invalid signer");
    printing();
    const held = await plan();
    expect([held.call, held.under]).toEqual([null, null]);
    expect(held.attempts.map((x) => [x.under, x.ok, x.kind])).toEqual([["tick", false, "refused"]]);
    expect(held.storedPriceWithheld).toBe('a proven settlement may still exist (tick: refused): try again later, or pass storedPrice: "always" to settle at the stored price anyway');
    expect(held.reason).toMatch(/The stored-price fallback is open but not offered: a proven settlement may still exist/);
    expect(s.fake.called("terminateScheduledPair")).toEqual([]);
    // a caller who has decided gets it, with its price
    const p = await plan(archive(pro), { storedPrice: "always" });
    expect(p.under).toBe("storedPrice");
    expect(p.settlementPrice).toBe(100n * E18);
    expect(decodeCall(T(), "terminateScheduledPair", p.call!.data)[1]).toEqual([]);
    expect(p.call!.value).toBe(0n);
    expect(p.call!.summary).toMatch(/at 100 under the stored price/);
    expect(p.call!.notes[0]).toMatch(/settles at its last stored price, 100\./);
    expect(p.attempts.map((x) => [x.under, x.ok, x.price])).toEqual([
      ["tick", false, null],
      ["storedPrice", true, 100n * E18],
    ]);
    // Pyth's verifier reverts with a reason string: it is explained, not just quoted
    expect(p.attempts[0]!.reason).toMatch(/would not verify these updates \(The price update was signed by a key Pyth no longer accepts\..*\)\..*would settle at the market's stored price \(100\) instead/);
    // The refused set was never simulated as a settlement: only the empty call was.
    expect(s.fake.called("terminateScheduledPair").map((c) => c.args[1])).toEqual([[]]);
    // A pair that never stored a price settles at 1.
    s.st.lastPrice = { spotPrice: 0n, updateTs: 0n };
    expect((await plan(archive(pro), { storedPrice: "always" })).settlementPrice).toBe(1n);
  });

  it("within the grace, updates the oracle refuses give no call", async () => {
    s.st.rule = tickRule();
    s.st.prove = () => errorData(oracleCodec(), "BazaarOracle__WrongTick", BigInt(C) * 1_000_000n, 3);
    printing();
    const p = await plan();
    expect(p.call).toBeNull();
    expect(p.settlementPrice).toBeNull();
    expect(p.reason).toMatch(/would not verify these updates \(A settlement price update is not Pyth's one-second update for the required second\.\)\. The terminator would refuse them too\./);
    expect(p.attempts[0]!.error?.name).toBe("BazaarOracle__WrongTick");
    expect(p.retryAt).toBe(C + 12 * H + 1);
    expect(s.fake.called("terminateScheduledPair")).toEqual([]);
  });

  it("verifies a chain through fetchChainedMedian with the terminator's bounds, and falls back past its last resort", async () => {
    s.st.rule = chainRule(BigInt(C + 9_999), C + 9_999 + 12 * H);
    s.st.cap = BigInt(C + 9_999);
    s.st.prove = () => 1_234n * E18;
    pro.generate(A_ID, C - 9, 5n).printing(A_ID, C + 2, 6n); // quiet across the cutoff: the first sample takes two updates
    const a = archive(pro);
    const p = await plan(a);
    const proof = s.fake.called("fetchChainedMedian");
    const want = [C + 1, C + 2, C + 602, C + 1_202, C + 1_802, C + 2_402].map((t) => a.blob(t));
    expect(proof[0]!.args).toEqual([FEED_A, want, BigInt(C), BigInt(C + 9_999), 600n, 5n]);
    expect(proof[0]!.value).toBe(42n); // six updates, each verified on its own
    expect(s.fake.called("getUpdateFee").at(-1)!.args).toEqual([6n]);
    expect([p.under, p.settlementPrice, p.call!.value]).toEqual(["chain", 1_234n * E18, 42n]);
    expect(p.updates).toEqual(want);
    expect(p.call!.notes[0]).toMatch(/^Settles at 1234: the median of five Pyth prices chained from the cutoff/);

    // No UMA cap: the terminator bounds the chain at uint64 max.
    s.st.cap = 0n;
    s.st.rule = chainRule();
    await plan();
    expect(s.fake.called("fetchChainedMedian").at(-1)!.args[3]).toBe(U64_MAX);

    // Past the last resort a refused chain gives the stored price once the caller decides it should.
    s.st.rule = chainRule(U64_MAX, NOW - 1);
    s.st.prove = () => errorData(oracleCodec(), "BazaarOracle__SampleNotProven", FEED_A, BigInt(C), BigInt(C + 1));
    const held = await plan();
    expect([held.under, held.attempts.map((x) => x.kind)]).toEqual([null, ["refused"]]);
    const late = await plan(archive(pro), { storedPrice: "always" });
    expect([late.under, late.settlementPrice]).toEqual(["storedPrice", 100n * E18]);
    expect(late.attempts[0]!.error?.name).toBe("BazaarOracle__SampleNotProven");
  });

  it("the chain rule: five chained samples, never the cutoff's update alone", async () => {
    s.st.rule = chainRule();
    s.st.scheduleId = b32(0xb4e);
    s.st.insurer.set(b32(0xb4e), { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(C - D), cutoffTs: BigInt(C), claimBacked: false, resolved: true, scheduled: true });
    printing();
    const a = archive(pro);
    const p = await plan(a);
    expect(p.under).toBe("chain");
    const [, updates] = decodeCall(T(), "terminateScheduledPair", p.call!.data);
    expect(updates).toEqual(chainTicks.map((t) => a.blob(t)));
    expect(p.call!.value).toBe(35n);
    expect(p.prints.map((x) => x.tick)).toEqual(chainTicks);
    expect(s.fake.called("fetchPriceAtTick")).toEqual([]);
  });

  it("a chain whose samples do not exist yet, or cannot fit under a UMA cutoff, waits", async () => {
    // the fifth sample's target is still ahead of the chain's time
    s.st.rule = chainRule();
    pro.printing(A_ID, C - 1_000, 5n);
    s.fake.now = C + 2_000;
    pro.now = C + 2_000;
    const early = await plan();
    expect(early.call).toBeNull();
    expect(early.reason).toMatch(/The sample's target \d+ has not been reached yet/);
    expect(early.retryAt).toBe(C + 21 * D + 1);
    s.fake.now = NOW;
    pro.now = NOW;
    // capped at a UMA cutoff 1,000 s after the vote's: only two samples fit
    s.st.rule = chainRule(BigInt(C + 1_000), C + 1_000 + 12 * H);
    const capped = await plan();
    expect(capped.call).toBeNull();
    expect(capped.reason).toMatch(/lies after the latest second a sample may be stamped with/);
    expect(capped.retryAt).toBe(C + 1_000 + 12 * H + 1);
  });

  describe("a claim-backed vote with no recorded verdict", () => {
    const CLAIM = b32(0xc1a1);
    beforeEach(() => {
      s.st.scheduleId = CLAIM;
      s.st.cap = BigInt(C + 5_000);
      s.st.insurer.set(CLAIM, { pair: ADDR.pair, proposer: ADDR.bob, proposalTs: BigInt(C - D), cutoffTs: BigInt(C), claimBacked: true, verdict: 0, resolved: true, scheduled: true });
      s.st.rule = { rule: 3, firstTarget: 0n, latestPublishTs: 0n, lastResortTs: 0n, verdictDeadline: BigInt(C - D + 14 * D) };
      s.st.assertions.set(CLAIM, { asserter: ADDR.bob, assertionTime: BigInt(C - D), expirationTime: BigInt(C - D + 12 * H), currency: ADDR.usdc, bond: 1_000_000_000n, disputer: ADDR.alice });
      printing();
    });

    it("settles under UMA's rule when the DVM upheld the claim", async () => {
      s.st.preview = true;
      const a = archive(pro);
      const p = await plan(a);
      expect(p.under).toBe("tick");
      expect(decodeCall(T(), "terminateScheduledPair", p.call!.data)[1]).toEqual([a.blob(C)]);
      expect(p.call!.notes.join(" ")).toMatch(/records UMA's verdict/);
      expect(a.asked).toEqual([[[A_ID], C]]); // the chain is never fetched
    });

    it("settles under the chain rule, capped, when the DVM rejected it", async () => {
      s.st.preview = false;
      s.st.cap = BigInt(C + 1_500); // the fourth sample would be past it
      const p = await plan();
      expect(p.call).toBeNull();
      expect(p.reason).toMatch(new RegExp(`lies after the latest second a sample may be stamped with \\(${C + 1_500}\\)`));
      s.st.cap = 0n;
      const ok = await plan();
      expect(ok.under).toBe("chain");
    });

    it("builds both sets and returns the one the contract accepts when the verdict cannot be previewed", async () => {
      s.st.preview = new Revert(stringError("Assertion not resolved"));
      s.st.accept = (updates: readonly Hex[]) => (updates.length === 5 ? true : errorData(T(), "BazaarPairTerminator__InsurerVerdictPending", 1n));
      const p = await plan();
      expect(p.under).toBe("chain");
      expect(p.attempts.map((x) => [x.under, x.ok])).toEqual([
        ["tick", false],
        ["chain", true],
      ]);
      expect(p.attempts[0]!.error?.name).toBe("BazaarPairTerminator__InsurerVerdictPending");
    });

    it("reports the verdict deadline when the contract takes neither", async () => {
      s.st.accept = () => errorData(T(), "BazaarPairTerminator__InsurerVerdictPending", BigInt(C + 13 * D));
      const p = await plan();
      expect(p.call).toBeNull();
      expect(p.attempts).toHaveLength(2);
      expect(p.retryAt).toBe(C - D + 14 * D);
      expect(p.reason).toMatch(/waits for UMA's verdict/);
    });

    it("waits for an undisputed claim's liveness without fetching anything", async () => {
      s.st.assertions.set(CLAIM, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 600), currency: ADDR.usdc, bond: 1n });
      const a = archive(pro);
      const p = await plan(a);
      expect(p.call).toBeNull();
      expect(p.retryAt).toBe(NOW + 600);
      expect(a.asked).toEqual([]);
    });
  });

  it("refuses up front before the cutoff, with no cutoff, and once fixed", async () => {
    s.st.rule = tickRule();
    s.st.scheduled = BigInt(NOW + 10);
    expect((await inputError(plan(), "pair")).message).toMatch(/first block after it/);
    s.st.scheduled = 0n;
    await inputError(plan(), "pair");
    s.st.scheduled = BigInt(C);
    s.st.fixedTs = BigInt(NOW - 1);
    await inputError(plan(), "pair");
  });

  it("past the last resort, an archive that cannot be asked never leads to the stored price", async () => {
    s.st.rule = tickRule(NOW - 1);
    const down: TickFetcher = async () => {
      throw new ProError("price endpoint returned HTTP 503 from https://archive.example/v2/abcdefghijklmnopqrstuvwxyz0123456789: try later");
    };
    const p = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchTick: down });
    expect(p.call).toBeNull();
    expect(p.attempts.map((x) => [x.under, x.kind])).toEqual([["tick", "unreachable"]]);
    expect(p.attempts[0]!.reason).toBe(`Pyth's archive could not serve feed 0x00000000… at second ${C}: price endpoint returned HTTP 503 from https://archive.example/v2/***: try later`);
    expect(p.storedPriceWithheld).toMatch(/^a proven settlement may still exist \(tick: unreachable\)/);
    expect(s.fake.called("terminateScheduledPair")).toEqual([]);
    const always = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchTick: down, storedPrice: "always" });
    expect([always.under, always.settlementPrice]).toEqual(["storedPrice", 100n * E18]);
  });

  it("believes the archive has no update only when it serves a control update", async () => {
    s.st.rule = tickRule(NOW - 1);
    // a 404 for every second, as from a wrong archive URL: its "none" says nothing
    const p = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, fetchTick: async () => null });
    expect(p.call).toBeNull();
    expect(p.attempts.map((x) => [x.under, x.kind])).toEqual([["tick", "unreachable"]]);
    expect(p.attempts[0]!.reason).toMatch(/\(Not believed: the archive did not serve ETH\/USD's one-second update from a minute ago either\.\)$/);
    expect(p.storedPriceWithheld).toMatch(/^Pyth's archive did not serve ETH\/USD's one-second update from a minute ago/);
    // an archive that serves ETH/USD but not the cutoff: believed, and the stored price is offered
    pro.missing.add(C);
    const a = archive(pro);
    const q = await plan(a);
    expect([q.under, q.attempts.map((x) => x.kind)]).toEqual(["storedPrice", ["absent", null]]);
    expect(a.asked.at(-1)).toEqual([[2], NOW - 60]); // the control: ETH/USD a minute before the chain's time
    // never: not even then
    const never = await plan(archive(pro), { storedPrice: "never" });
    expect([never.call, never.storedPriceWithheld]).toEqual([null, 'storedPrice is "never"']);
  });

  it("builds the stored-price call without a price source when asked to", async () => {
    s.st.rule = tickRule(NOW - 1);
    await expect(terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice })).rejects.toThrow(ConnectError);
    const p = await terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice, storedPrice: "always" });
    expect([p.under, p.settlementPrice]).toEqual(["storedPrice", 100n * E18]);
    expect(p.attempts.map((x) => [x.under, x.kind])).toEqual([
      ["tick", "unreachable"],
      ["storedPrice", null],
    ]);
    expect(p.attempts[0]!.reason).toMatch(/connect with a Pyth Pro price source/);
  });

  it("needs a price source that serves past updates", async () => {
    s.st.rule = tickRule();
    await expect(terminateScheduledPair(s.ctx, { pair: ADDR.pair, from: ADDR.alice })).rejects.toThrow(ConnectError);
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

  // The bond is quoted at build time and pulled at execution.
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
    expect(st.settlementRule.key).toBe("tick");
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

  // The subgraph's ids are validated, bounded and paged, not only the first 100 read.
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
  it("terminateStalePair opens 21 days after the pair last stored a price", async () => {
    const s = scene();
    s.st.lastPrice = { spotPrice: 5n, updateTs: BigInt(NOW - 20 * D) };
    expect((await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair")).message).toMatch(/stored a price within the last .* opens at/);
    s.st.lastPrice = { spotPrice: 5n, updateTs: BigInt(NOW - 21 * D) };
    await inputError(terminateStalePair(s.ctx, { pair: ADDR.pair }), "pair"); // exactly 21 days: not yet
    s.st.lastPrice = { spotPrice: 5n, updateTs: BigInt(NOW - 21 * D - 1) };
    const c = await terminateStalePair(s.ctx, { pair: ADDR.pair });
    expect(decodeCall(T(), "terminateStalePair", c.data)).toEqual([ADDR.pair]);
    expect(c.summary).toMatch(/stored no price for more than 21 days/);
    // the pair's own stored price is the evidence: the oracle is not asked anything
    expect(s.fake.calls.filter((x) => x.to === ADDR.oracle)).toEqual([]);
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
      CATEGORY_PYTH_VERIFIER_MIGRATION: 4,
      OUTCOME_NONE: 0,
      OUTCOME_TRUE: 1,
      OUTCOME_FALSE: 2,
      OUTCOME_UNJUDGED: 3,
      VERDICT_PENDING: 0,
      VERDICT_TRUE: 1,
      VERDICT_FALSE: 2,
      SETTLE_NOTHING: 0,
      SETTLE_TICK: 1,
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
    expect(c.categories).toEqual({ oracleDecommission: 1, assetCessation: 2, structuralChange: 3, pythVerifierMigration: 4 });
    expect(c.settleRules).toEqual({ nothing: 0, tick: 1, chain: 2, awaitVerdict: 3 });
    // the SDK's own copies agree with what the chain reports
    expect(c.settleRules).toEqual({ nothing: SETTLE_NOTHING, tick: SETTLE_TICK, chain: SETTLE_CHAIN, awaitVerdict: SETTLE_AWAIT_VERDICT });
    expect(TerminationCategory.PythVerifierMigration).toBe(c.categories.pythVerifierMigration);
    expect(TERMINATION_CATEGORY_INFO[4].description).toMatch(/Pyth Pro verifier contract/);
    expect(SETTLEMENT_RULE_TEXT.tick).toMatch(/one-second update stamped at its cutoff/);
    expect([c.terminationProposalLiveness, c.maxReasonLength, c.settlementSampleCount, c.settlementSampleSpacing]).toEqual([43_200, 1_000, 5, 600]);
    expect(c.requiredTerminationBondUsdc).toBe(1_000_000_000n);

    s.st.rule = { rule: 2, firstTarget: 100n, latestPublishTs: (1n << 64n) - 1n, lastResortTs: (1n << 256n) - 1n, verdictDeadline: 0n };
    expect(await settlementRule(s.ctx, ADDR.pair)).toEqual(expect.objectContaining({ key: "chain", firstTarget: 100, latestPublishTs: null, lastResortTs: null }));
    s.st.rule = { rule: 1, firstTarget: 100n, latestPublishTs: 100n, lastResortTs: 100n + BigInt(12 * H), verdictDeadline: 0n };
    expect(await settlementRule(s.ctx, ADDR.pair)).toEqual(expect.objectContaining({ key: "tick", firstTarget: 100, latestPublishTs: 100, lastResortTs: 100 + 12 * H }));

    const id = b32(0xc1);
    s.st.claims.set(id, { pair: ADDR.pair, proposer: ADDR.bob, lastTradingTs: 5n, reason: "gone", proposalTs: 10n, resolved: false, category: 4 });
    expect(await terminationProposal(s.ctx, id)).toEqual(
      expect.objectContaining({ proposer: ADDR.bob, categoryName: "Pyth verifier migration", livenessEndsAt: 10 + 12 * H, reason: "gone" }),
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

  // An `oo` override becomes the call's target and the bond's spender only when it is Bazaar's oracle.
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

  // A bond quote is pulled at execution, so a node answering 0 must not yield a "0 USDC" dispute.
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

  // The dispute bond's unit comes from its currency, never a hard-coded "USDC".
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

  // Costs are never shown rounded down, and a uint256 time prints instead of throwing.
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
