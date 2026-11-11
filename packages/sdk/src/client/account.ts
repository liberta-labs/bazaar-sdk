/**
 * An account's state for a UI: on one market ({@link accountSnapshot}) or on every market where it
 * holds anything ({@link portfolio}).
 *
 * A snapshot has the position and its health at the live price, attached TP/SL, open orders, the
 * order exposure, what can be withdrawn now, claimable fees, the meta-transaction nonce, the terminal
 * entitlement of a market that is winding down, and the USDC wallet balance and allowance for the pair.
 *
 * Reads are batched by phase, not by market: one `chain.batch` for every market's position, live
 * order ids, stored price and the account's claimable fees and wallet balance; then one more for
 * everything that depends on those (the lens reads at the account's conservative price, the orders
 * themselves), sent together with the markets' state read. So a 50-market portfolio is about four
 * calls, the same as one market. {@link accountHealth} revalues a snapshot at a new price without any
 * read, for a display that follows the live price.
 */

import { type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress } from "viem";
import type { Block, Read } from "../chain/client.js";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import { BAZAAR_SCALE, ORDER_TYPE_NAMES, STOP_LOSS, TAKE_PROFIT, TRIGGER_PRICE_MASK, ZERO_ADDRESS } from "../constants.js";
import { bucketState, effectiveMmrBp, marginRatio, mulDiv } from "../formulas/index.js";
import { type MarketState, Status, marketFromStatic, marketStatus } from "../models.js";
import type { OrderRecord } from "../sync/reader.js";
import type { BazaarContext } from "./context.js";
import {
  type LivePriceView,
  type MarketFlags,
  type MarketInfo,
  type MarketRef,
  type MarketSnapshot,
  type HeldPrice,
  type PriceQuote,
  getMarket,
  headFor,
  listMarkets,
  marketFlags,
  readerFor,
  resolvePrices,
} from "./markets.js";

// =====================================================================================================
// Shapes
// =====================================================================================================

/** The account's position bucket on the pair (BazaarPairLens.getPositionBucket), BAZAAR precision. */
export interface AccountPosition {
  readonly isLong: boolean;
  readonly size: bigint;
  /** The position's entry notional. */
  readonly entryValue: bigint;
  /** entryValue / size: the average entry price (0 while flat). */
  readonly entryPrice: bigint;
  /** Raw collateral: deposits plus realized PnL, less fees. */
  readonly collateral: bigint;
  readonly entryFundingIndex: bigint;
  /** The attached TakeProfit's order id (0 for none). */
  readonly takeProfitOrderId: bigint;
  /** The attached StopLoss's order id (0 for none). */
  readonly stopLossOrderId: bigint;
}

/**
 * The position valued at a price, by the pair's own formula (BucketLib.calculateState) at the
 * projected funding index (what a price stored now would accrue to) and the effective maintenance rate.
 */
export interface PositionHealth {
  /** The spot it was valued at. */
  readonly price: bigint;
  readonly notional: bigint;
  readonly unrealizedPnl: bigint;
  /** Funding owed (negative) or earned since entry. */
  readonly fundingPnl: bigint;
  readonly totalPnl: bigint;
  /** Collateral plus total PnL (signed). */
  readonly equity: bigint;
  /** Equity floored at zero. */
  readonly availableEquity: bigint;
  /** What maintenance margin requires at this price. */
  readonly maintenanceRequired: bigint;
  /** Equity over the maintenance requirement: below 1, anyone may liquidate the position. */
  readonly marginRatio: number;
  /** Notional over equity (null when equity is not positive). */
  readonly leverage: number | null;
  readonly isSolvent: boolean;
}

/** BazaarPairLens.checkBucketSolvency at the snapshot's spot: the contract's own view, at the stored funding index. */
export interface LensBucketState {
  readonly unrealizedPnl: bigint;
  readonly fundingPnl: bigint;
  readonly totalPnl: bigint;
  readonly adjustedSize: bigint;
  readonly currentNotional: bigint;
  readonly entryValue: bigint;
  readonly minRequiredCollateral: bigint;
  readonly availableEquity: bigint;
  readonly effectiveCollateral: bigint;
  readonly adjustedEntryFundingIndex: bigint;
  readonly isSolvent: boolean;
}

