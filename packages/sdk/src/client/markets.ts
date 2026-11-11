/**
 * Markets for a UI: discovery and labels, the static facts a market page shows, the market's live
 * state in one batched read, and book depth aggregated into price levels.
 *
 * Static facts (pair id, feeds, trading calendar, label) never change for a deployed pair, so
 * {@link listMarkets} reads them once per context and caches them; a refresh only describes pairs the
 * factory listed since. Live state ({@link marketSnapshot}) is read at one block in one `chain.batch`
 * (the probe's aggregate, Multicall3 or parallel eth_calls, whichever the node allows), alongside the
 * keeper's own state read ({@link Reader.marketStates}), so a market page costs a single round trip
 * once the block is known. Nothing here reads the chain per render: snapshots are plain objects, and
 * {@link marketStatusAt} and {@link adlScoreThresholdAt} re-derive the time-dependent fields locally.
 */

import { type Address, type Hex, getAddress, isAddress } from "viem";
import type { Block, Read } from "../chain/client.js";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import {
  ADL_AUCTION_DURATION,
  ADL_TIMEOUT_DURATION,
  BAZAAR_SCALE,
  BP_SCALE,
  LIMBO_LEAD,
  TERMINAL_SETTLEMENT_ESCAPE,
} from "../constants.js";
import { adlThreshold, effectiveMmrBp, mulDiv, pairPrice } from "../formulas/index.js";
import { type Market, type MarketState, type MarketStatic, Status, freeCapital, marketFromStatic, marketStatus } from "../models.js";
import type { Print, ProSymbol } from "../prices/pro.js";
import { marketLabel } from "../prices/service.js";
import { Reader } from "../sync/reader.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { descriptionProblem } from "./listings.js";
import { type SymbolSource, feedInfoFor } from "./registry.js";

export type { SymbolSource } from "./registry.js";

// =====================================================================================================
// Static facts
// =====================================================================================================

/** "24/7" for a continuously traded market; "trading-hours" for one that follows its venue's calendar (stocks, FX). */
export type TradingHours = "24/7" | "trading-hours";

/** What never changes about a market: what a market list and a market header show. */
export interface MarketInfo extends MarketStatic {
  /**
   * When it trades. A trading-hours market keeps running on its last price while the venue is closed,
   * with fills boxed to 10% of that price, market orders refused and position collateral locked
   * until the first fresh price at the reopen (docs: Trading, "Stocks & FX after hours").
   */
  readonly hours: TradingHours;
  /** Priced from two Pyth Pro feeds (an asset and an FX leg) composed by the oracle. */
  readonly composite: boolean;
  /** Each leg's Pyth symbol ("Crypto.BTC/USD", "Equity.US.AAPL/USD"); "" where the symbols registry has none. */
  readonly legSymbols: readonly string[];
  /**
   * Each leg's entry in Pyth Pro's symbols registry (asset type, fastest channel, state, schedule);
   * null where the registry has none or was not read.
   */
  readonly legFeeds: readonly (ProSymbol | null)[];
  /** The market's position in the factory's pair list. */
  readonly index: number;
}

/** A market as callers name it: its info, its pair address, its pair id, or its label. */
export type MarketRef = MarketInfo | Address | Hex | string;

export interface ListMarketsOptions {
  /**
   * Read the factory's pair list again, for markets listed since the last call. Markets already known
   * keep their static facts (they never change); only new ones are described and labelled.
   */
  refresh?: boolean;
  /**
   * Where market labels come from. Default: the symbols registry of the context's Pyth Pro client (a
   * {@link proPriceSource}), and Pyth's own registry (networks.ts `PYTH_PRO.symbolsUrl`) when that
   * lists none of the feeds. `null` skips symbols: labels are then the short address (never the
   * subgraph's description, which is not verified).
   */
  metadata?: string | SymbolSource | null;
}

interface MarketCache {
  readonly byAddress: Map<Address, MarketInfo>;
  list: MarketInfo[];
  loaded: boolean;
  loading: Promise<MarketInfo[]> | null;
  /** the metadata choice of the first call, reused by refreshes that do not give one */
  metadata: ListMarketsOptions["metadata"];
}

const marketCaches = new WeakMap<BazaarContext, MarketCache>();
const readers = new WeakMap<BazaarContext, Reader>();

/**
 * The keeper's batched {@link Reader}, wired to the context's deployment (no factory read needed).
 * @internal
 */
export function readerFor(ctx: BazaarContext): Reader {
  let r = readers.get(ctx);
  if (!r) {
    r = new Reader(ctx.chain);
    r.dep = { factory: ctx.factory, lens: ctx.lens, terminator: ctx.terminator, oracle: ctx.oracle, usdc: ctx.usdc };
    readers.set(ctx, r);
  }
  return r;
}

/**
 * Pair descriptions (the listing's claim text) from the subgraph, when the context has one. Never
 * throws. The subgraph's copy is not checked against the chain, so it is decoration only: a row is
 * kept only for a pair asked about, with a string description that passes the factory's own charset
 * and length rule (listings' `descriptionProblem`); anything else reads as no description.
 */
async function descriptionsFor(ctx: BazaarContext, addresses: readonly Address[]): Promise<Map<Address, string>> {
  const out = new Map<Address, string>();
  if (!ctx.subgraph || addresses.length === 0) return out;
  const asked = new Set(addresses);
  const q = "query($ids: [Bytes!]) { pairs(first: 1000, where: { id_in: $ids }) { id description } }";
  try {
    for (let i = 0; i < addresses.length; i += 1000) {
      const ids = addresses.slice(i, i + 1000).map((a) => a.toLowerCase());
      const r = await ctx.subgraph.query<{ pairs?: unknown }>(q, { ids });
      const rows = r?.pairs;
      if (!Array.isArray(rows)) continue;
      for (const p of rows as { id?: unknown; description?: unknown }[]) {
        if (!p || typeof p.id !== "string" || !isAddress(p.id, { strict: false })) continue;
        const a = getAddress(p.id);
        if (!asked.has(a) || typeof p.description !== "string" || descriptionProblem(p.description) !== null) continue;
        out.set(a, p.description);
      }
    }
  } catch {
    // Descriptions are decoration: a subgraph outage must not stop a market list.
  }
  return out;
}

