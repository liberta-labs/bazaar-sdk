/**
 * ABI encoding and decoding: calls, return values, logs and custom errors.
 *
 * Results come back with the ABI's own names: a struct decodes to an object of its fields, several
 * named outputs to an object of the output names, and a single output to the bare value. Selectors
 * and topics are computed once per contract, so the keeper's hot paths only pay for the encoding.
 *
 * viem decodes integers of 48 bits or fewer as `number` and wider ones as `bigint`; both encode from
 * either.
 */

import {
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  toBytes,
} from "viem";
import { ABIS, type ContractName, CONTRACT_NAMES } from "../abi/index.js";

export function canonicalType(p: AbiParameter): string {
  if (p.type.startsWith("tuple")) {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    return "(" + comps.map(canonicalType).join(",") + ")" + p.type.slice(5);
  }
  return p.type;
}

export function signature(name: string, inputs: readonly AbiParameter[]): string {
  return `${name}(${inputs.map(canonicalType).join(",")})`;
}

export interface FunctionSpec {
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly outputs: readonly AbiParameter[];
  readonly selector: Hex;
}

export interface EventSpec {
  readonly name: string;
  readonly inputs: readonly (AbiParameter & { indexed?: boolean })[];
  readonly topic0: Hex;
}

export interface ErrorSpec {
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly selector: Hex;
}

/** A log as Chain.logs and Chain.receipt return it. */
export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface DecodedLog<A = Record<string, unknown>> {
  readonly name: string;
  readonly address: Address;
  readonly args: A;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
}

const isDynamicTopic = (t: string) => t === "string" || t === "bytes" || t.startsWith("(") || t.endsWith("]");

export class ContractCodec {
  readonly functions = new Map<string, FunctionSpec>();
  readonly events = new Map<Hex, EventSpec>();
  readonly eventByName = new Map<string, EventSpec>();
  readonly errors = new Map<Hex, ErrorSpec>();

  constructor(readonly abi: Abi) {
    for (const e of abi) {
      if (e.type === "function") {
        const sel = keccak256(toBytes(signature(e.name, e.inputs))).slice(0, 10) as Hex;
        this.functions.set(e.name, { name: e.name, inputs: e.inputs, outputs: e.outputs, selector: sel });
      } else if (e.type === "event") {
        const spec: EventSpec = { name: e.name, inputs: e.inputs, topic0: keccak256(toBytes(signature(e.name, e.inputs))) };
        this.events.set(spec.topic0, spec);
        this.eventByName.set(e.name, spec);
      } else if (e.type === "error") {
        const sel = keccak256(toBytes(signature(e.name, e.inputs))).slice(0, 10) as Hex;
        this.errors.set(sel, { name: e.name, inputs: e.inputs, selector: sel });
      }
    }
  }

  fn(name: string): FunctionSpec {
    const f = this.functions.get(name);
    if (!f) throw new Error(`the ABI has no function ${name}`);
    return f;
  }

  selector(name: string): Hex {
    return this.fn(name).selector;
  }

  /** Calldata for `name(args)`. Structs may be passed as objects of their fields or as arrays. */
  encode(name: string, ...args: readonly unknown[]): Hex {
    const f = this.fn(name);
    if (args.length !== f.inputs.length) {
      throw new TypeError(`${name} takes ${f.inputs.length} arguments, got ${args.length}`);
    }
    if (f.inputs.length === 0) return f.selector;
    return concatHex([f.selector, encodeAbiParameters(f.inputs, args as unknown[])]);
  }

  /** A return value, named as the ABI names it. */
  decode<T = unknown>(name: string, data: Hex): T {
    const f = this.fn(name);
    const values = decodeAbiParameters(f.outputs, data) as readonly unknown[];
    if (values.length === 1) return values[0] as T;
    if (f.outputs.length > 0 && f.outputs.every((p) => p.name)) {
      const out: Record<string, unknown> = {};
      f.outputs.forEach((p, i) => (out[p.name as string] = values[i]));
      return out as T;
    }
    return values as T;
  }

  topic(event: string): Hex {
    const e = this.eventByName.get(event);
    if (!e) throw new Error(`the ABI has no event ${event}`);
    return e.topic0;
  }

  /** The decoded log, or null when its topic0 is not one of this contract's events. */
  decodeLog<A = Record<string, unknown>>(log: RawLog): DecodedLog<A> | null {
    const t0 = log.topics[0];
    if (!t0) return null;
    const spec = this.events.get(t0.toLowerCase() as Hex);
    if (!spec) return null;
    const args: Record<string, unknown> = {};
    let ti = 1;
    const plain: AbiParameter[] = [];
    for (const p of spec.inputs) {
      if (p.indexed) {
        const topic = log.topics[ti++];
        if (topic === undefined) return null;
        const ct = canonicalType(p);
        // A dynamic indexed value is hashed into its topic; only the hash is recoverable.
        args[p.name ?? ""] = isDynamicTopic(ct) ? topic : decodeAbiParameters([p], topic)[0];
      } else {
        plain.push(p);
      }
    }
    if (plain.length) {
      const raw = decodeAbiParameters(plain, log.data) as readonly unknown[];
      plain.forEach((p, i) => (args[p.name ?? ""] = raw[i]));
    }
    return {
      name: spec.name,
      address: getAddress(log.address),
      args: args as A,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  }
}

const cache = new Map<string, ContractCodec>();

export function codec(name: ContractName): ContractCodec {
  let c = cache.get(name);
  if (!c) {
    c = new ContractCodec(ABIS[name] as unknown as Abi);
    cache.set(name, c);
  }
  return c;
}

export const factory = () => codec("BazaarFactory");
export const pair = () => codec("BazaarPair");
export const lens = () => codec("BazaarPairLens");
export const terminator = () => codec("BazaarPairTerminator");
export const oracle = () => codec("BazaarOracle");

let errorsCache: Map<Hex, ErrorSpec> | null = null;

/** Every custom error the five contracts declare, by selector. */
export function allErrors(): Map<Hex, ErrorSpec> {
  if (!errorsCache) {
    errorsCache = new Map();
    for (const n of CONTRACT_NAMES) for (const [k, v] of codec(n).errors) errorsCache.set(k, v);
  }
  return errorsCache;
}
