import type { Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICE_ENDPOINTS, PYTH_PRO, PYTH_PRO_TOKEN_URL, isPythProPriceEndpoint } from "../src/networks.js";
import { MAX_RESPONSE_BYTES, MAX_STREAM_MESSAGE, PRO_PROPERTIES, type Print, ProClient, ProError, STREAM_IDLE_TIMEOUT, cachedToken, isLivePrint, mintProToken, whyNotLive } from "../src/prices/index.js";
import { FakeSocket, SIGNER, evm, fakeFetch, fid, json, settle, signed, streamUpdated, tick, unsigned } from "./pro-fakes.js";
import { MAX_STRAY_MESSAGES, MAX_UPDATE_AHEAD, PriceService, UNKNOWN_EXPIRY_LIFETIME } from "../src/prices/index.js";
import { MAX_UPDATE_BYTES } from "../src/prices/lazer.js";
import { Chain } from "../src/chain/client.js";
import type { JsonRpc } from "../src/chain/rpc.js";
import { InputError } from "../src/client/calls.js";
import { proPriceSource } from "../src/client/prices.js";
import { errorMessage } from "../src/errors/messages.js";
import { SubgraphClient } from "../src/subgraph/client.js";

const [F1, F2, F3] = [fid(1), fid(2), fid(3)];
const A = "wss://pro-0.test/v1/stream";
const B = "wss://pro-1.test/v1/stream";
const C = "wss://pro-2.test/v1/stream";
const OTHER_KEY: Hex = `0x${"11".repeat(32)}`;
const TOKEN = "tok_live_SECRET1234";
/** A request API that is not Pyth's: with stream URLs of its own, a client for it needs no token. */
const REST = "https://pro.test";

