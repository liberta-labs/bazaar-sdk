import { type Abi, type Hex, decodeFunctionData, encodePacked, getAddress, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { bazaarPairAbi } from "../src/abi/index.js";
import { ERC20_ABI, approveUsdc, usdcFunding } from "../src/client/allowance.js";
import {
  TRADING_ACCOUNT_ABI,
  decodeTradingAccountResults,
  encodeTradingAccountExecute,
  shareOnePriceUpdate,
  toBatchCalls,
  tradingAccountExecute,
  walletSendCallsRequest,
} from "../src/client/batching.js";
import { InputError } from "../src/client/calls.js";
import {
  AMEND_BEST_EFFORT_BIT,
  CLOSE_POSITION,
  NEVER_EXPIRE_BLOCK,
  type OrderInput,
  TimeInForce,
  amendIdWord,
  bestEffortAmendIdWord,
  buildOrderSpec,
  decodeAmends,
  describeOrder,
  encodeAmends,
  packTriggerPrice,
  unpackAmendIdWord,
  unpackTriggerPrice,
  validateOrderSpec,
} from "../src/client/orders.js";
import {
  amendOrders,
  cancelOrders,
  claimFees,
  createOrder,
  depositCollateral,
  executeTriggeredOrders,
  findPredecessor,
  pairPriceFromUpdate,
  parsePriceUpdate,
  withdrawCollateral,
} from "../src/client/trade.js";
import { LIMIT, MARKET, STOP_LIMIT, STOP_LOSS, TAKE_PROFIT } from "../src/constants.js";
import { pairPrice } from "../src/formulas/index.js";
import { FEED, INTEGRATOR, PAIR, USDC, alice, bob, bucket, fakeContext, mockUpdate, storedOrder } from "./client-writes-fake.js";

const E18 = 10n ** 18n;
const I = INTEGRATOR;
const pairAbi = bazaarPairAbi as unknown as Abi;

/** The InputError a call throws, or fails. */
function inputError(f: () => unknown): InputError {
  try {
    f();
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected an InputError");
}
async function rejectsInput(p: Promise<unknown>): Promise<InputError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected an InputError");
}

const limit = (o: Partial<OrderInput> = {}): OrderInput => ({ orderType: LIMIT, isLong: true, size: E18, limitPrice: 2000n * E18, expirationBlock: 5000, ...o });
const flat = { position: { isLong: false, size: 0n }, activeLimitOrderIds: [], takeProfitOrderId: 0n, stopLossOrderId: 0n };
const longPos = { ...flat, position: { isLong: true, size: E18 } };

describe("buildOrderSpec", () => {
  it("builds a limit order carrying only the fields its type uses", () => {
    const s = buildOrderSpec(limit({ triggerPrice: 5n, maxSlippageBp: 50n, isPostOnly: true }), I, { currentBlock: 1000, price: 2000n * E18 });
    expect(s).toEqual({
      orderType: LIMIT,
      isLong: true,
      isPostOnly: true,
      tif: TimeInForce.GTC,
      size: E18,
      triggerPrice: 0n,
      limitPrice: 2000n * E18,
      maxSlippageBp: 0n,
      expirationBlock: 5000n,
      integrator: I,
    });
  });

  it("packs a trigger order's bounty into the high 128 bits of triggerPrice", () => {
    const bounty = 25n * 10n ** 16n; // $0.25
    const s = buildOrderSpec({ orderType: STOP_LOSS, isLong: false, size: CLOSE_POSITION, triggerPrice: 1900n * E18, bounty, maxSlippageBp: 100n }, I, { account: longPos });
    expect(s.triggerPrice).toBe((bounty << 128n) | (1900n * E18));
    expect(unpackTriggerPrice(s.triggerPrice)).toEqual({ price: 1900n * E18, bounty });
    expect(packTriggerPrice(1900n * E18, bounty)).toBe(s.triggerPrice);
    expect(s.expirationBlock).toBe(NEVER_EXPIRE_BLOCK);
    expect(s.limitPrice).toBe(0n);
    expect(s.size).toBe(CLOSE_POSITION);
  });

  it("zeroes a market order's prices and expiry and bounds its slippage", () => {
    const s = buildOrderSpec({ orderType: MARKET, isLong: true, size: E18, maxSlippageBp: 1000n, limitPrice: 7n, expirationBlock: 9 }, I);
    expect([s.limitPrice, s.triggerPrice, s.expirationBlock, s.maxSlippageBp]).toEqual([0n, 0n, 0n, 1000n]);
    expect(inputError(() => buildOrderSpec({ orderType: MARKET, isLong: true, size: E18, maxSlippageBp: 1001n }, I)).field).toBe("maxSlippageBp");
    expect(inputError(() => buildOrderSpec({ orderType: MARKET, isLong: true, size: E18 }, I)).field).toBe("maxSlippageBp");
    expect(inputError(() => buildOrderSpec({ orderType: TAKE_PROFIT, isLong: false, size: E18, triggerPrice: E18, maxSlippageBp: 0n }, I)).field).toBe("maxSlippageBp");
  });

  it("accepts each time in force only where the pair does", () => {
    expect(buildOrderSpec({ orderType: MARKET, isLong: true, size: E18, maxSlippageBp: 10n, tif: TimeInForce.FOK }, I).tif).toBe(TimeInForce.FOK);
    expect(buildOrderSpec(limit({ tif: TimeInForce.IOC }), I).expirationBlock).toBe(0n);
    expect(inputError(() => buildOrderSpec({ orderType: MARKET, isLong: true, size: E18, maxSlippageBp: 10n, tif: TimeInForce.IOC }, I)).field).toBe("tif");
    expect(inputError(() => buildOrderSpec({ orderType: STOP_LIMIT, isLong: true, size: E18, triggerPrice: E18, limitPrice: E18, tif: TimeInForce.FOK }, I)).field).toBe("tif");
    expect(inputError(() => buildOrderSpec(limit({ tif: TimeInForce.IOC, isPostOnly: true }), I)).field).toBe("isPostOnly");
    expect(inputError(() => buildOrderSpec({ orderType: MARKET, isLong: true, size: E18, maxSlippageBp: 10n, isPostOnly: true }, I)).field).toBe("isPostOnly");
    expect(inputError(() => buildOrderSpec(limit({ tif: 3 as TimeInForce }), I)).field).toBe("tif");
  });

  it("refuses a stop-limit whose limit is on the wrong side of its trigger", () => {
    const sl = (isLong: boolean, limitPrice: bigint) => ({ orderType: STOP_LIMIT, isLong, size: E18, triggerPrice: 2000n * E18, limitPrice, expirationBlock: 5000 }) as const;
    expect(buildOrderSpec(sl(true, 2000n * E18), I).limitPrice).toBe(2000n * E18);
    expect(inputError(() => buildOrderSpec(sl(true, 1999n * E18), I)).field).toBe("limitPrice");
    expect(buildOrderSpec(sl(false, 1999n * E18), I).maxSlippageBp).toBe(0n);
    expect(inputError(() => buildOrderSpec(sl(false, 2001n * E18), I)).field).toBe("limitPrice");
  });

  it("checks the bounty", () => {
    expect(inputError(() => buildOrderSpec(limit({ bounty: E18 }), I)).field).toBe("bounty");
    expect(inputError(() => buildOrderSpec({ orderType: STOP_LOSS, isLong: false, size: E18, triggerPrice: E18, bounty: 10n ** 12n + 1n, maxSlippageBp: 10n }, I)).field).toBe("bounty");
    expect(validateOrderSpec.bind(null, { ...buildOrderSpec(limit(), I), triggerPrice: 1n << 128n })).toThrow(InputError);
  });

  it("holds a limit price to ±50% of the oracle price", () => {
    const env = { price: 2000n * E18 };
    expect(buildOrderSpec(limit({ limitPrice: 1000n * E18 }), I, env).limitPrice).toBe(1000n * E18);
    expect(buildOrderSpec(limit({ limitPrice: 3000n * E18 }), I, env).limitPrice).toBe(3000n * E18);
    expect(inputError(() => buildOrderSpec(limit({ limitPrice: 1000n * E18 - 1n }), I, env)).field).toBe("limitPrice");
    expect(inputError(() => buildOrderSpec(limit({ limitPrice: 3000n * E18 + 1n }), I, env)).field).toBe("limitPrice");
  });

  it("refuses an order worth under $5 unless it closes the whole position", () => {
    const small = limit({ size: 2n * 10n ** 15n }); // 0.002 at 2000 = $4
    expect(inputError(() => buildOrderSpec(small, I, { account: flat })).field).toBe("size");
    const short = { ...flat, position: { isLong: false, size: 2n * 10n ** 15n } };
    expect(buildOrderSpec(small, I, { account: short }).size).toBe(2n * 10n ** 15n);
    // a market order is measured at the oracle price
    const m = { orderType: MARKET, isLong: true, size: 2n * 10n ** 15n, maxSlippageBp: 10n } as const;
    expect(inputError(() => buildOrderSpec(m, I, { price: 2000n * E18 })).field).toBe("size");
    expect(buildOrderSpec(m, I, { price: 3000n * E18 }).size).toBe(2n * 10n ** 15n);
  });

  it("measures a TP/SL on what it can close, and needs an opposite position", () => {
    const tp = (isLong: boolean) => ({ orderType: TAKE_PROFIT, isLong, size: CLOSE_POSITION, triggerPrice: 2100n * E18, maxSlippageBp: 50n }) as const;
    expect(buildOrderSpec(tp(false), I, { account: longPos }).size).toBe(CLOSE_POSITION);
    expect(inputError(() => buildOrderSpec(tp(true), I, { account: longPos })).field).toBe("isLong");
    expect(inputError(() => buildOrderSpec(tp(false), I, { account: flat })).field).toBe("orderType");
    const dust = { ...flat, position: { isLong: true, size: 10n ** 15n } }; // $2.10 at the trigger: a full close
    expect(buildOrderSpec(tp(false), I, { account: dust }).size).toBe(CLOSE_POSITION);
    const part = { orderType: STOP_LOSS, isLong: false, size: 10n ** 15n, triggerPrice: 2000n * E18, maxSlippageBp: 50n } as const;
    expect(inputError(() => buildOrderSpec(part, I, { account: longPos })).field).toBe("size");
  });

  it("needs at least the minimum lifetime plus a landing margin", () => {
    expect(buildOrderSpec(limit({ expirationBlock: 1280 }), I, { currentBlock: 1000 }).expirationBlock).toBe(1280n);
    expect(inputError(() => buildOrderSpec(limit({ expirationBlock: 1279 }), I, { currentBlock: 1000 })).field).toBe("expirationBlock");
    expect(inputError(() => buildOrderSpec({ orderType: LIMIT, isLong: true, size: E18, limitPrice: E18 * 2000n }, I)).field).toBe("expirationBlock");
  });

  it("enforces the per-user caps", () => {
    const full = { ...longPos, activeLimitOrderIds: Array.from({ length: 32 }, (_, i) => BigInt(i + 1)) };
    expect(inputError(() => buildOrderSpec(limit(), I, { account: full })).field).toBe("orderType");
    expect(buildOrderSpec(limit({ tif: TimeInForce.IOC }), I, { account: full }).tif).toBe(TimeInForce.IOC);
    expect(inputError(() => buildOrderSpec({ orderType: STOP_LIMIT, isLong: true, size: E18, triggerPrice: 2000n * E18, limitPrice: 2000n * E18, expirationBlock: 5000 }, I, { account: full })).field).toBe("orderType");
    const tpsl = { ...longPos, takeProfitOrderId: 4n, stopLossOrderId: 5n };
    expect(inputError(() => buildOrderSpec({ orderType: TAKE_PROFIT, isLong: false, size: E18, triggerPrice: 2100n * E18, maxSlippageBp: 50n }, I, { account: tpsl })).message).toMatch(/take-profit/);
    expect(inputError(() => buildOrderSpec({ orderType: STOP_LOSS, isLong: false, size: E18, triggerPrice: 1900n * E18, maxSlippageBp: 50n }, I, { account: tpsl })).message).toMatch(/stop-loss/);
  });

  it("refuses a zero size and an unknown type", () => {
    expect(inputError(() => buildOrderSpec(limit({ size: 0n }), I)).field).toBe("size");
    expect(inputError(() => buildOrderSpec(limit({ orderType: 9 as never }), I)).field).toBe("orderType");
  });
});

describe("amendment words", () => {
  it("packs as BazaarPairLens.amendIdWord / bestEffortAmendIdWord", () => {
    expect(amendIdWord(7n, 3n, 4n)).toBe(7n | (3n << 64n) | (4n << 128n));
    expect(bestEffortAmendIdWord(7n, 3n, 4n)).toBe(7n | (3n << 64n) | (4n << 128n) | (1n << 192n));
    expect(AMEND_BEST_EFFORT_BIT).toBe(1n << 192n);
    expect(unpackAmendIdWord(bestEffortAmendIdWord(9n, 1n))).toEqual({ orderId: 9n, pred: 1n, pred2: 0n, bestEffort: true });
    expect(() => unpackAmendIdWord(1n << 193n)).toThrow(InputError);
    expect(() => amendIdWord(1n << 64n)).toThrow(InputError);
  });

  it("lays a batch out as word triples, 1 to 32 of them", () => {
    const words = encodeAmends([
      { orderId: 5n, limitPrice: 10n, size: 20n, pred: 2n },
      { orderId: 6n, limitPrice: 11n, size: 21n, bestEffort: true },
    ]);
    expect(words).toEqual([amendIdWord(5n, 2n), 10n, 20n, bestEffortAmendIdWord(6n), 11n, 21n]);
    expect(decodeAmends(words)[1]).toEqual({ orderId: 6n, pred: 0n, pred2: 0n, bestEffort: true, limitPrice: 11n, size: 21n });
    expect(() => encodeAmends([])).toThrow(InputError);
    expect(() => encodeAmends(Array.from({ length: 33 }, () => ({ orderId: 1n, limitPrice: 1n, size: 1n })))).toThrow(InputError);
    expect(inputError(() => encodeAmends([{ orderId: 1n, limitPrice: 0n, size: 1n }])).field).toBe("limitPrice");
    expect(() => decodeAmends([1n, 2n])).toThrow(InputError);
  });
});

function stockAccount(fake: ReturnType<typeof fakeContext>["fake"], b = bucket(), active: bigint[] = []) {
  fake.pair("positionBuckets", b);
  fake.lens("getUserActiveLimitOrders", { orderIds: active, count: BigInt(active.length), longExposure: 0n, shortExposure: 0n });
}

describe("createOrder", () => {
  it("encodes the spec, fresh hints, the price update and an empty signature", async () => {
    const { fake, ctx } = fakeContext();
    stockAccount(fake);
    fake.lens("findPredecessor", ([, , , start]: readonly [unknown, unknown, unknown, bigint]) => (start === 0n ? { pred: 7n, found: false } : { pred: 9n, found: true }));
    const call = await createOrder(ctx, PAIR, alice.address, limit({ limitPrice: 1990n * E18 }));
    const d = decodeFunctionData({ abi: pairAbi, data: call.data });
    expect(d.functionName).toBe("createOrder");
    const [spec, hints, update, nonce, deadline, fee, sig, permit] = d.args as readonly unknown[];
    expect(spec).toEqual({ orderType: LIMIT, isLong: true, isPostOnly: false, tif: 0, size: E18, triggerPrice: 0n, limitPrice: 1990n * E18, maxSlippageBp: 0n, expirationBlock: 5000n, integrator: I });
    expect(hints).toEqual({ pred: 9n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 });
    expect(update).toEqual([mockUpdate(FEED, 2000_00000000n, fake.timestamp)]);
    expect([nonce, deadline, fee, sig, permit]).toEqual([0n, 0n, 0n, "0x", "0x"]);
    expect(call.value).toBe(7n);
    expect(call.priceTime).toBe(fake.timestamp);
    expect(call.from).toBe(alice.address);
    expect(call.pullsUsdc).toBe(0n);
    const pages = fake.callsTo("findPredecessor").map((c) => [c.args[1], c.args[2], c.args[3], c.args[4]]);
    expect(pages).toEqual([
      [true, 1990n * E18, 0n, 64n],
      [true, 1990n * E18, 7n, 64n],
    ]);
  });

  it("pulls a stop's bounty, carries a permit, and asks for no hints", async () => {
    const { fake, ctx } = fakeContext();
    stockAccount(fake, bucket({ isLong: true, size: E18 }));
    const call = await createOrder(
      ctx,
      PAIR,
      alice.address,
      { orderType: STOP_LOSS, isLong: false, size: CLOSE_POSITION, triggerPrice: 1900n * E18, bounty: E18 / 2n, maxSlippageBp: 200n },
      { permitData: "0x1234" },
    );
    expect(call.pullsUsdc).toBe(E18 / 2n);
    const args = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect((args[0] as { triggerPrice: bigint }).triggerPrice).toBe(((E18 / 2n) << 128n) | (1900n * E18));
    expect(args[7]).toBe("0x1234");
    expect(fake.callsTo("findPredecessor")).toHaveLength(0);
    expect(call.summary).toMatch(/Stop loss/);
  });

  it("refuses against the account before anything is sent", async () => {
    const { fake, ctx } = fakeContext();
    stockAccount(fake, bucket(), Array.from({ length: 32 }, (_, i) => BigInt(i + 1)));
    fake.lens("findPredecessor", { pred: 0n, found: true });
    expect((await rejectsInput(createOrder(ctx, PAIR, alice.address, limit()))).field).toBe("orderType");
    expect((await rejectsInput(createOrder(ctx, PAIR, alice.address, limit({ limitPrice: 999n * E18 })))).field).toBe("limitPrice");
    expect((await rejectsInput(createOrder(ctx, PAIR, alice.address, limit({ expirationBlock: 1100 })))).field).toBe("expirationBlock");
    expect(fake.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
  });

  it("lets a direct order bound its walk", async () => {
    const { fake, ctx } = fakeContext();
    stockAccount(fake);
    fake.lens("findPredecessor", { pred: 0n, found: true });
    const call = await createOrder(ctx, PAIR, alice.address, limit(), { maxSteps: 8 });
    expect((decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[])[1]).toMatchObject({ maxSteps: 8 });
    await expect(createOrder(ctx, PAIR, alice.address, limit(), { maxSteps: 33 })).rejects.toThrow(InputError);
  });
});

describe("findPredecessor", () => {
  it("follows at most 8 pages and returns the last node reached", async () => {
    const { fake, ctx } = fakeContext();
    fake.lens("findPredecessor", ([, , , start]: readonly [unknown, unknown, unknown, bigint]) => ({ pred: start + 1n, found: false }));
    expect(await findPredecessor(ctx, PAIR, false, E18)).toBe(8n);
    expect(fake.callsTo("findPredecessor")).toHaveLength(8);
  });
});

describe("amendOrders", () => {
  function book(fake: ReturnType<typeof fakeContext>["fake"], orders: Record<string, ReturnType<typeof storedOrder>>) {
    fake.pair("orders", ([id]: readonly [bigint]) => orders[id.toString()] ?? storedOrder({ creator: "0x0000000000000000000000000000000000000000" }));
    fake.pair("book", { bidHead: 11n, askHead: 20n, bidCount: 1n, askCount: 1n });
    fake.pair("positionBuckets", bucket());
  }
  const orders = {
    "11": storedOrder({ limitPrice: 1990n * E18, size: E18, filledSize: E18 / 5n, prevInBook: 4 }),
    "20": storedOrder({ creator: bob.address, isLong: false, limitPrice: 2010n * E18 }),
    "30": storedOrder({ orderType: STOP_LIMIT, inBook: false }),
  };

  it("fills the hint from the book, skipping the order itself, and signs nothing", async () => {
    const { fake, ctx } = fakeContext();
    book(fake, orders);
    fake.lens("findPredecessor", { pred: 11n, found: true });
    const call = await amendOrders(ctx, PAIR, alice.address, [{ orderId: 11n, limitPrice: 1980n * E18, size: 2n * E18 }]);
    const [amends, update, nonce, deadline, fee, sig, permit] = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(amends).toEqual([amendIdWord(11n, 4n), 1980n * E18, 2n * E18]);
    expect(update).toHaveLength(1);
    expect([nonce, deadline, fee, sig, permit]).toEqual([0n, 0n, 0n, "0x", "0x"]);
    expect(call.value).toBe(7n);
  });

  it("keeps a caller's hint, and needs none for a shrink in place", async () => {
    const { fake, ctx } = fakeContext();
    book(fake, orders);
    const call = await amendOrders(ctx, PAIR, alice.address, [{ orderId: 11n, limitPrice: 1990n * E18, size: E18 / 2n }]);
    expect((decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[])[0]).toEqual([11n, 1990n * E18, E18 / 2n]);
    expect(fake.callsTo("findPredecessor")).toHaveLength(0);
  });

  it("refuses what the pair would refuse, and leaves best-effort skips to the pair", async () => {
    const { fake, ctx } = fakeContext();
    book(fake, orders);
    fake.lens("findPredecessor", { pred: 0n, found: true });
    const amend = (o: object) => amendOrders(ctx, PAIR, alice.address, [{ orderId: 11n, limitPrice: 1995n * E18, size: E18, ...o }]);
    expect((await rejectsInput(amend({ limitPrice: 2010n * E18 }))).message).toMatch(/cross/);
    expect((await rejectsInput(amend({ size: E18 / 5n }))).field).toBe("size");
    expect((await rejectsInput(amend({ limitPrice: 3001n * E18 }))).field).toBe("limitPrice");
    expect((await rejectsInput(amend({ orderId: 20n }))).message).toMatch(/not yours/);
    expect((await rejectsInput(amend({ orderId: 30n }))).message).toMatch(/resting limit/);
    expect((await rejectsInput(amend({ orderId: 99n }))).message).toMatch(/does not exist/);
    const be = await amend({ limitPrice: 2010n * E18, bestEffort: true });
    const words = (decodeFunctionData({ abi: pairAbi, data: be.data }).args as readonly unknown[])[0] as bigint[];
    expect(words[0]! & AMEND_BEST_EFFORT_BIT).toBe(AMEND_BEST_EFFORT_BIT);
  });

  it("refuses a move too close to expiry", async () => {
    const { fake, ctx } = fakeContext();
    book(fake, { ...orders, "11": storedOrder({ limitPrice: 1990n * E18, expiryBlock: 1200n }) });
    expect((await rejectsInput(amendOrders(ctx, PAIR, alice.address, [{ orderId: 11n, limitPrice: 1980n * E18, size: E18 }]))).message).toMatch(/expires too soon/);
  });
});

describe("cancelOrders", () => {
  it("checks the ids and the orders, and encodes the direct form", async () => {
    const { fake, ctx } = fakeContext();
    const os: Record<string, ReturnType<typeof storedOrder>> = {
      "1": storedOrder(),
      "2": storedOrder({ canceledBlock: 900n }),
      "3": storedOrder({ canceledBlock: 900n }),
      "4": storedOrder({ creator: bob.address }),
    };
    fake.pair("orders", ([id]: readonly [bigint]) => os[id.toString()]);
    fake.lens("triggerBounty", ([, id]: readonly [unknown, bigint]) => (id === 2n ? E18 : 0n));
    const call = await cancelOrders(ctx, PAIR, alice.address, [1n, 2n]);
    const d = decodeFunctionData({ abi: pairAbi, data: call.data });
    expect(d.functionName).toBe("cancelOrders");
    expect(d.args).toEqual([[1n, 2n], 0n, 0n, 0n, "0x", "0x"]);
    expect(call.summary).toMatch(/reclaiming/);
    expect((await rejectsInput(cancelOrders(ctx, PAIR, alice.address, [3n]))).message).toMatch(/already closed/);
    expect((await rejectsInput(cancelOrders(ctx, PAIR, alice.address, [4n]))).message).toMatch(/not yours/);
    expect((await rejectsInput(cancelOrders(ctx, PAIR, alice.address, [1n, 1n]))).message).toMatch(/twice/);
    expect((await rejectsInput(cancelOrders(ctx, PAIR, alice.address, []))).field).toBe("orderIds");
    expect((await rejectsInput(cancelOrders(ctx, PAIR, alice.address, Array.from({ length: 201 }, (_, i) => BigInt(i + 1))))).message).toMatch(/200/);
  });
});

describe("collateral and fees", () => {
  it("floors a deposit to micro-USDC and reports the pull", async () => {
    const { ctx } = fakeContext();
    const call = await depositCollateral(ctx, PAIR, alice.address, 10n * E18 + 123n);
    expect(decodeFunctionData({ abi: pairAbi, data: call.data }).args).toEqual([10n * E18, 0n, 0n, 0n, "0x", "0x"]);
    expect(call.pullsUsdc).toBe(10n * E18);
    expect(call.value).toBe(0n);
    expect((await rejectsInput(depositCollateral(ctx, PAIR, alice.address, 5n * E18 - 1n))).field).toBe("amount");
  });

  it("attaches a price to a withdrawal, and needs one only for an account with exposure", async () => {
    const { fake, ctx } = fakeContext();
    const call = await withdrawCollateral(ctx, PAIR, alice.address, 3n * E18);
    const args = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(args[0]).toBe(3n * E18);
    expect(args[1]).toHaveLength(1);
    expect(args.slice(2)).toEqual([0n, 0n, 0n, "0x"]);
    expect(call.value).toBe(7n);

    const bare = fakeContext({ prices: null });
    stockAccount(bare.fake);
    bare.fake.pair("isPairTerminated", false);
    const flatCall = await withdrawCollateral(bare.ctx, PAIR, alice.address, 3n * E18);
    expect((decodeFunctionData({ abi: pairAbi, data: flatCall.data }).args as readonly unknown[])[1]).toEqual([]);
    stockAccount(bare.fake, bucket({ size: E18 }));
    await expect(withdrawCollateral(bare.ctx, PAIR, alice.address, 3n * E18)).rejects.toThrow(/price source/);
    void fake;
  });

  it("claims only what is owed", async () => {
    const { fake, ctx } = fakeContext();
    fake.lens("claimableFees", { owed: 0n, total: 0n });
    expect((await rejectsInput(claimFees(ctx, PAIR, alice.address))).field).toBe("pair");
    fake.lens("claimableFees", { owed: 3n * 10n ** 17n, total: E18 });
    const call = await claimFees(ctx, PAIR, alice.address);
    expect(call.data).toBe(keccak256(toBytes("claimFees()")).slice(0, 10));
    expect(call.summary).toBe("Claim 0.3 USDC");
  });
});

describe("executeTriggeredOrders", () => {
  it("fires the owner's reached triggers, with a hint for a stop-limit", async () => {
    const { fake, ctx } = fakeContext();
    const os: Record<string, ReturnType<typeof storedOrder>> = {
      "5": storedOrder({ orderType: STOP_LOSS, isLong: false, inBook: false, triggerPrice: 2100n * E18, limitPrice: 0n, expiryBlock: NEVER_EXPIRE_BLOCK }),
      "6": storedOrder({ orderType: STOP_LIMIT, isLong: true, inBook: false, triggerPrice: 1950n * E18, limitPrice: 2005n * E18 }),
      "7": storedOrder({ orderType: TAKE_PROFIT, isLong: false, inBook: false, triggerPrice: 2100n * E18, expiryBlock: NEVER_EXPIRE_BLOCK }),
      "8": storedOrder({ orderType: STOP_LOSS, creator: bob.address, inBook: false, triggerPrice: 2100n * E18 }),
    };
    fake.pair("orders", ([id]: readonly [bigint]) => os[id.toString()]);
    fake.lens("findPredecessor", { pred: 3n, found: true });
    const call = await executeTriggeredOrders(ctx, PAIR, alice.address, [5n, 6n]);
    const [execs, update] = decodeFunctionData({ abi: pairAbi, data: call.data }).args as readonly unknown[];
    expect(execs).toEqual([
      { orderId: 5n, hints: { pred: 0n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 } },
      { orderId: 6n, hints: { pred: 3n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 } },
    ]);
    expect(update).toHaveLength(1);
    // a sell take-profit at 2100 fires at price >= 2100; the price is 2000
    expect((await rejectsInput(executeTriggeredOrders(ctx, PAIR, alice.address, [7n]))).message).toMatch(/not been reached/);
    expect((await rejectsInput(executeTriggeredOrders(ctx, PAIR, alice.address, [8n]))).message).toMatch(/not yours/);
    await expect(executeTriggeredOrders(ctx, PAIR, alice.address, Array.from({ length: 21 }, (_, i) => BigInt(i)))).rejects.toThrow(InputError);
  });
});

describe("price updates", () => {
  const msg = (feed: Hex, price: bigint, conf: bigint, expo: number, pub: number) =>
    encodePacked(["uint8", "bytes32", "int64", "uint64", "int32", "int64", "int64", "int64", "uint64"], [0, feed, price, conf, expo, BigInt(pub), BigInt(pub - 1), price, conf]);
  function accumulator(msgs: Hex[]): Hex {
    const updates = msgs.map((m) => encodePacked(["uint16", "bytes", "uint8", "bytes20"], [(m.length - 2) / 2, m, 1, ("0x" + "77".repeat(20)) as Hex]));
    return encodePacked(["bytes4", "uint8", "uint8", "uint8", "uint8", "uint16", "bytes3", "uint8", ...updates.map(() => "bytes" as const)], [
      "0x504e4155", 1, 0, 0, 0, 3, "0xaabbcc", msgs.length, ...updates,
    ] as never);
  }

  it("reads accumulator and MockPyth updates", () => {
    const feed2 = ("0x" + "cd".repeat(32)) as Hex;
    const out = parsePriceUpdate([accumulator([msg(FEED, 123n, 4n, -5, 1000), msg(feed2, -7n, 1n, 2, 999)]), mockUpdate(FEED, 55n, 1001, 3n)]);
    expect(out.map((m) => [m.feedId, m.price, m.conf, m.expo, m.publishTime, m.prevPublishTime])).toEqual([
      [FEED, 123n, 4n, -5, 1000, 999],
      [feed2, -7n, 1n, 2, 999, 998],
      [FEED, 55n, 3n, -8, 1001, 1000],
    ]);
    expect(() => parsePriceUpdate(["0x1234"])).toThrow(/unrecognized/);
  });

  it("composes a composite pair's price as the oracle does, from the newest message per feed", async () => {
    const { fake, ctx } = fakeContext();
    const base = ("0x" + "01".repeat(32)) as Hex;
    const quote = ("0x" + "02".repeat(32)) as Hex;
    fake.oracle("composites", { baseId: base, quoteId: quote, invertQuote: true });
    const update = [accumulator([msg(base, 300_000_000n, 30_000n, -8, 100), msg(quote, 150_000_000n, 15_000n, -8, 90)]), mockUpdate(base, 310_000_000n, 99, 0n)];
    const got = await pairPriceFromUpdate(ctx, PAIR, update);
    const want = pairPrice(
      [
        { price: 300_000_000n, conf: 30_000n, expo: -8, publishTime: 100 },
        { price: 150_000_000n, conf: 15_000n, expo: -8, publishTime: 90 },
      ],
      true,
    );
    expect(got).toEqual(want);
    expect(got!.spot).toBe(2n * E18);
    expect(await pairPriceFromUpdate(ctx, PAIR, [mockUpdate(base, 1n, 1)])).toBeNull();
  });
});

describe("batching", () => {
  it("encodes BazaarTradingAccount.execute and sums the values", async () => {
    const { fake, ctx } = fakeContext();
    stockAccount(fake);
    fake.lens("findPredecessor", { pred: 0n, found: true });
    const account = bob.address;
    const approve = await approveUsdc(ctx, account, PAIR, 20_000n * 10n ** 6n);
    const dep = await depositCollateral(ctx, PAIR, account, 20_000n * E18);
    const o1 = await createOrder(ctx, PAIR, account, limit({ limitPrice: 1990n * E18 }));
    const o2 = await createOrder(ctx, PAIR, account, limit({ limitPrice: 1980n * E18 }));
    const shared = shareOnePriceUpdate([approve, dep, o1, o2]);
    expect(shared[2]).toBe(o1);
    expect(shared[3]!.value).toBe(0n);
    expect((decodeFunctionData({ abi: pairAbi, data: shared[3]!.data }).args as readonly unknown[])[2]).toEqual([]);
    expect(shared[3]!.priceTime).toBeUndefined();

    const tx = tradingAccountExecute(account, alice.address, shared);
    expect(tx.to).toBe(account);
    expect(tx.from).toBe(alice.address);
    expect(tx.value).toBe(7n);
    expect(tx.pullsUsdc).toBe(20_000n * E18);
    expect(tx.data.slice(0, 10)).toBe(keccak256(toBytes("execute((address,uint256,bytes)[])")).slice(0, 10));
    const inner = decodeFunctionData({ abi: TRADING_ACCOUNT_ABI, data: tx.data }).args![0] as readonly { target: string; value: bigint }[];
    expect(inner.map((c) => c.target)).toEqual([USDC, PAIR, PAIR, PAIR]);
    expect(inner.map((c) => c.value)).toEqual([0n, 0n, 7n, 0n]);
    expect(encodeTradingAccountExecute(toBatchCalls(shared))).toBe(tx.data);
    expect(decodeTradingAccountResults("0x" + "00".repeat(31) + "20" + "00".repeat(32) as Hex)).toEqual([]);

    const req = walletSendCallsRequest(ctx, account, shared);
    expect(req.method).toBe("wallet_sendCalls");
    expect(req.params[0]).toMatchObject({ version: "2.0.0", chainId: "0xa4b1", from: account, atomicRequired: true });
    expect(req.params[0].calls[2]).toEqual({ to: PAIR, data: o1.data, value: "0x7" });
  });
});

describe("allowance", () => {
  it("approves an exact amount unless unlimited is asked for", async () => {
    const { fake, ctx } = fakeContext();
    const exact = await approveUsdc(ctx, alice.address, PAIR, 25_500_000n);
    expect(decodeFunctionData({ abi: ERC20_ABI, data: exact.data }).args).toEqual([PAIR, 25_500_000n]);
    expect(exact.summary).toMatch(/25\.5 USDC/);
    const unlimited = await approveUsdc(ctx, alice.address, PAIR, 1n, { unlimited: true });
    expect(decodeFunctionData({ abi: ERC20_ABI, data: unlimited.data }).args[1]).toBe((1n << 256n) - 1n);
    fake.usdc("balanceOf", 30_000_000n).usdc("allowance", 10_000_000n);
    const f = await usdcFunding(ctx, alice.address, PAIR, 25n * E18 + 1n);
    expect(f).toEqual({ needUsdc: 25_000_001n, balance: 30_000_000n, allowance: 10_000_000n, enoughBalance: true, enoughAllowance: false, approveUsdc: 25_000_001n });
  });
});

describe("the pair guard (factory.isPair)", () => {
  // No route answers for this address in the fake: any read of it would fail the test.
  const ATTACKER = getAddress("0x000000000000000000000000000000000000dead");

  it("refuses every builder for an address the factory does not know, before reading anything else", async () => {
    const { fake, ctx } = fakeContext();
    const builders: (() => Promise<unknown>)[] = [
      () => depositCollateral(ctx, ATTACKER, alice.address, 1000n * E18),
      () => withdrawCollateral(ctx, ATTACKER, alice.address, E18),
      () => createOrder(ctx, ATTACKER, alice.address, limit()),
      () => amendOrders(ctx, ATTACKER, alice.address, [{ orderId: 1n, limitPrice: E18, size: E18 }]),
      () => cancelOrders(ctx, ATTACKER, alice.address, [1n]),
      () => claimFees(ctx, ATTACKER, alice.address),
      () => executeTriggeredOrders(ctx, ATTACKER, alice.address, [1n]),
      () => approveUsdc(ctx, alice.address, ATTACKER, 1000_000000n),
      () => approveUsdc(ctx, alice.address, ATTACKER, 0n, { unlimited: true }),
    ];
    for (const build of builders) {
      const before = fake.calls.length;
      const e = await rejectsInput(build());
      expect(e.field).toBe("pair");
      expect(e.message).toMatch(/is not a market of this Bazaar deployment/);
      expect(fake.calls.slice(before).map((c) => c.fn)).toEqual(["isPair"]);
    }
    expect((await rejectsInput(depositCollateral(ctx, "0x1234" as never, alice.address, 10n * E18))).field).toBe("pair");
  });

  it("asks the factory once per pair per connection, and does not cache a refusal", async () => {
    const { fake, ctx } = fakeContext();
    await depositCollateral(ctx, PAIR, alice.address, 10n * E18);
    await depositCollateral(ctx, PAIR.toLowerCase() as never, alice.address, 20n * E18);
    await approveUsdc(ctx, alice.address, PAIR, 1n);
    expect(fake.callsTo("isPair")).toHaveLength(1);
    await rejectsInput(depositCollateral(ctx, ATTACKER, alice.address, 10n * E18));
    fake.factory("isPair", () => true); // listed since
    expect((await depositCollateral(ctx, ATTACKER, alice.address, 10n * E18)).to).toBe(ATTACKER);
    expect(fake.callsTo("isPair")).toHaveLength(3);
    // another connection asks again
    const other = fakeContext();
    await depositCollateral(other.ctx, PAIR, alice.address, 10n * E18);
    expect(other.fake.callsTo("isPair")).toHaveLength(1);
  });
});

describe("withdrawals on a terminated pair", () => {
  it("show what the withdrawal pays at the principal ratio, and refuse one that pays nothing", async () => {
    const { fake, ctx } = fakeContext();
    fake.pair("isPairTerminated", true);
    const entitlement = (principalRatio: bigint) => ({ collateral: 10n * E18, registeredClaim: 0n, principalRatio, profitRatio: 0n, payout: (10n * principalRatio) });
    fake.lens("getTerminalEntitlement", entitlement(E18 / 2n));
    const call = await withdrawCollateral(ctx, PAIR, alice.address, 3n * E18);
    expect(call.summary).toBe("Withdraw 3 USDC of collateral (the market is terminated: it pays 1.5 USDC, 50% of the amount)");
    expect(call.pullsUsdc).toBe(0n);
    fake.lens("getTerminalEntitlement", entitlement(0n));
    expect((await rejectsInput(withdrawCollateral(ctx, PAIR, alice.address, 3n * E18))).message).toMatch(/pays nothing/);
    fake.pair("isPairTerminated", false);
    expect((await withdrawCollateral(ctx, PAIR, alice.address, 3n * E18)).summary).toBe("Withdraw 3 USDC of collateral");
  });
});

describe("describeOrder", () => {
  it("prints the bounty, size and prices exactly, never rounded down", () => {
    const sl = buildOrderSpec({ orderType: STOP_LOSS, isLong: false, size: CLOSE_POSITION, triggerPrice: 19001234567891n * 10n ** 8n, bounty: 250_001n * 10n ** 12n, maxSlippageBp: 150n }, I);
    expect(describeOrder(sl)).toBe("Stop loss: sell the whole position when the price reaches 1900.1234567891 (1.5% max slippage, $0.250001 keeper bounty)");
    const tp = buildOrderSpec({ orderType: TAKE_PROFIT, isLong: false, size: E18, triggerPrice: 2100n * E18, bounty: 10n ** 12n, maxSlippageBp: 50n }, I);
    expect(describeOrder(tp)).toMatch(/\$0\.000001 keeper bounty/);
    expect(describeOrder(buildOrderSpec(limit({ size: 10000005n * 10n ** 11n }), I))).toBe("Buy 1.0000005 at 2000 (limit, GTC)");
  });
});