/** One of the account's live orders, decoded from `pair.orders(id)`. Prices and sizes in BAZAAR precision. */
export interface AccountOrder {
  readonly orderId: bigint;
  readonly orderType: number;
  /** "Market", "Limit", "StopLimit", "TakeProfit" or "StopLoss". */
  readonly typeName: string;
  readonly isLong: boolean;
  readonly isPostOnly: boolean;
  /** 0 GTC, 1 IOC, 2 FOK. */
  readonly tif: number;
  readonly size: bigint;
  readonly filled: bigint;
  /** What is left to fill; for a TP/SL, capped at the position it closes. */
  readonly remaining: bigint;
  readonly limitPrice: bigint;
  /** The trigger price (StopLimit, TakeProfit, StopLoss); 0 for the other types. */
  readonly triggerPrice: bigint;
  /** The keeper bounty the order still holds in escrow (BazaarPairLens.triggerBounty). */
  readonly bounty: bigint;
  readonly maxSlippageBp: bigint;
  readonly expiryBlock: number;
  readonly neverExpires: boolean;
  /** Blocks until it expires (null when it never does). */
  readonly blocksLeft: number | null;
  /** Resting in the book: a Limit, or a StopLimit that has armed. */
  readonly inBook: boolean;
  /** A TP/SL sized to close whatever the position is when it fires. */
  readonly closesWholePosition: boolean;
  /** Whether it is the position's attached TakeProfit or StopLoss. */
  readonly attached: "takeProfit" | "stopLoss" | null;
  readonly integrator: Address;
  readonly record: OrderRecord;
}

/** BazaarPairLens.outstandingOrderExposure: the live limit orders' remaining notional (at their limits) and size per side. */
export interface OrderExposure {
  readonly longNotional: bigint;
  readonly shortNotional: bigint;
  readonly longSize: bigint;
  readonly shortSize: bigint;
}

/** BazaarPairLens.getTerminalEntitlement: what a withdrawal pays on a market that is winding down. */
export interface TerminalPayout {
  readonly collateral: bigint;
  readonly registeredClaim: bigint;
  /** Cash per unit of collateral, 1e18 = 100% (0 before finalize). */
  readonly principalRatio: bigint;
  /** Cash per unit of registered claim, 1e18 = 100% (0 before finalize). */
  readonly profitRatio: bigint;
  /** collateral × principalRatio + registeredClaim × profitRatio. */
  readonly payout: bigint;
}

export interface WalletState {
  /** USDC in the wallet, in USDC units (6 decimals). */
  readonly usdcBalance: bigint;
  /** What the pair may pull from the wallet, in USDC units (6 decimals). */
  readonly usdcAllowance: bigint;
}

export interface AccountSnapshot {
  readonly market: MarketInfo;
  readonly user: Address;
  readonly block: number;
  readonly timestamp: number;
  readonly status: Status;
  /** The market's flags at the snapshot's block. */
  readonly flags: MarketFlags;
  /** The market's state read, kept for {@link accountHealth}. */
  readonly state: MarketState;
  readonly position: AccountPosition;
  readonly hasPosition: boolean;
  /** What the health and the withdrawal bound were valued at; null when no price was known at all. */
  readonly price: PriceQuote | null;
  /** The position's health at `price.spot`; null while flat or without a price. */
  readonly health: PositionHealth | null;
  readonly solvency: LensBucketState | null;
  /** Every live order: the limit-type orders in the account's active set, then the attached TP/SL. */
  readonly orders: AccountOrder[];
  readonly takeProfit: AccountOrder | null;
  readonly stopLoss: AccountOrder | null;
  readonly exposure: OrderExposure;
  /**
   * The most `withdrawCollateral` accepts now (BazaarPairLens.getMaxWithdrawable, BAZAAR precision),
   * valued at the conservative side of the price for a position (low for a long, high for a short).
   * The lens cannot see a closed venue: when {@link withdrawalBlocked} is set the withdrawal reverts
   * whatever this says.
   */
  readonly maxWithdrawable: bigint;
  /** Why this account cannot withdraw right now (the market's flags, applied to it); null when it can. */
  readonly withdrawalBlocked: string | null;
  /** Fees, rewards and refunded bounties the account can claim on this pair with claimFees (BAZAAR precision). */
  readonly claimableFees: bigint;
  /** The account's next meta-transaction nonce on this pair. */
  readonly nonce: bigint;
  /** What a withdrawal pays while the market settles or after it terminated; null on a live market. */
  readonly terminal: TerminalPayout | null;
  readonly wallet: WalletState;
}