/**
 * A market's label: derived from its feeds' Pyth symbols ("BTC/USD"; a composite in USD), else its
 * short address. Never from the description, which is the subgraph's unverified text and could
 * name another market.
 */
function labelOf(m: Market, legSymbols: readonly string[]): string {
  const base = legSymbols[0] || null;
  const quote = m.legs.length === 2 ? (legSymbols[1] ?? "") : null;
  const label = marketLabel(base, quote);
  return label || m.address.slice(0, 10);
}

async function loadMarkets(ctx: BazaarContext, cache: MarketCache, opts: ListMarketsOptions): Promise<MarketInfo[]> {
  const reader = readerFor(ctx);
  const addresses = await reader.pairAddresses();
  const fresh = addresses.filter((a) => !cache.byAddress.has(a));
  if (fresh.length > 0) {
    const [described, descriptions] = await Promise.all([reader.describe(fresh), descriptionsFor(ctx, fresh)]);
    const feeds = [...new Set(described.flatMap((m) => m.legs.map((l) => l.toLowerCase() as Hex)))];
    let registry = new Map<Hex, ProSymbol>();
    try {
      registry = await feedInfoFor(ctx, feeds, opts.metadata !== undefined ? opts.metadata : cache.metadata);
    } catch {
      // Labels fall back to the address.
    }
    for (const m of described) {
      m.description = descriptions.get(m.address) ?? "";
      const legFeeds = m.legs.map((l) => registry.get(l.toLowerCase() as Hex) ?? null);
      const legSymbols = legFeeds.map((f) => f?.symbol ?? "");
      const info: MarketInfo = {
        address: m.address,
        pairId: m.pairId,
        baseFeedId: m.baseFeedId,
        legs: m.legs,
        invertQuote: m.invertQuote,
        continuous: m.continuous,
        description: m.description,
        label: labelOf(m, legSymbols),
        hours: m.continuous ? "24/7" : "trading-hours",
        composite: m.legs.length === 2,
        legSymbols,
        legFeeds,
        index: 0,
      };
      cache.byAddress.set(m.address, info);
    }
  }
  const list: MarketInfo[] = [];
  addresses.forEach((a, index) => {
    const m = cache.byAddress.get(a);
    if (!m) return;
    if (m.index !== index) {
      const moved = { ...m, index };
      cache.byAddress.set(a, moved);
      list.push(moved);
    } else {
      list.push(m);
    }
  });
  cache.list = list;
  cache.loaded = true;
  return list;
}

/**
 * Every market the context's factory has deployed, in the factory's order, with its static facts and
 * a label for display ("BTC/USD", "AAPL/USD"; a composite is labelled in USD).
 *
 * Reads `factory.getAllPairs`, then {@link Reader.describe} (pair id, base feed, calendar, composite
 * legs: two batched reads), the listing descriptions from the subgraph when the context has one, and
 * the legs' entries in Pyth Pro's symbols registry. Cached per context: later calls return the cached
 * list without any request until `refresh` is passed.
 */
export async function listMarkets(ctx: BazaarContext, opts: ListMarketsOptions = {}): Promise<MarketInfo[]> {
  let cache = marketCaches.get(ctx);
  if (!cache) marketCaches.set(ctx, (cache = { byAddress: new Map(), list: [], loaded: false, loading: null, metadata: opts.metadata }));
  if (cache.loaded && !opts.refresh) return cache.list;
  if (cache.loading) return cache.loading;
  const c = cache;
  const p = loadMarkets(ctx, c, opts).finally(() => {
    if (c.loading === p) c.loading = null;
  });
  c.loading = p;
  return p;
}

const PAIR_ID = /^0x[0-9a-fA-F]{64}$/;

function findMarket(list: readonly MarketInfo[], ref: string): MarketInfo | MarketInfo[] | null {
  const r = ref.trim();
  if (isAddress(r, { strict: false })) {
    const a = getAddress(r);
    return list.find((m) => m.address === a) ?? null;
  }
  if (PAIR_ID.test(r)) {
    const id = r.toLowerCase();
    return list.find((m) => m.pairId.toLowerCase() === id) ?? null;
  }
  // Labels only: a description is the subgraph's unverified text, so it never resolves a name.
  const low = r.toLowerCase();
  const matches = list.filter((m) => m.label.toLowerCase() === low);
  if (matches.length === 1) return matches[0]!;
  return matches.length > 1 ? matches : null;
}

/**
 * One market, by its address, its pair id, or its label (case-insensitive; labels come from the
 * feeds' Pyth symbols, never from the subgraph's description). A market the cached list does not
 * know yet makes one refresh of the factory's pair list. Throws {@link InputError} on field
 * "market" for a name that matches no market or several.
 */
export async function getMarket(ctx: BazaarContext, ref: MarketRef): Promise<MarketInfo> {
  if (typeof ref !== "string") return ref;
  let list = await listMarkets(ctx);
  let found = findMarket(list, ref);
  if (found === null) {
    list = await listMarkets(ctx, { refresh: true });
    found = findMarket(list, ref);
  }
  if (Array.isArray(found)) {
    throw new InputError("market", `"${ref}" matches several markets (${found.map((m) => m.address).join(", ")}); choose one by its address.`);
  }
  if (found === null) {
    const known = list.map((m) => m.label || m.address).sort().join(", ") || "none";
    throw new InputError("market", `There is no market called "${ref}". Markets: ${known}.`);
  }
  return found;
}