beforeEach(() => FakeSocket.reset());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ProClient requests", () => {
  it("defaults to Pyth's endpoints, the 200 ms channel and no signer check", () => {
    const c = new ProClient({ token: TOKEN });
    expect(c.streamUrls).toEqual(PYTH_PRO.streamUrls);
    expect(c.streamUrls).toHaveLength(3);
    expect(c.restUrl).toBe("https://pyth-lazer.dourolabs.app");
    expect(c.symbolsUrl).toBe("https://pyth.dourolabs.app");
    expect(c.channel).toBe("fixed_rate@200ms");
    expect(c.isTrustedSigner).toBeNull();
    expect(c.streamAuth).toBe("header"); // no document here
    expect(new ProClient({ token: TOKEN, restUrl: "https://proxy.test/pro///" }).restUrl).toBe("https://proxy.test/pro");
    expect(() => new ProClient({ restUrl: "pyth" })).toThrow("the price request URL is not an http(s) or ws(s) URL");
    expect(() => new ProClient({ channel: "fixed_rate@10ms" as never })).toThrow("unknown Pyth Pro channel");
    vi.stubGlobal("document", {});
    expect(new ProClient({ token: TOKEN }).streamAuth).toBe("subprotocol"); // a browser cannot set WebSocket headers
  });

  it("asks for a Pyth Pro API key for Pyth's own endpoints, and lets a custom endpoint run without one", () => {
    const refusal = (opts?: ConstructorParameters<typeof ProClient>[0]): InputError => {
      try {
        new ProClient(opts);
      } catch (e) {
        if (e instanceof InputError) return e;
        throw e;
      }
      throw new Error("expected an InputError");
    };
    const e = refusal();
    expect(e.field).toBe("prices.token");
    expect(e.message).toBe(
      "prices.token: Pyth's own price endpoints serve only the holder of a Pyth Pro API key. On a server, give the key as the token (an Authorization header among the headers does not count); in a browser, give a function returning short-lived tokens your backend mints from the key (mintProToken), never the key itself. Without a token, the request API (restUrl) and every stream endpoint (streamUrls) must be custom ones, such as a proxy that adds the key or a local mock: both default to Pyth's.",
    );
    expect(errorMessage(e)).toBe(e.message);
    // Pyth's request API, or any one of its stream endpoints, however written, needs the key
    for (const opts of [
      { token: null },
      { streamUrls: [A] },
      { restUrl: REST },
      { restUrl: REST, streamUrls: [A, PYTH_PRO.streamUrls[2]!] },
      { restUrl: "HTTPS://PYTH-LAZER.DOUROLABS.APP/", streamUrls: [A] },
      { headers: { "x-proxy": "proxy-header-value" }, restUrl: REST },
      { restUrl: "https://pyth-lazer.dourolabs.app.", streamUrls: [A] },
      { restUrl: REST, streamUrls: ["wss://pyth-lazer-0.dourolabs.app./v1/stream"] },
    ]) {
      expect(refusal(opts).field).toBe("prices.token");
    }
    // the key goes in the token: an Authorization header of one's own is not taken for it
    expect(refusal({ headers: { Authorization: "Bearer fake-pyth-pro-key" } }).field).toBe("prices.token");
    // a token, or endpoints of one's own, and it is made
    expect(() => new ProClient({ token: () => "jwt-test-token" })).not.toThrow();
    expect(() => new ProClient({ restUrl: REST, streamUrls: [A] })).not.toThrow();
    // the symbols registry needs no key, so Pyth's own registry is no reason to ask for one
    expect(() => new ProClient({ restUrl: REST, streamUrls: [A], symbolsUrl: PYTH_PRO.symbolsUrl })).not.toThrow();
    // what is wrong with an endpoint is reported first
    expect(() => new ProClient({ restUrl: "pyth" })).toThrow(new ProError("the price request URL is not an http(s) or ws(s) URL"));
    // and the facade's options and a source built from options are held to it as well
    expect(() => proPriceSource({})).toThrow(InputError);
    expect(() => proPriceSource({ restUrl: REST, streamUrls: [A] })).not.toThrow();
    // Pyth's own price endpoints are its request API's host and its stream endpoints' hosts
    expect([PYTH_PRO.restUrl, ...PYTH_PRO.streamUrls, "https://pyth-lazer-1.dourolabs.app/v1/latest_price"].map(isPythProPriceEndpoint)).toEqual([true, true, true, true, true]);
    expect([PYTH_PRO.symbolsUrl, PYTH_PRO_TOKEN_URL, REST, A, "https://pyth-lazer.dourolabs.app.example", "not a url"].map(isPythProPriceEndpoint)).toEqual([false, false, false, false, false, false]);
    // a host written with a trailing dot, however encoded, is the same host
    expect(
      ["https://pyth-lazer.dourolabs.app.", "https://pyth-lazer.dourolabs.app.:443/", "https://pyth-lazer.dourolabs.app%2E/", "wss://pyth-lazer-0.dourolabs.app./v1/stream"].map(isPythProPriceEndpoint),
    ).toEqual([true, true, true, true]);
    // the only endpoint shortcut is Pyth's own: there is no shared endpoint that needs no key
    expect(PRICE_ENDPOINTS).toEqual({ pyth: PYTH_PRO });
  });

  it("asks for the four properties in the EVM format, with the token as a bearer, and reads the signed bytes only", async () => {
    const blob = unsigned({ at: 100, feeds: [{ id: 1, price: 5_000_000_000_000n, conf: 7n }, { id: 2 }] });
    // the JSON beside the update says something else entirely: it is never read
    const lying = { parsed: { timestampUs: "1", priceFeeds: [{ priceFeedId: 1, price: "1", exponent: 0, confidence: 1, feedUpdateTimestamp: 1 }] }, evm: { encoding: "hex", data: blob } };
    const { fetch, calls } = fakeFetch(() => json(lying));
    const c = new ProClient({ token: TOKEN, headers: { "x-extra": "1" }, restUrl: "https://pro.test/", fetch });
    const prints = await c.latest([F2, F1, F1.toUpperCase().replace("0X", "0x") as Hex]);
    expect(prints.map((p) => [p.feedId, p.price, p.conf, p.expo, p.publishTime, p.generatedUs, p.timestampUs, p.channel, p.signer, p.blob])).toEqual([
      [F1, 5_000_000_000_000n, 7n, -8, 100, 100_000_000n, 100_000_000n, 3, null, blob],
      [F2, 200_000_000_000n, 1_000n, -8, 100, 100_000_000n, 100_000_000n, 3, null, blob],
    ]);
    const { url, method, headers, body } = calls[0]!;
    expect(method).toBe("POST");
    expect(url.href).toBe("https://pro.test/v1/latest_price");
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-extra")).toBe("1");
    // Only fields Pyth's REST API reads: it has no ignoreInvalidFeeds and no deliveryFormat.
    expect(body).toEqual({
      priceFeedIds: [1, 2],
      properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"],
      formats: ["evm"],
      channel: "fixed_rate@200ms",
      jsonBinaryEncoding: "hex",
      parsed: false,
    });
    expect(PRO_PROPERTIES).toEqual(body.properties);
  });

  it("accepts update data with or without 0x, and in base64", async () => {
    const blob = unsigned({ at: 100, feeds: [{ id: 1 }] });
    const b64 = btoa(String.fromCharCode(...(blob.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16))));
    for (const evmField of [{ encoding: "hex", data: blob }, { encoding: "hex", data: blob.slice(2) }, { encoding: "base64", data: b64 }, blob, { data: blob.toUpperCase().replace("0X", "0x") }]) {
      const { fetch } = fakeFetch(() => json({ evm: evmField }));
      const prints = await new ProClient({ token: TOKEN, fetch }).latest([F1]);
      expect(prints.map((p) => [p.feedId, p.blob])).toEqual([[F1, blob]]);
    }
    for (const bad of [{ data: "zz" }, { data: 12 }, { encoding: "base64", data: "***" }, { encoding: "hex" }]) {
      const { fetch } = fakeFetch(() => json({ evm: bad }));
      await expect(new ProClient({ token: TOKEN, fetch }).latest([F1])).rejects.toThrow(ProError);
    }
    // an answer without update data brings no print
    const { fetch } = fakeFetch(() => json({ parsed: {} }));
    expect(await new ProClient({ token: TOKEN, fetch }).latest([F1])).toEqual([]);
  });

  it("returns only the feeds asked for, leaves out ids that are not raw, and asks nothing when none is", async () => {
    const blob = unsigned({ at: 100, feeds: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const { fetch, calls } = fakeFetch(() => json(evm(blob)));
    const c = new ProClient({ token: TOKEN, fetch });
    const composite: Hex = `0x${"ab".repeat(32)}`;
    expect((await c.latest([F3, composite])).map((p) => p.feedId)).toEqual([F3]);
    expect(calls[0]!.body.priceFeedIds).toEqual([3]);
    expect(await c.latest([composite, `0x${"00".repeat(32)}`])).toEqual([]);
    expect(await c.latestUpdate([])).toBeNull();
    expect(calls).toHaveLength(1);
    // both legs of a composite asked for together come in one update
    const u = (await c.latestUpdate([F2, F1]))!;
    expect(calls[1]!.body.priceFeedIds).toEqual([1, 2]);
    expect(new Set(u.prints.map((p) => p.blob))).toEqual(new Set([blob]));
    expect([...u.feeds.keys()]).toEqual([F1, F2, F3]);
  });

  it("gives a print only to a feed with a usable live price", async () => {
    const at = 10_000;
    const blob = unsigned({
      at,
      feeds: [
        { id: 1 }, // usable
        { id: 2, price: 0n }, // no price
        { id: 3, omit: ["exponent"] },
        { id: 4, omit: ["confidence"] },
        { id: 5, omit: ["feedUpdateTimestamp"] },
        { id: 6, generated: 0 }, // never priced: the timestamp property is there, unset
        { id: 7, conf: 0n }, // the oracle refuses a live price without a confidence
        { id: 8, expo: 60 }, // more than 77 places from BAZAAR precision: the oracle's scale overflows
        { id: 9, price: -5n }, // below zero: the oracle refuses it
        { id: 10, generated: at - 3_600 }, // carried forward for an hour: a print, an hour old
        { id: 11, expo: -40 }, // 22 places below: the price truncates to zero at BAZAAR precision
        { id: 12, price: 10n ** 18n, expo: 50 }, // 68 places above: the scaled price overflows int256
        { id: 13, price: 1n, conf: 2n ** 64n - 1n, expo: 40 }, // the scaled price fits, the scaled confidence does not
      ],
    });
    const { fetch } = fakeFetch(() => json(evm(blob)));
    const ids = Array.from({ length: 13 }, (_, i) => fid(i + 1));
    const u = (await new ProClient({ token: TOKEN, fetch }).latestUpdate(ids))!;
    expect(u.prints.map((p) => [p.feedId, p.publishTime])).toEqual([
      [fid(1), at],
      [fid(10), at - 3_600],
    ]);
    expect(u.feeds.size).toBe(13); // every feed is still there to be read
    expect(isLivePrint(u.feeds.get(fid(7))!)).toBe(false);
    expect(isLivePrint(u.feeds.get(fid(10))!)).toBe(true);
    // and each unusable one can say why
    expect(ids.map((id) => whyNotLive(u.feeds.get(id)!))).toEqual([
      null,
      "Pyth has no price for it at the update's time",
      "the update was requested without its exponent",
      "the update was requested without its confidence",
      "the update was requested without its feedUpdateTimestamp",
      "the update does not say when its price was generated",
      "Pyth reports no confidence for it, and the oracle refuses a live price without one",
      "at exponent 60 its price is not above zero (or overflows) at the oracle's 18 decimals",
      "its price -5 is below zero, and the oracle refuses a price at or below zero",
      null,
      "at exponent -40 its price is not above zero (or overflows) at the oracle's 18 decimals",
      "at exponent 50 its price is not above zero (or overflows) at the oracle's 18 decimals",
      "at exponent 40 its confidence overflows at the oracle's 18 decimals",
    ]);
    expect(u.prints[1]!.timestampUs).toBe(BigInt(at) * 1_000_000n); // the update's instant, not the price's
  });

  it("fetches the one-second update stamped on a second, and refuses any other", async () => {
    const good = tick(1_700_000_000, [{ id: 1, generated: 1_699_999_990 }, { id: 2, price: 0n, generated: 0 }]);
    const { fetch, calls } = fakeFetch((url) => (url.pathname === "/v1/price" ? json(evm(good)) : new Response("?", { status: 500 })));
    const c = new ProClient({ token: TOKEN, channel: "real_time", fetch });
    const u = (await c.atTick([F2, F1], 1_700_000_000))!;
    expect(calls[0]!.body).toMatchObject({ priceFeedIds: [1, 2], channel: "fixed_rate@1000ms", timestamp: 1_700_000_000_000_000, formats: ["evm"] });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect([u.blob, u.channel, u.timestampUs]).toEqual([good, 4, 1_700_000_000_000_000n]);
    expect(u.prints.map((p) => [p.feedId, p.publishTime])).toEqual([[F1, 1_699_999_990]]); // a carried-forward price
    expect(u.feeds.get(F2)).toMatchObject({ price: 0n, feedUpdateTimestamp: 0n }); // no price: no print, but the proof is there
    // the endpoint answering another second, or another channel, is refused
    await expect(c.atTick([F1], 1_700_000_001)).rejects.toThrow("answered the one-second tick at 1700000001 with another update");
    const wrongChannel = unsigned({ at: 1_700_000_000, channel: "fixed_rate@200ms", feeds: [{ id: 1 }] });
    const c2 = new ProClient({ token: TOKEN, fetch: fakeFetch(() => json(evm(wrongChannel))).fetch });
    await expect(c2.atTick([F1], 1_700_000_000)).rejects.toThrow(ProError);
    // no update for that second: a 404, or an answer without data
    expect(await new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response("none", { status: 404 })).fetch }).atTick([F1], 5)).toBeNull();
    expect(await new ProClient({ token: TOKEN, fetch: fakeFetch(() => json({})).fetch }).atTick([F1], 5)).toBeNull();
    await expect(new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response("down", { status: 503 })).fetch }).atTick([F1], 5)).rejects.toThrow("HTTP 503");
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) await expect(c.atTick([F1], bad)).rejects.toThrow("is not a unix time in whole seconds");
    expect(await c.atTick([`0x${"ab".repeat(32)}`], 5)).toBeNull();
  });

  it("refuses a token or header a request cannot carry, and never prints the token", async () => {
    for (const bad of [`${TOKEN}\u0000x`, `${TOKEN}\r\n`]) {
      let err: unknown;
      try {
        new ProClient({ token: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProError);
      expect(String((err as Error).message)).not.toContain("SECRET");
      expect(String((err as Error).message)).toContain("prices.token");
    }
    expect(() => new ProClient({ token: null, restUrl: REST, streamUrls: [A] })).not.toThrow(); // no token at all, for endpoints that need none
    for (const empty of ["", "   "]) expect(() => new ProClient({ token: empty })).toThrow("the price token is empty: set it (prices.token)");
    expect(() => new ProClient({ headers: { "bad name": "x" } })).toThrow("is not a valid HTTP header name");
    let err: Error | null = null;
    try {
      new ProClient({ headers: { "x-key": "hunter2hunter2\n" } });
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toContain("price endpoint header x-key has a value a request header cannot carry");
    expect(err!.message).not.toContain("hunter2");
  });

  it("explains refusals and failures without the token, a header secret or a key in the URL", async () => {
    const keyed = "https://pro.test/7f6e5d4c3b2a19087f6e5d4c3b2a1908";
    const mk = (r: () => Response | Promise<Response>) => new ProClient({ token: TOKEN, headers: { "x-key": "hunter2hunter2" }, restUrl: keyed, fetch: fakeFetch(r).fetch });
    const failing = mk(() => {
      throw new TypeError(`fetch failed for ${keyed}/v1/latest_price with ${TOKEN} and hunter2hunter2`);
    });
    const e1 = (await failing.latest([F1]).catch((e) => e)) as Error;
    expect(e1).toBeInstanceOf(ProError);
    expect(e1.message).toBe("price endpoint unreachable: fetch failed for https://pro.test/***/v1/latest_price with *** and ***");
    const e2 = (await mk(() => new Response("nope", { status: 401 })).latest([F1]).catch((e) => e)) as ProError;
    // the endpoint's answer is withheld here: the URL itself holds a key the endpoint might echo
    expect([e2.message, e2.status]).toEqual(["price endpoint refused the request (HTTP 401); check the token (prices.token) and that it covers these feeds and this channel. The endpoint said: (response withheld: the endpoint URL holds a key)", 401]);
    // what Pyth says on a refusal names the cause, and is quoted with the token masked
    const e2b = (await new ProClient({ token: TOKEN, restUrl: "https://pro.test", fetch: fakeFetch(() => new Response(`Not entitled: feed 3925 (asked by ${TOKEN})`, { status: 403 })).fetch }).latest([F1]).catch((e) => e)) as ProError;
    expect([e2b.message, e2b.status]).toEqual(["price endpoint refused the request (HTTP 403); check the token (prices.token) and that it covers these feeds and this channel. The endpoint said: Not entitled: feed 3925 (asked by ***)", 403]);
    // an empty refusal adds nothing
    const e2c = (await mk(() => new Response("", { status: 403 })).latest([F1]).catch((e) => e)) as ProError;
    expect(e2c.message).toBe("price endpoint refused the request (HTTP 403); check the token (prices.token) and that it covers these feeds and this channel");
    // the body of an error is withheld when the URL itself holds a key the endpoint might echo
    const e3 = (await mk(() => new Response(`bad key ${keyed}`, { status: 500 })).latest([F1]).catch((e) => e)) as Error;
    expect(e3.message).toBe("price endpoint returned HTTP 500: (response withheld: the endpoint URL holds a key)");
    const plain = new ProClient({ token: TOKEN, restUrl: "https://pro.test", fetch: fakeFetch(() => new Response(`no such feed for ${TOKEN}`, { status: 400 })).fetch });
    expect(((await plain.latest([F1]).catch((e) => e)) as Error).message).toBe("price endpoint returned HTTP 400: no such feed for ***");
    const notJson = new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response("<html>")).fetch });
    await expect(notJson.latest([F1])).rejects.toThrow("price endpoint returned a body that is not JSON: <html>");
    expect(mk(() => json({})).displayUrl).toBe("https://pro.test/***");
  });

  it("refuses a response body over 16 MiB, declared or streamed", async () => {
    expect(MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
    const declared = new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })).fetch });
    await expect(declared.latest([F1])).rejects.toThrow("price endpoint's response is larger than 16 MiB: refusing it");
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        c.enqueue(chunk);
      },
    });
    const streamed = new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response(endless)).fetch });
    await expect(streamed.latest([F1])).rejects.toThrow("larger than 16 MiB");
    expect(sent).toBeLessThan(20); // stopped reading soon after the limit
  });

  it("calls a token provider for each request, and masks every token it has handed over", async () => {
    let n = 0;
    const seen: (string | null)[] = [];
    const { fetch } = fakeFetch((_, init) => {
      const auth = new Headers(init.headers).get("authorization");
      seen.push(auth);
      if (seen.length === 3) throw new Error(`refused ${auth} (earlier jwt-AAAAAAAA-1)`);
      return json(evm(unsigned({ at: 100, feeds: [{ id: 1 }] })));
    });
    const c = new ProClient({ token: async () => `jwt-AAAAAAAA-${++n}`, fetch });
    await c.latest([F1]);
    await c.latest([F1]);
    expect(seen).toEqual(["Bearer jwt-AAAAAAAA-1", "Bearer jwt-AAAAAAAA-2"]);
    expect(((await c.latest([F1]).catch((e) => e)) as Error).message).toBe("price endpoint unreachable: refused Bearer *** (earlier ***)");
    const failing = new ProClient({
      token: () => {
        throw new Error("backend said no");
      },
      fetch,
    });
    await expect(failing.latest([F1])).rejects.toThrow("the price token provider failed: backend said no");
    await expect(new ProClient({ token: () => "", fetch }).latest([F1])).rejects.toThrow("the price token is empty");
  });

  it("checks each update's signer when asked to, and refuses one that is not trusted", async () => {
    const good = await signed({ at: 100, feeds: [{ id: 1 }] });
    const forged = await signed({ at: 100, feeds: [{ id: 1, price: 1n }] }, OTHER_KEY);
    const asked: string[] = [];
    const check = (s: string) => {
      asked.push(s);
      return s === SIGNER;
    };
    const c = new ProClient({ token: TOKEN, isTrustedSigner: check, fetch: fakeFetch(() => json(evm(good))).fetch });
    expect((await c.latest([F1])).map((p) => p.signer)).toEqual([SIGNER]);
    const bad = new ProClient({ token: TOKEN, isTrustedSigner: check, fetch: fakeFetch(() => json(evm(forged))).fetch });
    await expect(bad.latest([F1])).rejects.toThrow(`a price update is signed by ${privateKeyToAddress(OTHER_KEY)}, which is not a signer Pyth's verifier trusts: refusing it`);
    await expect(bad.atTick([F1], 100)).rejects.toThrow("refusing it");
    expect(asked).toEqual([SIGNER, privateKeyToAddress(OTHER_KEY), privateKeyToAddress(OTHER_KEY)]);
    // a check that cannot answer leaves the update unused: unconfirmed is not trusted
    const down = new ProClient({
      token: TOKEN,
      isTrustedSigner: () => {
        throw new Error("rpc down");
      },
      fetch: fakeFetch(() => json(evm(good))).fetch,
    });
    await expect(down.latest([F1])).rejects.toThrow("could not confirm that Pyth trusts the signer of a price update: rpc down");
    // a signature that recovers to nothing, and bytes that are no update at all
    const broken = `${good.slice(0, 138)}05${good.slice(140)}` as Hex;
    await expect(new ProClient({ token: TOKEN, isTrustedSigner: check, fetch: fakeFetch(() => json(evm(broken))).fetch }).latest([F1])).rejects.toThrow("price endpoint sent an update the SDK cannot read");
    await expect(new ProClient({ token: TOKEN, fetch: fakeFetch(() => json(evm("0xdeadbeef"))).fetch }).latest([F1])).rejects.toThrow("price endpoint sent an update the SDK cannot read (malformed Pyth Pro update: shorter than an envelope): refusing it");
  });

  it("lists the symbols registry without credentials", async () => {
    const entries = [
      { pyth_lazer_id: 1, symbol: "Crypto.BTC/USD", name: "BTCUSD", description: "BITCOIN / US DOLLAR", asset_type: "crypto", min_channel: "real_time", state: "stable", schedule: "America/New_York;O,O,O,O,O,O,O;", exponent: -8, hermes_id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
      { pyth_lazer_id: "1304", symbol: "Equity.US.NFLX/USD", asset_type: "equity", min_channel: "fixed_rate@200ms", state: "stable" },
      { pyth_lazer_id: 0, symbol: "zero" },
      { pyth_lazer_id: 4_294_967_296, symbol: "too big" },
      { symbol: "no id" },
      null,
    ];
    const { fetch, calls } = fakeFetch(() => json(entries));
    const c = new ProClient({ token: TOKEN, headers: { "x-key": "hunter2hunter2" }, symbolsUrl: "https://symbols.test", fetch });
    const list = await c.symbols({ query: "BTC", assetType: "crypto" });
    expect(calls[0]!.url.href).toBe("https://symbols.test/v1/symbols?query=BTC&asset_type=crypto");
    expect(calls[0]!.method).toBe("GET");
    expect([...calls[0]!.headers.keys()]).toEqual([]); // no token, no proxy header: another host, public data
    expect(list).toEqual([
      { id: 1, feedId: F1, symbol: "Crypto.BTC/USD", name: "BTCUSD", description: "BITCOIN / US DOLLAR", assetType: "crypto", minChannel: "real_time", state: "stable", schedule: "America/New_York;O,O,O,O,O,O,O;", exponent: -8, hermesId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
      { id: 1304, feedId: fid(1304), symbol: "Equity.US.NFLX/USD", name: "", description: "", assetType: "equity", minChannel: "fixed_rate@200ms", state: "stable", schedule: "", exponent: null, hermesId: null },
    ]);
    await c.symbols();
    expect(calls[1]!.url.href).toBe("https://symbols.test/v1/symbols");
    // an answer that is not a list is a failure, not an empty registry
    await expect(new ProClient({ token: TOKEN, fetch: fakeFetch(() => json({ error: "?" })).fetch }).symbols()).rejects.toThrow(
      new ProError("the symbols registry answered with something that is not a list of feeds"),
    );
  });

  it("makes the registry's text printable and bounded", async () => {
    const { fetch } = fakeFetch(() => json([{ pyth_lazer_id: 7, symbol: "Crypto.EVIL\n/USD\u202e", description: "d".repeat(1_000), state: "\u001b[31mstable" }]));
    const [s] = await new ProClient({ token: TOKEN, fetch }).symbols();
    expect([s!.symbol, s!.state, s!.description.length]).toEqual(["Crypto.EVIL /USD", "[31mstable", 257]);
  });
});

