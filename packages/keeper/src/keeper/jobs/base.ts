/** What every job shares: its scope, its cooldowns, and the price it acts on. */

import { MAX_LIQUIDATION_PRICE_AGE, MAX_PRICE_STALENESS, type Market, Status, marketStatus, pair } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";
import { JobConfig } from "../../config/index.js";
import { Action, type ActionInit, type ActionResult } from "../../exec/executor.js";
import type { Keeper } from "../engine.js";

/** Seconds on a monotonic clock, for cooldowns and schedules. */
export const monotonic = (): number => performance.now() / 1000;

/** The statuses most jobs run in. */
export const LIVE: ReadonlySet<Status> = new Set([Status.Live]);
/** Live, or with an ADL window open (matching halts; liquidation, ADL and refresh still run). */
export const LIVE_OR_ADL: ReadonlySet<Status> = new Set([Status.Live, Status.Adl]);
export const ALL_STATUSES: ReadonlySet<Status> = new Set(Object.values(Status));

/**
 * The price a planner judges by and the update payload its call carries.
 *
 * `updates` is built on first use (most plans find nothing to do and never need it); a planner reads
 * it before its first await, so it carries the very print `price` came from.
 */
export class PricedCall {
  private built: Hex[] | null;
  private readonly build: (() => Hex[]) | null;

  constructor(
    readonly price: bigint,
    updates: readonly Hex[] | (() => Hex[]),
    readonly fresh: boolean,
  ) {
    if (typeof updates === "function") {
      this.built = null;
      this.build = updates;
    } else {
      this.built = [...updates];
      this.build = null;
    }
  }

  get updates(): Hex[] {
    if (this.built === null) this.built = this.build!();
    return this.built;
  }
}

/**
 * Seconds past updateTs + MAX_PRICE_STALENESS (on the chain clock) at which an early re-plan runs, so
 * the block it simulates against no longer serves the cached price. Pyth's getPriceNoOlderThan keeps a
 * price fresh while block.timestamp - publishTime <= MAX_PRICE_STALENESS (inclusive), and block
 * timestamps are whole seconds, so the first block that ignores the cache is at updateTs + 4: one
 * second plus a 0.2 s margin past the 3 s window.
 */
export const CACHE_REPLAN_MARGIN = 1.2;

const PAIR = pair();

/**
 * Whether a refusal may be the pair judging by Pyth's on-chain cache: the call ran (no revert, no RPC
 * failure) and `countFn`'s returned count (liquidatedCount, executedCount) is zero, so nothing crossed
 * at the price the pair used, although the planner saw it cross at the attached print.
 */
function nothingCrossed(r: ActionResult, countFn: string): boolean {
  if (r.sent || r.error !== null || r.returned === "0x") return false;
  try {
    return PAIR.decode<bigint>(countFn, r.returned) === 0n;
  } catch {
    return false;
  }
}

/** Everything an Action takes besides what {@link Job.action} fills in. */
export type ActionExtras = Omit<ActionInit, "job" | "market" | "target" | "data" | "summary">;

const DEFAULT_JOB_CONFIG: JobConfig = JobConfig.parse({});

/**
 * A keeper job. Per-market jobs implement {@link plan}; the others (collect) {@link planGlobal}. A plan
 * returns the actions to dispatch; the engine locks each action's keys, simulates and sends it, and
 * hands the result back to {@link note}.
 */
export class Job<C extends JobConfig = JobConfig> {
  /** the job's key under `jobs:` (camelCase) */
  readonly name: string = "";
  /** the market statuses the job plans in */
  readonly statuses: ReadonlySet<Status> = LIVE;
  readonly perMarket: boolean = true;
  /**
   * Also plan a market as soon as a newer print arrives for one of its legs, not only on the tick. The
   * tick still plans it too: funding, margin rates, new positions and new orders change without a
   * print, and a closed session market gets no prints at all.
   */
  readonly onPrint: boolean = false;
  /** market addresses; null means every market */
  scope: Set<Address> | null = null;
  excluded: Set<Address> = new Set();
  readonly cfg: C;
  /** cooldown key -> monotonic time it ends */
  private readonly coolUntil = new Map<string, number>();
  /** key -> monotonic time until which its early retry (see {@link coolRefused}) counts as used */
  private readonly earlyUsed = new Map<string, number>();

  constructor(
    readonly k: Keeper,
    cfg?: C | null,
  ) {
    this.cfg = cfg ?? (DEFAULT_JOB_CONFIG as C);
  }

  // ---- scope ----
  inScope(m: Market): boolean {
    if (this.excluded.size > 0 && this.excluded.has(m.address)) return false;
    return this.scope === null || this.scope.has(m.address);
  }

