/**
 * Live updates for a UI: a market's or an account's events as they land, typed, and refreshed
 * snapshots when something relevant changed.
 *
 * A {@link LogFollower} polls the head (or, when the transport pushes `eth_subscribe` notifications
 * as EIP-1193 "message" events, wakes on each new head), reads the watched contracts' logs from a
 * block cursor with `eth_getLogs`, and hands them on in chain order. A head whose hash no longer
 * matches what was seen rewinds the cursor a few blocks, as the keeper's tail does after a reorg, and
 * logs already delivered from blocks that survived are not delivered twice. A failure backs off
 * exponentially and retries; nothing is lost, because the cursor only advances once a range is read.
 *
 * Polling is the default because a wallet's provider rarely offers log subscriptions. One follower
 * per watch reads every watched market and the terminator in one `eth_getLogs` per tick.
 */

import { type Address, type Hex, getAddress } from "viem";
import type { Block, Chain } from "../chain/client.js";
import { type RawLog, pair as pairCodec, terminator as terminatorCodec } from "../chain/codec.js";
import { RpcError, type Transport } from "../chain/rpc.js";
import { type AccountSnapshot, accountSnapshots } from "./account.js";
import type { BazaarContext } from "./context.js";
import { type LivePriceView, type MarketInfo, type MarketRef, type MarketSnapshot, getMarket, marketSnapshots } from "./markets.js";

// =====================================================================================================
// Typed events
// =====================================================================================================

/** OrderUpdated's payload: the order's stored state at the event. Block numbers and enums as numbers. */
export interface OrderUpdatePayload {
  /** 0 Created, 1 Triggered, 2 Canceled. */
  readonly action: number;
  readonly orderType: number;
  readonly isLong: boolean;
  readonly isPostOnly: boolean;
  readonly size: bigint;
  readonly filledSize: bigint;
  /** The trigger price alone: the bounty is not part of the stored order. */
  readonly triggerPrice: bigint;
  readonly limitPrice: bigint;
  readonly maxSlippageBp: bigint;
  readonly canceledBlock: number;
  readonly filledBlock: number;
  /** 2^64 − 1 (as a number) for an order that never expires. */
  readonly expiryBlock: number;
  readonly prioritySeq: number;
  /** 0 GTC, 1 IOC, 2 FOK. */
  readonly tif: number;
  readonly integrator: Address;
  /** BazaarTypes.CancelReason: 0 None, 1 Owner, 2 Expired, 3 Unfilled, 4 BelowMinimum, 5 PostOnly, 6 SelfMatch, 7 StepLimit, 8 Margin, 9 PriceBand, 10 PositionClosed, 11 Liquidated, 12 Deleveraged. */
  readonly cancelReason: number;
}

