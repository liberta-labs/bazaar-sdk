/**
 * The log tail's catch-up: ranges the node refuses are split, and a failure part-way neither loses
 * nor replays what was applied.
 */

import { type Block, type BlockTag, Chain, type ContractCodec, HttpError, type Market, type RawLog, RpcError, factory, pair } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, encodeAbiParameters, getAddress, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { Store } from "../src/state/store.js";
import { LogTail, REGROW_AFTER, refused } from "../src/sync/tail.js";

const FACTORY = getAddress("0x" + "fa".repeat(20));
const TERMINATOR = getAddress("0x" + "7e".repeat(20));
const PAIR = getAddress("0x" + "01".repeat(20));
const NEW_PAIR = getAddress("0x" + "02".repeat(20));
const PAIR_ID = ("0x" + "01".repeat(32)) as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

const hashOf = (n: number) => toHex(n, { size: 32 });
const fakeBlock = (n: number): Block => ({ number: n, timestamp: 0, hash: hashOf(n), parentHash: ZERO32, baseFee: 0n });

/** Logs by block; refuses ranges wider than `maxRange`; fails once at each block in `failAt`. */
class FakeChain {
  readonly calls: [number, number][] = [];
  private readonly failAt: Set<number>;

  constructor(
    private readonly byBlock: Map<number, RawLog[]> = new Map(),
    private readonly maxRange: number | null = null,
    failAt: number[] = [],
  ) {
    this.failAt = new Set(failAt);
  }

  async logs(start: number, end: number, _addresses: readonly Address[]): Promise<RawLog[]> {
    this.calls.push([start, end]);
    if (this.maxRange !== null && end - start + 1 > this.maxRange) throw new RpcError(-32005, "query exceeds the maximum block range");
    if (this.failAt.has(start)) {
      this.failAt.delete(start);
      throw new TypeError("fetch failed"); // what fetch throws when the connection is refused
    }
    const out: RawLog[] = [];
    for (let b = start; b <= end; b++) for (const lg of this.byBlock.get(b) ?? []) out.push(lg);
    return out;
  }

  async block(at?: BlockTag): Promise<Block> {
    return fakeBlock(Number(at));
  }
}

/** A log as the chain returns it: `name`'s topics and data encoded from `args`. */
function event(block: number, c: ContractCodec, name: string, address: Address, args: Record<string, unknown>): RawLog {
  const spec = c.eventByName.get(name)!;
  const all: Record<string, unknown> = { pairId: PAIR_ID, ...args };
  const topics: Hex[] = [spec.topic0];
  const plain = [];
  const values = [];
  for (const p of spec.inputs) {
    if (p.indexed) topics.push(encodeAbiParameters([p], [all[p.name!]]));
    else {
      plain.push(p);
      values.push(all[p.name!]);
    }
  }
  const data = plain.length ? encodeAbiParameters(plain, values) : "0x";
  return { address, topics, data, blockNumber: block, blockHash: ZERO32, transactionHash: ZERO32, logIndex: 0 };
}

function tailFor(chain: Pick<FakeChain, "logs" | "block">, chunk = 2_000): LogTail {
  const store = new Store();
  const m: Market = {
    address: PAIR, pairId: PAIR_ID, baseFeedId: PAIR_ID, legs: [PAIR_ID], invertQuote: false, continuous: true,
    description: "", label: "", state: null, dirty: true, lastRead: 0,
  };
  store.addMarket(m);
  return new LogTail(chain, store, { factory: FACTORY, terminator: TERMINATOR }, new Set(), chunk);
}

