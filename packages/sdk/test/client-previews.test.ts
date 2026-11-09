import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { Chain } from "../src/chain/client.js";
import { type ContractCodec, lens as lensCodec, pair as pairCodec } from "../src/chain/codec.js";
import type { RequestArgs, Transport } from "../src/chain/rpc.js";
import type { BazaarContext } from "../src/client/context.js";
import {
  type Bucket,
  type MarginRates,
  applyFill,
  creationGate,
  feeBreakdown,
  fillDebit,
  fillMarginOk,
  liquidationPrice,
  makerFillFee,
  maxLeverage,
  positionState,
  previewOrder,
  previewWithdrawal,
  restingReserve,
  simulateOrder,
  takerFillFee,
  takerInsuranceFeeBase,
  takerInsuranceFeeRates,
  worstCaseNotional,
} from "../src/client/previews.js";
import { OrderType, STOP_LIMIT, TAKE_PROFIT, ZERO_ADDRESS } from "../src/constants.js";
import { bucketState } from "../src/formulas/index.js";

const E18 = 10n ** 18n;
const usd = (n: number | string) => (typeof n === "number" ? BigInt(Math.round(n * 1e6)) * 10n ** 12n : BigInt(n));
const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");
const BOB = getAddress("0x0000000000000000000000000000000000000b0b");
const CAROL = getAddress("0x00000000000000000000000000000000000ca401");
const INTEGRATOR = getAddress("0x00000000000000000000000000000000001e7e67");
const PAIR = getAddress("0x00000000000000000000000000000000000000aa");
const LENS = getAddress("0x00000000000000000000000000000000000000bb");

const flat = (collateral: bigint): Bucket => ({ isLong: false, size: 0n, entryValue: 0n, collateral, entryFundingIndex: 0n });
const long = (size: bigint, entryValue: bigint, collateral: bigint, efi = 0n): Bucket => ({ isLong: true, size, entryValue, collateral, entryFundingIndex: efi });
const short = (size: bigint, entryValue: bigint, collateral: bigint, efi = 0n): Bucket => ({ isLong: false, size, entryValue, collateral, entryFundingIndex: efi });
const RATES: MarginRates = { imrBp: 1000n, mmrBp: 500n, laggedMmrBp: 0n };
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;

// =====================================================================================================
// Fee schedule (RiskParamsLib.getInsuranceFeeRates, MatchingEngineLib._computePairFees / _finalizeTx)
// =====================================================================================================

describe("fee schedule", () => {
  it("interpolates the taker base rate between the 2% and 10% targets", () => {
    expect(takerInsuranceFeeBase(100n)).toBe(75n);
    expect(takerInsuranceFeeBase(200n)).toBe(75n);
    expect(takerInsuranceFeeBase(600n)).toBe(250n); // 75 + 400 * 350 / 800
    expect(takerInsuranceFeeBase(1000n)).toBe(425n);
    expect(takerInsuranceFeeBase(5000n)).toBe(425n);
    expect(takerInsuranceFeeBase(201n)).toBe(75n); // 75 + 1 * 350 / 800 floors to 75
  });

  it("charges the base at or above target and multiplies it up below", () => {
    expect(takerInsuranceFeeRates(300n, 200n)).toEqual({ takerEbp: 75n, closingEbp: 75n });
    expect(takerInsuranceFeeRates(2n ** 256n - 1n, 600n)).toEqual({ takerEbp: 250n, closingEbp: 250n }); // no open interest
    // empty fund at a 2% target: 75 x (1 + 49) = 3750 EBP = 37.5 bp, as docs/guide/trading.md says
    expect(takerInsuranceFeeRates(0n, 200n)).toEqual({ takerEbp: 3750n, closingEbp: 75n });
    // half funded: deficit 5000 bp -> 75 x (1e8 + 49 x 25e6) / 1e8 = 993.75, floored
    expect(takerInsuranceFeeRates(100n, 200n)).toEqual({ takerEbp: 993n, closingEbp: 75n });
    // empty at the 10% target: 425 x 50 = 21250, capped at 50 bp
    expect(takerInsuranceFeeRates(0n, 1000n)).toEqual({ takerEbp: 5000n, closingEbp: 425n });
  });

  it("charges a taker the dynamic rate and 0.25 bp per integrator", () => {
    const f = takerFillFee(2n * E18, 3000n * E18, true, { isLong: false, size: 0n }, { takerEbp: 75n, closingEbp: 75n }, true);
    expect(f).toEqual({ insurance: usd(0.45), integrator: usd(0.15), total: usd(0.6) });
    const g = takerFillFee(2n * E18, 3000n * E18, true, { isLong: false, size: 0n }, { takerEbp: 75n, closingEbp: 75n }, false);
    expect(g.integrator).toBe(0n);
  });

  it("charges the closing part of a flip at the base rate", () => {
    // long 1, sells 3 at $3000: $3000 closes at 0.75 bp, $6000 opens at 9.93 bp
    const f = takerFillFee(3n * E18, 3000n * E18, false, { isLong: true, size: E18 }, { takerEbp: 993n, closingEbp: 75n }, false);
    expect(f.insurance).toBe(usd(0.225) + usd(5.958));
    // a pure reduce pays only the base rate however thin the fund
    const r = takerFillFee(E18, 3000n * E18, false, { isLong: true, size: 2n * E18 }, { takerEbp: 5000n, closingEbp: 75n }, false);
    expect(r.insurance).toBe(usd(0.225));
    // adding to the same side pays the dynamic rate on all of it
    const a = takerFillFee(E18, 3000n * E18, true, { isLong: true, size: 2n * E18 }, { takerEbp: 993n, closingEbp: 75n }, false);
    expect(a.insurance).toBe(usd(2.979));
  });

  it("charges a maker a flat 0.25 bp, plus 0.25 bp per integrator", () => {
    expect(makerFillFee(2n * E18, 3000n * E18, false)).toEqual({ insurance: usd(0.15), integrator: 0n, total: usd(0.15) });
    expect(makerFillFee(2n * E18, 3000n * E18, true).total).toBe(usd(0.3));
  });

  it("skims 1% of both legs to the bug bounty", () => {
    const b = feeBreakdown({ insurance: usd(0.45), integrator: usd(0.15), total: usd(0.6) });
    expect(b.toInsuranceFund).toBe(usd(0.4455));
    expect(b.toIntegrator).toBe(usd(0.1485));
    expect(b.toBugBounty).toBe(usd(0.006));
    expect(b.toInsuranceFund + b.toIntegrator + b.toBugBounty).toBe(b.total);
  });
});