export interface AccountOptions {
  /** The block to read at (a watcher passes its head); default the latest. */
  readonly block?: Pick<Block, "number" | "timestamp"> | null;
  /** Live prices ({@link LivePrices}) to value the position at and to judge the venue with. */
  readonly prices?: LivePriceView | null;
  /** Without live prices, ask the context's Pyth Pro source for the legs (in parallel with the first read). Default true. */
  readonly fetchPrices?: boolean;
}

export interface AccountSnapshotOptions extends AccountOptions {
  /** A price the caller already holds, used instead of a live one. */
  readonly price?: HeldPrice | null;
  /** The market's snapshot (or state read) at the same block, to skip reading it again. */
  readonly market?: MarketSnapshot | MarketState | null;
}

// =====================================================================================================
// Reads
// =====================================================================================================

interface RawBucket {
  isLong: boolean;
  size: bigint;
  entryValue: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  takeProfitOrderId: bigint | number;
  stopLossOrderId: bigint | number;
}

interface RawStoredPrice {
  spotPrice: bigint;
  updateTs: bigint;
  lowPrice: bigint;
  highPrice: bigint;
}

interface RawOrder {
  creator: Address;
  canceledBlock: bigint | number;
  orderType: number;
  isLong: boolean;
  isPostOnly: boolean;
  tif: number;
  integrator: Address;
  expiryBlock: bigint | number;
  inBook: boolean;
  maxSlippageBp: bigint | number;
  triggerPrice: bigint;
  limitPrice: bigint;
  size: bigint;
  filledSize: bigint;
  prioritySeq: bigint | number;
  filledBlock: bigint | number;
  restedBlock: bigint | number;
  restedPremiumPpm: bigint | number;
  prevInBook: bigint | number;
  nextInBook: bigint | number;
}

const EMPTY_BUCKET: RawBucket = {
  isLong: false,
  size: 0n,
  entryValue: 0n,
  collateral: 0n,
  entryFundingIndex: 0n,
  takeProfitOrderId: 0n,
  stopLossOrderId: 0n,
};

const UINT128_MAX = (1n << 128n) - 1n;
const NEVER_EXPIRES = 2 ** 63; // the never-expire sentinel 2^64 - 1 reads back as ~1.8e19

// balanceOf(address), allowance(address,address): USDC is a plain ERC-20, not in the vendored ABIs.
const erc20Balance = (owner: Address): Hex => concatHex(["0x70a08231", encodeAbiParameters([{ type: "address" }], [owner])]);
const erc20Allowance = (owner: Address, spender: Address): Hex =>
  concatHex(["0xdd62ed3e", encodeAbiParameters([{ type: "address" }, { type: "address" }], [owner, spender])]);
const uint = (data: Hex): bigint => decodeAbiParameters([{ type: "uint256" }], data)[0];

function decodeOr<T>(res: readonly [boolean, Hex] | undefined, decode: (data: Hex) => T, fallback: T): T {
  if (!res || !res[0]) return fallback;
  try {
    return decode(res[1]);
  } catch {
    return fallback;
  }
}

