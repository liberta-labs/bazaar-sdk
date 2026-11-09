#!/usr/bin/env node
/** The bazaar command: `bazaar keeper …` runs the keeper; `wallet` and `mock-prices` are shared tools. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inventorySize, marketStatus } from "@liberta-labs/bazaar-sdk";
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { ConfigError, DEFAULT_CONFIG, JOB_NAMES, type JobName, expandHome, loadConfig } from "../config/index.js";
import type { ActionResult } from "../exec/executor.js";
import { Ledger, type SummaryRow } from "../exec/ledger.js";
import { KEYS_DIR, LocalSigner, WalletError, newKey, writeKeystore } from "../exec/wallets.js";
import type * as Engine from "../keeper/engine.js";
import type * as Opportunities from "../keeper/ops/opportunities.js";
import { setupLogging } from "../observe/index.js";
import { runDoctor } from "./doctor.js";
import {
  CliExit,
  OK,
  type Output,
  c,
  consoleOutput,
  errorText,
  fixed,
  formatG,
  grouped,
  redactUrls,
  table,
  usd,
  utcTime,
} from "./format.js";
import { type Prompts, inquirerPrompts, isPromptExit, runWizard } from "./wizard.js";

// ---- what the commands talk to (tests replace these) ----

type EngineApi = Pick<typeof Engine, "Keeper" | "listMarkets" | "stateDirFor">;
type OpportunitiesApi = Pick<typeof Opportunities, "findOpportunities">;
type Keeper = Engine.Keeper;
type Operations = Keeper["run"];

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface CliDeps {
  out: Output;
  /** whether stdin is a terminal (prompts and confirmations) */
  isTTY: boolean;
  prompts: Prompts;
  /** the keeper engine, loaded on first use (only the commands that need it load it) */
  engine(): Promise<EngineApi>;
  opportunities(): Promise<OpportunitiesApi>;
  /** where Ctrl-C (SIGINT) and SIGTERM arrive */
  signals: SignalSource;
  /** leave at once (a second Ctrl-C while stopping) */
  exit(code: number): never;
  handlers: Handlers;
}

export interface ConfigArgs {
  config: string;
}
export interface StartArgs extends ConfigArgs {
  dryRun: boolean;
  only?: JobName[];
}
export interface EarningsArgs extends ConfigArgs {
  since: string;
  by: "job" | "market";
}
export interface RunArgs extends ConfigArgs {
  operation: Operation;
  market?: string;
  accounts?: Address[];
  orders?: bigint[];
  assertion?: Hex;
  proposal?: Hex;
  pairId?: Hex;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
}
export interface WalletArgs extends ConfigArgs {
  action: "new" | "import" | "list";
  name: string;
  path?: string;
}
export interface MockPricesArgs {
  rpc: string;
  pyth: string;
  /** USD by feed id (lowercase, no 0x) */
  price: Record<string, number>;
  host: string;
  port: number;
}

/** A command's body: resolves to its exit code (nothing = 0), or throws CliExit / ConfigError / WalletError. */
type Handler<A> = (args: A, deps: CliDeps) => Promise<number | void>;

export interface Handlers {
  init: Handler<ConfigArgs>;
  doctor: Handler<ConfigArgs>;
  start: Handler<StartArgs>;
  status: Handler<ConfigArgs>;
  markets: Handler<ConfigArgs>;
  earnings: Handler<EarningsArgs>;
  opportunities: Handler<ConfigArgs>;
  run: Handler<RunArgs>;
  wallet: Handler<WalletArgs>;
  mockPrices: Handler<MockPricesArgs>;
}

// ---- argument values ----

