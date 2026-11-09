/** What the SDK knows about each market, its positions and its orders. */

import type { Address, Hex } from "viem";
import { LIMBO_LEAD } from "./constants.js";

export const Status = {
  Live: "live",
  /** an ADL window is open: matching halts, liquidation and ADL run */
  Adl: "adl",
  /** within LIMBO_LEAD of a scheduled cutoff, price not yet fixed */
  Limbo: "limbo",
  /** settlement price fixed, not finalized */
  Settling: "settling",
  Terminated: "terminated",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export interface Inventory {
  size: bigint;
  entryNotional: bigint;
  bankruptcyNotional: bigint;
  seized: bigint;
  entryFundingIndex: bigint;
  seizedTs: number;
}

export const emptyInventory = (): Inventory => ({
  size: 0n,
  entryNotional: 0n,
  bankruptcyNotional: 0n,
  seized: 0n,
  entryFundingIndex: 0n,
  seizedTs: 0,
});

/** One read of a market's on-chain state (Reader.marketStates). */
export interface MarketState {
  block: number;
  timestamp: number;
  spot: bigint;
  updateTs: number;
  imrBp: bigint;
  mmrBp: bigint;
  laggedMmrBp: bigint;
  fundingIndex: bigint;
  projectedFundingIndex: bigint;
  adlPending: boolean;
  adlAuctionStart: number;
  adlTerminationTs: number;
  settlementFixedTs: number;
  scheduledTs: number;
  terminated: boolean;
  longOi: bigint;
  shortOi: bigint;
  insurance: bigint;
  deficit: bigint;
  longInv: Inventory;
  shortInv: Inventory;
}

/** The insurance balance less the seizure earmarked against inventory the vault holds. */
export function freeCapital(s: MarketState): bigint {
  const seized = s.longInv.seized + s.shortInv.seized;
  return s.insurance > seized ? s.insurance - seized : 0n;
}

export function inventorySize(s: MarketState): bigint {
  return s.longInv.size + s.shortInv.size;
}

export function marketStatus(s: MarketState, now: number): Status {
  if (s.terminated) return Status.Terminated;
  if (s.settlementFixedTs) return Status.Settling;
  if (s.scheduledTs && now + LIMBO_LEAD >= s.scheduledTs) return Status.Limbo;
  if (s.adlPending) return Status.Adl;
  return Status.Live;
}

export interface Market {
  address: Address;
  pairId: Hex;
  baseFeedId: Hex;
  /** raw Pyth feed ids: one, or two for a composite */
  legs: Hex[];
  invertQuote: boolean;
  /** traded 24/7, as opposed to a market with trading hours */
  continuous: boolean;
  description: string;
  label: string;
  state: MarketState | null;
  dirty: boolean;
  /** ms since epoch of the last state read */
  lastRead: number;
}

/** The part of a Market that never changes, as stored in snapshots. */
export interface MarketStatic {
  address: Address;
  pairId: Hex;
  baseFeedId: Hex;
  legs: Hex[];
  invertQuote: boolean;
  continuous: boolean;
  description: string;
  label: string;
}

export function marketStatic(m: Market): MarketStatic {
  const { address, pairId, baseFeedId, legs, invertQuote, continuous, description, label } = m;
  return { address, pairId, baseFeedId, legs: [...legs], invertQuote, continuous, description, label };
}

export function marketFromStatic(d: MarketStatic): Market {
  return { ...d, legs: [...d.legs], description: d.description ?? "", label: d.label ?? "", state: null, dirty: true, lastRead: 0 };
}

export interface Position {
  account: Address;
  isLong: boolean;
  size: bigint;
  entryValue: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  block: number;
}

export interface Order {
  orderId: bigint;
  owner: Address;
  orderType: number;
  isLong: boolean;
  size: bigint;
  filled: bigint;
  triggerPrice: bigint;
  limitPrice: bigint;
  expiryBlock: number;
  terminal: boolean;
  /** null until read from the chain; events do not report it */
  inBook: boolean | null;
  bounty: bigint;
  block: number;
  /** false for a stub created by a bounty event that preceded the order's own */
  known: boolean;
}

export function orderRemaining(o: Order): bigint {
  return o.size > o.filled ? o.size - o.filled : 0n;
}
