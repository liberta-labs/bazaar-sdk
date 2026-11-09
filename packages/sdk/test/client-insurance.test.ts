import { type Abi, type Hex, decodeFunctionData, getAddress, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bazaarPairAbi } from "../src/abi/index.js";
import { InputError } from "../src/client/calls.js";
import {
  INSURANCE_WITHDRAWAL_COOLDOWN,
  INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS,
  INSURANCE_WITHDRAWAL_WINDOW_SESSION,
  claimOpensAt,
  depositToInsurance,
  executeInsuranceWithdrawal,
  getInsuranceWithdrawalBudget,
  getInsuranceWithdrawalLock,
  insuranceExitPlan,
  quoteInsuranceDeposit,
  quoteInsuranceWithdrawal,
  requestInsuranceWithdrawal,
} from "../src/client/insurance.js";
import { encodeRelayed, signRelayed } from "../src/client/relay.js";
import { pairPrice } from "../src/formulas/index.js";
import { FEED, PAIR, alice, fakeContext, mockUpdate } from "./client-writes-fake.js";

const E18 = 10n ** 18n;
const DAY = 86_400;
const pairAbi = bazaarPairAbi as unknown as Abi;

// Gasless deadlines are checked against this device's clock: run it at the fake chain's time.
beforeEach(() => {
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});
const inv = (size = 0n) => ({ size, entryNotional: 0n, bankruptcyNotional: 0n, seized: 0n, entryFundingIndex: 0n, seizedTs: 0n });
const vault = (o: { oi?: bigint; inventory?: bigint } = {}) => ({
  totalLongOI: o.oi ?? 0n,
  totalShortOI: 0n,
  longWeightedEntrySum: 0n,
  shortWeightedEntrySum: 0n,
  totalCollateralDeposited: 0n,
  insuranceFundBalance: 10_000n * E18,
  deficit: 0n,
  targetInsuranceRatioBp: 200n,
  ledgerArrears: 0n,
  trailingOiSize: 0n,
  longInv: inv(o.inventory ?? 0n),
  shortInv: inv(),
});

async function rejectsInput(p: Promise<unknown>): Promise<InputError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected an InputError");
}

interface LpState {
  shares?: bigint;
  requestTs?: number;
  requested?: bigint;
  terminated?: boolean;
  continuous?: boolean;
  scheduled?: number;
  fixedTs?: number;
  storedTs?: number;
  lastGap?: number;
  lastJump?: number;
  oi?: bigint;
  inventory?: bigint;
  adl?: boolean;
  lock?: { lockedAmount: bigint; lockTs: number; claimOpensTs: number } | null;
  voting?: bigint;
  /** The pair's share epoch (default 1). */
  epoch?: number;
  /** The share epoch the request was stamped in (default: the pair's). */
  requestEpoch?: number;
}

