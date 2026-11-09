/**
 * A fake EIP-1193 transport for the frontend read tests (markets, account, live): it answers eth_call
 * by target and selector (decoding the calldata with the vendored ABIs and encoding the handler's
 * return value), batches through Multicall3's aggregate3 so tests can count batched calls, serves a
 * mutable chain of blocks and their logs, and records every request.
 */

import {
  type AbiParameter,
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  toHex,
  type Abi,
} from "viem";
import { bazaarPairAbi } from "../src/abi/index.js";
import { type ContractCodec, factory, lens, oracle, pair, terminator } from "../src/chain/codec.js";
import { RpcError, type RequestArgs, type Transport } from "../src/chain/rpc.js";
import type { BazaarContext } from "../src/client/context.js";
import { Chain } from "../src/chain/client.js";

export const addr = (b: string) => getAddress("0x" + b.repeat(20));
export const h32 = (b: string) => ("0x" + b.repeat(32)) as Hex;

export const FACTORY = addr("fa");
export const LENS = addr("1e");
export const TERMINATOR = addr("7e");
export const ORACLE = addr("0c");
export const USDC = addr("dc");
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

type Handler = (args: readonly unknown[], ctx: { block: number }) => unknown;

interface Fn {
  readonly codec: ContractCodec;
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly outputs: readonly AbiParameter[];
}

