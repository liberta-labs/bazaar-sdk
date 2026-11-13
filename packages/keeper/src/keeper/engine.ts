/**
 * The keeper: connect, keep the index current, and run the enabled jobs.
 *
 * One loop runs every `engine.tickSeconds`: read the head, apply new logs, re-read the state of the
 * markets that changed (one batched read), let every job plan, and hand each action to the executor
 * on its own. Liquidation and trigger execution race other keepers, and what usually makes them due
 * is a price move, so they also plan a market the moment a newer print for one of its legs arrives,
 * without waiting for the tick. Prints and the tick share one plan per job and market at a time: a
 * print or tick that arrives during a plan queues one more plan, which then judges by the newest
 * print. The print path waits while the index catches up (a sync step that starts CATCH_UP_BLOCKS or
 * more behind the head, as after a restart).
 *
 * ```ts
 * const keeper = await Keeper.create(loadConfig());
 * keeper.on("action", (r) => console.log(r.job, r.market, r.status, r.rewardUsd));
 * await keeper.run.liquidate("BTC/USD", { dryRun: true });
 * process.once("SIGINT", () => void keeper.stop());
 * await keeper.start(); // until stop()
 * await keeper.close();
 * ```
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Chain,
  type Deployment,
  InputError,
  type Market,
  PriceService,
  ProClient,
  ProError,
  type ProEndpoints,
  Reader,
  type Status,
  SubgraphClient,
  SubgraphError,
  ZERO_ADDRESS,
  fetchSymbols,
  findDeploymentBlock,
  inventorySize,
  marketLabel,
  marketStatus,
  verifierSignerCheck,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import {
  ConfigError,
  type JobName,
  type KeeperConfig,
  type ResolvedNetwork,
  UNCHECKED_SIGNERS_WARNING,
  enabledJobs,
  expandHome,
  missingProKey,
  priceEndpoints,
  resolvedNetwork,
  subgraphUrl,
} from "../config/index.js";
import { type Action, type ActionResult, Executor, Lane, Mutex } from "../exec/executor.js";
import { Ledger, type SummaryRow } from "../exec/ledger.js";
import { loadSigner } from "../exec/wallets.js";
// (format.ts only formats text: no CLI code comes with it)
import { errorText } from "../cli/format.js";
import { Alerter } from "../observe/alerts.js";
import { getLogger, safeLabel } from "../observe/logs.js";
import { streamSocket } from "./stream-socket.js";
import { Store } from "../state/store.js";
import { bootstrap as bootstrapFromSubgraph } from "../sync/bootstrap.js";
import { LogTail, type TailLogger } from "../sync/tail.js";
import { CollectJob, JOBS, type Job, LiquidationJob, UnloadJob, monotonic } from "./jobs/index.js";
import { Operations } from "./ops/manual.js";
import { type Opportunity, findOpportunities } from "./ops/opportunities.js";

const log = getLogger("bazaar_sdk");
const syncLog = getLogger("bazaar_sdk.sync");
const priceLog = getLogger("bazaar_sdk.prices");
const TAIL_LOG: TailLogger = { info: (m) => syncLog.info(m), warn: (m) => syncLog.warning(m) };

/**
 * A sync step that starts this many blocks behind the head is a catch-up (after a restart or an
 * outage): the print path waits for it, so it does not plan from an index still being replayed.
 */
export const CATCH_UP_BLOCKS = 64;

/** How many sent results {@link Keeper.recent} keeps, newest first. */
const RECENT = 50;

/** Where a keeper for this network and factory keeps its snapshot, ledger and status. */
export function stateDirFor(cfg: KeeperConfig): string {
  const net = resolvedNetwork(cfg);
  return join(expandHome(cfg.state.dir), "keeper", `${net.chainId}-${net.factory.slice(2, 10).toLowerCase()}`);
}

/** The factory's markets with their labels, without indexing anything (for setup and listings). */
export async function listMarkets(cfg: KeeperConfig): Promise<Market[]> {
  const k = await Keeper.create(cfg, { loadWallets: false });
  try {
    k.dep = await k.reader.deployment(k.net.factory);
    return await k.discoverMarkets();
  } finally {
    await k.close();
  }
}

/** What {@link Keeper.on} delivers, by event. */
export interface KeeperEvents {
  /** a sent transaction's result, once its receipt is in (confirmed, reverted, or unknown) */
  action: ActionResult;
  /** a transaction was submitted: the action and its hash */
  sent: readonly [action: Action, txHash: Hex];
  /** an alert (lowBalance, jobPaused, endpointDown, ...): its kind and message */
  alert: readonly [kind: string, message: string];
  /** a manual operation that is available now, or opens later (with alerts.notify "opportunity") */
  opportunity: Opportunity;
}
export type KeeperEvent = keyof KeeperEvents;
export type KeeperListener<K extends KeeperEvent> = (payload: KeeperEvents[K]) => unknown;

export interface KeeperOptions {
  /**
   * Load the configured wallets' signers (default true). false makes a watch-only keeper: it plans
   * and simulates, and sends nothing.
   */
  loadWallets?: boolean;
}

export interface StopOptions {
  /** claim earnings before stopping; default jobs.collect.onShutdown */
  collect?: boolean | null;
  /** seconds to wait for the loop and the in-flight sends; default 60 */
  timeout?: number;
}

/** One market in the status file. */
export interface MarketStatusEntry {
  label: string;
  address: Address;
  /** live | adl | limbo | settling | terminated, or unknown before its state is read */
  status: Status | "unknown";
  positions: number;
  orders: number;
  /** the vault's inventory, in units */
  inventory: number;
  /** positions within watchBufferPct of their requirement; null without the liquidation job */
  atRisk: number | null;
  /** seconds since the base leg's latest print; null without one */
  priceAge: number | null;
}

/** One job in the status file. */
export interface JobStatusEntry {
  /** how many markets it covers, or "all" for jobs that are not per market */
  markets: number | "all";
  /** its latest sent call: "<market> <summary> (<status>)", or "" */
  last: string;
  /** the ledger's last 24 h for it ({} when it sent nothing) */
  today: SummaryRow | Record<string, never>;
}

