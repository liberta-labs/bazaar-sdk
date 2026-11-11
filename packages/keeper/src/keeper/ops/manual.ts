/**
 * One-shot runs of the automatic jobs, and the manual operations, each naming its market per call.
 *
 * Every call is simulated first. Automatic jobs run once keep their profit and loss rules unless
 * `force: true`. Manual operations pay the caller nothing and run because they were asked for; with
 * `dryRun: true` they only report what would happen. Neither force nor a manual operation lifts the
 * daily spend caps, the low-balance halt or the fee ceilings, and a call the running keeper is
 * already sending (its in-flight keys are taken) is not sent again.
 *
 * A market is named by its label ("BTC/USD"), its description, its address or its pair id.
 */

import {
  type BazaarContext,
  type Deployment,
  InputError,
  type Market,
  ProError,
  STOP_LIMIT,
  ZERO_ADDRESS,
  factory as factoryCodec,
  marketStatus,
  pair as pairCodec,
  termination,
  terminator as terminatorCodec,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, bytesToHex, formatUnits, getAddress } from "viem";
import {
  AdlJob as AdlJobSchema,
  CollectJob as CollectJobSchema,
  type JobConfig,
  type JobName,
  LiquidationJob as LiquidationJobSchema,
  RefreshJob as RefreshJobSchema,
  SweepExpiredJob as SweepExpiredJobSchema,
  TerminalSettlementJob as TerminalSettlementJobSchema,
  TriggersJob as TriggersJobSchema,
  UnloadJob as UnloadJobSchema,
} from "../../config/index.js";
import { Action, ActionResult, lockKey } from "../../exec/executor.js";
import { getLogger } from "../../observe/logs.js";
import type { Keeper } from "../engine.js";
import { JOBS, type Job, PricedCall } from "../jobs/index.js";
import type { CollectJob } from "../jobs/collect.js";
import type { LiquidationJob } from "../jobs/liquidation.js";

const log = getLogger("bazaar_sdk.ops");

const PAIR = pairCodec();
const TERMINATOR = terminatorCodec();
const FACTORY = factoryCodec();

/** How a settlement call fixes the price, as a result's summary and notes word it. */
const UNDER: Readonly<Record<termination.SettleUnder, string>> = {
  tick: "UMA's rule (the one-second update stamped at the cutoff)",
  chain: "the chain rule (the median of five chained prices)",
  storedPrice: "the stored price (the last resort is open)",
};
/** A settlement price (BAZAAR precision, 1e18 = 1) as an exact decimal. */
const priceText = (p: bigint): string => formatUnits(p, 18);

const JOB_MODELS: Readonly<Record<JobName, { parse(x: unknown): JobConfig }>> = {
  liquidation: LiquidationJobSchema,
  triggers: TriggersJobSchema,
  unload: UnloadJobSchema,
  adl: AdlJobSchema,
  refresh: RefreshJobSchema,
  collect: CollectJobSchema,
  terminalSettlement: TerminalSettlementJobSchema,
  sweepExpired: SweepExpiredJobSchema,
};

/** How a one-shot run of an automatic job goes. */
export interface OpOptions {
  /** simulate and report, send nothing */
  dryRun?: boolean;
  /**
   * skip the profit and loss rules (nothing that reverts in simulation is ever sent; the daily spend
   * caps, the low-balance halt and the fee ceilings still apply)
   */
  force?: boolean;
}

/** How a manual operation goes. */
export interface ManualOptions {
  /** simulate and report, send nothing */
  dryRun?: boolean;
}

/** How a scheduled termination is planned and sent. */
export interface ScheduledTerminationOptions extends ManualOptions {
  /**
   * When the call with no updates, which settles at the market's stored price, is planned once its
   * last resort is open (the SDK's `storedPrice`): "whenAbsent" (default) only when Pyth's archive
   * answers and has no usable update for the settlement, "always" whenever no proven set is
   * accepted, "never" not at all.
   */
  storedPrice?: termination.StoredPricePolicy;
  /**
   * Send a settlement at the market's stored price. Without it such a plan is simulated and reported
   * (`dryRun`) or skipped, never sent: it fixes the market's price for good at a price no Pyth update
   * proves.
   */
  acceptStoredPrice?: boolean;
  /**
   * A plan made earlier ({@link Operations.planScheduledTermination}): the call is sent only while the
   * plan made now is the same (rule, settlement price and call); otherwise nothing is sent.
   */
  expect?: ScheduledTermination | null;
}