describe("tokens", () => {
  it("mints a short-lived token from an API key, and keeps the key out of every error", async () => {
    const { fetch, calls } = fakeFetch(() => json({ access_token: "jwt.abc.def", expires_at: "2026-11-10T12:15:00Z", token_type: "Bearer" }));
    const t = await mintProToken(TOKEN, { fetch });
    expect(t).toEqual({ token: "jwt.abc.def", expiresAt: Date.parse("2026-11-10T12:15:00Z") / 1000, tokenType: "Bearer" });
    expect(calls[0]!.url.href).toBe(PYTH_PRO_TOKEN_URL);
    expect(PYTH_PRO_TOKEN_URL).toBe("https://pyth.dourolabs.app/auth/token");
    expect([calls[0]!.method, calls[0]!.headers.get("authorization"), calls[0]!.body]).toEqual(["POST", `Bearer ${TOKEN}`, {}]);
    // the expiry in other forms: unix seconds, milliseconds, digits, missing
    for (const [given, want] of [[1_800_000_000, 1_800_000_000], [1_800_000_000_000, 1_800_000_000], ["1800000000", 1_800_000_000], [undefined, null], ["soon", null]] as const) {
      const r = await mintProToken(TOKEN, { fetch: fakeFetch(() => json({ access_token: "j", expires_at: given })).fetch });
      expect(r.expiresAt).toBe(want);
    }
    const errors = [
      await mintProToken(TOKEN, { fetch: fakeFetch(() => new Response(`key ${TOKEN} is revoked`, { status: 400 })).fetch }).catch((e) => e),
      await mintProToken(TOKEN, { fetch: fakeFetch(() => new Response("", { status: 401 })).fetch }).catch((e) => e),
      await mintProToken(TOKEN, { fetch: fakeFetch(() => json({ token: "x" })).fetch }).catch((e) => e),
      await mintProToken(TOKEN, { fetch: fakeFetch(() => new Response("<html>")).fetch }).catch((e) => e),
      await mintProToken(TOKEN, {
        fetch: fakeFetch(() => {
          throw new Error(`connect failed with ${TOKEN}`);
        }).fetch,
      }).catch((e) => e),
      await mintProToken(`${TOKEN}\n`).catch((e) => e),
      await mintProToken("").catch((e) => e),
    ] as Error[];
    for (const e of errors) {
      expect(e).toBeInstanceOf(ProError);
      expect(e.message).not.toContain("SECRET");
    }
    expect(errors.map((e) => e.message)).toEqual([
      "the token endpoint returned HTTP 400: key *** is revoked",
      "the token endpoint refused the API key (HTTP 401)",
      "the token endpoint's answer holds no access_token",
      "the token endpoint returned a body that is not JSON",
      "the token endpoint is unreachable: connect failed with ***",
      "the Pyth Pro API key holds a line break or another character a request header cannot carry: re-enter it",
      "no Pyth Pro API key was given to mint a token from",
    ]);
  });

  it("caches a token until shortly before it expires, sharing one mint among concurrent requests", async () => {
    let now = 1_000;
    let mints = 0;
    const provider = cachedToken(
      async () => {
        mints++;
        await settle(5);
        return { token: `jwt-${mints}`, expiresAt: now + 900 };
      },
      { clock: () => now },
    );
    expect(await Promise.all([provider(), provider(), provider()])).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    now += 839; // 61 s before expiry
    expect(await provider()).toBe("jwt-1");
    now += 2; // inside the 60 s margin
    expect(await provider()).toBe("jwt-2");
    expect(mints).toBe(2);
    // an unknown expiry is trusted for five minutes
    const blind = cachedToken(async () => ({ token: `t${++mints}`, expiresAt: null }), { clock: () => now });
    expect(await blind()).toBe("t3");
    now += 299;
    expect(await blind()).toBe("t3");
    now += 2;
    expect(await blind()).toBe("t4");
    // a failed mint is not cached
    let fail = true;
    const flaky = cachedToken(async () => {
      if (fail) throw new Error("backend down");
      return { token: "ok", expiresAt: now + 900 };
    });
    await expect(flaky()).rejects.toThrow("backend down");
    fail = false;
    expect(await flaky()).toBe("ok");
  });
});