function list(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const JOB_KEYS = new Map<string, JobName>(JOB_NAMES.map((n) => [n.toLowerCase(), n]));

/** `liquidation,terminal-settlement` -> the config's job names (any of -, _ or camelCase). */
export function parseJobs(v: string): JobName[] {
  return list(v).map((raw) => {
    const name = JOB_KEYS.get(raw.replace(/[-_]/g, "").toLowerCase());
    if (!name) throw new InvalidArgumentError(`unknown job '${raw}'. Jobs: ${JOB_NAMES.join(", ")}`);
    return name;
  });
}

/** A period such as 30m, 24h or 7d (a bare number is days), in seconds. */
export function sinceSeconds(s: string): number {
  const t = s.trim();
  const units: Record<string, number> = { m: 60, h: 3600, d: 86_400 };
  const unit = units[t.slice(-1)];
  const num = unit ? t.slice(0, -1).trim() : t;
  const n = Number(num);
  if (!num || !Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("expected a period such as 30m, 24h or 7d (a bare number is days)");
  }
  return n * (unit ?? 86_400);
}

function parseAccounts(v: string): Address[] {
  return list(v).map((a, i) => {
    // Never echo the value: a key pasted here by mistake would land in the terminal and its history.
    if (!isAddress(a, { strict: false })) {
      throw new InvalidArgumentError(`--accounts entry ${i + 1} is not an address (${a.length} characters; expected 0x and 40 hex digits)`);
    }
    return getAddress(a);
  });
}

function parseOrderIds(v: string): bigint[] {
  return list(v).map((s) => {
    if (!/^\d+$/.test(s)) throw new InvalidArgumentError(`${s} is not an order id (a whole number)`);
    return BigInt(s);
  });
}

/** A bytes32 id (assertion, proposal, pair id), with or without 0x. */
function parseId(v: string): Hex {
  const s = v.trim();
  const h = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new InvalidArgumentError("expected a 32-byte id: 0x followed by 64 hex digits");
  return `0x${h.toLowerCase()}`;
}

function parsePort(v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || n > 65_535) throw new InvalidArgumentError("expected a port number (0 to 65535)");
  return n;
}

function collectPrice(v: string, prev: Record<string, number>): Record<string, number> {
  const i = v.indexOf("=");
  const feed = i > 0 ? v.slice(0, i).trim().toLowerCase().replace(/^0x/, "") : "";
  const price = i > 0 ? Number(v.slice(i + 1)) : NaN;
  if (!feed || !Number.isFinite(price)) throw new InvalidArgumentError("expected FEED_ID=USD, e.g. 0xff61…0ace=3000");
  return { ...prev, [feed]: price };
}

// ---- run: the operations ----

const AUTO = [
  "liquidate",
  "execute-triggers",
  "unload",
  "execute-adl",
  "refresh-price",
  "collect",
  "settle-terminal",
  "sweep-expired",
] as const;
const MANUAL = [
  "finalize",
  "terminate-stale",
  "terminate-scheduled",
  "settle-termination",
  "execute-insurer-termination",
  "settle-listing",
  "expire-listing",
  "settle-identifier-upgrade",
  "expire-identifier-upgrade",
  "activate-identifier-upgrade",
] as const;
type AutoOperation = (typeof AUTO)[number];
type ManualOperation = (typeof MANUAL)[number];
export type Operation = AutoOperation | ManualOperation;

/** One line each, for help and for an unknown operation. */
export const OPERATIONS: Readonly<Record<Operation, string>> = {
  liquidate: "seize positions below their maintenance margin (--accounts names them)",
  "execute-triggers": "fire StopLimit, StopLoss and TakeProfit orders that are ready (--orders names them)",
  unload: "sell the vault's liquidated inventory into the book",
  "execute-adl": "run an ADL batch while a window is open",
  "refresh-price": "store a fresh price on the market",
  collect: "claim your earnings (--market optional, comma-separated)",
  "settle-terminal": "settle positions at the fixed settlement price (--accounts names them)",
  "sweep-expired": "unlink expired orders and return stranded bounties (--orders names them)",
  finalize: "finalize a terminated market once its positions are settled",
  "terminate-stale": "end a market whose stored price is more than 21 days old",
  "terminate-scheduled": "end a market at its scheduled cutoff, with the settlement prints its rule asks for",
  "settle-termination": "settle a UMA termination claim (--assertion)",
  "execute-insurer-termination": "resolve an insurer vote on a market (--proposal)",
  "settle-listing": "settle a listing proposal (--assertion)",
  "expire-listing": "release a stuck listing (--pair-id)",
  "settle-identifier-upgrade": "settle an identifier upgrade proposal (--assertion)",
  "expire-identifier-upgrade": "release a stuck identifier upgrade",
  "activate-identifier-upgrade": "activate the queued identifier upgrade",
};

function isOperation(op: string): op is Operation {
  return Object.hasOwn(OPERATIONS, op);
}

function isAuto(op: Operation): op is AutoOperation {
  return (AUTO as readonly string[]).includes(op);
}

export function operationList(): string {
  const w = Math.max(...Object.keys(OPERATIONS).map((k) => k.length));
  const rows = (ops: readonly Operation[]) => ops.map((op) => `  ${op.padEnd(w)}  ${OPERATIONS[op]}`).join("\n");
  return (
    "Automatic jobs, once (they keep the profit and loss rules unless --force):\n" +
    rows(AUTO) +
    "\nManual operations (shown first, then sent once you confirm, or at once with --yes):\n" +
    rows(MANUAL)
  );
}