function lp(fake: ReturnType<typeof fakeContext>["fake"], s: LpState) {
  const continuous = s.continuous ?? true;
  const requestTs = s.requestTs ?? 0;
  const epoch = BigInt(s.epoch ?? 1);
  // the request is stamped `shareEpoch << 64 | timestamp`
  fake.pair("insuranceShares", s.shares ?? 0n);
  fake.pair("insuranceWithdrawalRequestTs", requestTs ? (BigInt(s.requestEpoch ?? s.epoch ?? 1) << 64n) | BigInt(requestTs) : 0n);
  fake.pair("insuranceWithdrawalRequestShareAmount", s.requested ?? 0n);
  fake.pair("isPairTerminated", s.terminated ?? false);
  fake.pair("isContinuouslyTraded", continuous);
  fake.pair("scheduledTerminationTs", BigInt(s.scheduled ?? 0));
  fake.pair("settlementPriceFixedTs", BigInt(s.fixedTs ?? 0));
  fake.pair("lastPairPrice", { spotPrice: 2000n * E18, emaVarianceBp: 0n, updateTs: BigInt(s.storedTs ?? fake.timestamp - 10), lowPrice: 0n, highPrice: 0n });
  fake.pair("extsload", ([slot]: readonly [Hex]) => {
    if (slot === toHex(95n, { size: 32 })) return toHex(epoch, { size: 32 }); // shareEpoch
    expect(slot).toBe(toHex(107n, { size: 32 }));
    return toHex((BigInt(s.lastJump ?? 0) << 192n) | BigInt(s.lastGap ?? 0), { size: 32 });
  });
  fake.pair("pairVault", vault({ ...(s.oi !== undefined ? { oi: s.oi } : {}), ...(s.inventory !== undefined ? { inventory: s.inventory } : {}) }));
  fake.pair("isAdlPending", s.adl ?? false);
  const windowEndTs = requestTs ? requestTs + INSURANCE_WITHDRAWAL_COOLDOWN + (continuous ? INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS : INSURANCE_WITHDRAWAL_WINDOW_SESSION) : 0;
  fake.lens(
    "getInsuranceWithdrawalLock",
    s.lock
      ? { isLocked: true, lockedAmount: s.lock.lockedAmount, lockTs: BigInt(s.lock.lockTs), claimOpensTs: BigInt(s.lock.claimOpensTs), windowEndTs: BigInt(windowEndTs) }
      : { isLocked: false, lockedAmount: 0n, lockTs: 0n, claimOpensTs: 0n, windowEndTs: BigInt(windowEndTs) },
  );
  fake.terminator("getLockedShares", s.voting ?? 0n);
  fake.lens("quoteInsuranceWithdrawal", ([, shares, price]: readonly [unknown, bigint, bigint]) => (shares * price) / (2000n * E18));
  fake.lens("getInsuranceWithdrawalBudget", { remaining: 50n * E18, cap: 100n * E18, resetsAt: BigInt(fake.timestamp + 3600), coverageRatioBp: 500n, targetRatioBp: 200n });
}

describe("insurance writes", () => {
  function pairState(fake: ReturnType<typeof fakeContext>["fake"], o: { adl?: boolean; terminated?: boolean; scheduled?: number; fixedTs?: number; inventory?: bigint } = {}) {
    fake.pair("isAdlPending", o.adl ?? false);
    fake.pair("isPairTerminated", o.terminated ?? false);
    fake.pair("scheduledTerminationTs", BigInt(o.scheduled ?? 0));
    fake.pair("settlementPriceFixedTs", BigInt(o.fixedTs ?? 0));
    fake.pair("pairVault", vault({ ...(o.inventory !== undefined ? { inventory: o.inventory } : {}) }));
  }

  it("deposits: floors to micro-USDC, attaches the price, reports the pull", async () => {
    const { fake, ctx } = fakeContext();
    pairState(fake);
    const call = await depositToInsurance(ctx, PAIR, alice.address, 50n * E18 + 999n, { permitData: "0xbeef" });
    const [amount, update, nonce, deadline, fee, sig, permit] = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(amount).toBe(50n * E18);
    expect(update).toEqual([mockUpdate(FEED, 2000_00000000n, fake.timestamp)]);
    expect([nonce, deadline, fee, sig, permit]).toEqual([0n, 0n, 0n, "0x", "0xbeef"]);
    expect(call).toMatchObject({ value: 7n, pullsUsdc: 50n * E18, priceTime: fake.timestamp });
  });

  it("refuses a deposit the pair would refuse", async () => {
    const { fake, ctx } = fakeContext();
    pairState(fake);
    expect((await rejectsInput(depositToInsurance(ctx, PAIR, alice.address, 4n * E18))).field).toBe("amount");
    pairState(fake, { adl: true });
    expect((await rejectsInput(depositToInsurance(ctx, PAIR, alice.address, 10n * E18))).message).toMatch(/deleveraging/);
    pairState(fake, { terminated: true });
    expect((await rejectsInput(depositToInsurance(ctx, PAIR, alice.address, 10n * E18))).message).toMatch(/terminated/);
    pairState(fake, { scheduled: fake.timestamp + 6 });
    expect((await rejectsInput(depositToInsurance(ctx, PAIR, alice.address, 10n * E18))).message).toMatch(/closing/);
    pairState(fake, { fixedTs: 5 });
    expect((await rejectsInput(depositToInsurance(ctx, PAIR, alice.address, 10n * E18))).message).toMatch(/settling/);
  });

  it("deposits without a price source only while the vault holds no inventory", async () => {
    const { fake, ctx } = fakeContext({ prices: null });
    pairState(fake);
    const call = await depositToInsurance(ctx, PAIR, alice.address, 10n * E18);
    expect((decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[])[1]).toEqual([]);
    expect(call.value).toBe(0n);
    pairState(fake, { inventory: E18 });
    await expect(depositToInsurance(ctx, PAIR, alice.address, 10n * E18)).rejects.toThrow(/price source/);
  });

  it("requests a withdrawal of shares the LP holds", async () => {
    const { fake, ctx } = fakeContext();
    lp(fake, { shares: 100n * E18 });
    const call = await requestInsuranceWithdrawal(ctx, PAIR, alice.address, 40n * E18);
    expect(decodeFunctionData({ abi: pairAbi, data: call.data }).args).toEqual([40n * E18, 0n, 0n, 0n, "0x", "0x"]);
    expect(call.summary).toMatch(/13-day cooldown, then a 2-day window/);
    expect((await rejectsInput(requestInsuranceWithdrawal(ctx, PAIR, alice.address, 101n * E18))).field).toBe("shareAmount");
    expect((await rejectsInput(requestInsuranceWithdrawal(ctx, PAIR, alice.address, 0n))).field).toBe("shareAmount");
    lp(fake, { shares: 100n * E18, requestTs: fake.timestamp - DAY, requested: E18 });
    expect((await requestInsuranceWithdrawal(ctx, PAIR, alice.address, E18)).summary).toMatch(/Replace/);
  });
});