// =====================================================================================================
// Live prices and the venue, as snapshots judge them
// =====================================================================================================

/**
 * Seconds a trading-hours market's feed may go without generating a price, while the price endpoint
 * is otherwise delivering, before its venue counts as closed (PriceService.closed's default).
 */
export const VENUE_CLOSED_AFTER = 15;

/** A price a caller already holds, in BAZAAR precision. */
export interface HeldPrice {
  readonly spot: bigint;
  /** the conservative side for a long (spot less confidence); defaults to spot */
  readonly low?: bigint;
  /** the conservative side for a short (spot plus confidence); defaults to spot */
  readonly high?: bigint;
  readonly publishTime?: number;
}

/** A composed live price for one market, as {@link LivePrices.price} returns it. */
export interface LivePriceQuote {
  readonly spot: bigint;
  readonly low: bigint;
  readonly high: bigint;
  readonly publishTime: number;
}

/** What snapshots read live prices and the venue from: a {@link LivePrices}, or anything shaped like it. */
export interface LivePriceView {
  /** The market's composed live price; null while a leg has no print. */
  price(market: Address): LivePriceQuote | null;
  /** Whether a trading-hours market's venue is closed (its feed stopped printing). */
  venueClosed(market: Address): boolean;
}

/** The price a snapshot valued an account at, and where it came from. */
export interface PriceQuote extends LivePriceQuote {
  /** "given" by the caller, "live" from a LivePrices stream, "pro" from one Pyth Pro request, "stored" on the pair */
  readonly source: "given" | "live" | "pro" | "stored";
}

/** @internal */
export interface ResolvedPrice {
  readonly price: PriceQuote | null;
  /** null when nothing could judge it (no live prices and no Pyth Pro source) */
  readonly venueClosed: boolean | null;
}

interface PrintSource {
  prints(feedIds: readonly Hex[]): Promise<Print[]>;
}

const isPrintSource = (x: unknown): x is PrintSource => !!x && typeof (x as PrintSource).prints === "function";

/** @internal */
export interface ResolveOptions {
  readonly prices?: LivePriceView | null;
  readonly price?: HeldPrice | null;
  readonly fetchPrices?: boolean;
  /** whether a price is wanted for every market (accounts), or only the venue (market snapshots) */
  readonly needPrice: boolean;
}

/**
 * Each market's live price and venue state: from the caller's price, a live view, or one Pyth Pro
 * request for every leg involved (only when the context's source is a {@link proPriceSource} and no
 * live view is given). Never throws: what cannot be judged is null.
 * @internal
 */
export async function resolvePrices(ctx: BazaarContext, markets: readonly MarketStatic[], opts: ResolveOptions): Promise<Map<Address, ResolvedPrice>> {
  const out = new Map<Address, ResolvedPrice>();
  const given: PriceQuote | null = opts.price
    ? {
        spot: opts.price.spot,
        low: opts.price.low ?? opts.price.spot,
        high: opts.price.high ?? opts.price.spot,
        publishTime: opts.price.publishTime ?? 0,
        source: "given",
      }
    : null;
  const view = opts.prices ?? null;
  if (view) {
    for (const m of markets) {
      const live = given ? null : view.price(m.address);
      const price: PriceQuote | null = given ?? (live ? { spot: live.spot, low: live.low, high: live.high, publishTime: live.publishTime, source: "live" } : null);
      out.set(m.address, { price, venueClosed: m.continuous ? false : view.venueClosed(m.address) });
    }
    return out;
  }
  const source = opts.fetchPrices === false ? null : ctx.prices;
  const printer = isPrintSource(source) ? source : null;
  const ask = printer ? markets.filter((m) => (opts.needPrice && !given) || !m.continuous) : [];
  let prints = new Map<Hex, Print>();
  let fetched = false;
  if (ask.length > 0) {
    try {
      const legs = [...new Set(ask.flatMap((m) => m.legs.map((l) => l.toLowerCase() as Hex)))];
      for (const p of await printer!.prints(legs)) prints.set(p.feedId, p);
      fetched = true;
    } catch {
      prints = new Map();
    }
  }
  const now = Date.now() / 1000;
  for (const m of markets) {
    const legs = m.legs.map((l) => prints.get(l.toLowerCase() as Hex));
    const all = legs.every((p) => p !== undefined) ? (legs as Print[]) : null;
    let price: PriceQuote | null = given;
    if (!price && all && opts.needPrice) {
      const pp = pairPrice(all, m.invertQuote);
      if (pp) price = { spot: pp.spot, low: pp.low, high: pp.high, publishTime: pp.publishTime, source: "pro" };
    }
    let venueClosed: boolean | null = m.continuous ? false : null;
    if (!m.continuous && fetched) venueClosed = all ? all.some((p) => now - p.publishTime > VENUE_CLOSED_AFTER) : null;
    out.set(m.address, { price, venueClosed });
  }
  return out;
}

// =====================================================================================================
// Status and flags
// =====================================================================================================

/** Why something a trader may try is refused right now; null where it is not. */
export interface MarketFlagReasons {
  readonly venueClosed: string | null;
  readonly marketOrdersDisabled: string | null;
  readonly positionWithdrawalsFrozen: string | null;
  readonly allWithdrawalsPaused: string | null;
}

