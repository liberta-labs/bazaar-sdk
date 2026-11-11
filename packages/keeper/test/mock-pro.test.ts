/**
 * The mock Pyth Pro server, driven as the keeper drives the real one: through the SDK's client over
 * HTTP and a WebSocket, with the updates read back from their signed bytes.
 */

import { request } from "node:http";
import {
  AUTH_SUBPROTOCOL,
  ETH_USD_FEED,
  type Market,
  PriceService,
  ProClient,
  type ProClientOptions,
  ProError,
  type Transport,
  type WebSocketConstructor,
  feedIdHex,
  lazer,
} from "@liberta-labs/bazaar-sdk";
import { type Hex, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import { MockPro, type MockProServer, feedNumber, isLoopbackHost, listenRefusal, startMockPro } from "../src/devtools/mock-pro.js";

const BTC = 1;
const ETH = 2;
const EUR = 327;
const FEED = feedIdHex(BTC);
const SIGNER = privateKeyToAddress(lazer.localSignerKey());
const US = 1_000_000n;
const T0 = 1_700_000_000;
const WS = WebSocket as unknown as WebSocketConstructor;

const market = (legs: Hex[]): Market => ({
  address: `0x${"aa".repeat(20)}`, pairId: legs[0]!, baseFeedId: legs[0]!, legs, invertQuote: false, continuous: true,
  description: "", label: "", state: null, dirty: false, lastRead: 0,
});

describe("mock Pyth Pro", () => {
  /** the mock's clock, in seconds: a test moves it by hand */
  let now: number;
  let mock: MockPro;
  let srv: MockProServer;
  const clients: ProClient[] = [];

  beforeEach(async () => {
    now = T0 + 0.25;
    mock = new MockPro({ clock: () => now, prices: { [FEED]: 60_000.5, [EUR]: 1.08 }, symbols: { [BTC]: "Crypto.BTC/USD", "327": "FX.EUR/USD" } });
    srv = await startMockPro(mock, { port: 0 });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    await srv.close();
  });

  const client = (over: ProClientOptions = {}): ProClient => {
    const c = new ProClient({ restUrl: srv.url, symbolsUrl: srv.url, streamUrls: [srv.streamUrl], WebSocket: WS, ...over });
    clients.push(c);
    return c;
  };
  const get = async (path: string) => {
    const r = await fetch(srv.url + path);
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(srv.url + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const ask = { priceFeedIds: [BTC], properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"], formats: ["evm"], channel: "fixed_rate@200ms" };

  it("names feeds by number, decimal digits or bytes32, and serves ETH/USD unasked", async () => {
    expect([feedNumber(1), feedNumber("327"), feedNumber(FEED), feedNumber(2n)]).toEqual([1, 327, 1, 2]);
    expect(() => feedNumber(`0x${"ab".repeat(32)}`)).toThrow(); // a composite id is not a feed Pyth serves
    expect(() => feedNumber("btc")).toThrow();
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
    expect(srv.streamUrl).toBe(`ws://127.0.0.1:${srv.port}/v1/stream`);
    expect(mock.feeds()).toEqual([BTC, ETH, EUR]);
    expect((await get("/mock/price")).body).toEqual({ "1": 60_000.5, "2": 2000, "327": 1.08 });
    expect([mock.price(FEED), mock.price(ETH_USD_FEED), mock.price(9)]).toEqual([60_000.5, 2000, undefined]);
  });

  it("serves the symbols registry the SDK's client reads, with its two filters", async () => {
    const all = await client().symbols();
    expect(all.map((s) => [s.id, s.feedId, s.symbol, s.assetType, s.exponent])).toEqual([
      [BTC, FEED, "Crypto.BTC/USD", "crypto", -8],
      [ETH, ETH_USD_FEED, "Crypto.ETH/USD", "crypto", -8],
      [EUR, feedIdHex(EUR), "FX.EUR/USD", "fx", -8],
    ]);
    expect((await client().symbols({ query: "eur" })).map((s) => s.id)).toEqual([EUR]);
    expect((await client().symbols({ assetType: "crypto" })).map((s) => s.id)).toEqual([BTC, ETH]);
  });

  it("signs the latest update with the local key, stamped on the channel's interval at the clock's time", async () => {
    const u = (await client().latestUpdate([FEED, feedIdHex(999)]))!; // a feed it does not serve is left out
    const parsed = await lazer.parseUpdate(u.blob);
    expect(parsed.signer).toBe(SIGNER);
    expect(parsed.channel).toBe(3);
    expect(parsed.timestampUs).toBe(BigInt(T0) * US + 200_000n); // T0 + 0.25 s, on the 200 ms grid
    // The four properties the oracle reads: the price at exponent -8, a confidence of 0.1% of it, generated now.
    expect(parsed.feeds).toEqual([
      { id: BTC, included: lazer.LIVE_PROPERTIES, price: 6_000_050_000_000n, exponent: -8, confidence: 6_000_050_000n, feedUpdateTimestamp: parsed.timestampUs },
    ]);
    expect(u.prints).toEqual([expect.objectContaining({ feedId: FEED, price: 6_000_050_000_000n, conf: 6_000_050_000n, expo: -8, publishTime: T0, channel: 3 })]);
    // A signer check that asks for the local signer accepts it; any other refuses the update.
    expect((await client({ isTrustedSigner: (s) => s === SIGNER }).latest([FEED]))[0]!.signer).toBe(SIGNER);
    await expect(client({ isTrustedSigner: () => false }).latest([FEED])).rejects.toThrow(/not a signer Pyth's verifier trusts/);
    // The channel and the properties are the request's: the one-second channel, and only a price.
    const raw = await post("/v1/latest_price", { ...ask, channel: "fixed_rate@1000ms", properties: ["price"] });
    expect(raw.body.evm.encoding).toBe("hex");
    const only = lazer.readUpdate(`0x${raw.body.evm.data}`);
    expect([only.channel, only.timestampUs, only.feeds[0]!.included]).toEqual([4, BigInt(T0) * US, lazer.HAS_PRICE]);
    expect(raw.body.parsed).toEqual({
      timestampUs: String(BigInt(T0) * US),
      priceFeeds: [{ priceFeedId: BTC, price: "6000050000000", exponent: -8, confidence: 6_000_050_000, feedUpdateTimestamp: T0 * 1e6 }],
    });
    const b64 = await post("/v1/latest_price", { ...ask, jsonBinaryEncoding: "base64" });
    expect(`0x${Buffer.from(b64.body.evm.data, "base64").toString("hex")}`).toBe(u.blob);
  });

  it("a confidence is never zero unless a test asks for it, and a zero one makes no print", async () => {
    mock.setPrice(77, 0.000001); // 100 units of the mantissa: 0.1% of it rounds to nothing
    const tiny = (await client().latestUpdate([feedIdHex(77)]))!;
    expect(tiny.feeds.get(feedIdHex(77))).toMatchObject({ price: 100n, confidence: 1n });
    mock.setConfidence(FEED, 0);
    const none = (await client().latestUpdate([FEED]))!;
    expect(none.feeds.get(FEED)).toMatchObject({ price: 6_000_050_000_000n, confidence: 0n });
    expect(none.prints).toEqual([]); // the oracle refuses a live price without a confidence
    mock.setConfidence(FEED, 123n);
    expect((await client().latest([FEED]))[0]!.conf).toBe(123n);
    mock.setConfidence(FEED, null);
    expect((await client().latest([FEED]))[0]!.conf).toBe(6_000_050_000n);
    expect(new MockPro({ clock: () => now, prices: { [BTC]: 100 }, confidenceBp: 1 }).stateAt(BTC, 0n)).toMatchObject({ confidence: 1_000_000n });
  });

  it("archives the one-second channel: a live feed's tick is generated on it, a quiet feed's carries its last price", async () => {
    const pro = client();
    const live = (await pro.atTick([FEED], T0 - 3_600))!; // any past second: a starting price holds from the beginning
    expect([live.channel, live.timestampUs]).toEqual([4, BigInt(T0 - 3_600) * US]);
    expect(live.feeds.get(FEED)).toMatchObject({ price: 6_000_050_000_000n, feedUpdateTimestamp: BigInt(T0 - 3_600) * US });
    expect((await lazer.parseUpdate(live.blob)).signer).toBe(SIGNER);

    // The feed goes quiet at T0 + 10.5 at a new price, as a session closes; ETH/USD keeps printing.
    now = T0 + 10.5;
    mock.setPrice(FEED, 61_000);
    mock.pause(FEED);
    expect(mock.isPaused(FEED)).toBe(true);
    now = T0 + 100;
    const closedAt = BigInt(T0) * US + 10_500_000n;
    const tick = (await pro.atTick([FEED, ETH_USD_FEED], T0 + 60))!; // both asked together: one update
    expect(tick.feeds.get(FEED)).toMatchObject({ price: 6_100_000_000_000n, feedUpdateTimestamp: closedAt });
    expect(tick.feeds.get(ETH_USD_FEED)).toMatchObject({ price: 200_000_000_000n, feedUpdateTimestamp: BigInt(T0 + 60) * US });
    // Before it went quiet the archive still holds what it printed then.
    expect((await pro.atTick([FEED], T0 + 10))!.feeds.get(FEED)).toMatchObject({ price: 6_000_050_000_000n, feedUpdateTimestamp: BigInt(T0 + 10) * US });
    // The live channel carries the same price forward: an update per interval, no new print.
    const carried = (await pro.latestUpdate([FEED]))!;
    expect(carried.timestampUs).toBe(BigInt(T0 + 100) * US);
    expect(carried.prints).toEqual([expect.objectContaining({ publishTime: T0 + 10, generatedUs: closedAt, price: 6_100_000_000_000n })]);
    // Resumed, it generates a price with every update again.
    mock.resume(FEED);
    now = T0 + 101;
    expect((await pro.atTick([FEED], T0 + 101))!.feeds.get(FEED)).toMatchObject({ feedUpdateTimestamp: BigInt(T0 + 101) * US });
    expect((await pro.atTick([FEED], T0 + 99))!.feeds.get(FEED)).toMatchObject({ feedUpdateTimestamp: closedAt });
  });

  it("has no tick for a second that has not come, and none before a feed's first price", async () => {
    const pro = client();
    expect(await pro.atTick([FEED], T0 + 1)).toBeNull(); // the clock reads T0 + 0.25
    expect((await post("/v1/price", { ...ask, channel: "fixed_rate@1000ms", timestamp: (T0 + 1) * 1e6 })).status).toBe(404);
    now = T0 + 50;
    mock.setPrice(500, 12); // a feed listed now
    now = T0 + 60;
    const before = (await pro.atTick([feedIdHex(500)], T0 + 40))!;
    // What Pyth writes for a feed with no price yet: a zero price and no generation time.
    expect(before.feeds.get(feedIdHex(500))).toMatchObject({ price: 0n, confidence: 0n, feedUpdateTimestamp: 0n });
    expect((await pro.atTick([feedIdHex(500)], T0 + 55))!.feeds.get(feedIdHex(500))).toMatchObject({ price: 1_200_000_000n });
    // Only whole seconds of the one-second channel are archived.
    for (const bad of [{ channel: "fixed_rate@200ms", timestamp: T0 * 1e6 }, { channel: "fixed_rate@1000ms", timestamp: T0 * 1e6 + 5 }, { channel: "fixed_rate@1000ms", timestamp: String(T0 * 1e6) }]) {
      expect((await post("/v1/price", { ...ask, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("takes prices, pauses and confidences over HTTP", async () => {
    expect((await post("/mock/price", { id: FEED, price: "61000", paused: true })).body).toEqual({ ok: true });
    expect([mock.price(BTC), mock.isPaused(BTC)]).toEqual([61_000, true]);
    expect((await post("/mock/price", { id: 1, price: 61_500.25, paused: false, confidence: 0 })).status).toBe(200);
    expect([mock.price(BTC), mock.isPaused(BTC)]).toEqual([61_500.25, false]);
    expect(mock.stateAt(BTC, mock.nowUs())).toMatchObject({ price: 6_150_025_000_000n, confidence: 0n });
    expect((await post("/mock/price", { id: "1", price: 61_500.25, confidence: null })).status).toBe(200);
    expect(mock.stateAt(BTC, mock.nowUs())!.confidence).toBe(6_150_025_000n);
    for (const bad of [{ id: FEED }, { id: FEED, price: "soon" }, { id: FEED, price: -1 }, { price: 5 }, { id: `0x${"ab".repeat(32)}`, price: 5 }, { id: 1, price: 5, confidence: 1.5 }, [1, 2]]) {
      expect((await post("/mock/price", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post("/mock/price", "{not json")).status).toBe(400);
    expect(mock.price(BTC)).toBe(61_500.25); // none of them set a price
  });

  it("answers bad requests and unknown routes", async () => {
    expect((await get("/v2/updates/price/latest")).status).toBe(404);
    expect((await post("/v1/nothing", {})).status).toBe(404);
    for (const bad of [{}, { priceFeedIds: [] }, { ...ask, channel: "fast" }, { ...ask, formats: ["solana"] }, { ...ask, properties: "price" }]) {
      const r = await post("/v1/latest_price", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
    expect((await fetch(`${srv.url}/v1/latest_price`, { method: "PUT" })).status).toBe(501);
  });

  it("takes prices only from a local client: JSON, a local Host, no foreign Origin", async () => {
    // Raw requests: fetch() would not let a test set Host.
    const send = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const body = JSON.stringify({ id: BTC, price: 1 });
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
    // DNS rebinding: the browser names the attacker's domain in Host, a name under .localhost included
    // (a resolver that answers for one can point it anywhere).
    for (const host of [`evil.example:${srv.port}`, `evil.localhost:${srv.port}`]) {
      const rebound = await send({ host, ...JSON_TYPE });
      expect(rebound.status, host).toBe(403);
      expect(rebound.body.error).toMatch(/Host header must be localhost or an IP address/);
    }
    // A page on another origin.
    for (const origin of ["https://evil.example", "null", "http://192.168.1.10:3000", "http://app.localhost:5173"]) {
      expect((await send({ host: local, origin, ...JSON_TYPE })).status, origin).toBe(403);
    }
    expect(mock.price(BTC)).toBe(60_000.5); // none of them set a price
    for (const host of [local, `localhost:${srv.port}`, `[::1]:${srv.port}`, `10.0.0.5:${srv.port}`]) {
      expect((await send({ host, ...JSON_TYPE })).body, host).toEqual({ ok: true });
    }
    expect((await send({ host: local, origin: "http://localhost:5173", "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect(mock.price(BTC)).toBe(1);
  });

  it("opens the stream only for a local client: a local Host, no foreign Origin", async () => {
    const opens = (opts: ClientOptions) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(srv.streamUrl, opts);
        ws.once("open", () => {
          ws.terminate();
          resolve("open");
        });
        ws.once("error", (e) => resolve(e.message));
      });
    for (const host of [`evil.example:${srv.port}`, `evil.localhost:${srv.port}`]) {
      expect(await opens({ headers: { host } }), host).toBe("Unexpected server response: 403");
    }
    for (const origin of ["https://evil.example", "null", "http://app.localhost:5173"]) {
      expect(await opens({ origin }), origin).toBe("Unexpected server response: 403");
    }
    expect(await opens({})).toBe("open");
    expect(await opens({ origin: "http://localhost:5173", headers: { host: `localhost:${srv.port}` } })).toBe("open");
  });

  it("with a token, asks for it on the price controls too", async () => {
    mock.token = "made-up-mock-token";
    expect((await get("/mock/price")).status).toBe(401);
    const denied = await post("/mock/price", { id: BTC, price: 1 });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toMatch(/^authentication required/);
    expect(mock.price(BTC)).toBe(60_000.5);
    const auth = { authorization: "Bearer made-up-mock-token" };
    expect((await post("/mock/price", { id: BTC, price: 1 }, auth)).body).toEqual({ ok: true });
    expect(mock.price(BTC)).toBe(1);
    expect((await fetch(`${srv.url}/mock/price`, { headers: auth })).status).toBe(200);
    expect((await get("/v1/symbols")).status).toBe(200); // the registry needs none, as Pyth's
  });

  it("listens beyond this machine only with a token", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "app.localhost"]) {
      await expect(startMockPro(new MockPro({ clock: () => now }), { host, port: 0 }), host).rejects.toThrow(
        `not listening on ${host}: other machines may reach the mock there, and anyone who reaches it can set the prices a keeper acts on`,
      );
    }
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1"]) expect(listenRefusal(host, null), host).toBeNull();
    expect(listenRefusal("0.0.0.0", "made-up-mock-token")).toBeNull();
    expect(listenRefusal("0.0.0.0", "")).not.toBeNull();
    for (const name of ["localhost.", "app.localhost", "::ffff:127.0.0.1", "10.0.0.1"]) expect(isLoopbackHost(name), name).toBe(false);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("bounds what a client may ask: the feeds of an update, the subscriptions of a connection, the size of a message", async () => {
    const many = Array.from({ length: 256 }, (_, i) => i + 1);
    const tooMany = await post("/v1/latest_price", { ...ask, priceFeedIds: many });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe("'priceFeedIds' names 256 feeds, and one update carries at most 255");
    // A raw socket, as a client that ignores the limits would open it.
    const raw = new WebSocket(srv.streamUrl);
    const said: any[] = [];
    raw.on("message", (data) => said.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      raw.once("open", resolve);
      raw.once("error", reject);
    });
    const send = (msg: Record<string, unknown>) => raw.send(JSON.stringify(msg));
    const answer = async (subscriptionId: number, type: string) => {
      while (!said.some((m) => m.subscriptionId === subscriptionId && m.type === type)) await new Promise((r) => setTimeout(r, 5));
      return said.find((m) => m.subscriptionId === subscriptionId && m.type === type);
    };
    send({ type: "subscribe", subscriptionId: 1, ...ask, priceFeedIds: many });
    expect((await answer(1, "subscriptionError")).error).toBe("'priceFeedIds' names 256 feeds, and one update carries at most 255");
    for (let id = 2; id <= 256; id++) send({ type: "subscribe", subscriptionId: id, ...ask, channel: "fixed_rate@1000ms" });
    send({ type: "subscribe", subscriptionId: 257, ...ask });
    expect((await answer(257, "subscriptionError")).error).toBe("a connection holds at most 255 subscriptions: unsubscribe one first");
    expect(said.filter((m) => m.type === "subscribed")).toHaveLength(255);
    send({ type: "subscribe", subscriptionId: 2, ...ask }); // one it holds may be replaced
    send({ type: "unsubscribe", subscriptionId: 3 });
    await answer(3, "unsubscribed");
    said.length = 0;
    send({ type: "subscribe", subscriptionId: 257, ...ask });
    await answer(257, "subscribed");
    // A message above 1 MiB closes the connection rather than being read.
    const closed = new Promise<number>((resolve) => raw.once("close", (code) => resolve(code)));
    raw.send(JSON.stringify({ type: "subscribe", subscriptionId: 258, pad: "x".repeat(1024 * 1024) }));
    expect([1006, 1009]).toContain(await closed);
    expect(said.some((m) => m.subscriptionId === 258)).toBe(false);
  });

  it("streams each subscription its own updates: one at once, then one per interval the clock has moved past", async () => {
    const got: { feeds: Hex[]; at: bigint; signer: string | null }[] = [];
    const pro = client({ isTrustedSigner: (s) => s === SIGNER });
    // Two sets, as a keeper subscribes: a composite's two legs together, and ETH/USD on its own.
    for await (const prints of pro.stream([[FEED, feedIdHex(EUR)], [ETH_USD_FEED]])) {
      // One batch holds every update taken since the last: grouped here by the update that carried each print.
      for (const blob of new Set(prints.map((p) => p.blob))) {
        const mine = prints.filter((p) => p.blob === blob);
        got.push({ feeds: mine.map((p) => p.feedId), at: mine[0]!.timestampUs, signer: mine[0]!.signer });
      }
      if (got.length === 2) now += 1; // the clock moves: the next interval's updates follow
      if (got.length >= 4) break;
    }
    const first = BigInt(T0) * US + 200_000n;
    const sort = (xs: typeof got) => xs.map((x) => `${x.feeds.join("+")}@${x.at}`).sort();
    expect(sort(got.slice(0, 2))).toEqual(sort([{ feeds: [FEED, feedIdHex(EUR)], at: first, signer: SIGNER }, { feeds: [ETH_USD_FEED], at: first, signer: SIGNER }]));
    expect(sort(got.slice(2, 4))).toEqual(sort([{ feeds: [FEED, feedIdHex(EUR)], at: first + US, signer: SIGNER }, { feeds: [ETH_USD_FEED], at: first + US, signer: SIGNER }]));
    expect(got.every((g) => g.signer === SIGNER)).toBe(true);
  });

  it("tells a subscription which feeds it left out, and refuses one with none it serves", async () => {
    const notices: string[] = [];
    const pro = client();
    for await (const prints of pro.stream([[FEED, feedIdHex(999)], [feedIdHex(998)]], undefined, { onNotice: (m) => notices.push(m) })) {
      expect(prints.map((p) => p.feedId)).toEqual([FEED]);
      break;
    }
    expect(notices.some((n) => /left out feeds it does not serve/.test(n) && n.includes("999"))).toBe(true);
    expect(notices.some((n) => /refused the subscription for feed\(s\) 998/.test(n))).toBe(true);
  });

  it("asks for its token when it has one, by header or by subprotocol, on the request API and the stream", async () => {
    mock.token = "made-up-mock-token";
    const firstBatch = async (pro: ProClient) => {
      for await (const prints of pro.stream([[FEED]], undefined, { idleTimeout: 2 })) return prints.length;
      return 0;
    };
    // No token, or another one: refused.
    await expect(client().latest([FEED])).rejects.toThrow(/refused the request \(HTTP 401\); check the token \(prices\.token\)/);
    await expect(client({ token: "another-made-up-token" }).latest([FEED])).rejects.toThrow(ProError);
    await expect(firstBatch(client({ token: "another-made-up-token" }))).rejects.toThrow(/price stream unreachable/);
    await expect(firstBatch(client({ token: "another-made-up-token", streamAuth: "subprotocol" }))).rejects.toThrow(/price stream unreachable/);
    // The registry needs none, as Pyth's.
    expect((await client().symbols()).length).toBe(3);
    // The token as an Authorization header (what a keeper sends), and through the subprotocol list (a browser's way).
    const byHeader = client({ token: "made-up-mock-token" });
    expect((await byHeader.latest([FEED])).length).toBe(1);
    expect(await firstBatch(byHeader)).toBe(1);
    expect(await firstBatch(client({ token: "made-up-mock-token", streamAuth: "subprotocol" }))).toBe(1);
    // A raw socket: the server answers the auth subprotocol, which a browser requires of a server it offered one to.
    const raw = new WebSocket(srv.streamUrl, [AUTH_SUBPROTOCOL, "made-up-mock-token"]);
    await new Promise<void>((resolve, reject) => {
      raw.once("open", resolve);
      raw.once("error", reject);
    });
    expect(raw.protocol).toBe(AUTH_SUBPROTOCOL);
    raw.terminate();
  });

  it("drives a PriceService, and closes with its stream open", async () => {
    const svc = new PriceService(client(), { clock: () => Math.floor(now), logger: null });
    const m = market([FEED]);
    svc.watchMarkets([m]);
    const running = svc.run();
    const seen = new Set<Hex>();
    while (seen.size < 2) for (const f of await svc.nextPrints()) seen.add(f);
    expect(seen).toEqual(new Set([FEED, ETH_USD_FEED]));
    const [upd] = svc.updateFor(m);
    // The market's own update: its one feed, signed for the local verifier.
    const parsed = await lazer.parseUpdate(upd!);
    expect([parsed.signer, parsed.feeds.map((f) => f.id)]).toEqual([SIGNER, [BTC]]);
    expect(svc.fresh(m)).toBe(true);
    expect(svc.ethUsd()).toBe(2000);
    const t0 = Date.now();
    await srv.close(); // ends the open stream; the service keeps trying
    svc.stop();
    await running;
    expect(Date.now() - t0).toBeLessThan(2_000);
    srv = await startMockPro(mock, { port: 0 }); // for afterEach
  });

  it("follows a local chain's clock: the latest block's time plus the time since it was seen, through a warp", async () => {
    const chain = { number: 16, time: T0 + 5_000 };
    const transport: Transport = {
      async request({ method }) {
        if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
        return { number: toHex(chain.number), timestamp: toHex(chain.time), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, baseFeePerGas: "0x1" };
      },
    };
    const onChain = new MockPro({ rpc: transport, prices: { [BTC]: 100 } });
    expect(onChain.nowUs()).toBe(0n); // nothing is known before the chain is asked
    const u = await onChain.latest([BTC], "fixed_rate@1000ms");
    expect(u.timestampUs).toBe(BigInt(chain.time) * US);
    expect(await onChain.tick([BTC], chain.time + 2)).toBeNull(); // not a second the chain has reached
    // The chain warps two days ahead and mines: the very next request's update is stamped there,
    // however recently the chain was asked.
    chain.number += 1;
    chain.time += 172_800;
    const warped = await onChain.latest([BTC], "fixed_rate@1000ms");
    expect(warped.timestampUs).toBe(BigInt(chain.time) * US);
    expect((await onChain.tick([BTC], chain.time))!.feeds[0]).toMatchObject({ price: 10_000_000_000n, generatedUs: BigInt(chain.time) * US });
    // The stream may go by an answer from the last moments: there a warp shows on its next interval.
    chain.number += 1;
    chain.time += 60;
    await onChain.sync(true);
    expect(onChain.nowUs() / US).toBe(BigInt(chain.time - 60));
    await onChain.sync();
    expect(onChain.nowUs() / US).toBe(BigInt(chain.time));
    // Between blocks the clock runs on from the block it last saw.
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await onChain.latest([BTC], "fixed_rate@1000ms")).timestampUs).toBe(BigInt(chain.time + 1) * US);
  });
});
