/**
 * History from Bazaar's subgraph: the trade tape, candles, an account's orders, positions and cash
 * movements, fees and rewards, liquidations and ADL, insurance, termination, governance and listings.
 *
 * Every query here reads `ctx.subgraph` ({@link requireSubgraph}); {@link httpSubgraph} is a
 * browser-safe source over `fetch`. Results are converted to SDK units on the way out: amounts
 * (prices, sizes, notionals, collateral, fees, shares, funding indices, payout ratios, bp rates) are
 * `bigint` in BAZAAR precision (1e18 = $1 or one unit), except the fields whose names end in `Usdc`,
 * which are USDC units (6 decimals) as the subgraph stores them; timestamps (Unix seconds), block
 * numbers (Arbitrum L2 blocks, the numbers order expiry uses), counts and enum codes are `number`;
 * addresses are checksummed and other bytes are lowercase `Hex`.
 *
 * Lists come back as a {@link Page}: pass `page.next` as `after` to read the next one. Lists ordered
 * by `id` page with an `id_gt` cursor; lists ordered by time (or price) page with a cursor on that
 * value, using `skip` only to step over rows that share the last value of the previous page, so a
 * page never repeats or drops a row while history is appended. `from`/`to` bound the list's order
 * field (time, or the candle's period start), `from` inclusive and `to` exclusive.
 *
 * The subgraph lags the chain by a few blocks, more when its indexer is behind: {@link subgraphLag}
 * says how far, so a UI can show that its history is not yet current. Live values the contracts do
 * not emit (the mark price, the insurance share price, the vault's inventory) are not indexed: read
 * them from the chain.
 */

import { type Address, type Hex, getAddress } from "viem";
import { TRIGGER_PRICE_MASK } from "../constants.js";
import { redactUrl } from "../urls.js";
import { InputError } from "./calls.js";
import { type BazaarContext, type SubgraphSource, requireSubgraph } from "./context.js";

// =====================================================================================================
// Transport
// =====================================================================================================

/** The subgraph refused or failed a query. Its message never carries the endpoint's raw URL. */
export class SubgraphError extends Error {
  override readonly name = "SubgraphError";
  constructor(
    message: string,
    /** The HTTP status, when the endpoint answered with one. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface HttpSubgraphOptions {
  /** Per-request timeout in milliseconds (default 30 s). */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** The fetch to use (default `globalThis.fetch`). */
  fetch?: typeof fetch;
}

/**
 * A {@link SubgraphSource} over HTTP: each query is a JSON POST of `{query, variables}` to `url`, with
 * `Authorization: Bearer <apiKey>` when a key is given (The Graph's gateway also accepts the key in
 * the URL path; such a URL is redacted in every error). Works in browsers and in Node 20+.
 */
export function httpSubgraph(url: string, apiKey?: string | null, opts: HttpSubgraphOptions = {}): SubgraphSource {
  const display = redactUrl(url);
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...(opts.headers ?? {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const scrub = (s: string) => (url ? s.split(url).join(display) : s);
  return {
    async query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
      let r: Response;
      try {
        r = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables: variables ?? {} }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new SubgraphError(`the subgraph at ${display} is unreachable: ${scrub(msg)}`);
      }
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? ": the endpoint refused the request; check the API key" : "";
        throw new SubgraphError(`HTTP ${r.status} from the subgraph at ${display}${hint}`, r.status);
      }
      let out: { data?: T; errors?: { message?: string }[] };
      try {
        out = (await r.json()) as typeof out;
      } catch {
        throw new SubgraphError(`the subgraph at ${display} did not answer with JSON`, r.status);
      }
      if (out.errors && out.errors.length) {
        const msg = out.errors.map((e) => e.message ?? "").join("; ").slice(0, 500);
        throw new SubgraphError(`the subgraph refused the query: ${scrub(msg)}`, r.status);
      }
      if (out.data === undefined || out.data === null) throw new SubgraphError(`the subgraph at ${display} returned no data`, r.status);
      return out.data;
    },
  };
}

// =====================================================================================================
// Enums (the contracts' declaration order: the index is the on-chain code)
// =====================================================================================================