describe("ProClient.stream", () => {
  const SUBSCRIBE = { properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"], formats: ["evm"], channel: "fixed_rate@200ms", jsonBinaryEncoding: "hex", parsed: false, deliveryFormat: "json", ignoreInvalidFeeds: true };
  const u = (at: number, extraUs = 0n, feeds: number[] = [1]) => unsigned({ at, extraUs, feeds: feeds.map((id) => ({ id })) });
  const rows = (batch: Print[] | void) => (batch ?? []).map((p) => [p.feedId, p.timestampUs]);

  it("connects to every endpoint with the token in a header, subscribes once per set, and yields each update once", async () => {
    const c = new ProClient({ token: TOKEN, headers: { "x-extra": "1" }, WebSocket: FakeSocket, streamUrls: [A, B, C] });
    const it = c.stream([F1], undefined, { idleTimeout: null });
    const first = it.next();
    await settle();
    expect(FakeSocket.all.map((s) => s.url)).toEqual([A, B, C]);
    for (const s of FakeSocket.all) {
      expect(s.headers).toEqual({ "x-extra": "1", Authorization: `Bearer ${TOKEN}` });
      expect(s.sent).toEqual([]); // nothing before the connection opens
      s.open();
      expect(s.sent).toEqual([{ type: "subscribe", subscriptionId: 1, priceFeedIds: [1], ...SUBSCRIBE }]);
    }
    const [a, b, d] = FakeSocket.all as [FakeSocket, FakeSocket, FakeSocket];
    const u1 = u(100);
    b.message(streamUpdated(u1));
    a.message(streamUpdated(u1)); // the same update from another endpoint
    d.message(streamUpdated(u1.slice(2) as Hex)); // and without its 0x
    const r1 = await first;
    expect(r1.value!.map((p) => [p.feedId, p.publishTime, p.blob, p.signer])).toEqual([[F1, 100, u1, null]]);
    // the next instant, whichever endpoint brings it first; an older one arriving late is dropped
    const second = it.next();
    a.message(streamUpdated(u(100, 200_000n)));
    d.message(streamUpdated(u1));
    b.message(streamUpdated(u(100, 200_000n)));
    expect(rows((await second).value)).toEqual([[F1, 100_200_000n]]);
    const third = it.next();
    await settle(5);
    d.message(new TextEncoder().encode(streamUpdated(u(100, 400_000n)))); // a binary frame holding the same JSON
    expect(rows((await third).value)).toEqual([[F1, 100_400_000n]]);
    await it.return();
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
  });

  it("presents the token as a subprotocol where headers cannot be set, and refuses a token that cannot be one", async () => {
    const c = new ProClient({ token: () => "eyJhbGciOi.payload-part_x.sig", WebSocket: FakeSocket, streamUrls: [A], streamAuth: "subprotocol", headers: { "x-extra": "1" } });
    const it = c.stream([F1], undefined, { idleTimeout: null });
    const first = it.next();
    await settle();
    expect(FakeSocket.all[0]!.protocols).toEqual(["pyth-lazer-auth", "eyJhbGciOi.payload-part_x.sig"]);
    expect(FakeSocket.all[0]!.headers).toBeUndefined();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.message(streamUpdated(u(100)));
    expect(rows((await first).value)).toEqual([[F1, 100_000_000n]]);
    await it.return();
    // an API key with a character a subprotocol cannot hold: refused before any connection, unquoted
    const key = "sk live/SECRET=";
    const bad = new ProClient({ token: key, WebSocket: FakeSocket, streamUrls: [A, B], streamAuth: "subprotocol" });
    FakeSocket.reset();
    const e = (await bad.stream([F1]).next().catch((x) => x)) as Error;
    expect(e).toBeInstanceOf(ProError);
    expect(e.message).toContain("price stream unreachable: the price token holds a character a WebSocket subprotocol cannot carry");
    expect(e.message).not.toContain("SECRET");
    expect(FakeSocket.all).toEqual([]);
    // without a token there is nothing to present
    const open = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A], streamAuth: "subprotocol" });
    const waiting = open.stream([F1], undefined, { idleTimeout: null }).next();
    await settle();
    expect(FakeSocket.all[0]!.arg).toBeUndefined();
    await open.close();
    expect((await waiting).done).toBe(true);
  });

  it("says so when the runtime has no WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined);
    await expect(new ProClient({ restUrl: REST, streamUrls: [A] }).stream([F1]).next()).rejects.toThrow(
      "this runtime has no WebSocket (Node before 22 has none): pass a WebSocket constructor, for example the `ws` package's, as the client's WebSocket option",
    );
    vi.stubGlobal("WebSocket", FakeSocket);
    const c = new ProClient({ restUrl: REST, streamUrls: [A] });
    const waiting = c.stream([F1], undefined, { idleTimeout: null }).next();
    await settle();
    expect(FakeSocket.all).toHaveLength(1); // the global one is used when none is given
    await c.close();
    expect((await waiting).done).toBe(true);
  });

  it("makes one subscription per distinct set, so a market's update carries exactly its legs", async () => {
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A], channel: "real_time" });
    const composite: Hex = `0x${"ab".repeat(32)}`;
    const it = c.stream([[F2], [F3, F1], [F1, F3], [F1], [composite], [], [F2, composite]], undefined, { idleTimeout: null });
    const first = it.next();
    await settle();
    const s = FakeSocket.all[0]!;
    s.open();
    expect(s.sent.map((m) => [m.subscriptionId, m.priceFeedIds, m.channel])).toEqual([
      [1, [2], "real_time"],
      [2, [1, 3], "real_time"], // both legs of the composite, once, whatever their order
      [3, [1], "real_time"],
    ]);
    // each set's update is its own stream: the same instant for another set is not a duplicate
    const both = unsigned({ at: 100, feeds: [{ id: 3 }, { id: 1 }] });
    const alone = u(100);
    s.message(streamUpdated(both, 2));
    s.message(streamUpdated(alone, 3));
    const got = [...(await first).value!];
    while (got.length < 3) got.push(...(await it.next()).value!);
    expect(got.map((p) => [p.feedId, p.blob === both ? "both" : "alone"])).toEqual([
      [F3, "both"],
      [F1, "both"],
      [F1, "alone"],
    ]);
    await it.return();
    // a flat list is one set; nothing raw is nothing to stream
    const flat = c.stream([F2, F1], undefined, { idleTimeout: null }).next();
    await settle();
    FakeSocket.all[1]!.open();
    expect(FakeSocket.all[1]!.sent.map((m) => m.priceFeedIds)).toEqual([[1, 2]]);
    await c.close();
    expect((await flat).done).toBe(true);
    expect(await c.stream([composite]).next()).toEqual({ done: true, value: undefined });
  });

  it("hands a slow consumer the newest update per set, and never mistakes it for silence", async () => {
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A] });
    const it = c.stream([[F1], [F2]], undefined, { idleTimeout: 0.05 });
    const first = it.next();
    await settle();
    const s = FakeSocket.all[0]!;
    s.open();
    s.message(streamUpdated(u(100)));
    expect(rows((await first).value)).toEqual([[F1, 100_000_000n]]);
    for (const extra of [200_000n, 400_000n, 600_000n]) s.message(streamUpdated(u(100, extra)));
    s.message(streamUpdated(u(100, 600_000n, [2])));
    await settle(120); // the consumer is busy for longer than the idle timeout
    expect(rows((await it.next()).value)).toEqual([
      [F1, 100_600_000n],
      [F2, 100_600_000n],
    ]);
    // now it waits, and nothing comes
    await expect(it.next()).rejects.toThrow("price stream went quiet: no new update for 0.05 s");
    expect(s.closed).toBe(true);
    expect(STREAM_IDLE_TIMEOUT).toBe(10);
  });

  it("counts an update without a live print as life, and a connection that never opens as silence", async () => {
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A] });
    const it = c.stream([F1], undefined, { idleTimeout: 0.6 });
    const first = it.next();
    await settle();
    const s = FakeSocket.all[0]!;
    s.open();
    // a feed with no price yet: updates keep coming for longer than the idle timeout, none carries a print
    for (let i = 0; i < 6; i++) {
      await settle(120);
      s.message(streamUpdated(unsigned({ at: 100, extraUs: BigInt(i) * 100_000n, feeds: [{ id: 1, price: 0n, generated: 0 }] })));
    }
    s.message(streamUpdated(u(101)));
    expect(rows((await first).value)).toEqual([[F1, 101_000_000n]]);
    await it.return();
    // never answered at all
    FakeSocket.reset();
    const quiet = c.stream([F1], undefined, { idleTimeout: 0.05 });
    await expect(quiet.next()).rejects.toThrow("price stream went quiet: no new update for 0.05 s");
    expect(FakeSocket.all[0]!.closed).toBe(true);
  });

  it("reconnects a dropped endpoint with a growing delay and a fresh token while the others deliver", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let n = 0;
    const notices: string[] = [];
    const c = new ProClient({ token: () => `jwt-${++n}`, WebSocket: FakeSocket, streamUrls: [A, B] });
    const it = c.stream([F1], undefined, { idleTimeout: null, onNotice: (m) => notices.push(m) });
    const first = it.next();
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    a.drop(1012, "service restart");
    expect(a.closed).toBe(true);
    b.message(streamUpdated(u(100)));
    expect(rows((await first).value)).toEqual([[F1, 100_000_000n]]); // the other endpoint keeps delivering
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.to(A)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeSocket.to(A)).toHaveLength(2); // half a second after the first drop
    const a2 = FakeSocket.to(A)[1]!;
    expect(a2.headers).toEqual({ Authorization: "Bearer jwt-3" }); // a token asked for again
    a2.error("connection refused");
    a2.drop(); // the close that follows the error is the same failure
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.to(A)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeSocket.to(A)).toHaveLength(3); // then a second
    const a3 = FakeSocket.to(A)[2]!;
    a3.open();
    expect(a3.sent).toHaveLength(1); // subscribed again
    const next = it.next();
    a3.message(streamUpdated(u(101)));
    expect(rows((await next).value)).toEqual([[F1, 101_000_000n]]);
    // having delivered, its next drop starts from half a second again
    a3.drop();
    await vi.advanceTimersByTimeAsync(501);
    expect(FakeSocket.to(A)).toHaveLength(4);
    expect(notices).toEqual([
      "price stream endpoint wss://pro-0.test/v1/stream dropped (connection closed (code 1012): service restart): reconnecting",
      "price stream endpoint wss://pro-0.test/v1/stream dropped (connection refused): reconnecting",
      "price stream endpoint wss://pro-0.test/v1/stream dropped (connection closed (code 1006)): reconnecting",
    ]);
    await it.return();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(5); // nothing reconnects after the stream ended
  });

  it("throws when no endpoint can be reached, without the token or a keyed URL", async () => {
    const keyed = "wss://pro.test/7f6e5d4c3b2a19087f6e5d4c3b2a1908/v1/stream";
    const c = new ProClient({ token: TOKEN, WebSocket: FakeSocket, streamUrls: [keyed, B] });
    const it = c.stream([F1], undefined, { idleTimeout: null });
    const first = it.next().catch((e) => e);
    await settle();
    FakeSocket.all[0]!.error(`Unexpected server response: 401 for ${keyed} with ${TOKEN}`);
    await settle();
    FakeSocket.all[1]!.drop(1006);
    const e = (await first) as Error;
    expect(e).toBeInstanceOf(ProError);
    expect(e.message).toBe("price stream unreachable: connection closed (code 1006) (check the stream URLs and the token)");
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
    // a single endpoint: its own reason, masked
    FakeSocket.reset();
    const one = new ProClient({ token: TOKEN, WebSocket: FakeSocket, streamUrls: [keyed] }).stream([F1], undefined, { idleTimeout: null });
    const failed = one.next().catch((x) => x);
    await settle();
    FakeSocket.all[0]!.error(`Unexpected server response: 401 for ${keyed} with ${TOKEN}`);
    expect(((await failed) as Error).message).toBe("price stream unreachable: Unexpected server response: 401 for wss://pro.test/***/v1/stream with *** (check the stream URLs and the token)");
    // a constructor that throws is an endpoint that cannot be reached
    class Throwing {
      constructor() {
        throw new SyntaxError(`bad subprotocol ${TOKEN}`);
      }
    }
    const thrown = new ProClient({ token: TOKEN, WebSocket: Throwing as never, streamUrls: [A] }).stream([F1]);
    await expect(thrown.next()).rejects.toThrow("price stream unreachable: bad subprotocol *** (check the stream URLs and the token)");
  });

  it("returns once every endpoint has dropped after connecting, and at once when aborted or closed", async () => {
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A, B] });
    const it = c.stream([F1], undefined, { idleTimeout: null });
    const first = it.next();
    await settle();
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    a.message(streamUpdated(u(100)));
    expect((await first).done).toBe(false);
    const end = it.next();
    a.drop();
    await settle(5);
    b.drop();
    expect(await end).toEqual({ done: true, value: undefined });
    // an abort ends it, closing the sockets
    FakeSocket.reset();
    const ctl = new AbortController();
    const aborted = c.stream([F1], ctl.signal, { idleTimeout: null });
    const waiting = aborted.next();
    await settle();
    FakeSocket.all[0]!.open();
    ctl.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
    // an already aborted signal never connects
    FakeSocket.reset();
    expect(await c.stream([F1], ctl.signal).next()).toEqual({ done: true, value: undefined });
    expect(FakeSocket.all).toEqual([]);
    // close() ends every open stream
    const open = c.stream([F1], undefined, { idleTimeout: null });
    const pending = open.next();
    await settle();
    await c.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
  });

  it("drops an endpoint whose update is not from a trusted signer, and takes the instant from another", async () => {
    const good = await signed({ at: 100, feeds: [{ id: 1 }] });
    const forged = await signed({ at: 100, feeds: [{ id: 1, price: 999n }] }, OTHER_KEY);
    const notices: string[] = [];
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A, B], isTrustedSigner: (s) => s === SIGNER });
    const it = c.stream([F1], undefined, { idleTimeout: null, onNotice: (m) => notices.push(m) });
    const first = it.next();
    await settle();
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    a.message(streamUpdated(forged));
    await settle(20);
    expect(a.closed).toBe(true); // refused, and the endpoint with it
    b.message(streamUpdated(good)); // the same instant, genuine: still taken
    const batch = (await first).value!;
    expect(batch.map((p) => [p.price, p.signer, p.blob])).toEqual([[200_000_000_000n, SIGNER, good]]);
    expect(notices).toEqual([
      `price stream endpoint wss://pro-0.test/v1/stream dropped (a price update is signed by ${privateKeyToAddress(OTHER_KEY)}, which is not a signer Pyth's verifier trusts: refusing it): reconnecting`,
    ]);
    await it.return();
  });

  it("leaves an update unused, without dropping its endpoint, when the signer check itself fails", async () => {
    const good = await signed({ at: 100, feeds: [{ id: 1 }] });
    const later = await signed({ at: 101, feeds: [{ id: 1 }] });
    let down = true;
    const notices: string[] = [];
    const c = new ProClient({
      restUrl: REST,
      WebSocket: FakeSocket,
      streamUrls: [A],
      isTrustedSigner: () => {
        if (down) throw new Error("rpc down");
        return true;
      },
    });
    const it = c.stream([F1], undefined, { idleTimeout: 0.1, onNotice: (m) => notices.push(m) });
    const first = it.next();
    await settle();
    const s = FakeSocket.all[0]!;
    s.open();
    s.message(streamUpdated(good));
    await settle(20);
    expect(s.closed).toBe(false);
    expect(notices).toEqual(["could not confirm that Pyth trusts the signer of a price update: rpc down"]);
    down = false;
    s.message(streamUpdated(later));
    expect(rows((await first).value)).toEqual([[F1, 101_000_000n]]);
    // and when it never recovers, the silence says why
    down = true;
    s.message(streamUpdated(await signed({ at: 102, feeds: [{ id: 1 }] })));
    await expect(it.next()).rejects.toThrow("price stream went quiet: no new update for 0.1 s (last endpoint message: could not confirm that Pyth trusts the signer of a price update: rpc down)");
  });

  it("drops an endpoint that sends something it cannot read, and reports what the endpoint says", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const notices: string[] = [];
    const c = new ProClient({ token: TOKEN, WebSocket: FakeSocket, streamUrls: [A, B] });
    const it = c.stream([[F1], [F2]], undefined, { idleTimeout: null, onNotice: (m) => notices.push(m) });
    const first = it.next();
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    // things that are ignored: not JSON, not an object, an unknown type, an acknowledgement
    for (const m of ["not json", "null", JSON.stringify({ type: "hello" }), JSON.stringify({ type: "subscribed", subscriptionId: 1 }), new Blob(["x"])]) a.message(m);
    expect(a.closed).toBe(false);
    // what the endpoint reports is passed on once, with the token masked
    const refusal = JSON.stringify({ type: "subscriptionError", subscriptionId: 2, error: `feed 2 is not available on this channel for ${TOKEN}` });
    a.message(refusal);
    b.message(refusal);
    a.message(JSON.stringify({ type: "subscribedWithInvalidFeedIdsIgnored", subscriptionId: 1, subscribedFeedIds: [], ignoredInvalidFeedIds: { unknownIds: [1] } }));
    a.message(JSON.stringify({ type: "error", error: "Client too slow" }));
    expect(a.closed).toBe(false);
    // what cannot be read drops the endpoint
    a.message(JSON.stringify({ type: "streamUpdated", subscriptionId: 1, evm: { encoding: "hex", data: "0xdeadbeef" } }));
    expect(a.closed).toBe(true);
    b.message(JSON.stringify({ type: "streamUpdated", subscriptionId: 1, parsed: {} })); // no signed data at all
    expect(b.closed).toBe(true);
    expect(await first).toEqual({ done: true, value: undefined }); // both gone after connecting: the stream ends
    expect(notices).toEqual([
      "price stream refused the subscription for feed(s) 2 on fixed_rate@200ms: feed 2 is not available on this channel for ***",
      'price stream left out feeds it does not serve on fixed_rate@200ms: {"unknownIds":[1]}',
      "price stream reported an error: Client too slow",
      "price stream endpoint wss://pro-0.test/v1/stream dropped (it sent an update the SDK cannot read (malformed Pyth Pro update: shorter than an envelope)): reconnecting",
    ]);
    // a message past the size limit
    FakeSocket.reset();
    const big = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A] }).stream([F1], undefined, { idleTimeout: null });
    const end = big.next();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.message(" ".repeat(MAX_STREAM_MESSAGE + 1));
    expect(FakeSocket.all[0]!.closed).toBe(true);
    expect(await end).toEqual({ done: true, value: undefined });
    expect(MAX_STREAM_MESSAGE).toBe(1024 * 1024);
  });

  it("carries the one-second tick helper's shape", () => {
    // tick() is what the settlement tests build archives from: channel 4, stamped on the second
    const t = tick(50, [{ id: 1, generated: 40 }]);
    expect(t.startsWith("0x2a22999a")).toBe(true);
  });
});

