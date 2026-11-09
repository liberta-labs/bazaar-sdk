import { describe, expect, it } from "vitest";
import { JsonRpc, redactUrl, urlCredential } from "../src/index.js";

// Made-up keys in each provider's shape.
const ALCHEMY = "https://arb-mainnet.g.alchemy.com/v2/pz2BQ3JpUyM2t-2nXpbt3aTvP8vTtM-a";
const INFURA = "https://arbitrum-mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161";
const QUICKNODE = "https://solitary-few-shard.arbitrum-mainnet.quiknode.pro/7f6e5d4c3b2a19087f6e5d4c3b2a190871ab2cd3/";
const GRAPH =
  "https://gateway.thegraph.com/api/0123abcd4567ef890123abcd4567ef89/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
const DRPC = "https://lb.drpc.org/ogrpc?network=arbitrum&dkey=Ak80gSCleU1Frwnafb5Ka4V3cFQ9C-oR8Kg9gkl9-Mvm";
const USERINFO = "https://keeper:hunter2@rpc.example.com";
const TOKEN_PARAM = "wss://rpc.example.com/ws?token=abc";

const PLAIN = [
  "https://arb1.arbitrum.io/rpc",
  "https://sepolia-rollup.arbitrum.io/rpc",
  "https://arbitrum-one-rpc.publicnode.com",
  "http://127.0.0.1:8545",
  "https://hermes.pyth.network",
  "https://pyth.dourolabs.app/hermes",
  "https://api.studio.thegraph.com/query/12345/bazaar-arbitrum-sepolia/v0.0.1",
  "http://localhost:8000/subgraphs/name/bazaar",
  "https://lb.drpc.org/ogrpc?network=arbitrum",
  "sequencer",
  "none",
];

describe("credentials in URLs", () => {
  it.each([ALCHEMY, INFURA, QUICKNODE, GRAPH, DRPC, USERINFO, TOKEN_PARAM])("finds the key in %s", (url) => {
    expect(urlCredential(url)).toBeTruthy();
  });

  it.each(PLAIN)("passes %s and prints it unchanged", (url) => {
    expect(urlCredential(url)).toBeNull();
    expect(redactUrl(url)).toBe(url);
  });

  it("keeps the URL recognisable when redacting", () => {
    expect(redactUrl(ALCHEMY)).toBe("https://arb-mainnet.g.alchemy.com/v2/***");
    expect(redactUrl(INFURA)).toBe("https://arbitrum-mainnet.infura.io/v3/***");
    expect(redactUrl(QUICKNODE)).toBe("https://solitary-few-shard.arbitrum-mainnet.quiknode.pro/***/");
    expect(redactUrl(GRAPH)).toBe("https://gateway.thegraph.com/api/***/subgraphs/id/***");
    expect(redactUrl(DRPC)).toBe("https://lb.drpc.org/ogrpc?network=arbitrum&dkey=***");
    expect(redactUrl(USERINFO)).toBe("https://***@rpc.example.com");
    expect(redactUrl(ALCHEMY, "${NAME}")).toBe("https://arb-mainnet.g.alchemy.com/v2/${NAME}");
  });

  it("keeps the key out of RPC errors", async () => {
    const refuse: typeof fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Must be authenticated!" } }), { status: 401 });
    const rpc = new JsonRpc(ALCHEMY, { retries: 0, fetch: refuse });
    const err = await rpc.request({ method: "eth_chainId" }).catch((e: Error) => e);
    expect(String(err)).not.toContain("pz2BQ3JpUyM2t");
    expect((err as Error).message).toBe(
      "HTTP 401 from https://arb-mainnet.g.alchemy.com/v2/***: the provider refused the request; check the key in the URL",
    );
  });
});