/** What the pair refuses right now, as one set of flags a UI can gate its buttons on. */
export interface MarketFlags {
  /**
   * A trading-hours market whose venue is closed: no fresh Pyth price, so the pair runs on its last
   * stored one (fills boxed to 10% of it). Null when nothing could judge it (no live prices given and
   * the context has no Pyth Pro source); always false for a 24/7 market.
   */
  readonly venueClosed: boolean | null;
  /**
   * Market orders are refused: while the venue is closed (they price off the oracle, and the stale
   * fallback cannot bound them; limit orders still work), and with every other order while trading is
   * halted (ADL pending, limbo before a scheduled cutoff, the settlement window, termination).
   */
  readonly marketOrdersDisabled: boolean;
  /**
   * An account that holds a position cannot withdraw collateral: while ADL is pending, while the venue
   * is closed, and whenever all withdrawals are paused. Flat accounts are unaffected by the first two.
   */
  readonly positionWithdrawalsFrozen: boolean;
  /**
   * No account can withdraw collateral: in limbo (from LIMBO_LEAD before a scheduled cutoff until the
   * settlement price is fixed) and while the settlement window is open (price fixed, termination not
   * finalized: until every position is settled, at most 14 days).
   */
  readonly allWithdrawalsPaused: boolean;
  readonly reasons: MarketFlagReasons;
}

const REASON = {
  venueClosed:
    "The venue is closed: this market runs on its last price, with fills held within 10% of it, until the first fresh price at the reopen.",
  terminated: "This market has been terminated: nothing trades any more. Collateral and settled profits can be withdrawn.",
  settling: "The settlement price is fixed: trading has ended while every position is settled at that price.",
  limbo: "Trading has stopped ahead of this market's scheduled termination.",
  adl: "Trading is paused while the market auto-deleverages.",
  marketOrdersClosed: "The venue is closed: market orders need a live price and resume at the reopen. Limit orders still work.",
  withdrawSettling:
    "Withdrawals are paused while every position is settled at the fixed price: they reopen when the market's termination is finalized, at most 14 days after the price was fixed.",
  withdrawLimbo: "Withdrawals are paused: the market has stopped trading ahead of its scheduled termination and is waiting for its settlement price.",
  withdrawAdl:
    "While the market auto-deleverages, collateral cannot be withdrawn from an account that holds a position (flat accounts can still withdraw). This lasts until the crisis clears, or at most 24 hours plus a 30-minute grace.",
  withdrawClosed:
    "The venue is closed: collateral backing an open position can be withdrawn again with the first fresh price at the reopen. Deposits stay open, and accounts without a position are unaffected.",
} as const;

/** Whether `now` is in limbo: a cutoff is scheduled and the block is within LIMBO_LEAD of it (BazaarPair._pastTradingCutoff). */
export function pastTradingCutoff(scheduledTs: number, now: number): boolean {
  return scheduledTs !== 0 && now + LIMBO_LEAD >= scheduledTs;
}

/**
 * The flags for a market state at `now` (a block timestamp), following the pair's own gates:
 * `_requireLiveTrading` (halts), MatchingEngineLib's stale-oracle refusal of market orders,
 * withdrawCollateral's ADL freeze for position holders, CollateralLib's fresh-price requirement for
 * position holders, `_pastTradingCutoff` and `_requireNoSweepWindow` for every account.
 */
export function marketFlags(market: Pick<MarketStatic, "continuous">, s: MarketState, now: number, venueClosed: boolean | null): MarketFlags {
  const closed = market.continuous ? false : venueClosed;
  const settling = s.settlementFixedTs !== 0 && !s.terminated;
  const limbo = !s.terminated && pastTradingCutoff(s.scheduledTs, now);
  const adl = s.adlPending && !s.terminated;

  let marketOrders: string | null = null;
  if (s.terminated) marketOrders = REASON.terminated;
  else if (settling) marketOrders = REASON.settling;
  else if (limbo) marketOrders = REASON.limbo;
  else if (adl) marketOrders = REASON.adl;
  else if (closed) marketOrders = REASON.marketOrdersClosed;

  const allPaused = settling ? REASON.withdrawSettling : limbo ? REASON.withdrawLimbo : null;
  const positionFrozen = allPaused ?? (adl ? REASON.withdrawAdl : closed ? REASON.withdrawClosed : null);

  return {
    venueClosed: closed,
    marketOrdersDisabled: marketOrders !== null,
    positionWithdrawalsFrozen: positionFrozen !== null,
    allWithdrawalsPaused: allPaused !== null,
    reasons: {
      venueClosed: closed ? REASON.venueClosed : null,
      marketOrdersDisabled: marketOrders,
      positionWithdrawalsFrozen: positionFrozen,
      allWithdrawalsPaused: allPaused,
    },
  };
}

// =====================================================================================================
// Snapshots
// =====================================================================================================

/** The pair's stored oracle price (lastPairPrice): what its next call falls back to without a fresh one. */
export interface StoredPrice {
  readonly spot: bigint;
  /** spot less the Pyth confidence (floored at 1 wei) */
  readonly low: bigint;
  /** spot plus the Pyth confidence */
  readonly high: bigint;
  /** the stored print's Pyth publish time (unix seconds) */
  readonly updateTs: number;
  /** seconds between the stored print and the snapshot's block */
  readonly age: number;
  /** the variance EMA the margin curve reads, in basis points */
  readonly emaVarianceBp: bigint;
  /** prices the pair has stored since it was created */
  readonly updateCount: number;
}

export interface FundingView {
  /** The rate the mark's premium implies now, per hour (1e18 = 100%): positive when longs pay shorts. */
  readonly currentRatePerHour: bigint;
  /** The rate the next stored price charges for the window since the index last accrued, per hour. */
  readonly accruingRatePerHour: bigint;
  /** The stored cumulative funding index, in price units. */
  readonly index: bigint;
  /** The index a price stored at this block would leave (BazaarPairLens.fundingRate). */
  readonly projectedIndex: bigint;
  /** When the index last accrued (unix seconds). */
  readonly lastAccrualTs: number;
  /** The per-hour cap: 0.1% on 24/7 markets, 0.5% on trading-hours ones (which accrue only while open). */
  readonly maxRatePerHour: bigint;
}

