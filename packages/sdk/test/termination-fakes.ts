/**
 * A fake chain for the termination, listing and governance tests: an EIP-1193 transport that answers
 * eth_call by (address, selector), decoding the calldata with the contract's codec and encoding the
 * handler's answer with the function's outputs (missing struct fields default to zero). Calls are
 * recorded. Reverts are thrown as `Revert(data)`.
 */

import { type AbiParameter, type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, toHex } from "viem";
import { Chain } from "../src/chain/client.js";
import type { ContractCodec } from "../src/chain/codec.js";
import type { Transport } from "../src/chain/rpc.js";
import type { BazaarContext, PriceUpdateSource, SubgraphSource } from "../src/client/context.js";

export class Revert extends Error {
  constructor(readonly data: Hex) {
    super("revert");
  }
}

/** Revert data for a custom error the codec declares. */
export function errorData(c: ContractCodec, name: string, ...args: unknown[]): Hex {
  for (const spec of c.errors.values()) {
    if (spec.name === name) return spec.inputs.length ? concatHex([spec.selector, encodeAbiParameters(spec.inputs, args)]) : spec.selector;
  }
  throw new Error(`the codec declares no error ${name}`);
}

/** Revert data for Error(string), as UMA's oracle reverts. */
export const stringError = (msg: string): Hex => concatHex(["0x08c379a0", encodeAbiParameters([{ type: "string" }], [msg])]);

function zeroOf(p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith("]")) return [];
  if (t === "tuple") return Object.fromEntries((p as unknown as { components: AbiParameter[] }).components.map((c) => [c.name, zeroOf(c)]));
  if (t === "bool") return false;
  if (t === "address") return "0x0000000000000000000000000000000000000000";
  if (t === "string") return "";
  if (t === "bytes") return "0x";
  if (t.startsWith("bytes")) return "0x" + "00".repeat(Number(t.slice(5)));
  return 0n;
}

function fill(p: AbiParameter, v: unknown): unknown {
  if (v === undefined) return zeroOf(p);
  if (p.type === "tuple" && v && typeof v === "object" && !Array.isArray(v)) {
    const comps = (p as unknown as { components: AbiParameter[] }).components;
    return Object.fromEntries(comps.map((c) => [c.name, fill(c, (v as Record<string, unknown>)[c.name!])]));
  }
  return v;
}

type Tx = { from?: Address; value: bigint };
type Handler = (args: readonly any[], tx: Tx) => unknown;
type Answer = string | bigint | number | boolean | readonly unknown[] | { readonly [k: string]: unknown };

export interface CallRecord {
  readonly to: Address;
  readonly fn: string;
  readonly args: readonly any[];
  readonly from?: Address;
  readonly value: bigint;
}

export class FakeChain {
  now = 1_900_000_000;
  block = 1_000;
  rawLogs: Record<string, unknown>[] = [];
  readonly calls: CallRecord[] = [];
  private readonly handlers = new Map<string, { c: ContractCodec; fn: string; h: Handler }>();
  readonly transport: Transport = { request: (a) => this.request(a.method, a.params ?? []) };

  /** Answer `fn` on `to` with a fixed value or a handler. */
  on(to: Address, c: ContractCodec, fn: string, h: Handler | Answer): this {
    this.handlers.set(`${to.toLowerCase()}:${c.selector(fn)}`, { c, fn, h: typeof h === "function" ? (h as Handler) : () => h });
    return this;
  }

  called(fn: string): CallRecord[] {
    return this.calls.filter((c) => c.fn === fn);
  }

  private async request(method: string, params: readonly unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return "0xa4b1";
      case "eth_blockNumber":
        return toHex(this.block);
      case "eth_getBlockByNumber":
        return { number: toHex(this.block), timestamp: toHex(this.now), hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), baseFeePerGas: "0x1" };
      case "eth_getCode":
        return "0x";
      case "eth_estimateGas":
        return "0x5208";
      case "eth_getLogs":
        return this.rawLogs;
      case "eth_call": {
        const [tx, , overrides] = params as [{ to: string; data: Hex; from?: string; value?: string }, unknown, unknown];
        if (overrides) throw { code: -32602, message: "state overrides are not supported" };
        const key = `${tx.to.toLowerCase()}:${tx.data.slice(0, 10)}`;
        const hd = this.handlers.get(key);
        if (!hd) throw new Error(`unexpected eth_call ${key}`);
        const f = hd.c.fn(hd.fn);
        const args = f.inputs.length ? decodeAbiParameters(f.inputs, ("0x" + tx.data.slice(10)) as Hex) : [];
        const value = tx.value ? BigInt(tx.value) : 0n;
        const from = tx.from ? getAddress(tx.from) : undefined;
        this.calls.push({ to: getAddress(tx.to), fn: hd.fn, args, from, value });
        let out: unknown;
        try {
          out = await hd.h(args, { from, value });
        } catch (e) {
          if (e instanceof Revert) throw { code: 3, message: "execution reverted", data: e.data };
          throw e;
        }
        if (!f.outputs.length) return "0x";
        const vals =
          f.outputs.length === 1
            ? [fill(f.outputs[0]!, out)]
            : f.outputs.map((o, i) => fill(o, Array.isArray(out) ? out[i] : (out as Record<string, unknown> | undefined)?.[o.name!]));
        return encodeAbiParameters(f.outputs, vals);
      }
    }
    throw new Error(`unexpected ${method}`);
  }
}

const addr = (n: number) => getAddress("0x" + n.toString(16).padStart(40, "0"));

export const ADDR = {
  factory: addr(0xfac),
  lens: addr(0x1e45),
  terminator: addr(0x7e44),
  oracle: addr(0x0a1e),
  usdc: addr(0x05dc),
  oo: addr(0x00f3),
  pair: addr(0x9a14),
  pyth: addr(0x9717),
  finder: addr(0xf14d),
  whitelist: addr(0x3417),
  alice: addr(0xa11ce),
  bob: addr(0xb0b),
};

export function makeCtx(fake: FakeChain, opts: { prices?: PriceUpdateSource | null; subgraph?: SubgraphSource | null } = {}): BazaarContext {
  return {
    chain: new Chain(fake.transport),
    chainId: 42161,
    factory: ADDR.factory,
    lens: ADDR.lens,
    terminator: ADDR.terminator,
    oracle: ADDR.oracle,
    usdc: ADDR.usdc,
    prices: opts.prices ?? null,
    subgraph: opts.subgraph ?? null,
    integrator: "0x0000000000000000000000000000000000000000",
  };
}

export const b32 = (n: number | bigint) => ("0x" + BigInt(n).toString(16).padStart(64, "0")) as Hex;