// The shapes a recognise-the-key-by-its-look rule missed (the transport audit's list): [what, URL, a
// piece of the secret that must not survive redaction].
const MISSED: [string, string, string][] = [
  ["32 letters, no digit", "https://arb-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf", "AbCdEfGh"],
  ["parts under 8 characters", "https://arb-mainnet.g.alchemy.com/v2/aB3_dEf-GhIjK1_lMn-oPqR2_TuVw-X", "aB3_dEf"],
  ["a key as a subdomain", "https://0123456789abcdef0123456789abcdef.eth.rpc.rivet.cloud/", "0123456789abcdef"],
  ["a JWT", "https://rpc.example.com/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGci"],
  ["base64 with + and =", "https://rpc.example.com/rpc/abc+def/ghiJKL1234==", "abc+def"],
  ["base64 split by /", "https://rpc.example.com/rpc/abc+def/ghiJKL1234==", "ghiJKL1234"],
  ["percent-encoded", "https://rpc.example.com/k/AbC%2Bd3fGh1jkLmNoPq", "d3fGh1jk"],
  ["a 12-character key", "https://rpc.example.com/a1b2c3d4e5f6", "a1b2c3d4e5f6"],
  ["a uuid", "https://rpc.example.com/v1/9aa3d95b-3bc4-40fa-88ea-12eaa4456161", "9aa3d95b"],
  ["22 letters", "https://arbitrum.gateway.tenderly.co/AbCdEfGhIjKlMnOpQrStUv", "AbCdEfGh"],
  ["x-api-key with a dot", "https://hermes.example.com/?x-api-key=live.AbC123dEf456", "AbC123dEf456"],
  ["access-token, letters only", "https://hermes.example.com/?access-token=abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop"],
  ["api-token", "https://hermes.example.com/?api-token=s3cr3t", "s3cr3t"],
  ["auth_token", "https://hermes.example.com/?auth_token=s3cr3t", "s3cr3t"],
  ["client_secret", "https://hermes.example.com/?client_id=me&client_secret=hunter2", "hunter2"],
  ["signature", "https://hermes.example.com/?signature=0xdeadbeef", "deadbeef"],
  ["a short apikey", "https://x.example.com/?apikey=abc", "abc"],
  ["a bare query key", "https://x.example.com/?Ab3dEfGhIjKlMnOpQrSt", "Ab3dEfGh"],
  ["a key as a parameter name", "https://x.example.com/?Ab3dEfGh1jKl=", "Ab3dEfGh1jKl"],
  ["a matrix ;key=", "https://rpc.example.com/rpc;key=abcdefghijklmnopqrst", "abcdefghijklmnopqrst"],
  ["a password holding /", "https://user:pa/ss1234567890abcd@rpc.example.com/", "pa/ss"],
  ["a password holding ? and #", "https://user:pa?ss#wd@rpc.example.com/", "pa?ss"],
  ["a user name alone", "https://AbCdEf123456@rpc.example.com/", "AbCdEf123456"],
  ["a key in the fragment", "https://rpc.example.com/#Ab3dEfGhIjKlMnOpQrSt", "Ab3dEfGh"],
  ["leading space, upper-case scheme", "  HTTPS://arb.g.alchemy.com/v2/Ab3dEfGhIjKlMnOpQrStUvWx", "Ab3dEfGh"],
  ["one slash after the scheme", "https:/arb-mainnet.g.alchemy.com/v2/Ab3dEfGhIjKlMnOpQrStUvWx", "Ab3dEfGh"],
  ["backslashes", "https:\\\\rpc.example.com\\v2\\Ab3dEfGhIjKlMnOpQrStUvWx", "Ab3dEfGh"],
  ["a tab inside the scheme", "ht\ttps://rpc.example.com/v2/Ab3dEfGhIjKlMnOp", "Ab3dEfGh"],
  ["a bad port", "https://rpc.example.com:Ab3dEfGh1jKl/", "Ab3dEfGh1jKl"],
  ["a Telegram bot token", "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "AAHdqTcv"],
  ["a Discord webhook", "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "AbCdEfGh"],
];

// Public URLs (with any ${NAME} the config loader strips already removed) that must print as themselves.
const PUBLIC = [
  "https://arb1-sequencer.arbitrum.io/rpc",
  "wss://arbitrum-one-rpc.publicnode.com",
  "https://solitary-few-shard.arbitrum-mainnet.quiknode.pro/",
  "https://arb-mainnet.g.alchemy.com/v2/",
  "https://rpc.ankr.com/arbitrum/",
  "https://lb.drpc.org/ogrpc?network=arbitrum&dkey=",
  "https://api.studio.thegraph.com/query/48211/bazaar-arbitrum-sepolia/version/latest",
  "https://gateway.thegraph.com/api/subgraphs/id/",
  "https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=0x" + "ab".repeat(32) + "&encoding=hex&parsed=true&ignore_invalid_price_ids=true",
  "https://hermes.pyth.network/v2/price_feeds",
  "http://[::1]:8545/",
  "http://localhost:8000/subgraphs/name/bazaar/graphql",
  "https://@rpc.example.com/rpc",
  "https://rpc.example.com/rpc?chainId=42161#",
];

/** xorshift32: the same "random" keys on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHAPES: [string, number, (k: string) => string][] = [
  [ALNUM, 32, (k) => `https://h.example/v2/${k}`],
  [ALNUM + "-_", 32, (k) => `https://h.example/v2/${k}`],
  [ALNUM, 22, (k) => `https://h.example/${k}`],
  [ALNUM, 12, (k) => `https://h.example/rpc/${k}`],
  ["0123456789abcdef", 32, (k) => `https://${k}.rpc.example/`],
  ["0123456789abcdef", 40, (k) => `https://h.example/${k}/`],
  [ALNUM + "+/", 40, (k) => `https://h.example/rpc/${k}==`],
  [ALNUM, 24, (k) => `https://h.example/?any_param=${k}`],
  ["abcdefghijklmnopqrstuvwxyz", 16, (k) => `https://h.example/?x-api-key=${k}`],
];

describe("redaction by structure", () => {
  it.each(MISSED)("masks %s", (_what, url, secret) => {
    expect(urlCredential(url)).toBeTruthy();
    expect(redactUrl(url)).not.toContain(secret);
  });

  it("keeps what is known to be public", () => {
    for (const url of PUBLIC) {
      expect(urlCredential(url), url).toBeNull();
      expect(redactUrl(url), url).toBe(url);
    }
  });

  it("masks every random key, whatever its shape", () => {
    const next = rng(20251108);
    for (const [alphabet, len, place] of SHAPES) {
      for (let i = 0; i < 5_000; i++) {
        let k = "";
        for (let j = 0; j < len; j++) k += alphabet[Math.floor(next() * alphabet.length)];
        const url = place(k);
        if (urlCredential(url) === null || redactUrl(url).includes(k)) throw new Error(`missed a ${len}-character key: ${url}`);
      }
    }
  });

  it("prints only the parts it keeps", () => {
    expect(redactUrl("https://user:pa/ss1234567890abcd@rpc.example.com/")).toBe("https://***@rpc.example.com/");
    expect(redactUrl("https://0123456789abcdef0123456789abcdef.eth.rpc.rivet.cloud/")).toBe("https://***.eth.rpc.rivet.cloud/");
    expect(redactUrl("https://rpc.example.com/rpc;key=abcdefghijklmnopqrst")).toBe("https://rpc.example.com/***");
    expect(redactUrl("https://hermes.example.com/?x-api-key=live.AbC123dEf456&network=arbitrum")).toBe("https://hermes.example.com/?x-api-key=***&network=arbitrum");
    expect(redactUrl("https://x.example.com/?Ab3dEfGhIjKlMnOpQrSt&chain=arb")).toBe("https://x.example.com/?***&chain=arb");
    expect(redactUrl("https://rpc.example.com/#Ab3dEfGhIjKlMnOpQrSt")).toBe("https://rpc.example.com/#***");
    expect(redactUrl("  HTTPS://arb.g.alchemy.com/v2/Ab3dEfGhIjKlMnOpQrStUvWx")).toBe("  HTTPS://arb.g.alchemy.com/v2/***");
    expect(redactUrl("https:\\\\rpc.example.com\\v2\\Ab3dEfGhIjKlMnOpQrStUvWx")).toBe("https:\\\\rpc.example.com\\v2\\***");
    // only well-known segments survive: an unfamiliar word is masked too
    expect(redactUrl("https://api.telegram.org/bot123:AAHdq/sendMessage")).toBe("https://api.telegram.org/***/***");
    expect(redactUrl("https://gateway.thegraph.com/api/0123abcd/subgraphs/id/x")).toBe("https://gateway.thegraph.com/api/***/subgraphs/id/x");
  });

  it("says where the credential sits", () => {
    expect(urlCredential("https://user:pw@rpc.example.com")).toBe("a user name or password before the host");
    expect(urlCredential("https://0123456789abcdef0123456789abcdef.rpc.example/")).toMatch(/a key in its host name/);
    expect(urlCredential("https://h.example/v2/Ab3dEf")).toMatch(/a key in its path/);
    expect(urlCredential("https://h.example/?network=arbitrum&dkey=x")).toMatch(/a key in its dkey parameter/);
    expect(urlCredential("https://h.example/?Ab3dEfGhIjKl")).toMatch(/a key in its query/);
    expect(urlCredential("https://h.example/#x")).toMatch(/a key in its fragment/);
  });

  it("flags a URL exactly when redacting it would change it, and redacts idempotently", () => {
    const next = rng(7);
    const urls = [...PLAIN, ...PUBLIC, ...MISSED.map((m) => m[1]), ALCHEMY, INFURA, QUICKNODE, GRAPH, DRPC, USERINFO, TOKEN_PARAM];
    for (let i = 0; i < 2_000; i++) {
      // random URLs built from public and secret-looking pieces
      const piece = () => ["rpc", "v2", "Ab3dEf", "x", "123", "my-name", "%41", "a.b", ""][Math.floor(next() * 9)]!;
      urls.push(`https://${piece() || "h"}.example/${piece()}/${piece()}?${piece()}=${piece()}&chain=${piece()}#${piece()}`);
    }
    for (const url of urls) {
      expect(urlCredential(url) !== null, url).toBe(redactUrl(url, "<MASK>") !== url);
      const once = redactUrl(url);
      expect(redactUrl(once), url).toBe(once);
    }
  });
});
