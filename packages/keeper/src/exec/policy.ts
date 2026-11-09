/**
 * When a simulated call is worth sending.
 *
 * A paid call goes out when it is profitable: reward − cost ≥ minProfitUsd and reward ≥ cost ×
 * gasSafetyMultiplier. A call that fails that test is skipped unless the operator has chosen to take
 * losses for that job (allowLoss), or has switched on an unpaid duty by name (finalize, health pokes).
 * A loss-taking call still has to fit three caps: the per-call cap, the job's daily loss budget and the
 * global daily loss budget. Every call, profitable or not, forced or not, has to fit the global daily
 * spend caps: maxSpendUsdPerDay, and maxSpendEthPerDay in wei, which no ETH/USD price can lift.
 */

import type { JobConfig, KeeperConfig } from "../config/index.js";
import type { Ledger } from "./ledger.js";

/** What a simulated call would earn and cost, in USD, and what it costs in wei. */
export class Quote {
  constructor(
    readonly rewardUsd: number,
    readonly costUsd: number,
    readonly costWei: bigint = 0n,
  ) {}

  get netUsd(): number {
    return this.rewardUsd - this.costUsd;
  }

  get lossUsd(): number {
    return Math.max(0, this.costUsd - this.rewardUsd);
  }
}

/** profit | loss | unpaid | forced | skip, or a job's own (collect, forward). */
export type DecisionKind = "profit" | "loss" | "unpaid" | "forced" | "skip" | (string & {});

export interface Decision {
  readonly send: boolean;
  readonly kind: DecisionKind;
  readonly reason: string;
}

export interface DecideOptions {
  /** false for a call that pays its caller nothing */
  paid?: boolean;
  /** marks an unpaid duty the operator enabled by name, with its per-call cap */
  consentCapUsd?: number | null;
  /** one-shot calls only: skip the profit and loss rules (never the spend caps) */
  force?: boolean;
}

/** Python's `{x:g}`: up to six significant digits, no trailing zeros. */
export function fmtG(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/** The daily ETH spend cap: budget.maxSpendEthPerDay, or maxSpendUsdPerDay at the gas.ethUsdFloor price. */
export function maxSpendEthPerDay(cfg: KeeperConfig): number {
  return cfg.budget.maxSpendEthPerDay ?? cfg.budget.maxSpendUsdPerDay / cfg.gas.ethUsdFloor;
}

export class SpendPolicy {
  constructor(
    readonly cfg: KeeperConfig,
    readonly ledger: Ledger,
  ) {}

  /**
   * The caps every call has to fit, whoever decided it should go (a job's own rule, or force): a
   * refusal, or null when the call fits. A cost that is not a finite number is refused.
   */
  spendCaps(q: Quote): Decision | null {
    if (!Number.isFinite(q.costUsd) || q.costUsd < 0 || !Number.isFinite(q.rewardUsd)) {
      return { send: false, kind: "skip", reason: "the call's cost could not be priced in USD; nothing is sent until it can" };
    }
    const budget = this.cfg.budget;
    const spent = this.ledger.spentToday();
    if (spent + q.costUsd > budget.maxSpendUsdPerDay) {
      return {
        send: false,
        kind: "skip",
        reason: `daily gas budget reached ($${spent.toFixed(2)} of $${budget.maxSpendUsdPerDay.toFixed(2)} spent)`,
      };
    }
    const capEth = maxSpendEthPerDay(this.cfg);
    const spentEth = Number(this.ledger.spentWeiToday()) / 1e18;
    if (spentEth + Number(q.costWei) / 1e18 > capEth) {
      return {
        send: false,
        kind: "skip",
        reason: `daily ETH spend cap reached (${fmtG(spentEth)} of ${fmtG(capEth)} ETH spent; budget.maxSpendEthPerDay)`,
      };
    }
    return null;
  }

  decide(job: string, jobCfg: JobConfig | null | undefined, q: Quote, opts: DecideOptions = {}): Decision {
    const paid = opts.paid ?? true;
    const consentCap = opts.consentCapUsd ?? null;
    const capped = this.spendCaps(q);
    if (capped) return capped;
    if (opts.force) return { send: true, kind: "forced", reason: "sent on request (profit and loss rules skipped)" };
    const budget = this.cfg.budget;
    const minProfit = jobCfg?.minProfitUsd ?? this.cfg.profit.minProfitUsd;
    const mult = jobCfg?.gasSafetyMultiplier ?? this.cfg.profit.gasSafetyMultiplier;
    if (paid && q.netUsd >= minProfit && q.rewardUsd >= q.costUsd * mult) {
      return { send: true, kind: "profit", reason: `earns $${q.rewardUsd.toFixed(4)} for $${q.costUsd.toFixed(4)} of gas` };
    }

    const consented = consentCap !== null || Boolean(jobCfg?.allowLoss);
    if (!consented) {
      if (!paid) return { send: false, kind: "skip", reason: "pays nothing, and this job does not take losses (allowLoss is off)" };
      return {
        send: false,
        kind: "skip",
        reason:
          `below the profit rule: earns $${q.rewardUsd.toFixed(4)} for $${q.costUsd.toFixed(4)} of gas, ` +
          `needs ×${fmtG(mult)} and $${fmtG(minProfit)} net (allowLoss is off)`,
      };
    }
    // Consent without a cap of its own comes from allowLoss, so jobCfg is set here.
    const cap = consentCap ?? jobCfg!.maxLossUsdPerCall;
    const loss = q.lossUsd;
    if (loss > cap) {
      return { send: false, kind: "skip", reason: `would lose $${loss.toFixed(4)}, above the $${cap.toFixed(4)} per-call cap` };
    }
    if (jobCfg) {
      const jobLost = this.ledger.lossesToday(job);
      if (jobLost + loss > jobCfg.lossBudgetUsdPerDay) {
        return {
          send: false,
          kind: "skip",
          reason: `${job}'s daily loss budget is spent ($${jobLost.toFixed(2)} of $${jobCfg.lossBudgetUsdPerDay.toFixed(2)})`,
        };
      }
    }
    const allLost = this.ledger.lossesToday();
    if (allLost + loss > budget.maxLossUsdPerDay) {
      return {
        send: false,
        kind: "skip",
        reason: `the global daily loss budget is spent ($${allLost.toFixed(2)} of $${budget.maxLossUsdPerDay.toFixed(2)})`,
      };
    }
    return {
      send: true,
      kind: paid ? "loss" : "unpaid",
      reason: `loss accepted: $${loss.toFixed(4)} (earns $${q.rewardUsd.toFixed(4)}, costs $${q.costUsd.toFixed(4)})`,
    };
  }
}