describe("log tail", () => {
  it("splits refused ranges and reads every block once", async () => {
    const chain = new FakeChain(new Map(), 300);
    await tailFor(chain).scan(0, 9_999, [PAIR]);
    const ok = chain.calls.filter(([s, e]) => e - s + 1 <= 300);
    expect(ok[0]![0]).toBe(0);
    expect(ok[ok.length - 1]![1]).toBe(9_999);
    for (let i = 1; i < ok.length; i++) expect(ok[i]![0]).toBe(ok[i - 1]![1] + 1); // contiguous: no gap, no overlap
    // 2,000 -> 1,000 -> 500 refused, then 250 at a time with one wider try every REGROW_AFTER requests.
    expect(chain.calls.length - ok.length).toBeLessThanOrEqual(3 + Math.floor(ok.length / REGROW_AFTER));
  });

  it("widens a range again after a busy stretch", async () => {
    const calls: [number, number][] = [];
    const busy = {
      async logs(start: number, end: number): Promise<RawLog[]> {
        calls.push([start, end]);
        // block 100 alone holds too many logs to share a request
        if (start <= 100 && 100 <= end && end - start + 1 > 1) throw new RpcError(-32005, "query returned more than 10000 results");
        return [];
      },
      block: async (at?: BlockTag) => fakeBlock(Number(at)),
    };
    await tailFor(busy).scan(0, 199_999, [PAIR]);
    expect(Math.max(...calls.slice(-5).map(([s, e]) => e - s + 1))).toBe(2_000); // back to full chunks well before the end
  });

  it("keeps a reduced range across scans, logging the refusal once", async () => {
    // A provider that serves at most 10 blocks a request, tailed 15 blocks a tick.
    const chain = new FakeChain(new Map(), 10);
    const lines: string[] = [];
    const tail = new LogTail(chain, new Store(), { factory: FACTORY, terminator: TERMINATOR }, new Set(), 2_000, {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
    });
    const ticks = 40;
    for (let t = 0; t < ticks; t++) await tail.scan(t * 15, t * 15 + 14, [PAIR]);
    const refusedCalls = chain.calls.filter(([s, e]) => e - s + 1 > 10).length;
    // The first tick's refusal, then only the wider try after every REGROW_AFTER full-size requests.
    const fullSize = chain.calls.filter(([s, e]) => e - s + 1 === 7).length;
    expect(refusedCalls).toBeLessThanOrEqual(1 + Math.ceil(fullSize / REGROW_AFTER));
    expect(refusedCalls).toBeLessThan(ticks / 2);
    expect(lines).toEqual([expect.stringContaining("the node refused logs for 15 blocks")]);
    const ok = chain.calls.filter(([s, e]) => e - s + 1 <= 10);
    for (let i = 1; i < ok.length; i++) expect(ok[i]![0]).toBe(ok[i - 1]![1] + 1); // every block read once
    expect(ok[ok.length - 1]![1]).toBe(ticks * 15 - 1);
  });

  it("raises failures that are not refusals at once", async () => {
    const chain = new FakeChain(new Map(), null, [0]);
    await expect(tailFor(chain).scan(0, 4_999, [PAIR])).rejects.toThrow(TypeError);
    expect(chain.calls).toEqual([[0, 1_999]]);
    // even one block refused: nothing left to split
    await expect(tailFor(new FakeChain(new Map(), 0)).scan(0, 9, [PAIR])).rejects.toBeInstanceOf(RpcError);
  });

  it("counts node errors and client HTTP errors as refusals, and nothing else", () => {
    expect(refused(new RpcError(-32005, "limit exceeded"))).toBe(true);
    expect(refused(new HttpError(413, "HTTP 413"))).toBe(true);
    expect(refused(new HttpError(429, "HTTP 429"))).toBe(false);
    expect(refused(new HttpError(503, "HTTP 503"))).toBe(false);
    expect(refused(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(false);
    expect(refused(new TypeError("fetch failed"))).toBe(false);
    expect(refused(Object.assign(new Error("HTTP request failed."), { status: 413 }))).toBe(true); // viem's HttpRequestError
  });

  it("does not take a timed-out request through Chain for a refusal", async () => {
    // fetch rejects a timed-out request with a DOMException whose legacy `code` is 23.
    const chain = new Chain({
      request: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const err = await chain.logs(0, 1, [PAIR]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(refused(err)).toBe(false);
  });

  it("resumes a failed catch-up after the applied chunks", async () => {
    const logs = new Map<number, RawLog[]>([
      [10, [event(10, factory(), "PairDeployed", FACTORY, {
        pairAddress: NEW_PAIR, deployer: PAIR, baseFeedId: PAIR_ID, isContinuouslyTraded: true, seedAmount: 1n, description: "",
      })]],
      [20, [event(20, pair(), "TriggerBountyEscrowed", PAIR, { orderId: 7n, amount: 5n })]],
      [2_500, [event(2_500, pair(), "TriggerBountyEscrowed", PAIR, { orderId: 7n, amount: 3n })]],
    ]);
    const chain = new FakeChain(logs, null, [2_001]);
    const tail = tailFor(chain);
    tail.store.head = 0;

    await expect(tail.advance(5_000)).rejects.toThrow(TypeError);
    expect(tail.store.head).toBe(2_000); // the first chunk is applied and recorded
    expect(tail.hasPending).toBe(true);
    expect(tail.store.orders.get(PAIR)!.get(7n)!.bounty).toBe(5n);

    const fx = await tail.advance(5_000);
    expect(tail.store.orders.get(PAIR)!.get(7n)!.bounty).toBe(8n); // the first chunk's escrow was not applied again
    expect(tail.store.head).toBe(5_000);
    expect(tail.store.headHash).toBe(hashOf(5_000));
    expect(tail.hasPending).toBe(false);
    expect(fx.newPairs).toEqual([NEW_PAIR]); // kept from the failed call
    expect(fx.firstBlock).toBe(1);
    expect(chain.calls).toEqual([[1, 2_000], [2_001, 4_000], [2_001, 4_000], [4_001, 5_000]]);
  });

  it("rewinds and re-reads every market when the stored head's hash changed", async () => {
    const chain = new FakeChain();
    const tail = tailFor(chain);
    const warnings: string[] = [];
    tail.log = { info() {}, warn: (m) => warnings.push(m) };
    tail.store.head = 1_000;
    tail.store.headHash = "0xstale";
    const fx = await tail.advance(1_000);
    expect(warnings).toEqual(["chain reorganized below block 1000; re-reading the last 64 blocks"]);
    expect(fx.dirty).toEqual(new Set([PAIR]));
    expect(chain.calls).toEqual([[1_000 - 64 + 1, 1_000]]);
    expect(tail.store.headHash).toBe(hashOf(1_000));
  });
});