export const ORDER_TYPES = ["Market", "Limit", "StopLimit", "TakeProfit", "StopLoss"] as const;
export type OrderTypeName = (typeof ORDER_TYPES)[number];
export const TIME_IN_FORCE = ["GTC", "IOC", "FOK"] as const;
export type TimeInForceName = (typeof TIME_IN_FORCE)[number];
export const ORDER_STATUSES = ["Waiting", "Pending", "Resting", "Fired", "Filled", "Canceled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Statuses of an order that can still trade. */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ["Waiting", "Resting", "Fired"];
export const CANCEL_REASONS = [
  "None",
  "Owner",
  "Expired",
  "Unfilled",
  "BelowMinimum",
  "PostOnly",
  "SelfMatch",
  "StepLimit",
  "Margin",
  "PriceBand",
  "PositionClosed",
  "Liquidated",
  "Deleveraged",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export const AMEND_SKIP_REASONS = ["Inactive", "Expired", "SizeFilled", "BelowMinimum", "WouldCross"] as const;
export type AmendSkipReason = (typeof AMEND_SKIP_REASONS)[number];
export const ORDER_EVENT_ACTIONS = ["Created", "Triggered", "Canceled", "Amended", "AmendSkipped"] as const;
export type OrderEventAction = (typeof ORDER_EVENT_ACTIONS)[number];
export const PAIR_STATUSES = ["Active", "Scheduled", "SettlementFixed", "Terminated"] as const;
export type PairStatus = (typeof PAIR_STATUSES)[number];
export const SETTLEMENT_SOURCES = ["Cutoff", "Stale", "Insolvency"] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];
export const INSURANCE_EVENT_KINDS = [
  "Deposit",
  "WithdrawalRequested",
  "WithdrawalLocked",
  "WithdrawalExecuted",
  "LevyCharged",
  "LevyReceived",
] as const;
export type InsuranceEventKind = (typeof INSURANCE_EVENT_KINDS)[number];
export const LISTING_STATUSES = ["Pending", "Disputed", "Deployed", "Rejected", "Expired", "Voided"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export const IDENTIFIER_UPGRADE_STATUSES = ["Pending", "Disputed", "Queued", "Upgraded", "Canceled", "Expired", "Rejected"] as const;
export type IdentifierUpgradeStatus = (typeof IDENTIFIER_UPGRADE_STATUSES)[number];
export const TERMINATION_PROPOSAL_STATUSES = ["Pending", "Disputed", "Accepted", "ScheduleRefused", "Superseded", "Rejected"] as const;
export type TerminationProposalStatus = (typeof TERMINATION_PROPOSAL_STATUSES)[number];
export const INSURER_PROPOSAL_STATUSES = ["Open", "Scheduled", "Failed", "Preempted", "Voided", "Rejected"] as const;
export type InsurerProposalStatus = (typeof INSURER_PROPOSAL_STATUSES)[number];

/** BazaarTypes.CancelReason's code (as an OrderUpdated payload carries it) -> its name. */
export function cancelReasonName(code: number): CancelReason {
  const n = CANCEL_REASONS[code];
  if (n === undefined) throw new RangeError(`unknown cancel reason code ${code}`);
  return n;
}

/** Why an order was canceled, in a sentence for its owner. */
export const CANCEL_REASON_TEXT: Readonly<Record<CancelReason, string>> = {
  None: "Not canceled.",
  Owner: "You canceled it.",
  Expired: "It reached its expiry block.",
  Unfilled: "The book could not fill all of it on arrival; a market or immediate-or-cancel order cancels what is left.",
  BelowMinimum: "What was left of it was worth less than the $5 order minimum, so it could not rest.",
  PostOnly: "It was post-only and would have filled on arrival, so it was canceled instead of taking liquidity.",
  SelfMatch: "It would have traded against another order of yours.",
  StepLimit: "It crossed more resting orders than one transaction may walk; the rest was canceled.",
  Margin: "Your collateral could not cover this fill (its margin or its fee) when it was reached, so it was canceled. Add collateral and place it again.",
  PriceBand: "While the market was closed it would have filled more than 10% away from the last price.",
  PositionClosed: "The position it protected was closed or flipped, leaving nothing for it to close.",
  Liquidated: "Your position was liquidated.",
  Deleveraged: "Your position was closed in full by auto-deleveraging.",
};

/** The candle intervals the subgraph keeps, in seconds: 1m, 5m, 15m, 1h, 4h, 1d. */
export const CANDLE_INTERVALS = [60, 300, 900, 3600, 14400, 86400] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

// =====================================================================================================
// Entities
// =====================================================================================================

/** One fill. A vault fill (the pair unloading liquidated inventory) names the pair itself as taker. */
export interface Trade {
  id: Hex;
  pair: Address;
  maker: Address;
  /** The pair's own address for a vault fill. */
  taker: Address;
  isVaultFill: boolean;
  takerIsLong: boolean;
  makerOrderId: bigint;
  /** null for a vault fill. */
  takerOrderId: bigint | null;
  size: bigint;
  /** The maker's limit price. */
  price: bigint;
  notional: bigint;
  /** Integrator and insurance legs together. */
  makerFee: bigint;
  takerFee: bigint;
  makerRemaining: bigint;
  takerRemaining: bigint;
  makerIntegrator: Address;
  takerIntegrator: Address;
  /** The transaction sender: for a vault fill, the keeper that ran the unload. */
  txFrom: Address;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
}

/** OHLCV over fills. Periods without fills have no candle: see {@link fillCandleGaps}. */
export interface Candle {
  id: string;
  pair: Address;
  interval: number;
  periodStart: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeSize: bigint;
  volumeNotional: bigint;
  tradeCount: number;
}

export interface PairDayData {
  id: string;
  pair: Address;
  /** Start of the UTC day. */
  date: number;
  volumeSize: bigint;
  volumeNotional: bigint;
  tradeCount: number;
  makerFees: bigint;
  takerFees: bigint;
  open: bigint | null;
  high: bigint | null;
  low: bigint | null;
  close: bigint | null;
  liquidationCount: number;
  liquidatedNotional: bigint;
  /** As of the day's last update. */
  openInterestLong: bigint;
  openInterestShort: bigint;
  fundingIndex: bigint;
  insuranceDeposited: bigint;
  insuranceWithdrawn: bigint;
}

export interface HistoryOrder {
  /** "<pair>-<orderId>" */
  id: string;
  pair: Address;
  orderId: bigint;
  owner: Address;
  orderType: OrderTypeName;
  isLong: boolean;
  isPostOnly: boolean;
  timeInForce: TimeInForceName;
  /** Zero address when the order carries no integrator. */
  integrator: Address;
  /** A TP/SL reports the size its owner set at creation, and the size capped at the position once it fires. */
  size: bigint;
  filledSize: bigint;
  /** 0 once filled or canceled. */
  remaining: bigint;
  /** The trigger price alone (the keeper bounty is reported separately). */
  triggerPrice: bigint;
  limitPrice: bigint;
  maxSlippageBp: bigint;
  /** A resting order past this block stays in the book until a transaction removes it. */
  expiryBlock: number;
  prioritySeq: number;
  status: OrderStatus;
  inBook: boolean;
  cancelReason: CancelReason;
  createdBlock: number;
  createdTimestamp: number;
  createdTx: Hex;
  triggerCount: number;
  lastTriggeredTimestamp: number | null;
  canceledBlock: number | null;
  canceledTimestamp: number | null;
  filledBlock: number | null;
  filledTimestamp: number | null;
  updatedTimestamp: number;
  amendCount: number;
  fillCount: number;
  bountyEscrowed: bigint;
  bountyHeld: bigint;
  bountyPaidToKeepers: bigint;
  bountyRefunded: bigint;
}

/** One OrderUpdated, OrderAmended or OrderAmendSkipped log. */
export interface OrderEvent {
  id: Hex;
  pair: Address;
  orderId: bigint;
  owner: Address;
  action: OrderEventAction;
  cancelReason: CancelReason;
  amendSkipReason: AmendSkipReason | null;
  size: bigint;
  filledSize: bigint;
  limitPrice: bigint;
  triggerPrice: bigint;
  prioritySeq: number;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
}

export interface HistoryPosition {
  /** "<pair>-<account>" */
  id: string;
  pair: Address;
  account: Address;
  isLong: boolean;
  size: bigint;
  entryValue: bigint;
  /** entryValue / size; 0 when flat. */
  entryPrice: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  /** The pair's funding index the latest position event carried. */
  fundingIndexAtUpdate: bigint;
  imrBp: bigint;
  mmrBp: bigint;
  isOpen: boolean;
  takeProfitOrderId: bigint | null;
  stopLossOrderId: bigint | null;
  /** Price PnL realized by fills, plus ADL credits (funding settles into collateral and is not counted). */
  realizedPnl: bigint;
  feesPaid: bigint;
  tradeCount: number;
  volumeSize: bigint;
  volumeNotional: bigint;
  collateralDeposited: bigint;
  collateralWithdrawn: bigint;
  liquidationCount: number;
  adlCount: number;
  openedAtTimestamp: number | null;
  closedAtTimestamp: number | null;
  updatedAtBlock: number;
  updatedAtTimestamp: number;
}

/** The full stored position a PositionBucketUpdated log reported. */
export interface PositionSnapshot {
  id: Hex;
  pair: Address;
  account: Address;
  isLong: boolean;
  size: bigint;
  entryValue: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  globalFundingIndex: bigint;
  /** 0 when the event reported no margin rates (terminal settlement). */
  imrBp: bigint;
  mmrBp: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
}

/** A trade's effect on one position: the maker's per fill, the taker's once per order walk at its VWAP. */
export interface PositionChange {
  id: Hex;
  pair: Address;
  account: Address;
  /** The side after the change. */
  isLong: boolean;
  /** New size less the old (both unsigned): a flip reports less than it traded. */
  sizeDelta: bigint;
  newSize: bigint;
  newEntryValue: bigint;
  newCollateral: bigint;
  executionPrice: bigint;
  fee: bigint;
  /** Price PnL of the size closed. */
  realizedPnl: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
}

export interface CollateralTransfer {
  id: Hex;
  pair: Address;
  account: Address;
  isDeposit: boolean;
  amount: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** A recipient's claimable balance on one pair: integrator fees, keeper rewards, relayer fees, refunds. */
export interface FeeBalance {
  id: string;
  pair: Address;
  recipient: Address;
  accrued: bigint;
  claimed: bigint;
  claimable: bigint;
}

/** One credit to a claimable balance (FeeAccrued), or one claim of it (FeesClaimed). */
export interface FeeMovement {
  id: Hex;
  pair: Address;
  recipient: Address;
  amount: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

export interface Liquidation {
  id: Hex;
  pair: Address;
  account: Address;
  liquidator: Address;
  size: bigint;
  isLong: boolean;
  bankruptcyPrice: bigint;
  /** The price the liquidation ran at. */
  price: bigint;
  notional: bigint;
  collateralSeized: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** One ADL window, from the AdlTriggered that opened it to AdlResolved or the pair's termination. */
export interface AdlWindow {
  /** "<pair>-<epoch>" */
  id: string;
  pair: Address;
  epoch: number;
  openedAt: number;
  openedPrice: bigint;
  openedFundingIndex: bigint;
  terminationTs: number | null;
  resolvedAt: number | null;
  endedByTermination: boolean;
  batchCount: number;
}

/** One executeAdl call. Join {@link AdlFill}s on transactionHash for the winners it closed. */
export interface AdlBatch {
  id: Hex;
  pair: Address;
  /** The window's id, "<pair>-<epoch>". */
  window: string | null;
  adlId: bigint;
  submitter: Address;
  longBucketClosed: bigint;
  /** 0 when that leg did not run. */
  longBucketSettlementPrice: bigint;
  shortBucketClosed: bigint;
  shortBucketSettlementPrice: bigint;
  netted: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** One winner an ADL batch closed, fully or in part. */
export interface AdlFill {
  id: Hex;
  pair: Address;
  account: Address;
  isLong: boolean;
  closedSize: bigint;
  /** Credited to the winner's collateral: PnL at the settlement price less withheld funding. */
  credit: bigint;
  remainingCollateral: bigint;
  adlScore: bigint;
  settlementPrice: bigint;
  withheldFunding: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

export interface InsuranceProvider {
  /** "<pair>-<account>" */
  id: string;
  pair: Address;
  account: Address;
  /** Live share balance; a dead-pool reset sets every balance to 0. */
  shares: bigint;
  deposited: bigint;
  withdrawn: bigint;
  depositCount: number;
  /** Shares named by the request in force; 0 when none. */
  requestedShares: bigint;
  requestedAt: number | null;
  /** What the first execute call recorded the requested shares as worth. */
  lockedAmount: bigint | null;
  /** When the paying execute call opens. */
  claimOpensTs: number | null;
  levyChargedShares: bigint;
  levyReceivedShares: bigint;
  createdTimestamp: number;
}

export interface InsuranceEvent {
  id: Hex;
  pair: Address;
  account: Address;
  kind: InsuranceEventKind;
  /** USD deposited, locked or paid; 0 for requests and levies. */
  amount: bigint;
  shares: bigint;
  claimOpensTs: number | null;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

export interface PairTermination {
  id: Hex;
  pair: Address;
  settlementPrice: bigint;
  owedToTraders: bigint;
  registeredClaims: bigint;
  badDebt: bigint;
  estateValue: bigint;
  pot: bigint;
  /** 1e18 = 100%. */
  principalRatio: bigint;
  profitRatio: bigint;
  insuranceFundBalanceAfter: bigint;
  /** False when finalize ran through the escape hatch with positions still open. */
  sweepComplete: boolean;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** A post-finalize settlement re-derived the payout ratios on the entitlements still unpaid. */
export interface TerminalRatioUpdate {
  id: Hex;
  pair: Address;
  unfunded: bigint;
  principalRatio: bigint;
  profitRatio: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** A UMA termination claim. Every claim also opens an insurer vote under the same id. */
export interface TerminationProposal {
  /** The UMA assertion id. */
  id: Hex;
  pair: Address;
  proposer: Address;
  category: number;
  /** The cutoff the claim proposed. */
  lastTradingTs: number;
  reason: string;
  status: TerminationProposalStatus;
  disputed: boolean;
  acceptedCutoffTs: number | null;
  submittedAt: number;
  /** From when an undisputed claim can be settled. */
  livenessEndsAt: number;
  resolvedAt: number | null;
  transactionHash: Hex;
}

export interface InsurerProposal {
  /** The proposal id: the UMA assertion id for a claim-backed vote. */
  id: Hex;
  pair: Address;
  proposer: Address;
  cutoffTs: number;
  windowOpenTs: number;
  claimBacked: boolean;
  snapshotTotalShares: bigint | null;
  snapshotShareEpoch: number | null;
  yesShares: bigint;
  status: InsurerProposalStatus;
  thresholdMet: boolean | null;
  /** 1 TRUE, 2 FALSE, 3 UNJUDGED. */
  outcome: number | null;
  costed: boolean | null;
  levyBp: bigint | null;
  bondRefundFailed: boolean;
  createdAt: number;
  resolvedAt: number | null;
  transactionHash: Hex;
}

export interface InsurerVote {
  id: Hex;
  proposal: Hex;
  pair: Address;
  voter: Address;
  amount: bigint;
  totalYesShares: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

export interface InsurerLevy {
  id: Hex;
  proposal: Hex;
  pair: Address;
  voter: Address;
  votedShares: bigint;
  levyShares: bigint;
  /** Zero address when the shares stay locked in the fund. */
  recipient: Address;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

export interface ListingProposal {
  /** The UMA assertion id. */
  id: Hex;
  pairId: Hex;
  deployer: Address;
  baseFeedId: Hex;
  description: string;
  seedAmount: bigint;
  status: ListingStatus;
  disputed: boolean;
  proposedAt: number;
  livenessEndsAt: number;
  resolvedAt: number | null;
  /** The deployed pair, once deployed. */
  pair: Address | null;
  /** Seed credited back to the deployer, in USDC units (6 decimals). */
  seedRefundUsdc: bigint | null;
  transactionHash: Hex;
}

export interface IdentifierUpgradeProposal {
  id: Hex;
  proposer: Address;
  newIdentifier: Hex;
  status: IdentifierUpgradeStatus;
  disputed: boolean;
  proposedAt: number;
  livenessEndsAt: number;
  /** When a queued upgrade's timelock ends. */
  effectiveTs: number | null;
  oldIdentifier: Hex | null;
  resolvedAt: number | null;
  transactionHash: Hex;
}

/** What one integrator address has routed. Its fee revenue is the recipient's {@link FeeBalance}s. */
export interface IntegratorStats {
  integrator: Address;
  orderCount: number;
  /** Fill sides that carried this integrator: one with it on both sides counts twice. */
  fillCount: number;
  makerVolumeNotional: bigint;
  takerVolumeNotional: bigint;
  firstOrderTimestamp: number;
  lastFillTimestamp: number | null;
}

export interface AccountStats {
  account: Address;
  firstSeenTimestamp: number;
  tradeCount: number;
  makerVolumeNotional: bigint;
  takerVolumeNotional: bigint;
  feesPaid: bigint;
  realizedPnl: bigint;
  liquidationCount: number;
  liquidationsExecuted: number;
  triggerBountiesEarned: bigint;
  triggerExecutions: number;
  adlBatchesExecuted: number;
  /** Every credit to a claimable balance on any pair: integrator fees, keeper rewards, relayer fees, refunds. */
  feesAccrued: bigint;
  feesClaimed: bigint;
  /** USDC units (6 decimals). */
  seedRefundOwedUsdc: bigint;
}

export interface AccountDayData {
  id: string;
  account: Address;
  date: number;
  makerVolumeNotional: bigint;
  takerVolumeNotional: bigint;
  tradeCount: number;
  feesPaid: bigint;
  realizedPnl: bigint;
}

export interface ProtocolDayData {
  id: string;
  date: number;
  volumeNotional: bigint;
  tradeCount: number;
  makerFees: bigint;
  takerFees: bigint;
  liquidationCount: number;
  uniqueTraders: number;
}

export interface MetaTransaction {
  id: Hex;
  pair: Address;
  user: Address;
  relayer: Address;
  /** The EIP-712 typehash of the relayed action. */
  functionId: Hex;
  nonce: bigint;
  relayerFee: bigint;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** An ERC-2612 permit the pair could not execute; the call went on with the existing allowance. */
export interface PermitFailure {
  id: Hex;
  pair: Address;
  owner: Address;
  blockNumber: number;
  timestamp: number;
  transactionHash: Hex;
}

/** Resting size at one price on one side. Counts expired orders until a transaction removes them. */
export interface BookLevel {
  id: string;
  pair: Address;
  isBid: boolean;
  price: bigint;
  size: bigint;
  orderCount: number;
}

// =====================================================================================================
// Field specs: what to select and how each value converts
// =====================================================================================================

type Kind = "big" | "big?" | "num" | "num?" | "bp" | "bp?" | "addr" | "addr?" | "hex" | "hex?" | "str" | "str?" | "bool" | "bool?" | "trig";
/** A field read as-is, or `[subgraph field, nested field ("" for none), kind]`. */
type Field = Kind | readonly [string, string, Kind];
type Fields<T> = { readonly [P in keyof T]-?: Field };

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

function convert(kind: Kind, v: unknown, name: string): unknown {
  const optional = kind.endsWith("?");
  if (v === null || v === undefined) {
    if (optional) return null;
    throw new SubgraphError(`the subgraph returned no ${name}`);
  }
  switch (kind.replace("?", "")) {
    case "big":
      return BigInt(v as string);
    case "trig":
      return BigInt(v as string) & TRIGGER_PRICE_MASK;
    case "num":
      return Number(v);
    case "bp":
      return BigInt(v as number | string);
    case "addr":
      return getAddress(v as string);
    case "hex":
      return (v as string).toLowerCase() as Hex;
    case "bool":
      return Boolean(v);
    default:
      return String(v);
  }
}

function selection<T>(fields: Fields<T>, extra: readonly string[] = []): string {
  const parts = new Set<string>(extra);
  for (const [k, f] of Object.entries(fields) as [string, Field][]) {
    if (typeof f === "string") parts.add(k);
    else parts.add(f[1] ? `${f[0]} { ${f[1]} }` : f[0]);
  }
  return [...parts].join(" ");
}

function mapRow<T>(fields: Fields<T>, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields) as [string, Field][]) {
    if (typeof f === "string") {
      out[k] = convert(f, row[k], k);
    } else {
      const raw = row[f[0]];
      const v = f[1] ? (raw && typeof raw === "object" ? (raw as Record<string, unknown>)[f[1]] : null) : raw;
      out[k] = convert(f[2], v, k);
    }
  }
  return out as T;
}

const tx = { blockNumber: "num", timestamp: "num", transactionHash: "hex" } as const;
const ref = (f: string, kind: Kind = "addr") => [f, "id", kind] as const;

const TRADE: Fields<Trade> = {
  id: "hex",
  pair: ref("pair"),
  maker: ref("maker"),
  taker: "addr",
  isVaultFill: "bool",
  takerIsLong: "bool",
  makerOrderId: ["makerOrder", "orderId", "big"],
  takerOrderId: ["takerOrder", "orderId", "big?"],
  size: "big",
  price: "big",
  notional: "big",
  makerFee: "big",
  takerFee: "big",
  makerRemaining: "big",
  takerRemaining: "big",
  makerIntegrator: "addr",
  takerIntegrator: "addr",
  txFrom: "addr",
  ...tx,
  logIndex: "num",
};

const CANDLE: Fields<Candle> = {
  id: "str",
  pair: ref("pair"),
  interval: "num",
  periodStart: "num",
  open: "big",
  high: "big",
  low: "big",
  close: "big",
  volumeSize: "big",
  volumeNotional: "big",
  tradeCount: "num",
};

const PAIR_DAY: Fields<PairDayData> = {
  id: "str",
  pair: ref("pair"),
  date: "num",
  volumeSize: "big",
  volumeNotional: "big",
  tradeCount: "num",
  makerFees: "big",
  takerFees: "big",
  open: "big?",
  high: "big?",
  low: "big?",
  close: "big?",
  liquidationCount: "num",
  liquidatedNotional: "big",
  openInterestLong: "big",
  openInterestShort: "big",
  fundingIndex: "big",
  insuranceDeposited: "big",
  insuranceWithdrawn: "big",
};

const ORDER: Fields<HistoryOrder> = {
  id: "str",
  pair: ref("pair"),
  orderId: "big",
  owner: ref("owner"),
  orderType: "str",
  isLong: "bool",
  isPostOnly: "bool",
  timeInForce: "str",
  integrator: "addr",
  size: "big",
  filledSize: "big",
  remaining: "big",
  triggerPrice: "trig",
  limitPrice: "big",
  maxSlippageBp: "big",
  expiryBlock: "num",
  prioritySeq: "num",
  status: "str",
  inBook: "bool",
  cancelReason: "str",
  createdBlock: "num",
  createdTimestamp: "num",
  createdTx: "hex",
  triggerCount: "num",
  lastTriggeredTimestamp: "num?",
  canceledBlock: "num?",
  canceledTimestamp: "num?",
  filledBlock: "num?",
  filledTimestamp: "num?",
  updatedTimestamp: "num",
  amendCount: "num",
  fillCount: "num",
  bountyEscrowed: "big",
  bountyHeld: "big",
  bountyPaidToKeepers: "big",
  bountyRefunded: "big",
};

const ORDER_EVENT: Fields<OrderEvent> = {
  id: "hex",
  pair: ref("pair"),
  orderId: ["order", "orderId", "big"],
  owner: ref("owner"),
  action: "str",
  cancelReason: "str",
  amendSkipReason: "str?",
  size: "big",
  filledSize: "big",
  limitPrice: "big",
  triggerPrice: "trig",
  prioritySeq: "num",
  ...tx,
  logIndex: "num",
};

const POSITION: Fields<HistoryPosition> = {
  id: "str",
  pair: ref("pair"),
  account: ref("account"),
  isLong: "bool",
  size: "big",
  entryValue: "big",
  entryPrice: "big",
  collateral: "big",
  entryFundingIndex: "big",
  fundingIndexAtUpdate: "big",
  imrBp: "big",
  mmrBp: "big",
  isOpen: "bool",
  takeProfitOrderId: ["takeProfitOrder", "orderId", "big?"],
  stopLossOrderId: ["stopLossOrder", "orderId", "big?"],
  realizedPnl: "big",
  feesPaid: "big",
  tradeCount: "num",
  volumeSize: "big",
  volumeNotional: "big",
  collateralDeposited: "big",
  collateralWithdrawn: "big",
  liquidationCount: "num",
  adlCount: "num",
  openedAtTimestamp: "num?",
  closedAtTimestamp: "num?",
  updatedAtBlock: "num",
  updatedAtTimestamp: "num",
};

const SNAPSHOT: Fields<PositionSnapshot> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  isLong: "bool",
  size: "big",
  entryValue: "big",
  collateral: "big",
  entryFundingIndex: "big",
  globalFundingIndex: "big",
  imrBp: "big",
  mmrBp: "big",
  ...tx,
  logIndex: "num",
};

const CHANGE: Fields<PositionChange> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  isLong: "bool",
  sizeDelta: "big",
  newSize: "big",
  newEntryValue: "big",
  newCollateral: "big",
  executionPrice: "big",
  fee: "big",
  realizedPnl: "big",
  ...tx,
  logIndex: "num",
};

const COLLATERAL: Fields<CollateralTransfer> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  isDeposit: "bool",
  amount: "big",
  ...tx,
};

const FEE_BALANCE: Fields<FeeBalance> = {
  id: "str",
  pair: ref("pair"),
  recipient: ref("recipient"),
  accrued: "big",
  claimed: "big",
  claimable: "big",
};

const FEE_MOVE: Fields<FeeMovement> = { id: "hex", pair: ref("pair"), recipient: ref("recipient"), amount: "big", ...tx };

const LIQUIDATION: Fields<Liquidation> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  liquidator: ref("liquidator"),
  size: "big",
  isLong: "bool",
  bankruptcyPrice: "big",
  price: "big",
  notional: "big",
  collateralSeized: "big",
  ...tx,
};

const ADL_WINDOW: Fields<AdlWindow> = {
  id: "str",
  pair: ref("pair"),
  epoch: "num",
  openedAt: "num",
  openedPrice: "big",
  openedFundingIndex: "big",
  terminationTs: "num?",
  resolvedAt: "num?",
  endedByTermination: "bool",
  batchCount: "num",
};

const ADL_BATCH: Fields<AdlBatch> = {
  id: "hex",
  pair: ref("pair"),
  window: ["window", "id", "str?"],
  adlId: "big",
  submitter: ref("submitter"),
  longBucketClosed: "big",
  longBucketSettlementPrice: "big",
  shortBucketClosed: "big",
  shortBucketSettlementPrice: "big",
  netted: "big",
  ...tx,
};

const ADL_FILL: Fields<AdlFill> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  isLong: "bool",
  closedSize: "big",
  credit: "big",
  remainingCollateral: "big",
  adlScore: "big",
  settlementPrice: "big",
  withheldFunding: "big",
  ...tx,
};

const PROVIDER: Fields<InsuranceProvider> = {
  id: "str",
  pair: ref("pair"),
  account: ref("account"),
  shares: "big",
  deposited: "big",
  withdrawn: "big",
  depositCount: "num",
  requestedShares: "big",
  requestedAt: "num?",
  lockedAmount: "big?",
  claimOpensTs: "num?",
  levyChargedShares: "big",
  levyReceivedShares: "big",
  createdTimestamp: "num",
};

const INSURANCE_EVENT: Fields<InsuranceEvent> = {
  id: "hex",
  pair: ref("pair"),
  account: ref("account"),
  kind: "str",
  amount: "big",
  shares: "big",
  claimOpensTs: "num?",
  ...tx,
};

const TERMINATION: Fields<PairTermination> = {
  id: "hex",
  pair: ref("pair"),
  settlementPrice: "big",
  owedToTraders: "big",
  registeredClaims: "big",
  badDebt: "big",
  estateValue: "big",
  pot: "big",
  principalRatio: "big",
  profitRatio: "big",
  insuranceFundBalanceAfter: "big",
  sweepComplete: "bool",
  ...tx,
};

const RATIO_UPDATE: Fields<TerminalRatioUpdate> = {
  id: "hex",
  pair: ref("pair"),
  unfunded: "big",
  principalRatio: "big",
  profitRatio: "big",
  ...tx,
};

const TERMINATION_PROPOSAL: Fields<TerminationProposal> = {
  id: "hex",
  pair: ref("pair"),
  proposer: ref("proposer"),
  category: "num",
  lastTradingTs: "num",
  reason: "str",
  status: "str",
  disputed: "bool",
  acceptedCutoffTs: "num?",
  submittedAt: "num",
  livenessEndsAt: "num",
  resolvedAt: "num?",
  transactionHash: "hex",
};

const INSURER_PROPOSAL: Fields<InsurerProposal> = {
  id: "hex",
  pair: ref("pair"),
  proposer: ref("proposer"),
  cutoffTs: "num",
  windowOpenTs: "num",
  claimBacked: "bool",
  snapshotTotalShares: "big?",
  snapshotShareEpoch: "num?",
  yesShares: "big",
  status: "str",
  thresholdMet: "bool?",
  outcome: "num?",
  costed: "bool?",
  levyBp: "bp?",
  bondRefundFailed: "bool",
  createdAt: "num",
  resolvedAt: "num?",
  transactionHash: "hex",
};

const INSURER_VOTE: Fields<InsurerVote> = {
  id: "hex",
  proposal: ref("proposal", "hex"),
  pair: ref("pair"),
  voter: ref("voter"),
  amount: "big",
  totalYesShares: "big",
  ...tx,
};

const INSURER_LEVY: Fields<InsurerLevy> = {
  id: "hex",
  proposal: ref("proposal", "hex"),
  pair: ref("pair"),
  voter: "addr",
  votedShares: "big",
  levyShares: "big",
  recipient: "addr",
  ...tx,
};

const LISTING: Fields<ListingProposal> = {
  id: "hex",
  pairId: "hex",
  deployer: ref("deployer"),
  baseFeedId: "hex",
  description: "str",
  seedAmount: "big",
  status: "str",
  disputed: "bool",
  proposedAt: "num",
  livenessEndsAt: "num",
  resolvedAt: "num?",
  pair: ref("pair", "addr?"),
  seedRefundUsdc: "big?",
  transactionHash: "hex",
};

const ID_UPGRADE: Fields<IdentifierUpgradeProposal> = {
  id: "hex",
  proposer: ref("proposer"),
  newIdentifier: "hex",
  status: "str",
  disputed: "bool",
  proposedAt: "num",
  livenessEndsAt: "num",
  effectiveTs: "num?",
  oldIdentifier: "hex?",
  resolvedAt: "num?",
  transactionHash: "hex",
};

const INTEGRATOR: Fields<IntegratorStats> = {
  integrator: ["id", "", "addr"],
  orderCount: "num",
  fillCount: "num",
  makerVolumeNotional: "big",
  takerVolumeNotional: "big",
  firstOrderTimestamp: "num",
  lastFillTimestamp: "num?",
};

const ACCOUNT: Fields<AccountStats> = {
  account: ["id", "", "addr"],
  firstSeenTimestamp: "num",
  tradeCount: "num",
  makerVolumeNotional: "big",
  takerVolumeNotional: "big",
  feesPaid: "big",
  realizedPnl: "big",
  liquidationCount: "num",
  liquidationsExecuted: "num",
  triggerBountiesEarned: "big",
  triggerExecutions: "num",
  adlBatchesExecuted: "num",
  feesAccrued: "big",
  feesClaimed: "big",
  seedRefundOwedUsdc: "big",
};

const ACCOUNT_DAY: Fields<AccountDayData> = {
  id: "str",
  account: ref("account"),
  date: "num",
  makerVolumeNotional: "big",
  takerVolumeNotional: "big",
  tradeCount: "num",
  feesPaid: "big",
  realizedPnl: "big",
};

const PROTOCOL_DAY: Fields<ProtocolDayData> = {
  id: "str",
  date: "num",
  volumeNotional: "big",
  tradeCount: "num",
  makerFees: "big",
  takerFees: "big",
  liquidationCount: "num",
  uniqueTraders: "num",
};

const META_TX: Fields<MetaTransaction> = {
  id: "hex",
  pair: ref("pair"),
  user: ref("user"),
  relayer: ref("relayer"),
  functionId: "hex",
  nonce: "big",
  relayerFee: "big",
  ...tx,
};

const PERMIT_FAILURE: Fields<PermitFailure> = { id: "hex", pair: ref("pair"), owner: "addr", ...tx };

const BOOK_LEVEL: Fields<BookLevel> = { id: "str", pair: ref("pair"), isBid: "bool", price: "big", size: "big", orderCount: "num" };

// =====================================================================================================
// Query building. Values are validated and written into the query as literals (an id filter is typed
// ID or Bytes depending on the entity, and a literal coerces to either), so nothing unvalidated reaches
// the query text.
// =====================================================================================================

/** A page of results; `next` is the cursor for the following page, null at the end. */
export interface Page<T> {
  readonly items: T[];
  readonly next: string | null;
}

export interface PageOptions {
  /** Rows per page, 1 to 1000 (default 100). */
  first?: number;
  /** The `next` cursor of the previous page. */
  after?: string | null;
  /** Read the subgraph as of this block, for a consistent multi-page snapshot. */
  atBlock?: number;
}

export interface TimeOptions extends PageOptions {
  /** Inclusive lower bound on the list's time field (seconds). */
  from?: number;
  /** Exclusive upper bound on the list's time field (seconds). */
  to?: number;
  /** "desc" (newest first) is the default for event lists, "asc" for candles and day data. */
  order?: "asc" | "desc";
}

type Where = Record<string, string>;

const quote = (s: string) => `"${s}"`;

function lowerAddr(v: string, field: string): string {
  try {
    return getAddress(v).toLowerCase();
  } catch {
    throw new InputError(field, "is not an address");
  }
}

const addrLit = (v: string, field: string) => quote(lowerAddr(v, field));

function hexLit(v: string, field: string, bytes?: number): string {
  const ok = bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v) : /^0x([0-9a-fA-F]{2})*$/.test(v);
  if (!ok) throw new InputError(field, bytes ? `must be ${bytes} bytes of hex` : "must be hex");
  return quote(v.toLowerCase());
}

function uintLit(v: number | bigint, field: string): bigint {
  const b = typeof v === "bigint" ? v : Number.isSafeInteger(v) ? BigInt(v) : -1n;
  if (b < 0n) throw new InputError(field, "must be a whole number of zero or more");
  return b;
}

function enumList<E extends string>(values: readonly E[], allowed: readonly string[], field: string): string {
  if (!values.length) throw new InputError(field, "must name at least one value");
  for (const v of values) if (!allowed.includes(v)) throw new InputError(field, `unknown value ${JSON.stringify(v)}`);
  return `[${values.join(", ")}]`;
}

function render(w: Where): string {
  return `{${Object.entries(w)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")}}`;
}

interface ListSpec<T> {
  entity: string;
  fields: Fields<T>;
  /** The subgraph field the list is ordered by. */
  orderBy: string;
  dir: "asc" | "desc";
  /** The order field never repeats within the list's filters, so its cursor needs no skip. */
  unique?: boolean;
}

interface Bounds {
  gte?: bigint;
  gt?: bigint;
  lte?: bigint;
  lt?: bigint;
}

const maxB = (a: bigint | undefined, b: bigint) => (a === undefined || b > a ? b : a);
const minB = (a: bigint | undefined, b: bigint) => (a === undefined || b < a ? b : a);

async function list<T>(
  ctx: BazaarContext,
  spec: ListSpec<T>,
  where: Where,
  opts: TimeOptions,
  either?: readonly Where[],
): Promise<Page<T>> {
  const sg = requireSubgraph(ctx);
  const first = opts.first ?? DEFAULT_PAGE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) throw new InputError("first", `must be between 1 and ${MAX_PAGE}`);
  const dir = opts.order ?? spec.dir;
  if (dir !== "asc" && dir !== "desc") throw new InputError("order", 'must be "asc" or "desc"');
  const field = spec.orderBy;
  const w: Where = { ...where };
  const b: Bounds = {};
  if (opts.from !== undefined) b.gte = uintLit(opts.from, "from");
  if (opts.to !== undefined) b.lt = uintLit(opts.to, "to");
  let skip = 0;
  let prevValue: string | null = null;
  if (opts.after) {
    if (field === "id") {
      if (!/^[0-9A-Za-z-]{1,200}$/.test(opts.after)) throw new InputError("after", "is not a cursor this list returned");
      w[dir === "asc" ? "id_gt" : "id_lt"] = quote(opts.after);
    } else {
      const m = /^(\d{1,78})(?::(\d{1,9}))?$/.exec(opts.after);
      if (!m) throw new InputError("after", "is not a cursor this list returned");
      const v = BigInt(m[1]!);
      if (spec.unique) {
        if (dir === "asc") b.gt = maxB(b.gt, v);
        else b.lt = minB(b.lt, v);
      } else {
        if (dir === "asc") b.gte = maxB(b.gte, v);
        else b.lte = minB(b.lte, v);
        skip = Number(m[2] ?? "0");
        prevValue = m[1]!;
      }
    }
  }
  for (const [op, v] of Object.entries(b) as [keyof Bounds, bigint | undefined][]) {
    if (v !== undefined) w[`${field}_${op}`] = quote(v.toString());
  }
  const whereText = either && either.length ? `{or: [${either.map((e) => render({ ...w, ...e })).join(", ")}]}` : render(w);
  const args = [`first: ${first}`];
  if (skip) args.push(`skip: ${skip}`);
  args.push(`orderBy: ${field}`, `orderDirection: ${dir}`, `where: ${whereText}`);
  if (opts.atBlock !== undefined) args.push(`block: {number: ${uintLit(opts.atBlock, "atBlock")}}`);
  const q = `{ rows: ${spec.entity}(${args.join(", ")}) { ${selection(spec.fields, ["id", field])} } }`;
  const data = await sg.query<{ rows?: Record<string, unknown>[] }>(q);
  const rows = data?.rows;
  if (!Array.isArray(rows)) throw new SubgraphError(`the subgraph's answer has no ${spec.entity}`);
  const items = rows.map((r) => mapRow(spec.fields, r));
  let next: string | null = null;
  if (rows.length === first) {
    const last = rows[rows.length - 1]!;
    if (field === "id") {
      next = String(last.id);
    } else {
      const v = String(last[field]);
      if (spec.unique) {
        next = v;
      } else {
        let n = 0;
        for (const r of rows) if (String(r[field]) === v) n++;
        if (prevValue === v) n += skip;
        next = `${v}:${n}`;
      }
    }
  }
  return { items, next };
}

async function single<T>(ctx: BazaarContext, entity: string, id: string, fields: Fields<T>, atBlock?: number): Promise<T | null> {
  const sg = requireSubgraph(ctx);
  const block = atBlock !== undefined ? `, block: {number: ${uintLit(atBlock, "atBlock")}}` : "";
  const data = await sg.query<{ row?: Record<string, unknown> | null }>(`{ row: ${entity}(id: ${id}${block}) { ${selection(fields, ["id"])} } }`);
  return data?.row ? mapRow(fields, data.row) : null;
}

function base(f: { pair?: Address | null }): Where {
  return f.pair ? { pair: addrLit(f.pair, "pair") } : {};
}

function withAddr(w: Where, key: string, v: Address | null | undefined, field = key): Where {
  if (v) w[key] = addrLit(v, field);
  return w;
}

/** A list ordered newest first by a time field. */
function T<X>(entity: string, fields: Fields<X>, orderBy = "timestamp"): ListSpec<X> {
  return { entity, fields, orderBy, dir: "desc" };
}

// =====================================================================================================
// Market data
// =====================================================================================================

export interface TradeFilter extends TimeOptions {
  pair?: Address;
  /** Trades the account took part in, as maker or as taker (the subgraph's `or` filter, graph-node 0.30+). */
  account?: Address;
  maker?: Address;
  taker?: Address;
}

/** The trade tape: fills, newest first. */
export async function trades(ctx: BazaarContext, f: TradeFilter = {}): Promise<Page<Trade>> {
  const w = withAddr(withAddr(base(f), "maker", f.maker), "taker", f.taker);
  const either: Where[] | undefined = f.account ? [{ maker: addrLit(f.account, "account") }, { taker: addrLit(f.account, "account") }] : undefined;
  return list(ctx, { entity: "trades", fields: TRADE, orderBy: "timestamp", dir: "desc" }, w, f, either);
}

/**
 * OHLCV candles of one pair at one interval (seconds: 60, 300, 900, 3600, 14400 or 86400), oldest
 * first; `from`/`to` bound the period start. Periods without fills have no candle: pass the result
 * through {@link fillCandleGaps} to carry the previous close forward.
 */
export async function candles(ctx: BazaarContext, pair: Address, interval: number, opts: TimeOptions = {}): Promise<Page<Candle>> {
  if (!(CANDLE_INTERVALS as readonly number[]).includes(interval)) {
    throw new InputError("interval", `must be one of ${CANDLE_INTERVALS.join(", ")} seconds`);
  }
  const w: Where = { pair: addrLit(pair, "pair"), interval: String(interval) };
  return list(ctx, { entity: "candles", fields: CANDLE, orderBy: "periodStart", dir: "asc", unique: true }, w, opts);
}

/** The most candles {@link fillCandleGaps} returns: about 69 days of 1-minute candles, more than a chart shows. */
export const MAX_FILLED_CANDLES = 100_000;

/**
 * Fill the periods between `from` and `to` (exclusive) that had no fills with flat candles at the
 * previous close (zero volume), as a chart expects. Periods before the first known candle stay empty.
 *
 * `interval` must be one of {@link CANDLE_INTERVALS}; `from` and `to` whole non-negative seconds;
 * every row's `periodStart` a whole non-negative second on the interval's grid (as the subgraph
 * keeps them). The answer holds at most {@link MAX_FILLED_CANDLES} candles: a longer span is refused
 * (InputError) before anything is built, rather than allocated.
 */
export function fillCandleGaps(rows: readonly Candle[], interval: number, from?: number, to?: number): Candle[] {
  if (!(CANDLE_INTERVALS as readonly number[]).includes(interval)) {
    throw new InputError("interval", `must be one of ${CANDLE_INTERVALS.join(", ")} seconds`);
  }
  for (const [field, v] of [["from", from], ["to", to]] as const) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) throw new InputError(field, "must be a unix time in whole seconds");
  }
  for (const c of rows) {
    if (!Number.isSafeInteger(c.periodStart) || c.periodStart < 0 || c.periodStart % interval !== 0) {
      throw new InputError("rows", `every candle must start on a whole ${interval}-second period; one starts at ${String(c.periodStart).slice(0, 32)}`);
    }
  }
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.periodStart - b.periodStart);
  const start = Math.max(sorted[0]!.periodStart, from !== undefined ? from - (from % interval) : -Infinity);
  const end = to ?? sorted[sorted.length - 1]!.periodStart + interval;
  const periods = end > start ? Math.ceil((end - start) / interval) : 0;
  if (periods > MAX_FILLED_CANDLES) {
    throw new InputError(
      to !== undefined ? "to" : "rows",
      `filling this span takes ${periods} candles of ${interval} seconds, more than the ${MAX_FILLED_CANDLES} this returns: ask for a shorter range (from/to) or a longer interval`,
    );
  }
  const byStart = new Map(sorted.map((c) => [c.periodStart, c]));
  const out: Candle[] = [];
  let prev: Candle | undefined = [...sorted].reverse().find((c) => c.periodStart < start);
  for (let t = start; t < end; t += interval) {
    const c = byStart.get(t);
    if (c) {
      out.push(c);
      prev = c;
    } else if (prev) {
      out.push({ ...prev, id: `${prev.pair.toLowerCase()}-${interval}-${t}`, periodStart: t, open: prev.close, high: prev.close, low: prev.close, volumeSize: 0n, volumeNotional: 0n, tradeCount: 0 });
    }
  }
  return out;
}

/** A pair's daily figures (UTC days), oldest first. */
export async function pairDayData(ctx: BazaarContext, pair: Address, opts: TimeOptions = {}): Promise<Page<PairDayData>> {
  return list(ctx, { entity: "pairDayDatas", fields: PAIR_DAY, orderBy: "date", dir: "asc", unique: true }, { pair: addrLit(pair, "pair") }, opts);
}

/** Protocol-wide daily figures, oldest first. */
export async function protocolDayData(ctx: BazaarContext, opts: TimeOptions = {}): Promise<Page<ProtocolDayData>> {
  return list(ctx, { entity: "protocolDayDatas", fields: PROTOCOL_DAY, orderBy: "date", dir: "asc", unique: true }, {}, opts);
}

export interface BookLevelOptions extends PageOptions {
  side: "bid" | "ask";
}

/**
 * Aggregated resting size per price on one side of a pair's book, best price first (bids high to
 * low, asks low to high). The subgraph counts resting orders whose expiry block has passed until a
 * transaction removes them, and lags the chain: for what an order would fill against now, read the
 * book from the chain (BazaarPairLens.getBookDepth).
 */
export async function bookLevels(ctx: BazaarContext, pair: Address, opts: BookLevelOptions): Promise<Page<BookLevel>> {
  if (opts.side !== "bid" && opts.side !== "ask") throw new InputError("side", 'must be "bid" or "ask"');
  const w: Where = { pair: addrLit(pair, "pair"), isBid: String(opts.side === "bid") };
  return list(ctx, { entity: "bookLevels", fields: BOOK_LEVEL, orderBy: "price", dir: opts.side === "bid" ? "desc" : "asc", unique: true }, w, {
    first: opts.first,
    after: opts.after,
    atBlock: opts.atBlock,
  });
}

// =====================================================================================================
// Orders and positions
// =====================================================================================================

export interface OrderFilter extends TimeOptions {
  account?: Address;
  pair?: Address;
  status?: readonly OrderStatus[];
  /** Only orders that can still trade (Waiting, Resting, Fired). */
  openOnly?: boolean;
  orderType?: readonly OrderTypeName[];
  integrator?: Address;
}

/** Orders, newest first by creation time (`from`/`to` bound the creation time). */
export async function orders(ctx: BazaarContext, f: OrderFilter = {}): Promise<Page<HistoryOrder>> {
  const w = withAddr(withAddr(base(f), "owner", f.account, "account"), "integrator", f.integrator);
  const statuses = f.openOnly ? OPEN_ORDER_STATUSES.filter((s) => !f.status || f.status.includes(s)) : f.status;
  if (statuses) w.status_in = enumList(statuses, ORDER_STATUSES, "status");
  if (f.orderType) w.orderType_in = enumList(f.orderType, ORDER_TYPES, "orderType");
  return list(ctx, { entity: "orders", fields: ORDER, orderBy: "createdTimestamp", dir: "desc" }, w, f);
}

/** One order by pair and order id, or null when the subgraph has not seen it. */
export async function order(ctx: BazaarContext, pair: Address, orderId: bigint, atBlock?: number): Promise<HistoryOrder | null> {
  const id = `${lowerAddr(pair, "pair")}-${uintLit(orderId, "orderId")}`;
  return single(ctx, "order", quote(id), ORDER, atBlock);
}

export interface OrderEventFilter extends TimeOptions {
  account?: Address;
  pair?: Address;
  /** One order's lifecycle: needs `pair`. */
  orderId?: bigint;
  action?: readonly OrderEventAction[];
}

/** Order lifecycle events (created, triggered, canceled with its reason, amended, amend skipped), newest first. */
export async function orderEvents(ctx: BazaarContext, f: OrderEventFilter = {}): Promise<Page<OrderEvent>> {
  const w = withAddr(base(f), "owner", f.account, "account");
  if (f.orderId !== undefined) {
    if (!f.pair) throw new InputError("pair", "is needed to look up one order's events");
    w.order = quote(`${lowerAddr(f.pair, "pair")}-${uintLit(f.orderId, "orderId")}`);
  }
  if (f.action) w.action_in = enumList(f.action, ORDER_EVENT_ACTIONS, "action");
  return list(ctx, T("orderEvents", ORDER_EVENT), w, f);
}

export interface PositionFilter extends PageOptions {
  account?: Address;
  pair?: Address;
  openOnly?: boolean;
}

/** Positions (one per account and pair), by id. */
export async function positions(ctx: BazaarContext, f: PositionFilter = {}): Promise<Page<HistoryPosition>> {
  const w = withAddr(base(f), "account", f.account);
  if (f.openOnly) w.isOpen = "true";
  return list(ctx, { entity: "positions", fields: POSITION, orderBy: "id", dir: "asc" }, w, f);
}

export interface AccountPairFilter extends TimeOptions {
  account?: Address;
  pair?: Address;
}

/** Each trade's effect on a position, newest first. */
export async function positionChanges(ctx: BazaarContext, f: AccountPairFilter = {}): Promise<Page<PositionChange>> {
  return list(ctx, T("positionChanges", CHANGE), withAddr(base(f), "account", f.account), f);
}

/** The full stored position after every change (PositionBucketUpdated), newest first. */
export async function positionSnapshots(ctx: BazaarContext, f: AccountPairFilter = {}): Promise<Page<PositionSnapshot>> {
  return list(ctx, T("positionSnapshots", SNAPSHOT), withAddr(base(f), "account", f.account), f);
}

/** Collateral deposits and withdrawals, newest first. */
export async function collateralTransfers(ctx: BazaarContext, f: AccountPairFilter = {}): Promise<Page<CollateralTransfer>> {
  return list(ctx, T("collateralTransfers", COLLATERAL), withAddr(base(f), "account", f.account), f);
}

// =====================================================================================================
// Fees, rewards and relaying
// =====================================================================================================

export interface RecipientFilter extends TimeOptions {
  /** The integrator, relayer, keeper or owner the balance belongs to. */
  recipient?: Address;
  pair?: Address;
}

/**
 * Claimable balances per pair and recipient: an integrator's or relayer's revenue, a keeper's rewards,
 * refunded bounties. `claimableOnly` keeps the balances with something to claim.
 */
export async function feeBalances(ctx: BazaarContext, f: RecipientFilter & { claimableOnly?: boolean } = {}): Promise<Page<FeeBalance>> {
  const w = withAddr(base(f), "recipient", f.recipient);
  if (f.claimableOnly) w.claimable_gt = quote("0");
  return list(ctx, { entity: "feeBalances", fields: FEE_BALANCE, orderBy: "id", dir: "asc" }, w, { first: f.first, after: f.after, atBlock: f.atBlock });
}

/** Credits to claimable balances (FeeAccrued), newest first. */
export async function feeAccruals(ctx: BazaarContext, f: RecipientFilter = {}): Promise<Page<FeeMovement>> {
  return list(ctx, T("feeAccruals", FEE_MOVE), withAddr(base(f), "recipient", f.recipient), f);
}

/** Claims of claimable balances (FeesClaimed), newest first. */
export async function feeClaims(ctx: BazaarContext, f: RecipientFilter = {}): Promise<Page<FeeMovement>> {
  return list(ctx, T("feeClaims", FEE_MOVE), withAddr(base(f), "recipient", f.recipient), f);
}

/** What an integrator address has routed, or null when it has carried no order. */
export async function integratorStats(ctx: BazaarContext, integrator: Address, atBlock?: number): Promise<IntegratorStats | null> {
  return single(ctx, "integratorStats", addrLit(integrator, "integrator"), INTEGRATOR, atBlock);
}

/** An account's lifetime totals, or null when the subgraph has not seen it. */
export async function accountStats(ctx: BazaarContext, account: Address, atBlock?: number): Promise<AccountStats | null> {
  return single(ctx, "account", addrLit(account, "account"), ACCOUNT, atBlock);
}

/** An account's daily totals (UTC days), oldest first. */
export async function accountDayData(ctx: BazaarContext, account: Address, opts: TimeOptions = {}): Promise<Page<AccountDayData>> {
  return list(ctx, { entity: "accountDayDatas", fields: ACCOUNT_DAY, orderBy: "date", dir: "asc", unique: true }, { account: addrLit(account, "account") }, opts);
}

export interface MetaTxFilter extends TimeOptions {
  user?: Address;
  relayer?: Address;
  pair?: Address;
}

/** Relayed (gasless) actions, newest first. */
export async function metaTransactions(ctx: BazaarContext, f: MetaTxFilter = {}): Promise<Page<MetaTransaction>> {
  const w = withAddr(withAddr(base(f), "user", f.user), "relayer", f.relayer);
  return list(ctx, T("metaTransactions", META_TX), w, f);
}

/** Permits the pair could not execute (the call went on with the existing allowance), newest first. */
export async function permitFailures(ctx: BazaarContext, f: TimeOptions & { owner?: Address; pair?: Address } = {}): Promise<Page<PermitFailure>> {
  return list(ctx, T("permitFailures", PERMIT_FAILURE), withAddr(base(f), "owner", f.owner), f);
}

// =====================================================================================================
// Liquidation and ADL
// =====================================================================================================

/** Liquidations, newest first: `account` is the liquidated trader. */
export async function liquidations(ctx: BazaarContext, f: AccountPairFilter & { liquidator?: Address } = {}): Promise<Page<Liquidation>> {
  const w = withAddr(withAddr(base(f), "account", f.account), "liquidator", f.liquidator);
  return list(ctx, T("liquidations", LIQUIDATION), w, f);
}

/** ADL windows, newest first by opening time. */
export async function adlWindows(ctx: BazaarContext, f: TimeOptions & { pair?: Address } = {}): Promise<Page<AdlWindow>> {
  return list(ctx, T("adlWindows", ADL_WINDOW, "openedAt"), base(f), f);
}

/** ADL batches (executeAdl calls), newest first; `window` is an {@link AdlWindow} id. */
export async function adlBatches(
  ctx: BazaarContext,
  f: TimeOptions & { pair?: Address; window?: string; transactionHash?: Hex } = {},
): Promise<Page<AdlBatch>> {
  const w = base(f);
  if (f.window !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}-\d+$/.test(f.window)) throw new InputError("window", 'must be an ADL window id ("<pair>-<epoch>")');
    w.window = quote(f.window.toLowerCase());
  }
  if (f.transactionHash) w.transactionHash = hexLit(f.transactionHash, "transactionHash", 32);
  return list(ctx, T("adlBatches", ADL_BATCH), w, f);
}

