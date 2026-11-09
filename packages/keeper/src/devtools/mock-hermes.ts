/**
 * A Hermes-compatible price server backed by Pyth's MockPyth, for local Anvil deployments.
 *
 *     bazaar mock-prices --rpc http://127.0.0.1:8545 --pyth 0x… --price <feedId>=2000
 *
 * It serves the routes the keeper uses (latest, stream, historical, price_feeds), building each update
 * with MockPyth.createPriceFeedUpdateData and stamping it with the chain's latest block time, so Anvil
 * accepts it as fresh. Set prices while it runs:
 *
 *     curl -X POST localhost:8787/mock/price -H 'content-type: application/json' -d '{"id": "<feedId>", "price": 1850.5}'
 *
 * and add `"paused": true` (or false) to stop (or resume) a feed's live prints, imitating a closed
 * session; historical requests still serve it. A POST must be JSON (`content-type: application/json`),
 * name this machine in its Host header (localhost, an IP address, or the --host it listens on), and
 * come from no web page on another origin: a site open in a browser here cannot set prices, directly
 * or through DNS rebinding.
 *
 * Feed ids are kept as Hermes writes them: lowercase hex without 0x. `prices`, `symbols` and `paused`
 * accept either spelling.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { type AddressInfo, isIP } from "node:net";
import { Chain, ETH_USD_FEED, JsonRpc, type Transport } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, toFunctionSelector } from "viem";

const CREATE = toFunctionSelector("createPriceFeedUpdateData(bytes32,int64,uint64,int32,int64,uint64,uint64,uint64)");
const CREATE_ARGS = [
  { type: "bytes32" },
  { type: "int64" },
  { type: "uint64" },
  { type: "int32" },
  { type: "int64" },
  { type: "uint64" },
  { type: "uint64" },
  { type: "uint64" },
] as const;
const BYTES = [{ type: "bytes" }] as const;
export const EXPO = -8;

/** A feed id as the mock keys it: lowercase, without 0x. */
export function feedKey(feed: string): string {
  const f = feed.toLowerCase();
  return f.startsWith("0x") ? f.slice(2) : f;
}

/** A Map keyed by feed id, whatever its spelling. */
export class FeedMap<V> extends Map<string, V> {
  override get(feed: string): V | undefined {
    return super.get(feedKey(feed));
  }
  override set(feed: string, value: V): this {
    return super.set(feedKey(feed), value);
  }
  override has(feed: string): boolean {
    return super.has(feedKey(feed));
  }
  override delete(feed: string): boolean {
    return super.delete(feedKey(feed));
  }
}

/** A Set of feed ids, whatever their spelling. */
export class FeedSet extends Set<string> {
  override add(feed: string): this {
    return super.add(feedKey(feed));
  }
  override has(feed: string): boolean {
    return super.has(feedKey(feed));
  }
  override delete(feed: string): boolean {
    return super.delete(feedKey(feed));
  }
}

export interface MockPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export interface MockParsed {
  id: string;
  price: MockPrice;
  ema_price: MockPrice;
  metadata: { slot: number; proof_available_time: number; prev_publish_time: number };
}

export interface MockBody {
  binary: { encoding: "hex"; data: string[] };
  parsed: MockParsed[];
}

/** Feed id -> value, as a record, a Map or entries. */
export type FeedEntries<V> = Readonly<Record<string, V>> | Iterable<readonly [string, V]>;