/** Which operations need which option, checked before anything is loaded. */
const NEEDS: readonly (readonly ["market" | "assertion" | "proposal" | "pairId", string, readonly Operation[]])[] = [
  [
    "market",
    "--market",
    [
      "liquidate",
      "execute-triggers",
      "unload",
      "execute-adl",
      "refresh-price",
      "settle-terminal",
      "sweep-expired",
      "finalize",
      "terminate-stale",
      "terminate-scheduled",
      "execute-insurer-termination",
    ],
  ],
  ["assertion", "--assertion", ["settle-termination", "settle-listing", "settle-identifier-upgrade"]],
  ["proposal", "--proposal", ["execute-insurer-termination"]],
  ["pairId", "--pair-id", ["expire-listing"]],
];

const nonEmpty = <T>(xs: T[] | undefined): T[] | undefined => (xs && xs.length ? xs : undefined);

const AUTO_OPS: Readonly<Record<AutoOperation, (ops: Operations, a: RunArgs) => Promise<ActionResult[]>>> = {
  liquidate: (ops, a) => ops.liquidate(a.market!, nonEmpty(a.accounts), { dryRun: a.dryRun, force: a.force }),
  "execute-triggers": (ops, a) => ops.executeTriggers(a.market!, nonEmpty(a.orders), { dryRun: a.dryRun, force: a.force }),
  unload: (ops, a) => ops.unload(a.market!, { dryRun: a.dryRun, force: a.force }),
  "execute-adl": (ops, a) => ops.executeAdl(a.market!, undefined, undefined, { dryRun: a.dryRun, force: a.force }),
  "refresh-price": (ops, a) => ops.refreshPrice(a.market!, { dryRun: a.dryRun, force: a.force }),
  collect: (ops, a) => ops.collect(nonEmpty(list(a.market ?? "")) ?? "all", { dryRun: a.dryRun, force: a.force }),
  "settle-terminal": (ops, a) => ops.settleTerminal(a.market!, nonEmpty(a.accounts), { dryRun: a.dryRun, force: a.force }),
  "sweep-expired": (ops, a) => ops.sweepExpired(a.market!, nonEmpty(a.orders), { dryRun: a.dryRun, force: a.force }),
};

const MANUAL_OPS: Readonly<Record<ManualOperation, (ops: Operations, a: RunArgs, dryRun: boolean) => Promise<ActionResult>>> = {
  finalize: (ops, a, dryRun) => ops.finalizeTermination(a.market!, { dryRun }),
  "terminate-stale": (ops, a, dryRun) => ops.terminateStalePair(a.market!, { dryRun }),
  "terminate-scheduled": (ops, a, dryRun) => ops.terminateScheduledPair(a.market!, { dryRun }),
  "settle-termination": (ops, a, dryRun) => ops.settleTerminationProposal(a.assertion!, { dryRun }),
  "execute-insurer-termination": (ops, a, dryRun) => ops.executeInsurerTermination(a.market!, a.proposal!, { dryRun }),
  "settle-listing": (ops, a, dryRun) => ops.factory.settleDeploymentProposal(a.assertion!, { dryRun }),
  "expire-listing": (ops, a, dryRun) => ops.factory.expireStuckDeploymentProposal(a.pairId!, { dryRun }),
  "settle-identifier-upgrade": (ops, a, dryRun) => ops.factory.settleIdentifierUpgradeProposal(a.assertion!, { dryRun }),
  "expire-identifier-upgrade": (ops, _a, dryRun) => ops.factory.expireStuckIdentifierUpgradeProposal({ dryRun }),
  "activate-identifier-upgrade": (ops, _a, dryRun) => ops.factory.activateIdentifierUpgrade({ dryRun }),
};

// ---- rendering ----

const STATUS_COLOR: Readonly<Record<string, (s: string) => string>> = {
  confirmed: c.green,
  simulated: c.cyan,
  skipped: c.yellow,
  reverted: c.red,
  unknown: c.red,
};