/** Winners ADL closed, newest first. */
export async function adlFills(ctx: BazaarContext, f: AccountPairFilter & { transactionHash?: Hex } = {}): Promise<Page<AdlFill>> {
  const w = withAddr(base(f), "account", f.account);
  if (f.transactionHash) w.transactionHash = hexLit(f.transactionHash, "transactionHash", 32);
  return list(ctx, T("adlFills", ADL_FILL), w, f);
}

// =====================================================================================================
// Insurance
// =====================================================================================================

/** Insurance LPs per pair, by id; `activeOnly` keeps those holding shares. */
export async function insuranceProviders(ctx: BazaarContext, f: PageOptions & { pair?: Address; account?: Address; activeOnly?: boolean } = {}): Promise<Page<InsuranceProvider>> {
  const w = withAddr(base(f), "account", f.account);
  if (f.activeOnly) w.shares_gt = quote("0");
  return list(ctx, { entity: "insuranceProviders", fields: PROVIDER, orderBy: "id", dir: "asc" }, w, f);
}

/** Insurance deposits, withdrawal requests, locks, payouts and levies, newest first. */
export async function insuranceEvents(ctx: BazaarContext, f: AccountPairFilter & { kind?: readonly InsuranceEventKind[] } = {}): Promise<Page<InsuranceEvent>> {
  const w = withAddr(base(f), "account", f.account);
  if (f.kind) w.kind_in = enumList(f.kind, INSURANCE_EVENT_KINDS, "kind");
  return list(ctx, T("insuranceEvents", INSURANCE_EVENT), w, f);
}