// =====================================================================================================
// Position transitions (MatchingEngineLib._applyFillCore)
// =====================================================================================================

describe("applyFill", () => {
  const fi = 10n * E18; // longs pay $10 per unit since entry

  it("flips a long into a short, realizing price PnL and funding", () => {
    const r = applyFill(long(2n * E18, 5000n * E18, 1000n * E18), false, 3n * E18, 3000n * E18, usd(6.183), fi);
    expect(r.realizedPnl).toBe(1000n * E18); // 6000 - 5000
    expect(r.settledFunding).toBe(-20n * E18);
    expect(r.position).toMatchObject({ isLong: false, size: E18, entryValue: 3000n * E18, collateral: usd(1973.817), entryFundingIndex: fi });
  });

  it("closes part of a position pro rata", () => {
    const r = applyFill(long(2n * E18, 5000n * E18, 1000n * E18), false, E18 / 2n, 3000n * E18, 0n, fi);
    expect(r.realizedPnl).toBe(250n * E18); // 1500 - 1250
    expect(r.settledFunding).toBe(-5n * E18);
    expect(r.position).toMatchObject({ isLong: true, size: (3n * E18) / 2n, entryValue: 3750n * E18, collateral: 1245n * E18, entryFundingIndex: 0n });
  });

  it("closes to flat and clears the entry funding index", () => {
    const r = applyFill(short(E18, 3000n * E18, 500n * E18, 4n * E18), true, E18, 2900n * E18, usd(0.3), fi);
    expect(r.realizedPnl).toBe(100n * E18);
    expect(r.settledFunding).toBe(6n * E18); // shorts receive (10 - 4) per unit
    expect(r.position).toMatchObject({ size: 0n, entryValue: 0n, entryFundingIndex: 0n, collateral: usd(605.7) });
  });

  it("averages the entry funding index when adding", () => {
    const r = applyFill(long(2n * E18, 5000n * E18, 1000n * E18), true, 2n * E18, 3000n * E18, 0n, fi);
    expect(r.position).toMatchObject({ size: 4n * E18, entryValue: 11000n * E18, entryFundingIndex: 5n * E18 });
  });

  it("opens from flat at the current funding index", () => {
    const r = applyFill(flat(100n * E18), false, E18, 3000n * E18, usd(0.15), fi);
    expect(r.position).toMatchObject({ isLong: false, size: E18, entryValue: 3000n * E18, entryFundingIndex: fi, collateral: usd(99.85) });
  });
});

// =====================================================================================================
// Margin (MatchingEngineLib._checkMargin, OrderManagementLib._creationShortfall, CollateralLib)
// =====================================================================================================