/** Each pair event's arguments, as the pair emits them (BAZAAR precision; timestamps, blocks and enums as numbers). */
export interface PairEventArgs {
  Trade: {
    pairId: Hex; maker: Address; taker: Address; makerOrderId: bigint; takerOrderId: bigint; takerIsLong: boolean; fillSize: bigint;
    price: bigint; makerFee: bigint; takerFee: bigint; makerRemaining: bigint; takerRemaining: bigint;
  };
  OrderUpdated: { pairId: Hex; orderId: bigint; owner: Address; payload: OrderUpdatePayload };
  OrderAmended: { pairId: Hex; orderId: bigint; owner: Address; limitPrice: bigint; size: bigint; prioritySeq: number };
  /** reason: 0 Inactive, 1 Expired, 2 SizeFilled, 3 BelowMinimum, 4 WouldCross */
  OrderAmendSkipped: { pairId: Hex; orderId: bigint; owner: Address; reason: number };
  PositionBucketUpdated: {
    pairId: Hex; owner: Address; isLong: boolean; size: bigint; entryValue: bigint; collateral: bigint; entryFundingIndex: bigint;
    globalFundingIndex: bigint; imrBp: bigint; mmrBp: bigint;
  };
  PositionModified: {
    pairId: Hex; user: Address; isLong: boolean; sizeDelta: bigint; newSize: bigint; newEntryValue: bigint; newCollateral: bigint;
    executionPrice: bigint; fee: bigint; realizedPnl: bigint;
  };
  CollateralDeposited: { pairId: Hex; user: Address; amount: bigint };
  CollateralWithdrawn: { pairId: Hex; user: Address; amount: bigint };
  FeeAccrued: { pairId: Hex; recipient: Address; amount: bigint };
  FeesClaimed: { pairId: Hex; recipient: Address; amount: bigint };
  TriggerBountyEscrowed: { pairId: Hex; orderId: bigint; amount: bigint };
  TriggerBountyReleased: { pairId: Hex; orderId: bigint; recipient: Address; amount: bigint };
  NewPriceUpdateAdded: { pairId: Hex; targetPublishTs: number; spotPrice: bigint; exponent: number; fundingIndex: bigint };
  AdlTriggered: { pairId: Hex; adlEpoch: number; price: bigint; fundingIndex: bigint };
  AdlTerminationArmed: { pairId: Hex; adlTerminationTs: number };
  AdlResolved: { pairId: Hex; adlEpoch: number };
  AdlExecuted: {
    pairId: Hex; adlId: bigint; submitter: Address; longBucketClosed: bigint; longBucketSettlementPrice: bigint; shortBucketClosed: bigint;
    shortBucketSettlementPrice: bigint; netted: bigint; timestamp: number;
  };
  UserAdld: {
    pairId: Hex; user: Address; isLong: boolean; closedSize: bigint; realizedPnl: bigint; remainingCollateral: bigint; adlScore: bigint;
    adlSettlementPrice: bigint; withheldFunding: bigint;
  };
  PositionLiquidated: {
    pairId: Hex; liquidatedUser: Address; liquidator: Address; size: bigint; isLong: boolean; bankruptcyPrice: bigint; triggerPrice: bigint;
    collateralSeized: bigint; timestamp: number;
  };
  /** reason: the isVaultHealthy verdict (2 ADL timeout, 3 balance short, 4 bad debt) */
  InsolvencySettlementFixed: { pairId: Hex; settlementPrice: bigint; reason: number };
  PairTerminated: {
    pairId: Hex; settlementPrice: bigint; owedToTraders: bigint; registeredClaims: bigint; badDebt: bigint; estateValue: bigint; pot: bigint;
    principalRatio: bigint; profitRatio: bigint; insuranceFundBalanceAfter: bigint; sweepComplete: boolean; timestamp: number;
  };
  TerminalRatiosRefrozen: { pairId: Hex; unfunded: bigint; principalRatio: bigint; profitRatio: bigint };
  MetaTransactionExecuted: { pairId: Hex; user: Address; relayer: Address; functionId: Hex; nonce: bigint; relayerFee: bigint };
  PermitExecutionFailed: { owner: Address };
  InsuranceCredited: { pairId: Hex; from: Address; amountBazaarPrecision: bigint };
  InsuranceDeposited: { pairId: Hex; user: Address; amount: bigint; sharesReceived: bigint };
  InsuranceWithdrawalRequested: { pairId: Hex; user: Address; shareAmount: bigint };
  InsuranceWithdrawalLocked: { pairId: Hex; user: Address; shareAmount: bigint; lockedAmount: bigint; claimOpensTs: number };
  /**
   * `amount` is the payout in BAZAAR precision (18 decimals, any relayer fee included; the wallet
   * receives it floored to micro-USDC). The event's ABI names it `usdcAmount`, but it is not in USDC
   * units, so it is renamed here.
   */
  InsuranceWithdrawalExecuted: { pairId: Hex; user: Address; shareAmount: bigint; amount: bigint };
  InsuranceShareEpochBumped: { newEpoch: bigint };
  Initialized: { version: number };
}

export type PairEventName = keyof PairEventArgs;

/** Where a log sits. */
export interface LogPosition {
  /** The pair the event concerns: the emitting pair, or the `pair` a terminator event names. */
  readonly market: Address;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
}

/** A pair event; narrow on `name` for its typed `args`. */
export type PairEvent = {
  [N in PairEventName]: LogPosition & { readonly source: "pair"; readonly name: N; readonly args: PairEventArgs[N] };
}[PairEventName];

