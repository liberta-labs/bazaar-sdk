/**
 * The earnings ledger: one JSON line per transaction the keeper sent, and the budgets read from it.
 *
 * The file (`ledger.jsonl` in the state dir) is append-only, one entry per line, in the Python
 * keeper's format (snake_case keys, integers written as JSON integers), so either implementation reads
 * the other's ledger. Lines written by an older or newer version with camelCase keys are read too.
 *
 * The daily budgets (gas spent and losses taken in the last 24 h) are kept as running totals over a
 * sliding window of the in-memory entries, which are held in time order: each query only drops the
 * entries that aged out since the last one, so a budget check costs O(1) amortized however long the
 * ledger grows. Sends in flight count at once through reservations (see {@link Ledger.reserve}).
 *
 * Each entry also carries what it spent in wei (`extra.cost_wei`, a decimal string: under `extra`
 * because the Python keeper refuses unknown top-level keys), for the ETH spend cap, which no price
 * can move. Lines without it (older ones, the Python keeper's) count 0 wei there.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../observe/logs.js";

export const DAY = 86_400;

const log = getLogger("bazaar_sdk.exec");

export type EntryStatus = "confirmed" | "reverted" | "unknown";

/** What an entry is: profit | loss | unpaid | collect | forward | manual | forced. */
export type EntryKind = string;

export interface EntryInit {
  /** seconds since the epoch */
  ts: number;
  job: string;
  /** the market's label, or "" for calls that are not about one market */
  market: string;
  wallet: string;
  tx: string;
  /** confirmed | reverted | unknown */
  status: EntryStatus | string;
  kind: EntryKind;
  costUsd: number;
  /** what the call accrued to the wallet's claimable balance */
  rewardUsd?: number;
  expectedRewardUsd?: number;
  /** USDC paid out to the wallet (collect) */
  claimedUsd?: number;
  gasUsed?: bigint;
  summary?: string;
  extra?: Record<string, unknown>;
  /** what the call spent in wei (gas and the ETH it carried); stored as extra.cost_wei */
  costWei?: bigint;
}

/** extra.cost_wei as written (a decimal string) or as a JSON integer; anything else is 0. */
function weiOf(v: unknown): bigint {
  if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return 0n;
}

export class Entry {
  ts: number;
  job: string;
  market: string;
  wallet: string;
  tx: string;
  status: EntryStatus | string;
  kind: EntryKind;
  costUsd: number;
  rewardUsd: number;
  expectedRewardUsd: number;
  claimedUsd: number;
  gasUsed: bigint;
  summary: string;
  extra: Record<string, unknown>;
  /** what the call spent in wei, for the ETH spend cap (0 for lines that do not say) */
  readonly costWei: bigint;

  constructor(e: EntryInit) {
    this.ts = e.ts;
    this.job = e.job;
    this.market = e.market;
    this.wallet = e.wallet;
    this.tx = e.tx;
    this.status = e.status;
    this.kind = e.kind;
    this.costUsd = e.costUsd;
    this.rewardUsd = e.rewardUsd ?? 0;
    this.expectedRewardUsd = e.expectedRewardUsd ?? 0;
    this.claimedUsd = e.claimedUsd ?? 0;
    this.gasUsed = e.gasUsed ?? 0n;
    this.summary = e.summary ?? "";
    this.extra = e.extra ?? {};
    if (e.costWei !== undefined) {
      this.costWei = e.costWei > 0n ? e.costWei : 0n;
      this.extra = { ...this.extra, cost_wei: this.costWei.toString() };
    } else {
      this.costWei = weiOf(this.extra.cost_wei);
    }
  }

  get netUsd(): number {
    return this.rewardUsd - this.costUsd;
  }

  /** The loss this entry counts against the loss budgets: only loss-taking and unpaid calls count. */
  get lossUsd(): number {
    return this.kind === "loss" || this.kind === "unpaid" ? Math.max(0, this.costUsd - this.rewardUsd) : 0;
  }
}