describe("ProClient credentials", () => {
  it("printing or serializing a client, a price service or a context shows no credential", async () => {
    const { inspect } = await import("node:util");
    const client = new ProClient({
      token: TOKEN,
      headers: { "x-key": "hunter2hunter2" },
      restUrl: "https://pro.test/7f6e5d4c3b2a19087f6e5d4c3b2a1908",
      streamUrls: ["wss://pro.test/v1/stream?key=s3cr3tvalue"],
    });
    const rpc = "https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz0123456789";
    const ctx = {
      chain: Chain.fromUrl(rpc, { headers: { "x-rpc-key": "rpcsecret123" } }),
      prices: proPriceSource(client),
      subgraph: new SubgraphClient("https://gateway.example/api/0123456789abcdef0123456789abcdef/subgraphs/id/x", "sgkey-SECRET-42"),
    };
    const secrets = ["SECRET1234", "hunter2", "7f6e5d4c3b2a19087f6e5d4c3b2a1908", "s3cr3tvalue", "abcdefghijklmnopqrstuvwxyz0123456789", "rpcsecret123", "0123456789abcdef0123456789abcdef", "sgkey-SECRET-42"];
    for (const v of [client, new PriceService(client, { logger: null }), ctx]) {
      for (const text of [inspect(v, { depth: 10, showHidden: true }), JSON.stringify(v)]) for (const s of secrets) expect(text).not.toContain(s);
    }
    // what was configured is still there to read
    expect(client.restUrl).toBe("https://pro.test/7f6e5d4c3b2a19087f6e5d4c3b2a1908");
    expect(client.streamUrls).toEqual(["wss://pro.test/v1/stream?key=s3cr3tvalue"]);
    expect((ctx.chain.rpc as JsonRpc).url).toBe(rpc);
    expect(ctx.subgraph.url).toContain("0123456789abcdef0123456789abcdef");
  });

  it("never lets a request that carries a credential follow a redirect", async () => {
    const seen: string[] = [];
    const { fetch } = fakeFetch((url, init) => {
      seen.push(`${url.pathname} ${init.redirect}`);
      if (url.pathname === "/v1/symbols") return json([]);
      if (url.pathname === "/auth/token") return json({ access_token: "jwt-test-token" });
      return json(evm(unsigned({ at: 100, channel: "fixed_rate@1000ms", feeds: [{ id: 1 }] })));
    });
    const c = new ProClient({ token: TOKEN, fetch, restUrl: "https://pro.test", symbolsUrl: "https://symbols.test" });
    await c.latest([F1]);
    await c.atTick([F1], 100);
    await c.symbols();
    await new ProClient({ headers: { "x-key": "hunter2hunter2" }, fetch, restUrl: "https://pro.test", streamUrls: [A] }).latest([F1]);
    await new ProClient({ fetch, restUrl: "https://pro.test", streamUrls: [A] }).latest([F1]); // nothing to hand over
    await mintProToken("pk_test_NOT_A_REAL_KEY", { fetch, url: "https://tokens.test/auth/token" });
    expect(seen).toEqual(["/v1/latest_price error", "/v1/price error", "/v1/symbols follow", "/v1/latest_price error", "/v1/latest_price follow", "/auth/token error"]);
  });

  it("masks a short header value, and a URL's key or password quoted without the rest of the URL", async () => {
    const restUrl = "https://feeds:pa55w0rd-x@pro.test/7f6e5d4c3b2a19087f6e5d4c3b2a1908";
    const { fetch } = fakeFetch(() => {
      throw new TypeError("refused key 7f6e5d4c3b2a19087f6e5d4c3b2a1908 and k3y9 for pa55w0rd-x, see https://other.example/v2/zyxwvutsrqponmlkjihgfedcba987654321.");
    });
    const c = new ProClient({ token: TOKEN, headers: { "x-k": "k3y9" }, restUrl, fetch });
    expect(((await c.latest([F1]).catch((e) => e)) as Error).message).toBe("price endpoint unreachable: refused key *** and *** for ***, see https://other.example/v2/***.");
  });

  it("refuses to send a credential unencrypted to another machine unless told to", async () => {
    expect(() => new ProClient({ token: TOKEN, restUrl: "http://pro.example" })).toThrow(
      new ProError(
        "the price request URL uses http://, which would send the price token and headers unencrypted to another machine: use https:// or wss://, or set allowInsecure for an endpoint on a network you trust",
      ),
    );
    expect(() => new ProClient({ headers: { "x-key": "hunter2hunter2" }, streamUrls: ["ws://pro.example/v1/stream"] })).toThrow("a price stream URL uses ws://");
    expect(() => new ProClient({ token: () => "jwt-test-token", streamUrls: ["ws://pro.example/v1/stream"] })).toThrow("a price stream URL uses ws://");
    // this machine, an explicit opt-in, or nothing to send
    expect(() => new ProClient({ token: TOKEN, restUrl: "http://127.0.0.1:8080", streamUrls: ["ws://localhost:8081/v1/stream", "ws://[::1]:8082/v1/stream"] })).not.toThrow();
    expect(() => new ProClient({ token: TOKEN, restUrl: "http://pro.example", streamUrls: ["ws://pro.example/v1/stream"], allowInsecure: true })).not.toThrow();
    expect(() => new ProClient({ restUrl: "http://pro.example", streamUrls: ["ws://pro.example/v1/stream"] })).not.toThrow();
    await expect(mintProToken("pk_test_NOT_A_REAL_KEY", { url: "http://tokens.example/auth/token" })).rejects.toThrow("the token endpoint uses http://, which would send the API key unencrypted");
  });

  it("quotes an endpoint's text on one line, and bounded", async () => {
    const body = `bad\u001b[31m request\r\nForged: entry\u202e${"x".repeat(10_000)}`;
    const msg = ((await new ProClient({ token: TOKEN, fetch: fakeFetch(() => new Response(body, { status: 400 })).fetch }).latest([F1]).catch((e) => e)) as Error).message;
    expect(msg.startsWith("price endpoint returned HTTP 400: bad [31m request Forged: entry xxx")).toBe(true);
    expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
    expect(msg.length).toBeLessThan(260);
  });

  it("reduces a failed signer check to a short summary, with every URL in it redacted", async () => {
    const blob = await signed({ at: 100, feeds: [{ id: 1 }] });
    const c = new ProClient({
      token: TOKEN,
      fetch: fakeFetch(() => json(evm(blob))).fetch,
      isTrustedSigner: () => {
        throw new Error(`HTTP request failed.\nURL: https://arb.example/v2/abcdefghijklmnopqrstuvwxyz0123456789\nDetails: ${"y".repeat(5_000)}`);
      },
    });
    const msg = ((await c.latest([F1]).catch((e) => e)) as Error).message;
    expect(msg.startsWith("could not confirm that Pyth trusts the signer of a price update: HTTP request failed. URL: https://arb.example/v2/*** Details: yyy")).toBe(true);
    expect(msg).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(msg.length).toBeLessThan(300);
  });

  it("refuses a base URL with a query or a fragment, and a channel it does not know, without quoting a URL", () => {
    for (const restUrl of ["https://pro.test/?key=s3cr3tvalue", "https://pro.test/v1#s3cr3tvalue"]) {
      let err: Error | null = null;
      try {
        new ProClient({ restUrl });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(ProError);
      expect(err!.message).toBe("the price request URL holds a query or a fragment: give the base URL alone (a key goes in the token or the headers)");
    }
    expect(() => new ProClient({ symbolsUrl: "https://symbols.test/v1?x=1" })).toThrow("the symbols registry URL holds a query or a fragment");
    expect(() => new ProClient({ restUrl: REST, streamUrls: ["wss://pro.test/v1/stream?key=s3cr3tvalue"] })).not.toThrow(); // a stream URL is used as given
    for (const channel of ["constructor", "toString", "__proto__"]) expect(() => new ProClient({ channel: channel as never })).toThrow("unknown Pyth Pro channel");
  });

  it("reuses a token whose expiry is past or nearer than the margin, as one whose expiry is unknown", async () => {
    let now = 1_000;
    let minted = 0;
    const provider = cachedToken(async () => ({ token: `jwt-${++minted}`, expiresAt: now - 10 }), { clock: () => now });
    expect(await provider()).toBe("jwt-1");
    expect(await provider()).toBe("jwt-1");
    now += UNKNOWN_EXPIRY_LIFETIME - 1;
    expect(await provider()).toBe("jwt-1");
    now += 2;
    expect(await provider()).toBe("jwt-2");
    const near = cachedToken(async () => ({ token: `near-${++minted}`, expiresAt: now + 30 }), { clock: () => now, margin: 60 });
    const first = await near();
    expect(await near()).toBe(first);
  });

  it("refuses to ask for more feeds than one update carries", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const c = new ProClient({ token: TOKEN, fetch });
    const many = Array.from({ length: 256 }, (_, i) => fid(i + 1));
    await expect(c.latestUpdate(many)).rejects.toThrow("256 feeds were asked for in one request, but one update carries at most 255: ask for them in parts");
    await expect(c.atTick(many, 100)).rejects.toThrow("one update carries at most 255");
    expect(calls).toHaveLength(0);
    await c.latestUpdate(many.slice(0, 255));
    expect(calls).toHaveLength(1);
  });

  it("keeps every update exactly as the verifier reads it, and refuses data longer than any update", async () => {
    const blob = unsigned({ at: 100, feeds: [{ id: 1 }] });
    const padded = `${blob}${"ab".repeat(1_000)}` as Hex;
    const u = (await new ProClient({ token: TOKEN, fetch: fakeFetch(() => json(evm(padded))).fetch }).latestUpdate([F1]))!;
    expect([u.blob, u.prints[0]!.blob]).toEqual([blob, blob]);
    const s = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A] });
    const first = s.stream([F1], undefined, { idleTimeout: null }).next();
    await settle();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.message(streamUpdated(padded));
    expect((await first).value![0]!.blob).toBe(blob);
    await s.close();
    const huge = `0x${"00".repeat(MAX_UPDATE_BYTES + 1)}`;
    await expect(new ProClient({ token: TOKEN, fetch: fakeFetch(() => json({ evm: { encoding: "hex", data: huge } })).fetch }).latestUpdate([F1])).rejects.toThrow(
      `price endpoint sent update data longer than the largest update there can be (${MAX_UPDATE_BYTES} bytes): refusing it`,
    );
  });
});

