import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain } from "@liberta-labs/bazaar-sdk";
import type { Command } from "commander";
import { parse as parseDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigError, type KeeperConfig, UNCHECKED_SIGNERS_WARNING, enabledJobs, loadConfig, parseConfig } from "../src/config/index.js";
import { ActionResult } from "../src/exec/executor.js";
import { runDoctor } from "../src/cli/doctor.js";
import {
  CliExit,
  type Output,
  errorText,
  formatG,
  grouped,
  groupedFixed,
  redactUrls,
  stripAnsi,
  table,
  utcTime,
} from "../src/cli/format.js";
import { type CliDeps, type Handlers, type MainOptions, OPERATIONS, buildProgram, main, renderResult } from "../src/cli/main.js";
import { type PromptChoice, type Prompts, envValue, runWizard, yamlScalar } from "../src/cli/wizard.js";

// ---- fixtures and helpers ----

const FACTORY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BTC = "0x1111111111111111111111111111111111111111";
const ETH = "0x2222222222222222222222222222222222222222";
/** shaped like a provider's key, so redactUrl masks it */
const KEY = "aBcD1234eFgH5678iJkL9012mNoP3456";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bazaar-cli-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Output = {
    out: (l = "") => void out.push(...stripAnsi(l).split("\n")),
    err: (l = "") => void err.push(...stripAnsi(l).split("\n")),
  };
  return { io, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const HANDLER_NAMES = ["init", "doctor", "start", "status", "markets", "earnings", "opportunities", "run", "wallet", "mockPrices"] as const;

/** Run the parser with every command replaced by a recorder. */
async function parse(argv: string[]) {
  const cap = capture();
  const calls: [string, unknown][] = [];
  const handlers = {} as Record<keyof Handlers, unknown>;
  for (const name of HANDLER_NAMES) {
    handlers[name] = async (args: unknown) => {
      calls.push([name, args]);
    };
  }
  const code = await main(argv, { out: cap.io, handlers: handlers as Handlers });
  return { code, calls, out: cap.text(), err: cap.errText() };
}

/** A stand-in for the engine module (packages/keeper/src/keeper/engine.ts). */
const engine = (impl: Record<string, unknown>): CliDeps["engine"] => (async () => impl) as never;

function writeConfig(dir: string, extra = ""): string {
  const path = join(dir, "bazaar-keeper.yaml");
  writeFileSync(
    path,
    `network: anvil\nfactory: "${FACTORY}"\nrpc:\n  http: http://127.0.0.1:8545\nstate:\n  dir: ${JSON.stringify(dir)}\n${extra}`,
    "utf8",
  );
  return path;
}

function marketOf(label: string, address: string, state: unknown = null) {
  return {
    address,
    pairId: `0x${"ab".repeat(32)}`,
    baseFeedId: `0x${"cd".repeat(32)}`,
    legs: [`0x${label === "BTC/USD" ? "01" : "02"}${"00".repeat(31)}`],
    invertQuote: false,
    continuous: label === "BTC/USD",
    description: label,
    label,
    state,
    dirty: false,
    lastRead: 0,
  };
}

function stateOf(over: Record<string, unknown> = {}) {
  const inv = { size: 0n, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs: 0 };
  return { terminated: false, settlementFixedTs: 0, scheduledTs: 0, adlPending: false, longInv: { ...inv }, shortInv: { ...inv }, ...over };
}

// ---- argument parsing ----

describe("argument parsing", () => {
  it("parses every keeper command with the shared --config/-c option", async () => {
    for (const cmd of ["init", "doctor", "status", "markets", "opportunities"] as const) {
      const a = await parse(["keeper", cmd]);
      expect(a.code, cmd).toBe(0);
      expect(a.calls, cmd).toEqual([[cmd, { config: "bazaar-keeper.yaml" }]]);
      const b = await parse(["keeper", cmd, "-c", "other.yaml"]);
      expect(b.calls, cmd).toEqual([[cmd, { config: "other.yaml" }]]);
      const c = await parse(["keeper", cmd, "--config=x/y.yaml"]);
      expect(c.calls, cmd).toEqual([[cmd, { config: "x/y.yaml" }]]);
    }
  });

  it("start: --dry-run and --only, with job names in any spelling", async () => {
    expect((await parse(["keeper", "start"])).calls).toEqual([["start", { config: "bazaar-keeper.yaml", dryRun: false, only: undefined }]]);
    const a = await parse(["keeper", "start", "--dry-run", "--only", "liquidation, terminal-settlement,sweep_expired,TRIGGERS", "-c", "k.yaml"]);
    expect(a.calls).toEqual([
      ["start", { config: "k.yaml", dryRun: true, only: ["liquidation", "terminalSettlement", "sweepExpired", "triggers"] }],
    ]);
    const bad = await parse(["keeper", "start", "--only", "liquidation,liquidations"]);
    expect(bad.code).toBe(2);
    expect(bad.calls).toEqual([]);
    expect(bad.err).toContain("unknown job 'liquidations'");
    expect(bad.err).toContain("liquidation, triggers, unload, adl, refresh, collect, terminalSettlement, sweepExpired");
  });

  it("earnings: --since and --by", async () => {
    expect((await parse(["keeper", "earnings"])).calls).toEqual([["earnings", { config: "bazaar-keeper.yaml", since: "7d", by: "job" }]]);
    expect((await parse(["keeper", "earnings", "--since", "24h", "--by", "market"])).calls).toEqual([
      ["earnings", { config: "bazaar-keeper.yaml", since: "24h", by: "market" }],
    ]);
    expect((await parse(["keeper", "earnings", "--since", "3"])).calls[0]![1]).toMatchObject({ since: "3" });
    const by = await parse(["keeper", "earnings", "--by", "wallet"]);
    expect(by.code).toBe(2);
    expect(by.err).toMatch(/Allowed choices are job, market/);
    for (const since of ["soon", "h", "-1d", ""]) {
      const r = await parse(["keeper", "earnings", "--since", since]);
      expect(r.code, since).toBe(2);
      expect(r.err, since).toContain("expected a period such as 30m, 24h or 7d");
    }
  });

  it("run: an operation with its options", async () => {
    const a = await parse([
      "keeper",
      "run",
      "liquidate",
      "--market",
      "BTC/USD",
      "--accounts",
      `${WALLET.toLowerCase()}, ${BTC}`,
      "--dry-run",
      "--force",
    ]);
    expect(a.code).toBe(0);
    expect(a.calls).toEqual([
      [
        "run",
        {
          config: "bazaar-keeper.yaml",
          operation: "liquidate",
          market: "BTC/USD",
          accounts: [WALLET, BTC],
          orders: undefined,
          assertion: undefined,
          proposal: undefined,
          pairId: undefined,
          dryRun: true,
          force: true,
          yes: false,
          storedPrice: undefined,
          acceptStoredPrice: false,
        },
      ],
    ]);
    const ts = await parse(["keeper", "run", "terminate-scheduled", "--market", "BTC/USD", "--stored-price", "never", "--accept-stored-price"]);
    expect(ts.calls[0]![1]).toMatchObject({ operation: "terminate-scheduled", storedPrice: "never", acceptStoredPrice: true });
    const t = await parse(["keeper", "run", "execute-triggers", "--market", "ETH/USD", "--orders", "1,2, 30"]);
    expect(t.calls[0]![1]).toMatchObject({ operation: "execute-triggers", orders: [1n, 2n, 30n], dryRun: false, force: false });
    const id = "AB".repeat(32);
    const s = await parse(["keeper", "run", "settle-termination", "--assertion", id, "-y"]);
    expect(s.calls[0]![1]).toMatchObject({ operation: "settle-termination", assertion: `0x${"ab".repeat(32)}`, yes: true });
    const e = await parse(["keeper", "run", "expire-listing", "--pair-id", `0x${id}`]);
    expect(e.calls[0]![1]).toMatchObject({ pairId: `0x${"ab".repeat(32)}` });
    const ins = await parse(["keeper", "run", "execute-insurer-termination", "--market", "BTC/USD", "--proposal", id, "--yes"]);
    expect(ins.calls[0]![1]).toMatchObject({ market: "BTC/USD", proposal: `0x${"ab".repeat(32)}`, yes: true });
    // collect needs no market; the factory's housekeeping needs nothing at all
    expect((await parse(["keeper", "run", "collect"])).calls[0]![1]).toMatchObject({ operation: "collect", market: undefined });
    expect((await parse(["keeper", "run", "collect", "--market", "BTC/USD,ETH/USD"])).calls[0]![1]).toMatchObject({ market: "BTC/USD,ETH/USD" });
    expect((await parse(["keeper", "run", "activate-identifier-upgrade"])).code).toBe(0);
    expect((await parse(["keeper", "run", "expire-identifier-upgrade"])).code).toBe(0);
  });

  it("run: each operation's required option, before anything loads", async () => {
    const cases: [string[], string][] = [
      [["liquidate"], "liquidate needs --market"],
      [["finalize"], "finalize needs --market"],
      [["terminate-scheduled"], "terminate-scheduled needs --market"],
      [["settle-termination"], "settle-termination needs --assertion"],
      [["settle-listing"], "settle-listing needs --assertion"],
      [["settle-identifier-upgrade"], "settle-identifier-upgrade needs --assertion"],
      [["execute-insurer-termination", "--market", "BTC/USD"], "execute-insurer-termination needs --proposal"],
      [["expire-listing"], "expire-listing needs --pair-id"],
    ];
    for (const [args, msg] of cases) {
      const r = await parse(["keeper", "run", ...args]);
      expect(r.code, msg).toBe(2);
      expect(r.calls, msg).toEqual([]);
      expect(r.err, msg).toContain(msg);
    }
  });

  it("run: an unknown or missing operation lists the operations", async () => {
    for (const argv of [["keeper", "run", "liquidation", "--market", "BTC/USD"], ["keeper", "run"]]) {
      const r = await parse(argv);
      expect(r.code).toBe(2);
      expect(r.calls).toEqual([]);
      expect(r.err).toMatch(argv.length > 2 ? /unknown operation 'liquidation'/ : /needs an operation/);
      for (const op of Object.keys(OPERATIONS)) expect(r.err).toContain(op);
    }
  });

  it("run: bad option values are refused", async () => {
    const orders = await parse(["keeper", "run", "sweep-expired", "--market", "BTC/USD", "--orders", "1,x"]);
    expect(orders.code).toBe(2);
    expect(orders.err).toContain("x is not an order id");
    const accounts = await parse(["keeper", "run", "liquidate", "--market", "BTC/USD", "--accounts", "0x12"]);
    expect(accounts.code).toBe(2);
    expect(accounts.err).toContain("--accounts entry 1 is not an address (4 characters");
    expect(accounts.err).not.toContain("0x12 ");
    const id = await parse(["keeper", "run", "settle-listing", "--assertion", "0x1234"]);
    expect(id.code).toBe(2);
    expect(id.err).toContain("expected a 32-byte id");
  });

  it("wallet new|import|list", async () => {
    expect((await parse(["wallet", "new"])).calls).toEqual([["wallet", { action: "new", config: "bazaar-keeper.yaml", name: "default", path: undefined }]]);
    expect((await parse(["wallet", "import", "--name", "fast", "--path", "k/fast.json"])).calls).toEqual([
      ["wallet", { action: "import", config: "bazaar-keeper.yaml", name: "fast", path: "k/fast.json" }],
    ]);
    expect((await parse(["wallet", "list", "-c", "k.yaml"])).calls).toEqual([
      ["wallet", { action: "list", config: "k.yaml", name: "default", path: undefined }],
    ]);
    const bad = await parse(["wallet", "delete"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Allowed choices are new, import, list/);
  });

  it("mock-prices", async () => {
    // A feed is its Pyth Pro number, or the bytes32 that holds it: both land under the number.
    const r = await parse(["mock-prices", "--price", "2=3000", "--price", `0x${"00".repeat(31)}ab = 1.5`, "--port", "9000"]);
    expect(r.calls).toEqual([["mockPrices", { rpc: "http://127.0.0.1:8545", price: { "2": 3000, "171": 1.5 }, host: "127.0.0.1", port: 9000 }]]);
    expect((await parse(["mock-prices"])).calls[0]![1]).toMatchObject({ price: {}, port: 8787 });
    // No price, no feed, a negative price, an id that is no Pyth Pro feed (a composite's hash, zero, a Pyth Core id).
    for (const price of ["3000", "=3000", "2=", "2=-1", "2=abc", `0x${"ab".repeat(32)}=1`, "0=1", "ff61491a=3000"]) {
      const bad = await parse(["mock-prices", "--price", price]);
      expect(bad.code, price).toBe(2);
      expect(bad.err, price).toContain("expected FEED_ID=USD with a Pyth Pro feed id");
    }
    expect((await parse(["mock-prices", "--port", "http"])).code).toBe(2);
    expect((await parse(["mock-prices", "--pyth", BTC])).code).toBe(2); // no such option: the mock needs no contract
    // The token is named by its variable, never given on the command line.
    expect((await parse(["mock-prices", "--host", "0.0.0.0", "--token-env", "MOCK_PRICES_TOKEN"])).calls[0]![1]).toMatchObject({
      host: "0.0.0.0",
      tokenEnv: "MOCK_PRICES_TOKEN",
    });
    expect((await parse(["mock-prices", "--token", "made-up-mock-token"])).code).toBe(2);
  });

  it("mock-prices listens beyond this machine only with a token, read from the environment", async () => {
    const run = async (argv: string[]) => {
      const cap = capture();
      const code = await main(["mock-prices", ...argv], { out: cap.io });
      return { code, err: cap.errText() };
    };
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "mock.localhost"]) {
      const r = await run(["--host", host]);
      expect(r.code, host).toBe(2);
      expect(r.err, host).toContain(`not listening on ${host}: other machines may reach the mock there`);
    }
    delete process.env.MADE_UP_MOCK_TOKEN;
    const unset = await run(["--host", "0.0.0.0", "--token-env", "MADE_UP_MOCK_TOKEN"]);
    expect(unset.code).toBe(2);
    expect(unset.err).toContain("--token-env names MADE_UP_MOCK_TOKEN, which is not set or is empty");
  });

  it("usage errors exit 2, help exits 0", async () => {
    for (const argv of [[], ["keeper"], ["bogus"], ["keeper", "bogus"], ["keeper", "status", "--bogus"], ["mock-prices", "-c", "x.yaml"]]) {
      const r = await parse(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toEqual([]);
    }
    const help = await parse(["--help"]);
    expect(help.code).toBe(0);
    for (const word of ["keeper", "wallet", "mock-prices", "--debug"]) expect(help.out).toContain(word);
    const run = await parse(["keeper", "run", "--help"]);
    expect(run.code).toBe(0);
    for (const op of Object.keys(OPERATIONS)) expect(run.out).toContain(op);
    expect((await parse(["keeper", "status", "--debug"])).code).toBe(0); // global flags go anywhere
  });

  it("every command, argument and option has help text", () => {
    const program = buildProgram({ handlers: {} } as CliDeps, () => {});
    const seen: string[] = [];
    const walk = (cmd: Command): void => {
      seen.push(cmd.name());
      expect(cmd.description(), cmd.name()).not.toBe("");
      for (const o of cmd.options) expect(o.description, `${cmd.name()} ${o.flags}`).not.toBe("");
      for (const a of cmd.registeredArguments) expect(a.description, `${cmd.name()} ${a.name()}`).not.toBe("");
      cmd.commands.forEach(walk);
    };
    walk(program);
    expect(seen.sort()).toEqual(
      ["bazaar", "doctor", "earnings", "init", "keeper", "markets", "mock-prices", "opportunities", "run", "start", "status", "wallet"].sort(),
    );
  });
});

// ---- errors ----

describe("errors", () => {
  const failing = (e: unknown): MainOptions => ({ handlers: { status: async () => Promise.reject(e) } });

  it("a ConfigError or WalletError is its message alone, exit 2", async () => {
    const dir = tempDir();
    const cap = capture();
    expect(await main(["keeper", "status", "-c", join(dir, "missing.yaml")], { out: cap.io })).toBe(2);
    expect(cap.errText()).toMatch(/^no config at .*missing\.yaml; run `bazaar keeper init` to create one$/);
    const w = capture();
    const { WalletError } = await import("../src/exec/wallets.js");
    expect(await main(["keeper", "status"], { out: w.io, ...failing(new WalletError("wallet default: wrong keystore password")) })).toBe(2);
    expect(w.err).toEqual(["wallet default: wrong keystore password"]);
  });

  it("anything else is one line, exit 1, with the stack only under --debug or --verbose", async () => {
    const boom = new Error(`could not reach https://arb-mainnet.g.alchemy.com/v2/${KEY}.`);
    const a = capture();
    expect(await main(["keeper", "status"], { out: a.io, ...failing(boom) })).toBe(1);
    expect(a.err).toEqual(["error: could not reach https://arb-mainnet.g.alchemy.com/v2/***.  (run with --debug for details)"]);
    for (const flag of ["--debug", "--verbose"]) {
      const b = capture();
      expect(await main([flag, "keeper", "status"], { out: b.io, ...failing(boom) })).toBe(1);
      expect(b.errText()).toMatch(/^Error: could not reach https:\/\/arb-mainnet\.g\.alchemy\.com\/v2\/\*\*\*\.\n\s+at /);
      expect(b.errText()).not.toContain(KEY);
    }
    const c = capture();
    expect(await main(["keeper", "status", "--debug"], { out: c.io, ...failing(new ConfigError("bad")) })).toBe(2);
    expect(c.errText()).toMatch(/^ConfigError: bad\n\s+at /);
  });

  it("a CliExit carries its own code and message", async () => {
    const cap = capture();
    expect(await main(["keeper", "status"], { out: cap.io, ...failing(new CliExit(7, "seven")) })).toBe(7);
    expect(cap.err).toEqual(["seven"]);
  });
});

// ---- format ----

describe("format", () => {
  it("prints grouped, fixed-point, dollar and %g numbers", () => {
    expect(formatG(0.5)).toBe("0.5");
    expect(formatG(3000)).toBe("3000");
    expect(formatG(1.25)).toBe("1.25");
    expect(formatG(0)).toBe("0");
    expect(formatG(0.00015)).toBe("0.00015");
    expect(formatG(0.00001)).toBe("1e-05");
    expect(formatG(1234567)).toBe("1.23457e+06");
    expect(formatG(123456)).toBe("123456");
    expect(formatG(-2.5e-7)).toBe("-2.5e-07");
    expect(grouped(1234567)).toBe("1,234,567");
    expect(grouped(-1234)).toBe("-1,234");
    expect(grouped(999)).toBe("999");
    expect(grouped(12_345_678_901_234_567_890n)).toBe("12,345,678,901,234,567,890");
    expect(groupedFixed(3012.456, 2)).toBe("3,012.46");
    expect(groupedFixed(-0.5, 2)).toBe("-0.50");
    expect(utcTime(0)).toBe("1970-01-01 00:00:00 UTC");
    expect(utcTime(1_762_605_296.9, false)).toBe("2025-11-08 12:34 UTC");
  });

  it("aligns table columns, colour codes excluded", () => {
    const lines = table(["A", { header: "NUM", align: "right" }, "C"], [
      ["\x1b[32mlong-cell\x1b[39m", "1", "x"],
      ["b", "1234", ""],
    ]).map(stripAnsi);
    expect(lines).toEqual([" A           NUM  C", " long-cell     1  x", " b          1234"]);
  });

  it("redacts URLs inside any text, keeping the punctuation after them", () => {
    expect(redactUrls(`see https://x.io/v2/${KEY}, then (wss://y.io/?key=${KEY}).`)).toBe("see https://x.io/v2/***, then (wss://y.io/?key=***).");
    expect(redactUrls("nothing here")).toBe("nothing here");
    const e = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
    expect(errorText(e)).toBe("fetch failed (ECONNREFUSED)");
  });
});

// ---- doctor ----

/** A keeper with everything the doctor touches; `over` replaces parts of it. */
function fakeKeeper(over: Record<string, unknown> = {}) {
  const markets = [marketOf("BTC/USD", BTC), marketOf("ETH/USD", ETH)];
  const k: Record<string, unknown> & { closed: boolean } = {
    closed: false,
    net: { name: "anvil", chainId: 31337, factory: FACTORY, official: false },
    dep: null,
    chain: {
      chainId: async () => 31337,
      supportsOverrides: async () => true,
      blockNumber: async () => 1_000,
      balance: async () => 10n ** 17n,
      gasPrice: async () => 10n ** 8n,
    },
    reader: {
      deployment: async () => ({ factory: FACTORY, lens: ETH, terminator: BTC, oracle: BTC, usdc: BTC }),
      wiringProblems: async () => [],
      pairAddresses: async () => [BTC, ETH],
    },
    executor: { lens: FACTORY, baseFee: 0n, lanes: new Map([["default", { name: "default", address: WALLET }]]) },
    subgraph: null,
    prices: {
      fetch: async () => {},
      legs: (m: { label: string }) => (m.label === "BTC/USD" ? [{}] : null),
      fresh: () => true,
      ethUsd: () => null,
    },
    pro: {
      // a stream that brings one ETH/USD print at once
      stream: async function* () {
        yield [{}];
      },
    },
    signerChecks: 0,
    checkSigners: () => {
      (k.signerChecks as number) += 1;
    },
    store: { markets: new Map() },
    discoverMarkets: async () => markets,
    updateBlock: async () => {},
    resolveScopes: () => {},
    close: async () => {
      k.closed = true;
    },
    ...over,
  };
  return k;
}
const keeperClass = (k: unknown) => ({ create: async () => k }) as never;

describe("doctor", () => {
  const cfg = (http = "http://127.0.0.1:8545") =>
    parseConfig({
      network: "anvil",
      factory: FACTORY,
      rpc: { http },
      jobs: { liquidation: { allowLoss: true, maxLossUsdPerCall: 0.1, lossBudgetUsdPerDay: 2 }, triggers: {}, sweepExpired: {} },
    });

  it("reports each check", async () => {
    const cap = capture();
    const k = fakeKeeper();
    expect(await runDoctor(cfg(), { Keeper: keeperClass(k), out: cap.io })).toBe(true);
    expect(cap.out[0]).toMatch(/^✔ RPC            chain 31337, latency \d+ ms, eth_call state overrides supported$/);
    expect(cap.out.slice(1)).toEqual([
      `✔ Factory        ${FACTORY} not an official deployment, 2 market(s)`,
      "✔ Wiring         lens and terminator both point back at this factory",
      "⚠ Subgraph       none configured: the first start indexes from chain logs",
      "⚠ Prices         1/2 markets have a print",
      "⚠ Prices         no fresh, plausible ETH/USD print: gas is priced at the $3000 fallback (never below gas.ethUsdFloor, $1000)",
      "✔ Prices         the fixed_rate@200ms stream is delivering",
      `✔ Wallet default ${WALLET}, 0.10000 ETH (roughly 1,666 calls at today's base fee)`,
      "⚠ Jobs           liquidation takes losses: up to $0.1 a call, $2 a day",
      "⚠ Jobs           sweepExpired pays nothing; its daily loss budget is $0.25",
      "✔ Jobs           liquidation, triggers, sweepExpired",
    ]);
    expect(k.closed).toBe(true);
    expect((k.executor as { lens: string }).lens).toBe(ETH);
    expect(k.signerChecks).toBe(1); // installed once the deployment is read, before any price is
    expect([...(k.store as { markets: Map<string, unknown> }).markets.keys()]).toEqual([BTC, ETH]);
  });

  it("checks the price stream, and masks the token and the endpoint's key in what it says", async () => {
    const TOKEN = "made-up-pyth-pro-token-0123456789";
    const priced = (prices: Record<string, unknown>) =>
      parseConfig({ network: "anvil", factory: FACTORY, rpc: { http: "http://127.0.0.1:8545" }, prices: { token: TOKEN, ...prices } });
    const REST = `https://pro.example/${KEY}`;
    // A stream that fails: a warning that says what the keeper does instead, nothing secret in it.
    const down = capture();
    const quiet = fakeKeeper({
      pro: {
        stream: async function* () {
          throw new Error(`price stream unreachable: ${REST}/v1/stream refused Bearer ${TOKEN} (check the stream URLs and the token)`);
        },
      },
    });
    expect(await runDoctor(priced({ endpoint: "pyth", restUrl: REST, channel: "real_time", pollInterval: 2 }), { Keeper: keeperClass(quiet), out: down.io })).toBe(true);
    expect(down.out).toContain(
      "⚠ Prices         the real_time stream is not delivering (price stream unreachable: https://pro.example/***/v1/stream refused Bearer *** " +
        "(check the stream URLs and the token)): the keeper would poll the request API every 2 s instead",
    );
    expect(down.text()).not.toContain(TOKEN);
    expect(down.text()).not.toContain(KEY);
    // The request API failing is the failure; the stream is not asked after it.
    const refused = capture();
    let streamed = 0;
    const k = fakeKeeper({
      prices: {
        fetch: async () => Promise.reject(new Error(`price endpoint refused the request (HTTP 401) for ${TOKEN}; check the token (prices.token)`)),
      },
      pro: {
        stream: async function* () {
          streamed += 1;
        },
      },
    });
    expect(await runDoctor(priced({ endpoint: "pyth" }), { Keeper: keeperClass(k), out: refused.io })).toBe(false);
    expect(refused.out).toContain("✘ Prices         price endpoint refused the request (HTTP 401) for ***; check the token (prices.token)");
    expect(streamed).toBe(0);
    // With prices.stream off the keeper polls by choice: nothing to check.
    const polling = capture();
    expect(await runDoctor(priced({ endpoint: "pyth", stream: false }), { Keeper: keeperClass(fakeKeeper({ pro: null })), out: polling.io })).toBe(true);
    expect(polling.text()).not.toContain("stream");
  });

  it("masks every configured secret of four characters or more, a header value word by word, wherever a message quotes it", async () => {
    const conf = parseConfig({
      network: "anvil",
      factory: FACTORY,
      rpc: { http: "http://127.0.0.1:8545" },
      prices: { endpoint: "pyth", token: "tk42", headers: { Authorization: "Bearer hd55", "x-api-key": "k7y2" } },
      subgraph: { url: "none", apiKey: "sg77" },
      alerts: { telegram: { botToken: "bt1234", chatId: "1" } },
    });
    const cap = capture();
    const k = fakeKeeper({ prices: { fetch: async () => Promise.reject(new Error("refused tk42, sg77, bt1234, Bearer hd55, hd55 and k7y2")) } });
    expect(await runDoctor(conf, { Keeper: keeperClass(k), out: cap.io })).toBe(false);
    expect(cap.out).toContain("✘ Prices         refused ***, ***, ***, ***, *** and ***");
    for (const secret of ["tk42", "sg77", "bt1234", "hd55", "k7y2"]) expect(cap.text()).not.toContain(secret);
  });

  it("warns when prices.checkSigners is off: the gas price's print is then unchecked", async () => {
    const unchecked = (checkSigners: boolean) =>
      parseConfig({ network: "anvil", factory: FACTORY, rpc: { http: "http://127.0.0.1:8545" }, prices: { endpoint: "pyth", checkSigners } });
    const off = capture();
    expect(await runDoctor(unchecked(false), { Keeper: keeperClass(fakeKeeper()), out: off.io })).toBe(true);
    expect(off.out).toContain(`⚠ Prices         ${UNCHECKED_SIGNERS_WARNING}`);
    expect(UNCHECKED_SIGNERS_WARNING).toMatch(/^prices\.checkSigners is off: .*the ETH\/USD print that prices gas reaches no contract/);
    const on = capture();
    expect(await runDoctor(unchecked(true), { Keeper: keeperClass(fakeKeeper()), out: on.io })).toBe(true);
    expect(on.text()).not.toContain("checkSigners");
  });

  it("fails on wiring, a low balance, a broken subgraph or an unknown market", async () => {
    const cap = capture();
    const k = fakeKeeper({
      reader: {
        deployment: async () => ({ factory: FACTORY, lens: ETH, terminator: BTC, oracle: BTC, usdc: BTC }),
        wiringProblems: async () => ["the lens belongs to another factory"],
        pairAddresses: async () => [BTC],
      },
      subgraph: { meta: async () => Promise.reject(new Error(`HTTP 500 from https://gateway.thegraph.com/api/${KEY}/subgraphs/id/x`)) },
      chain: { ...(fakeKeeper().chain as object), balance: async () => 10n ** 15n },
      resolveScopes: () => {
        throw new ConfigError("no market called 'DOGE/USD'. Markets: BTC/USD, ETH/USD");
      },
    });
    expect(await runDoctor(cfg(), { Keeper: keeperClass(k), out: cap.io })).toBe(false);
    const text = cap.text();
    expect(text).toContain("✘ Wiring         the lens belongs to another factory");
    expect(text).toContain("✘ Subgraph       HTTP 500 from https://gateway.thegraph.com/api/***/subgraphs/id/x; the keeper falls back to chain logs");
    expect(text).toContain(`✘ Wallet default ${WALLET}, 0.00100 ETH: below budget.minEthBalance; fund it`);
    expect(text).toContain("✘ Jobs           no market called 'DOGE/USD'. Markets: BTC/USD, ETH/USD");
    expect(text).not.toContain(KEY);
  });

  it("a config or wallet problem at startup is one failed line", async () => {
    const cap = capture();
    const { WalletError } = await import("../src/exec/wallets.js");
    const Keeper = { create: async () => Promise.reject(new WalletError("wallet default: wrong keystore password")) } as never;
    expect(await runDoctor(cfg(), { Keeper, out: cap.io })).toBe(false);
    expect(cap.out).toEqual(["✘ Config         wallet default: wrong keystore password"]);
  });

  describe("a failing RPC never shows its key", () => {
    let server: Server;
    let base = "";
    const requests: string[] = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(`invalid key ${req.url}`);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const viaChain = (chain: Chain) => keeperClass(fakeKeeper({ chain }));

    it("over a local server that refuses the key", async () => {
      const url = `${base}/v2/${KEY}`;
      const cap = capture();
      expect(await runDoctor(cfg(url), { Keeper: viaChain(Chain.fromUrl(url, { retries: 0 })), out: cap.io })).toBe(false);
      expect(requests.at(-1)).toBe(`/v2/${KEY}`); // it did reach the server
      expect(cap.out).toEqual([
        `✘ RPC            ${base}/v2/*** unreachable: HTTP 401 from ${base}/v2/***: the provider refused the request; check the key in the URL`,
      ]);
      expect(cap.text()).not.toContain(KEY);
    });

    it("when nothing listens", async () => {
      const dead = createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const port = (dead.address() as AddressInfo).port;
      await new Promise<void>((r) => dead.close(() => r()));
      const url = `http://127.0.0.1:${port}/rpc?key=${KEY}`;
      const cap = capture();
      expect(await runDoctor(cfg(url), { Keeper: viaChain(Chain.fromUrl(url, { retries: 0 })), out: cap.io })).toBe(false);
      expect(cap.out).toEqual([`✘ RPC            http://127.0.0.1:${port}/rpc?key=*** unreachable: fetch failed (ECONNREFUSED)`]);
    });

    it("when the error quotes the raw URL", async () => {
      const url = `https://arb-mainnet.g.alchemy.com/v2/${KEY}`;
      const chain = { chainId: async () => Promise.reject(new Error(`cannot connect to ${url} (timeout)`)) };
      const cap = capture();
      expect(await runDoctor(cfg(url), { Keeper: keeperClass(fakeKeeper({ chain })), out: cap.io })).toBe(false);
      expect(cap.out).toEqual([
        "✘ RPC            https://arb-mainnet.g.alchemy.com/v2/*** unreachable: cannot connect to https://arb-mainnet.g.alchemy.com/v2/*** (timeout)",
      ]);
    });

    const engineReady = existsSync(new URL("../src/keeper/engine.ts", import.meta.url));
    it.skipIf(!engineReady)("with the real Keeper", async () => {
      const url = `${base}/v2/${KEY}`;
      const cap = capture();
      const real = parseConfig({ network: "anvil", factory: FACTORY, rpc: { http: url }, prices: { endpoint: base }, subgraph: { url: "none" } });
      expect(await runDoctor(real, { out: cap.io })).toBe(false);
      expect(cap.text()).toContain(`✘ RPC            ${base}/v2/*** unreachable`);
      expect(cap.text()).not.toContain(KEY);
    });
  });
});

// ---- status and earnings ----

describe("status and earnings", () => {
  const now = Date.now() / 1000;
  const status = (over: Record<string, unknown> = {}) => ({
    updated: now - 2,
    network: "anvil",
    factory: FACTORY,
    official: false,
    block: 12_345,
    indexed: 12_340,
    prices: { healthy: true, error: "", feeds: 3 },
    markets: [],
    jobs: {
      liquidation: {
        markets: 2,
        last: "BTC/USD liquidate 1 account(s) (confirmed)",
        today: { calls: 1, reward: 0.05, cost: 0.0123, net: 0.0377, claimed: 0, reverted: 0 },
      },
      collect: { markets: "all", last: "", today: {} },
    },
    wallets: { default: WALLET, fast: BTC },
    halted: "",
    ...over,
  });

  async function runStatus(file: unknown) {
    const dir = tempDir();
    const cfgPath = writeConfig(dir);
    const stateDir = join(dir, "keeper", "31337-5fbdb231");
    if (file !== undefined) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "status.json"), JSON.stringify(file), "utf8");
    }
    const seen: KeeperConfig[] = [];
    const cap = capture();
    const code = await main(["keeper", "status", "-c", cfgPath], {
      out: cap.io,
      engine: engine({ stateDirFor: (c: KeeperConfig) => (seen.push(c), stateDir) }),
    });
    return { code, out: cap.out, cfg: seen[0] };
  }

  it("renders a running keeper's status file", async () => {
    const r = await runStatus(status());
    expect(r.code).toBe(0);
    expect(r.cfg?.state.dir).toBeTruthy();
    expect(r.out).toEqual([
      "Bazaar keeper · anvil · block 12,345 · indexed 12,340 · prices live · running",
      `factory ${FACTORY} is not an official deployment`,
      " JOB          MARKETS  LAST ACTION                                 TODAY EARNED    GAS    NET",
      " liquidation        2  BTC/USD liquidate 1 account(s) (confirmed)         $0.05  $0.01  $0.04",
      " collect          all  -                                                  $0.00  $0.00  $0.00",
      " WALLET   ADDRESS",
      ` default  ${WALLET}`,
      ` fast     ${BTC}`,
    ]);
  });

  it("says when the keeper stopped, prices are down or sending is halted", async () => {
    const r = await runStatus(
      status({
        updated: now - 600,
        official: true,
        prices: { healthy: false, error: `price endpoint unreachable: https://h.io/v2/${KEY}`, feeds: 0 },
        halted: "sending paused: default holds 0.00100 ETH, below budget.minEthBalance",
        jobs: {},
        wallets: {},
      }),
    );
    expect(r.out).toEqual([
      "Bazaar keeper · anvil · block 12,345 · indexed 12,340 · prices down: price endpoint unreachable: https://h.io/v2/*** · not running (last seen 10 min ago)",
      "sending paused: default holds 0.00100 ETH, below budget.minEthBalance",
      " JOB  MARKETS  LAST ACTION  TODAY EARNED  GAS  NET",
      " WALLET  ADDRESS",
    ]);
  });

  it("without a status file", async () => {
    const r = await runStatus(undefined);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["No keeper has run with this config yet. Start one with bazaar keeper start."]);
  });

  it.skipIf(!existsSync(new URL("../src/keeper/engine.ts", import.meta.url)))("finds the status file with the real engine", async () => {
    const dir = tempDir();
    const cfgPath = writeConfig(dir);
    const stateDir = join(dir, "keeper", "31337-5fbdb231"); // chainId-factory[2:10]
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "status.json"), JSON.stringify(status()), "utf8");
    const cap = capture();
    expect(await main(["keeper", "status", "-c", cfgPath], { out: cap.io })).toBe(0);
    expect(cap.out[0]).toBe("Bazaar keeper · anvil · block 12,345 · indexed 12,340 · prices live · running");
  });

  describe("earnings from a snake_case ledger", () => {
    const dir = tempDir();
    const cfgPath = writeConfig(dir);
    const stateDir = join(dir, "state");
    const t = Math.floor(now);
    const line = (ts: number, job: string, market: string, status: string, cost: number, reward: number, claimed = 0) =>
      JSON.stringify({
        ts,
        job,
        market,
        wallet: "default",
        tx: "0x01",
        status,
        kind: "paid",
        cost_usd: cost,
        reward_usd: reward,
        expected_reward_usd: reward,
        claimed_usd: claimed,
        gas_used: 100000,
        summary: job,
        extra: {},
      });
    beforeAll(() => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "ledger.jsonl"),
        [
          line(t - 3600, "liquidation", "BTC/USD", "confirmed", 0.01, 0.05),
          line(t - 7200, "liquidation", "ETH/USD", "reverted", 0.02, 0),
          line(t - 1800, "collect", "BTC/USD", "confirmed", 0.005, 0, 12.5),
          line(t - 10 * 86_400, "triggers", "BTC/USD", "confirmed", 0.01, 1),
        ].join("\n") + "\n",
        "utf8",
      );
    });

    const earnings = async (...args: string[]) => {
      const cap = capture();
      const code = await main(["keeper", "earnings", "-c", cfgPath, ...args], { out: cap.io, engine: engine({ stateDirFor: () => stateDir }) });
      expect(code).toBe(0);
      return cap.out;
    };

    it("by job over the last 7 days", async () => {
      expect(await earnings()).toEqual([
        " JOB          CALLS  REVERTED   EARNED      GAS       NET  CLAIMED",
        " collect          1         0  $0.0000  $0.0050  $-0.0050   $12.50",
        " liquidation      2         1  $0.0500  $0.0300   $0.0200    $0.00",
      ]);
    });

    it("by market, over a longer or shorter period", async () => {
      expect(await earnings("--by", "market", "--since", "30d")).toEqual([
        " MARKET   CALLS  REVERTED   EARNED      GAS       NET  CLAIMED",
        " BTC/USD      3         0  $1.0500  $0.0250   $1.0250   $12.50",
        " ETH/USD      1         1  $0.0000  $0.0200  $-0.0200    $0.00",
      ]);
      expect((await earnings("--since", "45m")).map((l) => l.split(/\s+/)[1])).toEqual(["JOB", "collect"]);
      expect(await earnings("--since", "1m")).toEqual(["No transactions in that period."]);
    });
  });
});