describe("quotes at the live price", () => {
  it("prices a deposit at the composed live price, and a redemption at a given one", async () => {
    const { fake, ctx, prices } = fakeContext();
    const base = ("0x" + "01".repeat(32)) as Hex;
    const quote = ("0x" + "02".repeat(32)) as Hex;
    fake.oracle("composites", { baseId: base, quoteId: quote, invertQuote: false });
    prices!.set(base, 2_500_000_000n).set(quote, 80_000_000n);
    fake.lens("quoteInsuranceDeposit", ([, amount, price]: readonly [unknown, bigint, bigint]) => amount + price);
    const q = await quoteInsuranceDeposit(ctx, PAIR, 10n * E18 + 5n);
    const want = pairPrice(
      [
        { price: 2_500_000_000n, conf: 0n, expo: -8, publishTime: fake.timestamp },
        { price: 80_000_000n, conf: 0n, expo: -8, publishTime: fake.timestamp },
      ],
      false,
    )!.spot;
    expect(want).toBe(20n * E18);
    expect(q).toEqual({ value: 10n * E18 + want, price: want, publishTime: fake.timestamp });

    fake.lens("quoteInsuranceWithdrawal", ([, shares, price]: readonly [unknown, bigint, bigint]) => shares * 2n + price);
    const calls = prices!.calls;
    expect(await quoteInsuranceWithdrawal(ctx, PAIR, 3n, { price: 5n })).toEqual({ value: 11n, price: 5n, publishTime: null });
    expect(prices!.calls).toBe(calls);
  });

  it("reads the budget and the lock", async () => {
    const { fake, ctx } = fakeContext();
    const max = (1n << 256n) - 1n;
    fake.lens("getInsuranceWithdrawalBudget", { remaining: max, cap: max, resetsAt: max, coverageRatioBp: 0n, targetRatioBp: 200n });
    expect(await getInsuranceWithdrawalBudget(ctx, PAIR, { price: E18 })).toMatchObject({ unlimited: true, resetsAt: null });
    fake.lens("getInsuranceWithdrawalLock", { isLocked: true, lockedAmount: 7n, lockTs: 10n, claimOpensTs: 310n, windowEndTs: 999n });
    expect(await getInsuranceWithdrawalLock(ctx, PAIR, alice.address)).toEqual({ isLocked: true, lockedAmount: 7n, lockTs: 10, claimOpensTs: 310, windowEndTs: 999 });
  });
});