describe("fill margin gate", () => {
  const mark = 1000n * E18;

  it("requires initial margin on a new position after the fee", () => {
    expect(fillMarginOk(flat(100n * E18), true, E18, mark, usd(0.1), mark, 0n, RATES)).toBe(false);
    expect(fillMarginOk(flat(usd(100.1)), true, E18, mark, usd(0.1), mark, 0n, RATES)).toBe(true);
    expect(fillMarginOk(flat(usd(0.05)), true, E18 / 1000n, mark, usd(0.1), mark, 0n, RATES)).toBe(false); // fee above collateral
  });

  it("debits the loss a fill above the mark books", () => {
    expect(fillMarginOk(flat(110n * E18), true, E18, 1010n * E18, 0n, mark, 0n, RATES)).toBe(true); // 110 - 10 >= 100
    expect(fillMarginOk(flat(usd(109.99)), true, E18, 1010n * E18, 0n, mark, 0n, RATES)).toBe(false);
  });

  it("passes a partial close outright above initial margin, else holds the margin ratio", () => {
    const pos = long(10n * E18, 10000n * E18, 600n * E18);
    expect(fillMarginOk(pos, false, 5n * E18, mark, 0n, mark, 0n, RATES)).toBe(true);
    const thin = long(10n * E18, 10000n * E18, 400n * E18);
    expect(fillMarginOk(thin, false, 5n * E18, mark, 0n, mark, 0n, RATES)).toBe(true); // ratio 400/250 vs 400/500
    // at $960 the margin after (200) x 500 equals 400 x 250: allowed; a dollar lower is not
    expect(fillMarginOk(thin, false, 5n * E18, 960n * E18, 0n, mark, 0n, RATES)).toBe(true);
    expect(fillMarginOk(thin, false, 5n * E18, 959n * E18, 0n, mark, 0n, RATES)).toBe(false);
  });

  it("requires a flip to close without bad debt and open at initial margin", () => {
    expect(fillMarginOk(long(E18, 1000n * E18, 50n * E18), false, 2n * E18, mark, 0n, mark, 0n, RATES)).toBe(false);
    expect(fillMarginOk(long(E18, 1000n * E18, 150n * E18), false, 2n * E18, mark, 0n, mark, 0n, RATES)).toBe(true);
    // the long is $200 underwater: closing it costs more than its collateral
    expect(fillMarginOk(long(E18, 1200n * E18, 150n * E18), false, 2n * E18, mark, 0n, mark, 0n, RATES)).toBe(false);
  });

  it("charges the held loss against an add", () => {
    // long 1 bought at $1100, mark $1000: $100 loss; adding 1 needs $200 IMR on $2000
    expect(fillMarginOk(long(E18, 1100n * E18, 300n * E18), true, E18, mark, 0n, mark, 0n, RATES)).toBe(true);
    expect(fillMarginOk(long(E18, 1100n * E18, usd(299.99)), true, E18, mark, 0n, mark, 0n, RATES)).toBe(false);
  });
});

describe("creation gate and reservations", () => {
  const spot = 3000n * E18;
  const st = (b: Bucket, price = spot) => positionState(b, price, 0n, RATES);
  const market = { orderType: OrderType.Market, isLong: true, size: E18, limitPrice: 0n, triggerPrice: spot, maxSlippageBp: 100n, hasIntegrator: false };

  it("margins a market order at the far slippage bound", () => {
    const g = creationGate(market, flat(100n * E18), st(flat(100n * E18)), spot, 1000n, { longExposure: 0n, shortExposure: 0n, fillDebit: 0n });
    expect(g).toEqual({ required: 303n * E18, ok: false }); // 10% of 1 x 3030
    const g2 = creationGate({ ...market, isLong: false }, flat(400n * E18), st(flat(400n * E18)), spot, 1000n, { longExposure: 0n, shortExposure: 0n, fillDebit: 0n });
    expect(g2).toEqual({ required: 303n * E18, ok: true }); // both sides at the upper bound
  });

  it("adds the resting set on the worse side, its fill debit and the held loss", () => {
    const resting = { longExposure: 1000n * E18, shortExposure: 0n, fillDebit: usd(0.5) };
    expect(creationGate(market, flat(500n * E18), st(flat(500n * E18)), spot, 1000n, resting).required).toBe(403n * E18 + usd(0.5));
    // long 1 from $3000 at a $2900 spot: $100 held loss; buying 1 more at $2929 (1% above $2900)
    const pos = long(E18, 3000n * E18, 1000n * E18);
    const g = creationGate(market, pos, st(pos, 2900n * E18), 2900n * E18, 1000n, { longExposure: 0n, shortExposure: 0n, fillDebit: 0n });
    expect(g.required).toBe(usd(582.9) + 100n * E18);
  });

  it("does not judge an order that only reduces", () => {
    const pos = long(2n * E18, 6000n * E18, 10n * E18);
    const sell = { orderType: OrderType.Limit, isLong: false, size: E18, limitPrice: spot, triggerPrice: 0n, maxSlippageBp: 0n, hasIntegrator: false };
    expect(creationGate(sell, pos, st(pos), spot, 1000n, { longExposure: 0n, shortExposure: 0n, fillDebit: 0n })).toEqual({ required: 0n, ok: true });
  });

  it("values a sell limit above the spot at its limit and reserves its maker fee", () => {
    const sell = { orderType: OrderType.Limit, isLong: false, size: E18, limitPrice: 3100n * E18, triggerPrice: 0n, maxSlippageBp: 0n, hasIntegrator: false };
    const g = creationGate(sell, flat(400n * E18), st(flat(400n * E18)), spot, 1000n, { longExposure: 0n, shortExposure: 0n, fillDebit: 0n });
    expect(g.required).toBe(310n * E18 + usd(0.0775));
  });

  it("reserves resting orders as the pair does", () => {
    expect(fillDebit(OrderType.Limit, true, E18, 2900n * E18, 0n, spot, false)).toBe(usd(0.0725));
    expect(fillDebit(OrderType.Limit, false, E18, 2900n * E18, 0n, spot, false)).toBe(100n * E18 + usd(0.0725));
    expect(fillDebit(STOP_LIMIT, true, E18, 3150n * E18, 3100n * E18, spot, true)).toBe(50n * E18 + usd(0.1575));
    const r = restingReserve(
      [
        { orderType: OrderType.Limit, isLong: true, remaining: E18, limitPrice: 2900n * E18, triggerPrice: 0n, inBook: true, integrator: ZERO_ADDRESS },
        { orderType: OrderType.Limit, isLong: false, remaining: E18, limitPrice: 2900n * E18, triggerPrice: 0n, inBook: true, integrator: ZERO_ADDRESS },
        { orderType: STOP_LIMIT, isLong: true, remaining: E18, limitPrice: 3150n * E18, triggerPrice: 3100n * E18, inBook: false, integrator: ZERO_ADDRESS },
      ],
      spot,
    );
    expect(r.longExposure).toBe(3000n * E18 + 3150n * E18); // bid at the mark, waiting stop at its limit
    expect(r.shortExposure).toBe(3000n * E18); // ask below the mark at the mark
    expect(r.fillDebit).toBe(usd(0.0725) + 100n * E18 + usd(0.0725) + 50n * E18 + usd(0.07875));
    expect(worstCaseNotional(true, 1000n, 500n, 2000n)).toBe(1500n);
    expect(worstCaseNotional(true, 1000n, 500n, 3000n)).toBe(2000n);
  });
});