describe("ProClient.stream under a misbehaving endpoint", () => {
  const u = (at: number) => unsigned({ at, feeds: [{ id: 1 }] });
  const rows = (batch: Print[] | void) => (batch ?? []).map((p) => [p.feedId, p.timestampUs]);

  it("sends the proxy headers without a token too", async () => {
    const c = new ProClient({ headers: { "x-proxy": "proxy-header-value" }, restUrl: REST, WebSocket: FakeSocket, streamUrls: [A] });
    const waiting = c.stream([F1], undefined, { idleTimeout: null }).next();
    await settle();
    expect(FakeSocket.all[0]!.headers).toEqual({ "x-proxy": "proxy-header-value" });
    await c.close();
    expect((await waiting).done).toBe(true);
  });

  it("drops an endpoint that sends an update stamped far ahead of the clock", async () => {
    const notices: string[] = [];
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A, B], clock: () => 1_000 });
    const it = c.stream([F1], undefined, { idleTimeout: null, onNotice: (m) => notices.push(m) });
    const first = it.next();
    await settle();
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    a.message(streamUpdated(u(1_000 + MAX_UPDATE_AHEAD + 1)));
    expect(a.closed).toBe(true);
    expect(notices[0]).toContain(`it sent an update stamped ${MAX_UPDATE_AHEAD + 1} s ahead of this machine's clock`);
    b.message(streamUpdated(u(1_000)));
    expect(rows((await first).value)).toEqual([[F1, 1_000_000_000n]]);
    await c.close();
  });

  it("lets no untrusted update hold back a genuine one, however it is stamped", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const c = new ProClient({
      restUrl: REST,
      WebSocket: FakeSocket,
      streamUrls: [A, B],
      clock: () => 1_000,
      isTrustedSigner: async (s) => {
        await gate;
        return s === SIGNER;
      },
    });
    const got: Print[] = [];
    const it = c.stream([F1], undefined, { idleTimeout: null });
    const consumer = (async () => {
      for await (const batch of it) got.push(...batch);
    })();
    await settle();
    const [hostile, honest] = FakeSocket.all as [FakeSocket, FakeSocket];
    hostile.open();
    honest.open();
    const [forged1, forged2, real1, real2] = await Promise.all([
      signed({ at: 1_030, feeds: [{ id: 1, price: 1n }] }, OTHER_KEY),
      signed({ at: 1_040, feeds: [{ id: 1, price: 1n }] }, OTHER_KEY),
      signed({ at: 1_000, feeds: [{ id: 1 }] }),
      signed({ at: 1_001, feeds: [{ id: 1 }] }),
    ]);
    hostile.message(streamUpdated(forged1));
    await settle(); // its check is under way when the next arrives
    hostile.message(streamUpdated(forged2));
    open();
    await vi.waitFor(() => expect(hostile.closed).toBe(true));
    await settle(5);
    honest.message(streamUpdated(real1));
    honest.message(streamUpdated(real2));
    await vi.waitFor(() => expect(got.map((p) => p.timestampUs).at(-1)).toBe(1_001_000_000n));
    expect(got.every((p) => p.signer === SIGNER)).toBe(true);
    await c.close();
    await consumer;
  });

  it("checks every set's newest update in turn, however slow the checks", async () => {
    const releases: (() => void)[] = [];
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A], isTrustedSigner: () => new Promise<boolean>((r) => releases.push(() => r(true))) });
    const ids = [1, 2, 3, 4, 5, 6];
    const seen = new Set<Hex>();
    const it = c.stream(ids.map((id) => [fid(id)]), undefined, { idleTimeout: null });
    const consumer = (async () => {
      for await (const batch of it) for (const p of batch) seen.add(p.feedId);
    })();
    await settle();
    FakeSocket.all[0]!.open();
    const rounds = 7;
    const blobs = await Promise.all(ids.flatMap((id) => Array.from({ length: rounds }, (_, r) => signed({ at: 1_000 + r, feeds: [{ id }] }))));
    // each round brings every set a newer update, and only one check completes
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < ids.length; i++) FakeSocket.all[0]!.message(streamUpdated(blobs[i * rounds + r]!));
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
      await settle();
    }
    expect([...seen].sort()).toEqual(ids.map((id) => fid(id)).sort());
    await c.close();
    for (const release of releases) release();
    await consumer;
  });

  it("drops an endpoint that keeps sending messages that are not price updates", async () => {
    const notices: string[] = [];
    const c = new ProClient({ restUrl: REST, WebSocket: FakeSocket, streamUrls: [A, B] });
    const first = c.stream([F1], undefined, { idleTimeout: null, onNotice: (m) => notices.push(m) }).next();
    await settle();
    const [a, b] = FakeSocket.all as [FakeSocket, FakeSocket];
    a.open();
    b.open();
    for (let i = 0; i < MAX_STRAY_MESSAGES - 1; i++) a.message(i % 2 ? "not json" : JSON.stringify({ type: "mystery" }));
    expect(a.closed).toBe(false); // one short of the limit
    a.message(streamUpdated(u(100))); // a price update starts the count again
    for (let i = 0; i < MAX_STRAY_MESSAGES - 1; i++) a.message("not json");
    expect(a.closed).toBe(false);
    a.message("not json");
    expect(a.closed).toBe(true);
    expect(notices).toContainEqual(expect.stringContaining(`it sent ${MAX_STRAY_MESSAGES} messages in a row that are not price updates`));
    expect(rows((await first).value)).toEqual([[F1, 100_000_000n]]);
    await c.close();
  });
});