function toRecord(o: RawOrder, bounty: bigint): OrderRecord {
  return {
    creator: o.creator,
    canceledBlock: Number(o.canceledBlock),
    orderType: Number(o.orderType),
    isLong: o.isLong,
    isPostOnly: o.isPostOnly,
    tif: Number(o.tif),
    integrator: o.integrator,
    expiryBlock: Number(o.expiryBlock),
    inBook: o.inBook,
    maxSlippageBp: BigInt(o.maxSlippageBp),
    triggerPrice: o.triggerPrice,
    limitPrice: o.limitPrice,
    size: o.size,
    filledSize: o.filledSize,
    prioritySeq: Number(o.prioritySeq),
    filledBlock: Number(o.filledBlock),
    restedBlock: Number(o.restedBlock),
    restedPremiumPpm: BigInt(o.restedPremiumPpm),
    prevInBook: BigInt(o.prevInBook),
    nextInBook: BigInt(o.nextInBook),
    bounty,
  };
}

/**
 * The SDK's view of a stored order. The pair stores the trigger price alone (uint128): the keeper
 * bounty an OrderSpec packs above it (`(bounty << 128) | price`) moves into the fee escrow at
 * creation, so it is read from there (`bounty`); the mask only guards the unpacking.
 */
function toAccountOrder(id: bigint, r: OrderRecord, block: number, position: RawBucket): AccountOrder {
  const attached = BigInt(position.takeProfitOrderId) === id ? "takeProfit" : BigInt(position.stopLossOrderId) === id ? "stopLoss" : null;
  const isTpSl = r.orderType === TAKE_PROFIT || r.orderType === STOP_LOSS;
  let remaining = r.size > r.filledSize ? r.size - r.filledSize : 0n;
  if (isTpSl && remaining > position.size) remaining = position.size;
  const neverExpires = r.expiryBlock >= NEVER_EXPIRES;
  return {
    orderId: id,
    orderType: r.orderType,
    typeName: ORDER_TYPE_NAMES[r.orderType] ?? `type ${r.orderType}`,
    isLong: r.isLong,
    isPostOnly: r.isPostOnly,
    tif: r.tif,
    size: r.size,
    filled: r.filledSize,
    remaining,
    limitPrice: r.limitPrice,
    triggerPrice: r.triggerPrice & TRIGGER_PRICE_MASK,
    bounty: r.bounty,
    maxSlippageBp: r.maxSlippageBp,
    expiryBlock: r.expiryBlock,
    neverExpires,
    blocksLeft: neverExpires ? null : Math.max(0, r.expiryBlock - block),
    inBook: r.inBook,
    closesWholePosition: isTpSl && r.size >= UINT128_MAX,
    attached,
    integrator: r.integrator,
    record: r,
  };
}

/** Whether the stored order is still live at `block` (as the lens's _orderLeg judges it). */
function isLive(r: OrderRecord, block: number): boolean {
  return r.creator !== ZERO_ADDRESS && r.canceledBlock === 0 && r.filledBlock === 0 && r.expiryBlock >= block;
}

/** The position valued at `spot` with the state's projected funding index and effective maintenance rate. */
export function positionHealth(position: AccountPosition, state: Pick<MarketState, "projectedFundingIndex" | "mmrBp" | "laggedMmrBp">, spot: bigint): PositionHealth {
  const s = bucketState(
    position.isLong,
    position.size,
    position.entryValue,
    position.collateral,
    position.entryFundingIndex,
    spot,
    state.projectedFundingIndex,
    effectiveMmrBp(state.mmrBp, state.laggedMmrBp),
  );
  return {
    price: spot,
    notional: s.currentNotional,
    unrealizedPnl: s.unrealizedPnl,
    fundingPnl: s.fundingPnl,
    totalPnl: s.totalPnl,
    equity: s.equity,
    availableEquity: s.availableEquity,
    maintenanceRequired: s.minRequiredCollateral,
    marginRatio: marginRatio(s),
    leverage: s.equity > 0n ? Number(s.currentNotional) / Number(s.equity) : null,
    isSolvent: s.isSolvent,
  };
}

/**
 * The snapshot's position revalued at a new spot price (a live print), with no read: for a display
 * that follows the price between snapshots. Null while flat.
 */
