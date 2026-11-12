import { type Address, type Hex, encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { Chain, SendError } from "../src/chain/client.js";
import { HttpError, JsonRpc, NEVER_RETRIED, type RequestArgs, RpcError, type Transport, deadline } from "../src/chain/rpc.js";
import { PROBE_ADDRESS, probeCodec } from "../src/probe/index.js";

// Not a real transaction: sendRaw only hashes the bytes, so any type-2 envelope shape will do.
const RAW = ("0x02" + "ab".repeat(120)) as Hex;
const HASH = keccak256(RAW);
const OTHER = ("0x" + "11".repeat(32)) as Hex;
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const A: Address = "0x0000000000000000000000000000000000000001";

/** A transport answering each method with `answer` and recording what it was asked. */
function node(answer: (method: string, params: readonly unknown[]) => unknown): Transport & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async request({ method, params = [] }: RequestArgs) {
      asked.push(method);
      return answer(method, params);
    },
  };
}

const refuse = (code: number, message: string) => () => {
  throw new RpcError(code, message);
};

/** A fetch for JsonRpc: counts POSTs per method and answers with `answer`. */
function rpcFetch(answer: (method: string, n: number, init: RequestInit) => Response | Promise<Response>) {
  const posts: string[] = [];
  const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    posts.push(body.method);
    return answer(body.method, posts.filter((m) => m === body.method).length, init!);
  }) as typeof fetch;
  return { fetch: f, posts };
}
const result = (v: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: v }));
const hang = (init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));

describe("Chain.sendRaw", () => {
  it("returns the transaction's own hash when the node answers with it", async () => {
    const n = node(() => HASH.toUpperCase().replace("0X", "0x"));
    expect(await new Chain(n).sendRaw(RAW)).toBe(HASH);
    expect(n.asked).toEqual(["eth_sendRawTransaction"]);
  });

  it("does not take the node's word for a different hash, or for no hash", async () => {
    for (const answer of [OTHER, "0x", null, 42, "not a hash"]) {
      const err = await new Chain(node(() => answer)).sendRaw(RAW).catch((e: unknown) => e);
      expect(err, String(answer)).toBeInstanceOf(SendError);
      expect((err as { hash: Hex }).hash).toBe(HASH);
    }
  });

  it("treats every client's 'already known' as sent, with the local hash", async () => {
    for (const msg of ["already known", "known transaction: 0x" + "ab".repeat(32), "transaction already imported", "AlreadyKnown", "ALREADY_KNOWN"]) {
      expect(await new Chain(node(refuse(-32000, msg))).sendRaw(RAW), msg).toBe(HASH);
    }
    // ... but not an error that only contains the words
    await expect(new Chain(node(refuse(-32000, "unknown transaction type"))).sendRaw(RAW)).rejects.toBeInstanceOf(RpcError);
  });

  it("settles 'nonce too low' by looking the hash up", async () => {
    const found = node((m) => {
      if (m === "eth_sendRawTransaction") throw new RpcError(-32000, "nonce too low: next nonce 8, tx nonce 7");
      return { hash: HASH, nonce: "0x7" };
    });
    expect(await new Chain(found).sendRaw(RAW)).toBe(HASH);
    expect(found.asked).toEqual(["eth_sendRawTransaction", "eth_getTransactionByHash"]);

    const missing = node((m) => {
      if (m === "eth_sendRawTransaction") throw new RpcError(-32000, "nonce too low");
      return null;
    });
    const err = await new Chain(missing).sendRaw(RAW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).rpcMessage).toBe("nonce too low");

    // the lookup goes to the read RPC; a separate send endpoint (a sequencer) is asked only as a fallback
    const read = node(() => null);
    const send = node((m) => {
      if (m === "eth_sendRawTransaction") throw new RpcError(-32000, "nonce too low");
      return { hash: HASH };
    });
    expect(await new Chain(read, { send }).sendRaw(RAW)).toBe(HASH);
    expect(read.asked).toEqual(["eth_getTransactionByHash"]);

    const broken = node((m) => {
      if (m === "eth_sendRawTransaction") throw new RpcError(-32000, "nonce too low");
      throw new TypeError("fetch failed");
    });
    const e2 = await new Chain(broken).sendRaw(RAW).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(SendError);
    expect((e2 as { hash: Hex }).hash).toBe(HASH);
  });

  it("rethrows a refusal, and reports a lost answer as an unknown outcome carrying the hash", async () => {
    const refused = await new Chain(node(refuse(-32000, "insufficient funds for gas * price + value"))).sendRaw(RAW).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RpcError);
    for (const thrown of [new TypeError("fetch failed"), new DOMException("The operation was aborted due to timeout", "TimeoutError"), new HttpError(502, "HTTP 502 from x")]) {
      const err = await new Chain(node(() => Promise.reject(thrown))).sendRaw(RAW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SendError);
      expect((err as { hash: Hex; cause: unknown }).hash).toBe(HASH);
      expect((err as { cause: unknown }).cause).toBe(thrown);
    }
    const timedOut = await new Chain(node(refuse(-32000, "request timed out"))).sendRaw(RAW).catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(SendError);
  });

  it("refuses what is not a signed transaction before sending anything", async () => {
    for (const raw of ["0x", "0x0", "02f8", "0xzz", ("0x03" + "00".repeat(40)) as Hex]) {
      const n = node(() => HASH);
      await expect(new Chain(n).sendRaw(raw as Hex)).rejects.toBeInstanceOf(TypeError);
      expect(n.asked).toEqual([]);
    }
  });

  it("is never retried by JsonRpc, while reads are", async () => {
    // The node takes the first submission but its answer is lost (slower than the timeout).
    const { fetch, posts } = rpcFetch((m, n, init) => (n === 1 ? hang(init) : m === "eth_chainId" ? result("0x1") : result(HASH)));
    const chain = new Chain(new JsonRpc("https://seq.example/rpc", { fetch, timeoutMs: 100, retries: 3 }));
    const err = await chain.sendRaw(RAW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(posts.filter((p) => p === "eth_sendRawTransaction").length).toBe(1);
    expect(await chain.chainId()).toBe(1);
    expect(posts.filter((p) => p === "eth_chainId").length).toBe(2);
  });

  it("gives JsonRpc a per-request retry count", async () => {
    const { fetch, posts } = rpcFetch(() => new Response("busy", { status: 503 }));
    const t = new JsonRpc("https://rpc.example/rpc", { fetch, retries: 3 });
    await expect(t.request({ method: "eth_blockNumber" }, { retries: 0 })).rejects.toBeInstanceOf(HttpError);
    expect(posts.length).toBe(1);
    expect(NEVER_RETRIED.has("eth_sendRawTransaction")).toBe(true);
  });
});