/** A terminator event about one market (proposals, schedules, settlement prices, insurer votes). */
export interface TerminatorEvent extends LogPosition {
  readonly source: "terminator";
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type LiveEvent = PairEvent | TerminatorEvent;

// Arguments the SDK's conventions type as numbers (timestamps, blocks, sequence numbers, enums) that
// viem decodes as bigint because they are wider than 48 bits.
const NUMBER_ARGS: Readonly<Record<string, readonly string[]>> = {
  OrderAmended: ["prioritySeq"],
  OrderAmendSkipped: ["reason"],
  NewPriceUpdateAdded: ["targetPublishTs", "exponent"],
  AdlTriggered: ["adlEpoch"],
  AdlResolved: ["adlEpoch"],
  AdlTerminationArmed: ["adlTerminationTs"],
  AdlExecuted: ["timestamp"],
  PositionLiquidated: ["timestamp"],
  PairTerminated: ["timestamp"],
  InsolvencySettlementFixed: ["reason"],
  InsuranceWithdrawalLocked: ["claimOpensTs"],
  Initialized: ["version"],
};
const PAYLOAD_NUMBERS = ["action", "orderType", "canceledBlock", "filledBlock", "expiryBlock", "prioritySeq", "tif", "cancelReason"] as const;

function numbersIn(args: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out = { ...args };
  for (const f of fields) if (typeof out[f] === "bigint") out[f] = Number(out[f]);
  return out;
}

/**
 * A pair's or the terminator's log as a typed {@link LiveEvent}; null for a log that is neither (or
 * a terminator event that names no pair). Works on receipt logs too.
 */
export function decodeLiveLog(log: RawLog, terminator?: Address | null): LiveEvent | null {
  const at = getAddress(log.address);
  const pos = { blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex };
  if (terminator && at === getAddress(terminator)) {
    const d = terminatorCodec().decodeLog(log);
    const p = d?.args.pair;
    if (!d || typeof p !== "string") return null;
    return { source: "terminator", name: d.name, market: getAddress(p), args: d.args, ...pos };
  }
  const d = pairCodec().decodeLog(log);
  if (!d) return null;
  let args = d.args;
  const nums = NUMBER_ARGS[d.name];
  if (nums) args = numbersIn(args, nums);
  if (d.name === "OrderUpdated") args = { ...args, payload: numbersIn(args.payload as Record<string, unknown>, PAYLOAD_NUMBERS) };
  if (d.name === "InsuranceWithdrawalExecuted") {
    const { usdcAmount, ...rest } = args;
    args = { ...rest, amount: usdcAmount }; // BAZAAR precision, whatever the ABI calls it
  }
  return { source: "pair", name: d.name, market: at, args, ...pos } as PairEvent;
}

// =====================================================================================================
// Following logs
// =====================================================================================================

export interface FollowOptions {
  /** Milliseconds between head polls; default 1000. While subscribed, a poll every 10× this backs the subscription up. */
  readonly pollMs?: number;
  /** The first block to deliver logs from; default the block after the head at start (only what lands from then on). */
  readonly fromBlock?: number;
  /** Blocks re-read after a reorg; default 32. */
  readonly reorgDepth?: number;
  /** The most blocks one eth_getLogs asks for (halved while the node refuses); default 2000. */
  readonly logChunk?: number;
  /**
   * The most blocks one tick reads; default 10 × logChunk. A head further ahead than this is not
   * taken on trust: the follower first reads the block it would stop at, refuses to go on (an error
   * notice, retried) when the node cannot serve it, and otherwise catches up in steps of this size.
   */
  readonly maxBlocksPerTick?: number;
  /** Wake on eth_subscribe("newHeads") when the transport emits EIP-1193 "message" events; default true. */
  readonly subscribe?: boolean;
  /** The longest wait between retries after errors (ms); default 30000. */
  readonly maxBackoffMs?: number;
}

/** What a follower reports besides logs. */
export type FollowNotice =
  | { readonly type: "head"; readonly block: number; readonly timestamp: number }
  | { readonly type: "reorg"; readonly fromBlock: number; readonly head: number }
  /** `retryInMs` is null when the watch gave up (it could not start). */
  | { readonly type: "error"; readonly error: unknown; readonly retryInMs: number | null };

interface MessageEmitter {
  on?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
}

const byPosition = (x: RawLog, y: RawLog) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex;

/**
 * Follows the logs of a set of contracts from a block cursor. `onLogs` gets each tick's new logs in
 * chain order (possibly none) with the head they were read up to; a rejection is reported as an
 * error and retried with backoff (the logs it was given are not delivered again).
 */
export class LogFollower {
  private last: Block | null = null;
  private next = 0; // the next block to read logs from
  private origin = 0;
  private readonly heads = new Map<number, Hex>(); // recent heads' hashes by number
  private readonly seen = new Map<string, number>(); // delivered logs (blockHash:logIndex) -> block
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private started: Promise<void> | null = null;
  private failures = 0;
  private subId: string | null = null;
  private listener: ((message: unknown) => void) | null = null;
  private readonly pollMs: number;
  private readonly reorgDepth: number;
  private readonly logChunk: number;
  private readonly maxBlocksPerTick: number;
  private readonly maxBackoffMs: number;