// =====================================================================================================
// Termination
// =====================================================================================================

/** Finalized terminations with their payout figures, newest first. */
export async function pairTerminations(ctx: BazaarContext, f: TimeOptions & { pair?: Address } = {}): Promise<Page<PairTermination>> {
  return list(ctx, T("pairTerminations", TERMINATION), base(f), f);
}

/** Payout ratios re-derived after finalize, newest first. */
export async function terminalRatioUpdates(ctx: BazaarContext, f: TimeOptions & { pair?: Address } = {}): Promise<Page<TerminalRatioUpdate>> {
  return list(ctx, T("terminalRatioUpdates", RATIO_UPDATE), base(f), f);
}

/** UMA termination claims, newest first by submission. */
export async function terminationProposals(
  ctx: BazaarContext,
  f: TimeOptions & { pair?: Address; proposer?: Address; status?: readonly TerminationProposalStatus[] } = {},
): Promise<Page<TerminationProposal>> {
  const w = withAddr(base(f), "proposer", f.proposer);
  if (f.status) w.status_in = enumList(f.status, TERMINATION_PROPOSAL_STATUSES, "status");
  return list(ctx, T("terminationProposals", TERMINATION_PROPOSAL, "submittedAt"), w, f);
}

/** Insurer termination votes, newest first by creation. */
export async function insurerProposals(
  ctx: BazaarContext,
  f: TimeOptions & { pair?: Address; proposer?: Address; status?: readonly InsurerProposalStatus[] } = {},
): Promise<Page<InsurerProposal>> {
  const w = withAddr(base(f), "proposer", f.proposer);
  if (f.status) w.status_in = enumList(f.status, INSURER_PROPOSAL_STATUSES, "status");
  return list(ctx, T("insurerProposals", INSURER_PROPOSAL, "createdAt"), w, f);
}