export interface SummaryRow {
  calls: number;
  reward: number;
  cost: number;
  net: number;
  claimed: number;
  reverted: number;
}

// ---- the file format ----

/** [field, key on disk (the Python keeper's), key accepted on read as well] */
const FIELDS: readonly (readonly [keyof EntryInit, string])[] = [
  ["ts", "ts"],
  ["job", "job"],
  ["market", "market"],
  ["wallet", "wallet"],
  ["tx", "tx"],
  ["status", "status"],
  ["kind", "kind"],
  ["costUsd", "cost_usd"],
  ["rewardUsd", "reward_usd"],
  ["expectedRewardUsd", "expected_reward_usd"],
  ["claimedUsd", "claimed_usd"],
  ["gasUsed", "gas_used"],
  ["summary", "summary"],
  ["extra", "extra"],
];

/** JSON with bigints written as JSON integers (exact, and what Python reads as int). */
function toJson(v: unknown): string {
  switch (typeof v) {
    case "bigint":
      return v.toString();
    case "number":
      return Number.isFinite(v) ? JSON.stringify(v) : "null";
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "object": {
      if (v === null) return "null";
      if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined || typeof x === "function" ? "null" : toJson(x))).join(", ") + "]";
      const parts: string[] = [];
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined || typeof x === "function" || typeof x === "symbol") continue;
        parts.push(`${JSON.stringify(k)}: ${toJson(x)}`);
      }
      return "{" + parts.join(", ") + "}";
    }
    default:
      return "null";
  }
}

export function entryToLine(e: Entry): string {
  const parts = FIELDS.map(([f, key]) => `${JSON.stringify(key)}: ${toJson(e[f as keyof Entry])}`);
  return "{" + parts.join(", ") + "}";
}

/**
 * Integers too large for a double come back as bigints where the runtime exposes a literal's source
 * text to revivers (Node 21+); on older runtimes they stay (inexact) numbers. The ledger's own
 * integers (gas) are far below that limit.
 */
function revive(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
    return BigInt(context.source);
  }
  return value;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Parse one ledger line, or null when it is not a usable entry. */
export function entryFromLine(line: string): Entry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line, revive as (this: unknown, key: string, value: unknown) => unknown);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const get = (field: string, key: string) => (key in o ? o[key] : o[field]);
  const str = (field: string, key: string) => {
    const v = get(field, key);
    return typeof v === "string" ? v : null;
  };
  const num = (field: string, key: string, required: boolean) => {
    const v = get(field, key);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "bigint") return Number(v);
    return v === undefined && !required ? 0 : null;
  };
  const ts = num("ts", "ts", true);
  const costUsd = num("costUsd", "cost_usd", true);
  const job = str("job", "job");
  const market = str("market", "market");
  const wallet = str("wallet", "wallet");
  const tx = str("tx", "tx");
  const status = str("status", "status");
  const kind = str("kind", "kind");
  const rewardUsd = num("rewardUsd", "reward_usd", false);
  const expectedRewardUsd = num("expectedRewardUsd", "expected_reward_usd", false);
  const claimedUsd = num("claimedUsd", "claimed_usd", false);
  if (ts === null || costUsd === null || rewardUsd === null || expectedRewardUsd === null || claimedUsd === null) return null;
  if (job === null || market === null || wallet === null || tx === null || status === null || kind === null) return null;
  const g = get("gasUsed", "gas_used");
  let gasUsed = 0n;
  if (typeof g === "bigint") gasUsed = g;
  else if (typeof g === "number" && Number.isFinite(g)) gasUsed = BigInt(Math.trunc(g));
  else if (typeof g === "string" && /^\d+$/.test(g)) gasUsed = BigInt(g);
  const summary = get("summary", "summary");
  const extra = get("extra", "extra");
  return new Entry({
    ts,
    // The Python keeper names its jobs by their snake_case config keys; this one by the camelCase keys.
    job: job.includes("_") ? camel(job) : job,
    market,
    wallet,
    tx,
    status,
    kind,
    costUsd,
    rewardUsd,
    expectedRewardUsd,
    claimedUsd,
    gasUsed,
    summary: typeof summary === "string" ? summary : "",
    extra: extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {},
  });
}

