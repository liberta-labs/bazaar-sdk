/** Collect: claim each wallet's earnings per market, and optionally forward the USDC elsewhere. */

import { USDC_DECIMALS, pair } from "@liberta-labs/bazaar-sdk";
import { type Address, concatHex, encodeAbiParameters } from "viem";
import type { CollectJob as CollectJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { type Decision, type Quote, fmtG } from "../../exec/policy.js";
import { ALL_STATUSES, Job, monotonic, units } from "./base.js";

const PAIR = pair();
const TRANSFER = "0xa9059cbb"; // transfer(address,uint256)

export class CollectJob extends Job<CollectJobConfig> {
  override readonly name = "collect";
  override readonly statuses = ALL_STATUSES;
  override readonly perMarket = false;
  /** monotonic time of the next run */
  nextRun = 0;
  /** `${wallet}:${pair}` -> when a balance appeared (seconds since the epoch) */
  readonly firstSeen = new Map<string, number>();

  wake(): void {
    this.nextRun = Math.min(this.nextRun, monotonic() + 5);
  }

  override async planGlobal(): Promise<Action[]> {
    if (this.nextRun > monotonic()) return [];
    this.nextRun = monotonic() + this.cfg.intervalSeconds;
    const claims = await this.claims(false);
    return [...claims, ...(await this.forward())];
  }

  /** A claim per wallet and market that holds a balance; `markets` limits them (null: the job's scope). */
  async claims(shutdown: boolean, markets: ReadonlySet<Address> | null = null): Promise<Action[]> {
    const actions: Action[] = [];
    const mult = this.cfg.gasSafetyMultiplier || this.k.cfg.profit.gasSafetyMultiplier;
    const inflight = this.k.executor.inflight;
    for (const lane of this.k.executor.lanes.values()) {
      const owed = await this.k.reader.claimable(lane.address);
      for (const [pairAt, amount] of owed) {
        const m = this.k.store.markets.get(pairAt);
        if (m === undefined || (markets !== null && !markets.has(pairAt)) || (markets === null && !this.inScope(m))) continue;
        const lock = lockKey("claim", lane.address, pairAt);
        if (inflight.has(lock)) continue;
        const key = lockKey(lane.address, pairAt);
        let first = this.firstSeen.get(key);
        if (first === undefined) {
          first = Date.now() / 1000;
          this.firstSeen.set(key, first);
        }
        const owedUsd = units(amount);
        const aged = Date.now() / 1000 - first > this.cfg.maxAgeDays * 86_400;
        const threshold = this.cfg.thresholdUsd;

        const decide = (q: Quote): Decision => {
          if (shutdown || aged) {
            if (owedUsd >= q.costUsd) return { send: true, kind: "collect", reason: `claims $${owedUsd.toFixed(2)} for $${q.costUsd.toFixed(4)}` };
            return { send: false, kind: "skip", reason: `$${owedUsd.toFixed(4)} does not cover the claim's gas` };
          }
          if (owedUsd >= threshold && owedUsd >= q.costUsd * mult) {
            return { send: true, kind: "collect", reason: `claims $${owedUsd.toFixed(2)} for $${q.costUsd.toFixed(4)}` };
          }
          return { send: false, kind: "skip", reason: `$${owedUsd.toFixed(2)} is below the $${fmtG(threshold)} collect threshold` };
        };

        const a = this.action(m, pairAt, PAIR.encode("claimFees"), `claim $${owedUsd.toFixed(2)}`, {
          locks: [lock],
          paid: false,
          background: !shutdown,
          decide,
          probe: false,
        });
        a.wallet = lane.name;
        actions.push(a);
      }
    }
    return actions;
  }

  /** Move each wallet's USDC to forwardTo once it holds forwardMinUsd. */
  async forward(): Promise<Action[]> {
    const to = this.cfg.forwardTo;
    if (!to) return [];
    const dep = this.k.dep;
    if (dep === null) return [];
    const actions: Action[] = [];
    for (const lane of this.k.executor.lanes.values()) {
      const lock = lockKey("forward", lane.address);
      if (this.k.executor.inflight.has(lock)) continue;
      const bal = await this.k.reader.usdcBalance(lane.address);
      const usd = Number(bal) / 10 ** USDC_DECIMALS;
      if (usd < this.cfg.forwardMinUsd) continue;
      const data = concatHex([TRANSFER, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, bal])]);
      const decide = (): Decision => ({ send: true, kind: "forward", reason: `forwards $${usd.toFixed(2)} to ${to}` });
      const a = this.action(null, dep.usdc, data, `forward $${usd.toFixed(2)} USDC`, {
        paid: false,
        background: true,
        locks: [lock],
        decide,
        probe: false,
      });
      a.wallet = lane.name;
      a.job = "forward";
      actions.push(a);
    }
    return actions;
  }

  override note(action: Action, result: ActionResult): void {
    if (result.status === "confirmed" && action.job === this.name) {
      const lane = this.k.executor.lanes.get(action.wallet);
      if (lane) this.firstSeen.delete(lockKey(lane.address, action.target));
    }
  }
}