export function accountHealth(snap: Pick<AccountSnapshot, "position" | "state" | "hasPosition">, spot: bigint | HeldPrice): PositionHealth | null {
  if (!snap.hasPosition) return null;
  return positionHealth(snap.position, snap.state, typeof spot === "bigint" ? spot : spot.spot);
}

interface Phase1 {
  readonly market: MarketInfo;
  readonly bucket: RawBucket;
  readonly orderIds: readonly bigint[];
  readonly stored: RawStoredPrice | null;
  readonly claimable: bigint;
}

interface ReadOptions extends AccountOptions {
  readonly price?: HeldPrice | null;
  readonly states?: ReadonlyMap<Address, MarketState>;
  /** keep every market, not only those where the account holds something */
  readonly keepAll: boolean;
  /** the markets are the factory's whole list: claimable fees come from getClaimableFeesAll */
  readonly allMarkets: boolean;
}

const PHASE1_READS = 3;
const PHASE2_READS = 6;

async function phase1(
  ctx: BazaarContext,
  user: Address,
  markets: readonly MarketInfo[],
  block: number,
  allMarkets: boolean,
): Promise<{ rows: Phase1[]; walletUsdc: bigint; unknownOwed: Address[] }> {
  const P = pairCodec();
  const L = lensCodec();
  const reads: Read[] = [];
  for (const m of markets) {
    reads.push(
      { to: ctx.lens, data: L.encode("getPositionBucket", m.address, user) },
      { to: ctx.lens, data: L.encode("getUserActiveLimitOrders", m.address, user) },
      { to: m.address, data: P.encode("lastPairPrice") },
    );
  }
  const addrs = markets.map((m) => m.address);
  reads.push(
    allMarkets
      ? { to: ctx.lens, data: L.encode("getClaimableFeesAll", user) }
      : { to: ctx.lens, data: L.encode("getClaimableFees", addrs, user) },
    { to: ctx.usdc, data: erc20Balance(user) },
  );
  const res = await ctx.chain.batch(reads, block);
  const n = markets.length * PHASE1_READS;
  const owed = new Map<Address, bigint>();
  const unknownOwed: Address[] = [];
  if (allMarkets) {
    const all = decodeOr(res[n], (d) => L.decode<{ pairs: readonly Address[]; owed: readonly bigint[] }>("getClaimableFeesAll", d), null);
    const known = new Set(addrs);
    all?.pairs.forEach((p, i) => {
      const a = getAddress(p);
      const o = all.owed[i] ?? 0n;
      owed.set(a, o);
      if (o > 0n && !known.has(a)) unknownOwed.push(a);
    });
  } else {
    const list = decodeOr(res[n], (d) => L.decode<readonly bigint[]>("getClaimableFees", d), [] as readonly bigint[]);
    addrs.forEach((a, i) => owed.set(a, list[i] ?? 0n));
  }
  const rows = markets.map((market, i): Phase1 => {
    const at = (k: number) => res[i * PHASE1_READS + k];
    return {
      market,
      bucket: decodeOr(at(0), (d) => L.decode<RawBucket>("getPositionBucket", d), EMPTY_BUCKET),
      orderIds: decodeOr(at(1), (d) => L.decode<{ orderIds: readonly bigint[] }>("getUserActiveLimitOrders", d).orderIds, [] as readonly bigint[]),
      stored: decodeOr(at(2), (d) => P.decode<RawStoredPrice>("lastPairPrice", d), null),
      claimable: owed.get(market.address) ?? 0n,
    };
  });
  return { rows, walletUsdc: decodeOr(res[n + 1], uint, 0n), unknownOwed };
}

const holdsSomething = (r: Phase1) =>
  r.bucket.size > 0n || r.bucket.collateral > 0n || r.orderIds.length > 0 || r.claimable > 0n;