export function renderResult(r: ActionResult, out: Output): void {
  const color = STATUS_COLOR[r.status] ?? ((s: string) => s);
  out.out(`${color(r.status)}  ${r.job}  ${r.market || ""}  ${r.summary}`);
  if (r.reason) out.out(`   ${redactUrls(r.reason)}`);
  if ((r.status === "confirmed" || r.status === "reverted" || r.status === "unknown" || r.status === "simulated") && (r.costUsd || r.expectedRewardUsd)) {
    if (r.sent) {
      out.out(`   earned ${usd(r.rewardUsd, 4)}, gas ${usd(r.costUsd, 4)}` + (r.claimedUsd ? `, claimed ${usd(r.claimedUsd, 2)}` : ""));
    } else {
      out.out(`   would earn ${usd(r.expectedRewardUsd, 4)} for about ${usd(r.costUsd, 4)} of gas`);
    }
  }
  if (r.txHash) out.out(`   tx ${r.txHash}`);
  const opens = r.opensAt;
  if (opens) out.out(`   opens at ${utcTime(opens)}`);
}

/** status.json as the engine writes it (the Python keeper's shape). */
export interface StatusFile {
  /** seconds since the epoch */
  updated: number;
  network: string;
  factory: string;
  official: boolean;
  block: number;
  indexed: number;
  prices: { healthy: boolean; error?: string | null; feeds?: number };
  markets?: unknown[];
  jobs: Record<string, { markets: number | string; last?: string | null; today?: Partial<SummaryRow> | null }>;
  wallets: Record<string, string>;
  halted?: string | null;
}

export function renderStatus(s: StatusFile, now: number = Date.now() / 1000): string[] {
  const age = now - s.updated;
  const state = age < 30 ? c.green("running") : c.yellow(`not running (last seen ${fixed(age / 60, 0)} min ago)`);
  const prices = s.prices.healthy ? "prices live" : c.red(`prices down: ${redactUrls(s.prices.error || "no print yet")}`);
  const out = [`Bazaar keeper · ${s.network} · block ${grouped(s.block)} · indexed ${grouped(s.indexed)} · ${prices} · ${state}`];
  if (!s.official) out.push(c.yellow(`factory ${s.factory} is not an official deployment`));
  if (s.halted) out.push(c.red(s.halted));
  const right = (header: string) => ({ header, align: "right" as const });
  out.push(
    ...table(
      ["JOB", right("MARKETS"), "LAST ACTION", right("TODAY EARNED"), right("GAS"), right("NET")],
      Object.entries(s.jobs).map(([name, j]) => {
        const today = j.today ?? {};
        return [name, String(j.markets), j.last || "-", usd(today.reward ?? 0), usd(today.cost ?? 0), usd(today.net ?? 0)];
      }),
    ),
  );
  out.push(...table(["WALLET", "ADDRESS"], Object.entries(s.wallets)));
  return out;
}

export function renderEarnings(s: Readonly<Record<string, SummaryRow>>, by: "job" | "market"): string[] {
  const keys = Object.keys(s).sort();
  if (!keys.length) return ["No transactions in that period."];
  const right = (header: string) => ({ header, align: "right" as const });
  return table(
    [by.toUpperCase(), right("CALLS"), right("REVERTED"), right("EARNED"), right("GAS"), right("NET"), right("CLAIMED")],
    keys.map((key) => {
      const v = s[key]!;
      return [key, String(v.calls), String(v.reverted), usd(v.reward, 4), usd(v.cost, 4), usd(v.net, 4), usd(v.claimed, 2)];
    }),
  );
}

// ---- the commands ----

function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    p.then(done, done);
  });
}

async function cmdStart(a: StartArgs, d: CliDeps): Promise<number> {
  const cfg = loadConfig(a.config);
  if (a.only?.length) {
    const keep = new Set<JobName>(a.only);
    for (const name of JOB_NAMES) if (!keep.has(name)) cfg.jobs[name] = null;
  }
  if (a.dryRun) {
    for (const name of JOB_NAMES) {
      const job = cfg.jobs[name];
      if (job) job.dryRun = true;
    }
  }
  setupLogging(cfg.log.level, cfg.log.format);
  const { Keeper } = await d.engine();
  const k = await Keeper.create(cfg);
  const st: { stopping: Promise<void> | null; signalled: () => void } = { stopping: null, signalled: () => {} };
  const stopRequested = new Promise<void>((resolve) => (st.signalled = resolve));
  const onSignal = (): void => {
    if (st.stopping) {
      d.out.err(c.yellow("stopping now, without waiting for in-flight transactions"));
      d.exit(130);
    }
    d.out.out("stopping: waiting for in-flight transactions…");
    st.stopping = k.stop();
    st.signalled();
  };
  d.signals.on("SIGINT", onSignal);
  d.signals.on("SIGTERM", onSignal);
  try {
    const running = k.start();
    running.catch(() => {}); // awaited below; abandoned only when a stop arrives while it is still connecting
    await Promise.race([running, stopRequested]);
    if (st.stopping) {
      await st.stopping;
      // start() resolves once stop() is done, unless it is still connecting (a long first index):
      // then it is not waited for.
      await within(running, 2_000);
    }
  } finally {
    d.signals.off("SIGINT", onSignal);
    d.signals.off("SIGTERM", onSignal);
    await k.close();
  }
  return 0;
}

