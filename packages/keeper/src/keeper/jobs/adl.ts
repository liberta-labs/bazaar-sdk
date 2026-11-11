/** ADL execution: close profitable counterparties against the vault's buckets while a window is open. */

import { type Market, Status, adlScore, adlThreshold, bucketState, effectiveMmrBp, pair } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { AdlJob as AdlJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job } from "./base.js";

const PAIR = pair();
const ADL_ONLY: ReadonlySet<Status> = new Set([Status.Adl]);

interface Pnl {
  total: bigint;
  collateral: bigint;
  isLong: boolean;
}

export class AdlJob extends Job<AdlJobConfig> {
  override readonly name = "adl";
  override readonly statuses = ADL_ONLY;

  override async plan(m: Market): Promise<Action[]> {
    const st = m.state!;
    const lock = lockKey("adl", m.address);
    if (this.k.executor.inflight.has(lock) || this.cooling(lock)) return [];
    const pc = this.priced(m); // ADL refuses the stored price
    if (pc === null) return [];
    const mmr = effectiveMmrBp(st.mmrBp, st.laggedMmrBp);
    // Shorts close against the long bucket, longs against the short bucket, each only while that
    // bucket holds inventory.
    const shortsEligible = st.longInv.size > 0n;
    const longsEligible = st.shortInv.size > 0n;
    const pnl = new Map<Address, Pnl>();
    for (const [acct, p] of this.k.store.positions.get(m.address) ?? []) {
      if (!(p.isLong ? longsEligible : shortsEligible)) continue;
      const s = bucketState(p.isLong, p.size, p.entryValue, p.collateral, p.entryFundingIndex, pc.price, st.projectedFundingIndex, mmr);
      if (s.totalPnl > 0n) pnl.set(acct, { total: s.totalPnl, collateral: p.collateral, isLong: p.isLong });
    }
    if (pnl.size === 0) return [];
    const updates = pc.updates; // before the first await: the update of the print `price` is from, or none for the stored price
    const deposits = await this.k.reader.windowDeposits(m.address, [...pnl.keys()]);
    const threshold = adlThreshold(st.adlAuctionStart, this.k.now());
    const scored: { score: bigint; acct: Address; isLong: boolean }[] = [];
    for (const [acct, { total, collateral, isLong }] of pnl) {
      const score = adlScore(total, collateral, deposits.get(acct) ?? 0n);
      if (score >= threshold) scored.push({ score, acct, isLong });
    }
    if (scored.length === 0) return [];
    scored.sort((x, y) => (y.score > x.score ? 1 : y.score < x.score ? -1 : x.acct < y.acct ? -1 : x.acct > y.acct ? 1 : 0));
    const cap = this.cfg.maxWinnersPerSide;
    const longBucket = scored.filter((s) => !s.isLong).slice(0, cap).map((s) => s.acct);
    const shortBucket = scored.filter((s) => s.isLong).slice(0, cap).map((s) => s.acct);
    const fee = await this.k.reader.updateFee(updates);
    return [
      this.action(
        m,
        m.address,
        PAIR.encode("executeAdl", longBucket, shortBucket, updates),
        `ADL batch: ${longBucket.length} short(s) vs the long bucket, ${shortBucket.length} long(s) vs the short bucket`,
        { value: fee, priceTime: pc.priceTime, locks: [lock], rewardPair: m.address },
      ),
    ];
  }

  override note(action: Action, result: ActionResult): void {
    if (!result.sent && !result.priceAged && action.market) this.cool(lockKey("adl", action.market.address));
  }
}