/** Yes-votes cast on insurer proposals, newest first. */
export async function insurerVotes(ctx: BazaarContext, f: TimeOptions & { proposal?: Hex; pair?: Address; voter?: Address } = {}): Promise<Page<InsurerVote>> {
  const w = withAddr(base(f), "voter", f.voter);
  if (f.proposal) w.proposal = hexLit(f.proposal, "proposal", 32);
  return list(ctx, T("insurerVotes", INSURER_VOTE), w, f);
}

/** Levies charged on yes-voters' redemptions after an insurer-vote termination, newest first. */
export async function insurerLevies(ctx: BazaarContext, f: TimeOptions & { proposal?: Hex; pair?: Address; voter?: Address } = {}): Promise<Page<InsurerLevy>> {
  const w = withAddr(base(f), "voter", f.voter);
  if (f.proposal) w.proposal = hexLit(f.proposal, "proposal", 32);
  return list(ctx, T("insurerLevies", INSURER_LEVY), w, f);
}

// =====================================================================================================
// Listings and governance
// =====================================================================================================

/** Listing (pair deployment) proposals, newest first. */
export async function listingProposals(
  ctx: BazaarContext,
  f: TimeOptions & { deployer?: Address; status?: readonly ListingStatus[] } = {},
): Promise<Page<ListingProposal>> {
  const w = withAddr({}, "deployer", f.deployer);
  if (f.status) w.status_in = enumList(f.status, LISTING_STATUSES, "status");
  return list(ctx, T("listingProposals", LISTING, "proposedAt"), w, f);
}

