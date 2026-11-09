import { request } from "node:http";
import type { Market, Transport } from "@liberta-labs/bazaar-sdk";
import { type Hex, decodeAbiParameters, encodeAbiParameters, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesClient, PriceService } from "@liberta-labs/bazaar-sdk";
import { MockHermes, type MockHermesServer, startMockHermes } from "../src/devtools/mock-hermes.js";

const PYTH = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const FEED: Hex = `0x${"ab".repeat(32)}`;
const ETH = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
const ARGS = [
  { type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" },
  { type: "int64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
] as const;
/** What MockPyth.createPriceFeedUpdateData returns, abi.encode(PriceFeed, prevPublishTime), word by word. */
const FEED_DATA = [
  { type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint256" },
  { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint256" }, { type: "uint64" },
] as const;

/** A chain whose latest block is at `time`, and whose "MockPyth" builds its update as the real one does. */
function fakeChain() {
  const state = { time: 1_700_000_000, calls: [] as string[] };
  const transport: Transport = {
    async request({ method, params = [] }) {
      state.calls.push(method);
      if (method === "eth_getBlockByNumber") {
        return { number: "0x10", timestamp: toHex(state.time), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, baseFeePerGas: "0x1" };
      }
      if (method === "eth_call") {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (to.toLowerCase() !== PYTH) throw new Error(`call to ${to}`);
        expect(data.slice(0, 10)).toBe("0xd9b81c3c"); // createPriceFeedUpdateData(...)
        const [id, price, conf, expo, emaPrice, emaConf, publishTime, prev] = decodeAbiParameters(ARGS, `0x${data.slice(10)}`);
        const update = encodeAbiParameters(FEED_DATA, [id, price, conf, expo, publishTime, emaPrice, emaConf, expo, publishTime, prev]);
        return encodeAbiParameters([{ type: "bytes" }], [update]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { state, transport };
}

const market = (legs: Hex[]): Market => ({
  address: `0x${"aa".repeat(20)}`, pairId: legs[0]!, baseFeedId: legs[0]!, legs, invertQuote: false, continuous: true,
  description: "", label: "", state: null, dirty: false, lastRead: 0,
});

describe("mock Hermes", () => {
  let chain: ReturnType<typeof fakeChain>;
  let mock: MockHermes;
  let srv: MockHermesServer;

  beforeEach(async () => {
    chain = fakeChain();
    mock = new MockHermes(chain.transport, PYTH, { [FEED]: 1850.5 }, { [FEED.slice(2)]: "Crypto.BTC/USD" });
    srv = await startMockHermes(mock, { port: 0 });
  });

  afterEach(async () => {
    await srv.close();
  });

  const get = async (path: string) => {
    const r = await fetch(srv.url + path);
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (path: string, body: string) => {
    const r = await fetch(srv.url + path, { method: "POST", body, headers: { "content-type": "application/json" } });
    return { status: r.status, body: (await r.json()) as any };
  };

  it("lists its feeds with their symbols, ETH/USD included", async () => {
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
    expect((await get("/v2/price_feeds")).body).toEqual([
      { id: FEED.slice(2), attributes: { symbol: "Crypto.BTC/USD" } },
      { id: ETH, attributes: { symbol: "Crypto.ETH/USD" } },
    ]);
    expect((await get("/mock/price")).body).toEqual({ [FEED.slice(2)]: 1850.5, [ETH]: 2000 });
  });

  it("builds each print with MockPyth at the chain's time", async () => {
    const { status, body } = await get(`/v2/updates/price/latest?ids[]=${FEED}&ids[]=0x${"cd".repeat(32)}`);
    expect(status).toBe(200);
    const t = chain.state.time;
    expect(body.parsed).toEqual([{
      id: FEED.slice(2),
      price: { price: "185050000000", conf: "18505000", expo: -8, publish_time: t },
      ema_price: { price: "185050000000", conf: "18505000", expo: -8, publish_time: t },
      metadata: { slot: t, proof_available_time: t, prev_publish_time: t - 1 },
    }]);
    expect(body.binary.encoding).toBe("hex");
    expect(body.binary.data).toHaveLength(1);
    const words = decodeAbiParameters(FEED_DATA, `0x${body.binary.data[0]}`);
    expect(words).toEqual([FEED, 185_050_000_000n, 18_505_000n, -8, BigInt(t), 185_050_000_000n, 18_505_000n, -8, BigInt(t), BigInt(t - 1)]);
    const hist = (await get(`/v2/updates/price/1234/?ids[]=${FEED.slice(2)}`)).body;
    expect(hist.parsed[0].price.publish_time).toBe(1234);
  });

  it("takes prices and pauses over HTTP, and pauses only the live routes", async () => {
    expect((await post("/mock/price", JSON.stringify({ id: FEED, price: "1900", paused: true }))).body).toEqual({ ok: true });
    expect(mock.prices.get(FEED)).toBe(1900);
    expect(mock.paused.has(FEED.slice(2))).toBe(true);
    expect((await get(`/v2/updates/price/latest?ids[]=${FEED}`)).body.parsed).toEqual([]);
    expect((await get(`/v2/updates/price/99?ids[]=${FEED}`)).body.parsed[0].price.price).toBe("190000000000");
    await post("/mock/price", JSON.stringify({ id: FEED.slice(2), price: 1901.25, paused: false }));
    expect((await get(`/v2/updates/price/latest?ids[]=${FEED}`)).body.parsed[0].price.price).toBe("190125000000");
    mock.paused.add(FEED); // in process, as the end-to-end test does
    expect((await get(`/v2/updates/price/latest?ids[]=${FEED}`)).body.parsed).toEqual([]);
  });

  it("answers bad requests and unknown routes", async () => {
    expect((await get("/v2/nothing")).status).toBe(404);
    expect((await post("/v2/nothing", "{}")).status).toBe(404);
    expect((await post("/mock/price", "{not json")).status).toBe(400);
    expect((await post("/mock/price", JSON.stringify({ id: FEED }))).status).toBe(400);
    const bad = await get(`/v2/updates/price/soon?ids[]=${FEED}`);
    expect(bad.status).toBe(500);
    expect(bad.body.error).toContain("soon");
  });

  it("takes prices only from a local client: JSON, a local Host, no foreign Origin", async () => {
    // Raw requests: fetch() would not let a test set Host.
    const send = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const body = JSON.stringify({ id: FEED, price: 1 });
        const req = request(
          { host: "127.0.0.1", port: srv.port, method: "POST", path: "/mock/price", headers: { "content-length": Buffer.byteLength(body), ...headers } },
          (res) => {
            let text = "";
            res.on("data", (c: Buffer) => (text += c.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const JSON_TYPE = { "content-type": "application/json" };
    const local = `127.0.0.1:${srv.port}`;
    // A form post, or text/plain: what a page can send cross-origin without a preflight.
    for (const type of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
      expect((await send({ host: local, "content-type": type })).status).toBe(415);
    }
    expect((await send({ host: local })).status).toBe(415);
    // DNS rebinding: the browser names the attacker's domain in Host.
    const rebound = await send({ host: `evil.example:${srv.port}`, ...JSON_TYPE });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error).toMatch(/Host header must be localhost or an IP address/);
    // A page on another origin.
    for (const origin of ["https://evil.example", "null", "http://192.168.1.10:3000"]) {
      expect((await send({ host: local, origin, ...JSON_TYPE })).status, origin).toBe(403);
    }
    expect(mock.prices.get(FEED)).toBe(1850.5); // none of them set a price
    for (const host of [local, `localhost:${srv.port}`, `[::1]:${srv.port}`, `10.0.0.5:${srv.port}`]) {
      expect((await send({ host, ...JSON_TYPE })).body, host).toEqual({ ok: true });
    }
    expect((await send({ host: local, origin: "http://localhost:5173", "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect(mock.prices.get(FEED)).toBe(1);
  });

  it("streams an event at once and one a second after, to the SDK's client", async () => {
    const client = new HermesClient(srv.url, "test-key");
    const got: [Hex, number][][] = [];
    for await (const prints of client.stream([FEED])) {
      got.push(prints.map((p) => [p.feedId, p.publishTime]));
      chain.state.time += 1;
      if (got.length === 2) break;
    }
    expect(got).toEqual([[[FEED, 1_700_000_000]], [[FEED, 1_700_000_001]]]);
    const latest = await client.latest([FEED]);
    expect(latest[0]!.price).toBe(185_050_000_000n);
  });

  it("drives a PriceService, and closes with its stream open", async () => {
    const svc = new PriceService(new HermesClient(srv.url), { clock: () => chain.state.time, logger: null });
    const m = market([FEED]);
    svc.watchMarkets([m]);
    const running = svc.run();
    const seen = new Set<Hex>();
    while (seen.size < 2) for (const f of await svc.nextPrints()) seen.add(f);
    expect(seen).toEqual(new Set([FEED, `0x${ETH}`]));
    const [upd] = svc.updateFor(m);
    expect(decodeAbiParameters(FEED_DATA, upd!)[0]).toBe(FEED); // the mock's one-feed update, passed through
    expect(svc.fresh(m)).toBe(true);
    const t0 = Date.now();
    await srv.close(); // ends the open stream; the service keeps trying
    svc.stop();
    await running;
    expect(Date.now() - t0).toBeLessThan(2_000);
    srv = await startMockHermes(mock, { port: 0 }); // for afterEach
  });
});
