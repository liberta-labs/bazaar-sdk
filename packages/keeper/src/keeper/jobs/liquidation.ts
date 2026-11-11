/** Liquidation: seize positions below their maintenance margin. */

import {
  BAZAAR_SCALE,
  BP_SCALE,
  MAX_PRICE_STALENESS,
  type Market,
  type Position,
  bucketState,
  effectiveMmrBp,
  pair,
} from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { LiquidationJob as LiquidationJobConfig } from "../../config/index.js";
import { type Action, type ActionResult, lockKey } from "../../exec/executor.js";
import { Job, LIVE_OR_ADL, PricedCall, thousands, units } from "./base.js";

const PAIR = pair();

/** Why no price can decide a liquidation on a market now ({@link LiquidationJob.liquidationPrice}). */
export interface NoLiquidationPrice {
  readonly reason: string;
}

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

  /**
   * The price a liquidation on `m` is judged at now and the update it carries, or why no price can
   * decide one, as BazaarPair._liquidationPrice resolves it. A call without an update is judged at the
   * stored price only while that is at most 3 s old, and reverts past it
   * (BazaarPair__LiquidationPriceTooOld on a market with trading hours,
   * BazaarPair__NoPriceUpdatesProvided on a continuously traded one).
   *
   * Decided by PriceService.liquidationUpdate, at one instant:
   * - "fresh": priced as every other call at a fresh print ({@link atPrint}). On a market with
   *   trading hours the pair reads any update a liquidation carries as Pyth's latest price
   *   (BazaarOracle.verifyAndFetchLatestPrice), which also holds every update to having been issued
   *   within 3 s of the block, so the SDK offers a fresh print there only while each update carrying
   *   it was issued within that window less prices.sendMarginSeconds of `now`; past that, the cases
   *   below apply.
   * - "latest" (a market with trading hours only): Pyth's latest update, issued within the window less
   *   the send margin, its price at most a minute old in any block that admits it. The pair judges the
   *   call at that price whenever it is no older than the stored price, the stored price's own second
   *   included, where it stores nothing; at the stored price only when that is strictly newer.
   *   `priceTime` is the earliest update's issue second, the one the call must land within 3 s of.
   * - Otherwise a call without an update, judged at the stored price, only while that price is within
   *   the window less the send margin.
   */
  liquidationPrice(m: Market): PricedCall | NoLiquidationPrice {
    const prices = this.k.prices;
    const now = prices.clock();
    const lu = prices.liquidationUpdate(m, now);
    let reason: string;
    if (lu.kind === "fresh") {
      const why = this.unconfident(m);
      if (why === null) return this.atPrint(m);
      reason = why;
    } else if (lu.kind === "latest" && lu.price !== null && lu.priceTime !== null) {
      const st = m.state;
      const judged = st !== null && st.updateTs > lu.price.publishTime ? st.spot : lu.price.spot;
      return new PricedCall(judged, lu.update, lu.priceTime, true);
    } else {
      reason = lu.reason ?? "no price update can be attached";
    }
    const st = m.state;
    if (st !== null && st.spot > 0n && now - st.updateTs <= MAX_PRICE_STALENESS - prices.sendMargin) return new PricedCall(st.spot, [], st.updateTs);
    return { reason };
  }

  override async plan(m: Market): Promise<Action[]> {
    const positions = this.k.store.positions.get(m.address);
    if (positions === undefined || positions.size === 0) return [];
    const pc = this.liquidationPrice(m);
    if (!(pc instanceof PricedCall)) {
      this.k.unusablePrint(m, `no price can decide a liquidation now (${pc.reason})`);
      return [];
    }
    const st = m.state!;
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
    const updates = pc.updates; // before the first await: the update the price was read from, or none for the stored price
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
          priceIssued: pc.issued,
          locks: batch.map((a) => lockKey("liq", m.address, a)),
          rewardPair: m.address,
        }),
      );
    }
    return actions;
  }

  override note(action: Action, result: ActionResult): void {
    // Refused or unprofitable: wait before simulating the same accounts again. A price (or a latest
    // update's issue time) that aged before the send refused nothing: the next plan prices them again.
    if (!result.sent && !result.priceAged) for (const key of action.locks) this.cool(key);
  }
}