describe("liquidation price and leverage", () => {
  it("solves equity = maintenance for a long", () => {
    const pos = long(E18, 3000n * E18, 300n * E18);
    const p = liquidationPrice(pos, 0n, { imrBp: 1000n, mmrBp: 500n, laggedMmrBp: 0n })!;
    expect(p).toBe(ceil(2700n * E18 * 10_000n * E18, 9500n * E18)); // $2842.105...
    expect(p).toBe(2842105263157894736843n);
    expect(bucketState(true, E18, 3000n * E18, 300n * E18, 0n, p, 0n, 500n).isSolvent).toBe(true);
    expect(bucketState(true, E18, 3000n * E18, 300n * E18, 0n, p - 10n ** 6n, 0n, 500n).isSolvent).toBe(false);
  });

  it("solves it for a short", () => {
    const p = liquidationPrice(short(E18, 3000n * E18, 300n * E18), 0n, { imrBp: 1000n, mmrBp: 500n, laggedMmrBp: 0n })!;
    expect(p).toBe(3142857142857142857142n); // 3300 / 1.05
    expect(bucketState(false, E18, 3000n * E18, 300n * E18, 0n, p, 0n, 500n).isSolvent).toBe(true);
    expect(bucketState(false, E18, 3000n * E18, 300n * E18, 0n, p + 10n ** 6n, 0n, 500n).isSolvent).toBe(false);
  });

  it("uses the lower lagged rate and counts accrued funding", () => {
    expect(liquidationPrice(long(E18, 3000n * E18, 300n * E18), 0n, { imrBp: 1000n, mmrBp: 500n, laggedMmrBp: 300n })).toBe(
      ceil(2700n * E18 * 10_000n * E18, 9700n * E18),
    );
    // longs have paid $20 of funding: it comes off equity
    expect(liquidationPrice(long(E18, 3000n * E18, 300n * E18), 20n * E18, RATES)).toBe(ceil(2720n * E18 * 10_000n * E18, 9500n * E18));
  });

  it("has none for a flat or fully collateralized long", () => {
    expect(liquidationPrice(flat(5n * E18), 0n, RATES)).toBeNull();
    expect(liquidationPrice(long(E18, 3000n * E18, 3000n * E18), 0n, RATES)).toBeNull();
    expect(maxLeverage(400n)).toBe(25);
    expect(maxLeverage(2000n)).toBe(5);
  });
});

// =====================================================================================================
// The arrival walk (MatchingEngineLib._walkTaker / _disposeRemainder)
// =====================================================================================================

const asks = (...rows: [bigint, bigint, Address?, number?][]) =>
  rows.map(([size, price, owner, expiry], i) => ({ orderId: BigInt(100 + i), owner: owner ?? BOB, price: price * E18, remaining: size, expiryBlock: expiry ?? 10_000 }));

const base = {
  account: ALICE,
  integrator: INTEGRATOR,
  mark: 3000n * E18,
  fundingIndex: 0n,
  rates: RATES,
  fees: { takerEbp: 993n, closingEbp: 75n },
  continuous: true,
  currentBlock: 1_000,
};