/** `status.json`, which `bazaar keeper status` reads. */
export interface KeeperStatus {
  /** seconds since the epoch */
  updated: number;
  network: string;
  factory: Address;
  official: boolean;
  /** the chain's head */
  block: number;
  /** the last block whose logs are applied */
  indexed: number;
  prices: { healthy: boolean; error: string; feeds: number };
  markets: MarketStatusEntry[];
  jobs: Record<string, JobStatusEntry>;
  wallets: Record<string, Address>;
  halted: string;
}

/** asyncio.Event: set, clear, and wait until set. */
export class Signal {
  private on = false;
  private waiters: (() => void)[] = [];

  get isSet(): boolean {
    return this.on;
  }

  set(): void {
    this.on = true;
    this.release();
  }

  clear(): void {
    this.on = false;
  }

  /** Resolves once set (at once if it is). */
  wait(): Promise<void> {
    if (this.on) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Wake every waiter without setting it (each re-checks what it waits for). */
  release(): void {
    if (this.waiters.length === 0) return;
    const w = this.waiters;
    this.waiters = [];
    for (const wake of w) wake();
  }
}

const noop = (): void => {};

/** The trailing Error argument the logger treats as exc_info, when `e` is one. */
const exc = (e: unknown): unknown[] => (e instanceof Error ? [e] : []);

/** Wait for `p` to settle, at most `seconds`. */
async function settleWithin(p: Promise<unknown>, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p.then(noop, noop), new Promise<void>((resolve) => (timer = setTimeout(resolve, seconds * 1000)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error from the file system (ENOENT, EACCES, EPERM, ...), as opposed to a bug. */
const isFsError = (e: unknown): boolean => e instanceof Error && typeof (e as { code?: unknown }).code === "string";

export class Keeper {
  readonly cfg: KeeperConfig;
  readonly net: ResolvedNetwork;
  readonly chain: Chain;
  readonly reader: Reader;
  /** the index: markets, open positions, live orders (replaced by the snapshot on connect) */
  store: Store;
  /** the Pyth Pro client: the price stream, the request API and the symbols registry */
  readonly pro: ProClient;
  readonly prices: PriceService;
  readonly subgraph: SubgraphClient | null;
  /** where the snapshot, the ledger and the status file live */
  readonly stateDir: string;
  readonly ledger: Ledger;
  readonly executor: Executor;
  /** the enabled jobs, by name, in the order they plan */
  jobs: Map<string, Job>;
  readonly alerts: Alerter;
  /** One-shot runs of every job and the manual operations: `await keeper.run.liquidate("BTC/USD", { dryRun: true })`. */
  readonly run: Operations;
  /** the factory's wiring, once connected */
  dep: Deployment | null = null;
  tail: LogTail | null = null;
  /** the latest block seen */
  head = 0;
  connected = false;
  /** the latest sent results, newest first */
  readonly recent: ActionResult[] = [];
  /** true while {@link start} runs (set false by {@link stop}) */
  running = false;
  /** set once a sync step has brought the index to the head; the print path waits for it */
  readonly synced = new Signal();
  /** `${job}:${market}` of the price-driven plans running now */
  readonly planning = new Set<string>();
  /** ... and of those to run once more when they finish */
  readonly replan = new Set<string>();
  /** background work (plans, sends, alerts) not finished yet */
  readonly tasks = new Set<Promise<unknown>>();

  private blockTs = 0;
  private seen = monotonic();
  private readonly listeners = new Map<KeeperEvent, KeeperListener<never>[]>();
  private readonly timers = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  /** the shared labels already warned about, so each warning is logged once */
  private readonly sharedLabels = new Set<string>();
  /** one log scan at a time: the engine and one-shot calls share the store */
  private readonly syncLock = new Mutex();
  private readonly loadsWallets: boolean;
  private walletsLoaded = false;
  private readonly wallets = new Set<Address>();
  private connecting: Promise<void> | null = null;
  private stopRequested = false;
  /** a run has ended: its price service is stopped for good */
  private ran = false;
  private stopping: Promise<void> | null = null;
  private loopDone: Promise<void> | null = null;
  private readonly sleepers = new Set<() => void>();
  // feed id -> the markets that have it as a leg, rebuilt when the store's markets change
  private feedIndex = new Map<Hex, Market[]>();
  private feedIndexStore: Store | null = null;
  private feedIndexSize = -1;

  /**
   * Build a keeper and load its wallets (a keystore may prompt for its password). Throws ConfigError
   * for a config the keeper cannot run with, WalletError for a wallet it cannot load.
   */
  static async create(cfg: KeeperConfig, opts: KeeperOptions = {}): Promise<Keeper> {
    const k = new Keeper(cfg, opts);
    if (opts.loadWallets ?? true) await k.loadWallets();
    return k;
  }

  /**
   * Build a keeper without loading its wallets yet: {@link connect} (and so {@link start} and every
   * `run.*` call) loads them first unless `loadWallets: false`. {@link create} loads them at once.
   */
  constructor(cfg: KeeperConfig, opts: KeeperOptions = {}) {
    this.cfg = cfg;
    this.net = resolvedNetwork(cfg);
    let send = cfg.rpc.send ?? null;
    if (send === "sequencer") {
      if (!this.net.sendUrl) throw new ConfigError(`rpc.send is 'sequencer', but ${this.net.name} has no sequencer endpoint preset`);
      send = this.net.sendUrl;
    }
    let endpoints: ProEndpoints;
    try {
      endpoints = priceEndpoints(cfg.prices);
    } catch (e) {
      throw new ConfigError(e instanceof Error ? e.message : String(e)); // each message names its setting
    }
    this.loadsWallets = opts.loadWallets ?? true;
    this.chain = Chain.fromUrl(cfg.rpc.http, { perSecond: cfg.rpc.maxRequestsPerSecond, sendUrl: send });
    this.reader = new Reader(this.chain);
    this.store = new Store();
    try {
      this.pro = new ProClient({
        ...endpoints,
        token: cfg.prices.token ?? null,
        channel: cfg.prices.channel,
        headers: cfg.prices.headers,
        allowInsecure: cfg.prices.allowInsecure,
        // The ws package's, bounded (stream-socket.ts): Node has a global WebSocket only from version 22,
        // and its defaults would buffer frames of up to 100 MiB, compressed or not.
        WebSocket: streamSocket,
        // Streamed updates are judged against the chain's clock, as their prices are: on a chain whose
        // clock was moved, this machine's would refuse every update as dated ahead.
        clock: () => this.chainTime(),
        signerCheckInterval: cfg.prices.signerCheckIntervalSeconds,
      });
    } catch (e) {
      // The client names the setting at fault and never quotes a value.
      if (e instanceof ProError) throw new ConfigError(`prices: ${e.message}`);
      // Its refusal of a missing key for Pyth's own endpoints. Config validation refuses that first
      // (missingProKey); a config that never went through it is refused here, in the same words.
      if (e instanceof InputError) {
        const noKey = missingProKey(cfg.prices);
        throw new ConfigError(noKey === null ? e.message : `prices.token: ${noKey}`);
      }
      throw e;
    }
    this.prices = new PriceService(this.pro, {
      stream: cfg.prices.stream,
      pollInterval: cfg.prices.pollInterval,
      // To the fraction of a second: a whole-second clock would judge a print up to a second younger than it is.
      clock: () => this.chainTime(),
      sendMargin: cfg.prices.sendMarginSeconds,
      streamIdleTimeout: cfg.prices.streamIdleTimeoutSeconds,
      ethUsdMaxAge: cfg.gas.ethUsdMaxAgeSeconds,
      logger: { warn: (m) => priceLog.warning(m) },
    });
    const sg = subgraphUrl(cfg);
    this.subgraph = sg ? new SubgraphClient(sg, cfg.subgraph.apiKey) : null;
    this.stateDir = stateDirFor(cfg);
    this.ledger = new Ledger(join(this.stateDir, "ledger.jsonl"));
    this.executor = new Executor(
      this.chain,
      cfg,
      this.ledger,
      new Map<string, Lane>(),
      this.net.chainId,
      ZERO_ADDRESS, // the lens, once the deployment is read
      () => this.prices.ethUsd(),
      (kind, payload) => this.emit(kind, payload as never),
    );
    this.executor.clock = () => this.chainTime();
    this.jobs = new Map();
    for (const [name, jc] of Object.entries(enabledJobs(cfg.jobs))) this.jobs.set(name, new JOBS[name as JobName](this, jc as never));
    this.alerts = new Alerter(cfg.alerts);
    this.run = new Operations(this);
  }

  /** Load the configured wallets' signers (once). */
  async loadWallets(): Promise<void> {
    if (this.walletsLoaded) return;
    for (const [name, w] of Object.entries(this.cfg.wallets)) {
      const lane = new Lane(name, await loadSigner(name, w));
      this.executor.lanes.set(name, lane);
      this.wallets.add(lane.address);
    }
    this.walletsLoaded = true;
  }

  // ---- basics ----

  /** The chain's clock: the latest block's timestamp plus the time since we saw it (unix seconds). */
  now(): number {
    if (!this.blockTs) return Math.floor(Date.now() / 1000);
    return this.blockTs + Math.floor(monotonic() - this.seen);
  }

  /** {@link now} to the fraction of a second, for scheduling against block times. */
  chainTime(): number {
    if (!this.blockTs) return Date.now() / 1000;
    return this.blockTs + (monotonic() - this.seen);
  }

  /** The keeper's own wallet addresses (their positions are never liquidated or settled by it). */
  walletAddresses(): ReadonlySet<Address> {
    const lanes = this.executor.lanes;
    if (this.wallets.size !== lanes.size) {
      this.wallets.clear(); // in place: the log tail holds this set
      for (const lane of lanes.values()) this.wallets.add(lane.address);
    }
    return this.wallets;
  }

  /**
   * Subscribe to "action" (a sent transaction's result), "sent", "alert" or "opportunity". Returns
   * the function that unsubscribes. A listener that throws (or rejects) is logged and never breaks
   * the keeper.
   */
  on<K extends KeeperEvent>(event: K, handler: KeeperListener<K>): () => void {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(handler as KeeperListener<never>);
    return () => {
      const l = this.listeners.get(event);
      const i = l ? l.indexOf(handler as KeeperListener<never>) : -1;
      if (i >= 0) l!.splice(i, 1);
    };
  }

  /** Deliver an event (the executor reports through here). */
  emit<K extends KeeperEvent>(kind: K, payload: KeeperEvents[K]): void {
    if (kind === "alert") {
      const [alertKind, msg] = payload as KeeperEvents["alert"];
      this.spawn(this.alerts.send(alertKind, msg));
    }
    if (kind === "action") {
      const r = payload as ActionResult;
      this.recent.unshift(r);
      if (this.recent.length > RECENT) this.recent.length = RECENT;
      if (this.cfg.alerts.notify.includes("action")) {
        const msg = `${r.job} ${r.market}: ${r.status}, earned $${r.rewardUsd.toFixed(4)} for $${r.costUsd.toFixed(4)}`;
        this.spawn(this.alerts.send("action", msg, { repeatAfter: 0 }));
      }
    }
    const list = this.listeners.get(kind);
    if (!list || list.length === 0) return;
    for (const fn of [...list]) {
      try {
        const out = (fn as KeeperListener<K>)(payload);
        if (out instanceof Promise) out.then(noop, (e: unknown) => log.exception("listener for %s failed", kind, ...exc(e)));
      } catch (e) {
        log.exception("listener for %s failed", kind, ...exc(e)); // a listener must not break the engine
      }
    }
  }

  /** Run `p` in the background: tracked until it settles (stop() waits for it), a failure logged. */
  spawn<T>(p: Promise<T>): Promise<T | undefined> {
    const t: Promise<T | undefined> = p.then(
      (v) => {
        this.tasks.delete(t);
        return v;
      },
      (e: unknown) => {
        this.tasks.delete(t);
        log.warning("background task failed: %s", e, ...exc(e));
        return undefined;
      },
    );
    this.tasks.add(t);
    return t;
  }

  private every(name: string, seconds: number): boolean {
    const now = monotonic();
    if ((this.timers.get(name) ?? 0) <= now) {
      // Expired entries behave as missing ones: dropped, so distinct skip reasons do not pile up.
      if (this.timers.size > 512) for (const [k, t] of this.timers) if (t <= now) this.timers.delete(k);
      this.timers.set(name, now + seconds);
      return true;
    }
    return false;
  }

  /** Log why a market's print is not attached to a call: at debug level, at most once a minute per market. */
  unusablePrint(m: Market, why: string): void {
    if (this.every(`print:${m.address}`, 60)) priceLog.debug("%s: %s; skipping it", m.label || m.address, why);
  }

  // ---- markets ----

  /**
   * The market `ref` names: an address, a pair id, or a label or description (case-insensitive).
   * Throws ConfigError when none or several match.
   */
  resolveMarket(ref: string): Market {
    const matches = this.findMarkets(ref);
    if (matches.length === 1) return matches[0]!;
    throw new ConfigError(`'${ref.trim()}' matches several markets (${matches.map((m) => m.address).join(", ")}); use an address`);
  }

  /**
   * The markets `ref` names: the one at an address or pair id, or every one whose label or description
   * it is (labels are not unique). Throws ConfigError when it names none.
   */
  findMarkets(ref: string): Market[] {
    ref = ref.trim();
    const hex40 = /^(?:0[xX])?([0-9a-fA-F]{40})$/.exec(ref);
    if (hex40 && isAddress(`0x${hex40[1]}`)) {
      const m = this.store.markets.get(getAddress(`0x${hex40[1]}`));
      if (m) return [m];
      throw new ConfigError(`${ref} is not a market of this factory`);
    }
    if (ref.toLowerCase().startsWith("0x") && ref.length === 66) {
      const m = this.store.marketByPairId(ref as Hex);
      if (m) return [m];
    }
    const low = ref.toLowerCase();
    const matches: Market[] = [];
    for (const m of this.store.markets.values()) {
      if (low === m.label.toLowerCase() || low === m.description.toLowerCase()) matches.push(m);
    }
    if (matches.length > 0) return matches;
    const known = [...this.store.markets.values()].map((m) => m.label || m.address).sort().join(", ") || "none";
    throw new ConfigError(`no market called '${ref}'. Markets: ${known}`);
  }

  /**
   * Each job's market scope and exclusions, from its config. Throws ConfigError for a name no market
   * carries, leaving every job's scope as it was.
   *
   * A label can name several markets: a market relisted after a termination carries its predecessor's
   * label, and a composite is labelled after its base. Such a label covers all of them, with a warning
   * that names their addresses. Each job plans only the markets in a status it runs in, so it is the
   * live one that a live-market job acts on, while terminal settlement and collect still reach the
   * terminated one. (At this point a newly found market has no state yet to choose by.)
   */
  resolveScopes(): void {
    const next: [Job, Set<Address> | null, Set<Address>][] = [];
    for (const job of this.jobs.values()) {
      const c = job.cfg;
      const at = `jobs.${job.name}`;
      next.push([job, c.markets === "all" ? null : this.scopeOf(c.markets, `${at}.markets`), this.scopeOf(c.exclude, `${at}.exclude`)]);
    }
    for (const [job, scope, excluded] of next) {
      job.scope = scope;
      job.excluded = excluded;
    }
  }

  private scopeOf(refs: readonly string[], at: string): Set<Address> {
    const out = new Set<Address>();
    for (const ref of refs) {
      const found = this.findMarkets(ref);
      for (const m of found) out.add(m.address);
      if (found.length < 2) continue;
      const addresses = found.map((m) => m.address).join(", ");
      const key = `${at}:${ref}:${addresses}`;
      if (this.sharedLabels.has(key)) continue;
      this.sharedLabels.add(key);
      log.warning(
        "%s: '%s' names %d markets (%s); it covers each of them, in the statuses each job runs in. Write an address to choose one",
        at,
        safeLabel(ref),
        found.length,
        addresses,
      );
    }
    return out;
  }

  /** The markets at least one enabled job covers. */
  watchedMarkets(): Market[] {
    const out: Market[] = [];
    const jobs = [...this.jobs.values()];
    for (const m of this.store.markets.values()) if (jobs.some((j) => j.inScope(m))) out.push(m);
    return out;
  }

  private async label(markets: readonly Market[], descriptions?: ReadonlyMap<Address, string> | null): Promise<void> {
    const feeds = new Set<Hex>();
    for (const m of markets) for (const leg of m.legs) feeds.add(leg);
    const symbols = await fetchSymbols(this.pro, feeds);
    const symbol = (leg: Hex | undefined) => (leg === undefined ? undefined : symbols.get(leg.toLowerCase() as Hex));
    for (const m of markets) {
      const d = descriptions?.get(m.address);
      if (typeof d === "string") m.description = d;
      const base = symbol(m.legs[0]);
      const quote = m.legs.length === 2 ? symbol(m.legs[1]) || "" : null;
      let label = marketLabel(base, quote);
      if (!label) {
        const desc = m.description.trim();
        label = desc.length > 0 && desc.length <= 24 ? desc : m.address.slice(0, 10);
      }
      // Symbols and descriptions come from the symbols registry and the lister: shown, never trusted.
      m.label = safeLabel(label) || m.address.slice(0, 10);
    }
  }

  /** Add the factory's markets the store does not hold yet, labelled; returns them. */
  async discoverMarkets(): Promise<Market[]> {
    const addrs = await this.reader.pairAddresses();
    const fresh = addrs.filter((a) => !this.store.markets.has(a));
    if (fresh.length === 0) return [];
    const markets = await this.reader.describe(fresh);
    await this.label(markets);
    for (const m of markets) this.store.addMarket(m);
    return markets;
  }

  // ---- connecting and syncing ----

  /**
   * With prices.checkSigners on and the deployment read, have the price client use only updates
   * signed by a signer the deployment's Pyth verifier trusts. The chain verifies every update a call
   * carries either way; the ETH/USD print that prices gas reaches no contract, so only this checks it.
   */
  checkSigners(): void {
    if (this.dep !== null && this.cfg.prices.checkSigners) this.pro.isTrustedSigner = verifierSignerCheck(this.chain, this.dep.oracle);
  }

  /** Read the latest block: the head, the chain's clock and the base fee. */
  async updateBlock(): Promise<void> {
    const b = await this.chain.block("latest");
    if (b.number !== this.head || !this.blockTs) {
      this.head = b.number;
      this.blockTs = b.timestamp;
      this.seen = monotonic();
    }
    this.executor.baseFee = b.baseFee;
  }

  /**
   * Check the chain and the factory's wiring, load the snapshot (or bootstrap from the subgraph or
   * logs), and read every watched market's state. Once; later calls return at once.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (this.loadsWallets) await this.loadWallets();
    const cid = await this.chain.chainId();
    if (cid !== this.net.chainId) {
      throw new ConfigError(`the RPC is on chain ${cid}, but network ${this.net.name} is chain ${this.net.chainId}`);
    }
    this.dep = await this.reader.deployment(this.net.factory);
    this.executor.lens = this.dep.lens;
    this.checkSigners();
    const problems = await this.reader.wiringProblems();
    if (problems.length) throw new ConfigError("refusing to start: " + problems.join("; "));
    const snap = Store.load(join(this.stateDir, "snapshot.json"), cid, this.net.factory);
    if (snap !== null) {
      // A snapshot written by an older keeper may hold labels as the endpoint gave them.
      for (const m of snap.markets.values()) m.label = safeLabel(m.label) || m.address.slice(0, 10);
      this.store = snap;
    }
    await this.discoverMarkets();
    await this.updateBlock();
    this.tail = new LogTail(this.chain, this.store, this.dep, this.walletAddresses(), this.cfg.rpc.logChunk, TAIL_LOG);
    if (this.store.head < 0) await this.bootstrapIndex();
    this.resolveScopes();
    this.prices.watchMarkets(this.watchedMarkets());
    await this.readStates(true);
    this.connected = true;
    if (!this.net.official) log.warning("factory %s is not an official deployment", this.net.factory);
    if (this.executor.lanes.size === 0 && this.loadsWallets) log.warning("no wallet configured: watch-only, nothing will be sent");
  }

  private async bootstrapIndex(): Promise<void> {
    if (this.subgraph !== null) {
      try {
        const [n, , errors] = await this.subgraph.meta();
        if (errors) log.warning("the subgraph reports indexing errors; chain reads will correct what it misses");
        const block = Math.min(n, this.head);
        const descriptions = await this.subgraph.descriptions(block);
        await this.label([...this.store.markets.values()], descriptions);
        const [pos, orders] = await bootstrapFromSubgraph(this.subgraph, this.store, block);
        this.store.head = block;
        this.store.headHash = "";
        log.info("loaded %d open positions and %d live orders from the subgraph at block %d", pos, orders, block);
        return;
      } catch (e) {
        // Whatever fails here (the subgraph, a row or description it cannot read, the labelling), chain
        // logs are the fallback: a first start must not depend on the subgraph. Nothing is half-loaded:
        // the bootstrap writes the store only once every page is read and parsed.
        log.warning("subgraph unavailable (%s); indexing from chain logs instead", e instanceof SubgraphError ? e.message : errorText(e));
      }
    }
    const dep = this.dep!;
    const start = this.net.startBlock ?? (await this.factoryDeploymentBlock());
    log.info("indexing from chain logs, blocks %d to %d", start, this.head);
    await this.tail!.scan(start, this.head, [dep.factory, dep.terminator, ...this.store.markets.keys()]);
    this.store.head = this.head;
    this.store.headHash = (await this.chain.block(this.head)).hash;
  }

  /**
   * Where the log scan starts when neither the config nor an official preset gives startBlock: the
   * factory's deployment block, found by a binary search on its code (one read per halving of the
   * chain's history). Nothing of Bazaar's can emit a log before its factory exists. A node without
   * historical state cannot answer; then the keeper refuses to start rather than scan from block 0,
   * which takes at least one log request per rpc.logChunk blocks of the chain's whole history.
   */
  private async factoryDeploymentBlock(): Promise<number> {
    const factory = this.net.factory;
    try {
      const block = await findDeploymentBlock(this.chain, factory, { head: this.head });
      log.info("found the factory's deployment block, %d (set startBlock: %d in the config to skip the search)", block, block);
      return block;
    } catch (e) {
      throw new ConfigError(
        `could not find the factory's deployment block (${errorText(e)}). Set startBlock in the config to the block ` +
          "the factory was deployed in, use an RPC that keeps historical state, or configure a subgraph",
      );
    }
  }

  /**
   * Read the state of `markets` (default: the watched ones) that are dirty, not read for
   * engine.idleRefreshSeconds, or all of them with `force`, in one batched read at the head.
   */
  async readStates(force = false, markets?: readonly Market[] | null): Promise<void> {
    const now = Date.now();
    const idle = this.cfg.engine.idleRefreshSeconds * 1000;
    const pool = markets ?? this.watchedMarkets();
    const due = pool.filter((m) => force || m.dirty || now - m.lastRead >= idle);
    if (due.length === 0) return;
    const states = await this.reader.marketStates(due, this.head, this.blockTs);
    for (const m of due) {
      const s = states.get(m.address);
      if (s !== undefined) {
        m.state = s;
        m.dirty = false;
        m.lastRead = now;
      }
    }
  }

  /** Read the head, apply the logs since the last step, and re-read the markets they changed. */
  async syncStep(): Promise<void> {
    return this.syncLock.runExclusive(() => this.syncStepLocked());
  }

  private async syncStepLocked(): Promise<void> {
    const before = this.store.head;
    await this.updateBlock();
    if (this.head - this.store.head >= CATCH_UP_BLOCKS) this.synced.clear();
    const tail = this.tail;
    if (tail === null) throw new Error("the keeper is not connected: call connect() first");
    if (this.head > this.store.head || tail.hasPending) {
      const fx = await tail.advance(this.head);
      if (fx.newPairs.length) {
        // From the first block these effects cover, which is earlier than `before` when an earlier
        // step applied part of this catch-up and then failed.
        await this.registerNew(fx.newPairs, fx.firstBlock === null ? before + 1 : fx.firstBlock);
      }
      for (const a of fx.dirty) {
        const m = this.store.markets.get(a);
        if (m) m.dirty = true;
      }
      const unload = this.jobs.get("unload");
      if (unload instanceof UnloadJob) {
        for (const a of fx.bookChanged) unload.wake(a);
        for (const a of fx.liquidations) unload.wake(a);
      }
      const collect = this.jobs.get("collect");
      if (fx.claimsChanged && collect instanceof CollectJob) collect.wake();
    }
    await this.readStates();
    this.synced.set();
  }

  private async registerNew(addresses: readonly Address[], fromBlock: number): Promise<void> {
    const fresh = addresses.filter((a) => !this.store.markets.has(a));
    if (fresh.length === 0) return;
    const markets = await this.reader.describe(fresh);
    await this.label(markets);
    for (const m of markets) {
      this.store.addMarket(m);
      log.info("new market listed: %s (%s)", m.label, m.address);
    }
    await this.tail!.scan(fromBlock, this.store.head, fresh);
    try {
      this.resolveScopes();
    } catch (e) {
      // A listing never stops a running keeper: every job keeps the scope it had.
      log.warning("the jobs' markets were not updated for the new listing: %s", errorText(e));
    }
    this.prices.watchMarkets(this.watchedMarkets());
  }

  // ---- running ----

  /**
   * Let every job plan once: the per-market jobs on each market they may run on, the others once.
   * The price-driven jobs go through {@link planSoon}, sharing one plan per market with the print path.
   */
  async tick(): Promise<void> {
    const plans: [Job, Promise<Action[]>][] = [];
    for (const job of this.jobs.values()) {
      if (job.perMarket) {
        for (const m of this.store.markets.values()) {
          if (!job.runnable(m)) continue;
          if (job.onPrint) this.planSoon(job, m);
          else plans.push([job, callPlan(() => job.plan(m))]);
        }
      } else {
        plans.push([job, callPlan(() => job.planGlobal())]);
      }
    }
    if (plans.length === 0) return;
    const results = await Promise.allSettled(plans.map(([, p]) => p));
    for (let i = 0; i < plans.length; i++) {
      const job = plans[i]![0];
      const r = results[i]!;
      if (r.status === "rejected") {
        this.planningFailed(job, r.reason);
        continue;
      }
      for (const a of r.value) this.dispatch(job, a);
    }
  }

  /**
   * Plan `job` on `m` now, or, if a plan of it is already running there, once more after it.
   *
   * The print path and the tick both go through here, so a job plans each market one at a time, and
   * however many prints arrive during a plan, they cost one more plan with the newest print.
   */
  planSoon(job: Job, m: Market): void {
    const key = `${job.name}:${m.address}`;
    if (this.planning.has(key)) {
      this.replan.add(key);
      return;
    }
    this.planning.add(key); // before the plan starts: it may finish without ever yielding
    this.spawn(this.planMarket(job, m, key));
  }

  private async planMarket(job: Job, m: Market, key: string): Promise<void> {
    try {
      for (;;) {
        this.replan.delete(key);
        if (job.runnable(m)) {
          let actions: Action[] | null = null;
          try {
            actions = await job.plan(m);
          } catch (e) {
            this.planningFailed(job, e); // reported like a failed tick plan
          }
          if (actions !== null) for (const a of actions) this.dispatch(job, a);
        }
        if (!this.replan.has(key) || !this.running) return;
      }
    } finally {
      this.planning.delete(key);
    }
  }

  /** feed id -> markets with that leg; rebuilt only when the store or its market count changes. */
  private marketsByFeed(): Map<Hex, Market[]> {
    const store = this.store;
    if (store !== this.feedIndexStore || store.markets.size !== this.feedIndexSize) {
      const index = new Map<Hex, Market[]>();
      for (const m of store.markets.values()) {
        for (const leg of m.legs) {
          const id = leg.toLowerCase() as Hex;
          let list = index.get(id);
          if (!list) {
            list = [];
            index.set(id, list);
          }
          if (!list.includes(m)) list.push(m);
        }
      }
      this.feedIndex = index;
      this.feedIndexStore = store;
      this.feedIndexSize = store.markets.size;
    }
    return this.feedIndex;
  }

  /** Plan the price-driven jobs on the markets that have one of `feeds` as a leg. */
  private planPrints(feeds: ReadonlySet<Hex>, jobs: readonly Job[]): void {
    const index = this.marketsByFeed();
    const seen = feeds.size > 1 ? new Set<Market>() : null; // a composite's two legs may both be new
    for (const f of feeds) {
      const markets = index.get(f);
      if (markets === undefined) continue;
      for (const m of markets) {
        if (seen !== null) {
          if (seen.has(m)) continue;
          seen.add(m);
        }
        for (const job of jobs) if (job.runnable(m)) this.planSoon(job, m);
      }
    }
  }

  /** Plan the price-driven jobs on a market as soon as a newer print arrives for one of its legs. */
  async priceLoop(): Promise<void> {
    const jobs = [...this.jobs.values()].filter((j) => j.perMarket && j.onPrint);
    let held: Set<Hex> | null = null;
    while (this.running && jobs.length > 0) {
      // Not while the index is catching up: positions opened meanwhile are not in it yet, and a
      // plan's re-read would be overlaid by the bounty deltas still being replayed. The tick does not
      // run during a catch-up either, and plans everything once it ends.
      if (!this.synced.isSet) {
        await this.synced.wait();
        continue; // re-check: stop() wakes this wait without setting it
      }
      let feeds: Set<Hex>;
      if (held !== null) {
        feeds = held; // what arrived as a catch-up began, now that it has ended
        held = null;
      } else {
        feeds = await this.prices.nextPrints();
        if (!this.running || feeds.size === 0) return; // empty only once the price service has stopped
        if (!this.synced.isSet) {
          held = feeds; // a catch-up began while these arrived: plan them once it ends
          continue;
        }
      }
      try {
        this.planPrints(feeds, jobs);
      } catch (e) {
        // one bad batch must not end the loop
        if ((this.errors.get("prints") ?? 0) < monotonic()) {
          this.errors.set("prints", monotonic() + 30);
          log.warning("planning on new prints failed: %s", e, ...exc(e));
        }
      }
    }
  }

  private planningFailed(job: Job, err: unknown): void {
    if ((this.errors.get(job.name) ?? 0) < monotonic()) {
      this.errors.set(job.name, monotonic() + 60);
      log.warning("%s: planning failed: %s", job.name, err, ...exc(err));
    }
  }

  /**
   * Hand `action` to the executor in the background, unless one of its lock keys is in flight (the
   * print path and the tick never send the same candidate twice) or the keeper is stopping. Returns
   * the run's promise (never rejecting), or null when not dispatched.
   */
  dispatch(job: Job, action: Action): Promise<ActionResult | null> | null {
    if (this.stopRequested) return null;
    if (!this.executor.tryLock(action.locks)) return null;
    return this.spawn(this.execute(job, action)) as Promise<ActionResult | null>;
  }

  private async execute(job: Job, action: Action): Promise<ActionResult | null> {
    let res: ActionResult | null = null;
    try {
      res = await this.executor.run(action, { jobCfg: job.cfg });
    } catch (e) {
      log.warning("%s: %s failed: %s", job.name, action.summary, e, ...exc(e));
    } finally {
      this.executor.unlock(action.locks);
    }
    if (res !== null) {
      job.note(action, res);
      if (res.sent) {
        log.info(
          "%s %s: %s %s, earned $%s for $%s",
          job.name,
          res.market || "-",
          res.summary,
          res.status,
          res.rewardUsd.toFixed(4),
          res.costUsd.toFixed(4),
        );
      } else {
        // Skips repeat every tick; show each distinct reason at most every five minutes.
        const say = this.every(`skip:${job.name}:${res.market}:${res.reason.slice(0, 60)}`, 300) ? log.info : log.debug;
        say("%s %s: skipped %s: %s", job.name, res.market || "-", res.summary, res.reason);
      }
    }
    return res;
  }

  /**
   * Run the enabled jobs until {@link stop}: connect, then every engine.tickSeconds sync, plan and
   * dispatch, while the print path plans liquidation and triggers on each newer print. Resolves once
   * stop() has finished (in-flight sends waited for, earnings collected if configured, snapshot
   * saved); rejects if connecting fails.
   */
  async start(): Promise<void> {
    if (this.loopDone !== null) throw new Error("the keeper is already running");
    if (this.ran) throw new Error("this keeper has already run and stopped; create a new Keeper to start again");
    this.stopRequested = false;
    let exited: () => void = noop;
    this.loopDone = new Promise<void>((resolve) => (exited = resolve));
    try {
      await this.connect();
      if (!this.stopRequested) await this.runLoop();
    } finally {
      this.loopDone = null;
      exited();
    }
    // A stop() in progress finishes its shutdown first; its own caller sees any failure.
    const stopping = this.stopping;
    if (stopping !== null) await stopping.catch(noop);
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    this.synced.clear(); // the first sync step replays whatever the snapshot is behind by
    this.ran = true;
    const priceTask = this.prices.run().catch((e: unknown) => log.warning("the price service failed: %s", e, ...exc(e)));
    const printTask = this.priceLoop().catch((e: unknown) => log.warning("the print path failed: %s", e, ...exc(e)));
    log.info(
      "keeper running on %s (%d markets, jobs: %s)",
      this.net.name,
      this.store.markets.size,
      [...this.jobs.keys()].join(", ") || "none",
    );
    if (!this.cfg.prices.checkSigners) log.warning("%s", UNCHECKED_SIGNERS_WARNING);
    try {
      while (this.running) {
        const t0 = monotonic();
        try {
          await this.syncStep();
          await this.tick();
          await this.housekeeping();
        } catch (e) {
          // one bad step must not end the loop
          if ((this.errors.get("loop") ?? 0) < monotonic()) {
            this.errors.set("loop", monotonic() + 30);
            log.warning("engine step failed: %s", e, ...exc(e));
          }
          await this.pause(1);
        }
        await this.pause(Math.max(0, this.cfg.engine.tickSeconds - (monotonic() - t0)));
      }
    } finally {
      this.running = false;
      this.prices.stop();
      this.synced.release();
      this.wakeSleepers();
      await settleWithin(Promise.all([priceTask, printTask]), 5);
    }
  }

  /** Sleep between ticks; stop() cuts it short. */
  private pause(seconds: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      this.sleepers.add(done);
    });
  }

  private wakeSleepers(): void {
    for (const wake of [...this.sleepers]) wake();
  }

  /**
   * Stop: end the price stream, the print path and the tick loop at once, dispatch nothing new, wait
   * (up to `timeout` seconds, default 60) for the loop and the in-flight sends, claim earnings if
   * `collect` (default jobs.collect.onShutdown), and save the snapshot. `stop({ collect: false })`,
   * or `stop(false, 30)`. Calling it again while it runs returns the same promise.
   */
  stop(opts?: StopOptions | boolean | null, timeout?: number): Promise<void> {
    const o: StopOptions = typeof opts === "object" && opts !== null ? opts : { collect: opts ?? null, timeout };
    this.stopping ??= this.shutdown(o.collect ?? null, o.timeout ?? timeout ?? 60).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async shutdown(collect: boolean | null, timeout: number): Promise<void> {
    const deadline = monotonic() + timeout;
    const left = () => deadline - monotonic();
    this.stopRequested = true;
    this.running = false;
    if (this.loopDone !== null) this.prices.stop(); // ends the stream now, not when the loop notices
    this.synced.release();
    this.wakeSleepers();
    const loop = this.loopDone;
    if (loop !== null) await settleWithin(loop, left());
    // Plans finishing now dispatch nothing; sends in flight get their receipts.
    while (this.tasks.size > 0 && left() > 0) await settleWithin(Promise.all([...this.tasks]), left());
    const job = this.jobs.get("collect");
    if (job instanceof CollectJob && (collect ?? job.cfg.onShutdown)) {
      try {
        for (const a of await job.claims(true)) {
          if (this.executor.tryLock(a.locks)) {
            try {
              await this.executor.run(a, { jobCfg: job.cfg });
            } finally {
              this.executor.unlock(a.locks);
            }
          }
        }
      } catch (e) {
        log.warning("collect on shutdown failed: %s", e);
      }
    }
    this.save();
  }

  /** Release the keeper's clients (call after stop(), or after one-shot use). */
  async close(): Promise<void> {
    this.prices.stop();
    await this.pro.close();
    await this.alerts.close();
    if (this.subgraph) await this.subgraph.close();
  }

  // ---- housekeeping ----

  /** Write the index to the snapshot (once connected), so a restart tails from its block. */
  save(): void {
    if (!this.connected) return;
    mkdirSync(this.stateDir, { recursive: true });
    this.store.save(join(this.stateDir, "snapshot.json"), this.net.chainId, this.net.factory);
  }

  private async housekeeping(): Promise<void> {
    if (this.every("balances", 60)) await this.checkBalances();
    if (this.every("snapshot", this.cfg.engine.snapshotSeconds)) this.save();
    if (this.every("status", 5)) this.writeStatus();
    if (this.every("summary", 86_400) && this.ledger.entries.length) {
      const s = this.ledger.summary(Date.now() / 1000 - 86_400);
      let total = 0;
      for (const v of Object.values(s)) total += v.net;
      this.spawn(this.alerts.send("dailySummary", `last 24 h: net $${total.toFixed(2)} across ${Object.keys(s).length} job(s)`));
    }
    if (this.cfg.alerts.notify.includes("opportunity") && this.alerts.configured && this.every("opportunities", 300)) {
      this.spawn(this.scanOpportunities());
    }
  }

  private async checkBalances(): Promise<void> {
    const lanes = [...this.executor.lanes.values()];
    const balances = await Promise.all(lanes.map((lane) => this.chain.balance(lane.address)));
    const min = this.cfg.budget.minEthBalance * 1e18;
    const low: string[] = [];
    lanes.forEach((lane, i) => {
      const bal = Number(balances[i]!);
      if (bal < min) low.push(`${lane.name} (${lane.address}) holds ${(bal / 1e18).toFixed(5)} ETH`);
    });
    if (low.length) {
      this.executor.halted = "sending paused: " + low.join("; ") + ", below budget.minEthBalance";
      this.emit("alert", ["lowBalance", this.executor.halted]);
    } else {
      this.executor.halted = "";
    }
  }

  private async scanOpportunities(): Promise<void> {
    try {
      for (const o of await findOpportunities(this)) {
        this.emit("opportunity", o);
        await this.alerts.send("opportunity", o.describe(), { repeatAfter: 86_400 });
      }
    } catch (e) {
      log.debug("opportunity scan failed: %s", e);
    }
  }

  /** What `status.json` holds: the head, the index, prices, each market and job, the wallets. */
  statusDict(): KeeperStatus {
    const now = this.now();
    const byJob = this.ledger.summary(Date.now() / 1000 - 86_400);
    const liq = this.jobs.get("liquidation");
    const markets: MarketStatusEntry[] = [];
    for (const m of this.store.markets.values()) {
      const st = m.state;
      const legs = this.prices.legs(m);
      markets.push({
        label: m.label,
        address: m.address,
        status: st ? marketStatus(st, now) : "unknown",
        positions: this.store.positions.get(m.address)?.size ?? 0,
        orders: this.store.orders.get(m.address)?.size ?? 0,
        inventory: st ? Number(inventorySize(st)) / 1e18 : 0,
        atRisk: liq instanceof LiquidationJob ? liq.atRisk(m) : null,
        priceAge: legs && legs.length ? now - legs[0]!.publishTime : null,
      });
    }
    const jobs: Record<string, JobStatusEntry> = {};
    for (const [name, job] of this.jobs) {
      const last = this.recent.find((r) => r.job === name);
      let count = 0;
      if (job.perMarket) for (const m of this.store.markets.values()) if (job.inScope(m)) count += 1;
      jobs[name] = {
        markets: job.perMarket ? count : "all",
        last: last ? `${last.market} ${last.summary} (${last.status})` : "",
        today: byJob[name] ?? {},
      };
    }
    const wallets: Record<string, Address> = {};
    for (const [n, lane] of this.executor.lanes) wallets[n] = lane.address;
    return {
      updated: Date.now() / 1000,
      network: this.net.name,
      factory: this.net.factory,
      official: this.net.official,
      block: this.head,
      indexed: this.store.head,
      prices: { healthy: this.prices.healthy, error: this.prices.lastError, feeds: this.prices.latest.size },
      markets,
      jobs,
      wallets,
      halted: this.executor.halted,
    };
  }

  /** Write `status.json` atomically (a temp file renamed over it), for `bazaar keeper status`. */
  writeStatus(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = join(this.stateDir, "status.tmp");
      writeFileSync(tmp, JSON.stringify(this.statusDict()), "utf8");
      renameSync(tmp, join(this.stateDir, "status.json"));
    } catch (e) {
      if (!isFsError(e)) throw e;
      log.debug("could not write status: %s", e);
    }
  }
}

/** A plan's promise, with a synchronous throw turned into a rejection. */
function callPlan(plan: () => Promise<Action[]>): Promise<Action[]> {
  try {
    return plan();
  } catch (e) {
    return Promise.reject(e);
  }
}
