/** Trigger execution: fire StopLimit, StopLoss and TakeProfit orders whose trigger the price reached. */

import {
  MAX_TRIGGER_EXECS_PER_CALL,
  type Market,
  type OrderRecord,
  STOP_LIMIT,
  TRIGGER_PRICE_MASK,
  TRIGGER_TYPES,
  ZERO_ADDRESS,
  pair,
  triggerReached,
} from "@liberta-labs/bazaar-sdk";
import type { TriggersJob as TriggersJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job, units } from "./base.js";

const PAIR = pair();
const TRIGGER_TYPE_SET: ReadonlySet<number> = new Set(TRIGGER_TYPES);

interface Ready {
  bounty: bigint;
  oid: bigint;
  r: OrderRecord;
}

export class TriggersJob extends Job<TriggersJobConfig> {
  override readonly name = "triggers";
  override readonly onPrint = true;

  override async plan(m: Market): Promise<Action[]> {
    const pc = this.priced(m); // a stale price can neither arm a stop nor bound its fill
    if (pc === null) return [];
    const orders = this.k.store.orders.get(m.address);
    if (orders === undefined || orders.size === 0) return [];
    const minBounty = BigInt(Math.trunc(this.cfg.minBountyUsd * 1e18));
    const includeUnbountied = this.cfg.includeUnbountied;
    const head = this.k.head;
    const price = pc.price;
    const inflight = this.k.executor.inflight;
    let candidates: bigint[] | null = null;
    for (const [oid, o] of orders) {
      if (!o.known || o.terminal || o.inBook || !TRIGGER_TYPE_SET.has(o.orderType)) continue;
      if (o.expiryBlock < head + 1) continue;
      if (o.bounty < minBounty && !(includeUnbountied && o.bounty === 0n)) continue;
      if (!triggerReached(o.orderType, o.isLong, o.triggerPrice, price)) continue;
      const lock = lockKey("trig", m.address, oid);
      if (this.cooling(lock) || inflight.has(lock)) continue;
      (candidates ??= []).push(oid);
    }
    if (candidates === null) return [];
    const updates = pc.updates; // before the first await: the print `price` came from
    const reader = this.k.reader;
    const live = await reader.orders(m.address, candidates);
    let ready: Ready[] = [];
    for (const [oid, r] of live) {
      const o = orders.get(oid);
      if (o === undefined) continue;
      o.bounty = r.bounty;
      o.inBook = r.inBook;
      if (r.creator === ZERO_ADDRESS || r.canceledBlock !== 0 || r.filledBlock !== 0) {
        o.terminal = true;
        continue;
      }
      if (r.inBook || r.expiryBlock < head + 1) continue;
      // An execution in the block a stale-price creation left the order waiting in pays the owner.
      if (r.restedBlock >= head) continue;
      if (!triggerReached(r.orderType, r.isLong, r.triggerPrice & TRIGGER_PRICE_MASK, price)) continue;
      ready.push({ bounty: o.bounty, oid, r });
    }
    if (ready.length === 0) return [];
    ready.sort((x, y) => (y.bounty > x.bounty ? 1 : y.bounty < x.bounty ? -1 : 0)); // highest bounty first (stable)
    ready = ready.slice(0, MAX_TRIGGER_EXECS_PER_CALL);
    // StopLimits rest in the book once fired: each needs its predecessor hint. The hints and the fee
    // are independent reads, so they go out together.
    const [fee, ...preds] = await Promise.all([
      reader.updateFee(updates),
      ...ready.map(({ r }) => (r.orderType === STOP_LIMIT ? reader.predecessor(m.address, r.isLong, r.limitPrice) : 0n)),
    ]);
    const execs = ready.map(({ oid }, i) => ({ orderId: oid, hints: { pred: preds[i]!, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 } }));
    let bounty = 0n;
    for (const x of ready) bounty += x.bounty;
    return [
      this.action(
        m,
        m.address,
        PAIR.encode("executeTriggeredOrders", execs, updates),
        `execute ${execs.length} trigger order(s), up to $${units(bounty).toFixed(2)} of bounty`,
        { value: fee, locks: ready.map(({ oid }) => lockKey("trig", m.address, oid)), rewardPair: m.address },
      ),
    ];
  }

  override note(action: Action, result: ActionResult): void {
    if (result.sent) this.clearEarly(action.locks);
    else this.coolRefused(action, result, "executeTriggeredOrders"); // see Job.coolRefused
  }
}