export interface MarginView {
  /** Initial margin, basis points of notional: what opening, adding and withdrawing must keep. */
  readonly imrBp: bigint;
  /** Maintenance margin now. */
  readonly mmrBp: bigint;
  /** The 24h-lagged maintenance rate (0 before any sample). */
  readonly laggedMmrBp: bigint;
  /** What liquidation judges by: the lower of the current rate and a non-zero lagged one. */
  readonly effectiveMmrBp: bigint;
  /** The most leverage a new position can take: 10,000 / imrBp (null while imrBp is 0). */
  readonly maxLeverage: number | null;
  /** The rate a position must keep as cash collateral when withdrawing: mmrBp on 24/7 markets, imrBp on trading-hours ones. */
  readonly withdrawalFloorBp: bigint;
}

export interface OpenInterestView {
  /** Sizes, BAZAAR precision (1e18 = one unit). */
  readonly long: bigint;
  readonly short: bigint;
  /** At the stored spot. */
  readonly longNotional: bigint;
  readonly shortNotional: bigint;
  /** Liquidated inventory the vault holds, by the side it came from. */
  readonly longInventory: bigint;
  readonly shortInventory: bigint;
}

export interface InsuranceView {
  /** The insurance fund's balance. */
  readonly fund: bigint;
  /** The fund less the seizure earmarked against inventory the vault holds. */
  readonly freeCapital: bigint;
  /** The seizure earmarked against held inventory. */
  readonly seized: bigint;
  /** The insurance target the margin curve last computed, basis points of open interest. */
  readonly targetRatioBp: bigint;
  /** What the deposits ledger owes the fund (cash winners already withdrew). */
  readonly ledgerArrears: bigint;
  /** The deposits ledger: every account's collateral the pair holds. */
  readonly depositsLedger: bigint;
}

export interface AdlView {
  readonly pending: boolean;
  /** Advanced each time an ADL window opens. */
  readonly epoch: number;
  /** When the open window opened (unix seconds; 0 when none). */
  readonly pendingSince: number;
  /** When the auction's score threshold started decaying (restarts after a market closure). */
  readonly auctionStart: number;
  /** When the threshold reaches its floor of 1 (auctionStart + 10 min; 0 when none). */
  readonly auctionEndsAt: number;
  /** When the window times out (pendingSince + 24 h): the timeout then arms termination with a fresh price. */
  readonly timeoutAt: number;
  /** When an armed timeout may terminate the pair (0 while unarmed; armed timeout + 30 min grace). */
  readonly terminationTs: number;
  /** The score a winner must exceed at the snapshot's block (MAX_UINT256 while no auction runs). */
  readonly scoreThreshold: bigint;
}

export interface TerminationView {
  /** The scheduled cutoff (unix seconds; 0 when none). */
  readonly scheduledTs: number;
  /** When trading halts ahead of it: cutoff less LIMBO_LEAD (0 when none). */
  readonly haltsAt: number;
  /** When the settlement price was fixed (0 while not). */
  readonly settlementFixedTs: number;
  /** The fixed settlement price (0 while the pair is live). */
  readonly settlementPrice: bigint;
  /** The latest finalizeTermination can wait: settlementFixedTs + 14 days (0 while not fixed). */
  readonly finalizeBy: number;
  readonly terminated: boolean;
  /** Cash paid per unit of collateral after finalize (1e18 = 100%; 0 before). */
  readonly principalRatio: bigint;
  /** Cash paid per unit of registered profit claim after finalize (1e18 = 100%; 0 before). */
  readonly profitRatio: bigint;
  /** Registered winner profit not yet paid out. */
  readonly profitClaims: bigint;
  /** Settled losses beyond collateral, tallied in the settlement window. */
  readonly badDebt: bigint;
}

export interface BookSummary {
  /** The best bid's and best ask's order ids (0 for an empty side). */
  readonly bidHead: bigint;
  readonly askHead: bigint;
  /** Orders resting on each side. */
  readonly bidCount: number;
  readonly askCount: number;
}

/** A market's live state at one block, with the one status and the flags a UI shows. */
export interface MarketSnapshot extends MarketFlags {
  readonly market: MarketInfo;
  readonly block: number;
  /** The block's timestamp: what the status, the clocks and the flags are judged at. */
  readonly timestamp: number;
  readonly status: Status;
  /** The keeper's state read, as {@link Reader.marketStates} returns it. */
  readonly state: MarketState;
  readonly price: StoredPrice;
  /** The mark at this block (BazaarPairLens.markPrice); 0 before any qualifying print formed one. */
  readonly markPrice: bigint;
  readonly funding: FundingView;
  readonly margin: MarginView;
  readonly openInterest: OpenInterestView;
  readonly insurance: InsuranceView;
  /** Realized bad debt beyond the insurance fund: non-zero means the pair is insolvent and settles. */
  readonly deficit: bigint;
  readonly adl: AdlView;
  readonly termination: TerminationView;
  readonly book: BookSummary;
}

export interface SnapshotOptions {
  /** The block to read at (a watcher passes its head); default the latest. */
  readonly block?: Pick<Block, "number" | "timestamp"> | null;
  /** Live prices to judge the venue of trading-hours markets with ({@link LivePrices}). */
  readonly prices?: LivePriceView | null;
  /**
   * Without live prices, ask the context's Pyth Pro source (a {@link proPriceSource}) for the legs of
   * trading-hours markets, in parallel with the chain read, to judge their venue. Default true.
   */
  readonly fetchPrices?: boolean;
}