describe("claimOpensAt", () => {
  it("is InsuranceVaultLib.claimOpensAt", () => {
    const t = 1_000_000;
    expect(claimOpensAt(t, 0, 0)).toBe(t + 300);
    expect(claimOpensAt(t, 0, t + 200)).toBe(t + 500);
    expect(claimOpensAt(t, t - 100, 0)).toBe(t + 1700);
    expect(claimOpensAt(100, 0, 0)).toBe(1800); // as the contract: lastGapTs 0 still counts

  });
});

describe("insuranceExitPlan", () => {
  const T = 1_700_000_000;
  const plan = async (s: LpState, quote = false) => {
    const { fake, ctx } = fakeContext();
    lp(fake, s);
    return insuranceExitPlan(ctx, PAIR, alice.address, { quote });
  };

  it("walks the steps of an exit on a live pair", async () => {
    expect((await plan({})).step).toBe("none");
    expect(await plan({ shares: E18 })).toMatchObject({ step: "request", nextAction: "requestInsuranceWithdrawal", nextCallAt: T });

    const req = T - DAY;
    const opens = req + INSURANCE_WITHDRAWAL_COOLDOWN;
    const end = opens + INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS;
    expect(await plan({ shares: E18, requestTs: req, requested: E18 })).toMatchObject({
      step: "cooldown",
      nextAction: "executeInsuranceWithdrawal",
      nextCallAt: opens,
      nextCallBy: end - 300,
      requestTs: req,
      windowOpensTs: opens,
      windowEndTs: end,
    });

    const r2 = T - INSURANCE_WITHDRAWAL_COOLDOWN - 3600;
    const end2 = r2 + INSURANCE_WITHDRAWAL_COOLDOWN + INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS;
    expect(await plan({ shares: E18, requestTs: r2, requested: E18 })).toMatchObject({ step: "lock", nextCallAt: T, nextCallBy: end2 - 300, claimOpensTs: T + 300 });
    // a stored price an hour old: the paying call's store will end a gap, so the claim waits 30 min
    expect((await plan({ shares: E18, requestTs: r2, requested: E18, storedTs: T - 3601 })).claimOpensTs).toBe(T + 1800);
    expect((await plan({ shares: E18, requestTs: r2, requested: E18, lastGap: T - 100, lastJump: T - 100 })).claimOpensTs).toBe(T + 1700);

    const lock = { lockedAmount: 900n * E18, lockTs: T - 100 };
    expect(await plan({ shares: E18, requestTs: r2, requested: E18, lock: { ...lock, claimOpensTs: T + 200 } })).toMatchObject({ step: "waitClaim", nextCallAt: T + 200, nextCallBy: end2, lockedAmount: 900n * E18 });
    expect(await plan({ shares: E18, requestTs: r2, requested: E18, lock: { ...lock, claimOpensTs: T - 1 } })).toMatchObject({ step: "claim", nextCallAt: T, nextCallBy: end2 });
  });

  it("estimates the payout as the lower of the lock and the live value, with the budget", async () => {
    const r2 = T - INSURANCE_WITHDRAWAL_COOLDOWN - 3600;
    const p = await plan({ shares: 2n * E18, requestTs: r2, requested: 2n * E18, lock: { lockedAmount: E18, lockTs: T - 400, claimOpensTs: T - 100 } }, true);
    expect(p).toMatchObject({ step: "claim", payoutEstimate: E18, budgetRemaining: 50n * E18 });
    const p2 = await plan({ shares: 2n * E18, requestTs: r2, requested: 2n * E18, lock: { lockedAmount: 9n * E18, lockTs: T - 400, claimOpensTs: T - 100 } }, true);
    expect(p2.payoutEstimate).toBe(2n * E18);
  });

  it("knows when a request has lapsed or cannot be locked in time", async () => {
    const lapsed = T - INSURANCE_WITHDRAWAL_COOLDOWN - INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS - 1;
    expect(await plan({ shares: E18, requestTs: lapsed, requested: E18 })).toMatchObject({ step: "expired", nextAction: "requestInsuranceWithdrawal" });
    const tight = T - INSURANCE_WITHDRAWAL_COOLDOWN - INSURANCE_WITHDRAWAL_WINDOW_CONTINUOUS + 100;
    expect((await plan({ shares: E18, requestTs: tight, requested: E18 })).step).toBe("expired");
  });

  it("gives a session pair its 4-day window and a trading-hours note", async () => {
    const p = await plan({ shares: E18, requestTs: T - DAY, requested: E18, continuous: false });
    expect(p.windowEndTs).toBe(T - DAY + INSURANCE_WITHDRAWAL_COOLDOWN + INSURANCE_WITHDRAWAL_WINDOW_SESSION);
    expect(p.notes.join(" ")).toMatch(/venue trades/);
  });

  it("knows what freezes exits", async () => {
    expect((await plan({ shares: E18, requestTs: T - DAY, requested: E18, fixedTs: T - 5 })).step).toBe("blocked");
    expect((await plan({ shares: E18, requestTs: T - DAY, requested: E18, scheduled: T + 6 })).step).toBe("blocked");
    const r2 = T - INSURANCE_WITHDRAWAL_COOLDOWN - 3600;
    const voted = await plan({ shares: E18, requestTs: r2, requested: E18, voting: E18 / 2n, lock: { lockedAmount: E18, lockTs: T - 400, claimOpensTs: T - 100 } });
    expect(voted.step).toBe("blocked");
    expect(voted.message).toMatch(/insurer vote/);
  });

  it("redeems at once on a terminated pair, once the sweep allows", async () => {
    expect(await plan({ shares: E18, terminated: true })).toMatchObject({ step: "request", nextAction: "requestInsuranceWithdrawal" });
    expect(await plan({ shares: E18, terminated: true, requestTs: T - 10, requested: E18 })).toMatchObject({ step: "redeem", nextCallAt: T });
    const fixedTs = T - DAY;
    expect(await plan({ shares: E18, terminated: true, requestTs: T - 10, requested: E18, oi: E18, fixedTs })).toMatchObject({ step: "blocked", nextCallAt: fixedTs + 28 * DAY });
  });
});