describe("state override support", () => {
  const aggregateOf = (rows: { success: boolean; returnData: Hex }[]) =>
    encodeAbiParameters(probeCodec().fn("aggregate").outputs, [rows]);
  const agg3 = (rows: { success: boolean; returnData: Hex }[]) =>
    encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [rows]);

  it("decodes aggregate([]) instead of trusting any answer", async () => {
    // A node that ignores the override runs the call against an empty account: "0x".
    for (const answer of ["0x", "0x1234", "0x" + "00".repeat(31) + "01"]) {
      const n = node((m) => (m === "eth_call" ? answer : "0x6001"));
      expect(await new Chain(n).supportsOverrides(), answer).toBe(false);
    }
    expect(await new Chain(node(() => aggregateOf([]))).supportsOverrides()).toBe(true);
    expect(await new Chain(node(refuse(-32602, "too many arguments"))).supportsOverrides()).toBe(false);
  });

  it("batches through Multicall3 on a node that ignores overrides", async () => {
    const n = node((m, params) => {
      if (m === "eth_getCode") return "0x6001";
      const to = (params[0] as { to: Address }).to;
      if (to === PROBE_ADDRESS) return "0x";
      if (to === MULTICALL3) return agg3([{ success: true, returnData: "0xbeef" }]);
      throw new Error("unexpected call");
    });
    const chain = new Chain(n);
    expect(await chain.batch([{ to: A, data: "0x12345678" }])).toEqual([[true, "0xbeef"]]);
    expect(chain.overridesSupported).toBe(false);
  });

  it("falls back when a node that took the override once ignores it later", async () => {
    let probes = 0;
    const n = node((m, params) => {
      if (m === "eth_getCode") return "0x6001";
      const to = (params[0] as { to: Address }).to;
      if (to === PROBE_ADDRESS) return probes++ === 0 ? aggregateOf([]) : "0x";
      return agg3([{ success: false, returnData: "0x" }]);
    });
    const chain = new Chain(n);
    expect(await chain.supportsOverrides()).toBe(true);
    expect(await chain.batch([{ to: A, data: "0x12345678" }])).toEqual([[false, "0x"]]);
    expect(chain.overridesSupported).toBe(false);
  });

  it("says plainly when the probe cannot simulate", async () => {
    const chain = new Chain(node(() => "0x"));
    await expect(chain.probe(A, A, "0x", 0n, A, null)).rejects.toThrow(/state override/);
  });
});