/** BazaarPairLens.fundingRate's cap per hour, by calendar (FundingLib.MAX_FUNDING_RATE_*). */
export const MAX_FUNDING_RATE_CONTINUOUS = BAZAAR_SCALE / 1000n;
export const MAX_FUNDING_RATE_SESSION = BAZAAR_SCALE / 200n;

const HOURS_PER_YEAR = 24 * 365;

/**
 * A funding rate per hour (1e18 = 100%, as the lens reports it) as a yearly fraction for display
 * (0.0876 = 8.76% a year). A trading-hours market accrues only while its venue is open, so pass the
 * hours it actually accrues in a year (about 1,700 for a US equity) rather than the default 8,760.
 */
export function annualizedFunding(ratePerHour: bigint, accruingHoursPerYear: number = HOURS_PER_YEAR): number {
  return (Number(ratePerHour) / Number(BAZAAR_SCALE)) * accruingHoursPerYear;
}

/** The most leverage an initial margin rate allows (10,000 / imrBp), or null for a zero rate. */
function leverageFor(imrBp: bigint): number | null {
  return imrBp > 0n ? Number(BP_SCALE) / Number(imrBp) : null;
}

/** The snapshot's status at another time (seconds), for countdowns without a new read. */
export function marketStatusAt(snap: Pick<MarketSnapshot, "state">, now: number): Status {
  return marketStatus(snap.state, now);
}

/** The ADL auction's score threshold at another time, for a live display without a new read. */
export function adlScoreThresholdAt(snap: Pick<MarketSnapshot, "adl">, now: number): bigint {
  return adlThreshold(snap.adl.pending ? snap.adl.auctionStart : 0, now);
}

// The extra reads a snapshot makes beside Reader.marketStates, in order: [function, via the lens].
const SNAPSHOT_READS: readonly (readonly [fn: string, viaLens: boolean])[] = [
  ["markPrice", true],
  ["fundingRate", true],
  ["lastPairPrice", false],
  ["adlPendingSince", false],
  ["adlEpoch", true],
  ["auxState", false],
  ["pairVault", false],
  ["book", false],
];

interface RawAux {
  lastFundingUpdateTs: bigint;
  pairCreatedTs: bigint;
  priceUpdateCount: bigint;
  settlementPrice: bigint;
  terminalPrincipalRatio: bigint;
  terminalProfitRatio: bigint;
  terminalProfitClaims: bigint;
  terminalBadDebt: bigint;
}

interface RawVault {
  totalCollateralDeposited: bigint;
  targetInsuranceRatioBp: bigint;
  ledgerArrears: bigint;
}

/** The extra reads for each market, flat, SNAPSHOT_READS.length per market */
function snapshotReads(ctx: BazaarContext, markets: readonly MarketStatic[]): Read[] {
  const P = pairCodec();
  const L = lensCodec();
  const reads: Read[] = [];
  for (const m of markets) {
    for (const [fn, viaLens] of SNAPSHOT_READS) {
      reads.push(viaLens ? { to: ctx.lens, data: L.encode(fn, m.address) } : { to: m.address, data: P.encode(fn) });
    }
  }
  return reads;
}

function decodeOr<T>(res: readonly [boolean, Hex] | undefined, decode: (data: Hex) => T, fallback: T): T {
  if (!res || !res[0]) return fallback;
  try {
    return decode(res[1]);
  } catch {
    return fallback;
  }
}

