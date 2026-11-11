/** Liquidation: seize positions below their maintenance margin. */

import { BAZAAR_SCALE, BP_SCALE, type Market, type Position, bucketState, effectiveMmrBp, pair } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { LiquidationJob as LiquidationJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job, LIVE_OR_ADL, thousands, units } from "./base.js";

const PAIR = pair();

/**
 * Whether `p` is below its maintenance requirement at `price` and `fundingIndex`: BucketLib's
 * calculateState solvency test (`availableEquity >= minRequiredCollateral && equity > 0`), without
 * building the whole state. This runs on every position of a market on every print, so it allocates
 * nothing it does not need. (BigInt division truncates toward zero, as signedMulDiv does.)
 */
export function belowMaintenance(p: Position, price: bigint, fundingIndex: bigint, mmrBp: bigint): boolean {
  const size = p.size;
  if (size === 0n) return false;
  const notional = (size * price) / BAZAAR_SCALE;
  const unrealized = p.isLong ? notional - p.entryValue : p.entryValue - notional;
  const rawFunding = ((fundingIndex - p.entryFundingIndex) * size) / BAZAAR_SCALE;
  const equity = p.collateral + unrealized + (p.isLong ? -rawFunding : rawFunding);
  if (equity <= 0n) return true;
  return equity < (mmrBp * notional) / BP_SCALE;
}

export class LiquidationJob extends Job<LiquidationJobConfig> {
  override readonly name = "liquidation";
  override readonly statuses = LIVE_OR_ADL;
  override readonly onPrint = true;

  /** Positions within watchBufferPct of their maintenance requirement at the latest print. */
  atRisk(m: Market): number {
    const pp = this.k.prices.price(m);
    const st = m.state;
    if (pp === null || st === null) return 0;
    const mmr = effectiveMmrBp(st.mmrBp, st.laggedMmrBp);
    const buffer = 1 + this.cfg.watchBufferPct / 100;
    let n = 0;
    for (const p of this.k.store.positions.get(m.address)?.values() ?? []) {
      const s = bucketState(p.isLong, p.size, p.entryValue, p.collateral, p.entryFundingIndex, pp.spot, st.projectedFundingIndex, mmr);
      if (Number(s.equity) < Number(s.minRequiredCollateral) * buffer) n += 1;
    }
    return n;
  }

  override async plan(m: Market): Promise<Action[]> {
    const pc = this.priced(m, true);
    if (pc === null) return [];
    const st = m.state!;
    const positions = this.k.store.positions.get(m.address);
    if (positions === undefined || positions.size === 0) return [];
    const mmr = effectiveMmrBp(st.mmrBp, st.laggedMmrBp);
    const price = pc.price;
    const fi = st.projectedFundingIndex;
    const own = this.k.walletAddresses();
    const inflight = this.k.executor.inflight;
    // Local first: only a position below its requirement at the live price costs a lock-key string or
    // an RPC request.
    let candidates: Address[] | null = null;
    for (const [acct, p] of positions) {
      if (!belowMaintenance(p, price, fi, mmr) || own.has(acct)) continue;
      const lock = lockKey("liq", m.address, acct);
      if (this.cooling(lock) || inflight.has(lock)) continue;
      (candidates ??= []).push(acct);
    }
    if (candidates === null) return [];
    const updates = pc.updates; // before the first await: the update of the print `price` is from, or none for the stored price
    const reader = this.k.reader;
    // The store follows events; the chain is re-read before anything is simulated. The fee read goes
    // out alongside, rather than after it.
    const [live, fee] = await Promise.all([reader.buckets(m.address, candidates), reader.updateFee(updates)]);
    const fiNow = m.state?.projectedFundingIndex ?? fi;
    const confirmed: Address[] = [];
    for (const [acct, b] of live) {
      if (b.size === 0n) {
        positions.delete(acct);
        continue;
      }
      const p: Position = {
        account: acct,
        isLong: b.isLong,
        size: b.size,
        entryValue: b.entryValue,
        collateral: b.collateral,
        entryFundingIndex: b.entryFundingIndex,
        block: 0,
      };
      positions.set(acct, p);
      if (belowMaintenance(p, price, fiNow, mmr)) confirmed.push(acct);
    }
    const actions: Action[] = [];
    const cap = this.cfg.maxAccountsPerCall;
    for (let i = 0; i < confirmed.length; i += cap) {
      const batch = confirmed.slice(i, i + cap);
      let notional = 0n;
      for (const a of batch) notional += (positions.get(a)!.size * price) / BAZAAR_SCALE;
      actions.push(
        this.action(m, m.address, PAIR.encode("liquidate", batch, updates), `liquidate ${batch.length} account(s), $${thousands(units(notional))} notional`, {
          value: fee,
          priceTime: pc.priceTime,
          locks: batch.map((a) => lockKey("liq", m.address, a)),
          rewardPair: m.address,
        }),
      );
    }
    return actions;
  }

  override note(action: Action, result: ActionResult): void {
    // Refused or unprofitable: wait before simulating the same accounts again. A price that aged
    // before the send refused nothing: the next print plans them again.
    if (!result.sent && !result.priceAged) for (const key of action.locks) this.cool(key);
  }
}