describe("JsonRpc", () => {
  const KEY = "sk_live_SECRETKEY1234";

  it("refuses a header value HTTP cannot carry, without showing it", () => {
    for (const bad of [`Bearer ${KEY}\u0000x`, `Bearer ${KEY}\r\nX-Evil: 1`, `Bearer ${KEY}\n`, `Bearer ${KEY}Ā`]) {
      let err: unknown;
      try {
        new JsonRpc("https://rpc.example/rpc", { headers: { authorization: bad } });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).message)).toContain("authorization");
    }
  });

  it("keeps header values out of transport and node errors", async () => {
    const headers = { authorization: `Bearer ${KEY}`, "x-api-key": "another-secret-value" };
    const leaky = (async () => {
      throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value (another-secret-value)`, { cause: new Error(`while sending Bearer ${KEY}`) });
    }) as typeof fetch;
    const err = (await new JsonRpc("https://rpc.example/rpc", { headers, retries: 0, fetch: leaky }).request({ method: "eth_chainId" }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("another-secret-value");
    expect(String((err.cause as Error | undefined)?.message ?? "")).not.toContain(KEY);
    const echo = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: `bad key Bearer ${KEY}` } }))) as typeof fetch;
    const e2 = (await new JsonRpc("https://rpc.example/rpc", { headers, retries: 0, fetch: echo }).request({ method: "eth_chainId" }).catch((e: unknown) => e)) as Error;
    expect(e2).toBeInstanceOf(RpcError);
    expect(e2.message).not.toContain(KEY);
  });

  it("refuses a response body over its byte limit, without retrying", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "00".repeat(5_000) });
    const { fetch, posts } = rpcFetch(() => new Response(big));
    const t = new JsonRpc("https://rpc.example/rpc", { fetch, retries: 3, maxResponseBytes: 4_096 });
    const err = (await t.request({ method: "eth_call" }).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("ResponseTooLargeError");
    expect(posts.length).toBe(1);
    // a declared length over the limit is refused before reading
    const declared = rpcFetch(() => new Response("{}", { headers: { "content-length": "999999" } }));
    await expect(new JsonRpc("https://rpc.example/rpc", { fetch: declared.fetch, retries: 0, maxResponseBytes: 4_096 }).request({ method: "eth_call" })).rejects.toThrow(/more than/);
    // and one under it reads as before
    const ok = rpcFetch(() => result("0x01"));
    expect(await new JsonRpc("https://rpc.example/rpc", { fetch: ok.fetch, maxResponseBytes: 4_096 }).request({ method: "eth_call" })).toBe("0x01");
  });

  it("does not accept data that is not hex from the node", async () => {
    await expect(new Chain(node(() => "hello")).call(A, "0x12345678")).rejects.toThrow(/not hex/);
    expect(await new Chain(node(() => "0xABCD")).call(A, "0x12345678")).toBe("0xabcd");
    expect(await new Chain(node(() => null)).call(A, "0x12345678")).toBe("0x");
  });
});

describe("a request's deadline", () => {
  // A fetch that neither settles nor acts on its abort signal: what a connection that went quiet looks like.
  const stalled = (seen: AbortSignal[]) =>
    ((_url: string, init?: RequestInit) => {
      seen.push(init!.signal!);
      return new Promise<Response>(() => {});
    }) as typeof fetch;

  it("ends an exchange whose fetch never settles, tells the fetch to stop, and retries", async () => {
    const seen: AbortSignal[] = [];
    const rpc = new JsonRpc("https://rpc.example/rpc", { fetch: stalled(seen), timeoutMs: 50, retries: 1 });
    const err = await rpc.request({ method: "eth_blockNumber" }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(seen).toHaveLength(2); // the first attempt and its retry
    expect(seen.every((s) => s.aborted)).toBe(true);
  });

  it("ends a body that stops halfway and never acts on the cancel", async () => {
    const half = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":');
    const fetchHalf = (async () =>
      new Response(
        new ReadableStream({
          start: (c) => c.enqueue(half),
          cancel: () => new Promise<void>(() => {}),
        }),
        { status: 200 },
      )) as typeof fetch;
    const rpc = new JsonRpc("https://rpc.example/rpc", { fetch: fetchHalf, timeoutMs: 50, retries: 0 });
    await expect(rpc.request({ method: "eth_blockNumber" })).rejects.toThrow(/aborted due to timeout/);
  });

  it("passes on what settles in time, and stops its timer when cleared", async () => {
    const limit = deadline(50);
    expect(await limit.race(Promise.resolve(7))).toBe(7);
    limit.clear();
    await new Promise((r) => setTimeout(r, 80));
    expect(limit.signal.aborted).toBe(false);
    const late = deadline(10);
    await expect(late.race(new Promise(() => {}))).rejects.toThrow(/aborted due to timeout/);
    expect(late.signal.aborted).toBe(true);
  });
});