// ---- fixed-point sums, so the running totals add and remove exactly ----

const UNITS = 1e12; // pico-dollars: each entry rounds by at most 5e-13 USD
/**
 * What a cost that is not a finite number counts as: more than any budget, so nothing else is sent
 * while it is in the window. A cost that cannot be priced is a refusal, never $0.
 */
const UNPRICED = 10n ** 40n;
const units = (usd: number): bigint => {
  const u = usd * UNITS;
  return Number.isFinite(u) ? BigInt(Math.round(u)) : UNPRICED;
};
const dollars = (u: bigint): number => (u >= UNPRICED ? Infinity : u > 0n ? Number(u) / UNITS : 0);

/**
 * A send in flight, counted in the budgets from the moment it is decided until it is settled into a
 * ledger entry or released (the send never went out). Made by {@link Ledger.reserve}.
 */
export interface Reservation {
  readonly job: string;
  readonly costUsd: number;
  readonly lossUsd: number;
  readonly costWei: bigint;
  /** false once released */
  readonly open: boolean;
}

interface OpenReservation {
  readonly job: string;
  readonly costUsd: number;
  readonly lossUsd: number;
  readonly costWei: bigint;
  open: boolean;
  readonly spent: bigint;
  readonly loss: bigint;
}

export class Ledger {
  readonly path: string | null;
  /** Every entry, oldest first. */
  readonly entries: Entry[] = [];

  // The last-24 h window: entries[winStart..] are inside it.
  private winStart = 0;
  private winSpent = 0n;
  private winLoss = 0n;
  private winWei = 0n;
  private readonly winLossByJob = new Map<string, bigint>();
  // Sends in flight (reservations), counted on top of the window.
  private resCount = 0;
  private resSpent = 0n;
  private resLoss = 0n;
  private resWei = 0n;
  private readonly resLossByJob = new Map<string, bigint>();
  private dirReady = false;
  private needsNewline = false;

  constructor(path: string | null) {
    this.path = path;
    if (path !== null && existsSync(path)) {
      const text = readFileSync(path, "utf8");
      // A line cut short by a crash is skipped below; the next append must not continue it.
      this.needsNewline = text.length > 0 && !text.endsWith("\n");
      const loaded: Entry[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const e = entryFromLine(line);
        if (e) loaded.push(e);
      }
      // Time order, which the window relies on (a clock step back can leave the file slightly out of order).
      loaded.sort((a, b) => a.ts - b.ts);
      for (const e of loaded) this.entries.push(e);
      const cutoff = Date.now() / 1000 - DAY;
      while (this.winStart < this.entries.length && this.entries[this.winStart]!.ts < cutoff) this.winStart++;
      for (let i = this.winStart; i < this.entries.length; i++) this.addToWindow(this.entries[i]!);
    }
  }