/** Assemble one snapshot from the state read, the extra reads (from `offset`) and the venue */
function buildSnapshot(
  market: MarketInfo,
  s: MarketState,
  res: readonly (readonly [boolean, Hex])[],
  offset: number,
  venueClosed: boolean | null,
): MarketSnapshot {
  const P = pairCodec();
  const L = lensCodec();
  const now = s.timestamp;
  const at = (i: number) => res[offset + i];
  const mark = decodeOr(at(0), (d) => L.decode<bigint>("markPrice", d), 0n);
  const fr = decodeOr(at(1), (d) => L.decode<{ currentRate: bigint; accruingRate: bigint; fundingIndex: bigint }>("fundingRate", d), null);
  const lp = decodeOr(
    at(2),
    (d) => P.decode<{ spotPrice: bigint; emaVarianceBp: bigint; updateTs: bigint; lowPrice: bigint; highPrice: bigint }>("lastPairPrice", d),
    null,
  );
  const pendingSince = Number(decodeOr(at(3), (d) => P.decode<bigint>("adlPendingSince", d), 0n));
  const epoch = Number(decodeOr(at(4), (d) => L.decode<bigint>("adlEpoch", d), 0n));
  const aux = decodeOr(at(5), (d) => P.decode<RawAux>("auxState", d), null);
  const vault = decodeOr(at(6), (d) => P.decode<RawVault>("pairVault", d), null);
  const book = decodeOr(at(7), (d) => P.decode<{ bidHead: bigint; askHead: bigint; bidCount: bigint; askCount: bigint }>("book", d), null);

  const effMmr = effectiveMmrBp(s.mmrBp, s.laggedMmrBp);
  const seized = s.longInv.seized + s.shortInv.seized;
  const fixedTs = s.settlementFixedTs;
  return {
    ...marketFlags(market, s, now, venueClosed),
    market,
    block: s.block,
    timestamp: now,
    status: marketStatus(s, now),
    state: s,
    price: {
      spot: s.spot,
      low: lp?.lowPrice ?? s.spot,
      high: lp?.highPrice ?? s.spot,
      updateTs: s.updateTs,
      age: s.updateTs ? now - s.updateTs : 0,
      emaVarianceBp: lp?.emaVarianceBp ?? 0n,
      updateCount: Number(aux?.priceUpdateCount ?? 0n),
    },
    markPrice: mark,
    funding: {
      currentRatePerHour: fr?.currentRate ?? 0n,
      accruingRatePerHour: fr?.accruingRate ?? 0n,
      index: s.fundingIndex,
      projectedIndex: s.projectedFundingIndex,
      lastAccrualTs: Number(aux?.lastFundingUpdateTs ?? 0n),
      maxRatePerHour: market.continuous ? MAX_FUNDING_RATE_CONTINUOUS : MAX_FUNDING_RATE_SESSION,
    },
    margin: {
      imrBp: s.imrBp,
      mmrBp: s.mmrBp,
      laggedMmrBp: s.laggedMmrBp,
      effectiveMmrBp: effMmr,
      maxLeverage: leverageFor(s.imrBp),
      withdrawalFloorBp: market.continuous ? s.mmrBp : s.imrBp,
    },
    openInterest: {
      long: s.longOi,
      short: s.shortOi,
      longNotional: mulDiv(s.longOi, s.spot, BAZAAR_SCALE),
      shortNotional: mulDiv(s.shortOi, s.spot, BAZAAR_SCALE),
      longInventory: s.longInv.size,
      shortInventory: s.shortInv.size,
    },
    insurance: {
      fund: s.insurance,
      freeCapital: freeCapital(s),
      seized,
      targetRatioBp: vault?.targetInsuranceRatioBp ?? 0n,
      ledgerArrears: vault?.ledgerArrears ?? 0n,
      depositsLedger: vault?.totalCollateralDeposited ?? 0n,
    },
    deficit: s.deficit,
    adl: {
      pending: s.adlPending,
      epoch,
      pendingSince,
      auctionStart: s.adlAuctionStart,
      auctionEndsAt: s.adlAuctionStart ? s.adlAuctionStart + ADL_AUCTION_DURATION : 0,
      timeoutAt: s.adlPending && pendingSince ? pendingSince + ADL_TIMEOUT_DURATION : 0,
      terminationTs: s.adlTerminationTs,
      scoreThreshold: adlThreshold(s.adlPending ? s.adlAuctionStart : 0, now),
    },
    termination: {
      scheduledTs: s.scheduledTs,
      haltsAt: s.scheduledTs ? Math.max(0, s.scheduledTs - LIMBO_LEAD) : 0,
      settlementFixedTs: fixedTs,
      settlementPrice: aux?.settlementPrice ?? 0n,
      finalizeBy: fixedTs ? fixedTs + TERMINAL_SETTLEMENT_ESCAPE : 0,
      terminated: s.terminated,
      principalRatio: aux?.terminalPrincipalRatio ?? 0n,
      profitRatio: aux?.terminalProfitRatio ?? 0n,
      profitClaims: aux?.terminalProfitClaims ?? 0n,
      badDebt: aux?.terminalBadDebt ?? 0n,
    },
    book: {
      bidHead: book?.bidHead ?? 0n,
      askHead: book?.askHead ?? 0n,
      bidCount: Number(book?.bidCount ?? 0n),
      askCount: Number(book?.askCount ?? 0n),
    },
  };
}

/** The block to read at: the caller's, or the latest. @internal */
export async function headFor(ctx: BazaarContext, block: Pick<Block, "number" | "timestamp"> | null | undefined): Promise<Pick<Block, "number" | "timestamp">> {
  return block ?? (await ctx.chain.block("latest"));
}

/**
 * Several markets' live state at one block: {@link Reader.marketStates} and the snapshot's own reads
 * (mark, funding rates, the stored price's band, ADL epoch and clocks, termination stamps and ratios,
 * the vault's ledger figures, the book's heads) in two batched calls sent together, plus, for
 * trading-hours markets without live prices, one Pyth Pro request to judge the venue. A market whose
 * core reads fail is left out of the map.
 */
export async function marketSnapshots(
  ctx: BazaarContext,
  markets: readonly MarketRef[],
  opts: SnapshotOptions = {},
): Promise<Map<Address, MarketSnapshot>> {
  const infos = await Promise.all(markets.map((m) => getMarket(ctx, m)));
  const out = new Map<Address, MarketSnapshot>();
  if (infos.length === 0) return out;
  const [head, venues] = await Promise.all([
    headFor(ctx, opts.block),
    resolvePrices(ctx, infos, { prices: opts.prices, fetchPrices: opts.fetchPrices, needPrice: false }),
  ]);
  const [states, res] = await Promise.all([
    readerFor(ctx).marketStates(infos.map(marketFromStatic), head.number, head.timestamp),
    ctx.chain.batch(snapshotReads(ctx, infos), head.number),
  ]);
  const n = SNAPSHOT_READS.length;
  infos.forEach((m, i) => {
    const s = states.get(m.address);
    if (s) out.set(m.address, buildSnapshot(m, s, res, i * n, venues.get(m.address)?.venueClosed ?? null));
  });
  return out;
}

/** One market's live state at one block; see {@link marketSnapshots}. Throws when its core reads fail. */
export async function marketSnapshot(ctx: BazaarContext, market: MarketRef, opts: SnapshotOptions = {}): Promise<MarketSnapshot> {
  const m = await getMarket(ctx, market);
  const snap = (await marketSnapshots(ctx, [m], opts)).get(m.address);
  if (!snap) throw new Error(`could not read the state of market ${m.label || m.address}: its price, margin or vault read failed`);
  return snap;
}

// =====================================================================================================
// Book depth
// =====================================================================================================

/** One price level of the book: every live resting order at that limit price. */
export interface DepthLevel {
  readonly price: bigint;
  /** The level's remaining size (BAZAAR precision). */
  readonly size: bigint;
  /** size × price. */
  readonly notional: bigint;
  /** Resting orders at the level. */
  readonly orders: number;
  /** Remaining size from the best level through this one. */
  readonly cumulative: bigint;
}

export type BookSide = "bids" | "asks";

