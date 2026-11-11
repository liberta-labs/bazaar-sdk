/** What every job shares: its scope, its cooldowns, and the price it acts on. */

import { MAX_LIQUIDATION_PRICE_AGE, type Market, Status, marketStatus } from "@liberta-labs/bazaar-sdk";
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
 * The price a planner judges by and the update payload its call carries: the print's update when the
 * call is judged at the print, none when it is judged at the pair's stored price.
 *
 * `updates` is built on first use (most plans find nothing to do and never need it); a planner reads
 * it before its first await, so the update attached is the one that carried the print the price was
 * judged at.
 */
export class PricedCall {
  private built: Hex[] | null;
  private readonly build: (() => Hex[]) | null;

  constructor(
    readonly price: bigint,
    updates: readonly Hex[] | (() => Hex[]),
    readonly fresh: boolean,
    /**
     * The second the price the call relies on was generated or stored in, when the call needs it to
     * be within the pair's 3 s window as it lands (the executor checks it again just before sending);
     * null when it does not (the stored price on a closed session market).
     */
    readonly priceTime: number | null = null,
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

  action(m: Market | null, target: Address, data: Hex, summary: string, extras: ActionExtras = {}): Action {
    return new Action({ wallet: this.cfg.wallet, ...extras, job: this.name, market: m, target, data, summary });
  }

  // ---- prices ----
  /**
   * The price a call on `m` is judged at now and the update it carries: a fresh print's, or, when
   * allowed, the stored price on a closed session market (with no update).
   *
   * A pair stores an update's price only when it was generated in a later second than the price it
   * holds (for a composite, when its older leg was), and otherwise judges the call at the price it
   * holds (BazaarPair._buildAndStorePairPrice). So while the market's stored price is from the
   * print's second or a later one, the planner judges at the stored price as the pair will: a
   * candidate that crosses only at the print is left for the next second's print, and one that
   * crosses at the stored price is not missed. The call then carries no update: the chain's stored
   * price is at least as new as the one read here (it never goes back), so the print could never be
   * stored, and attaching it would only cost its fee and revert the call once the print aged past the
   * window, where the call without it runs on the stored price, which is at least as fresh.
   */
  priced(m: Market, allowStale = false): PricedCall | null {
    const prices = this.k.prices;
    const st = m.state;
    if (prices.fresh(m) && this.confident(m)) {
      const pp = prices.price(m)!;
      if (st !== null && st.spot > 0n && st.updateTs >= pp.publishTime) return new PricedCall(st.spot, [], true, st.updateTs);
      return new PricedCall(pp.spot, () => prices.updateFor(m), true, pp.publishTime);
    }
    if (allowStale && !m.continuous && st !== null && st.spot > 0n) {
      if (this.k.now() - st.updateTs <= MAX_LIQUIDATION_PRICE_AGE - 30) return new PricedCall(st.spot, [], false);
    }
    return null;
  }

  /**
   * Whether every print `m` prices from carries a confidence. BazaarOracle reads a zero confidence as
   * an absent one and reverts the call (BazaarOracle__IncompleteFeed), so such a print is never
   * attached: the market is planned as one without a fresh print, and no confidence is made up for
   * it. The SDK's client yields no print for such a feed; this holds whatever the print's source.
   */
  private confident(m: Market): boolean {
    const legs = this.k.prices.legs(m);
    if (legs === null) return false;
    for (const p of legs) {
      if (p.conf > 0n) continue;
      this.k.unusablePrint(m, `the print for feed ${p.feedId} carries no confidence, and the oracle refuses a live price without one`);
      return false;
    }
    return true;
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

// ---- formatting ----

/** `{x:,.0f}`: rounded, with thousands separators. */
export function thousands(x: number): string {
  const s = Math.round(x).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A BAZAAR-precision amount (1e18 = $1 or one unit) as a double. */
export const units = (x: bigint): number => Number(x) / 1e18;