const ERC20: Record<string, { name: string; inputs: AbiParameter[]; outputs: AbiParameter[] }> = {
  "0x70a08231": { name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  "0xdd62ed3e": { name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
};

let selectors: Map<Hex, Fn[]> | null = null;
function fnsBySelector(): Map<Hex, Fn[]> {
  if (!selectors) {
    selectors = new Map();
    for (const c of [pair(), lens(), factory(), oracle(), terminator()]) {
      for (const f of c.functions.values()) {
        const list = selectors.get(f.selector) ?? [];
        list.push({ codec: c, name: f.name, inputs: f.inputs, outputs: f.outputs });
        selectors.set(f.selector, list);
      }
    }
  }
  return selectors;
}

/** The ABI encoding of a return value: an object by output names, or the single output's value. */
export function encodeReturn(outputs: readonly AbiParameter[], value: unknown): Hex {
  const values = outputs.length === 1 ? [value] : outputs.map((o) => (value as Record<string, unknown>)[o.name!]);
  return encodeAbiParameters(outputs, values);
}

export interface FakeBlock {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
}

export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

const blockHash = (n: number, fork = 0) => keccak256(toHex(`block-${n}-${fork}`));

export class FakeTransport implements Transport {
  readonly requests: RequestArgs[] = [];
  /** Every aggregate3 batch: the number of reads and the block tag. */
  readonly batches: { size: number; block: unknown }[] = [];
  /** Every eth_call answered (directly or inside a batch): `${to}:${fn}`. */
  readonly calls: string[] = [];
  readonly handlers = new Map<string, Handler>();
  blocks: FakeBlock[] = [];
  logs: FakeLog[] = [];
  /** Throw this on the next eth_getLogs (once). */
  failLogs: unknown = null;
  /** Requests failing a method name, when set. */
  failMethod: string | null = null;
  private fork = 0;

  constructor(head = 100, timestamp = 1_700_000_000) {
    for (let n = 0; n <= head; n++) this.blocks.push({ number: n, hash: blockHash(n), parentHash: n ? blockHash(n - 1) : h32("00"), timestamp: timestamp - (head - n) });
  }

  get head(): FakeBlock {
    return this.blocks[this.blocks.length - 1]!;
  }

  /** Mine `n` blocks, `dt` seconds apart. */
  mine(n = 1, dt = 1): FakeBlock {
    for (let i = 0; i < n; i++) {
      const h = this.head;
      this.blocks.push({ number: h.number + 1, hash: blockHash(h.number + 1, this.fork), parentHash: h.hash, timestamp: h.timestamp + dt });
    }
    return this.head;
  }

  /** Replace every block from `from` on with a fork of the same length (+ extra), dropping their logs. */
  reorg(from: number, extra = 0): void {
    this.fork += 1;
    const len = this.blocks.length;
    this.blocks = this.blocks.slice(0, from);
    this.logs = this.logs.filter((l) => l.blockNumber < from);
    for (let n = from; n < len + extra; n++) {
      const parent = this.blocks[n - 1]!;
      this.blocks.push({ number: n, hash: blockHash(n, this.fork), parentHash: parent.hash, timestamp: parent.timestamp + 1 });
    }
  }

  /**
   * Answer `fn` on `to` with a value (or a function of the decoded arguments). With `arg0`, only
   * calls whose first argument is it (a pair address for the lens, a feed id for the oracle).
   */
  answer(to: Address, fn: string, answer: unknown, arg0?: Address | Hex): this {
    const h: Handler = typeof answer === "function" ? (answer as Handler) : () => answer;
    const key = `${getAddress(to)}:${fn}`;
    if (arg0 === undefined) {
      this.handlers.set(key, h);
      return this;
    }
    let byArg = this.keyed.get(key);
    if (!byArg) this.keyed.set(key, (byArg = new Map()));
    byArg.set(arg0.toLowerCase(), h);
    return this;
  }

  private readonly keyed = new Map<string, Map<string, Handler>>();

  /** An event in block `blockNumber` (default the head), encoded with the pair's ABI (or `abi`). */
  emit(address: Address, name: string, args: Record<string, unknown>, blockNumber = this.head.number, abi: Abi = bazaarPairAbi as unknown as Abi): FakeLog {
    const ev = abi.find((e) => e.type === "event" && e.name === name) as { inputs: readonly (AbiParameter & { indexed?: boolean })[] };
    const topics = encodeEventTopics({ abi, eventName: name, args } as never) as Hex[];
    const plain = ev.inputs.filter((i) => !i.indexed);
    const data = plain.length ? encodeAbiParameters(plain, plain.map((p) => args[p.name!])) : "0x";
    const block = this.blocks[blockNumber]!;
    const lg: FakeLog = {
      address: getAddress(address),
      topics,
      data,
      blockNumber,
      blockHash: block.hash,
      transactionHash: keccak256(toHex(`tx-${blockNumber}-${this.logs.length}`)),
      logIndex: this.logs.filter((l) => l.blockNumber === blockNumber).length,
    };
    this.logs.push(lg);
    return lg;
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  private blockAt(tag: unknown): FakeBlock | null {
    if (tag === "latest" || tag === "pending" || tag === undefined) return this.head;
    const n = Number(BigInt(tag as string));
    return this.blocks[n] ?? null;
  }

  private dispatch(to: Address, data: Hex, block: number): Hex {
    const sel = data.slice(0, 10).toLowerCase() as Hex;
    const target = getAddress(to);
    const erc = ERC20[sel];
    const fns: { name: string; inputs: readonly AbiParameter[]; outputs: readonly AbiParameter[] }[] = erc ? [erc] : (fnsBySelector().get(sel) ?? []);
    for (const f of fns) {
      const key = `${target}:${f.name}`;
      const args = f.inputs.length ? decodeAbiParameters(f.inputs, `0x${data.slice(10)}`) : [];
      const a0 = typeof args[0] === "string" ? (args[0] as string).toLowerCase() : null;
      const h = (a0 !== null ? this.keyed.get(key)?.get(a0) : undefined) ?? this.handlers.get(key);
      if (!h) continue;
      this.calls.push(`${target}:${f.name}`);
      const v = h(args, { block });
      if (v instanceof Error) throw v;
      return encodeReturn(f.outputs, v);
    }
    throw new RpcError(3, "execution reverted", "0x");
  }

  async request(args: RequestArgs): Promise<unknown> {
    this.requests.push(args);
    const params = (args.params ?? []) as unknown[];
    if (this.failMethod === args.method) throw new RpcError(-32000, `${args.method} failed`);
    switch (args.method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return toHex(this.head.number);
      case "eth_getBlockByNumber": {
        const b = this.blockAt(params[0]);
        if (!b) return null;
        return { number: toHex(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: toHex(b.timestamp), baseFeePerGas: "0x1" };
      }
      case "eth_getCode":
        return getAddress(params[0] as string) === MULTICALL3 ? "0x01" : "0x";
      case "eth_call": {
        if (params[2] !== undefined) throw new RpcError(-32602, "state overrides are not supported");
        const tx = params[0] as { to: Address; data: Hex };
        const b = this.blockAt(params[1]);
        const block = b?.number ?? this.head.number;
        if (getAddress(tx.to) === MULTICALL3) {
          const [calls] = decodeAbiParameters(AGG3_IN, `0x${tx.data.slice(10)}`) as unknown as [{ target: Address; callData: Hex }[]];
          this.batches.push({ size: calls.length, block: params[1] });
          const out = calls.map((c) => {
            try {
              return { success: true, returnData: this.dispatch(c.target, c.callData, block) };
            } catch {
              return { success: false, returnData: "0x" as Hex };
            }
          });
          return encodeAbiParameters(AGG3_OUT, [out]);
        }
        return this.dispatch(tx.to, tx.data, block);
      }
      case "eth_getLogs": {
        if (this.failLogs) {
          const e = this.failLogs;
          this.failLogs = null;
          throw e;
        }
        const q = params[0] as { fromBlock: Hex; toBlock: Hex; address: Address[] };
        const from = Number(BigInt(q.fromBlock));
        const to = Number(BigInt(q.toBlock));
        const want = new Set(q.address.map((a) => getAddress(a)));
        return this.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to && want.has(l.address))
          .map((l) => ({ ...l, blockNumber: toHex(l.blockNumber), logIndex: toHex(l.logIndex), removed: false }));
      }
      default:
        throw new RpcError(-32601, `method ${args.method} not found`);
    }
  }
}

const AGG3_IN = [
  { type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] },
] as const;
const AGG3_OUT = [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] as const;

/** A context over the fake transport (no factory read). */
export function contextFor(t: FakeTransport, extra: Partial<BazaarContext> = {}): BazaarContext {
  return {
    chain: new Chain(t),
    chainId: 31337,
    factory: FACTORY,
    lens: LENS,
    terminator: TERMINATOR,
    oracle: ORACLE,
    usdc: USDC,
    prices: null,
    subgraph: null,
    integrator: "0x0000000000000000000000000000000000000000",
    ...extra,
  };
}

export const E18 = 10n ** 18n;

export const inventory = (size = 0n, seized = 0n) => ({ size, entryNotional: 0n, bankruptcyNotional: 0n, seized, entryFundingIndex: 0n, seizedTs: 0n });

/** Answers for one market's static and state reads (Reader.describe, Reader.marketStates, the snapshot's extra reads). */
export interface MarketFixture {
  address: Address;
  pairId: Hex;
  baseFeedId: Hex;
  continuous?: boolean;
  composite?: { baseId: Hex; quoteId: Hex; invertQuote: boolean };
  spot?: bigint;
  updateTs?: number;
  imrBp?: bigint;
  mmrBp?: bigint;
  laggedMmrBp?: bigint;
  fundingIndex?: bigint;
  projectedFundingIndex?: bigint;
  adlPending?: boolean;
  adlAuctionStart?: number;
  adlPendingSince?: number;
  adlTerminationTs?: number;
  settlementFixedTs?: number;
  scheduledTs?: number;
  terminated?: boolean;
  insurance?: bigint;
  longOi?: bigint;
  shortOi?: bigint;
}

export function withMarket(t: FakeTransport, f: MarketFixture): void {
  const a = f.address;
  const spot = f.spot ?? 2_000n * E18;
  t.answer(a, "pairId", f.pairId)
    .answer(a, "baseFeedId", f.baseFeedId)
    .answer(a, "isContinuouslyTraded", f.continuous ?? true)
    .answer(ORACLE, "composites", f.composite ?? { baseId: h32("00"), quoteId: h32("00"), invertQuote: false }, f.baseFeedId)
    .answer(a, "lastPairPrice", { spotPrice: spot, emaVarianceBp: 7n, updateTs: BigInt(f.updateTs ?? 1_700_000_000 - 2), lowPrice: spot - E18, highPrice: spot + E18 })
    .answer(a, "marginRequirements", { imrBp: f.imrBp ?? 400n, mmrBp: f.mmrBp ?? 200n, lastUpdateTs: 0n, laggedMmrBp: 0n })
    .answer(a, "getLaggedMmr", f.laggedMmrBp ?? 0n)
    .answer(a, "currentFundingIndex", f.fundingIndex ?? 0n)
    .answer(a, "isAdlPending", f.adlPending ?? false)
    .answer(a, "adlAuctionStartTs", BigInt(f.adlAuctionStart ?? 0))
    .answer(a, "adlPendingSince", BigInt(f.adlPendingSince ?? 0))
    .answer(a, "settlementPriceFixedTs", BigInt(f.settlementFixedTs ?? 0))
    .answer(a, "scheduledTerminationTs", BigInt(f.scheduledTs ?? 0))
    .answer(a, "isPairTerminated", f.terminated ?? false)
    .answer(a, "pairVault", {
      totalLongOI: f.longOi ?? 10n * E18,
      totalShortOI: f.shortOi ?? 8n * E18,
      longWeightedEntrySum: 0n,
      shortWeightedEntrySum: 0n,
      totalCollateralDeposited: 50_000n * E18,
      insuranceFundBalance: f.insurance ?? 10_000n * E18,
      deficit: 0n,
      targetInsuranceRatioBp: 300n,
      ledgerArrears: 0n,
      trailingOiSize: 0n,
      longInv: inventory(E18, 100n * E18),
      shortInv: inventory(),
    })
    .answer(a, "auxState", {
      lastFundingUpdateTs: 1_699_999_990n,
      lastMarkUpdateTs: 1_699_999_990n,
      rollingVolume: 0n,
      pairCreatedTs: 1_690_000_000n,
      priceUpdateCount: 1234n,
      settlementPrice: 0n,
      terminalPrincipalRatio: 0n,
      terminalProfitRatio: 0n,
      terminalProfitClaims: 0n,
      terminalBadDebt: 0n,
      bugBountyAddress: addr("bb"),
    })
    .answer(a, "book", { bidHead: 5n, askHead: 6n, bidCount: 3n, askCount: 2n })
    .answer(LENS, "markPrice", spot + 3n * E18, a)
    .answer(LENS, "fundingRate", { currentRate: 10n ** 14n, accruingRate: 5n * 10n ** 13n, fundingIndex: f.projectedFundingIndex ?? f.fundingIndex ?? 0n }, a)
    .answer(LENS, "adlTerminationTs", BigInt(f.adlTerminationTs ?? 0), a)
    .answer(LENS, "adlEpoch", 3n, a);
}