/** UMA identifier-upgrade proposals, newest first. */
export async function identifierUpgradeProposals(
  ctx: BazaarContext,
  f: TimeOptions & { proposer?: Address; status?: readonly IdentifierUpgradeStatus[] } = {},
): Promise<Page<IdentifierUpgradeProposal>> {
  const w = withAddr({}, "proposer", f.proposer);
  if (f.status) w.status_in = enumList(f.status, IDENTIFIER_UPGRADE_STATUSES, "status");
  return list(ctx, T("identifierUpgradeProposals", ID_UPGRADE, "proposedAt"), w, f);
}

// =====================================================================================================
// Freshness
// =====================================================================================================

export interface SubgraphLag {
  /** The last block the subgraph has indexed. */
  indexedBlock: number;
  /** Its timestamp, when the indexer reports one. */
  indexedTimestamp: number | null;
  chainBlock: number;
  chainTimestamp: number;
  /** Blocks the subgraph is behind the chain head (0 when level or ahead of this RPC). */
  blocksBehind: number;
  /** Seconds behind, when the indexer reports its block's timestamp. */
  secondsBehind: number | null;
  /** The indexer hit an error: its history may stop advancing. */
  hasIndexingErrors: boolean;
}

/**
 * How far the subgraph's history trails the chain: its `_meta.block` against the chain head, so a UI
 * can say that trades and positions from the last moments may not be listed yet.
 */