// ---- commands against a stand-in keeper ----

describe("commands against the keeper", () => {
  const dir = tempDir();
  const cfgPath = writeConfig(dir, "jobs:\n  liquidation: {}\n  triggers: {}\n  adl: {}\n");

  it("start: Ctrl-C stops the keeper cleanly, then closes it", async () => {
    const events: string[] = [];
    let release = (): void => {};
    const k = {
      start: () => {
        events.push("start");
        return new Promise<void>((r) => (release = r));
      },
      stop: async () => {
        events.push("stop");
        release(); // the loop notices and start() returns
      },
      close: async () => void events.push("close"),
    };
    const created: KeeperConfig[] = [];
    const signals = new EventEmitter();
    const cap = capture();
    const done = main(["keeper", "start", "-c", cfgPath, "--only", "liquidation,adl", "--dry-run"], {
      out: cap.io,
      signals,
      engine: engine({ Keeper: { create: async (c: KeeperConfig) => (created.push(c), k) } }),
    });
    await vi.waitFor(() => expect(events).toEqual(["start"]));
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGINT");
    expect(await done).toBe(0);
    expect(events).toEqual(["start", "stop", "close"]);
    expect(cap.out).toContain("stopping: waiting for in-flight transactions…");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    const cfg = created[0]!;
    expect(Object.keys(enabledJobs(cfg.jobs))).toEqual(["liquidation", "adl"]);
    expect(cfg.jobs.triggers).toBeNull();
    expect(cfg.jobs.liquidation?.dryRun).toBe(true);
    expect(cfg.jobs.adl?.dryRun).toBe(true);
  });

  it("start: a second Ctrl-C leaves at once", async () => {
    let finishStop = (): void => {};
    const k = {
      start: () => new Promise<void>(() => {}),
      stop: () => new Promise<void>((r) => (finishStop = r)),
      close: async () => {},
    };
    const signals = new EventEmitter();
    const exits: number[] = [];
    const cap = capture();
    const done = main(["keeper", "start", "-c", cfgPath], {
      out: cap.io,
      signals,
      exit: ((code: number) => {
        exits.push(code);
        throw new Error("exited");
      }) as never,
      engine: engine({ Keeper: { create: async () => k } }),
    });
    await vi.waitFor(() => expect(signals.listenerCount("SIGINT")).toBe(1));
    signals.emit("SIGTERM");
    expect(() => signals.emit("SIGINT")).toThrow("exited");
    expect(exits).toEqual([130]);
    expect(cap.err).toContain("stopping now, without waiting for in-flight transactions");
    finishStop();
    expect(await done).toBe(0); // start() never returned (still connecting): the CLI does not wait for it
  }, 10_000);

  it("start: a keeper that cannot start is one line, exit 2", async () => {
    const k = { start: async () => Promise.reject(new ConfigError("refusing to start: the lens belongs to another factory")), close: async () => {} };
    const cap = capture();
    const code = await main(["keeper", "start", "-c", cfgPath], {
      out: cap.io,
      signals: new EventEmitter(),
      engine: engine({ Keeper: { create: async () => k } }),
    });
    expect(code).toBe(2);
    expect(cap.err).toEqual(["refusing to start: the lens belongs to another factory"]);
  });

  it("markets: every market with its status, hours, positions, orders and inventory", async () => {
    const markets = new Map<string, unknown>([
      [ETH, marketOf("ETH/USD", ETH, stateOf({ adlPending: true, longInv: { size: 25n * 10n ** 17n } }))],
      [BTC, marketOf("BTC/USD", BTC, stateOf())],
      ["0x3333333333333333333333333333333333333333", marketOf("0x33333333", "0x3333333333333333333333333333333333333333")],
    ]);
    const calls: unknown[] = [];
    const k = {
      store: {
        markets,
        positions: new Map([[BTC, new Map([[WALLET, {}], [ETH, {}]])]]),
        orders: new Map([[ETH, new Map([[1n, {}]])]]),
      },
      connect: async () => void calls.push("connect"),
      readStates: async (force: boolean, ms: unknown[]) => void calls.push(["readStates", force, ms.length]),
      now: () => 1_000,
      close: async () => void calls.push("close"),
    };
    const cap = capture();
    const code = await main(["keeper", "markets", "-c", cfgPath], {
      out: cap.io,
      engine: engine({ Keeper: { create: async (_c: unknown, opts: unknown) => (calls.push(["create", opts]), k) } }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["create", { loadWallets: false }], "connect", ["readStates", true, 3], "close"]);
    expect(cap.out).toEqual([
      " MARKET      ADDRESS                                     STATUS  HOURS    POSITIONS  LIVE ORDERS  INVENTORY",
      " 0x33333333  0x3333333333333333333333333333333333333333  ?       session          0            0          ?",
      ` BTC/USD     ${BTC}  live    24/7             2            0          0`,
      ` ETH/USD     ${ETH}  adl     session          0            1        2.5`,
    ]);
  });

  it("opportunities: each one described, or a line saying there are none", async () => {
    for (const found of [[], [{ describe: () => "finalizeTermination BTC/USD: … (ready now) — bazaar keeper run finalize --market BTC/USD" }]]) {
      let closed = false;
      const k = { close: async () => void (closed = true) };
      const cap = capture();
      const code = await main(["keeper", "opportunities", "-c", cfgPath], {
        out: cap.io,
        engine: engine({ Keeper: { create: async () => k } }),
        opportunities: (async () => ({ findOpportunities: async (kk: unknown) => (expect(kk).toBe(k), found) })) as never,
      });
      expect(code).toBe(0);
      expect(closed).toBe(true);
      expect(cap.out).toEqual(found.length ? [found[0]!.describe()] : ["Nothing is waiting for a manual call."]);
    }
  });

  describe("run", () => {
    const result = (init: ConstructorParameters<typeof ActionResult>[0], set: Partial<ActionResult> = {}) =>
      Object.assign(new ActionResult(init), set);

    const CALL = { to: BTC, data: "0x5c3a" as const, value: 7n };
    /** A planned scheduled termination, as Operations.planScheduledTermination returns one. */
    const plannedUnder = (under: "chain" | "storedPrice") => ({
      market: { address: ETH, label: "BTC/USD" },
      plan: { under, settlementPrice: (under === "chain" ? 2150n : 2000n) * 10n ** 18n, call: CALL },
      call: CALL,
      summary:
        under === "chain"
          ? "terminate BTC/USD at its cutoff under the chain rule (the median of five chained prices), settling at 2150"
          : "terminate BTC/USD at its cutoff at its stored price, 2000 (the last resort is open)",
      storedPriceTs: under === "chain" ? null : 1_700_000_000,
      notes: [],
    });

    function keeperWithOps(under: "chain" | "storedPrice" | "none" = "chain") {
      const calls: unknown[] = [];
      const stalePreview = result({ status: "simulated", job: "terminateStalePair", market: "BTC/USD", summary: "end BTC/USD (dead oracle)" }, { wouldSend: true, costUsd: 0.02 });
      const staleSent = result(
        { status: "confirmed", job: "terminateStalePair", market: "BTC/USD", summary: "end BTC/USD (dead oracle)" },
        { costUsd: 0.021, txHash: `0x${"12".repeat(32)}` },
      );
      const planned = under === "none" ? null : plannedUnder(under);
      const scheduled = (status: "simulated" | "confirmed") =>
        result(
          { status, job: "terminateScheduledPair", market: "BTC/USD", summary: planned?.summary ?? "", reason: under === "storedPrice" ? "this settles the market irreversibly at its stored price, 2000, stored 22 d 0 h ago (2023-11-14 22:13:20 UTC): no Pyth update proves it" : "" },
          status === "simulated" ? { wouldSend: true, costUsd: 0.03 } : { costUsd: 0.031, txHash: `0x${"34".repeat(32)}` },
        );
      const k = {
        run: {
          liquidate: async (...args: unknown[]) => {
            calls.push(["liquidate", ...args]);
            return [result({ status: "skipped", job: "liquidation", market: "BTC/USD", summary: "liquidation", reason: "no position is below its maintenance margin" })];
          },
          terminateStalePair: async (market: string, opts: { dryRun: boolean }) => {
            calls.push(["terminateStalePair", market, opts]);
            return opts.dryRun ? stalePreview : staleSent;
          },
          planScheduledTermination: async (market: string, opts: unknown) => {
            calls.push(["planScheduledTermination", market, opts]);
            return planned ?? result({ status: "skipped", job: "terminateScheduledPair", market: "BTC/USD", summary: "terminate BTC/USD at its cutoff", reason: "no settlement updates are available yet" });
          },
          sendScheduledTermination: async (p: { summary: string }, opts: { dryRun?: boolean }) => {
            calls.push(["sendScheduledTermination", p.summary, opts]);
            return scheduled(opts.dryRun ? "simulated" : "confirmed");
          },
          terminateScheduledPair: async (market: string, opts: { expect?: unknown }) => {
            calls.push(["terminateScheduledPair", market, { ...opts, expect: opts.expect === planned ? "the previewed plan" : opts.expect }]);
            return scheduled("confirmed");
          },
          factory: {
            activateIdentifierUpgrade: async (opts: unknown) => {
              calls.push(["activateIdentifierUpgrade", opts]);
              return result({ status: "skipped", job: "activateIdentifierUpgrade", market: "", summary: "activate", reason: "nothing queued" });
            },
          },
        },
        close: async () => void calls.push("close"),
      };
      return { k, calls };
    }

    const run = async (argv: string[], opts: MainOptions = {}, under: "chain" | "storedPrice" | "none" = "chain") => {
      const { k, calls } = keeperWithOps(under);
      const cap = capture();
      const code = await main(["keeper", "run", ...argv, "-c", cfgPath], {
        out: cap.io,
        isTTY: false,
        engine: engine({ Keeper: { create: async () => k } }),
        ...opts,
      });
      return { code, calls, out: cap.out, err: cap.err };
    };

    const prompts = (asked: string[], answer: boolean | Error) =>
      ({
        confirm: async (q: { message: string }) => {
          asked.push(q.message);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      }) as unknown as Prompts;

    it("an automatic job runs once and shows its results", async () => {
      const r = await run(["liquidate", "--market", "BTC/USD", "--accounts", WALLET, "--force"]);
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([["liquidate", "BTC/USD", [WALLET], { dryRun: false, force: true }], "close"]);
      expect(r.out).toEqual(["skipped  liquidation  BTC/USD  liquidation", "   no position is below its maintenance margin"]);
      const all = await run(["liquidate", "--market", "BTC/USD"]);
      expect(all.calls[0]).toEqual(["liquidate", "BTC/USD", undefined, { dryRun: false, force: false }]);
    });

    it("a manual operation is shown, and not sent without a terminal or --yes", async () => {
      const r = await run(["terminate-stale", "--market", "BTC/USD"]);
      expect(r.calls).toEqual([["terminateStalePair", "BTC/USD", { dryRun: true }], "close"]);
      expect(r.out).toEqual([
        "simulated  terminateStalePair  BTC/USD  end BTC/USD (dead oracle)",
        "   would earn $0.0000 for about $0.0200 of gas",
        "Not sent: pass --yes to send without confirming.",
      ]);
    });

    it("a manual operation is sent after a yes, or at once with --yes", async () => {
      const asked: string[] = [];
      const no = await run(["terminate-stale", "--market", "BTC/USD"], { isTTY: true, prompts: prompts(asked, false) });
      expect(no.calls).toEqual([["terminateStalePair", "BTC/USD", { dryRun: true }], "close"]);
      const ctrlC = await run(["terminate-stale", "--market", "BTC/USD"], {
        isTTY: true,
        prompts: prompts(asked, Object.assign(new Error("closed"), { name: "ExitPromptError" })),
      });
      expect(ctrlC.code).toBe(0);
      expect(ctrlC.calls).toHaveLength(2);
      const yes = await run(["terminate-stale", "--market", "BTC/USD"], { isTTY: true, prompts: prompts(asked, true) });
      expect(asked).toEqual(["Send it?", "Send it?", "Send it?"]);
      expect(yes.calls).toEqual([
        ["terminateStalePair", "BTC/USD", { dryRun: true }],
        ["terminateStalePair", "BTC/USD", { dryRun: false }],
        "close",
      ]);
      expect(yes.out.slice(-3)).toEqual([
        "confirmed  terminateStalePair  BTC/USD  end BTC/USD (dead oracle)",
        "   earned $0.0000, gas $0.0210",
        `   tx 0x${"12".repeat(32)}`,
      ]);
      const flag = await run(["terminate-stale", "--market", "BTC/USD", "--yes"]);
      expect(flag.calls).toHaveLength(3);
      expect(flag.out[0]).toBe("confirmed  terminateStalePair  BTC/USD  end BTC/USD (dead oracle)"); // no preview
      const dry = await run(["terminate-stale", "--market", "BTC/USD", "--dry-run", "--yes"]);
      expect(dry.calls).toHaveLength(2);
    });

    it("a manual operation that cannot run is shown, not confirmed", async () => {
      const r = await run(["activate-identifier-upgrade"], { isTTY: true });
      expect(r.calls).toEqual([["activateIdentifierUpgrade", { dryRun: true }], "close"]);
      expect(r.out).toEqual(["skipped  activateIdentifierUpgrade    activate", "   nothing queued"]);
    });

    it("terminate-scheduled sends the very settlement it showed, after a yes that says it is irreversible", async () => {
      const asked: string[] = [];
      const r = await run(["terminate-scheduled", "--market", "BTC/USD"], { isTTY: true, prompts: prompts(asked, true) });
      expect(r.code).toBe(0);
      // Planned once, the call shown simulated, then sent only if the plan made at sending is that one.
      expect(r.calls).toEqual([
        ["planScheduledTermination", "BTC/USD", { storedPrice: undefined }],
        ["sendScheduledTermination", plannedUnder("chain").summary, { dryRun: true }],
        ["terminateScheduledPair", "BTC/USD", { storedPrice: undefined, acceptStoredPrice: false, expect: "the previewed plan" }],
        "close",
      ]);
      expect(asked).toEqual(["Send it? It fixes the settlement price for good, at the price shown."]);
      expect(r.out[0]).toBe(`simulated  terminateScheduledPair  BTC/USD  ${plannedUnder("chain").summary}`);
      expect(r.out.slice(-3)).toEqual([
        `confirmed  terminateScheduledPair  BTC/USD  ${plannedUnder("chain").summary}`,
        "   earned $0.0000, gas $0.0310",
        `   tx 0x${"34".repeat(32)}`,
      ]);
      // --yes skips the question, never the preview; --dry-run stops after it.
      const yes = await run(["terminate-scheduled", "--market", "BTC/USD", "--yes"]);
      expect(yes.calls.map((c) => (Array.isArray(c) ? c[0] : c))).toEqual(["planScheduledTermination", "sendScheduledTermination", "terminateScheduledPair", "close"]);
      expect(yes.out[0]).toMatch(/^simulated/);
      const dry = await run(["terminate-scheduled", "--market", "BTC/USD", "--dry-run", "--yes"]);
      expect(dry.calls).toHaveLength(3);
      // Nothing to send: the reason, and nothing asked.
      const none = await run(["terminate-scheduled", "--market", "BTC/USD", "--yes"], {}, "none");
      expect(none.calls).toEqual([["planScheduledTermination", "BTC/USD", { storedPrice: undefined }], "close"]);
      expect(none.out).toEqual(["skipped  terminateScheduledPair  BTC/USD  terminate BTC/USD at its cutoff", "   no settlement updates are available yet"]);
    });

    it("terminate-scheduled sends a settlement at the stored price only with --accept-stored-price, even with --yes", async () => {
      const refused = await run(["terminate-scheduled", "--market", "BTC/USD", "--stored-price", "always", "--yes"], {}, "storedPrice");
      expect(refused.calls).toEqual([
        ["planScheduledTermination", "BTC/USD", { storedPrice: "always" }],
        ["sendScheduledTermination", plannedUnder("storedPrice").summary, { dryRun: true }],
        "close",
      ]);
      expect(refused.out).toEqual([
        `simulated  terminateScheduledPair  BTC/USD  ${plannedUnder("storedPrice").summary}`,
        "   this settles the market irreversibly at its stored price, 2000, stored 22 d 0 h ago (2023-11-14 22:13:20 UTC): no Pyth update proves it",
        "   would earn $0.0000 for about $0.0300 of gas",
        "Not sent: this settles the market at its stored price, which no Pyth update proves. Pass --accept-stored-price to send it.",
      ]);
      const asked: string[] = [];
      const accepted = await run(["terminate-scheduled", "--market", "BTC/USD", "--accept-stored-price"], { isTTY: true, prompts: prompts(asked, true) }, "storedPrice");
      expect(asked).toEqual(["Send it? It fixes the settlement price for good, at the market's stored price, which no Pyth update proves."]);
      expect(accepted.calls[2]).toEqual(["terminateScheduledPair", "BTC/USD", { storedPrice: undefined, acceptStoredPrice: true, expect: "the previewed plan" }]);
    });

    it("refuses the stored-price flags on any other operation, and a policy it does not know", async () => {
      for (const argv of [
        ["terminate-stale", "--market", "BTC/USD", "--accept-stored-price"],
        ["finalize", "--market", "BTC/USD", "--stored-price", "always"],
      ]) {
        const r = await run(argv);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.calls).toEqual([]);
        expect(r.err.join("\n")).toContain("--stored-price and --accept-stored-price apply to terminate-scheduled only");
      }
      const bad = await run(["terminate-scheduled", "--market", "BTC/USD", "--stored-price", "sometimes"]);
      expect(bad.code).toBe(2);
      expect(bad.err.join("\n")).toMatch(/Allowed choices are whenAbsent, always, never/);
    });
  });

  it("renders action results", () => {
    const cap = capture();
    const r = Object.assign(new ActionResult({ status: "confirmed", job: "collect", market: "", summary: "collect 2 market(s)" }), {
      costUsd: 0.01,
      rewardUsd: 0,
      claimedUsd: 12.345,
      txHash: `0x${"ab".repeat(32)}` as const,
    });
    renderResult(r, cap.io);
    const early = new ActionResult({ status: "skipped", job: "terminateStalePair", market: "BTC/USD", summary: "end BTC/USD", reason: "too early" });
    Object.defineProperty(early, "opensAt", { value: 1_762_605_296 });
    renderResult(early, cap.io);
    expect(cap.out).toEqual([
      "confirmed  collect    collect 2 market(s)",
      "   earned $0.0000, gas $0.0100, claimed $12.35",
      `   tx 0x${"ab".repeat(32)}`,
      "skipped  terminateStalePair  BTC/USD  end BTC/USD",
      "   too early",
      "   opens at 2025-11-08 12:34:56 UTC",
    ]);
  });
});

// ---- wallet ----

describe("wallet", () => {
  const passwords = (...answers: (string | Error)[]) => {
    const asked: string[] = [];
    const prompts = {
      password: async (q: { message: string }) => {
        asked.push(q.message);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a ?? "";
      },
    } as unknown as Prompts;
    return { prompts, asked };
  };

  it("new writes an encrypted keystore and shows the config to use it", async () => {
    const path = join(tempDir(), "keys", "fast.json");
    const { prompts, asked } = passwords("pw-1", "pw-1");
    const cap = capture();
    expect(await main(["wallet", "new", "--name", "fast", "--path", path], { out: cap.io, prompts })).toBe(0);
    expect(asked).toEqual(["Choose a password for the keystore:", "Repeat it:"]);
    const ks = JSON.parse(readFileSync(path, "utf8")) as { address: string; version: number };
    expect(ks.version).toBe(3);
    expect(cap.out[0]).toMatch(new RegExp(`^✔ 0x${ks.address} saved encrypted at `, "i"));
    expect(cap.out.slice(1)).toEqual([
      "Fund it with a little ETH for gas. No keeper call needs USDC or an approval.",
      "In bazaar-keeper.yaml:",
      "  wallets:",
      "    fast:",
      "      type: keystore",
      `      path: ${path}`,
      "      password: ${KEEPER_KEYSTORE_PASSWORD}   # in .env, or leave out to be asked at start",
    ]);
  }, 20_000);

  it("refuses mismatched passwords, a bad key and an existing file before writing anything", async () => {
    const dir = tempDir();
    const path = join(dir, "k.json");
    const a = capture();
    expect(await main(["wallet", "new", "--path", path], { out: a.io, prompts: passwords("one", "two").prompts })).toBe(1);
    expect(a.err).toEqual(["The passwords did not match."]);
    expect(existsSync(path)).toBe(false);

    const b = capture();
    const bad = passwords("0x1234");
    expect(await main(["wallet", "import", "--path", path], { out: b.io, prompts: bad.prompts })).toBe(2);
    expect(b.err).toEqual(["not a valid private key: it must be 32 bytes of hex"]);
    expect(bad.asked).toEqual(["Private key (hex):"]);

    const c = capture();
    const cancel = passwords(Object.assign(new Error("closed"), { name: "ExitPromptError" }));
    expect(await main(["wallet", "new", "--path", path], { out: c.io, prompts: cancel.prompts })).toBe(1);
    expect(c.err).toEqual(["Cancelled; no keystore was written."]);

    writeFileSync(path, "{}", "utf8");
    const d = capture();
    const none = passwords();
    expect(await main(["wallet", "new", "--path", path], { out: d.io, prompts: none.prompts })).toBe(2);
    expect(d.err).toEqual([`${path} already exists`]);
    expect(none.asked).toEqual([]);
  });

  it("list shows each wallet's balance and what it can claim", async () => {
    const k = {
      connect: async () => {},
      executor: { lanes: new Map([["default", { address: WALLET }], ["fast", { address: BTC }]]) },
      chain: { balance: async (a: string) => (a === WALLET ? 123_456_789_000_000_000n : 0n) },
      reader: { claimable: async (a: string) => (a === WALLET ? new Map([[BTC, 2n * 10n ** 18n], [ETH, 5n * 10n ** 17n]]) : new Map()) },
      close: async () => {},
    };
    const cap = capture();
    const cfgPath = writeConfig(tempDir());
    expect(await main(["wallet", "list", "-c", cfgPath], { out: cap.io, engine: engine({ Keeper: { create: async () => k } }) })).toBe(0);
    expect(cap.out).toEqual([
      " WALLET   ADDRESS                                         ETH  CLAIMABLE",
      ` default  ${WALLET}  0.12346  $2.50 across 2 market(s)`,
      ` fast     ${BTC}  0.00000  $0.00 across 0 market(s)`,
    ]);
  });
});

// ---- wizard ----

type Kind = "select" | "input" | "confirm" | "password" | "checkbox";
/** [kind, message prefix, answer]; an undefined answer to an input takes its default. */
type Step = readonly [Kind, string, unknown];

interface Asked {
  message: string;
  default?: unknown;
  validate?: (v: string) => boolean | string;
  choices?: readonly PromptChoice<unknown>[];
}

/** Prompts that answer from a script, in order, checking each question, choice and validation. */
function scripted(steps: readonly Step[]) {
  let i = 0;
  const take = (kind: Kind, q: Asked): unknown => {
    const step = steps[i++];
    if (!step) throw new Error(`unexpected ${kind} prompt "${q.message}"`);
    const [k, msg, answer] = step;
    if (k !== kind || !q.message.startsWith(msg)) throw new Error(`step ${i}: expected ${k} "${msg}", got ${kind} "${q.message}"`);
    if (answer instanceof Error) throw answer;
    const a = kind === "input" && answer === undefined ? (q.default ?? "") : answer;
    if (q.validate && typeof a === "string") {
      const v = q.validate(a);
      if (v !== true) throw new Error(`step ${i}: "${a}" fails the validation of "${q.message}": ${String(v)}`);
    }
    if (kind === "select") {
      const choice = q.choices?.find((c) => c.value === a);
      if (!choice || choice.disabled) throw new Error(`step ${i}: ${String(a)} is not an enabled choice of "${q.message}"`);
    }
    if (kind === "checkbox") {
      for (const x of a as unknown[]) if (!q.choices?.some((c) => c.value === x)) throw new Error(`step ${i}: ${String(x)} is not a choice`);
    }
    return a;
  };
  const prompts: Prompts = {
    select: async <T>(q: { message: string; choices: readonly PromptChoice<T>[] }) => take("select", q as Asked) as T,
    input: async (q) => take("input", q) as string,
    confirm: async (q) => take("confirm", q) as boolean,
    password: async (q) => take("password", q) as string,
    checkbox: async <T>(q: { message: string; choices: readonly PromptChoice<T>[] }) => take("checkbox", q as Asked) as T[],
  };
  return { prompts, done: () => i === steps.length, at: () => i };
}

const ENV_NAMES = ["RPC_HTTP_URL", "SUBGRAPH_URL", "PYTH_PRO_TOKEN", "PRICE_ENDPOINT_URL", "PRICE_TOKEN", "KEEPER_KEYSTORE_PASSWORD", "OTHER"];
function clearEnv(): void {
  for (const n of ENV_NAMES) delete process.env[n];
}

describe("wizard", () => {
  const RPC = `https://arb-sepolia.g.alchemy.com/v2/${KEY}`;
  const BAD_RPC = `https://bad.example/v2/${KEY}`;
  const SG = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/Qm123`;
  const PYTH_TOKEN = "made-up-pyth-pro-token-0123456789";
  const PW = "correct horse#battery $1";
  const FORWARD = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
  /** BTC/USD relisted after a termination: a second market with the same label */
  const RELISTED = "0x3333333333333333333333333333333333333333";

  function deps(over: Record<string, unknown> = {}) {
    const cap = capture();
    const keystores: [string, string, string][] = [];
    const listed: KeeperConfig[] = [];
    return {
      cap,
      keystores,
      listed,
      d: {
        out: cap.io,
        isTTY: true,
        chainId: async (url: string) => {
          if (url === BAD_RPC) throw new Error(`HTTP 401 from ${url}`);
          if (url.includes("mainnet")) return 1;
          return url.includes("arb1") ? 42161 : 31337;
        },
        priceCheck: async () => "ETH/USD print 3,012.46",
        listMarkets: async (cfg: KeeperConfig) => {
          listed.push(cfg);
          return [
            { label: "ETH/USD", address: ETH },
            { label: "BTC/USD", address: RELISTED },
            { label: "BTC/USD", address: BTC },
            { label: "ETH/USD", address: ETH.toLowerCase() }, // listed twice: one choice
          ];
        },
        newKey: () => `0x${"11".repeat(32)}` as const,
        writeKeystore: async (key: string, pw: string, path: string) => {
          keystores.push([key, pw, path]);
          return "0x000000000000000000000000000000000000dEaD";
        },
        ...over,
      },
    };
  }

  it("writes the config with every secret and URL in .env", async () => {
    const dir = tempDir();
    const keysDir = join(dir, "keys");
    mkdirSync(keysDir);
    writeFileSync(join(keysDir, "default.json"), "{}", "utf8"); // taken: the new wallet goes beside it
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "# old comment\nOTHER=1\nRPC_HTTP_URL=old\n", "utf8");
    const cfgPath = join(dir, "bazaar-keeper.yaml");
    const s = scripted([
      ["select", "Network", "anvil"],
      ["input", "Factory address", FACTORY.toLowerCase()],
      ["input", "RPC URL", BAD_RPC],
      ["input", "RPC URL", "https://eth-mainnet.example/rpc"],
      ["input", "RPC URL", RPC],
      ["select", "Subgraph", "custom"],
      ["input", "Subgraph GraphQL URL", SG],
      ["select", "Price endpoint", "pyth"],
      ["password", "Pyth Pro access token", ` ${PYTH_TOKEN}\n`], // pasted with blanks around it
      ["select", "Keeper wallet", "new"],
      ["password", "Choose a keystore password", "first"],
      ["password", "Repeat it", "second"],
      ["password", "Choose a keystore password", PW],
      ["password", "Repeat it", PW],
      ["confirm", "Store the keystore password in .env", true],
      ["checkbox", "Jobs to run automatically", ["liquidation", "triggers", "collect"]],
      ["confirm", "Should any job also send calls", true],
      ["checkbox", "Which jobs may take losses", ["liquidation"]],
      ["input", "Largest loss per call", "0.1"],
      ["input", "Daily loss budget per job", undefined],
      ["select", "Markets for Liquidation", "choose"],
      ["checkbox", "Markets for Liquidation", [BTC, RELISTED]],
      ["select", "Markets for Trigger execution", "same"],
      ["input", "Collect when a market's balance reaches", undefined],
      ["input", "Forward collected USDC", FORWARD],
    ]);
    // No keysDir: the default, keys/ next to the config.
    const shown: unknown[] = [];
    const prompts: Prompts = {
      ...s.prompts,
      checkbox: async <T>(q: { message: string; choices: readonly PromptChoice<T>[] }) => {
        if (q.message.startsWith("Markets for")) shown.push(q.choices.map((c) => [c.name, c.value]));
        return s.prompts.checkbox(q);
      },
    };
    const { d, cap, keystores, listed } = deps({ prompts });
    await runWizard(cfgPath, d);
    expect(s.done()).toBe(true);
    // Each market is a choice of its own, by label and address, even where labels repeat.
    expect(shown).toEqual([
      [
        [`BTC/USD  ${BTC}`, BTC],
        [`BTC/USD  ${RELISTED}`, RELISTED],
        [`ETH/USD  ${ETH}`, ETH],
      ],
    ]);

    const ksPath = join(keysDir, "default-2.json");
    expect(keystores).toEqual([[`0x${"11".repeat(32)}`, PW, ksPath]]);
    const yaml = readFileSync(cfgPath, "utf8");
    expect(yaml).toBe(
      [
        "# Written by bazaar keeper init. Secrets live in .env next to this file.",
        "",
        "network: anvil",
        `factory: "${FACTORY}"`,
        "",
        "rpc:",
        "  http: ${RPC_HTTP_URL}",
        "",
        "subgraph:",
        "  url: ${SUBGRAPH_URL}",
        "",
        "prices:",
        "  endpoint: pyth",
        "  token: ${PYTH_PRO_TOKEN}",
        "",
        "wallets:",
        "  default:",
        "    type: keystore",
        `    path: ${ksPath}`,
        "    password: ${KEEPER_KEYSTORE_PASSWORD}",
        "",
        "jobs:",
        "  liquidation:",
        "    markets:",
        `      - "${BTC}"  # BTC/USD`,
        `      - "${RELISTED}"  # BTC/USD`,
        "    allowLoss: true",
        "    maxLossUsdPerCall: 0.1",
        "    lossBudgetUsdPerDay: 1",
        "  triggers:",
        "    markets:",
        `      - "${BTC}"  # BTC/USD`,
        `      - "${RELISTED}"  # BTC/USD`,
        "  collect:",
        "    thresholdUsd: 5",
        `    forwardTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906"`,
        "",
        "# The snapshot, the earnings ledger and the status file, so a restart resumes where it stopped.",
        "state:",
        `  dir: ${join(dir, "state")}`,
        "",
      ].join("\n"),
    );
    for (const secret of [KEY, PYTH_TOKEN, PW, "correct horse"]) expect(yaml).not.toContain(secret);

    const envText = readFileSync(envPath, "utf8");
    expect(envText).toBe(`OTHER=1\nRPC_HTTP_URL=${RPC}\nSUBGRAPH_URL=${SG}\nPYTH_PRO_TOKEN=${PYTH_TOKEN}\nKEEPER_KEYSTORE_PASSWORD='${PW}'\n`);
    expect(parseDotenv(envText)).toEqual({ OTHER: "1", RPC_HTTP_URL: RPC, SUBGRAPH_URL: SG, PYTH_PRO_TOKEN: PYTH_TOKEN, KEEPER_KEYSTORE_PASSWORD: PW });
    if (process.platform !== "win32") expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // What the wizard printed: each check, no key.
    expect(cap.out).toEqual([
      "✘ HTTP 401 from https://bad.example/v2/***",
      "✘ that RPC is on chain 1, not 31337",
      "✔ chain 31337",
      "✔ ETH/USD print 3,012.46",
      "The passwords did not match.",
      `✔ 0x000000000000000000000000000000000000dEaD encrypted at ${ksPath}. Fund it with a little ETH for gas.`,
      `✔ wrote ${cfgPath} and ${envPath} (secrets only in .env)`,
      "Next: bazaar keeper doctor, then bazaar keeper start",
    ]);
    // The market listing got the real URL and token, in memory only.
    expect(listed[0]).toMatchObject({ network: "anvil", factory: FACTORY, rpc: { http: RPC }, prices: { endpoint: "pyth", token: PYTH_TOKEN }, subgraph: { url: "none" } });

    // The keeper loads what was written, with the secrets filled from .env.
    clearEnv();
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.rpc.http).toBe(RPC);
      expect(cfg.subgraph.url).toBe(SG);
      expect(cfg.prices).toMatchObject({ endpoint: "pyth", token: PYTH_TOKEN });
      expect(cfg.wallets.default).toMatchObject({ type: "keystore", path: ksPath, password: PW });
      expect(cfg.jobs.liquidation).toMatchObject({ markets: [BTC, RELISTED], allowLoss: true, maxLossUsdPerCall: 0.1, lossBudgetUsdPerDay: 1 });
      expect(cfg.jobs.triggers?.markets).toEqual([BTC, RELISTED]);
      expect(cfg.jobs.collect).toMatchObject({ thresholdUsd: 5, forwardTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" });
      expect(cfg.state.dir).toBe(join(dir, "state"));
    } finally {
      clearEnv();
    }
  });

  it("a custom price endpoint, an existing keystore, the sequencer, and no jobs", async () => {
    const dir = tempDir();
    const cfgPath = join(dir, "bazaar-keeper.yaml");
    writeFileSync(cfgPath, "old", "utf8");
    const ks = join(dir, "my keystore.json");
    writeFileSync(ks, "{}", "utf8");
    const PRICE_URL = `https://pro.example/${KEY}/v1`;
    const s = scripted([
      ["confirm", `${cfgPath} exists. Replace it?`, true],
      ["select", "Network", "arbitrum-one"],
      ["input", "Factory address", FACTORY],
      ["input", "RPC URL", "https://arb1.example/rpc"],
      ["confirm", "Submit transactions straight to the sequencer", true],
      ["select", "Subgraph", "none"],
      ["select", "Price endpoint", "custom"],
      ["input", "Price endpoint URL", PRICE_URL],
      ["confirm", "Does it need an access token?", true],
      ["password", "Access token", "made-up-price-token"],
      ["select", "Keeper wallet", "keystore"],
      ["input", "Keystore file", ks],
      ["confirm", "Store the keystore password in .env", false],
      ["checkbox", "Jobs to run automatically", []],
    ]);
    const { d, cap, listed } = deps({
      prompts: s.prompts,
      priceCheck: async () => Promise.reject(new Error(`price endpoint unreachable: ${PRICE_URL}`)),
    });
    await runWizard(cfgPath, d);
    expect(s.done()).toBe(true);
    expect(listed).toEqual([]); // no job: no market listing
    const yaml = readFileSync(cfgPath, "utf8");
    expect(yaml).toBe(
      [
        "# Written by bazaar keeper init. Secrets live in .env next to this file.",
        "",
        "network: arbitrum-one",
        `factory: "${FACTORY}"`,
        "",
        "rpc:",
        "  http: ${RPC_HTTP_URL}",
        "  send: sequencer",
        "",
        "subgraph:",
        "  url: none",
        "",
        "prices:",
        "  endpoint: ${PRICE_ENDPOINT_URL}",
        "  token: ${PRICE_TOKEN}",
        "",
        "wallets:",
        "  default:",
        "    type: keystore",
        `    path: ${ks}`,
        "",
        "jobs:",
        "  {}",
        "",
        "# The snapshot, the earnings ledger and the status file, so a restart resumes where it stopped.",
        "state:",
        `  dir: ${join(dir, "state")}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      `RPC_HTTP_URL=https://arb1.example/rpc\nPRICE_ENDPOINT_URL=${PRICE_URL}\nPRICE_TOKEN=made-up-price-token\n`,
    );
    expect(cap.out).toContain("⚠ could not read a print yet: price endpoint unreachable: https://pro.example/***/v1");
    expect(cap.text()).not.toContain(KEY);
    clearEnv();
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.prices).toMatchObject({ endpoint: PRICE_URL, token: "made-up-price-token" });
      expect(cfg.rpc.send).toBe("sequencer");
      expect(Object.keys(enabledJobs(cfg.jobs))).toEqual([]);
    } finally {
      clearEnv();
    }
  });

  it("refuses a Hermes URL as the price endpoint: the Pyth Pro token would go there", async () => {
    const dir = tempDir();
    const s = scripted([
      ["select", "Network", "anvil"],
      ["input", "Factory address", FACTORY],
      ["input", "RPC URL", "http://127.0.0.1:8545"],
      ["select", "Subgraph", "none"],
      ["select", "Price endpoint", "custom"],
      ["input", "Price endpoint URL", "https://hermes.example/v2"],
    ]);
    const { d } = deps({ prompts: s.prompts });
    await expect(runWizard(join(dir, "bazaar-keeper.yaml"), d)).rejects.toThrow(
      /fails the validation of "Price endpoint URL": prices\.endpoint names a Hermes \(Pyth Core\) service/,
    );
    expect(s.done()).toBe(true);
  });

  it("a custom network; jobs keep running on all markets when they cannot be listed", async () => {
    const dir = tempDir();
    const cfgPath = join(dir, "sub", "keeper.yaml");
    const s = scripted([
      ["select", "Network", "custom"],
      ["input", "Chain id", "31337"],
      ["input", "Factory address", FACTORY],
      ["input", "The factory's deployment block", "12"],
      ["input", "RPC URL", "http://127.0.0.1:8545"],
      ["select", "Subgraph", "none"],
      ["select", "Price endpoint", "custom"],
      ["input", "Price endpoint URL", "http://127.0.0.1:8787"],
      ["confirm", "Does it need an access token?", false],
      ["select", "Keeper wallet", "none"],
      ["checkbox", "Jobs to run automatically", ["adl", "sweepExpired"]],
      ["confirm", "Should any job also send calls", false],
    ]);
    const { d, cap } = deps({ prompts: s.prompts, listMarkets: async () => Promise.reject(new Error("the RPC is on chain 1")) });
    await runWizard(cfgPath, d);
    expect(s.done()).toBe(true);
    expect(cap.out).toContain("⚠ could not list markets (the RPC is on chain 1); every job will run on all markets");
    const yaml = readFileSync(cfgPath, "utf8");
    expect(yaml).toContain('network: custom\nchainId: 31337\nfactory: "0x5FbDB2315678afecb367f032d93F642f64180aa3"\nstartBlock: 12\n');
    expect(yaml).toContain("\njobs:\n  adl: {}\n  sweepExpired: {}\n");
    expect(yaml).not.toContain("wallets:");
    clearEnv();
    try {
      const cfg = loadConfig(cfgPath);
      expect(Object.keys(enabledJobs(cfg.jobs))).toEqual(["adl", "sweepExpired"]);
      expect(cfg.startBlock).toBe(12);
    } finally {
      clearEnv();
    }
  });

  it("keeps the keystore and the state next to the config, and a new wallet's password in .env only if told to", async () => {
    // The Docker flow runs `keeper init` and then `keeper start` in containers that share only the
    // directory mounted at /config, so all the keeper keeps must land there, not in the container's home.
    const dir = tempDir();
    const cfgPath = join(dir, "bazaar-keeper.yaml");
    const s = scripted([
      ["select", "Network", "anvil"],
      ["input", "Factory address", FACTORY],
      ["input", "RPC URL", "http://127.0.0.1:8545"],
      ["select", "Subgraph", "none"],
      ["select", "Price endpoint", "custom"],
      ["input", "Price endpoint URL", "http://127.0.0.1:8787"],
      ["confirm", "Does it need an access token?", false],
      ["select", "Keeper wallet", "new"],
      ["password", "Choose a keystore password", PW],
      ["password", "Repeat it", PW],
      ["confirm", "Store the keystore password in .env", false],
      ["checkbox", "Jobs to run automatically", []],
    ]);
    const { d, keystores } = deps({ prompts: s.prompts });
    await runWizard(cfgPath, d);
    expect(s.done()).toBe(true);
    const ksPath = join(dir, "keys", "default.json");
    expect(keystores).toEqual([[`0x${"11".repeat(32)}`, PW, ksPath]]);
    const yaml = readFileSync(cfgPath, "utf8");
    expect(yaml).toContain(`\nwallets:\n  default:\n    type: keystore\n    path: ${ksPath}\n\njobs:\n`);
    expect(yaml).toContain(`\nstate:\n  dir: ${join(dir, "state")}\n`);
    expect(yaml).not.toContain("KEEPER_KEYSTORE_PASSWORD");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("RPC_HTTP_URL=http://127.0.0.1:8545\nPRICE_ENDPOINT_URL=http://127.0.0.1:8787\n");
    clearEnv();
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.wallets.default).toMatchObject({ type: "keystore", path: ksPath });
      expect(cfg.wallets.default!.password ?? null).toBeNull();
      // The snapshot, the ledger and status.json: under the same directory.
      const { stateDirFor } = await import("../src/keeper/engine.js");
      expect(stateDirFor(cfg).startsWith(join(dir, "state"))).toBe(true);
    } finally {
      clearEnv();
    }
  });

  it("needs a terminal, and Ctrl-C writes nothing", async () => {
    const dir = tempDir();
    const cfgPath = join(dir, "bazaar-keeper.yaml");
    const notty = deps({ isTTY: false, prompts: scripted([]).prompts });
    await expect(runWizard(cfgPath, notty.d)).rejects.toMatchObject({ code: 2, message: expect.stringContaining("init needs an interactive terminal") });
    const s = scripted([
      ["select", "Network", "anvil"],
      ["input", "Factory address", FACTORY],
      ["input", "RPC URL", Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" })],
    ]);
    const { d, cap } = deps({ prompts: s.prompts });
    await expect(runWizard(cfgPath, d)).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(cap.out).toEqual(["Setup cancelled; nothing was written."]);
    expect(existsSync(cfgPath)).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
    // Through the CLI: exit 1.
    const cli = capture();
    const again = scripted([["select", "Network", Object.assign(new Error("closed"), { name: "ExitPromptError" })]]);
    expect(await main(["keeper", "init", "-c", cfgPath], { out: cli.io, isTTY: true, prompts: again.prompts })).toBe(1);
    expect(cli.out).toEqual(["Setup cancelled; nothing was written."]);
  });

  it("keeps the config's existing file when told not to replace it", async () => {
    const dir = tempDir();
    const cfgPath = join(dir, "bazaar-keeper.yaml");
    writeFileSync(cfgPath, "network: anvil\n", "utf8");
    const s = scripted([["confirm", `${cfgPath} exists. Replace it?`, false]]);
    const { d } = deps({ prompts: s.prompts });
    await runWizard(cfgPath, d);
    expect(readFileSync(cfgPath, "utf8")).toBe("network: anvil\n");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("quotes only what YAML or dotenv would misread", () => {
    expect(yamlScalar("BTC/USD", true)).toBe("BTC/USD");
    expect(yamlScalar("C:\\Users\\me\\.bazaar\\keys\\default.json")).toBe("C:\\Users\\me\\.bazaar\\keys\\default.json");
    expect(yamlScalar("/home/me/my keys/default.json")).toBe("/home/me/my keys/default.json");
    expect(yamlScalar("Gold, spot", true)).toBe('"Gold, spot"');
    expect(yamlScalar("123", true)).toBe('"123"');
    expect(yamlScalar("null")).toBe('"null"');
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("#tag")).toBe('"#tag"');
    for (const v of ["plain", "with space inside", "a#b", " lead", "trail ", "it's", 'say "hi"', "back\\slash", "${NOT_EXPANDED}", "", "=x="]) {
      expect(parseDotenv(`K=${envValue(v)}\n`).K, JSON.stringify(v)).toBe(v);
    }
    expect(envValue("https://x.io/v2/abc?x=1&y=2")).toBe("https://x.io/v2/abc?x=1&y=2");
  });
});