describe("executeInsuranceWithdrawal", () => {
  it("builds the lock with a fresh price, and refuses during the cooldown", async () => {
    const { fake, ctx } = fakeContext();
    lp(fake, { shares: E18, requestTs: fake.timestamp - DAY, requested: E18 });
    expect((await rejectsInput(executeInsuranceWithdrawal(ctx, PAIR, alice.address))).message).toMatch(/cooldown ends in 12 d/);
    lp(fake, { shares: E18, requestTs: fake.timestamp - INSURANCE_WITHDRAWAL_COOLDOWN - 60, requested: E18 });
    const call = await executeInsuranceWithdrawal(ctx, PAIR, alice.address);
    const [update, ...rest] = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(update).toHaveLength(1);
    expect(rest).toEqual([0n, 0n, 0n, "0x", "0x"]);
    expect(call.summary).toMatch(/^Lock/);
    expect(call.value).toBe(7n);
  });

  it("redeems on a terminated pair without a price", async () => {
    const { fake, ctx } = fakeContext();
    lp(fake, { shares: E18, terminated: true, requestTs: fake.timestamp - 10, requested: E18 });
    const call = await executeInsuranceWithdrawal(ctx, PAIR, alice.address);
    expect((decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[])[0]).toEqual([]);
    expect(call.value).toBe(0n);
  });

  it("relays a lock with its fee pulled from the wallet, and a claim with it netted", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("metaTxNonces", 0n);
    lp(fake, { shares: E18, requestTs: fake.timestamp - INSURANCE_WITHDRAWAL_COOLDOWN - 60, requested: E18 });
    const req = await signRelayed(ctx, { action: "executeInsuranceWithdrawal" }, { wallet: fake, signer: alice.address, pair: PAIR, relayerFee: E18 / 5n });
    expect((await encodeRelayed(ctx, req)).pullsUsdc).toBe(E18 / 5n);
    lp(fake, { shares: E18, requestTs: fake.timestamp - INSURANCE_WITHDRAWAL_COOLDOWN - 600, requested: E18, lock: { lockedAmount: E18, lockTs: fake.timestamp - 400, claimOpensTs: fake.timestamp - 100 } });
    expect((await encodeRelayed(ctx, req)).pullsUsdc).toBe(0n);
  });
});

