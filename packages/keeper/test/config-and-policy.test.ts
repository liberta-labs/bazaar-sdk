import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { ConfigError, enabledJobs, loadConfig, parseConfig, resolvedNetwork } from "../src/config/index.js";
import { Entry, Ledger } from "../src/exec/ledger.js";
import { Quote, SpendPolicy, maxSpendEthPerDay } from "../src/exec/policy.js";

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
    writeFileSync(f, `network: anvil\nfactory: '${FACTORY}'\nrpc: {http: http://x}\nprices: {endpoint: http://p, apiKey: s3cret}\n`);
    expect(() => loadConfig(f)).toThrow(ConfigError);
    expect(() => loadConfig(f)).toThrow(/prices\.apiKey holds a secret/);
    writeFileSync(f, `network: anvil\nfactory: '${FACTORY}'\nrpc: {http: '\${RPC}'}\nprices: {endpoint: http://p, apiKey: '\${KEY}'}\n`);
    writeFileSync(join(dir, ".env"), "KEY=from-dotenv\n");
    delete process.env.KEY;
    process.env.RPC = "http://rpc";
    const cfg = loadConfig(f);
    expect(cfg.rpc.http).toBe("http://rpc");
    expect(cfg.prices.apiKey).toBe("from-dotenv");
    delete process.env.RPC;
    expect(() => loadConfig(f)).toThrow(/RPC is not set/);
  });

  it("URLs carrying keys must come from the environment", () => {
    const f = join(dir, "k.yaml");
    const alchemyKey = "pz2BQ3JpUyM2t-2nXpbt3aTvP8vTtM-a";
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

    write("https://lb.drpc.org/ogrpc?network=arbitrum&dkey=Ak80gSCleU1Frwnafb5Ka4V3cFQ9C-oR8Kg9gkl9-Mvm");
    expect(() => loadConfig(f)).toThrow(/rpc\.http is a URL with a key in its dkey parameter/);

    write(
      "https://arb1.arbitrum.io/rpc",
      "https://gateway.thegraph.com/api/0123abcd4567ef890123abcd4567ef89/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    );
    expect(() => loadConfig(f)).toThrow(/subgraph\.url is a URL with a key in its path/);

    // A URL without a key may be written in; a keyed one may carry its key as a ${NAME}.
    process.env.ALCHEMY_KEY = alchemyKey;
    process.env.DRPC_KEY = "Ak80gSCleU1Frwnafb5Ka4V3cFQ9C-oR8Kg9gkl9-Mvm";
    write("https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}", "https://api.studio.thegraph.com/query/1/bazaar/v0.0.1");
    expect(loadConfig(f).rpc.http).toBe(`https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`);
    write("https://lb.drpc.org/ogrpc?network=arbitrum&dkey=${DRPC_KEY}");
    expect(loadConfig(f).rpc.http.endsWith("dkey=Ak80gSCleU1Frwnafb5Ka4V3cFQ9C-oR8Kg9gkl9-Mvm")).toBe(true);
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
    // Force skips the profit and loss rules, never the daily spend cap (K6).
    const forced = p.decide("terminalSettlement", job, new Quote(0, 50), { force: true });
    expect(forced.send).toBe(false);
    expect(forced.reason).toBe("daily gas budget reached ($0.00 of $1.00 spent)");
  });

  it("the ETH spend cap: derived from the USD cap at the floor price unless set, checked in wei, forced or not (K1)", () => {
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

  it("refuses a cost that is not a finite number (K1)", () => {
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

describe("addresses in the config (K10)", () => {
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
