import { describe, expect, it } from "vitest";
import {
  ADL_MAX_SCORE,
  BAZAAR_SCALE as E18,
  MAX_UINT256,
  STOP_LIMIT,
  STOP_LOSS,
  TAKE_PROFIT,
  adlScore,
  adlThreshold,
  bucketState,
  convertExponent,
  effectiveMmrBp,
  pairPrice,
  refreshBountyDue,
  refreshBountyDueAt,
  signedMulDiv,
  triggerReached,
} from "../src/index.js";

describe("formulas", () => {
  it("signedMulDiv rounds toward zero", () => {
    expect(signedMulDiv(7n, 3n, 2n)).toBe(10n);
    expect(signedMulDiv(-7n, 3n, 2n)).toBe(-10n);
    expect(signedMulDiv(7n, -3n, -2n)).toBe(10n);
    expect(signedMulDiv(0n, 5n, 3n)).toBe(0n);
  });

  it("effective MMR takes the lower non-zero rate", () => {
    expect(effectiveMmrBp(500n, 0n)).toBe(500n);
    expect(effectiveMmrBp(500n, 300n)).toBe(300n);
    expect(effectiveMmrBp(300n, 500n)).toBe(300n);
  });

  it("bucket state: long under and over maintenance", () => {
    // 1 unit long from 2000 with 100 of collateral, 3% maintenance.
    const under = bucketState(true, E18, 2000n * E18, 100n * E18, 0n, 1950n * E18, 0n, 300n);
    expect(under.unrealizedPnl).toBe(-50n * E18);
    expect(under.minRequiredCollateral).toBe((1950n * E18 * 300n) / 10_000n);
    expect(under.isSolvent).toBe(false);
    const over = bucketState(true, E18, 2000n * E18, 100n * E18, 0n, 1960n * E18, 0n, 300n);
    expect(over.isSolvent).toBe(true);
  });

  it("bucket state: short, and funding direction", () => {
    const short = bucketState(false, 2n * E18, 4000n * E18, 200n * E18, 0n, 2100n * E18, 0n, 300n);
    expect(short.unrealizedPnl).toBe(-200n * E18);
    expect(short.isSolvent).toBe(false); // equity 0 is never solvent
    // A rising index costs longs and pays shorts: Δindex × size.
    const long = bucketState(true, 2n * E18, 4000n * E18, 500n * E18, 0n, 2000n * E18, E18, 300n);
    expect(long.fundingPnl).toBe(-2n * E18);
    const short2 = bucketState(false, 2n * E18, 4000n * E18, 500n * E18, 0n, 2000n * E18, E18, 300n);
    expect(short2.fundingPnl).toBe(2n * E18);
  });

  it("trigger predicates are inclusive and mirrored", () => {
    // A buy stop (closing a short) fires at or above its trigger; a sell stop at or below.
    expect(triggerReached(STOP_LOSS, true, 100n, 100n) && triggerReached(STOP_LOSS, true, 100n, 101n)).toBe(true);
    expect(triggerReached(STOP_LOSS, true, 100n, 99n)).toBe(false);
    expect(triggerReached(STOP_LIMIT, false, 100n, 100n)).toBe(true);
    expect(triggerReached(STOP_LIMIT, false, 100n, 101n)).toBe(false);
    // Take-profits are the mirror image.
    expect(triggerReached(TAKE_PROFIT, true, 100n, 100n) && triggerReached(TAKE_PROFIT, true, 100n, 99n)).toBe(true);
    expect(triggerReached(TAKE_PROFIT, true, 100n, 101n)).toBe(false);
    expect(triggerReached(TAKE_PROFIT, false, 100n, 101n)).toBe(true);
    expect(triggerReached(TAKE_PROFIT, false, 100n, 99n)).toBe(false);
  });

  it("ADL threshold decays quadratically to one", () => {
    expect(adlThreshold(0, 123)).toBe(MAX_UINT256);
    expect(adlThreshold(1000, 1000)).toBe(1n + ADL_MAX_SCORE);
    expect(adlThreshold(1000, 1300)).toBe(1n + ADL_MAX_SCORE / 4n);
    expect(adlThreshold(1000, 1600)).toBe(1n);
    expect(adlThreshold(1000, 99_999)).toBe(1n);
  });

  it("ADL score subtracts window deposits and floors at one", () => {
    expect(adlScore(50n * E18, 100n * E18, 0n)).toBe(E18 / 2n);
    expect(adlScore(50n * E18, 100n * E18, 50n * E18)).toBe(E18);
    expect(adlScore(50n * E18, 100n * E18, 200n * E18)).toBe(50n * E18 * E18);
    expect(adlScore(-1n, 100n * E18, 0n)).toBe(0n);
  });

  it("refresh bounty gates", () => {
    const bigInv = 1_250n * E18;
    const bigFund = 5_001n * E18;
    expect(refreshBountyDue(1000, 1400, 1301, bigInv, bigFund)).toBe(true);
    expect(refreshBountyDue(1000, 1400, 1300, bigInv, bigFund)).toBe(false); // gap must be exceeded
    expect(refreshBountyDue(1000, 1000, 9999, bigInv, bigFund)).toBe(false); // the stored price must advance
    expect(refreshBountyDue(1000, 1400, 1301, bigInv, 5_000n * E18)).toBe(false); // free capital must exceed $5,000
    expect(refreshBountyDue(1000, 90_000, 87_401, 0n, 1_001n * E18)).toBe(true); // heartbeat: a day
    expect(refreshBountyDue(1000, 90_000, 87_401, 0n, 1_000n * E18)).toBe(false); // and more than $1,000 free
    expect(refreshBountyDueAt(1000, bigInv, bigFund)).toBe(1301);
    expect(refreshBountyDueAt(1000, 0n, 500n * E18)).toBeNull();
  });

  it("convertExponent truncates toward zero", () => {
    expect(convertExponent(200_000_000_000n, -8)).toBe(2000n * E18);
    expect(convertExponent(-15n, -20, -18)).toBe(0n);
    expect(convertExponent(-155n, -20, -18)).toBe(-1n);
  });

  it("convertExponent refuses exponents more than 77 apart at once, as the contract reverts past 10^77", () => {
    expect(convertExponent(1n, 59)).toBe(10n ** 77n); // 59 - (-18) = 77: the largest shift
    expect(convertExponent(10n ** 77n, -95)).toBe(1n);
    const t0 = performance.now();
    expect(() => convertExponent(1n, -30_000_000)).toThrow(RangeError); // used to build 10^29999982 (seconds)
    expect(() => convertExponent(1n, 1_000_000_000)).toThrow(RangeError);
    expect(() => convertExponent(1n, 60)).toThrow("at most 77 apart");
    expect(() => convertExponent(1n, -8.5)).toThrow(RangeError);
    expect(() => convertExponent(1n, Number.NaN)).toThrow(RangeError);
    expect(() => pairPrice([{ price: 1n, conf: 0n, expo: -3e7, publishTime: 1 }], false)).toThrow(RangeError);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("pair price: single leg and composites", () => {
    const base = { price: 200_000_000_000n, conf: 100_000_000n, expo: -8, publishTime: 50 }; // 2000 ± 1
    const p = pairPrice([base], false)!;
    expect([p.spot, p.low, p.high, p.confidenceOk]).toEqual([2000n * E18, 1999n * E18, 2001n * E18, true]);
    expect(pairPrice([{ price: 100n, conf: 3n, expo: 0, publishTime: 1 }], false)!.confidenceOk).toBe(false); // 3% > 2%
    const jpyAsset = { price: 300_000n, conf: 0n, expo: 0, publishTime: 10 }; // 300,000 JPY
    const usdJpy = { price: 150n, conf: 0n, expo: 0, publishTime: 8 };
    const comp = pairPrice([jpyAsset, usdJpy], true)!;
    expect(comp.spot).toBe(2000n * E18);
    expect(comp.publishTime).toBe(8);
    const gbpAsset = { price: 1000n, conf: 0n, expo: 0, publishTime: 10 };
    const gbpUsd = { price: 125n, conf: 0n, expo: -2, publishTime: 12 };
    expect(pairPrice([gbpAsset, gbpUsd], false)!.spot).toBe(1250n * E18);
  });
});
