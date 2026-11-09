import { type Address, type Hex, encodeAbiParameters, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { BlockTag, Read } from "../src/chain/client.js";
import { type ContractCodec, factory, lens, oracle, pair, terminator } from "../src/chain/codec.js";
import { RpcError } from "../src/chain/rpc.js";
import { Reader } from "../src/sync/reader.js";

const addr = (b: string) => getAddress("0x" + b.repeat(20));
const FACTORY = addr("fa");
const LENS = addr("1e");
const TERMINATOR = addr("7e");
const ORACLE = addr("0c");
const USDC = addr("dc");
const A = addr("0a");
const B = addr("0b");
const C = addr("0d");
const ALICE = addr("aa");
const h32 = (b: string) => ("0x" + b.repeat(32)) as Hex;

/** The ABI encoding of `fn`'s return value, from its outputs by name (or the single output). */
function ret(c: ContractCodec, fn: string, value: unknown): Hex {
  const outs = c.fn(fn).outputs;
  const values = outs.length === 1 ? [value] : outs.map((o) => (value as Record<string, unknown>)[o.name!]);
  return encodeAbiParameters(outs, values);
}

/** Answers reads from a table keyed by target and calldata; anything else reverts. */
class FakeChain {
  readonly batches: { reads: Read[]; block: BlockTag }[] = [];
  readonly calls: Hex[] = [];
  private readonly answers = new Map<string, Hex>();

  on(to: Address, data: Hex, result: Hex): this {
    this.answers.set(`${to}:${data}`, result);
    return this;
  }

  async batch(reads: readonly Read[], block: BlockTag = "latest"): Promise<[boolean, Hex][]> {
    this.batches.push({ reads: [...reads], block });
    return reads.map((r): [boolean, Hex] => {
      const a = this.answers.get(`${r.to}:${r.data}`);
      return a === undefined ? [false, "0x"] : [true, a];
    });
  }

  async call(to: Address, data: Hex): Promise<Hex> {
    this.calls.push(data);
    const a = this.answers.get(`${to}:${data}`);
    if (a === undefined) throw new RpcError(3, "execution reverted");
    return a;
  }
}

function deployed(): FakeChain {
  const F = factory();
  return new FakeChain()
    .on(FACTORY, F.encode("lens"), ret(F, "lens", LENS))
    .on(FACTORY, F.encode("pairTerminator"), ret(F, "pairTerminator", TERMINATOR))
    .on(FACTORY, F.encode("oracle"), ret(F, "oracle", ORACLE))
    .on(FACTORY, F.encode("usdc"), ret(F, "usdc", USDC));
}

async function readerFor(chain: FakeChain): Promise<Reader> {
  const r = new Reader(chain);
  await r.deployment(FACTORY);
  chain.batches.length = 0;
  return r;
}

const inventory = (size: bigint, seized: bigint) => ({
  size, entryNotional: 2n, bankruptcyNotional: 3n, seized, entryFundingIndex: -4n, seizedTs: 1_700_000_000n,
});

function withState(chain: FakeChain, m: Address, opts: { fundingRate?: boolean; lagged?: boolean; vault?: boolean } = {}): void {
  const P = pair();
  const L = lens();
  chain
    .on(m, P.encode("lastPairPrice"), ret(P, "lastPairPrice", { spotPrice: 2_000n * 10n ** 18n, emaVarianceBp: 0n, updateTs: 1_700_000_100n, lowPrice: 0n, highPrice: 0n }))
    .on(m, P.encode("marginRequirements"), ret(P, "marginRequirements", { imrBp: 500n, mmrBp: 300n, lastUpdateTs: 0n, laggedMmrBp: 0n }))
    .on(m, P.encode("currentFundingIndex"), ret(P, "currentFundingIndex", -7n))
    .on(m, P.encode("isAdlPending"), ret(P, "isAdlPending", true))
    .on(m, P.encode("adlAuctionStartTs"), ret(P, "adlAuctionStartTs", 11n))
    .on(LENS, L.encode("adlTerminationTs", m), ret(L, "adlTerminationTs", 12n))
    .on(m, P.encode("settlementPriceFixedTs"), ret(P, "settlementPriceFixedTs", 0n))
    .on(m, P.encode("scheduledTerminationTs"), ret(P, "scheduledTerminationTs", 13n))
    .on(m, P.encode("isPairTerminated"), ret(P, "isPairTerminated", false));
  if (opts.lagged !== false) chain.on(m, P.encode("getLaggedMmr"), ret(P, "getLaggedMmr", 250n));
  if (opts.fundingRate !== false) {
    chain.on(LENS, L.encode("fundingRate", m), ret(L, "fundingRate", { currentRate: 1n, accruingRate: 2n, fundingIndex: -9n }));
  }
  if (opts.vault !== false) {
    chain.on(m, P.encode("pairVault"), ret(P, "pairVault", {
      totalLongOI: 100n, totalShortOI: 90n, longWeightedEntrySum: 0n, shortWeightedEntrySum: 0n, totalCollateralDeposited: 0n,
      insuranceFundBalance: 50n, deficit: 1n, targetInsuranceRatioBp: 0n, ledgerArrears: 0n, trailingOiSize: 0n,
      longInv: inventory(5n, 6n), shortInv: inventory(0n, 0n),
    }));
  }
}

describe("reader", () => {
  it("reads a factory's wiring and reports what does not belong to it", async () => {
    const chain = deployed();
    chain.on(LENS, lens().encode("factory"), ret(lens(), "factory", FACTORY));
    chain.on(TERMINATOR, terminator().encode("factory"), ret(terminator(), "factory", addr("99")));
    const r = new Reader(chain);
    expect(await r.deployment(FACTORY.toLowerCase() as Address)).toEqual({ factory: FACTORY, lens: LENS, terminator: TERMINATOR, oracle: ORACLE, usdc: USDC });
    expect(await r.wiringProblems()).toEqual(["the terminator belongs to a different factory"]);
    await expect(new Reader(new FakeChain()).deployment(FACTORY)).rejects.toThrow("does not answer as a Bazaar factory");
  });

  it("describes markets in two batched reads, with a composite's legs", async () => {
    const chain = deployed();
    const P = pair();
    const O = oracle();
    for (const [m, base, cont] of [[A, h32("a1"), true], [B, h32("b1"), false]] as const) {
      chain
        .on(m, P.encode("pairId"), ret(P, "pairId", h32(m === A ? "0a" : "0b")))
        .on(m, P.encode("baseFeedId"), ret(P, "baseFeedId", base))
        .on(m, P.encode("isContinuouslyTraded"), ret(P, "isContinuouslyTraded", cont));
    }
    chain.on(ORACLE, O.encode("composites", h32("a1")), ret(O, "composites", { baseId: h32("e1"), quoteId: h32("e2"), invertQuote: true }));
    const r = await readerFor(chain);
    const [a, b] = await r.describe([A, B]);
    expect(chain.batches.length).toBe(2);
    expect(a).toMatchObject({ address: A, pairId: h32("0a"), baseFeedId: h32("a1"), legs: [h32("e1"), h32("e2")], invertQuote: true, continuous: true, state: null, dirty: true });
    expect(b).toMatchObject({ address: B, legs: [h32("b1")], invertQuote: false, continuous: false }); // not a composite
  });

  it("never decodes a failed describe read as a value", async () => {
    const chain = deployed();
    const P = pair();
    chain
      .on(A, P.encode("pairId"), ret(P, "pairId", h32("0a")))
      .on(A, P.encode("baseFeedId"), ret(P, "baseFeedId", h32("a1")))
      .on(A, P.encode("isContinuouslyTraded"), ret(P, "isContinuouslyTraded", true));
    const r = await readerFor(chain);
    // B's reads revert with Error("..."): 100 bytes that would decode as a bytes32 if nobody looked at ok
    const revert = ("0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["not a pair"]).slice(2)) as Hex;
    const batch = chain.batch.bind(chain);
    chain.batch = async (reads, block) => (await batch(reads, block)).map(([ok, d]): [boolean, Hex] => (ok ? [ok, d] : [false, revert]));
    await expect(r.describe([A, B])).rejects.toThrow(`${B} does not answer as a Bazaar pair`);
    expect((await r.describe([A]))[0]).toMatchObject({ address: A, pairId: h32("0a") });
  });

  it("reads every market's state in one batch pinned to the block", async () => {
    const chain = deployed();
    withState(chain, A);
    withState(chain, B, { vault: false });
    withState(chain, C, { fundingRate: false, lagged: false });
    const r = await readerFor(chain);
    const markets = [A, B, C].map((address) => ({ address }) as never);
    const states = await r.marketStates(markets, 777, 1_700_000_101);
    expect(chain.batches.length).toBe(1);
    expect(chain.batches[0]!.block).toBe(777);
    expect(chain.batches[0]!.reads.length).toBe(3 * 12);
    expect([...states.keys()]).toEqual([A, C]); // B's vault read failed
    expect(states.get(A)).toEqual({
      block: 777, timestamp: 1_700_000_101, spot: 2_000n * 10n ** 18n, updateTs: 1_700_000_100, imrBp: 500n, mmrBp: 300n,
      laggedMmrBp: 250n, fundingIndex: -7n, projectedFundingIndex: -9n, adlPending: true, adlAuctionStart: 11, adlTerminationTs: 12,
      settlementFixedTs: 0, scheduledTs: 13, terminated: false, longOi: 100n, shortOi: 90n, insurance: 50n, deficit: 1n,
      longInv: { size: 5n, entryNotional: 2n, bankruptcyNotional: 3n, seized: 6n, entryFundingIndex: -4n, seizedTs: 1_700_000_000 },
      shortInv: { size: 0n, entryNotional: 2n, bankruptcyNotional: 3n, seized: 0n, entryFundingIndex: -4n, seizedTs: 1_700_000_000 },
    });
    expect(states.get(C)).toMatchObject({ laggedMmrBp: 0n, fundingIndex: -7n, projectedFundingIndex: -7n });
  });

  it("re-reads orders with their bounties, typed by meaning", async () => {
    const chain = deployed();
    const P = pair();
    const L = lens();
    const order = {
      creator: ALICE, canceledBlock: 0n, orderType: 4, isLong: true, isPostOnly: false, tif: 0, integrator: ALICE,
      expiryBlock: 2n ** 64n - 1n, inBook: false, maxSlippageBp: 500, triggerPrice: 1950n, limitPrice: 0n, size: 10n, filledSize: 0n,
      prioritySeq: 3, filledBlock: 0n, restedBlock: 0, restedPremiumPpm: 0, prevInBook: 0, nextInBook: 8,
    };
    chain.on(A, P.encode("orders", 7n), ret(P, "orders", order));
    chain.on(A, P.encode("orders", 8n), ret(P, "orders", { ...order, canceledBlock: 99n }));
    chain.on(LENS, L.encode("triggerBounty", A, 7n), ret(L, "triggerBounty", 5n));
    const r = await readerFor(chain);
    const out = await r.orders(A, [7n, 8n, 9n]);
    expect(chain.batches.length).toBe(1);
    expect([...out.keys()]).toEqual([7n, 8n]); // 9 does not read
    expect(out.get(7n)).toMatchObject({ canceledBlock: 0, expiryBlock: 2 ** 64, maxSlippageBp: 500n, prioritySeq: 3, nextInBook: 8n, bounty: 5n });
    expect(out.get(8n)).toMatchObject({ canceledBlock: 99, bounty: 0n }); // its bounty read failed
  });

  it("follows findPredecessor's pages, and reads claims and balances", async () => {
    const chain = deployed();
    const L = lens();
    chain.on(LENS, L.encode("findPredecessor", A, true, 100n, 0n, 64n), ret(L, "findPredecessor", { pred: 40n, found: false }));
    chain.on(LENS, L.encode("findPredecessor", A, true, 100n, 40n, 64n), ret(L, "findPredecessor", { pred: 41n, found: true }));
    chain.on(LENS, L.encode("getClaimableFeesAll", ALICE), ret(L, "getClaimableFeesAll", { pairs: [A, B], owed: [0n, 3n] }));
    const balanceOf = ("0x70a08231" + "00".repeat(12) + ALICE.slice(2).toLowerCase()) as Hex;
    chain.on(USDC, balanceOf, encodeAbiParameters([{ type: "uint256" }], [12n]));
    const r = await readerFor(chain);
    expect(await r.predecessor(A, true, 100n)).toBe(41n);
    expect(await r.claimable(ALICE)).toEqual(new Map([[B, 3n]]));
    expect(await r.usdcBalance(ALICE)).toBe(12n);
    expect(await r.updateFee([])).toBe(0n);
  });
});