describe("ProClient credentials inside URLs", () => {
  it("treats a URL's own user name, password or query as a credential not to send unencrypted", () => {
    const cases: [ConstructorParameters<typeof ProClient>[0], string, string][] = [
      [{ streamUrls: ["ws://proxy.example:9000/v1/stream?key=s3cr3tvalue"] }, "a price stream URL", "ws"],
      [{ restUrl: "http://feeds:pa55w0rd@pro.example" }, "the price request URL", "http"],
      [{ symbolsUrl: "http://feeds:pa55w0rd@symbols.example" }, "the symbols registry URL", "http"],
    ];
    for (const [opts, what, scheme] of cases) {
      let err: Error | null = null;
      try {
        new ProClient(opts);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(ProError);
      expect(err!.message).toBe(
        `${what} holds a user name, a password or a query and uses ${scheme}://, which would send them unencrypted to another machine: use https:// or wss://, or set allowInsecure for an endpoint on a network you trust`,
      );
      expect(err!.message).not.toMatch(/s3cr3tvalue|pa55w0rd|feeds|example/);
      expect(() => new ProClient({ restUrl: REST, streamUrls: [A], ...opts, allowInsecure: true })).not.toThrow();
    }
    // encrypted, or this machine: nothing travels in the clear to anyone else
    expect(() => new ProClient({ streamUrls: ["wss://proxy.example/v1/stream?key=s3cr3tvalue", "ws://127.0.0.1:9000/v1/stream?key=1"], restUrl: "http://feeds:pa55w0rd@localhost:8080" })).not.toThrow();
    expect(() => new ProClient({ restUrl: REST, streamUrls: ["ws://proxy.example:9000/v1/stream?"] })).not.toThrow(); // an empty query holds nothing
  });

  it("counts only the literal localhost, 127.0.0.0/8 and [::1] as this machine", () => {
    for (const host of ["mock.localhost", "localhost.example", "127.0.0.1.example", "[::ffff:7f00:1]"]) {
      expect(() => new ProClient({ token: TOKEN, streamUrls: [`ws://${host}/v1/stream`] }), host).toThrow("a price stream URL uses ws://");
    }
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.0.9", "[::1]"]) {
      expect(() => new ProClient({ token: TOKEN, streamUrls: [`ws://${host}:8081/v1/stream`] }), host).not.toThrow();
    }
  });
});