  constructor(
    readonly chain: Chain,
    private readonly addresses: () => readonly Address[],
    private readonly onLogs: (logs: RawLog[], head: Block) => Promise<void> | void,
    private readonly onNotice: (n: FollowNotice) => void,
    private readonly opts: FollowOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.reorgDepth = Math.max(1, opts.reorgDepth ?? 32);
    this.logChunk = Math.max(1, opts.logChunk ?? 2000);
    this.maxBlocksPerTick = Math.max(1, opts.maxBlocksPerTick ?? 10 * this.logChunk);
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  /** The next block logs will be read from. */
  get cursor(): number {
    return this.next;
  }

  /** Whether new heads arrive by subscription rather than polling. */
  get subscribed(): boolean {
    return this.subId !== null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Subscribe if possible, then run the first tick. Settles when that tick is done; never rejects. */
  start(): Promise<void> {
    this.started ??= (async () => {
      await this.subscribe();
      await this.tick();
    })();
    return this.started;
  }

  /** Stop polling, drop the subscription. A tick in flight finishes without delivering anything. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const t = this.chain.rpc as Transport & MessageEmitter;
    if (this.listener) {
      if (typeof t.removeListener === "function") t.removeListener("message", this.listener);
      else if (typeof t.off === "function") t.off("message", this.listener);
      this.listener = null;
    }
    if (this.subId) {
      this.chain.request("eth_unsubscribe", [this.subId]).catch(() => {});
      this.subId = null;
    }
  }

  /** Read the head and deliver new logs now (a tick already running is followed by one more). Never rejects. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const p = this.runOnce().then((delay): Promise<void> | undefined => {
      this.inflight = null;
      if (this.stopped) return undefined;
      const again = this.again && this.failures === 0;
      this.again = false;
      if (again) return this.tick();
      this.timer = setTimeout(() => void this.tick(), delay);
      return undefined;
    });
    this.inflight = p;
    return p;
  }

  private notice(n: FollowNotice): void {
    try {
      this.onNotice(n);
    } catch {
      // a listener's failure is its own
    }
  }

  private async subscribe(): Promise<void> {
    const t = this.chain.rpc as Transport & MessageEmitter;
    if (this.opts.subscribe === false || typeof t.on !== "function") return;
    try {
      const id = await this.chain.request<string>("eth_subscribe", ["newHeads"]);
      if (this.stopped) {
        this.chain.request("eth_unsubscribe", [id]).catch(() => {});
        return;
      }
      this.listener = (message: unknown) => {
        const m = message as { type?: unknown; data?: { subscription?: unknown } } | null;
        if (m && m.type === "eth_subscription" && m.data?.subscription === id) void this.tick();
      };
      t.on("message", this.listener);
      this.subId = id;
    } catch {
      // The provider does not push heads: poll.
    }
  }

  /** One tick; never rejects. Returns the wait before the next. */
  private async runOnce(): Promise<number> {
    try {
      const head = await this.chain.block("latest");
      if (this.stopped) return 0;
      const { logs, at } = await this.advance(head);
      if (this.stopped) return 0;
      await this.onLogs(logs, at);
      this.failures = 0;
      return this.subId ? this.pollMs * 10 : this.pollMs;
    } catch (e) {
      this.failures += 1;
      const wait = Math.min(this.maxBackoffMs, this.pollMs * 2 ** Math.min(this.failures, 16));
      if (!this.stopped) this.notice({ type: "error", error: e, retryInMs: wait });
      return wait;
    }
  }

  private rewind(head: Block): void {
    const last = this.last!;
    const from = Math.max(this.origin, Math.min(this.next, last.number - this.reorgDepth + 1));
    this.next = from;
    this.notice({ type: "reorg", fromBlock: from, head: head.number });
  }

  /**
   * The new logs up to `head`, after checking the chain still extends what was read, and the head
   * they were read to (the last one, when this one is a lagging node's older head).
   */
  private async advance(head: Block): Promise<{ logs: RawLog[]; at: Block }> {
    const last = this.last;
    let verify: Promise<Block> | null = null;
    if (last === null) {
      this.origin = this.opts.fromBlock ?? head.number + 1;
      this.next = this.origin;
    } else if (head.number <= last.number) {
      if (head.hash === (head.number === last.number ? last.hash : this.heads.get(head.number))) return { logs: [], at: last }; // nothing new
      if (head.number < last.number) {
        // An older head than the last: a load-balanced node behind the others, unless the last head
        // was replaced. A node that does not have the last block yet is behind; a shorter fork is
        // caught once the chain passes the last head again (its hash then differs).
        const b = await this.chain.block(last.number).catch(() => null);
        if (b === null || b.hash === last.hash) return { logs: [], at: last };
      }
      this.rewind(head);
    } else if (head.number === last.number + 1) {
      if (head.parentHash !== last.hash) this.rewind(head);
    }
    // A head further ahead than one tick reads is not taken on trust: read the block this tick would
    // stop at first. A node that cannot serve it reported a head it does not have (a bogus number
    // would otherwise send the follower through billions of eth_getLogs); one that can is caught up
    // with in steps, each delivered with the block it was read to.
    let at = head;
    if (head.number - this.next + 1 > this.maxBlocksPerTick) {
      const stop = this.next + this.maxBlocksPerTick - 1;
      const b = await this.chain.block(stop).catch((e: unknown) => {
        if (e instanceof RpcError) throw e; // the node failed: retried as any error is
        return null; // the node has no such block
      });
      if (b === null || b.number !== stop) {
        throw new Error(
          `The node reports block ${head.number} as its head, ${head.number - (last?.number ?? this.next - 1)} blocks past the last one read, but cannot serve block ${stop}: not following that head until it can.`,
        );
      }
      at = b;
      this.again = true; // go on with the next step as soon as this one is delivered
    }
    if (last !== null && head.number > last.number + 1) {
      verify = this.chain.block(last.number); // a gap: check the last head alongside the logs (a reorg is rare)
    }
    let [logs, check] = await Promise.all([this.read(this.next, at.number), verify]);
    if (check && check.hash !== last!.hash) {
      this.rewind(head);
      logs = await this.read(this.next, at.number);
    }
    const out: RawLog[] = [];
    for (const lg of logs) {
      const key = `${lg.blockHash}:${lg.logIndex}`;
      if (this.seen.has(key)) continue;
      this.seen.set(key, lg.blockNumber);
      out.push(lg);
    }
    const isNew = last === null || at.hash !== last.hash;
    this.next = at.number + 1;
    this.last = at;
    this.heads.set(at.number, at.hash);
    const keepFrom = at.number - 2 * this.reorgDepth;
    for (const [n] of this.heads) if (n < keepFrom) this.heads.delete(n);
    for (const [k, n] of this.seen) if (n < keepFrom) this.seen.delete(k);
    if (isNew) this.notice({ type: "head", block: at.number, timestamp: at.timestamp });
    return { logs: out, at };
  }

  private async read(from: number, to: number): Promise<RawLog[]> {
    const addrs = this.addresses();
    if (addrs.length === 0 || from > to) return [];
    const out: RawLog[] = [];
    let start = from;
    let size = this.logChunk;
    while (start <= to) {
      const end = Math.min(to, start + size - 1);
      try {
        for (const lg of await this.chain.logs(start, end, addrs)) out.push(lg);
        start = end + 1;
      } catch (e) {
        // A node that refuses a wide range (too many blocks or logs) is asked for half of it.
        if (end === start || !(e instanceof RpcError)) throw e;
        size = Math.max(1, Math.floor((end - start + 1) / 2));
      }
    }
    out.sort(byPosition);
    return out;
  }
}

// =====================================================================================================
// Watching a market and an account
// =====================================================================================================

export interface WatchOptions extends FollowOptions {
  /** Live prices ({@link LivePrices}): the venue for the snapshots, and the price accounts are valued at. */
  readonly prices?: LivePriceView | null;
  /** Without live prices, let snapshots ask the context's Hermes source (see {@link SnapshotOptions.fetchPrices}); default true. */
  readonly fetchPrices?: boolean;
  /** Refresh snapshots at least this often (ms) even without events: funding accrues and clocks run. Default 15000; 0 for events only. */
  readonly refreshMs?: number;
  /** The least time (ms) between two event-driven refreshes: events in between are folded into one. Default 1000. */
  readonly minSnapshotMs?: number;
  /** Deliver snapshots as soon as the watch starts; default true. */
  readonly initial?: boolean;
}

export type SnapshotCause = "initial" | "events" | "timer" | "manual";

/**
 * A log from a watched contract that could not be decoded (a malformed or unexpected event): it is
 * reported here and skipped, and the rest of its batch is still delivered.
 */
export interface UndecodableLog {
  readonly type: "undecodable";
  readonly log: RawLog;
  readonly error: unknown;
}

export type MarketUpdate =
  | { readonly type: "event"; readonly event: LiveEvent }
  /** `bookChanged`: a Trade, OrderUpdated or OrderAmended landed since the last snapshot (re-read the depth). */
  | { readonly type: "snapshot"; readonly snapshot: MarketSnapshot; readonly cause: SnapshotCause; readonly bookChanged: boolean }
  | UndecodableLog
  | FollowNotice;

export type AccountUpdate =
  | { readonly type: "event"; readonly event: LiveEvent }
  | { readonly type: "account"; readonly snapshot: AccountSnapshot; readonly cause: SnapshotCause }
  | UndecodableLog
  | FollowNotice;

/** decodeLiveLog, with a failure reported as an {@link UndecodableLog} and read as no event. */
function decodeOrReport(log: RawLog, terminator: Address, report: (u: UndecodableLog) => void): LiveEvent | null {
  try {
    return decodeLiveLog(log, terminator);
  } catch (error) {
    report({ type: "undecodable", log, error });
    return null;
  }
}

export interface WatchHandle {
  /** Settles once the watch has started and delivered its first snapshots (or reported why not). */
  readonly ready: Promise<void>;
  /** Read the head and refresh every snapshot now. */
  refresh(): Promise<void>;
  /** End the watch: no update is delivered after this returns. */
  stop(): void;
  readonly stopped: boolean;
}

const BOOK_EVENTS: ReadonlySet<string> = new Set(["Trade", "OrderUpdated", "OrderAmended"]);

// Market-wide events that change every account's standing on the pair.
const MARKET_STATE_EVENTS: ReadonlySet<string> = new Set([
  "AdlTriggered",
  "AdlResolved",
  "AdlTerminationArmed",
  "InsolvencySettlementFixed",
  "PairTerminated",
  "TerminalRatiosRefrozen",
]);

// The arguments that name an account, per pair event.
const ACCOUNT_ARGS: Readonly<Record<string, readonly string[]>> = {
  Trade: ["maker", "taker"],
  OrderUpdated: ["owner"],
  OrderAmended: ["owner"],
  OrderAmendSkipped: ["owner"],
  PositionBucketUpdated: ["owner"],
  PositionModified: ["user"],
  CollateralDeposited: ["user"],
  CollateralWithdrawn: ["user"],
  FeeAccrued: ["recipient"],
  FeesClaimed: ["recipient"],
  TriggerBountyReleased: ["recipient"],
  MetaTransactionExecuted: ["user", "relayer"],
  PermitExecutionFailed: ["owner"],
  UserAdld: ["user"],
  PositionLiquidated: ["liquidatedUser", "liquidator"],
  AdlExecuted: ["submitter"],
  InsuranceCredited: ["from"],
  InsuranceDeposited: ["user"],
  InsuranceWithdrawalRequested: ["user"],
  InsuranceWithdrawalLocked: ["user"],
  InsuranceWithdrawalExecuted: ["user"],
};

function safe<U>(onUpdate: (u: U) => void, stopped: () => boolean): (u: U) => void {
  return (u) => {
    if (stopped()) return;
    try {
      onUpdate(u);
    } catch {
      // a listener's failure must not stop the watch
    }
  };
}

function priority(a: SnapshotCause | null, b: SnapshotCause): SnapshotCause {
  if (a === null) return b;
  const rank: Record<SnapshotCause, number> = { timer: 0, events: 1, manual: 2, initial: 3 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Watch one market: every pair event it emits (and terminator events about it) as typed
 * {@link LiveEvent}s, and a fresh {@link MarketSnapshot} at the head after events (at most one per
 * `minSnapshotMs`), every `refreshMs`, and on {@link WatchHandle.refresh}. Returns at once; stop it with
 * the handle (e.g. in a React effect's cleanup).
 */
export function watchMarket(ctx: BazaarContext, market: MarketRef, onUpdate: (u: MarketUpdate) => void, opts: WatchOptions = {}): WatchHandle {
  let info: MarketInfo | null = typeof market === "string" ? null : market;
  let dirty: SnapshotCause | null = opts.initial === false ? null : "initial";
  let bookChanged = false;
  let lastSnapshot = 0;
  const refreshMs = opts.refreshMs ?? 15_000;
  const minMs = opts.minSnapshotMs ?? 1_000;
  let follower: LogFollower | null = null;
  const emit = safe(onUpdate, () => follower?.isStopped ?? false);

  follower = new LogFollower(
    ctx.chain,
    () => (info ? [info.address, ctx.terminator] : []),
    async (logs, head) => {
      const m = info!;
      for (const lg of logs) {
        const e = decodeOrReport(lg, ctx.terminator, emit);
        if (!e || e.market !== m.address) continue;
        emit({ type: "event", event: e });
        dirty = priority(dirty, "events");
        if (BOOK_EVENTS.has(e.name)) bookChanged = true;
      }
      const now = Date.now();
      if (dirty === null && refreshMs > 0 && now - lastSnapshot >= refreshMs) dirty = "timer";
      if (dirty === null || (dirty === "events" && now - lastSnapshot < minMs)) return;
      const cause = dirty;
      const book = bookChanged;
      bookChanged = false;
      const snap = (await marketSnapshots(ctx, [m], { block: head, prices: opts.prices, fetchPrices: opts.fetchPrices })).get(m.address);
      if (!snap) {
        bookChanged ||= book;
        throw new Error(`could not read the state of market ${m.label || m.address}`);
      }
      emit({ type: "snapshot", snapshot: snap, cause, bookChanged: book });
      if (dirty === cause) dirty = null; // a refresh asked for meanwhile still runs
      lastSnapshot = Date.now();
    },
    (n) => emit(n),
    opts,
  );
  const f = follower;
  const ready = (async () => {
    if (!info) {
      try {
        info = await getMarket(ctx, market);
      } catch (e) {
        emit({ type: "error", error: e, retryInMs: null });
        f.stop();
        return;
      }
    }
    await f.start();
  })();
  return {
    ready,
    async refresh() {
      await ready;
      dirty = priority(dirty, "manual");
      await f.tick();
    },
    stop: () => f.stop(),
    get stopped() {
      return f.isStopped;
    },
  };
}

/**
 * Watch one account on a set of markets: the events that concern it (its fills, orders, position,
 * collateral, fees, liquidation or deleverage, insurance) and the market-wide ones that change its
 * standing (ADL, settlement, termination, terminator schedules), as typed {@link LiveEvent}s, and a
 * fresh {@link AccountSnapshot} for each market an event touched (all of them read in one pass), for
 * every market every `refreshMs`, and on {@link WatchHandle.refresh}. Returns at once.
 *
 * Health between snapshots follows the live price without any read: pass each new price to
 * {@link accountHealth}.
 */
export function watchAccount(
  ctx: BazaarContext,
  user: Address,
  markets: readonly MarketRef[],
  onUpdate: (u: AccountUpdate) => void,
  opts: WatchOptions = {},
): WatchHandle {
  const owner = getAddress(user);
  let infos: MarketInfo[] = [];
  const byAddress = new Map<Address, MarketInfo>();
  const dirty = new Map<Address, SnapshotCause>();
  const last = new Map<Address, AccountSnapshot>();
  let lastRefresh = 0;
  let lastAll = 0;
  const refreshMs = opts.refreshMs ?? 15_000;
  const minMs = opts.minSnapshotMs ?? 1_000;
  let follower: LogFollower | null = null;
  const emit = safe(onUpdate, () => follower?.isStopped ?? false);

  const markAll = (cause: SnapshotCause) => {
    for (const m of infos) dirty.set(m.address, priority(dirty.get(m.address) ?? null, cause));
  };
  const concerns = (e: LiveEvent, ownOrders: ReadonlySet<bigint>): boolean => {
    if (e.source === "terminator") return true;
    if (MARKET_STATE_EVENTS.has(e.name)) return true;
    if (e.name === "TriggerBountyEscrowed") return ownOrders.has(e.args.orderId);
    const fields = ACCOUNT_ARGS[e.name];
    if (!fields) return false;
    const args = e.args as Readonly<Record<string, unknown>>;
    return fields.some((f) => typeof args[f] === "string" && getAddress(args[f] as string) === owner);
  };

  follower = new LogFollower(
    ctx.chain,
    () => (infos.length ? [...infos.map((m) => m.address), ctx.terminator] : []),
    async (logs, head) => {
      const ownOrders = new Map<Address, Set<bigint>>();
      const ordersOf = (a: Address) => {
        let s = ownOrders.get(a);
        if (!s) {
          s = new Set((last.get(a)?.orders ?? []).map((o) => o.orderId));
          ownOrders.set(a, s);
        }
        return s;
      };
      for (const lg of logs) {
        const e = decodeOrReport(lg, ctx.terminator, emit);
        if (!e || !byAddress.has(e.market)) continue;
        if (e.source === "pair" && e.name === "OrderUpdated" && e.args.owner === owner) ordersOf(e.market).add(e.args.orderId);
        if (!concerns(e, ordersOf(e.market))) continue;
        emit({ type: "event", event: e });
        dirty.set(e.market, priority(dirty.get(e.market) ?? null, "events"));
      }
      const now = Date.now();
      if (refreshMs > 0 && now - lastAll >= refreshMs) markAll("timer");
      if (dirty.size === 0) return;
      const onlyEvents = [...dirty.values()].every((c) => c === "events");
      if (onlyEvents && now - lastRefresh < minMs) return;
      const want = infos.filter((m) => dirty.has(m.address));
      const causes = new Map(dirty);
      const snaps = await accountSnapshots(ctx, owner, want, { block: head, prices: opts.prices, fetchPrices: opts.fetchPrices });
      for (const s of snaps) {
        const a = s.market.address;
        last.set(a, s);
        emit({ type: "account", snapshot: s, cause: causes.get(a) ?? "events" });
        if (dirty.get(a) === causes.get(a)) dirty.delete(a); // a refresh asked for meanwhile still runs
      }
      // A market whose own state read failed stays dirty and is retried on the next tick.
      lastRefresh = Date.now();
      if (want.length === infos.length) lastAll = lastRefresh;
      if (dirty.size > 0) throw new Error(`could not read the account on ${[...dirty.keys()].join(", ")}`);
    },
    (n) => emit(n),
    opts,
  );
  const f = follower;
  const ready = (async () => {
    try {
      infos = await Promise.all(markets.map((m) => getMarket(ctx, m)));
    } catch (e) {
      emit({ type: "error", error: e, retryInMs: null });
      f.stop();
      return;
    }
    for (const m of infos) byAddress.set(m.address, m);
    if (opts.initial !== false) markAll("initial");
    else lastAll = Date.now();
    await f.start();
  })();
  return {
    ready,
    async refresh() {
      await ready;
      markAll("manual");
      await f.tick();
    },
    stop: () => f.stop(),
    get stopped() {
      return f.isStopped;
    },
  };
}
