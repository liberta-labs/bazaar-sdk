/**
 * Expired-order cleanup: unlink expired orders and return stranded bounties to their owners.
 *
 * sweepExpired pays its caller nothing, so this job only runs as a loss the operator accepts, within
 * its loss budget.
 */

import { LIMIT, type Market, STOP_LIMIT, pair } from "@liberta-labs/bazaar-sdk";
import type { SweepExpiredJob as SweepExpiredJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job } from "./base.js";

const PAIR = pair();

export class SweepExpiredJob extends Job<SweepExpiredJobConfig> {
  override readonly name = "sweepExpired";

  override async plan(m: Market): Promise<Action[]> {
    const lock = lockKey("sweep", m.address);
    if (this.k.executor.inflight.has(lock) || this.cooling(lock)) return [];
    const head = this.k.head;
    const orders = this.k.store.orders.get(m.address);
    if (orders === undefined || orders.size === 0) return [];
    const expired: bigint[] = [];
    const refunds: bigint[] = [];
    const withRefunds = this.cfg.includeBountyRefunds;
    for (const o of orders.values()) {
      if (o.known && !o.terminal && (o.orderType === LIMIT || o.orderType === STOP_LIMIT) && o.expiryBlock < head) expired.push(o.orderId);
      if (withRefunds && o.terminal && o.bounty > 0n) refunds.push(o.orderId);
    }
    if (expired.length === 0 && refunds.length === 0) return [];
    if (expired.length + refunds.length < this.cfg.minBatch && refunds.length === 0) return [];
    const live = await this.k.reader.orders(m.address, [...expired, ...refunds]);
    let ids: bigint[] = [];
    for (const [oid, r] of live) {
      const o = orders.get(oid);
      const terminal = r.canceledBlock !== 0 || r.filledBlock !== 0;
      if (o !== undefined) {
        o.terminal = terminal;
        o.bounty = r.bounty;
        o.inBook = r.inBook;
      }
      if ((!terminal && r.expiryBlock < head) || (terminal && r.bounty > 0n)) ids.push(oid);
      else if (o !== undefined && terminal && r.bounty === 0n) orders.delete(oid);
    }
    if (ids.length === 0) return [];
    ids = ids.slice(0, this.cfg.maxOrdersPerCall);
    return [
      this.action(m, m.address, PAIR.encode("sweepExpired", ids), `sweep ${ids.length} expired or finished order(s)`, {
        locks: [lock],
        paid: false,
        background: true,
      }),
    ];
  }

  override note(action: Action, result: ActionResult): void {
    if (!result.sent && action.market) this.cool(lockKey("sweep", action.market.address), 300);
  }
}
