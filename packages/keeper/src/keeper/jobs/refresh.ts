/** Price refresh: store a fresh price on quiet markets, for the refresh bounty and the health check. */

import { BAZAAR_SCALE, type Market, type ProbeResult, freeCapital, inventorySize, pair, refreshBountyDue } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { RefreshJob as RefreshJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job, LIVE_OR_ADL, monotonic } from "./base.js";

const PAIR = pair();

export class RefreshJob extends Job<RefreshJobConfig> {
  override readonly name = "refresh";
  override readonly statuses = LIVE_OR_ADL;
  /** market -> monotonic time of the next health poke */
  readonly nextPoke = new Map<Address, number>();

  override async plan(m: Market): Promise<Action[]> {
    const lock = lockKey("refresh", m.address);
    if (this.k.executor.inflight.has(lock) || this.cooling(lock)) return [];
    const pc = this.priced(m); // only a fresh print can advance the stored price
    if (pc === null) return [];
    const st = m.state!;
    const pp = this.k.prices.price(m)!;
    const held = inventorySize(st);
    const inventoryNotional = (held * st.spot) / BAZAAR_SCALE;
    const now = this.k.now();
    if (refreshBountyDue(st.updateTs, pp.publishTime, now, inventoryNotional, freeCapital(st))) {
      const updates = pc.updates;
      const fee = await this.k.reader.updateFee(updates);
      return [
        this.action(m, m.address, PAIR.encode("refreshPrice", updates), "refresh a quiet market's price", {
          value: fee,
          locks: [lock],
          rewardPair: m.address,
        }),
      ];
    }
    if (!this.cfg.healthPokes || held === 0n) return [];
    if ((this.nextPoke.get(m.address) ?? 0) > monotonic()) return [];
    this.nextPoke.set(m.address, monotonic() + this.cfg.healthPokeIntervalSeconds);
    const wasPending = st.adlPending;

    const changesHealth = (sim: ProbeResult): string | null => {
      if (sim.settlementFixedAfter) return null; // ends a timed-out ADL window (or another insolvency): worth paying for
      if (sim.adlPendingAfter && !wasPending) return null; // opens the ADL window and starts its clock
      return "the refresh would not change the vault's health state";
    };

    const updates = pc.updates;
    const fee = await this.k.reader.updateFee(updates);
    return [
      this.action(m, m.address, PAIR.encode("refreshPrice", updates), "health check (unpaid refresh)", {
        value: fee,
        locks: [lock],
        rewardPair: m.address,
        paid: false,
        consentCapUsd: this.cfg.healthPokeMaxCostUsd,
        requires: changesHealth,
      }),
    ];
  }

  override note(action: Action, result: ActionResult): void {
    if (!result.sent && action.market) this.cool(lockKey("refresh", action.market.address), 10);
  }
}