describe("a request stamped in an earlier share epoch (voided by a fund recap)", () => {
  const T = 1_700_000_000;
  const ripe = T - INSURANCE_WITHDRAWAL_COOLDOWN - 3600; // in its window, were it live

  it("is no request: the plan says request again, execute is refused, and a new request is not a replacement", async () => {
    const { fake, ctx } = fakeContext();
    lp(fake, { shares: E18, requestTs: ripe, requested: E18, epoch: 2, requestEpoch: 1 });
    const p = await insuranceExitPlan(ctx, PAIR, alice.address, { quote: false });
    expect(p).toMatchObject({ step: "request", nextAction: "requestInsuranceWithdrawal", requestTs: null, requestedShares: 0n, windowOpensTs: null });
    expect(p.message).toMatch(/voided when the insurance fund was recapitalized/);
    expect((await rejectsInput(executeInsuranceWithdrawal(ctx, PAIR, alice.address))).message).toMatch(/voided/);
    expect((await requestInsuranceWithdrawal(ctx, PAIR, alice.address, E18)).summary).toMatch(/^Request to withdraw/);
    // the same request stamped in the current epoch is live
    lp(fake, { shares: E18, requestTs: ripe, requested: E18, epoch: 2 });
    expect((await insuranceExitPlan(ctx, PAIR, alice.address, { quote: false })).step).toBe("lock");
    expect((await requestInsuranceWithdrawal(ctx, PAIR, alice.address, E18)).summary).toMatch(/^Replace/);
  });

  it("is voided on a terminated pair too, and with no shares left reads as none", async () => {
    const { fake, ctx } = fakeContext();
    lp(fake, { shares: E18, terminated: true, requestTs: T - 10, requested: E18, epoch: 3, requestEpoch: 2 });
    expect(await insuranceExitPlan(ctx, PAIR, alice.address, { quote: false })).toMatchObject({ step: "request", nextAction: "requestInsuranceWithdrawal" });
    lp(fake, { shares: 0n, requestTs: ripe, requested: E18, epoch: 1, requestEpoch: 0 });
    const p = await insuranceExitPlan(ctx, PAIR, alice.address, { quote: false });
    expect(p.step).toBe("none");
    expect(p.message).toMatch(/voided/);
  });
});

describe("the pair guard on insurance writes", () => {
  it("refuses an address the factory does not know, reading nothing from it", async () => {
    const { fake, ctx } = fakeContext();
    const other = getAddress("0x000000000000000000000000000000000000dead");
    const builders = [
      () => depositToInsurance(ctx, other, alice.address, 10n * E18),
      () => requestInsuranceWithdrawal(ctx, other, alice.address, E18),
      () => executeInsuranceWithdrawal(ctx, other, alice.address),
    ];
    for (const build of builders) expect((await rejectsInput(build())).field).toBe("pair");
    expect(fake.calls.map((c) => c.fn)).toEqual(["isPair", "isPair", "isPair"]);
  });
});