/** A scheduled termination as planned: the call, and what it fixes. */
export interface ScheduledTermination {
  readonly market: Market;
  readonly plan: termination.ScheduledSettlementPlan;
  /** The call that settles the market (the plan's). */
  readonly call: NonNullable<termination.ScheduledSettlementPlan["call"]>;
  /** The rule and the settlement price, as a result's summary words them. */
  readonly summary: string;
  /** Under the stored price: when the market stored it (unix seconds); null otherwise, or when it never stored one. */
  readonly storedPriceTs: number | null;
  /** What the builder tried and gave up on before this plan. */
  readonly notes: readonly string[];
}

/** The settlement price a plan fixes, as text. */
const settlementText = (p: ScheduledTermination): string => (p.plan.settlementPrice === null ? "?" : priceText(p.plan.settlementPrice));

/** How `planned`'s settlement at the stored price reads for whoever approves it: irreversible, and how old the price is. */
function storedPriceNote(planned: ScheduledTermination, now: number): string {
  const ts = planned.storedPriceTs;
  if (ts === null) {
    // BazaarPairTerminator._lastStoredPrice: a pair that never stored a price settles at 1 (1e-18).
    return `this settles the market irreversibly at ${settlementText(planned)}, the price the terminator gives a market that never stored one: no Pyth update proves it`;
  }
  const at = new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return `this settles the market irreversibly at its stored price, ${settlementText(planned)}, stored ${durationText(Math.max(0, now - ts))} ago (${at}): no Pyth update proves it`;
}

