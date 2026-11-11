import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { PYTH_PRO } from "@liberta-labs/bazaar-sdk";
import { ConfigError, enabledJobs, loadConfig, parseConfig, priceEndpoints, resolvedNetwork } from "../src/config/index.js";
import { Entry, Ledger } from "../src/exec/ledger.js";
import { Quote, SpendPolicy, maxSpendEthPerDay } from "../src/exec/policy.js";
import { Keeper } from "../src/keeper/engine.js";

const FACTORY = "0x" + "12".repeat(20);

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { network: "anvil", factory: FACTORY, rpc: { http: "http://x" }, prices: { endpoint: "http://p" }, ...extra };
}

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-cfg-"));
  savedEnv = { ...process.env };
});

afterEach(() => {
  // Like monkeypatch, and also undo what .env loading put into the environment.
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("minimal config and defaults", () => {
    const cfg = parseConfig(base({ jobs: { liquidation: {}, sweepExpired: { enabled: false } } }));
    expect(new Set(Object.keys(enabledJobs(cfg.jobs)))).toEqual(new Set(["liquidation"]));
    const net = resolvedNetwork(cfg);
    expect(net.chainId).toBe(31337);
    expect(net.factory).toBe("0x" + "12".repeat(20));
    expect(net.official).toBe(false);
    expect(cfg.jobs.liquidation!.markets).toBe("all");
    expect(cfg.jobs.liquidation!.allowLoss).toBe(false);
  });

  it("config errors are readable", () => {
    expect(() => parseConfig({ network: "custom", rpc: { http: "x" } })).toThrow(ConfigError);
    expect(() => parseConfig({ network: "custom", rpc: { http: "x" } })).toThrow(/custom network needs chainId and factory/);
    expect(() => parseConfig({ network: "arbitrum-one", rpc: { http: "x" } })).toThrow(/no official factory/);
    expect(() =>
      parseConfig(
        base({
          wallets: { default: { type: "privateKey", key: "0x" + "1".repeat(64) } },
          jobs: { liquidation: { wallet: "fast" } },
        }),
      ),
    ).toThrow(/uses wallet 'fast'/);
    expect(() => parseConfig(base({ wallets: { default: { type: "keystore" } } }))).toThrow(/needs path/);
  });

  it("secrets must come from the environment", () => {
    const f = join(dir, "k.yaml");
    writeFileSync(f, `network: anvil\nfactory: '${FACTORY}'\nrpc: {http: http://x}\nprices: {endpoint: http://p, token: s3cret}\n`);
    expect(() => loadConfig(f)).toThrow(ConfigError);
    expect(() => loadConfig(f)).toThrow(/prices\.token holds a secret/);
    writeFileSync(f, `network: anvil\nfactory: '${FACTORY}'\nrpc: {http: '\${RPC}'}\nprices: {endpoint: http://p, token: '\${KEY}'}\n`);
    writeFileSync(join(dir, ".env"), "KEY=from-dotenv\n");
    delete process.env.KEY;
    process.env.RPC = "http://rpc";
    const cfg = loadConfig(f);
    expect(cfg.rpc.http).toBe("http://rpc");
    expect(cfg.prices.token).toBe("from-dotenv");
    delete process.env.RPC;
    expect(() => loadConfig(f)).toThrow(/RPC is not set/);
  });

  it("prices: Pyth Pro's endpoints, a base URL's, and each one overridden", () => {
    const pyth = parseConfig(base({ prices: { endpoint: "pyth", token: "made-up-token" } })).prices;
    expect(pyth).toMatchObject({ channel: "fixed_rate@200ms", stream: true, checkSigners: true, streamIdleTimeoutSeconds: 10, token: "made-up-token" });
    expect(priceEndpoints(pyth)).toEqual(PYTH_PRO);
    // A base URL names all three: the request API and the registry there, the stream at its /v1/stream.
    expect(priceEndpoints(parseConfig(base({ prices: { endpoint: "http://127.0.0.1:8787/" } })).prices)).toEqual({
      streamUrls: ["ws://127.0.0.1:8787/v1/stream"],
      restUrl: "http://127.0.0.1:8787",
      symbolsUrl: "http://127.0.0.1:8787",
    });
    expect(priceEndpoints(parseConfig(base({ prices: { endpoint: "https://pro.example" } })).prices).streamUrls).toEqual(["wss://pro.example/v1/stream"]);
    // Each place can be replaced on its own, over a preset or a base URL.
    const mixed = parseConfig(
      base({ prices: { endpoint: "pyth", channel: "real_time", streamUrls: ["ws://127.0.0.1:9001/v1/stream", "ws://127.0.0.1:9002/v1/stream"], restUrl: "http://127.0.0.1:9000" } }),
    ).prices;
    expect(mixed.channel).toBe("real_time");
    expect(priceEndpoints(mixed)).toEqual({
      streamUrls: ["ws://127.0.0.1:9001/v1/stream", "ws://127.0.0.1:9002/v1/stream"],
      restUrl: "http://127.0.0.1:9000",
      symbolsUrl: PYTH_PRO.symbolsUrl,
    });
  });

  it("prices: what the config refuses", () => {
    expect(() => parseConfig(base({ prices: { endpoint: "pyth", channel: "fixed_rate@1ms" } }))).toThrow(/prices\.channel: Invalid enum value/);
    expect(() => parseConfig(base({ prices: { endpoint: "pyth", streamUrls: [] } }))).toThrow(/prices\.streamUrls/);
    // The setting that holds the token is named, and where it belongs.
    expect(() => parseConfig(base({ prices: { endpoint: "pyth", apiKey: "made-up-token" } }))).toThrow(
      "prices: Unrecognized key(s) in object: 'apiKey' (prices.apiKey is not a setting: the Pyth Pro access token goes in prices.token " +
        "(a Pyth Core or Hermes key does not work), and prices.endpoint must be pyth or the URL of a Pyth Pro compatible service)",
    );
    // The default endpoint has no URLs: the keeper says what to set.
    const shared = parseConfig({ network: "anvil", factory: FACTORY, rpc: { http: "http://x" } });
    expect(shared.prices.endpoint).toBe("bazaar");
    expect(() => priceEndpoints(shared.prices)).toThrow(/^prices\.endpoint: the 'bazaar' price endpoint has no URLs yet; set prices\.endpoint to 'pyth' with your own Pyth Pro token/);
    expect(() => new Keeper(shared, { loadWallets: false })).toThrow(/^prices\.endpoint: the 'bazaar' price endpoint has no URLs yet/);
    for (const endpoint of ["hermes", "ftp://p.example", "ws://p.example"]) {
      expect(() => priceEndpoints(parseConfig(base({ prices: { endpoint } })).prices), endpoint).toThrow(/^prices\.endpoint: expected pyth, bazaar or an http\(s\) URL/);
    }
  });

  it("prices: a Hermes service left over from a Pyth Core setup is refused wherever the token would go", () => {
    const KEY = "made-up-key-0123456789";
    const refused = (prices: Record<string, unknown>) => {
      try {
        void new Keeper(parseConfig(base({ state: { dir }, prices: { token: "made-up-token", ...prices } })), { loadWallets: false });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain(KEY);
        return (e as Error).message;
      }
      return null;
    };
    const why = (setting: string) =>
      `${setting} names a Hermes (Pyth Core) service, and the keeper sends its Pyth Pro token wherever prices are asked for: the token must go only to a Pyth Pro service. ` +
      "Set prices.endpoint to pyth, or to the URL of a Pyth Pro compatible service";
    // In the host or in the path of the endpoint, the request API or a stream URL.
    expect(refused({ endpoint: `https://hermes.pyth.network/${KEY}` })).toBe(why("prices.endpoint"));
    expect(refused({ endpoint: `https://prices.example/HERMES/v2?key=${KEY}` })).toBe(why("prices.endpoint"));
    expect(refused({ endpoint: "pyth", restUrl: `https://my-hermes.example/${KEY}` })).toBe(why("prices.restUrl"));
    expect(refused({ endpoint: "pyth", streamUrls: ["wss://pro.example/v1/stream", `wss://pro.example/hermes/${KEY}`] })).toBe(why("prices.streamUrls"));
    // The symbols registry is asked without the token; a Pyth Pro endpoint loads.
    expect(refused({ endpoint: "pyth", symbolsUrl: "https://hermes-registry.example" })).toBeNull();
    expect(refused({ endpoint: "https://pro.example" })).toBeNull();
  });

  it("prices: a setting the client cannot use is a config error that names it and never quotes a token", () => {
    const token = "made-up-token-with\na-line-break";
    const bad = (prices: Record<string, unknown>) => {
      try {
        void new Keeper(parseConfig(base({ state: { dir }, prices })), { loadWallets: false });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    const msg = bad({ endpoint: "pyth", token });
    expect(msg).toBe("prices: the price token (prices.token) holds a line break or another character a request header cannot carry: re-enter it");
    expect(msg).not.toContain("made-up");
    expect(bad({ endpoint: "pyth", token: "" })).toBe("prices: the price token is empty: set it (prices.token)");
    expect(bad({ endpoint: "pyth", restUrl: "pyth-lazer.example" })).toBe("prices: the price request URL is not an http(s) or ws(s) URL");
    expect(bad({ endpoint: "pyth", streamUrls: ["not a url"] })).toBe("prices: a price stream URL is not an http(s) or ws(s) URL");
  });

  it("prices: a token goes over plain http or ws only to this machine, unless allowInsecure says otherwise", () => {
    const build = (prices: Record<string, unknown>) => new Keeper(parseConfig(base({ state: { dir }, prices })), { loadWallets: false });
    const token = "made-up-token-0123456789";
    let err: unknown;
    try {
      build({ endpoint: "http://pro.example", token });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^prices: the price request URL uses http:\/\/, which would send the price token and headers unencrypted to another machine: .*allowInsecure/);
    expect((err as Error).message).not.toContain(token);
    expect(() => build({ endpoint: "https://pro.example", streamUrls: ["ws://pro.example/v1/stream"], token })).toThrow(/a price stream URL uses ws:\/\//);
    // Opted in, or with nothing secret to send, or on this machine: accepted.
    expect(build({ endpoint: "http://pro.example", token, allowInsecure: true }).pro.restUrl).toBe("http://pro.example");
    expect(build({ endpoint: "http://pro.example" }).pro.streamUrls).toEqual(["ws://pro.example/v1/stream"]);
    expect(build({ endpoint: "http://127.0.0.1:8787", token }).pro.restUrl).toBe("http://127.0.0.1:8787");
    expect(build({ endpoint: "http://localhost:8787", token }).pro.restUrl).toBe("http://localhost:8787");
    expect(build({ endpoint: "http://[::1]:8787", token }).pro.restUrl).toBe("http://[::1]:8787");
    // A name under .localhost is resolved like any other name, so it is another machine.
    expect(() => build({ endpoint: "http://prices.localhost:8787", token })).toThrow(/^prices: the price request URL uses http:\/\//);
  });

  it("prices: a URL's own user name, password or query goes over plain http only to this machine, and is never quoted", () => {
    const build = (prices: Record<string, unknown>) => new Keeper(parseConfig(base({ state: { dir }, prices })), { loadWallets: false });
    const refusal = (prices: Record<string, unknown>) => {
      try {
        build(prices);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    for (const [prices, what] of [
      [{ endpoint: "http://user:made-up-pass@pro.example" }, "the price request URL holds a user name, a password or a query and uses http://"],
      [{ endpoint: "https://pro.example", streamUrls: ["ws://pro.example/v1/stream?key=made-up-pass"] }, "a price stream URL holds a user name, a password or a query and uses ws://"],
    ] as const) {
      const msg = refusal(prices);
      expect(msg.startsWith(`prices: ${what}, `), msg).toBe(true);
      expect(msg).toContain("allowInsecure");
      expect(msg).not.toContain("made-up-pass");
      expect(msg).not.toContain("pro.example");
    }
    expect(refusal({ endpoint: "pyth", symbolsUrl: "http://user:made-up-pass@registry.example" })).toMatch(/^prices: the symbols registry URL holds a user name/);
    expect(build({ endpoint: "http://user:made-up-pass@pro.example", allowInsecure: true }).pro.restUrl).toBe("http://user:made-up-pass@pro.example");
    expect(build({ endpoint: "http://user:made-up-pass@127.0.0.1:8787" }).pro.restUrl).toBe("http://user:made-up-pass@127.0.0.1:8787");
  });

  it("URLs carrying keys must come from the environment", () => {
    const f = join(dir, "k.yaml");
    const alchemyKey = "fakeAlchemyKey-0123456789abcdefg";
    const write = (rpc: string, subgraph = "none") =>
      writeFileSync(
        f,
        stringify({ network: "anvil", factory: FACTORY, rpc: { http: rpc }, subgraph: { url: subgraph }, prices: { endpoint: "http://p" } }),
      );

    write(`https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`);
    let err: unknown;
    try {
      loadConfig(f);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/rpc\.http is a URL with a key in its path/);
    expect(msg).not.toContain(alchemyKey);
    expect(msg).toContain("https://arb-mainnet.g.alchemy.com/v2/${NAME}");

    write("https://lb.drpc.org/ogrpc?network=arbitrum&dkey=fakeDrpcKey-0123456789abcdefghijklmnopqrstuv");
    expect(() => loadConfig(f)).toThrow(/rpc\.http is a URL with a key in its dkey parameter/);

    write(
      "https://arb1.arbitrum.io/rpc",
      "https://gateway.thegraph.com/api/0123abcd4567ef890123abcd4567ef89/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    );
    expect(() => loadConfig(f)).toThrow(/subgraph\.url is a URL with a key in its path/);

    // A URL without a key may be written in; a keyed one may carry its key as a ${NAME}.
    process.env.ALCHEMY_KEY = alchemyKey;
    process.env.DRPC_KEY = "fakeDrpcKey-0123456789abcdefghijklmnopqrstuv";
    write("https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}", "https://api.studio.thegraph.com/query/1/bazaar/v0.0.1");
    expect(loadConfig(f).rpc.http).toBe(`https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`);
    write("https://lb.drpc.org/ogrpc?network=arbitrum&dkey=${DRPC_KEY}");
    expect(loadConfig(f).rpc.http.endsWith("dkey=fakeDrpcKey-0123456789abcdefghijklmnopqrstuv")).toBe(true);
  });
});

function policy(extra: Record<string, unknown> = {}, ledger?: Ledger) {
  const cfg = parseConfig(base(extra));
  return { cfg, p: new SpendPolicy(cfg, ledger ?? new Ledger(null)) };
}

describe("spend policy", () => {
  it("profitable calls send and others wait for consent", () => {
    const { cfg, p } = policy({ jobs: { liquidation: {} } });
    const job = cfg.jobs.liquidation;
    expect(p.decide("liquidation", job, new Quote(0.05, 0.01)).kind).toBe("profit");
    let d = p.decide("liquidation", job, new Quote(0.01, 0.02));
    expect(d.send).toBe(false);
    expect(d.reason).toContain("allowLoss is off");
    d = p.decide("liquidation", job, new Quote(0.012, 0.01)); // positive, but below the 1.25x rule
    expect(d.send).toBe(false);
  });

  it("loss taking within its caps", () => {
    const { cfg, p } = policy({ jobs: { adl: { allowLoss: true, maxLossUsdPerCall: 0.05, lossBudgetUsdPerDay: 0.08 } } });
    const job = cfg.jobs.adl;
    let d = p.decide("adl", job, new Quote(0.0, 0.03));
    expect(d.send).toBe(true);
    expect(d.kind).toBe("loss");
    expect(p.decide("adl", job, new Quote(0.0, 0.06)).send).toBe(false); // over the per-call cap
    p.ledger.record(
      new Entry({ ts: Date.now() / 1000, job: "adl", market: "", wallet: "", tx: "", status: "confirmed", kind: "loss", costUsd: 0.06, rewardUsd: 0.0 }),
    );
    d = p.decide("adl", job, new Quote(0.0, 0.03));
    expect(d.send).toBe(false);
    expect(d.reason).toContain("daily loss budget");
  });

  it("unpaid duties, force and the global caps", () => {
    const { cfg, p } = policy({ jobs: { terminalSettlement: {} }, budget: { maxSpendUsdPerDay: 1, maxLossUsdPerDay: 0.5 } });
    const job = cfg.jobs.terminalSettlement;
    expect(p.decide("terminalSettlement", job, new Quote(0, 0.1), { paid: false }).send).toBe(false); // no consent
    const d = p.decide("terminalSettlement", job, new Quote(0, 0.1), { paid: false, consentCapUsd: 0.5 });
    expect(d.send).toBe(true);
    expect(d.kind).toBe("unpaid");
    expect(p.decide("terminalSettlement", job, new Quote(0, 0.6), { paid: false, consentCapUsd: 0.5 }).send).toBe(false);
    expect(p.decide("terminalSettlement", job, new Quote(0, 0.9), { force: true }).kind).toBe("forced");
    expect(p.decide("terminalSettlement", job, new Quote(5, 2)).send).toBe(false); // over the daily spend cap
    // Force skips the profit and loss rules, never the daily spend cap.
    const forced = p.decide("terminalSettlement", job, new Quote(0, 50), { force: true });
    expect(forced.send).toBe(false);
    expect(forced.reason).toBe("daily gas budget reached ($0.00 of $1.00 spent)");
  });

  it("the ETH spend cap: derived from the USD cap at the floor price unless set, checked in wei, forced or not", () => {
    const { cfg, p } = policy();
    expect(cfg.gas.ethUsdFloor).toBe(1000);
    expect(cfg.budget.maxSpendEthPerDay).toBeUndefined();
    expect(maxSpendEthPerDay(cfg)).toBeCloseTo(0.01); // $10 at $1000
    const set = policy({ budget: { maxSpendEthPerDay: 0.002 } });
    expect(maxSpendEthPerDay(set.cfg)).toBe(0.002);
    set.p.ledger.record(
      new Entry({ ts: Date.now() / 1000, job: "adl", market: "", wallet: "", tx: "", status: "confirmed", kind: "profit", costUsd: 0, costWei: 15n * 10n ** 14n }),
    );
    expect(set.p.decide("liquidation", null, new Quote(1, 0.001, 4n * 10n ** 14n)).kind).toBe("profit");
    for (const force of [false, true]) {
      const d = set.p.decide("liquidation", null, new Quote(1, 0.001, 6n * 10n ** 14n), { force });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("daily ETH spend cap reached (0.0015 of 0.002 ETH spent; budget.maxSpendEthPerDay)");
    }
    expect(() => parseConfig(base({ gas: { ethUsdFloor: 0 } }))).toThrow(ConfigError);
    expect(() => parseConfig(base({ budget: { maxSpendEthPerDay: -1 } }))).toThrow(ConfigError);
  });

  it("refuses a cost that is not a finite number", () => {
    const { p } = policy({ jobs: { adl: { allowLoss: true } } });
    for (const cost of [Number.NaN, Infinity]) {
      for (const force of [false, true]) {
        const d = p.decide("adl", null, new Quote(0, cost), { force, consentCapUsd: 1 });
        expect(d.send).toBe(false);
        expect(d.reason).toMatch(/could not be priced/);
      }
    }
  });
});

describe("addresses in the config", () => {
  it("never echoes the value", () => {
    const key = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const remote = (address: string) => base({ wallets: { default: { type: "remote", url: "http://signer", address } } });
    for (const [v, re] of [
      [`0x${key}`, /wallets\.default\.address: not an address: it is 32 bytes of hex, the length of a private key/],
      [key, /the length of a private key/],
      ["hunter2-not-an-address", /wallets\.default\.address: not an address: expected 0x and 40 hex digits/],
    ] as const) {
      let msg = "";
      try {
        parseConfig(remote(v));
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(re);
      expect(msg).not.toContain(v.replace(/^0x/, "").slice(0, 16));
    }
    let msg = "";
    try {
      parseConfig(base({ jobs: { collect: { forwardTo: "0x1234" } } }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/jobs\.collect\.forwardTo: not an address/);
    expect(msg).not.toContain("0x1234");
  });
});
