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
  type Deployment,
  HermesError,
  MAX_PRICE_STALENESS,
  type Market,
  type Print,
  RpcError,
  SETTLEMENT_SAMPLE_COUNT,
  SETTLEMENT_SAMPLE_SPACING,
  SETTLE_AWAIT_VERDICT,
  SETTLE_CHAIN,
  SETTLE_NOTHING,
  SETTLE_WINDOW,
  STOP_LIMIT,
  accumulator,
  decodeError,
  factory as factoryCodec,
  marketStatus,
  oracle as oracleCodec,
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
import { JOBS, type Job } from "../jobs/index.js";
import type { CollectJob } from "../jobs/collect.js";

const log = getLogger("bazaar_sdk.ops");

const PAIR = pairCodec();
const TERMINATOR = terminatorCodec();
const FACTORY = factoryCodec();
const ORACLE = oracleCodec();
const ZERO32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const U64_MAX = (1n << 64n) - 1n;

type SettleUnder = "window" | "chain";
const UNDER: Readonly<Record<SettleUnder, string>> = {
  window: "UMA's rule (the window's first print)",
  chain: "the chain rule (five chained prints)",
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
        if (!(e instanceof HermesError)) throw e;
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

  private async planned(name: JobName, ref: string, dryRun: boolean, force: boolean, empty: string): Promise<ActionResult[]> {
    const m = await this.market(ref);
    const job = this.job(name);
    if (m.state === null) return [skipped(name, m.label, name, "could not read the market's state")];
    const status = marketStatus(m.state, this.k.now());
    if (!job.statuses.has(status)) {
      const allowed = [...job.statuses].sort().join(", ");
      return [skipped(name, m.label, name, `the market is ${status}; this job runs while it is ${allowed}`)];
    }
    const actions = await job.plan(m);
    if (actions.length === 0) return [skipped(name, m.label, name, empty)];
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
    if (!accounts || accounts.length === 0) {
      return this.planned("liquidation", market, dryRun, force, "no position is below its maintenance margin");
    }
    const accts = addresses(accounts);
    const m = await this.market(market);
    const job = this.job("liquidation");
    const pc = job.priced(m, true);
    const updates = pc ? pc.updates : [];
    const fee = await this.k.reader.updateFee(updates);
    const a = job.action(m, m.address, PAIR.encode("liquidate", accts, updates), `liquidate ${accts.length} account(s)`, {
      value: fee,
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
   * End a market at its scheduled cutoff, fetching the settlement prints its rule asks for.
   *
   * A print set is sent as a print settlement only once the pair's oracle has verified it the way
   * the terminator calls it (fetchFirstPriceAtOrAfter for UMA's rule, fetchChainedMedian for the
   * chain rule, same arguments, the fee as value), and its summary names the price that call
   * returns. Past the grace or the last resort the terminator catches a refused set and settles at
   * the stored price instead, so simulating terminateScheduledPair alone passes either way and would
   * label a stored-price settlement as a print one. Past the last resort the call with no prints,
   * which settles at the stored price, is offered when no verified set goes through.
   */
  async terminateScheduledPair(market: string, opts: ManualOptions = {}): Promise<ActionResult> {
    const dryRun = opts.dryRun ?? false;
    const m = await this.market(market);
    const k = this.k;
    const dep = this.dep();
    const rule = await k.reader.one<{ rule: number | bigint; firstTarget: bigint; latestPublishTs: bigint; lastResortTs: bigint; verdictDeadline: bigint }>(
      dep.terminator,
      TERMINATOR,
      "settlementRule",
      m.address,
    );
    const r = Number(rule.rule);
    const first = Number(rule.firstTarget);
    const latest = Number(rule.latestPublishTs);
    const lastResort = Number(rule.lastResortTs);
    const summary = `terminate ${m.label} at its cutoff`;
    if (r === SETTLE_NOTHING) {
      return skipped("terminateScheduledPair", m.label, summary, "the market has no scheduled cutoff, or its settlement price is already fixed");
    }
    // What the terminator settles with: the pair's own oracle, cutoff and stored price, and the UMA cap.
    const [scheduleId, pairOracle, scheduledTs, capRaw, lastPrice] = await Promise.all([
      k.reader.one<Hex>(dep.terminator, TERMINATOR, "insurerScheduleId", m.address),
      k.reader.one<Address>(m.address, PAIR, "oracle"),
      k.reader.one<bigint | number>(m.address, PAIR, "scheduledTerminationTs"),
      k.reader.one<bigint | number>(dep.terminator, TERMINATOR, "umaCutoffCap", m.address),
      k.reader.one<{ spotPrice: bigint }>(m.address, PAIR, "lastPairPrice"),
    ]);
    const vote = scheduleId.toLowerCase() !== ZERO32;
    const cutoff = Number(scheduledTs);
    const now = k.now();
    // BazaarPairTerminator._lastStoredPrice: a pair that never stored a price settles at 1.
    const stored = lastPrice.spotPrice === 0n ? termination.NEVER_PRICED_SETTLEMENT_PRICE : lastPrice.spotPrice;
    const cap = BigInt(capRaw);
    const chainMax = cap === 0n || cap > U64_MAX ? U64_MAX : cap; // _insurerSettlementBounds' latestPublishTs
    // A claim-backed vote whose verdict nobody has recorded may settle under either rule, because the
    // call records the verdict (UMA's rule if the claim was upheld, the chain rule if not). A vote
    // with no claim, or a recorded verdict other than upheld, settles under the chain rule.
    let either = r === SETTLE_AWAIT_VERDICT;
    if (vote && r === SETTLE_CHAIN) {
      const p = await k.reader.one<{ claimBacked: boolean; verdict: number | bigint }>(dep.terminator, TERMINATOR, "insurerProposals", scheduleId);
      either = Boolean(p.claimBacked) && Number(p.verdict) === 0;
    }
    // Where a set the oracle refuses settles at the stored price instead of reverting. UMA's rule
    // for a verdict this call records has no fallback yet: its grace starts at the recording.
    const chainLastResort = r === SETTLE_CHAIN ? lastResort : termination.chainLastResort(cutoff, cap === 0n ? null : Number(cap));
    const fallsBack = (under: SettleUnder): boolean => (under === "window" ? r === SETTLE_WINDOW && now > lastResort : now > chainLastResort);

    // With either rule possible the chain set goes first: under UMA's rule a chain set reverts (no
    // fallback), so its success shows the chain rule applies, while a UMA-rule set could pass
    // under the chain rule's stored-price fallback.
    const sets: { under: SettleUnder; target: number; latest: number | null }[] = [];
    if (r === SETTLE_CHAIN || either) {
      sets.push({ under: "chain", target: r === SETTLE_CHAIN ? first : cutoff, latest: r === SETTLE_CHAIN ? latest : cap === 0n ? null : Number(cap) });
    }
    if (r === SETTLE_WINDOW || either) {
      sets.push({ under: "window", target: r === SETTLE_WINDOW ? first : cutoff - MAX_PRICE_STALENESS, latest: r === SETTLE_WINDOW ? latest : cutoff });
    }
    const notes: string[] = [];
    let last: ActionResult | null = null;
    let chainRefused = false; // a verified chain set the terminator reverted on: the chain rule does not apply
    for (const s of sets) {
      const label = UNDER[s.under];
      const [ups, why] = s.under === "window" ? await this.windowPrints(m, s.target, s.latest!) : await this.chainPrints(m, s.target, s.latest);
      if (!ups.length) {
        notes.push(why);
        continue;
      }
      const fee =
        s.under === "window"
          ? await k.reader.one<bigint>(pairOracle, ORACLE, "getUpdateFee", ups)
          : await k.reader.one<bigint>(pairOracle, ORACLE, "getSampleSetFee", m.baseFeedId, ups);
      const proof = await this.provePrints(pairOracle, m.baseFeedId, s.under, ups, fee, cutoff, chainMax);
      if (!("price" in proof)) {
        notes.push(
          fallsBack(s.under)
            ? `under ${label}, the oracle would not verify the prints (${proof.why}); the stored-price fallback is open, so a call ` +
                `carrying them would settle at the stored price (${priceText(stored)}) instead: not sent as a print settlement`
            : `under ${label}, the oracle would not verify the prints (${proof.why}), and the terminator would refuse them too`,
        );
        continue;
      }
      if (s.under === "window" && either && now > chainLastResort && !chainRefused) {
        notes.push(
          `UMA's rule applies only if UMA upheld the claim behind the vote, and nobody has recorded its verdict; if it did not, ` +
            `the chain rule's stored-price fallback is open and a call carrying these prints would settle at the stored price ` +
            `(${priceText(stored)}). Record the verdict first (settleTerminationProposal ${scheduleId}), then run this again`,
        );
        continue;
      }
      const res = await this.manual(
        "terminateScheduledPair",
        m,
        dep.terminator,
        TERMINATOR.encode("terminateScheduledPair", m.address, ups),
        `${summary} under ${label}, settling at ${priceText(proof.price)}`,
        dryRun,
        fee,
      );
      if (res.sent || res.status === "simulated") return res;
      if (s.under === "chain" && res.error !== null) chainRefused = true;
      last = res;
    }
    // Past the last resort, a call with no prints settles at the stored price.
    if ((r === SETTLE_WINDOW || r === SETTLE_CHAIN) && now > lastResort) {
      const res = await this.manual(
        "terminateScheduledPair",
        m,
        dep.terminator,
        TERMINATOR.encode("terminateScheduledPair", m.address, []),
        `${summary} at its stored price, ${priceText(stored)} (the last resort is open)`,
        dryRun,
        0n,
      );
      if (res.sent || res.status === "simulated") {
        if (notes.length) res.reason = [res.reason, ...notes].filter((n) => n).join("; ");
        return res;
      }
      last = res;
    }
    if (last !== null) {
      if (notes.length) last.reason = [last.reason, ...notes].filter((n) => n).join("; ");
      return last;
    }
    let reason = notes.filter((n) => n).join("; ") || "no settlement prints are available yet";
    if (r === SETTLE_AWAIT_VERDICT) reason += `; the vote waits for UMA's verdict until ${rule.verdictDeadline}`;
    else if (lastResort && now <= lastResort) reason += `; the stored-price fallback opens at ${lastResort}`;
    return skipped("terminateScheduledPair", m.label, summary, reason);
  }

  /**
   * The settlement price the pair's oracle fixes for `updates`, called exactly as the terminator
   * calls it (the same function and arguments, the fee as value, from the wallet that would send),
   * or why it refuses them.
   */
  private async provePrints(
    oracleAt: Address,
    feed: Hex,
    under: SettleUnder,
    updates: readonly Hex[],
    fee: bigint,
    cutoff: number,
    chainMax: bigint,
  ): Promise<{ price: bigint } | { why: string }> {
    const fn = under === "window" ? "fetchFirstPriceAtOrAfter" : "fetchChainedMedian";
    const data =
      under === "window"
        ? ORACLE.encode(fn, feed, updates, BigInt(cutoff - MAX_PRICE_STALENESS), BigInt(cutoff))
        : ORACLE.encode(fn, feed, updates, BigInt(cutoff), chainMax, BigInt(SETTLEMENT_SAMPLE_SPACING), BigInt(SETTLEMENT_SAMPLE_COUNT));
    const lane = this.k.executor.lanes.get(this.manualWallet());
    let ret: Hex;
    try {
      ret = await this.k.chain.call(oracleAt, data, { from: lane ? lane.address : null, value: fee });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      const d = e.revertData;
      // No revert data: the node refused the call itself (say, the wallet cannot cover the fee).
      return { why: d === null || d === "0x" ? e.rpcMessage : decodeError(d).toString() };
    }
    try {
      return { price: ORACLE.decode<bigint>(fn, ret) };
    } catch {
      return { why: "the oracle returned no price" };
    }
  }

  private dep(): Deployment {
    const d = this.k.dep;
    if (d === null) throw new Error("the keeper is not connected");
    return d;
  }

  private async firstPrint(feed: Hex, target: number, latest: number | null): Promise<[Print | null, string]> {
    const id = feed.toLowerCase();
    const short = id.slice(2, 10);
    let prints: Print[];
    try {
      prints = await this.k.hermes.atOrAfter(target, [feed]);
    } catch (e) {
      if (e instanceof HermesError) return [null, e.message];
      throw e;
    }
    const p = prints.find((x) => x.feedId.toLowerCase() === id);
    if (p === undefined) return [null, `the price endpoint returned no print for ${short} at ${target}`];
    if (p.publishTime < target || (p.prevPublishTime !== null && p.prevPublishTime >= target)) {
      return [null, `the price endpoint's print for ${short} is not the first at or after ${target}`];
    }
    if (latest !== null && p.publishTime > latest) return [null, `the feed ${short} has no print between ${target} and ${latest}`];
    return [p, ""];
  }

  private static oneFeed(p: Print): Hex {
    return accumulator.isAccumulator(p.blob) ? accumulator.subset(p.blob, [p.feedId]) : p.blob;
  }

  private async windowPrints(m: Market, target: number, latest: number): Promise<[Hex[], string]> {
    const out: Hex[] = [];
    for (const leg of m.legs) {
      const [p, why] = await this.firstPrint(leg, target, latest);
      if (p === null) return [[], why];
      out.push(Operations.oneFeed(p));
    }
    return [out, ""];
  }

  private async chainPrints(m: Market, firstTarget: number, latest: number | null): Promise<[Hex[], string]> {
    const out: Hex[] = [];
    let target = firstTarget;
    for (let i = 0; i < SETTLEMENT_SAMPLE_COUNT; i++) {
      const sample: Print[] = [];
      for (const leg of m.legs) {
        const [p, why] = await this.firstPrint(leg, target, latest);
        if (p === null) return [[], why];
        sample.push(p);
      }
      for (const p of sample) out.push(Operations.oneFeed(p));
      target = Math.max(...sample.map((p) => p.publishTime)) + SETTLEMENT_SAMPLE_SPACING;
    }
    return [out, ""];
  }
}
