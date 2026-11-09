/**
 * Chain access: reads, batched reads and simulations through the probe, gas, logs and sending.
 *
 * `Chain` wraps any {@link Transport}: a browser wallet's provider, a viem client, or a JsonRpc for a
 * server. Batched reads use the probe's `aggregate` through a state override where the node supports
 * overrides, Multicall3 where it is deployed, and parallel eth_calls otherwise.
 */

import { type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, toHex } from "viem";
import { ZERO_ADDRESS } from "../constants.js";
import { PROBE_ADDRESS, type StateOverride, probeCodec, stateOverride } from "../probe/index.js";
import type { RawLog } from "./codec.js";
import { HttpError, JsonRpc, type JsonRpcOptions, RpcError, type Transport, toRpcError } from "./rpc.js";

/**
 * A send whose outcome is unknown: the signed transaction left this process, but nothing settled
 * whether the node took it. It may still be mined. `hash` is keccak256 of the signed bytes, so a
 * receipt or eth_getTransactionByHash lookup settles it, and submitting the same bytes again is safe
 * (it cannot run twice); signing a new transaction for the same work is not, until that is settled.
 * `cause` holds what was seen (the transport's error, the node's error, or nothing for a bad answer).
 */
export class SendError extends Error {
  override readonly name = "SendError";
  constructor(
    message: string,
    readonly hash: Hex,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The node already holds this exact transaction: geth, reth and Nitro "already known" (geth before
 * 1.9 "known transaction: <hash>"), Besu "Known transaction", Nethermind "AlreadyKnown", Anvil
 * "transaction already imported", OpenEthereum "...was already imported". Matched with `_` read as a space.
 */
const ALREADY_KNOWN = /\balready ?known\b|\bknown transaction\b|\balready imported\b/i;
/** The sender's nonce is past this transaction's: it was mined, or another transaction used the nonce. */
const NONCE_TOO_LOW = /\bnonce (?:is )?too low\b|\boldnonce\b|\bnonce has already been used\b/i;
/** A JSON-RPC error that reports the node's own timeout, not a refusal. */
const TIMED_OUT = /\btime(?:d)? ?out\b|\bdeadline exceeded\b/i;
const SIGNED_TX = /^0x(?:[0-9a-fA-F]{2})+$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Thrown inside {@link Chain.batch} when the probe's aggregate answers "0x": the node ignored the override. */
class OverrideIgnored extends Error {}

export interface Block {
  readonly number: number;
  readonly timestamp: number;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly baseFee: bigint;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly ret: Hex;
  readonly claimBefore: bigint;
  readonly claimAfter: bigint;
  readonly gasUsed: bigint;
  readonly adlPendingAfter: boolean;
  readonly settlementFixedAfter: bigint;
  /** Claimable balance the call earned, in BAZAAR precision (1e18 = $1). */
  readonly reward: bigint;
}

/** One call in a batched read. */
export interface Read {
  readonly to: Address;
  readonly data: Hex;
}

export interface Receipt {
  readonly transactionHash: Hex;
  readonly blockNumber: number;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly from: Address;
  readonly to: Address | null;
  readonly logs: RawLog[];
}

export type BlockTag = number | "latest" | "pending" | "safe" | "finalized" | "earliest";

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const tag = (b: BlockTag) => (typeof b === "number" ? toHex(b) : b);
const num = (h: unknown) => Number(BigInt(h as string));
const big = (h: unknown) => (h === null || h === undefined ? 0n : BigInt(h as string));
const HEX = /^0x[0-9a-fA-F]*$/;
const hex = (h: unknown): Hex => {
  if (h === null || h === undefined || h === "" || h === "0x") return "0x";
  if (typeof h !== "string" || !HEX.test(h)) throw new Error("the node answered with something that is not hex");
  return h.toLowerCase() as Hex;
};

/** Whether `raw` is aggregate([])'s answer, an empty array (a node that ignored the override says "0x"). */
function emptyAggregate(raw: unknown): boolean {
  if (typeof raw !== "string" || raw === "0x" || !HEX.test(raw)) return false;
  try {
    const out = probeCodec().decode<readonly unknown[]>("aggregate", raw as Hex);
    return Array.isArray(out) && out.length === 0;
  } catch {
    return false;
  }
}

function parseLog(lg: Record<string, unknown>): RawLog {
  return {
    address: getAddress(lg.address as string),
    topics: (lg.topics as string[]).map((t) => t.toLowerCase() as Hex),
    data: hex(lg.data),
    blockNumber: num(lg.blockNumber),
    blockHash: hex(lg.blockHash),
    transactionHash: hex(lg.transactionHash),
    logIndex: num(lg.logIndex),
  };
}

export interface ChainOptions {
  /** Where transactions are submitted; defaults to the read transport. */
  send?: Transport;
}

export class Chain {
  readonly rpc: Transport;
  readonly sendRpc: Transport;
  overridesSupported: boolean | null = null;
  private multicall: boolean | null = null;

  constructor(rpc: Transport, opts: ChainOptions = {}) {
    this.rpc = rpc;
    this.sendRpc = opts.send ?? rpc;
  }

  /** A Chain over HTTP JSON-RPC, optionally submitting to a different endpoint (e.g. the sequencer). */
  static fromUrl(url: string, opts: JsonRpcOptions & { sendUrl?: string | null } = {}): Chain {
    const rpc = new JsonRpc(url, opts);
    return new Chain(rpc, opts.sendUrl ? { send: new JsonRpc(opts.sendUrl, opts) } : {});
  }

  /** A JSON-RPC request; errors normalized to RpcError where the node sent one. */
  async request<T = unknown>(method: string, params: readonly unknown[] = [], via: Transport = this.rpc): Promise<T> {
    try {
      return (await via.request({ method, params })) as T;
    } catch (e) {
      throw toRpcError(e) ?? e;
    }
  }

  // ---- basics ----
  async chainId(): Promise<number> {
    return num(await this.request("eth_chainId"));
  }

  async blockNumber(): Promise<number> {
    return num(await this.request("eth_blockNumber"));
  }

  async block(at: BlockTag = "latest"): Promise<Block> {
    const b = await this.request<Record<string, unknown> | null>("eth_getBlockByNumber", [tag(at), false]);
    if (!b) throw new Error(`no block ${String(at)}`);
    return {
      number: num(b.number),
      timestamp: num(b.timestamp),
      hash: hex(b.hash),
      parentHash: hex(b.parentHash),
      baseFee: big(b.baseFeePerGas),
    };
  }

  async code(address: Address): Promise<Hex> {
    return hex(await this.request("eth_getCode", [address, "latest"]));
  }

  async balance(address: Address): Promise<bigint> {
    return big(await this.request("eth_getBalance", [address, "latest"]));
  }

  async nonce(address: Address, at: BlockTag = "pending"): Promise<number> {
    return num(await this.request("eth_getTransactionCount", [address, tag(at)]));
  }

  async gasPrice(): Promise<bigint> {
    return big(await this.request("eth_gasPrice"));
  }

  // ---- calls ----
  async call(
    to: Address,
    data: Hex,
    opts: { from?: Address | null; value?: bigint; block?: BlockTag; overrides?: StateOverride } = {},
  ): Promise<Hex> {
    const tx: Record<string, string> = { to, data };
    if (opts.from) tx.from = opts.from;
    if (opts.value) tx.value = toHex(opts.value);
    const params: unknown[] = [tx, tag(opts.block ?? "latest")];
    if (opts.overrides) params.push(opts.overrides);
    return hex(await this.request("eth_call", params));
  }

  /**
   * Whether eth_call honours state overrides here, asked once: `aggregate([])` on the probe placed by
   * override must decode to an empty array. A node that ignores the override runs the call against an
   * empty account and answers "0x"; that, an answer that does not decode, or a JSON-RPC error means no.
   */
  async supportsOverrides(): Promise<boolean> {
    if (this.overridesSupported === null) {
      let ok = false;
      try {
        const data = probeCodec().encode("aggregate", []);
        ok = emptyAggregate(await this.request("eth_call", [{ to: PROBE_ADDRESS, data }, "latest", stateOverride()]));
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
      }
      this.overridesSupported = ok;
    }
    return this.overridesSupported;
  }

  private async hasMulticall(): Promise<boolean> {
    if (this.multicall === null) {
      try {
        this.multicall = (await this.code(MULTICALL3)).length > 2;
      } catch {
        this.multicall = false;
      }
    }
    return this.multicall;
  }

  /** Run many reads in as few eth_calls as the node allows. A failing read reports [false, revertData]. */
  async batch(reads: readonly Read[], block: BlockTag = "latest", chunk = 200): Promise<[boolean, Hex][]> {
    if (!reads.length) return [];
    const probe = probeCodec();
    if (await this.supportsOverrides()) {
      const parts: Promise<[boolean, Hex][]>[] = [];
      for (let i = 0; i < reads.length; i += chunk) {
        const part = reads.slice(i, i + chunk).map((r) => ({ target: r.to, data: r.data }));
        parts.push(
          this.call(PROBE_ADDRESS, probe.encode("aggregate", part), { block, overrides: stateOverride() }).then((raw) => {
            if (raw === "0x") throw new OverrideIgnored();
            return probe.decode<{ success: boolean; returnData: Hex }[]>("aggregate", raw).map((x) => [x.success, x.returnData]);
          }),
        );
      }
      try {
        return (await Promise.all(parts)).flat();
      } catch (e) {
        if (!(e instanceof OverrideIgnored)) throw e;
        // It honoured the override before (another node behind a load balancer, say): not any more.
        this.overridesSupported = false;
        return this.batch(reads, block, chunk);
      }
    }
    if (await this.hasMulticall()) {
      const parts: Promise<[boolean, Hex][]>[] = [];
      for (let i = 0; i < reads.length; i += chunk) {
        const calls = reads.slice(i, i + chunk).map((r) => ({ target: r.to, allowFailure: true, callData: r.data }));
        parts.push(
          this.call(MULTICALL3, encodeAggregate3(calls), { block }).then((raw) =>
            decodeAggregate3(raw).map((x) => [x.success, x.returnData] as [boolean, Hex]),
          ),
        );
      }
      return (await Promise.all(parts)).flat();
    }
    return Promise.all(
      reads.map(async (r): Promise<[boolean, Hex]> => {
        try {
          return [true, await this.call(r.to, r.data, { block })];
        } catch (e) {
          if (e instanceof RpcError) return [false, e.revertData ?? "0x"];
          throw e;
        }
      }),
    );
  }

  /** Simulate one call from the probe and report its reward on `pair`. */
  async probe(sender: Address | null, target: Address, data: Hex, value: bigint, lens: Address, pair: Address | null): Promise<ProbeResult> {
    const probe = probeCodec();
    const enc = probe.encode("execute", target, data, value, lens, pair ?? ZERO_ADDRESS);
    const raw = await this.call(PROBE_ADDRESS, enc, { from: sender, overrides: stateOverride() });
    if (raw === "0x") {
      this.overridesSupported = false;
      throw new Error("the node ignored the eth_call state override, so the probe cannot simulate here; use an RPC that supports state overrides");
    }
    const r = probe.decode<{
      ok: boolean;
      ret: Hex;
      claimBefore: bigint;
      claimAfter: bigint;
      gasUsed: bigint;
      adlPendingAfter: boolean;
      settlementFixedAfter: bigint;
    }>("execute", raw);
    return { ...r, reward: r.claimAfter > r.claimBefore ? r.claimAfter - r.claimBefore : 0n };
  }

  async estimateGas(from: Address, to: Address, data: Hex, value = 0n): Promise<bigint> {
    const tx: Record<string, string> = { from, to, data };
    if (value) tx.value = toHex(value);
    return big(await this.request("eth_estimateGas", [tx]));
  }

  // ---- logs ----
  async logs(fromBlock: number, toBlock: number, addresses: readonly Address[]): Promise<RawLog[]> {
    if (!addresses.length || fromBlock > toBlock) return [];
    const raw = await this.request<Record<string, unknown>[]>("eth_getLogs", [
      { fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), address: addresses },
    ]);
    const out: RawLog[] = [];
    for (const lg of raw) if (!lg.removed) out.push(parseLog(lg));
    return out;
  }

  // ---- sending ----
  /**
   * Submit a signed transaction (its canonical envelope, as signing returns it) through the send
   * transport, exactly once: JsonRpc never retries eth_sendRawTransaction (a transport you supply must
   * not either), so a lost answer cannot become a second submission here.
   *
   * Returns the transaction's hash, keccak256(raw) computed locally (lowercase), when the node took
   * the transaction: it answered with that same hash; or it already holds it ("already known",
   * "known transaction", "transaction already imported", "AlreadyKnown"); or it said "nonce too low"
   * (or "nonce has already been used") and eth_getTransactionByHash finds that hash, asked of the read
   * transport and then, if different, of the send transport.
   *
   * Throws, having sent nothing, `TypeError` when `raw` is not 0x-prefixed hex bytes or is an EIP-4844
   * blob transaction (type 3: its network form hashes differently).
   *
   * Throws {@link RpcError}, the node's own error unchanged, when the node refused the transaction:
   * any other JSON-RPC error (underpriced, insufficient funds, ...), and "nonce too low" when no lookup
   * finds the hash. The transaction is not in that node's pool.
   *
   * Throws {@link SendError} (with `hash`, and `cause`) when the outcome is unknown and the
   * transaction may still be mined: the transport failed (connection error, timeout, a non-2xx HTTP
   * answer, an oversized or unreadable answer: anything that is not a JSON-RPC error); the node's
   * JSON-RPC error reports a timeout; the node answered with another hash or with something that is
   * not a hash; or "nonce too low" came back and the lookup by hash failed.
   */
  async sendRaw(raw: Hex): Promise<Hex> {
    if (typeof raw !== "string" || !SIGNED_TX.test(raw)) throw new TypeError("sendRaw takes a signed transaction as 0x-prefixed hex bytes");
    if (raw.slice(2, 4) === "03") throw new TypeError("sendRaw does not send blob (EIP-4844) transactions: their network form hashes differently");
    const hash = keccak256(raw);
    let answer: unknown;
    try {
      answer = await this.sendRpc.request({ method: "eth_sendRawTransaction", params: [raw] });
    } catch (e) {
      const err = toRpcError(e);
      if (!err) {
        const what = e instanceof HttpError ? `HTTP ${e.status}` : e instanceof Error ? e.name : "an error";
        throw new SendError(`the transaction ${hash} was submitted but no answer settled it (${what}); it may still be mined`, hash, { cause: e });
      }
      const msg = err.rpcMessage.replaceAll("_", " ");
      if (ALREADY_KNOWN.test(msg)) return hash;
      if (NONCE_TOO_LOW.test(msg)) return this.settleNonceTooLow(hash, err);
      if (TIMED_OUT.test(msg)) throw new SendError(`the node timed out on the transaction ${hash}; it may still be mined`, hash, { cause: err });
      throw err;
    }
    if (typeof answer === "string" && answer.toLowerCase() === hash) return hash;
    const got = typeof answer === "string" && TX_HASH.test(answer) ? `another hash (${answer.toLowerCase()})` : "something that is not its hash";
    throw new SendError(`the node answered the transaction ${hash} with ${got}; it may or may not have taken it`, hash);
  }

  /** "nonce too low" also answers a transaction that was already mined: only a lookup by its hash tells. */
  private async settleNonceTooLow(hash: Hex, refusal: RpcError): Promise<Hex> {
    const holds = (tx: unknown) => !!tx && typeof tx === "object" && String((tx as { hash?: unknown }).hash).toLowerCase() === hash;
    let found: boolean;
    try {
      found = holds(await this.request("eth_getTransactionByHash", [hash]));
    } catch (e) {
      throw new SendError(`the node said "nonce too low" for the transaction ${hash} and looking it up failed; it may have been mined`, hash, { cause: e });
    }
    if (!found && this.sendRpc !== this.rpc) {
      try {
        found = holds(await this.request("eth_getTransactionByHash", [hash], this.sendRpc));
      } catch {
        // a sequencer's endpoint may serve sends only
      }
    }
    if (found) return hash;
    throw refusal;
  }

  async receipt(txHash: Hex): Promise<Receipt | null> {
    const r = await this.request<Record<string, unknown> | null>("eth_getTransactionReceipt", [txHash]);
    if (!r) return null;
    return {
      transactionHash: hex(r.transactionHash),
      blockNumber: num(r.blockNumber),
      status: big(r.status) === 1n ? "success" : "reverted",
      gasUsed: big(r.gasUsed),
      effectiveGasPrice: big(r.effectiveGasPrice),
      from: getAddress(r.from as string),
      to: r.to ? getAddress(r.to as string) : null,
      logs: ((r.logs as Record<string, unknown>[]) ?? []).map(parseLog),
    };
  }
}

// ---- Multicall3.aggregate3 (selector 0x82ad56cb), for nodes without state overrides ----

const AGG3_IN = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;
const AGG3_OUT = [
  {
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  },
] as const;

function encodeAggregate3(calls: { target: Address; allowFailure: boolean; callData: Hex }[]): Hex {
  return concatHex(["0x82ad56cb", encodeAbiParameters(AGG3_IN, [calls])]);
}

function decodeAggregate3(raw: Hex): readonly { success: boolean; returnData: Hex }[] {
  return decodeAbiParameters(AGG3_OUT, raw)[0];
}