function entries<V>(e: FeedEntries<V> | null | undefined): [string, V][] {
  if (!e) return [];
  if (Symbol.iterator in e) return [...(e as Iterable<readonly [string, V]>)].map(([k, v]) => [k, v]);
  return Object.entries(e as Record<string, V>);
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export class MockHermes {
  readonly chain: Chain;
  readonly pyth: Address;
  /** USD per feed */
  readonly prices: FeedMap<number>;
  readonly symbols: FeedMap<string>;
  readonly confBp: number;
  /** feeds that stop printing, to imitate a closed session */
  readonly paused = new FeedSet();

  /** `rpc` is a URL, any EIP-1193 transport, or a Chain. */
  constructor(
    rpc: string | Transport | Chain,
    pyth: string,
    prices?: FeedEntries<number> | null,
    symbols?: FeedEntries<string> | null,
    confBp = 1,
  ) {
    this.chain =
      rpc instanceof Chain ? rpc : new Chain(typeof rpc === "string" ? new JsonRpc(rpc, { perSecond: 500 }) : rpc);
    this.pyth = getAddress(pyth);
    this.prices = new FeedMap(entries(prices));
    if (!this.prices.has(ETH_USD_FEED)) this.prices.set(ETH_USD_FEED, 2000.0);
    this.symbols = new FeedMap(entries(symbols));
    if (!this.symbols.has(ETH_USD_FEED)) this.symbols.set(ETH_USD_FEED, "Crypto.ETH/USD");
    this.confBp = confBp;
  }

  async chainTime(): Promise<number> {
    return (await this.chain.block("latest")).timestamp;
  }

  setPrice(feed: string, usd: number): void {
    this.prices.set(feed, Number(usd));
  }

  /** The update data and parsed print for `feed` at `ts`, built by MockPyth. */
  async update(feed: string, ts: number): Promise<[Hex, MockParsed]> {
    const key = feedKey(feed);
    const usd = this.prices.get(key);
    if (usd === undefined) throw new Error(`no price for feed ${key}`);
    const price = BigInt(roundHalfEven(usd * 10 ** -EXPO));
    const conf = floorDiv(price * BigInt(this.confBp), 10_000n);
    const args = encodeAbiParameters(CREATE_ARGS, [`0x${key}`, price, conf, EXPO, price, conf, BigInt(ts), BigInt(ts - 1)]);
    const raw = await this.chain.call(this.pyth, concatHex([CREATE, args]));
    const [blob] = decodeAbiParameters(BYTES, raw);
    const p: MockPrice = { price: price.toString(), conf: conf.toString(), expo: EXPO, publish_time: ts };
    const parsed: MockParsed = {
      id: key,
      price: p,
      ema_price: { ...p },
      metadata: { slot: ts, proof_available_time: ts, prev_publish_time: ts - 1 },
    };
    return [blob, parsed];
  }

  /** A Hermes response for `ids`: live prints at the chain's time when `ts` is null, else at `ts`. */
  async body(ids: readonly string[], ts: number | null): Promise<MockBody> {
    const feeds: string[] = [];
    for (const id of ids) {
      const f = feedKey(id);
      if (!this.prices.has(f)) continue;
      if (ts === null && this.paused.has(f)) continue;
      feeds.push(f);
    }
    const at = ts ?? (await this.chainTime());
    const built = await Promise.all(feeds.map((f) => this.update(f, at)));
    return {
      binary: { encoding: "hex", data: built.map(([blob]) => blob.slice(2)) },
      parsed: built.map(([, p]) => p),
    };
  }

  feeds(): { id: string; attributes: { symbol: string } }[] {
    return [...this.prices.keys()].map((f) => ({ id: f, attributes: { symbol: this.symbols.get(f) ?? "" } }));
  }
}

// ---- the server ----

function json(res: ServerResponse, code: number, obj: unknown): void {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class BadRequest extends Error {}

/** A host name that DNS rebinding cannot point at this server: a loopback name or an IP address. */
function localName(name: string): boolean {
  const h = name.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || isIP(h.replace(/^\[(.*)\]$/, "$1")) !== 0;
}

function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Why a POST is refused, as [status, message], or null to serve it. Setting prices changes what a
 * keeper on this machine sees, so it is for local clients only: the Host must be a loopback name, an
 * IP address or the host the server was started on (any other name means DNS rebinding); an Origin, if
 * sent, must be a loopback one (any other is a web page from elsewhere); and the body must be declared
 * JSON (which a page cannot send cross-origin without a preflight this server never answers).
 */
function refusePost(req: IncomingMessage, listenHost: string): [number, string] | null {
  const host = hostnameOf(req.headers.host ?? "");
  if (host === null || !(localName(host) || host.toLowerCase() === listenHost.toLowerCase())) {
    return [403, "refused: the Host header must be localhost or an IP address (this is a local test server)"];
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // "null" (a sandboxed page, a file) or garbage: not local
    }
    const o = originHost?.toLowerCase() ?? "";
    if (!(o === "localhost" || o.endsWith(".localhost") || /^(?:127\.\d+\.\d+\.\d+|\[::1\])$/.test(o))) {
      return [403, "refused: a web page on another origin cannot set prices"];
    }
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return [415, "send the body as JSON, with content-type: application/json"];
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** One open price stream: an event now, then one a second after each, until the client leaves. */
function openStream(mock: MockHermes, ids: string[], res: ServerResponse, open: Set<() => void>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    open.delete(stop);
    res.end();
  };
  open.add(stop);
  res.on("close", stop); // the client left (a request's own "close" fires once it is read)
  const send = async () => {
    let body: MockBody;
    try {
      body = await mock.body(ids, null);
    } catch {
      stop(); // as the Python mock does: the stream ends, and the client reconnects
      return;
    }
    if (closed) return;
    res.write(`data:${JSON.stringify(body)}\n\n`);
    timer = setTimeout(() => void send(), 1000);
  };
  void send();
}

async function handle(
  mock: MockHermes,
  req: IncomingMessage,
  res: ServerResponse,
  open: Set<() => void>,
  listenHost: string,
): Promise<void> {
  const u = new URL(req.url ?? "/", "http://mock");
  const path = u.pathname.replace(/\/+$/, "");
  if (req.method === "GET") {
    const ids = u.searchParams.getAll("ids[]").filter((s) => s !== "");
    try {
      if (path === "/v2/price_feeds") return json(res, 200, mock.feeds());
      if (path === "/mock/price") return json(res, 200, Object.fromEntries(mock.prices));
      if (path === "/v2/updates/price/latest") return json(res, 200, await mock.body(ids, null));
      if (path === "/v2/updates/price/stream") return openStream(mock, ids, res, open);
      if (path.startsWith("/v2/updates/price/")) {
        const last = path.slice(path.lastIndexOf("/") + 1);
        if (!/^\s*[+-]?\d+\s*$/.test(last)) throw new Error(`invalid literal for int() with base 10: '${last}'`);
        return json(res, 200, await mock.body(ids, Number.parseInt(last, 10)));
      }
    } catch (e) {
      return json(res, 500, { error: errorText(e) });
    }
    return json(res, 404, { error: "not found" });
  }
  if (req.method === "POST") {
    const refused = refusePost(req, listenHost);
    if (refused !== null) {
      req.resume(); // the body is not read: drain it
      return json(res, refused[0], { error: refused[1] });
    }
    let body: Record<string, unknown>;
    try {
      const text = await readBody(req);
      const parsed: unknown = JSON.parse(text || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("the body must be a JSON object");
      body = parsed as Record<string, unknown>;
    } catch (e) {
      return json(res, 400, { error: errorText(e) });
    }
    if (path === "/mock/price") {
      const id = body.id;
      const price = body.price;
      const usd = typeof price === "number" ? price : typeof price === "string" && price.trim() !== "" ? Number(price) : NaN;
      if (typeof id !== "string") return json(res, 400, { error: "'id' must be a feed id" });
      if (!Number.isFinite(usd)) return json(res, 400, { error: "'price' must be a number" });
      mock.setPrice(id, usd);
      if ("paused" in body) {
        if (body.paused) mock.paused.add(id);
        else mock.paused.delete(id);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  }
  res.writeHead(501, { "content-type": "text/plain" });
  res.end(`Unsupported method (${req.method ?? ""})`);
}

export interface MockHermesServer {
  /** where to point `prices.endpoint` */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  /** Ends the open streams and stops listening. */
  close(): Promise<void>;
}

/** Serve `mock` in the background (port 0 picks a free one); resolves once it listens. */
export async function startMockHermes(
  mock: MockHermes,
  opts: { host?: string; port?: number } = {},
): Promise<MockHermesServer> {
  const host = opts.host ?? "127.0.0.1";
  const open = new Set<() => void>();
  const server = createServer((req, res) => {
    handle(mock, req, res, open, host).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: errorText(e) });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}`,
    host,
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const stop of [...open]) stop();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** `bazaar mock-prices`: serve in the foreground until Ctrl-C (or SIGTERM). */
export async function serveMockHermes(
  rpcUrl: string,
  pyth: string,
  prices: FeedEntries<number>,
  opts: { host?: string; port?: number } = {},
): Promise<void> {
  const mock = new MockHermes(rpcUrl, pyth, prices);
  const srv = await startMockHermes(mock, opts);
  console.log(`mock Hermes on ${srv.url} for MockPyth ${mock.pyth}; feeds: ${[...mock.prices.keys()].join(", ")}`);
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await srv.close();
}
