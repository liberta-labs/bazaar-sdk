import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { SUBGRAPH_PAGE, SubgraphClient, SubgraphError } from "../src/subgraph/client.js";

const KEY = "0123456789abcdef0123456789abcdef";
const URL_WITH_KEY = `https://gateway.example.com/api/${KEY}/subgraphs/id/bazaar`;

interface Sent {
  url: string;
  headers: Record<string, string>;
  query: string;
}

/** A fetch that records each request and answers with `answer(query)`. */
function fakeFetch(answer: (query: string) => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, query: body.query });
    return answer(body.query);
  }) as typeof fetch;
  return { fetch: f, sent };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("subgraph client", () => {
  it("sends the api key as a bearer token and returns the data", async () => {
    const { fetch, sent } = fakeFetch(() => json({ data: { _meta: { block: { number: 123, hash: "0xab" }, hasIndexingErrors: false } } }));
    const sg = new SubgraphClient("https://sg.example/q", "secret-key", { fetch });
    expect(await sg.meta()).toEqual([123, "0xab", false]);
    expect(sent[0]!.headers.authorization).toBe("Bearer secret-key");
    const anon = fakeFetch(() => json({ data: { x: 1 } }));
    await new SubgraphClient("https://sg.example/q", null, { fetch: anon.fetch }).query("{ x }");
    expect(anon.sent[0]!.headers.authorization).toBeUndefined();
  });

  it("pages an entity by id, every page pinned to the same block", async () => {
    const ids = Array.from({ length: SUBGRAPH_PAGE + 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(4, "0")}`);
    const { fetch, sent } = fakeFetch((q) => {
      const after = /id_gt: "([^"]*)"/.exec(q)![1]!;
      const rest = ids.filter((id) => id > after).slice(0, SUBGRAPH_PAGE);
      return json({ data: { orders: rest.map((id) => ({ id, size: "1" })) } });
    });
    const rows = await new SubgraphClient("https://sg.example/q", null, { fetch }).pages("orders", "size", "status_in: [Waiting]", 4_242, true);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(sent.length).toBe(2);
    expect(sent.every((s) => s.query.includes("block: {number: 4242}") && s.query.includes("status_in: [Waiting]"))).toBe(true);
    expect(sent[0]!.query).toContain('id_gt: "0x"');
    expect(sent[1]!.query).toContain(`id_gt: "${ids[SUBGRAPH_PAGE - 1]}"`);
  });

  it("reads pair descriptions by checksummed address", async () => {
    const a = "0x" + "ab".repeat(20);
    const { fetch } = fakeFetch(() => json({ data: { pairs: [{ id: a, description: "ETH / USD" }] } }));
    const d = await new SubgraphClient("https://sg.example/q", null, { fetch }).descriptions(1);
    expect(d).toEqual(new Map([[getAddress(a), "ETH / USD"]]));
  });

  it("turns every failure into a SubgraphError that shows neither the key nor the raw URL", async () => {
    const cases: [() => Response | Promise<Response>, RegExp][] = [
      [() => new Response(`upstream ${URL_WITH_KEY} failed`, { status: 502 }), /HTTP 502/],
      [() => json({ errors: [{ message: "bad query" }, { message: "and more" }] }), /bad query; and more/],
      [() => new Response("<html>", { status: 200 }), /unreadable answer/],
      [() => json({ data: null }), /no data/],
      [() => Promise.reject(new TypeError(`Failed to parse URL from ${URL_WITH_KEY}`)), /subgraph unreachable/],
      [() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), /unreachable: The operation was aborted/],
    ];
    for (const [answer, expected] of cases) {
      const { fetch } = fakeFetch(answer);
      const err = await new SubgraphClient(URL_WITH_KEY, KEY, { fetch }).query("{ x }").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubgraphError);
      expect((err as Error).message).toMatch(expected);
      expect((err as Error).message).not.toContain(KEY);
    }
    const { fetch } = fakeFetch(() => json({ data: {} }));
    await expect(new SubgraphClient("https://sg.example/q", null, { fetch }).pages("positions", "", "", 1)).rejects.toThrow(SubgraphError);
    await expect(new SubgraphClient("https://sg.example/q", null, { fetch }).meta()).rejects.toThrow(SubgraphError);
  });

  it("stops paging when the cursor does not move forward", async () => {
    // the same full page, forever: without a progress check the loop would ask for it again and again
    const same = fakeFetch(() => json({ data: { positions: Array.from({ length: SUBGRAPH_PAGE }, () => ({ id: "0x01" })) } }));
    await expect(new SubgraphClient("https://sg.example/q", null, { fetch: same.fetch }).pages("positions", "", "", 1, true)).rejects.toThrow(/id order/);
    expect(same.sent.length).toBe(1);
    // ordered pages that start over below the cursor
    const back = fakeFetch(() => json({ data: { orders: Array.from({ length: SUBGRAPH_PAGE }, (_, i) => ({ id: `o-${String(1 + i).padStart(6, "0")}` })) } }));
    await expect(new SubgraphClient("https://sg.example/q", null, { fetch: back.fetch }).pages("orders", "", "", 1)).rejects.toThrow(/id order/);
    expect(back.sent.length).toBe(2);
  });

  it("caps the number of pages", async () => {
    let next = 0;
    const endless = fakeFetch(() =>
      json({ data: { orders: Array.from({ length: SUBGRAPH_PAGE }, () => ({ id: `o-${String(next++).padStart(9, "0")}` })) } }),
    );
    const sg = new SubgraphClient("https://sg.example/q", null, { fetch: endless.fetch, maxPages: 3 });
    await expect(sg.pages("orders", "", "", 1)).rejects.toThrow(/3 pages/);
    expect(endless.sent.length).toBe(3);
  });

  it("writes the cursor so that an id cannot rewrite the query", async () => {
    const evil = 'x"}) { id } positions(where: {id_gt: "';
    const { fetch, sent } = fakeFetch(() =>
      json({ data: { orders: sent.length === 1 ? Array.from({ length: SUBGRAPH_PAGE }, (_, i) => ({ id: i === SUBGRAPH_PAGE - 1 ? evil : `a${String(i).padStart(4, "0")}` })) : [] } }),
    );
    await new SubgraphClient("https://sg.example/q", null, { fetch }).pages("orders", "", "", 1);
    expect(sent[1]!.query).toContain(`id_gt: ${JSON.stringify(evil)}`);
    // a Bytes id must be hex
    const bad = fakeFetch(() => json({ data: { pairs: [{ id: '0x01"' }] } }));
    await expect(new SubgraphClient("https://sg.example/q", null, { fetch: bad.fetch }).pages("pairs", "", "", 1, true)).rejects.toThrow(SubgraphError);
  });

  it("refuses an answer over its byte limit", async () => {
    const big = fakeFetch(() => json({ data: { x: "a".repeat(10_000) } }));
    const err = await new SubgraphClient("https://sg.example/q", null, { fetch: big.fetch, maxResponseBytes: 4_096 }).query("{ x }").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubgraphError);
    expect((err as Error).message).toMatch(/more than/);
    const ok = fakeFetch(() => json({ data: { x: 1 } }));
    expect(await new SubgraphClient("https://sg.example/q", null, { fetch: ok.fetch, maxResponseBytes: 4_096 }).query("{ x }")).toEqual({ x: 1 });
  });
});