async function cmdStatus(a: ConfigArgs, d: CliDeps): Promise<void> {
  const cfg = loadConfig(a.config);
  const { stateDirFor } = await d.engine();
  const path = join(stateDirFor(cfg), "status.json");
  if (!existsSync(path)) {
    d.out.out(`No keeper has run with this config yet. Start one with ${c.bold("bazaar keeper start")}.`);
    return;
  }
  let s: StatusFile;
  try {
    s = JSON.parse(readFileSync(path, "utf8")) as StatusFile;
  } catch (e) {
    throw new Error(`${path} is not a keeper status file: ${errorText(e)}`);
  }
  for (const line of renderStatus(s)) d.out.out(line);
}

async function cmdMarkets(a: ConfigArgs, d: CliDeps): Promise<void> {
  const cfg = loadConfig(a.config);
  const { Keeper } = await d.engine();
  const k = await Keeper.create(cfg, { loadWallets: false });
  try {
    await k.connect();
    await k.readStates(true, [...k.store.markets.values()]);
    const now = k.now();
    const markets = [...k.store.markets.values()].sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
    const rows = markets.map((m) => {
      const st = m.state;
      return [
        m.label,
        m.address,
        st ? marketStatus(st, now) : "?",
        m.continuous ? "24/7" : "session",
        String(k.store.positions.get(m.address)?.size ?? 0),
        String(k.store.orders.get(m.address)?.size ?? 0),
        st ? formatG(Number(inventorySize(st)) / 1e18) : "?",
      ];
    });
    const right = (header: string) => ({ header, align: "right" as const });
    for (const line of table(["MARKET", "ADDRESS", "STATUS", "HOURS", right("POSITIONS"), right("LIVE ORDERS"), right("INVENTORY")], rows)) {
      d.out.out(line);
    }
  } finally {
    await k.close();
  }
}

async function cmdEarnings(a: EarningsArgs, d: CliDeps): Promise<void> {
  const cfg = loadConfig(a.config);
  const { stateDirFor } = await d.engine();
  const ledger = new Ledger(join(stateDirFor(cfg), "ledger.jsonl"));
  const s = ledger.summary(Date.now() / 1000 - sinceSeconds(a.since), a.by);
  for (const line of renderEarnings(s, a.by)) d.out.out(line);
}

async function cmdOpportunities(a: ConfigArgs, d: CliDeps): Promise<void> {
  const cfg = loadConfig(a.config);
  const { Keeper } = await d.engine();
  const { findOpportunities } = await d.opportunities();
  const k = await Keeper.create(cfg);
  let found: Awaited<ReturnType<typeof findOpportunities>>;
  try {
    found = await findOpportunities(k);
  } finally {
    await k.close();
  }
  if (!found.length) d.out.out("Nothing is waiting for a manual call.");
  for (const o of found) d.out.out(o.describe());
}

async function cmdRun(a: RunArgs, d: CliDeps): Promise<void> {
  const cfg = loadConfig(a.config);
  setupLogging("warning", cfg.log.format);
  const { Keeper } = await d.engine();
  const k = await Keeper.create(cfg);
  try {
    const op = a.operation;
    if (isAuto(op)) {
      for (const r of await AUTO_OPS[op](k.run, a)) renderResult(r, d.out);
      return;
    }
    const manual = MANUAL_OPS[op];
    const preview = await manual(k.run, a, true);
    if (a.dryRun || preview.status !== "simulated" || !preview.wouldSend) {
      renderResult(preview, d.out);
      return;
    }
    if (!a.yes) {
      renderResult(preview, d.out);
      if (!d.isTTY) {
        d.out.out("Not sent: pass --yes to send without confirming.");
        return;
      }
      let send = false;
      try {
        send = await d.prompts.confirm({ message: "Send it?", default: false });
      } catch (e) {
        if (!isPromptExit(e)) throw e;
      }
      if (!send) return;
    }
    renderResult(await manual(k.run, a, false), d.out);
  } finally {
    await k.close();
  }
}