/** Seconds as "22 d 0 h", "3 h 5 min" or "40 s". */
function durationText(seconds: number): string {
  const s = Math.floor(seconds);
  if (s >= 86_400) return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3_600)} h`;
  if (s >= 3_600) return `${Math.floor(s / 3_600)} h ${Math.floor((s % 3_600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

/** What differs between two plans of one market's settlement, or null when it is the same call. */
function settlementChange(before: ScheduledTermination, now: ScheduledTermination): string | null {
  if (before.market.address !== now.market.address) return "another market";
  if (before.plan.under !== now.plan.under) return `it settles under ${UNDER[now.plan.under!]}, not ${UNDER[before.plan.under!]}`;
  if (before.plan.settlementPrice !== now.plan.settlementPrice) return `it settles at ${settlementText(now)}, not ${settlementText(before)}`;
  if (before.call.to !== now.call.to || before.call.data !== now.call.data) return "it carries other updates";
  if (before.call.value !== now.call.value) return `its fee is ${now.call.value} wei, not ${before.call.value}`;
  return null;
}

/**
 * The SDK's text with its option named as the keeper's operator sets it: the CLI's `--stored-price`
 * (the library's `storedPrice` takes the same values).
 */
function keeperWording(text: string): string {
  return text.split('pass storedPrice: "always"').join("run with --stored-price always").split('storedPrice is "never"').join("--stored-price is never");
}

export interface LiquidateOptions extends OpOptions {
  /** the accounts to liquidate; left out, the planner picks every account below its requirement */
  accounts?: readonly string[] | null;
}

export interface TriggerOptions extends OpOptions {
  /** the orders to fire; left out, the planner picks every order ready to fire */
  orderIds?: readonly (bigint | number)[] | null;
}

export interface AdlOptions extends OpOptions {
  /** shorts to close against the long bucket */
  longBucketWinners?: readonly string[] | null;
  /** longs to close against the short bucket */
  shortBucketWinners?: readonly string[] | null;
}

export interface SettleOptions extends OpOptions {
  /** the accounts to settle; left out, every open position but the keeper's own */
  accounts?: readonly string[] | null;
}

export interface SweepOptions extends OpOptions {
  /** the orders to sweep; left out, every expired order and every finished one holding a bounty */
  orderIds?: readonly (bigint | number)[] | null;
}

export interface CollectOptions extends OpOptions {
  /** "all" (default) or the markets to claim on */
  markets?: "all" | readonly string[];
}

const isOptions = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** `(list?, opts?)` or `(opts)`: the list (from either place) and the options. */
function listAndOptions<L, O extends object>(arg: L | O | null | undefined, opts: O | undefined, key: keyof O): [L | null, O] {
  if (isOptions(arg)) {
    const o = arg as O;
    return [((o[key] as L | null | undefined) ?? null) as L | null, o];
  }
  return [(arg ?? null) as L | null, opts ?? ({} as O)];
}

function skipped(job: string, market: string, summary: string, reason: string): ActionResult {
  return new ActionResult({ status: "skipped", job, market, summary, reason });
}

/** A 32-byte id from hex (with or without 0x) or bytes. */
function b32(v: Hex | string | Uint8Array): Hex {
  const h = typeof v === "string" ? v.replace(/^0[xX]/, "") : bytesToHex(v).slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError("expected a 32-byte id");
  return `0x${h.toLowerCase()}`;
}

const addresses = (xs: readonly string[]): Address[] => xs.map((x) => getAddress(x));
const orderIds = (xs: readonly (bigint | number)[]): bigint[] => xs.map((x) => BigInt(x));

/** The factory's permissionless operations: listings and identifier upgrades. */
export class FactoryOperations {
  constructor(private readonly ops: Operations) {}

  private async call(name: string, summary: string, args: readonly unknown[], opts: ManualOptions): Promise<ActionResult> {
    const k = await this.ops.ready();
    return this.ops.manual(name, null, k.dep!.factory, FACTORY.encode(name, ...args), summary, opts.dryRun ?? false);
  }

  /** Settle a listing proposal whose liveness has ended. */
  async settleDeploymentProposal(assertionId: Hex | string | Uint8Array, opts: ManualOptions = {}): Promise<ActionResult> {
    return this.call("settleDeploymentProposal", "settle a listing proposal", [b32(assertionId)], opts);
  }

  /** Release a listing that cannot settle. */
  async expireStuckDeploymentProposal(pairId: Hex | string | Uint8Array, opts: ManualOptions = {}): Promise<ActionResult> {
    return this.call("expireStuckDeploymentProposal", "release a stuck listing", [b32(pairId)], opts);
  }

  /** Settle a pending identifier upgrade. */
  async settleIdentifierUpgradeProposal(assertionId: Hex | string | Uint8Array, opts: ManualOptions = {}): Promise<ActionResult> {
    return this.call("settleIdentifierUpgradeProposal", "settle an identifier upgrade", [b32(assertionId)], opts);
  }

  /** Release a pending identifier upgrade that cannot settle. */
  async expireStuckIdentifierUpgradeProposal(opts: ManualOptions = {}): Promise<ActionResult> {
    return this.call("expireStuckIdentifierUpgradeProposal", "release a stuck identifier upgrade", [], opts);
  }

  /** Activate the queued identifier upgrade once its delay has passed. */
  async activateIdentifierUpgrade(opts: ManualOptions = {}): Promise<ActionResult> {
    return this.call("activateIdentifierUpgrade", "activate the queued identifier upgrade", [], opts);
  }
}

/**
 * `keeper.run`: every job once, on one market, and the manual operations. Each connects and syncs
 * first when needed, so it works on a Keeper that is not running as well as on one that is.
 */
export class Operations {
  /** the factory's operations */
  readonly factory: FactoryOperations;

  constructor(readonly k: Keeper) {
    this.factory = new FactoryOperations(this);
  }

  // ---- plumbing ----

  /** Connect, read the head, and for `markets`, sync, read their state and fetch their prints. */
  async ready(markets?: readonly Market[] | null): Promise<Keeper> {
    const k = this.k;
    await k.connect();
    await k.updateBlock();
    if (markets && markets.length) {
      await k.syncStep();
      await k.readStates(true, markets);
      const feeds = new Set(k.prices.feeds);
      for (const m of markets) for (const leg of m.legs) feeds.add(leg);
      try {
        await k.prices.fetch(feeds);
      } catch (e) {
        if (!(e instanceof ProError)) throw e;
        log.warning("price endpoint: %s", e.message);
      }
    }
    return k;
  }

  /** The market `ref` names (label, description, address or pair id), synced and priced. */
  async market(ref: string): Promise<Market> {
    const k = await this.ready();
    const m = k.resolveMarket(ref);
    await this.ready([m]);
    return m;
  }

  /** The configured job, or one with default settings when the config leaves it off. */
  job(name: JobName): Job {
    const have = this.k.jobs.get(name);
    if (have) return have;
    const cfg = JOB_MODELS[name].parse({});
    const lanes = this.k.executor.lanes;
    if (!lanes.has(cfg.wallet) && lanes.size > 0) cfg.wallet = lanes.keys().next().value!;
    return new JOBS[name](this.k, cfg as never);
  }

  async runActions(job: Job, actions: readonly Action[], dryRun: boolean, force: boolean): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const a of actions) out.push(await this.locked(a, { dryRun, force, jobCfg: job.cfg }));
    return out;
  }

  /**
   * Run `a` under its in-flight keys, as the running keeper dispatches: a call the keeper (or another
   * one-shot) is already sending is not sent twice. A dry run sends nothing and takes no keys.
   */
  private async locked(a: Action, opts: { dryRun: boolean; force: boolean; jobCfg?: JobConfig }): Promise<ActionResult> {
    const ex = this.k.executor;
    if (opts.dryRun) return ex.run(a, opts);
    if (!ex.tryLock(a.locks)) {
      return skipped(a.job, a.market ? a.market.label : "", a.summary, "already in flight: the keeper is sending this call; try again once it lands");
    }
    try {
      return await ex.run(a, opts);
    } finally {
      ex.unlock(a.locks);
    }
  }

  /** The wallet manual operations send from: "default", else the first one configured. */
  private manualWallet(): string {
    const lanes = this.k.executor.lanes;
    return lanes.has("default") ? "default" : (lanes.keys().next().value ?? "default");
  }

  /**
   * Run a manual operation: unpaid, sent because it was asked for (force), from the default wallet.
   * `locks` are the keys a job sending the same call takes (one per operation and market besides).
   */
  async manual(
    name: string,
    m: Market | null,
    target: Address,
    data: Hex,
    summary: string,
    dryRun: boolean,
    value = 0n,
    locks: readonly string[] = [],
  ): Promise<ActionResult> {
    const wallet = this.manualWallet();
    const keys = [lockKey("manual", name, m ? m.address : target), ...locks];
    const a = new Action({ job: name, market: m, target, data, value, summary, wallet, paid: false, locks: keys });
    return this.locked(a, { dryRun, force: true });
  }

  /** `empty` is the skip reason when the plan finds nothing, or a function of the market giving it. */
  private async planned(
    name: JobName,
    ref: string,
    dryRun: boolean,
    force: boolean,
    empty: string | ((m: Market) => string),
  ): Promise<ActionResult[]> {
    const m = await this.market(ref);
    const job = this.job(name);
    if (m.state === null) return [skipped(name, m.label, name, "could not read the market's state")];
    const status = marketStatus(m.state, this.k.now());
    if (!job.statuses.has(status)) {
      const allowed = [...job.statuses].sort().join(", ");
      return [skipped(name, m.label, name, `the market is ${status}; this job runs while it is ${allowed}`)];
    }
    const actions = await job.plan(m);
    if (actions.length === 0) return [skipped(name, m.label, name, typeof empty === "string" ? empty : empty(m))];
    return this.runActions(job, actions, dryRun, force);
  }

  // ---- the automatic jobs, once ----

  /**
   * Liquidate on `market`: the accounts given, or every account the planner finds below its
   * maintenance requirement. `liquidate("BTC/USD", { dryRun: true })`, or with accounts:
   * `liquidate("BTC/USD", ["0x..."], { force: true })`.
   */
  async liquidate(market: string, opts?: LiquidateOptions): Promise<ActionResult[]>;
  async liquidate(market: string, accounts: readonly string[] | null | undefined, opts?: OpOptions): Promise<ActionResult[]>;
  async liquidate(market: string, arg?: readonly string[] | LiquidateOptions | null, more?: OpOptions): Promise<ActionResult[]> {
    const [accounts, o] = listAndOptions<readonly string[], LiquidateOptions>(arg, more, "accounts");
    const dryRun = o.dryRun ?? false;
    const force = o.force ?? false;
    const noPrice = (reason: string) => `no price can decide a liquidation now (${reason}): positions wait for the market's next price`;
    if (!accounts || accounts.length === 0) {
      return this.planned("liquidation", market, dryRun, force, (m) => {
        const held = this.k.store.positions.get(m.address)?.size ?? 0;
        const pc = held > 0 ? (this.job("liquidation") as LiquidationJob).liquidationPrice(m) : null;
        return pc === null || pc instanceof PricedCall ? "no position is below its maintenance margin" : noPrice(pc.reason);
      });
    }
    const accts = addresses(accounts);
    const m = await this.market(market);
    const job = this.job("liquidation") as LiquidationJob;
    // Priced as the job prices: a call the pair could only refuse (no update, on a stored price more
    // than 3 s old) is not simulated.
    const pc = job.liquidationPrice(m);
    if (!(pc instanceof PricedCall)) return [skipped("liquidation", m.label, "liquidate", noPrice(pc.reason))];
    const updates = pc.updates;
    const fee = await this.k.reader.updateFee(updates);
    const a = job.action(m, m.address, PAIR.encode("liquidate", accts, updates), `liquidate ${accts.length} account(s)`, {
      value: fee,
      priceTime: pc.priceTime,
      priceIssued: pc.issued,
      locks: accts.map((acct) => lockKey("liq", m.address, acct)), // the liquidation job's keys
      rewardPair: m.address,
    });
    return this.runActions(job, [a], dryRun, force);
  }

  /** Fire trigger orders on `market`: the ids given, or every order the planner finds ready. */
  async executeTriggers(market: string, opts?: TriggerOptions): Promise<ActionResult[]>;
  async executeTriggers(market: string, orderIds: readonly (bigint | number)[] | null | undefined, opts?: OpOptions): Promise<ActionResult[]>;
  async executeTriggers(market: string, arg?: readonly (bigint | number)[] | TriggerOptions | null, more?: OpOptions): Promise<ActionResult[]> {
    const [ids, o] = listAndOptions<readonly (bigint | number)[], TriggerOptions>(arg, more, "orderIds");
    const dryRun = o.dryRun ?? false;
    const force = o.force ?? false;
    if (!ids || ids.length === 0) return this.planned("triggers", market, dryRun, force, "no trigger order is ready to fire");
    const oids = orderIds(ids);
    const m = await this.market(market);
    const job = this.job("triggers");
    const pc = job.priced(m);
    if (pc === null) return [skipped("triggers", m.label, "execute triggers", "no fresh price: the market may be closed")];
    const updates = pc.updates;
    const live = await this.k.reader.orders(m.address, oids);
    const execs = [];
    for (const oid of oids) {
      const r = live.get(oid);
      let pred = 0n;
      if (r && r.orderType === STOP_LIMIT) pred = await this.k.reader.predecessor(m.address, r.isLong, r.limitPrice);
      execs.push({ orderId: oid, hints: { pred, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 } });
    }
    const fee = await this.k.reader.updateFee(updates);
    const a = job.action(m, m.address, PAIR.encode("executeTriggeredOrders", execs, updates), `execute ${execs.length} trigger order(s)`, {
      value: fee,
      priceTime: pc.priceTime,
      locks: oids.map((oid) => lockKey("trig", m.address, oid)), // the triggers job's keys
      rewardPair: m.address,
    });
    return this.runActions(job, [a], dryRun, force);
  }

  /** Unload the vault's inventory on `market` into the book. */
  async unload(market: string, opts: OpOptions = {}): Promise<ActionResult[]> {
    return this.planned("unload", market, opts.dryRun ?? false, opts.force ?? false, "nothing to unload, or no fresh price to unload against");
  }

  /**
   * Execute ADL on `market`: the winners given (either list may be empty), or the planner's picks
   * when neither is given.
   */
  async executeAdl(market: string, opts?: AdlOptions): Promise<ActionResult[]>;
  async executeAdl(
    market: string,
    longBucketWinners: readonly string[] | null | undefined,
    shortBucketWinners?: readonly string[] | null,
    opts?: OpOptions,
  ): Promise<ActionResult[]>;
  async executeAdl(
    market: string,
    arg?: readonly string[] | AdlOptions | null,
    short?: readonly string[] | null,
    more?: OpOptions,
  ): Promise<ActionResult[]> {
    let longW: readonly string[] | null;
    let shortW: readonly string[] | null;
    let o: OpOptions;
    if (isOptions(arg)) {
      const a = arg as AdlOptions;
      longW = a.longBucketWinners ?? null;
      shortW = a.shortBucketWinners ?? null;
      o = a;
    } else {
      longW = (arg as readonly string[] | null | undefined) ?? null;
      shortW = short ?? null;
      o = more ?? {};
    }
    const dryRun = o.dryRun ?? false;
    const force = o.force ?? false;
    if (longW === null && shortW === null) {
      return this.planned("adl", market, dryRun, force, "no ADL window is open, or no account is eligible");
    }
    const m = await this.market(market);
    const job = this.job("adl");
    const pc = job.priced(m);
    if (pc === null) return [skipped("adl", m.label, "execute ADL", "ADL needs a fresh price: the market may be closed")];
    const updates = pc.updates;
    const fee = await this.k.reader.updateFee(updates);
    const a = job.action(m, m.address, PAIR.encode("executeAdl", addresses(longW ?? []), addresses(shortW ?? []), updates), "ADL batch", {
      value: fee,
      priceTime: pc.priceTime,
      locks: [lockKey("adl", m.address)],
      rewardPair: m.address,
    });
    return this.runActions(job, [a], dryRun, force);
  }

  /** Store a fresh price on `market`. */
  async refreshPrice(market: string, opts: OpOptions = {}): Promise<ActionResult[]> {
    const m = await this.market(market);
    const job = this.job("refresh");
    const pc = job.priced(m);
    if (pc === null) return [skipped("refresh", m.label, "refresh price", "no fresh print: the market may be closed")];
    const updates = pc.updates;
    const fee = await this.k.reader.updateFee(updates);
    const a = job.action(m, m.address, PAIR.encode("refreshPrice", updates), "refresh price", {
      value: fee,
      priceTime: pc.priceTime,
      locks: [lockKey("refresh", m.address)],
      rewardPair: m.address,
    });
    return this.runActions(job, [a], opts.dryRun ?? false, opts.force ?? false);
  }

  /**
   * Claim the wallets' earnings on every market ("all") or the markets given. `force` claims every
   * balance that covers its gas, as on shutdown.
   */
  async collect(opts?: CollectOptions): Promise<ActionResult[]>;
  async collect(markets: "all" | readonly string[], opts?: OpOptions): Promise<ActionResult[]>;
  async collect(arg: "all" | readonly string[] | CollectOptions = "all", more?: OpOptions): Promise<ActionResult[]> {
    let markets: "all" | readonly string[];
    let o: OpOptions;
    if (isOptions(arg)) {
      markets = (arg as CollectOptions).markets ?? "all";
      o = arg as CollectOptions;
    } else {
      markets = arg as "all" | readonly string[];
      o = more ?? {};
    }
    const k = await this.ready();
    const job = this.job("collect") as CollectJob;
    const scope = markets === "all" ? null : new Set(markets.map((r) => k.resolveMarket(r).address));
    const actions = await job.claims(o.force ?? false, scope);
    if (actions.length === 0) return [skipped("collect", "", "collect", "nothing to claim")];
    return this.runActions(job, actions, o.dryRun ?? false, false);
  }

  /** Settle positions at the fixed settlement price on `market`: the accounts given, or the planner's. */
  async settleTerminal(market: string, opts?: SettleOptions): Promise<ActionResult[]>;
  async settleTerminal(market: string, accounts: readonly string[] | null | undefined, opts?: OpOptions): Promise<ActionResult[]>;
  async settleTerminal(market: string, arg?: readonly string[] | SettleOptions | null, more?: OpOptions): Promise<ActionResult[]> {
    const [accounts, o] = listAndOptions<readonly string[], SettleOptions>(arg, more, "accounts");
    const dryRun = o.dryRun ?? false;
    const force = o.force ?? false;
    if (!accounts || accounts.length === 0) {
      return this.planned("terminalSettlement", market, dryRun, force, "no settlement price is fixed, or nothing is left to settle");
    }
    const accts = addresses(accounts);
    const m = await this.market(market);
    const job = this.job("terminalSettlement");
    const a = job.action(m, m.address, PAIR.encode("liquidate", accts, []), `settle ${accts.length} position(s)`, {
      locks: [lockKey("settle", m.address)],
      rewardPair: m.address,
    });
    return this.runActions(job, [a], dryRun, force);
  }

  /** Sweep expired or finished orders on `market`: the ids given, or the planner's. */
  async sweepExpired(market: string, opts?: SweepOptions): Promise<ActionResult[]>;
  async sweepExpired(market: string, orderIds: readonly (bigint | number)[] | null | undefined, opts?: OpOptions): Promise<ActionResult[]>;
  async sweepExpired(market: string, arg?: readonly (bigint | number)[] | SweepOptions | null, more?: OpOptions): Promise<ActionResult[]> {
    const [ids, o] = listAndOptions<readonly (bigint | number)[], SweepOptions>(arg, more, "orderIds");
    const dryRun = o.dryRun ?? false;
    const force = o.force ?? false;
    if (!ids || ids.length === 0) return this.planned("sweepExpired", market, dryRun, force, "no expired order to sweep");
    const oids = orderIds(ids);
    const m = await this.market(market);
    const job = this.job("sweepExpired");
    const a = job.action(m, m.address, PAIR.encode("sweepExpired", oids), `sweep ${oids.length} order(s)`, {
      locks: [lockKey("sweep", m.address)],
      paid: false,
    });
    return this.runActions(job, [a], dryRun, force);
  }

  // ---- manual operations ----

  /** Finalize a terminated market once every position is settled or the escape hatch has opened. */
  async finalizeTermination(market: string, opts: ManualOptions = {}): Promise<ActionResult> {
    const m = await this.market(market);
    return this.manual("finalizeTermination", m, m.address, PAIR.encode("finalizeTermination"), `finalize ${m.label}`, opts.dryRun ?? false, 0n, [
      lockKey("settle", m.address), // the terminal-settlement job finalizes under this key
    ]);
  }

  /** End a market whose stored price is more than 21 days old (a dead oracle). */
  async terminateStalePair(market: string, opts: ManualOptions = {}): Promise<ActionResult> {
    const m = await this.market(market);
    return this.manual(
      "terminateStalePair",
      m,
      this.dep().terminator,
      TERMINATOR.encode("terminateStalePair", m.address),
      `end ${m.label} (dead oracle)`,
      opts.dryRun ?? false,
    );
  }

  /** Settle a UMA termination claim whose liveness has ended. */
  async settleTerminationProposal(assertionId: Hex | string | Uint8Array, opts: ManualOptions = {}): Promise<ActionResult> {
    const k = await this.ready();
    return this.manual(
      "settleTerminationProposal",
      null,
      k.dep!.terminator,
      TERMINATOR.encode("settleTerminationProposal", b32(assertionId)),
      "settle a UMA termination claim",
      opts.dryRun ?? false,
    );
  }

  /** Resolve an insurer vote on `market`. */
  async executeInsurerTermination(market: string, proposalId: Hex | string | Uint8Array, opts: ManualOptions = {}): Promise<ActionResult> {
    const m = await this.market(market);
    return this.manual(
      "executeInsurerTermination",
      m,
      this.dep().terminator,
      TERMINATOR.encode("executeInsurerTermination", m.address, b32(proposalId)),
      `resolve an insurer vote on ${m.label}`,
      opts.dryRun ?? false,
    );
  }

  /**
   * Plan the call that ends a market at its scheduled cutoff, without sending anything: a
   * {@link ScheduledTermination} when there is a call, or a skipped result that says why there is none
   * (and when to try again, when that is known).
   *
   * The SDK's builder (termination.terminateScheduledPair) reads the rule, fetches Pyth's archived
   * one-second updates for it with the keeper's client, has the pair's oracle verify them as the
   * terminator calls it, and simulates the call as the wallet that would send it. Once the last resort
   * is open it plans the call with no updates, which settles at the market's stored price, only as
   * `opts.storedPrice` allows: by default only when the archive answers and positively has no usable
   * update, so an archive that cannot be asked never leads to the stored price.
   */
  async planScheduledTermination(market: string, opts: { storedPrice?: termination.StoredPricePolicy } = {}): Promise<ScheduledTermination | ActionResult> {
    const m = await this.market(market);
    const k = this.k;
    const summary = `terminate ${m.label} at its cutoff`;
    const lane = k.executor.lanes.get(this.manualWallet());
    let plan: termination.ScheduledSettlementPlan;
    try {
      plan = await termination.terminateScheduledPair(this.context(), {
        pair: m.address,
        from: lane ? lane.address : ZERO_ADDRESS,
        fetchTick: (feeds, second) => k.pro.atTick(feeds, second),
        storedPrice: opts.storedPrice ?? "whenAbsent",
      });
    } catch (e) {
      // Refused before anything was fetched: no cutoff, a cutoff not passed yet, a price already fixed.
      if (!(e instanceof InputError)) throw e;
      return skipped("terminateScheduledPair", m.label, summary, e.message.slice(e.field.length + 2));
    }
    if (plan.call === null || plan.under === null) {
      return skipped("terminateScheduledPair", m.label, summary, keeperWording(plan.reason ?? "no settlement updates are available yet"));
    }
    const price = plan.settlementPrice === null ? "" : priceText(plan.settlementPrice);
    const stored = plan.under === "storedPrice";
    const updateTs = m.state?.updateTs ?? 0;
    return {
      market: m,
      plan,
      call: plan.call,
      summary: stored ? `${summary} at its stored price, ${price} (the last resort is open)` : `${summary} under ${UNDER[plan.under]}, settling at ${price}`,
      storedPriceTs: stored && updateTs > 0 ? updateTs : null,
      notes: plan.attempts.filter((a) => !a.ok).map((a) => `under ${UNDER[a.under]}: ${keeperWording(a.reason)}`),
    };
  }

  /**
   * Send (or, with `dryRun`, simulate) exactly the call `planned` holds. A settlement at the market's
   * stored price is sent only with `acceptStoredPrice`: it fixes the market's price for good at a
   * price no Pyth update proves. A dry run reports it either way.
   */
  async sendScheduledTermination(planned: ScheduledTermination, opts: Pick<ScheduledTerminationOptions, "dryRun" | "acceptStoredPrice"> = {}): Promise<ActionResult> {
    const dryRun = opts.dryRun ?? false;
    const m = planned.market;
    const stored = planned.plan.under === "storedPrice";
    if (stored && !dryRun && opts.acceptStoredPrice !== true) {
      const res = skipped("terminateScheduledPair", m.label, planned.summary, `${storedPriceNote(planned, this.k.now())}; not sent without acceptStoredPrice (the CLI's --accept-stored-price)`);
      res.reason = [res.reason, ...planned.notes].join("; ");
      return res;
    }
    const call = planned.call;
    const res = await this.manual("terminateScheduledPair", m, call.to, call.data, planned.summary, dryRun, call.value);
    const notes = stored ? [storedPriceNote(planned, this.k.now()), ...planned.notes] : planned.notes;
    if (notes.length) res.reason = [res.reason, ...notes].filter((n) => n).join("; ");
    return res;
  }

  /**
   * End a market at its scheduled cutoff: plan the call ({@link planScheduledTermination}) and send it
   * ({@link sendScheduledTermination}). With `opts.expect`, the plan made now must be that one (the
   * same rule, settlement price and call) or nothing is sent: what an operator approved is what goes
   * out, never a settlement that changed in the meantime.
   */
  async terminateScheduledPair(market: string, opts: ScheduledTerminationOptions = {}): Promise<ActionResult> {
    const planned = await this.planScheduledTermination(market, opts);
    if (planned instanceof ActionResult) return planned;
    const changed = opts.expect ? settlementChange(opts.expect, planned) : null;
    if (changed !== null) {
      return skipped("terminateScheduledPair", planned.market.label, planned.summary, `the settlement changed since the preview (${changed}): nothing was sent; run the command again`);
    }
    return this.sendScheduledTermination(planned, opts);
  }

  private dep(): Deployment {
    const d = this.k.dep;
    if (d === null) throw new Error("the keeper is not connected");
    return d;
  }

  /** The keeper's chain and deployment as the SDK's builders take them: no price source, no subgraph, no integrator. */
  private context(): BazaarContext {
    const d = this.dep();
    return {
      chain: this.k.chain,
      chainId: this.k.net.chainId,
      factory: d.factory,
      lens: d.lens,
      terminator: d.terminator,
      oracle: d.oracle,
      usdc: d.usdc,
      prices: null,
      subgraph: null,
      integrator: ZERO_ADDRESS,
    };
  }
}