  runnable(m: Market): boolean {
    const st = m.state;
    if (st === null || !this.inScope(m)) return false;
    if (!this.statuses.has(marketStatus(st, this.k.now()))) return false;
    const ex = this.k.executor;
    return ex.pauses.size === 0 || !ex.paused(this.name, m.label);
  }

  // ---- cooldowns: a candidate the chain refused is not re-simulated at once ----
  cooling(key: string): boolean {
    if (this.coolUntil.size === 0) return false;
    const until = this.coolUntil.get(key);
    if (until === undefined) return false;
    if (until > monotonic()) return true;
    this.coolUntil.delete(key); // expired: as if never set, and the map stays small
    return false;
  }

  cool(key: string, seconds?: number | null): void {
    this.coolUntil.set(key, monotonic() + (seconds ?? this.k.cfg.engine.simCooldownSeconds));
  }

  /**
   * Cool down the keys of a price-driven candidate the chain refused: engine.simCooldownSeconds, except
   * once in a row for a refusal Pyth's on-chain cache likely explains. While the market's stored price
   * is younger than MAX_PRICE_STALENESS, the pair judges by Pyth's cached price, not the update the
   * call attached, so a move inside that window crosses nothing (`countFn` returns 0) until the cache
   * ages out at updateTs + MAX_PRICE_STALENESS. Then the keys cool only until just after that, and the
   * engine re-plans this job on the market at that moment instead of after the full cooldown. A
   * refusal of that retry takes the fixed cooldown. Another pair on the same feed can refresh Pyth's
   * cache too, so a young stored price is a signal, not a proof: it costs one early simulation at most.
   */
  protected coolRefused(action: Action, result: ActionResult, countFn: string): void {
    const m = action.market;
    const st = m?.state ?? null;
    const now = this.k.chainTime();
    const at =
      m !== null && st !== null && st.updateTs > 0 && now - st.updateTs < MAX_PRICE_STALENESS && nothingCrossed(result, countFn)
        ? st.updateTs + MAX_PRICE_STALENESS + CACHE_REPLAN_MARGIN
        : null;
    if (at === null) {
      for (const key of action.locks) this.cool(key);
      return;
    }
    const mono = monotonic();
    const delay = Math.max(0, at - now);
    if (this.earlyUsed.size > 256) for (const [k, t] of this.earlyUsed) if (t <= mono) this.earlyUsed.delete(k);
    let early = false;
    for (const key of action.locks) {
      const used = this.earlyUsed.get(key);
      if (used !== undefined && used > mono) {
        this.earlyUsed.delete(key);
        this.cool(key); // the early retry was refused as well: the fixed cooldown is the backstop
      } else {
        this.earlyUsed.set(key, mono + delay + MAX_PRICE_STALENESS);
        this.cool(key, delay);
        early = true;
      }
    }
    if (early) this.k.replanAt(this, m!, at);
  }

  /** A sent candidate starts afresh: its next refusal may take an early retry again. */
  protected clearEarly(keys: readonly string[]): void {
    if (this.earlyUsed.size > 0) for (const key of keys) this.earlyUsed.delete(key);
  }

  action(m: Market | null, target: Address, data: Hex, summary: string, extras: ActionExtras = {}): Action {
    return new Action({ wallet: this.cfg.wallet, ...extras, job: this.name, market: m, target, data, summary });
  }

  // ---- prices ----
  /** A fresh print and its update, or, when allowed, the stored price on a closed session market. */
  priced(m: Market, allowStale = false): PricedCall | null {
    const prices = this.k.prices;
    if (prices.fresh(m)) {
      const pp = prices.price(m)!;
      return new PricedCall(pp.spot, () => prices.updateFor(m), true);
    }
    const st = m.state;
    if (allowStale && !m.continuous && st !== null && st.spot > 0n) {
      if (this.k.now() - st.updateTs <= MAX_LIQUIDATION_PRICE_AGE - 30) return new PricedCall(st.spot, [], false);
    }
    return null;
  }

  /** Per-market jobs: what to send on `m` now. */
  async plan(_m: Market): Promise<Action[]> {
    return [];
  }

  /** Jobs that are not about one market. */
  async planGlobal(): Promise<Action[]> {
    return [];
  }

  /** Called with each result, so a job can cool down what the chain refused. */
  note(_action: Action, _result: ActionResult): void {}
}

/** The constructor every job class has (the config is the job's own schema type). */
export type JobClass = new (keeper: Keeper, cfg: never) => Job;

// ---- formatting, as the Python's f-strings ----

/** `{x:,.0f}`: rounded, with thousands separators. */
export function thousands(x: number): string {
  const s = Math.round(x).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A BAZAAR-precision amount (1e18 = $1 or one unit) as a double. */
export const units = (x: bigint): number => Number(x) / 1e18;