async function cmdWallet(a: WalletArgs, d: CliDeps): Promise<number | void> {
  if (a.action === "new" || a.action === "import") {
    const path = a.path ? expandHome(a.path) : join(expandHome(KEYS_DIR), `${a.name}.json`);
    if (existsSync(path)) throw new WalletError(`${path} already exists`);
    let key: string;
    let pw: string;
    try {
      if (a.action === "new") {
        key = newKey();
      } else {
        key = (await d.prompts.password({ message: "Private key (hex):" })).trim();
        if (!key) return;
        void new LocalSigner(key); // a bad key fails now, before a password is chosen
      }
      pw = await d.prompts.password({ message: "Choose a password for the keystore:" });
      if (!pw || pw !== (await d.prompts.password({ message: "Repeat it:" }))) throw new CliExit(1, c.red("The passwords did not match."));
    } catch (e) {
      if (isPromptExit(e)) throw new CliExit(1, "Cancelled; no keystore was written.");
      throw e;
    }
    const addr = await writeKeystore(key, pw, path);
    d.out.out(`${OK()} ${addr} saved encrypted at ${path}`);
    d.out.out("Fund it with a little ETH for gas. No keeper call needs USDC or an approval.");
    d.out.out(
      "In bazaar-keeper.yaml:\n" +
        `  wallets:\n    ${a.name}:\n      type: keystore\n      path: ${path}\n` +
        "      password: ${KEEPER_KEYSTORE_PASSWORD}   # in .env, or leave out to be asked at start",
    );
    return;
  }
  const cfg = loadConfig(a.config);
  const { Keeper } = await d.engine();
  const k = await Keeper.create(cfg);
  try {
    await k.connect();
    const rows: string[][] = [];
    for (const [name, lane] of k.executor.lanes) {
      const bal = await k.chain.balance(lane.address);
      const owed = await k.reader.claimable(lane.address);
      let total = 0n;
      for (const v of owed.values()) total += v;
      rows.push([name, lane.address, fixed(Number(bal) / 1e18, 5), `${usd(Number(total) / 1e18)} across ${owed.size} market(s)`]);
    }
    for (const line of table(["WALLET", "ADDRESS", { header: "ETH", align: "right" }, "CLAIMABLE"], rows)) d.out.out(line);
  } finally {
    await k.close();
  }
}

async function cmdInit(a: ConfigArgs, d: CliDeps): Promise<void> {
  await runWizard(a.config, {
    prompts: d.prompts,
    out: d.out,
    isTTY: d.isTTY,
    listMarkets: async (cfg) => (await d.engine()).listMarkets(cfg),
  });
}

async function cmdDoctor(a: ConfigArgs, d: CliDeps): Promise<number> {
  const cfg = loadConfig(a.config);
  const { Keeper } = await d.engine();
  return (await runDoctor(cfg, { Keeper, out: d.out })) ? 0 : 1;
}

async function cmdMockPrices(a: MockPricesArgs): Promise<void> {
  const { serveMockHermes } = await import("../devtools/mock-hermes.js");
  await serveMockHermes(a.rpc, a.pyth, a.price, { host: a.host, port: a.port });
}

export const DEFAULT_HANDLERS: Handlers = {
  init: cmdInit,
  doctor: cmdDoctor,
  start: cmdStart,
  status: cmdStatus,
  markets: cmdMarkets,
  earnings: cmdEarnings,
  opportunities: cmdOpportunities,
  run: cmdRun,
  wallet: cmdWallet,
  mockPrices: cmdMockPrices,
};

// ---- the parser ----

const configOption = (): Option =>
  new Option("-c, --config <path>", "the keeper's config file").default(DEFAULT_CONFIG);