describe("simulateOrder", () => {
  it("walks the asks up to the slippage bound, fee per fill", () => {
    const r = simulateOrder({
      ...base,
      bucket: flat(1000n * E18),
      order: { isLong: true, size: 3n * E18, maxSlippageBp: 100n },
      book: asks([E18, 3000n], [E18, 3010n], [5n * E18, 3020n], [5n * E18, 3040n]),
    });
    expect(r.fills.map((f) => f.price)).toEqual([3000n * E18, 3010n * E18, 3020n * E18]);
    expect(r.fills[0]!.fee).toEqual({ insurance: usd(2.979), integrator: usd(0.075), total: usd(3.054) });
    expect(r.fees.insurance).toBe(usd(2.979) + usd(2.98893) + usd(2.99886));
    expect(r.fees.integrator).toBe(usd(0.075) + usd(0.07525) + usd(0.0755));
    expect(r.takerAvgPrice).toBe(3010n * E18);
    expect(r.after).toMatchObject({ isLong: true, size: 3n * E18, entryValue: 9030n * E18, collateral: 1000n * E18 - r.fees.total });
    expect(r.after.notional).toBe(9000n * E18);
    expect(r.after.unrealizedPnl).toBe(-30n * E18);
    expect(r.after.liquidationPrice).toBe(ceil((9030n * E18 - (1000n * E18 - r.fees.total)) * 10_000n * E18, 9500n * 3n * E18));
    expect(r.margin).toMatchObject({ requiredCollateral: 909n * E18, ok: true, shortfall: 0n, initialMargin: 900n * E18, retainedFloorBp: 500n, retainedFloor: 450n * E18 });
    expect(r.maxLeverage).toBe(10);
    expect(r.blockers).toEqual([]);
    expect(r.opens && !r.flips && !r.reduces).toBe(true);
  });

  it("stops at the bound and cancels a market remainder", () => {
    const r = simulateOrder({ ...base, bucket: flat(1000n * E18), order: { isLong: true, size: 3n * E18, maxSlippageBp: 100n }, book: asks([E18, 3000n], [5n * E18, 3031n]) });
    expect(r.takerSize).toBe(E18);
    expect(r.canceledSize).toBe(2n * E18);
    expect(r.cancelReason).toBe("Unfilled");
  });

  it("skips expired makers and stops at its own order", () => {
    const r = simulateOrder({ ...base, bucket: flat(1000n * E18), order: { isLong: true, size: E18, maxSlippageBp: 100n }, book: asks([E18, 2990n, BOB, 999], [E18, 3000n, ALICE]) });
    expect(r.fills).toEqual([]);
    expect(r.cancelReason).toBe("SelfMatch");
  });

  it("flips a position, the closing part at the base rate", () => {
    const r = simulateOrder({
      ...base,
      integrator: ZERO_ADDRESS,
      bucket: long(E18, 3000n * E18, 1000n * E18),
      order: { isLong: false, size: 3n * E18, maxSlippageBp: 100n },
      book: asks([5n * E18, 3000n]),
    });
    expect(r.fees.total).toBe(usd(0.225) + usd(5.958));
    expect(r.after).toMatchObject({ isLong: false, size: 2n * E18, entryValue: 6000n * E18 });
    expect(r.flips && r.reduces && r.opens && !r.closes).toBe(true);
    expect(r.realizedPnl).toBe(0n);
  });

  it("rests a limit's remainder and previews its later maker fill", () => {
    const r = simulateOrder({ ...base, bucket: flat(1000n * E18), order: { orderType: OrderType.Limit, isLong: true, size: 2n * E18, limitPrice: 3005n * E18 }, book: asks([E18, 3000n], [E18, 3010n]) });
    expect(r.takerSize).toBe(E18);
    expect(r.restingSize).toBe(E18);
    expect(r.fills.map((f) => [f.role, f.later])).toEqual([["taker", false], ["maker", true]]);
    expect(r.fills[1]!.fee).toEqual(makerFillFee(E18, 3005n * E18, true));
    expect(r.afterArrival.size).toBe(E18);
    expect(r.after).toMatchObject({ size: 2n * E18, entryValue: 6005n * E18 });
    expect(r.laterFillOk).toBe(true);
  });

  it("cancels a post-only that would cross", () => {
    const r = simulateOrder({ ...base, bucket: flat(1000n * E18), order: { orderType: OrderType.Limit, isLong: true, size: E18, limitPrice: 3005n * E18, isPostOnly: true }, book: asks([E18, 3000n]) });
    expect(r.cancelReason).toBe("PostOnly");
    expect(r.fills).toEqual([]);
  });

  it("reverts a fill-or-kill the book cannot fill", () => {
    const r = simulateOrder({ ...base, bucket: flat(1000n * E18), order: { isLong: true, size: 2n * E18, maxSlippageBp: 100n, tif: 2 }, book: asks([E18, 3000n]) });
    expect(r.blockers.map((b) => b.error)).toEqual(["MatchingEngineLib__FillOrKillUnfilled"]);
  });

  it("stops the walk where the taker's margin gives out", () => {
    // $350 opens 1 at $3000 ($300 IMR) but not 2
    const r = simulateOrder({ ...base, integrator: ZERO_ADDRESS, bucket: flat(350n * E18), order: { orderType: OrderType.Limit, isLong: true, size: 2n * E18, limitPrice: 3000n * E18, tif: 1 }, book: asks([E18, 3000n], [E18, 3000n]) });
    expect(r.takerSize).toBe(E18);
    expect(r.cancelReason).toBe("Margin");
    expect(r.blockers.map((b) => b.error)).toEqual(["OrderManagementLib__InsufficientMarginAfterOrder"]);
    expect(r.margin.shortfall).toBe(usd(600.15) - 350n * E18); // the IOC limit still reserves its maker fee
  });

  it("reports what createOrder refuses, with messages", () => {
    const run = (order: Parameters<typeof simulateOrder>[0]["order"], bucket = flat(1000n * E18)) =>
      simulateOrder({ ...base, bucket, order }).blockers.map((b) => b.error);
    expect(run({ orderType: OrderType.Limit, isLong: true, size: E18, limitPrice: 1000n * E18 })).toEqual(["OrderManagementLib__LimitPriceOutsidePlacementBand"]);
    expect(run({ isLong: true, size: E18, maxSlippageBp: 0n })).toEqual(["OrderManagementLib__InvalidSlippage"]);
    expect(run({ isLong: true, size: E18 / 1000n, maxSlippageBp: 100n })).toEqual(["OrderManagementLib__NotionalBelowMinimum"]);
    expect(run({ isLong: false, size: E18 / 1000n, maxSlippageBp: 100n }, long(E18 / 1000n, 3n * E18, 10n * E18))).toEqual([]); // full close is exempt
    expect(run({ orderType: TAKE_PROFIT, isLong: false, size: E18, triggerPrice: 3500n * E18, maxSlippageBp: 100n })).toEqual(["OrderManagementLib__NoPositionForTpSl"]);
    expect(run({ orderType: TAKE_PROFIT, isLong: true, size: E18, triggerPrice: 3500n * E18, maxSlippageBp: 100n }, long(E18, 3000n * E18, 500n * E18))).toEqual([
      "OrderManagementLib__TpSlMustBeOppositeDirection",
    ]);
    expect(run({ orderType: STOP_LIMIT, isLong: true, size: E18, triggerPrice: 3100n * E18, limitPrice: 3050n * E18 })).toEqual(["OrderManagementLib__StopLimitPriceOnWrongSide"]);
    expect(run({ isLong: true, size: E18, maxSlippageBp: 100n, isPostOnly: true })).toEqual(["OrderManagementLib__PostOnlyNotAllowed"]);
    expect(run({ orderType: OrderType.Limit, isLong: true, size: E18, limitPrice: 3000n * E18, tif: 1, isPostOnly: true })).toEqual(["OrderManagementLib__InvalidTimeInForce"]);
    const m = simulateOrder({ ...base, bucket: flat(100n * E18), order: { isLong: true, size: E18, maxSlippageBp: 100n } }).blockers[0]!;
    expect(m.error).toBe("OrderManagementLib__InsufficientMarginAfterOrder");
    expect(m.message).toContain("$303.00");
  });

  it("refuses a market order on a closed session market", () => {
    const r = simulateOrder({ ...base, continuous: false, stale: true, bucket: flat(1000n * E18), order: { isLong: true, size: E18, maxSlippageBp: 100n } });
    expect(r.blockers.map((b) => b.error)).toContain("MatchingEngineLib__BlockedOracleStale");
    expect(r.margin.retainedFloorBp).toBe(1000n); // markets with trading hours keep initial margin as cash
  });

  it("previews a take-profit at its trigger, capped at the position", () => {
    const r = simulateOrder({
      ...base,
      integrator: ZERO_ADDRESS,
      bucket: long(2n * E18, 6000n * E18, 500n * E18),
      order: { orderType: TAKE_PROFIT, isLong: false, size: 2n ** 256n - 1n, triggerPrice: 3500n * E18, maxSlippageBp: 100n },
    });
    expect(r.triggersNow).toBe(false);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ price: 3500n * E18, size: 2n * E18, assumed: true });
    expect(r.fees.insurance).toBe(usd(0.525)); // $7000 closing at 0.75 bp
    expect(r.realizedPnl).toBe(1000n * E18);
    expect(r.after.size).toBe(0n);
    expect(r.closes).toBe(true);
    expect(r.margin.requiredCollateral).toBe(0n);
  });

  it("rejects malformed input", () => {
    expect(() => simulateOrder({ ...base, bucket: flat(0n), order: { isLong: true, size: 0n } })).toThrow(/size/);
    expect(() => simulateOrder({ ...base, bucket: flat(0n), order: { isLong: true, size: E18, orderType: 9 } })).toThrow(/orderType/);
  });
});