  record(e: Entry): void {
    const n = this.entries.length;
    if (n === 0 || this.entries[n - 1]!.ts <= e.ts) {
      this.entries.push(e);
      this.addToWindow(e);
    } else {
      // Out of time order (the clock stepped back): insert it where it belongs.
      const i = this.firstAtOrAfter(e.ts, true);
      this.entries.splice(i, 0, e);
      if (i >= this.winStart) this.addToWindow(e);
      else this.winStart++;
    }
    if (this.path === null) return;
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.path, (this.needsNewline ? "\n" : "") + entryToLine(e) + "\n", "utf8");
      this.needsNewline = false;
    } catch (err) {
      // The entry still counts in memory; losing the line only matters after a restart.
      log.error("could not append to the ledger %s: %s", this.path, err);
    }
  }

  /** Entries at or after `ts` (seconds), oldest first. */
  since(ts: number): Entry[] {
    return this.entries.slice(this.firstAtOrAfter(ts, false));
  }

  /** Gas spent in the last 24 h, in-flight sends included. */
  spentToday(): number {
    this.advance();
    return dollars(this.winSpent + this.resSpent);
  }

  /** Wei spent in the last 24 h, in-flight sends included. */
  spentWeiToday(): bigint {
    this.advance();
    return this.winWei + this.resWei;
  }

  /** Losses taken in the last 24 h, by one job or by all, in-flight sends included. */
  lossesToday(job: string | null = null): number {
    this.advance();
    if (job === null) return dollars(this.winLoss + this.resLoss);
    return dollars((this.winLossByJob.get(job) ?? 0n) + (this.resLossByJob.get(job) ?? 0n));
  }

  /**
   * Count a send's cost (and the loss it accepts) in the budgets now, before it goes out, so a
   * decision made meanwhile sees it. Synchronous bookkeeping: call it right after the decision, with
   * no await in between. Settle it with {@link release} once the send's entry is recorded or it
   * never went out.
   */
  reserve(job: string, costUsd: number, lossUsd: number, costWei: bigint): Reservation {
    const r: OpenReservation = {
      job,
      costUsd,
      lossUsd,
      costWei: costWei > 0n ? costWei : 0n,
      open: true,
      spent: units(costUsd),
      loss: lossUsd > 0 || !Number.isFinite(lossUsd) ? units(lossUsd) : 0n,
    };
    this.resCount++;
    this.resSpent += r.spent;
    this.resWei += r.costWei;
    if (r.loss) {
      this.resLoss += r.loss;
      this.resLossByJob.set(job, (this.resLossByJob.get(job) ?? 0n) + r.loss);
    }
    return r;
  }

  /** Stop counting a reservation (idempotent). */
  release(res: Reservation): void {
    const r = res as OpenReservation;
    if (!r.open) return;
    r.open = false;
    this.resCount--;
    this.resSpent -= r.spent;
    this.resWei -= r.costWei;
    if (r.loss) {
      this.resLoss -= r.loss;
      const left = (this.resLossByJob.get(r.job) ?? 0n) - r.loss;
      if (left > 0n) this.resLossByJob.set(r.job, left);
      else this.resLossByJob.delete(r.job);
    }
  }

  /** Sends in flight (open reservations). */
  get reserved(): number {
    return this.resCount;
  }

  summary(since: number, by: "job" | "market" = "job"): Record<string, SummaryRow> {
    const out: Record<string, SummaryRow> = {};
    for (let i = this.firstAtOrAfter(since, false); i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const key = by === "job" ? e.job : e.market || "-";
      const s = (out[key] ??= { calls: 0, reward: 0, cost: 0, net: 0, claimed: 0, reverted: 0 });
      s.calls += 1;
      s.reward += e.rewardUsd;
      s.cost += e.costUsd;
      s.net += e.netUsd;
      s.claimed += e.claimedUsd;
      if (e.status === "reverted") s.reverted += 1;
    }
    return out;
  }

  // ---- the window ----
  private addToWindow(e: Entry): void {
    this.winSpent += units(e.costUsd);
    this.winWei += e.costWei;
    const loss = units(e.lossUsd);
    if (loss) {
      this.winLoss += loss;
      this.winLossByJob.set(e.job, (this.winLossByJob.get(e.job) ?? 0n) + loss);
    }
  }

  private advance(): void {
    const cutoff = Date.now() / 1000 - DAY;
    const entries = this.entries;
    while (this.winStart < entries.length && entries[this.winStart]!.ts < cutoff) {
      const e = entries[this.winStart++]!;
      this.winSpent -= units(e.costUsd);
      this.winWei -= e.costWei;
      const loss = units(e.lossUsd);
      if (loss) {
        this.winLoss -= loss;
        const left = (this.winLossByJob.get(e.job) ?? 0n) - loss;
        if (left > 0n) this.winLossByJob.set(e.job, left);
        else this.winLossByJob.delete(e.job);
      }
    }
  }

  /** The first index whose ts is >= `ts` (or > `ts` when `after`), by binary search. */
  private firstAtOrAfter(ts: number, after: boolean): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const t = this.entries[mid]!.ts;
      if (after ? t <= ts : t < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