/** The `bazaar` command tree. `setCode` receives the exit code of the command that ran. */
export function buildProgram(d: CliDeps, setCode: (code: number) => void): Command {
  const done = (code: number | void): void => setCode(code ?? 0);
  const trim = (s: string) => s.replace(/\n$/, "");
  const program = new Command("bazaar")
    .description("Tools for the Bazaar protocol.")
    .option("--debug", "print the whole error, with its stack trace, when a command fails")
    .option("--verbose", "the same as --debug")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => d.out.out(trim(s)),
      writeErr: (s) => d.out.err(trim(s)),
      outputError: (s, write) => write(c.red(s.trimEnd()) + "\n"),
    })
    .showHelpAfterError("(add --help for usage)");

  // ---- keeper ----
  const keeper = program
    .command("keeper")
    .summary("run Bazaar's keeper duties and collect their bounties")
    .description("Run Bazaar's permissionless upkeep and collect its bounties.");

  keeper
    .command("init")
    .summary("create a config with the setup wizard")
    .description("create a config with the setup wizard (secrets and URLs go to a .env beside it)")
    .addOption(configOption())
    .action(async (o: { config: string }) => done(await d.handlers.init({ config: o.config }, d)));

  keeper
    .command("doctor")
    .summary("check every connection the keeper needs")
    .description("check every connection the keeper needs: RPC, factory wiring, subgraph, prices, wallets and jobs")
    .addOption(configOption())
    .action(async (o: { config: string }) => done(await d.handlers.doctor({ config: o.config }, d)));

  keeper
    .command("start")
    .summary("run the enabled jobs until Ctrl-C")
    .description(
      "Run the enabled jobs until Ctrl-C. The first Ctrl-C (or SIGTERM) stops cleanly: in-flight transactions\n" +
        "finish, collect runs if its onShutdown is set, and the snapshot is saved. A second one leaves at once.",
    )
    .addOption(configOption())
    .option("--dry-run", "simulate and log, never send")
    .option("--only <jobs>", "comma-separated jobs to run, e.g. liquidation,triggers", parseJobs)
    .action(async (o: { config: string; dryRun?: boolean; only?: JobName[] }) =>
      done(await d.handlers.start({ config: o.config, dryRun: Boolean(o.dryRun), only: nonEmpty(o.only) }, d)),
    );

  keeper
    .command("status")
    .summary("what a running keeper is doing")
    .description("what a running keeper is doing: its jobs, wallets and today's earnings")
    .addOption(configOption())
    .action(async (o: { config: string }) => done(await d.handlers.status({ config: o.config }, d)));

  keeper
    .command("markets")
    .summary("list the factory's markets")
    .description("list the factory's markets with their label, status and open positions")
    .addOption(configOption())
    .action(async (o: { config: string }) => done(await d.handlers.markets({ config: o.config }, d)));

  keeper
    .command("earnings")
    .description("rewards, gas and net from the ledger")
    .addOption(configOption())
    .option("--since <period>", "how far back, e.g. 30m, 24h, 7d (a bare number is days)", (v: string) => (sinceSeconds(v), v), "7d")
    .addOption(new Option("--by <group>", "one row per job or per market").choices(["job", "market"]).default("job"))
    .action(async (o: { config: string; since: string; by: "job" | "market" }) =>
      done(await d.handlers.earnings({ config: o.config, since: o.since, by: o.by }, d)),
    );

  keeper
    .command("opportunities")
    .summary("manual operations available now")
    .description("manual operations available now, each confirmed by simulation")
    .addOption(configOption())
    .action(async (o: { config: string }) => done(await d.handlers.opportunities({ config: o.config }, d)));

  keeper
    .command("run")
    .summary("run one operation now")
    .description(
      "Run one operation now. Every call is simulated first; nothing that reverts in simulation is sent.\n" +
        "A manual operation shows what would happen and asks before sending.",
    )
    .addArgument(new Argument("[operation]", "the operation to run (listed below)"))
    .addOption(configOption())
    .option("--market <m>", "market label, address or pair id (comma-separated for collect)")
    .option("--accounts <addresses>", "comma-separated accounts (liquidate, settle-terminal)", parseAccounts)
    .option("--orders <ids>", "comma-separated order ids (execute-triggers, sweep-expired)", parseOrderIds)
    .option("--assertion <id>", "UMA assertion id (settle-termination, settle-listing, settle-identifier-upgrade)", parseId)
    .option("--proposal <id>", "insurer proposal id (execute-insurer-termination)", parseId)
    .option("--pair-id <id>", "listing pair id (expire-listing)", parseId)
    .option("--dry-run", "simulate only")
    .option("--force", "send even when the profit and loss rules would skip it")
    .option("-y, --yes", "send manual operations without confirming")
    .addHelpText("after", "\nOperations:\n" + operationList())
    .action(async (operation: string | undefined, o: Omit<RunArgs, "operation" | "dryRun" | "force" | "yes"> & { dryRun?: boolean; force?: boolean; yes?: boolean }) => {
      if (!operation) throw new CliExit(2, `${c.red("bazaar keeper run needs an operation.")}\n${operationList()}`);
      if (!isOperation(operation)) throw new CliExit(2, `${c.red(`unknown operation '${operation}'.`)}\n${operationList()}`);
      for (const [field, flag, ops] of NEEDS) {
        if (ops.includes(operation) && !o[field]) throw new CliExit(2, c.red(`${operation} needs ${flag}`));
      }
      const args: RunArgs = {
        config: o.config,
        operation,
        market: o.market,
        accounts: o.accounts,
        orders: o.orders,
        assertion: o.assertion,
        proposal: o.proposal,
        pairId: o.pairId,
        dryRun: Boolean(o.dryRun),
        force: Boolean(o.force),
        yes: Boolean(o.yes),
      };
      done(await d.handlers.run(args, d));
    });

  // ---- shared tools ----
  program
    .command("wallet")
    .summary("create, import or list wallets (list reads a keeper config)")
    .description(
      "new: create a key and save it as an encrypted keystore. import: encrypt a private key you paste.\n" +
        "list: each configured wallet's address, ETH balance and claimable earnings (reads the config).",
    )
    .addArgument(new Argument("<action>", "new, import or list").choices(["new", "import", "list"]))
    .addOption(configOption())
    .option("--name <name>", "the wallet's name: the keystore's file name, and its key under wallets", "default")
    .option("--path <file>", "where to write the keystore (default ~/.bazaar/keys/<name>.json)")
    .action(async (action: WalletArgs["action"], o: { config: string; name: string; path?: string }) =>
      done(await d.handlers.wallet({ action, config: o.config, name: o.name, path: o.path }, d)),
    );

  program
    .command("mock-prices")
    .summary("serve Hermes-style prints from a MockPyth (local testing)")
    .description("Serve Hermes-style prints from a MockPyth on a local chain, until Ctrl-C.")
    .option("--rpc <url>", "the local chain's RPC", "http://127.0.0.1:8545")
    .requiredOption("--pyth <address>", "the MockPyth address")
    .option("--price <FEED_ID=USD>", "a feed's starting price in USD; repeatable", collectPrice, {} as Record<string, number>)
    .option("--host <host>", "the address to listen on", "127.0.0.1")
    .option("--port <port>", "the port to listen on", parsePort, 8787)
    .action(async (o: MockPricesArgs) =>
      done(await d.handlers.mockPrices({ rpc: o.rpc, pyth: o.pyth, price: o.price, host: o.host, port: o.port }, d)),
    );

  return program;
}