/** The order ids a row reads: its live limit-type orders, then its attached TP/SL. */
function idsOf(r: Phase1): bigint[] {
  const ids = [...r.orderIds];
  for (const x of [r.bucket.takeProfitOrderId, r.bucket.stopLossOrderId]) {
    const id = BigInt(x);
    if (id !== 0n && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const ZERO_EXPOSURE: OrderExposure = { longNotional: 0n, shortNotional: 0n, longSize: 0n, shortSize: 0n };

async function readAccounts(
  ctx: BazaarContext,
  user: Address,
  markets: readonly MarketInfo[],
  opts: ReadOptions,
): Promise<{ accounts: AccountSnapshot[]; walletUsdc: bigint; block: number; timestamp: number }> {
  const head = await headFor(ctx, opts.block);
  const [p1, prices] = await Promise.all([
    phase1(ctx, user, markets, head.number, opts.allMarkets),
    resolvePrices(ctx, markets, { prices: opts.prices, price: opts.price, fetchPrices: opts.fetchPrices, needPrice: true }),
  ]);
  let rows = p1.rows;
  if (p1.unknownOwed.length > 0) {
    // getClaimableFeesAll knows a pair the cached list does not: a market listed since. Read it too.
    const fresh = (await listMarkets(ctx, { refresh: true })).filter((m) => p1.unknownOwed.includes(m.address));
    if (fresh.length) {
      const more = await phase1(ctx, user, fresh, head.number, false);
      rows = [...rows, ...more.rows];
      const morePrices = await resolvePrices(ctx, fresh, { prices: opts.prices, fetchPrices: opts.fetchPrices, needPrice: true });
      for (const [a, p] of morePrices) prices.set(a, p);
    }
  }
  const active = opts.keepAll ? rows : rows.filter(holdsSomething);
  if (active.length === 0) return { accounts: [], walletUsdc: p1.walletUsdc, block: head.number, timestamp: head.timestamp };

  // ---- phase 2: everything that needs the price or the order ids, with the markets' state ----
  const P = pairCodec();
  const L = lensCodec();
  const quotes: (PriceQuote | null)[] = active.map((r) => {
    const live = prices.get(r.market.address)?.price ?? null;
    if (live) return live;
    const s = r.stored;
    return s && s.spotPrice > 0n
      ? { spot: s.spotPrice, low: s.lowPrice, high: s.highPrice, publishTime: Number(s.updateTs), source: "stored" }
      : null;
  });
  const reads: Read[] = [];
  const orderIds: bigint[][] = [];
  active.forEach((r, i) => {
    const m = r.market.address;
    const q = quotes[i];
    const spot = q?.spot ?? 0n;
    const conservative = r.bucket.size === 0n ? spot : r.bucket.isLong ? (q?.low ?? 0n) : (q?.high ?? 0n);
    reads.push(
      { to: ctx.lens, data: L.encode("checkBucketSolvency", m, user, spot) },
      { to: ctx.lens, data: L.encode("getMaxWithdrawable", m, user, conservative) },
      { to: ctx.lens, data: L.encode("outstandingOrderExposure", m, user) },
      { to: m, data: P.encode("metaTxNonces", user) },
      { to: ctx.lens, data: L.encode("getTerminalEntitlement", m, user) },
      { to: ctx.usdc, data: erc20Allowance(user, m) },
    );
    orderIds.push(idsOf(r));
  });
  const orderBase = reads.length;
  active.forEach((r, i) => {
    for (const id of orderIds[i]!) {
      reads.push({ to: r.market.address, data: P.encode("orders", id) }, { to: ctx.lens, data: L.encode("triggerBounty", r.market.address, id) });
    }
  });
  const needStates = active.filter((r) => !opts.states?.has(r.market.address)).map((r) => marketFromStatic(r.market));
  const [res, states] = await Promise.all([
    ctx.chain.batch(reads, head.number),
    needStates.length ? readerFor(ctx).marketStates(needStates, head.number, head.timestamp) : Promise.resolve(new Map<Address, MarketState>()),
  ]);

  const accounts: AccountSnapshot[] = [];
  let k = orderBase;
  active.forEach((r, i) => {
    const m = r.market;
    const ids = orderIds[i]!;
    const orderRes = res.slice(k, k + 2 * ids.length);
    k += 2 * ids.length;
    const state = opts.states?.get(m.address) ?? states.get(m.address);
    if (!state) return; // the market's own state read failed: nothing to judge the account against
    const at = (j: number) => res[i * PHASE2_READS + j];
    const b = r.bucket;
    const position: AccountPosition = {
      isLong: b.isLong,
      size: b.size,
      entryValue: b.entryValue,
      entryPrice: b.size > 0n ? mulDiv(b.entryValue, BAZAAR_SCALE, b.size) : 0n,
      collateral: b.collateral,
      entryFundingIndex: b.entryFundingIndex,
      takeProfitOrderId: BigInt(b.takeProfitOrderId),
      stopLossOrderId: BigInt(b.stopLossOrderId),
    };
    const hasPosition = b.size > 0n;
    const q = quotes[i] ?? null;
    const orders: AccountOrder[] = [];
    ids.forEach((id, j) => {
      const [ok, data] = orderRes[2 * j]!;
      if (!ok) return;
      const bounty = decodeOr(orderRes[2 * j + 1], (d) => L.decode<bigint>("triggerBounty", d), 0n);
      const rec = toRecord(P.decode<RawOrder>("orders", data), bounty);
      if (isLive(rec, head.number)) orders.push(toAccountOrder(id, rec, head.number, b));
    });
    const flags = marketFlags(m, state, head.timestamp, prices.get(m.address)?.venueClosed ?? null);
    const status = marketStatus(state, head.timestamp);
    const terminal = decodeOr(at(4), (d) => L.decode<TerminalPayout>("getTerminalEntitlement", d), null);
    const exposure = decodeOr(
      at(2),
      (d) => {
        const e = L.decode<{ longExposure: bigint; shortExposure: bigint; longSize: bigint; shortSize: bigint }>("outstandingOrderExposure", d);
        return { longNotional: e.longExposure, shortNotional: e.shortExposure, longSize: e.longSize, shortSize: e.shortSize };
      },
      ZERO_EXPOSURE,
    );
    accounts.push({
      market: m,
      user,
      block: head.number,
      timestamp: head.timestamp,
      status,
      flags,
      state,
      position,
      hasPosition,
      price: q,
      health: hasPosition && q ? positionHealth(position, state, q.spot) : null,
      solvency: q ? decodeOr(at(0), (d) => L.decode<LensBucketState>("checkBucketSolvency", d), null) : null,
      orders,
      takeProfit: orders.find((o) => o.attached === "takeProfit") ?? null,
      stopLoss: orders.find((o) => o.attached === "stopLoss") ?? null,
      exposure,
      maxWithdrawable: decodeOr(at(1), (d) => L.decode<bigint>("getMaxWithdrawable", d), 0n),
      withdrawalBlocked: flags.allWithdrawalsPaused
        ? flags.reasons.allWithdrawalsPaused
        : hasPosition && flags.positionWithdrawalsFrozen
          ? flags.reasons.positionWithdrawalsFrozen
          : null,
      claimableFees: r.claimable,
      nonce: decodeOr(at(3), (d) => P.decode<bigint>("metaTxNonces", d), 0n),
      terminal: status === Status.Settling || status === Status.Terminated ? terminal : null,
      wallet: { usdcBalance: p1.walletUsdc, usdcAllowance: decodeOr(at(5), uint, 0n) },
    });
  });
  return { accounts, walletUsdc: p1.walletUsdc, block: head.number, timestamp: head.timestamp };
}

function stateOf(m: MarketSnapshot | MarketState | null | undefined): MarketState | null {
  if (!m) return null;
  return "state" in m ? m.state : m;
}

// =====================================================================================================
// Public reads
// =====================================================================================================

/**
 * The account `user` on one market. The position is valued at, in order: `price`, the live price from
 * `prices`, one Pyth Pro request (when the context's source is a {@link proPriceSource}), or the
 * pair's stored price (`price.source` says which). Two batched reads: the position, its live order ids
 * and the stored price first; then the lens at that price (solvency, max withdrawable), the order
 * exposure, nonce, terminal entitlement, allowance and the orders themselves, together with the
 * market's state read (skipped when `market` gives it).
 */
export async function accountSnapshot(
  ctx: BazaarContext,
  market: MarketRef,
  user: Address,
  opts: AccountSnapshotOptions = {},
): Promise<AccountSnapshot> {
  const m = await getMarket(ctx, market);
  const owner = getAddress(user);
  const state = stateOf(opts.market);
  const block = opts.block ?? (state ? { number: state.block, timestamp: state.timestamp } : null);
  const { accounts } = await readAccounts(ctx, owner, [m], {
    ...opts,
    block,
    states: state ? new Map([[m.address, state]]) : undefined,
    keepAll: true,
    allMarkets: false,
  });
  const a = accounts[0];
  if (!a) throw new Error(`could not read the state of market ${m.label || m.address}: its price, margin or vault read failed`);
  return a;
}

export interface PortfolioTotals {
  /** Raw collateral across the markets (BAZAAR precision). */
  readonly collateral: bigint;
  /** Equity at the valuation prices: collateral plus PnL where there is a position. */
  readonly equity: bigint;
  readonly unrealizedPnl: bigint;
  readonly fundingPnl: bigint;
  readonly claimableFees: bigint;
  readonly maxWithdrawable: bigint;
}

export interface Portfolio {
  readonly user: Address;
  readonly block: number;
  readonly timestamp: number;
  /** One snapshot per market where the account has collateral, a position, orders or claimable fees, in the factory's order. */
  readonly accounts: AccountSnapshot[];
  /** USDC in the wallet, in USDC units (6 decimals). */
  readonly walletUsdc: bigint;
  readonly totals: PortfolioTotals;
}

/**
 * Every market where `user` has collateral, a position, live orders or claimable fees, as
 * {@link accountSnapshot}s, with totals. `markets` defaults to the factory's whole list (claimable
 * fees then come from one getClaimableFeesAll read, which also catches a market listed since the list
 * was cached). About four calls whatever the number of markets: the head, one batch over every market,
 * then one batch for the markets the account uses, sent with their state read.
 */
export async function portfolio(ctx: BazaarContext, user: Address, markets?: readonly MarketRef[], opts: AccountOptions = {}): Promise<Portfolio> {
  const owner = getAddress(user);
  const infos = markets ? await Promise.all(markets.map((m) => getMarket(ctx, m))) : await listMarkets(ctx);
  const r = await readAccounts(ctx, owner, infos, { ...opts, keepAll: false, allMarkets: !markets });
  const t = { collateral: 0n, equity: 0n, unrealizedPnl: 0n, fundingPnl: 0n, claimableFees: 0n, maxWithdrawable: 0n };
  for (const a of r.accounts) {
    t.collateral += a.position.collateral;
    t.equity += a.health ? a.health.equity : a.position.collateral;
    t.unrealizedPnl += a.health?.unrealizedPnl ?? 0n;
    t.fundingPnl += a.health?.fundingPnl ?? 0n;
    t.claimableFees += a.claimableFees;
    t.maxWithdrawable += a.withdrawalBlocked ? 0n : a.maxWithdrawable;
  }
  const order = new Map(infos.map((m, i) => [m.address, i]));
  r.accounts.sort((x, y) => (order.get(x.market.address) ?? x.market.index + infos.length) - (order.get(y.market.address) ?? y.market.index + infos.length));
  return { user: owner, block: r.block, timestamp: r.timestamp, accounts: r.accounts, walletUsdc: r.walletUsdc, totals: t };
}

/**
 * Several accounts' snapshots on chosen markets in one pass (used by watchAccount to refresh the
 * markets an event touched). Unlike {@link portfolio}, every market given gets a snapshot.
 * @internal
 */
export async function accountSnapshots(
  ctx: BazaarContext,
  user: Address,
  markets: readonly MarketInfo[],
  opts: AccountOptions & { states?: ReadonlyMap<Address, MarketState> } = {},
): Promise<AccountSnapshot[]> {
  return (await readAccounts(ctx, getAddress(user), markets, { ...opts, keepAll: true, allMarkets: false })).accounts;
}