// =====================================================================================================
// previewOrder / previewWithdrawal against a fake chain
// =====================================================================================================

type Impl = (args: readonly unknown[]) => readonly unknown[];

class FakeChain implements Transport {
  readonly handlers = new Map<string, { codec: ContractCodec; fn: string; impl: Impl }>();
  readonly seen: { to: string; fn: string; args: readonly unknown[] }[] = [];
  block = { number: 1_000, timestamp: 1_700_000_000 };

  on(codec: ContractCodec, to: Address, fn: string, impl: Impl): this {
    this.handlers.set(`${to.toLowerCase()}:${codec.selector(fn)}`, { codec, fn, impl });
    return this;
  }

  async request({ method, params = [] }: RequestArgs): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return "0xa4b1";
      case "eth_getBlockByNumber":
        return { number: toHex(this.block.number), timestamp: toHex(this.block.timestamp), hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), baseFeePerGas: "0x1" };
      case "eth_getCode":
        return "0x";
      case "eth_call": {
        if (params.length > 2) throw { code: -32602, message: "state overrides are not supported" };
        const tx = params[0] as { to: string; data: Hex };
        const h = this.handlers.get(`${tx.to.toLowerCase()}:${tx.data.slice(0, 10)}`);
        if (!h) throw { code: 3, message: "execution reverted", data: "0x" };
        const spec = h.codec.fn(h.fn);
        const args = spec.inputs.length ? decodeAbiParameters(spec.inputs, ("0x" + tx.data.slice(10)) as Hex) : [];
        this.seen.push({ to: tx.to, fn: h.fn, args });
        return encodeAbiParameters(spec.outputs, h.impl(args) as unknown[]);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

interface FakeOrder {
  creator: Address;
  isLong: boolean;
  limitPrice: bigint;
  size: bigint;
  filled?: bigint;
  expiry?: bigint;
  orderType?: number;
  triggerPrice?: bigint;
  inBook?: boolean;
}

function fakePair(opts: {
  bucket: Bucket;
  continuous?: boolean;
  adlPending?: boolean;
  adlTerminationTs?: bigint;
  ledger?: bigint;
  asks?: [bigint, FakeOrder][];
  bids?: [bigint, FakeOrder][];
  resting?: [bigint, FakeOrder][];
  coverage?: bigint;
  target?: bigint;
  maxWithdrawable?: bigint;
  stored?: { spot: bigint; low: bigint; high: bigint };
}) {
  const fake = new FakeChain();
  const P = pairCodec();
  const L = lensCodec();
  const stored = opts.stored ?? { spot: 3000n * E18, low: 2990n * E18, high: 3010n * E18 };
  const inv = { size: 0n, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs: 0n };
  const allOrders = new Map<bigint, FakeOrder>([...(opts.asks ?? []), ...(opts.bids ?? []), ...(opts.resting ?? [])]);
  const b = opts.bucket;
  fake
    .on(P, PAIR, "marginRequirements", () => [1000n, 500n, 1_699_999_000n, 0n])
    .on(P, PAIR, "getLaggedMmr", () => [0n])
    .on(P, PAIR, "currentFundingIndex", () => [0n])
    .on(P, PAIR, "lastPairPrice", () => [stored.spot, 0n, 1_699_999_990n, stored.low, stored.high])
    .on(P, PAIR, "isContinuouslyTraded", () => [opts.continuous ?? true])
    .on(P, PAIR, "isAdlPending", () => [opts.adlPending ?? false])
    .on(P, PAIR, "isPairTerminated", () => [false])
    .on(P, PAIR, "settlementPriceFixedTs", () => [0n])
    .on(P, PAIR, "scheduledTerminationTs", () => [0n])
    .on(P, PAIR, "pairVault", () => [0n, 0n, 0n, 0n, opts.ledger ?? 1_000_000n * E18, 50_000n * E18, 0n, 200n, 0n, 0n, inv, inv])
    .on(P, PAIR, "orders", ([id]) => {
      const o = allOrders.get(id as bigint)!;
      return [o.creator, 0n, o.orderType ?? OrderType.Limit, o.isLong, false, 0, ZERO_ADDRESS, o.expiry ?? 10_000n, o.inBook ?? true, 0, o.triggerPrice ?? 0n, o.limitPrice, o.size, o.filled ?? 0n, 1, 0n, 0, 0, 0, 0];
    })
    .on(L, LENS, "getPositionBucket", () => [{ ...b, takeProfitOrderId: 0n, stopLossOrderId: 0n }])
    .on(L, LENS, "getUserActiveLimitOrders", () => [(opts.resting ?? []).map(([id]) => id), BigInt((opts.resting ?? []).length), 0n, 0n])
    .on(L, LENS, "adlTerminationTs", () => [opts.adlTerminationTs ?? 0n])
    .on(L, LENS, "getBookDepth", ([, isLong]) => {
      const side = isLong ? (opts.bids ?? []) : (opts.asks ?? []);
      return [side.map(([id]) => id), side.map(([, o]) => o.limitPrice), 0n];
    })
    .on(L, LENS, "checkBucketSolvency", ([, , price]) => {
      const s = bucketState(b.isLong, b.size, b.entryValue, b.collateral, b.entryFundingIndex, price as bigint, 0n, 500n);
      return [{ ...s, adjustedSize: b.size, entryValue: b.entryValue, effectiveCollateral: b.collateral, adjustedEntryFundingIndex: b.entryFundingIndex }];
    })
    .on(L, LENS, "getInsuranceWithdrawalBudget", () => [0n, 0n, 0n, opts.coverage ?? 300n, opts.target ?? 200n])
    .on(L, LENS, "getMaxWithdrawable", () => [opts.maxWithdrawable ?? 0n]);
  const ctx: BazaarContext = {
    chain: new Chain(fake),
    chainId: 42161,
    factory: getAddress("0x00000000000000000000000000000000000000f1"),
    lens: LENS,
    terminator: getAddress("0x00000000000000000000000000000000000000f2"),
    oracle: getAddress("0x00000000000000000000000000000000000000f3"),
    usdc: getAddress("0x00000000000000000000000000000000000000f4"),
    prices: null,
    subgraph: null,
    integrator: INTEGRATOR,
  };
  return { fake, ctx };
}

describe("previewOrder", () => {
  it("reads the pair, the book and the fund, and previews a market buy", async () => {
    const { ctx, fake } = fakePair({
      bucket: flat(1000n * E18),
      asks: [
        [11n, { creator: BOB, isLong: false, limitPrice: 3000n * E18, size: 2n * E18, filled: E18 }],
        [12n, { creator: CAROL, isLong: false, limitPrice: 3010n * E18, size: 5n * E18 }],
      ],
      coverage: 100n,
      target: 200n,
    });
    const r = await previewOrder(ctx, PAIR, ALICE, { orderType: OrderType.Market, isLong: true, size: 2n * E18, maxSlippageBp: 100n });
    expect(r.feeRates).toMatchObject({ takerEbp: 993n, closingEbp: 75n, coverageRatioBp: 100n, targetRatioBp: 200n });
    expect(r.fills.map((f) => [f.size, f.price])).toEqual([
      [E18, 3000n * E18],
      [E18, 3010n * E18],
    ]);
    expect(r.fees.total).toBe(usd(3.054) + usd(2.98893) + usd(0.07525));
    expect(r.mark).toBe(3000n * E18);
    expect(r.blockers).toEqual([]);
    expect(r.venueClosed).toBe(false);
    expect(fake.seen.find((c) => c.fn === "getBookDepth")!.args).toEqual([PAIR, false, 0n, 33n]); // the asks, one past the step cap
    expect(fake.seen.find((c) => c.fn === "checkBucketSolvency")!.args[2]).toBe(3000n * E18);
  });

  it("reports a halted market and reserves resting orders", async () => {
    const { ctx } = fakePair({
      bucket: flat(400n * E18),
      adlPending: true,
      adlTerminationTs: 1_700_086_400n,
      resting: [[7n, { creator: ALICE, isLong: true, limitPrice: 2900n * E18, size: E18 }]],
    });
    const r = await previewOrder(ctx, PAIR, ALICE, { orderType: OrderType.Limit, isLong: true, size: E18, limitPrice: 2950n * E18 }, { walkBook: false });
    expect(r.blockers[0]).toMatchObject({ error: "BazaarPair__TradingHalted", until: 1_700_086_400 });
    // 10% IMR on the new bid and the resting bid, both at the $3000 mark, plus both maker fees (the new
    // order carries the context's integrator: 0.5 bp of $2950; the resting one none: 0.25 bp of $2900)
    expect(r.margin.requiredCollateral).toBe(600n * E18 + usd(0.1475) + usd(0.0725));
    expect(r.blockers.map((b) => b.error)).toContain("OrderManagementLib__InsufficientMarginAfterOrder");
    expect(r.restingSize).toBe(E18);
  });

  it("flags a closed venue from the live price's publish time", async () => {
    const { ctx } = fakePair({ bucket: flat(1000n * E18), continuous: false });
    const r = await previewOrder(ctx, PAIR, ALICE, { isLong: true, size: E18, maxSlippageBp: 100n }, { price: { spot: 3000n * E18, publishTime: 1_699_990_000 } });
    expect(r.venueClosed).toBe(true);
    expect(r.blockers.map((b) => b.error)).toContain("MatchingEngineLib__BlockedOracleStale");
  });
});

describe("previewWithdrawal", () => {
  it("freezes a position holder while ADL is pending", async () => {
    const { ctx } = fakePair({ bucket: long(E18, 3000n * E18, 500n * E18), adlPending: true, adlTerminationTs: 1_700_086_400n });
    const w = await previewWithdrawal(ctx, PAIR, ALICE, 100n * E18);
    expect(w.freezes.map((f) => f.error)).toEqual(["BazaarPair__WithdrawalsFrozenAdlPending"]);
    expect(w.freezes[0]!.until).toBe(1_700_086_400);
    expect(w.ok).toBe(false);
    expect(w.blocker!.message).toMatch(/auto-deleveraging/);
  });

  it("values a long at the low edge of the band and names the binding ceiling", async () => {
    const { ctx, fake } = fakePair({ bucket: long(E18, 3000n * E18, 500n * E18), maxWithdrawable: 190n * E18 });
    const w = await previewWithdrawal(ctx, PAIR, ALICE, 400n * E18);
    expect(fake.seen.find((c) => c.fn === "getMaxWithdrawable")!.args[2]).toBe(2990n * E18);
    expect(w.priceUsed).toBe(2990n * E18);
    expect(w.maxWithdrawable).toBe(190n * E18);
    // 24/7: keep 5% of $2990 as cash ($149.50): $400 would leave $100
    expect(w.blocker).toMatchObject({ error: "CollateralLib__MustRetainMinimumCollateral", args: { remaining: 100n * E18, minimum: usd(149.5) } });
    expect((await previewWithdrawal(ctx, PAIR, ALICE, 190n * E18)).ok).toBe(true);
  });

  it("explains a deposits ledger short of the request", async () => {
    const { ctx } = fakePair({ bucket: flat(200n * E18), ledger: 150n * E18, maxWithdrawable: 150n * E18 });
    const w = await previewWithdrawal(ctx, PAIR, ALICE, 200n * E18);
    expect(w.blocker).toMatchObject({ error: "CollateralLib__LedgerShortfall", args: { amount: 200n * E18, available: 150n * E18 } });
    expect(w.blocker!.message).toContain("$150.00 right now");
    expect(w.priceUsed).toBeNull();
  });

  it("needs a fresh price for a position on a closed session market", async () => {
    const { ctx } = fakePair({ bucket: short(E18, 3000n * E18, 500n * E18), continuous: false, maxWithdrawable: 0n });
    const w = await previewWithdrawal(ctx, PAIR, ALICE, undefined, { price: { spot: 3000n * E18, publishTime: 1_699_000_000 } });
    expect(w.venueClosed).toBe(true);
    expect(w.freezes.map((f) => f.error)).toEqual(["CollateralLib__WithdrawalRequiresFreshPrice"]);
    expect(w.ok).toBeNull();
  });
});