// ---- errors and exit codes ----

/**
 * One readable line for a failed command, and its exit code: 2 for a usage, config or wallet
 * problem (as argparse and the Python CLI used), 1 for anything else. --debug adds the stack trace.
 */
export function reportError(e: unknown, out: Output, debug: boolean): number {
  if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2; // commander has printed it
  if (e instanceof CliExit) {
    if (e.message) out.err(redactUrls(e.message));
    return e.code;
  }
  if (isPromptExit(e)) {
    out.err("Cancelled.");
    return 130;
  }
  const known = e instanceof ConfigError || e instanceof WalletError;
  if (debug && e instanceof Error && e.stack) out.err(c.red(redactUrls(e.stack)));
  else if (known) out.err(c.red(redactUrls((e as Error).message)));
  else out.err(c.red(`error: ${errorText(e)}`) + c.dim("  (run with --debug for details)"));
  return known ? 2 : 1;
}

function defaultDeps(): CliDeps {
  return {
    out: consoleOutput,
    isTTY: Boolean(process.stdin.isTTY),
    prompts: inquirerPrompts,
    engine: () => import("../keeper/engine.js"),
    opportunities: () => import("../keeper/ops/opportunities.js"),
    signals: process,
    exit: (code) => process.exit(code),
    handlers: DEFAULT_HANDLERS,
  };
}

export type MainOptions = Partial<Omit<CliDeps, "handlers">> & { handlers?: Partial<Handlers> };

/** Run the CLI on `argv` (without the node and script paths); resolves to the exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...options, handlers: { ...DEFAULT_HANDLERS, ...options.handlers } };
  let code = 0;
  const program = buildProgram(deps, (n) => (code = n));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (e) {
    const o = program.opts<{ debug?: boolean; verbose?: boolean }>();
    return reportError(e, deps.out, Boolean(o.debug || o.verbose));
  }
}

function invokedAsScript(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    // npm links the bin (a symlink on POSIX): compare real paths.
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  void main().then((code) => {
    process.exitCode = code;
    // Leave once the output is flushed, even if an idle keep-alive socket or a stopped engine's timer
    // would keep the process up.
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
}