export interface BookDepth {
  readonly market: Address;
  readonly side: BookSide;
  readonly block: number;
  /** Best first: bids from the highest price down, asks from the lowest up. */
  readonly levels: DepthLevel[];
  /** Every level the side has is here (it has no more than were asked for). */
  readonly complete: boolean;
}

export interface BookDepthOptions {
  /** Orders per BazaarPairLens.getBookDepth page; default levels × 4, between 32 and 200. */
  readonly pageSize?: number;
  /** Stop after this many orders even if fewer levels were found (the last level may then be partial); default 2,000. */
  readonly maxOrders?: number;
  /** The block to read at; default the latest. */
  readonly block?: Pick<Block, "number"> | null;
}

interface RawBookOrder {
  canceledBlock: bigint | number;
  expiryBlock: bigint | number;
  inBook: boolean;
  limitPrice: bigint;
  size: bigint;
  filledSize: bigint;
  filledBlock: bigint | number;
}

/**
 * The best `levels` price levels of one side of the book. Walks the side head to tail with
 * BazaarPairLens.getBookDepth (pages of order ids and limit prices, read until enough distinct prices
 * are seen), then reads the orders' sizes in one batch, drops what is no longer live (filled,
 * canceled, or past its expiry block but not yet swept) and sums each price level. Every read is
 * pinned to one block, so pages are consistent.
 */
export async function getBookDepth(
  ctx: BazaarContext,
  market: MarketRef,
  side: BookSide,
  levels = 20,
  opts: BookDepthOptions = {},
): Promise<BookDepth> {
  if (side !== "bids" && side !== "asks") throw new InputError("side", 'Choose "bids" or "asks".');
  if (!Number.isInteger(levels) || levels < 1 || levels > 1000) throw new InputError("levels", "Ask for between 1 and 1,000 price levels.");
  const m = await getMarket(ctx, market);
  const P = pairCodec();
  const L = lensCodec();
  const isLong = side === "bids";
  const pageSize = BigInt(opts.pageSize ?? Math.min(200, Math.max(32, levels * 4)));
  const maxOrders = opts.maxOrders ?? 2_000;
  const block = opts.block?.number ?? (await ctx.chain.blockNumber());

  const ids: bigint[] = [];
  const prices: bigint[] = [];
  const live: (bigint | null)[] = []; // remaining size of each live order, null when not live
  let start = 0n;
  let exhausted = false;
  let out: DepthLevel[] = [];
  let distinctLive = 0;
  for (;;) {
    const page = L.decode<{ orderIds: readonly bigint[]; prices: readonly bigint[]; nextId: bigint }>(
      "getBookDepth",
      await ctx.chain.call(ctx.lens, L.encode("getBookDepth", m.address, isLong, start, pageSize), { block }),
    );
    ids.push(...page.orderIds);
    prices.push(...page.prices);
    exhausted = page.nextId === 0n || page.orderIds.length === 0;
    start = page.nextId;
    const capped = ids.length >= maxOrders;
    if (!exhausted && !capped && distinctFrom(prices, live.length) + distinctLive <= levels) continue;

    const from = live.length;
    const res = await ctx.chain.batch(
      ids.slice(from).map((id) => ({ to: m.address, data: P.encode("orders", id) })),
      block,
    );
    for (const [ok, data] of res) {
      if (!ok) {
        live.push(null);
        continue;
      }
      const o = P.decode<RawBookOrder>("orders", data);
      const remaining = o.size > o.filledSize ? o.size - o.filledSize : 0n;
      // As the lens's _orderLeg: an order past its expiry block is dead even before a sweep removes it.
      const alive = o.inBook && Number(o.canceledBlock) === 0 && Number(o.filledBlock) === 0 && Number(o.expiryBlock) >= block && remaining > 0n;
      live.push(alive ? remaining : null);
    }
    out = aggregate(prices, live);
    distinctLive = out.length;
    if (distinctLive > levels || exhausted || capped) break;
  }
  return { market: m.address, side, block, levels: out.slice(0, levels), complete: exhausted && distinctLive <= levels };
}

/** Distinct prices among prices[from..] (the book is sorted, so equal prices are adjacent). */
function distinctFrom(prices: readonly bigint[], from: number): number {
  let n = 0;
  for (let i = from; i < prices.length; i++) if (i === from || prices[i] !== prices[i - 1]) n++;
  return n;
}

function aggregate(prices: readonly bigint[], live: readonly (bigint | null)[]): DepthLevel[] {
  const out: DepthLevel[] = [];
  let cumulative = 0n;
  let cur: { price: bigint; size: bigint; orders: number } | null = null;
  const flush = () => {
    if (!cur) return;
    cumulative += cur.size;
    out.push({ price: cur.price, size: cur.size, notional: mulDiv(cur.size, cur.price, BAZAAR_SCALE), orders: cur.orders, cumulative });
    cur = null;
  };
  for (let i = 0; i < live.length; i++) {
    const size = live[i];
    if (size === null || size === undefined) continue;
    const price = prices[i]!;
    if (cur && cur.price === price) {
      cur.size += size;
      cur.orders += 1;
    } else {
      flush();
      cur = { price, size, orders: 1 };
    }
  }
  flush();
  return out;
}

/** Both sides of the book, read together; see {@link getBookDepth}. */
export async function getBook(
  ctx: BazaarContext,
  market: MarketRef,
  levels = 20,
  opts: BookDepthOptions = {},
): Promise<{ bids: BookDepth; asks: BookDepth }> {
  const m = await getMarket(ctx, market);
  const block = opts.block ?? { number: await ctx.chain.blockNumber() };
  const [bids, asks] = await Promise.all([
    getBookDepth(ctx, m, "bids", levels, { ...opts, block }),
    getBookDepth(ctx, m, "asks", levels, { ...opts, block }),
  ]);
  return { bids, asks };
}
