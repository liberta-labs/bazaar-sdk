/** Terminal settlement: settle every open position at a fixed settlement price, then finalize. */

import { type Market, type Position, Status, TERMINAL_SETTLEMENT_ESCAPE, pair } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { TerminalSettlementJob as TerminalSettlementJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job } from "./base.js";

const PAIR = pair();
const SETTLING_OR_TERMINATED: ReadonlySet<Status> = new Set([Status.Settling, Status.Terminated]);

export class TerminalSettlementJob extends Job<TerminalSettlementJobConfig> {
  override readonly name = "terminalSettlement";
  override readonly statuses = SETTLING_OR_TERMINATED;

  override async plan(m: Market): Promise<Action[]> {
    const st = m.state!;
    const lock = lockKey("settle", m.address);
    if (this.k.executor.inflight.has(lock) || this.cooling(lock)) return [];
    const own = this.k.walletAddresses();
    const positions = this.k.store.positionsOf(m.address);
    // The wallet's own positions earn no tip; their owner settles them by withdrawing.
    const open: Address[] = [];
    for (const [a, p] of positions) if (p.size && !own.has(a)) open.push(a);
    if (open.length > 0) {
      const live = await this.k.reader.buckets(m.address, open);
      const accounts: Address[] = [];
      for (const [a, b] of live) {
        if (b.size === 0n) {
          positions.delete(a);
        } else {
          const p: Position = {
            account: a,
            isLong: b.isLong,
            size: b.size,
            entryValue: b.entryValue,
            collateral: b.collateral,
            entryFundingIndex: b.entryFundingIndex,
            block: 0,
          };
          positions.set(a, p);
          accounts.push(a);
        }
      }
      if (accounts.length > 0) {
        // One batch at a time; the next tick takes the rest.
        const batch = accounts.slice(0, this.cfg.maxAccountsPerCall);
        return [
          this.action(m, m.address, PAIR.encode("liquidate", batch, []), `settle ${batch.length} position(s) at the settlement price`, {
            locks: [lock],
            rewardPair: m.address,
          }),
        ];
      }
    }
    if (this.cfg.finalize && !st.terminated) {
      const escape = this.k.now() >= st.settlementFixedTs + TERMINAL_SETTLEMENT_ESCAPE;
      if ((st.longOi === 0n && st.shortOi === 0n) || escape) {
        return [
          this.action(m, m.address, PAIR.encode("finalizeTermination"), "finalize the termination", {
            locks: [lock],
            paid: false,
            consentCapUsd: this.cfg.finalizeMaxCostUsd,
            background: true,
          }),
        ];
      }
    }
    return [];
  }

  override note(action: Action, result: ActionResult): void {
    if (!result.sent && action.market) this.cool(lockKey("settle", action.market.address), 30);
  }
}