export async function subgraphLag(ctx: BazaarContext): Promise<SubgraphLag> {
  const sg = requireSubgraph(ctx);
  type Meta = { _meta?: { block?: { number?: number | string; timestamp?: number | string | null }; hasIndexingErrors?: boolean } };
  // Older indexers do not serve the block's timestamp: ask again without it.
  const readMeta = () =>
    sg.query<Meta>("{ _meta { block { number timestamp } hasIndexingErrors } }").catch(() => sg.query<Meta>("{ _meta { block { number } hasIndexingErrors } }"));
  const [meta, head] = await Promise.all([readMeta(), ctx.chain.block("latest")]);
  const blk = meta?._meta?.block;
  if (!blk || blk.number === undefined) throw new SubgraphError("the subgraph's answer has no _meta block");
  const indexedBlock = Number(blk.number);
  const indexedTimestamp = blk.timestamp === undefined || blk.timestamp === null ? null : Number(blk.timestamp);
  return {
    indexedBlock,
    indexedTimestamp,
    chainBlock: head.number,
    chainTimestamp: head.timestamp,
    blocksBehind: Math.max(0, head.number - indexedBlock),
    secondsBehind: indexedTimestamp === null ? null : Math.max(0, head.timestamp - indexedTimestamp),
    hasIndexingErrors: Boolean(meta._meta?.hasIndexingErrors),
  };
}
