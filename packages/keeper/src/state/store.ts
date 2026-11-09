/**
 * The keeper's local index: markets, open positions and live orders, kept current from logs.
 *
 * Every event the store applies reports the full state of what it describes (a position bucket, an
 * order at an update), except fills and bounty movements, which report deltas. Planners never act on
 * the store alone: they re-read candidates from the chain before simulating (the SDK's Reader).
 *
 * Every log the keeper sees goes through {@link Store.applyRaw}, so it is kept cheap: a market's log
 * is dispatched by its topic0 through one precomputed Map to a handler, and decoded (once) only when
 * the handler needs its arguments. Most events only mark their market for a state re-read and are
 * never decoded. Effects accumulate into the caller's {@link Effects} instead of one per log.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import {
  type DecodedLog,
  type Market,
  type MarketStatic,
  type Order,
  type Position,
  type RawLog,
  TRIGGER_PRICE_MASK,
  ZERO_ADDRESS,
  factory as factoryCodec,
  marketFromStatic,
  marketStatic,
  pair as pairCodec,
  terminator as terminatorCodec,
} from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";

/**
 * The snapshot format. 1 is the Python keeper's (snake_case, integers as JSON numbers); this one
 * writes camelCase with every bigint as a decimal string. Each keeper ignores the other's snapshot
 * and bootstraps afresh.
 */
export const SNAPSHOT_VERSION = 2;

/** What applying logs changed, for the engine to act on. */
export class Effects {
  /** markets whose state should be re-read */
  dirty = new Set<Address>();
  bookChanged = new Set<Address>();
  claimsChanged = false;
  newPairs: Address[] = [];
  liquidations = new Set<Address>();
  /** the first block of the logs these effects come from */
  firstBlock: number | null = null;

  merge(other: Effects): void {
    for (const a of other.dirty) this.dirty.add(a);
    for (const a of other.bookChanged) this.bookChanged.add(a);
    this.claimsChanged ||= other.claimsChanged;
    for (const p of other.newPairs) if (!this.newPairs.includes(p)) this.newPairs.push(p);
    for (const a of other.liquidations) this.liquidations.add(a);
    if (other.firstBlock !== null && (this.firstBlock === null || other.firstBlock < this.firstBlock)) {
      this.firstBlock = other.firstBlock;
    }
  }
}

// ---- pair events ----

type Args = Record<string, unknown>;
type Update = (s: Store, m: Address, a: Args, block: number) => void;

interface PairHandler {
  readonly name: string;
  /** the event changes what the per-block state read returns */
  readonly state: boolean;
  readonly book: boolean;
  readonly liquidation: boolean;
  /** FeeAccrued / FeesClaimed: claims change when `recipient` is one of the keeper's wallets */
  readonly claims: boolean;
  /** what the event changes in the store's positions and orders */
  readonly update: Update | null;
}

// Pair events that change what the per-block state read returns.
const STATE_EVENTS = [
  "NewPriceUpdateAdded", "PositionLiquidated", "AdlExecuted", "AdlTriggered", "AdlResolved",
  "AdlTerminationArmed", "InsolvencySettlementFixed", "PairTerminated", "UserAdld", "InsuranceDeposited",
  "InsuranceWithdrawalExecuted", "InsuranceCredited", "TerminalRatiosRefrozen",
];
const BOOK_EVENTS = ["Trade", "OrderUpdated", "OrderAmended"];
const CLAIM_EVENTS = ["FeeAccrued", "FeesClaimed"];

const big = (x: unknown): bigint => (typeof x === "bigint" ? x : BigInt(x as number | string));
const num = (x: unknown): number => (typeof x === "number" ? x : Number(x as bigint | string));

function setPosition(s: Store, m: Address, a: Args, block: number): void {
  const acct = a.owner as Address;
  const size = big(a.size);
  const book = s.positionsOf(m);
  if (size === 0n) {
    book.delete(acct);
    return;
  }
  book.set(acct, {
    account: acct,
    isLong: Boolean(a.isLong),
    size,
    entryValue: big(a.entryValue),
    collateral: big(a.collateral),
    entryFundingIndex: big(a.entryFundingIndex),
    block,
  });
}

function orderUpdated(s: Store, m: Address, a: Args, block: number): void {
  const p = a.payload as Args;
  const oid = big(a.orderId);
  const orders = s.ordersOf(m);
  const prev = orders.get(oid);
  const terminal = big(p.canceledBlock) !== 0n || big(p.filledBlock) !== 0n;
  const o: Order = {
    orderId: oid,
    owner: a.owner as Address,
    orderType: num(p.orderType),
    isLong: Boolean(p.isLong),
    size: big(p.size),
    filled: big(p.filledSize),
    triggerPrice: big(p.triggerPrice) & TRIGGER_PRICE_MASK,
    limitPrice: big(p.limitPrice),
    expiryBlock: num(p.expiryBlock),
    terminal,
    inBook: terminal ? false : null,
    bounty: prev ? prev.bounty : 0n,
    block,
    known: true,
  };
  orders.set(oid, o);
  maybeForget(orders, o);
}

function orderAmended(s: Store, m: Address, a: Args, block: number): void {
  const o = s.orders.get(m)?.get(big(a.orderId));
  if (o) {
    o.limitPrice = big(a.limitPrice);
    o.size = big(a.size);
    o.block = block;
  }
}

function fill(orders: Map<bigint, Order>, orderId: unknown, remaining: unknown): void {
  const oid = big(orderId);
  if (oid === 0n) return;
  const o = orders.get(oid);
  if (!o || !o.known) return;
  const rem = big(remaining);
  if (o.size >= rem && o.size - rem > o.filled) o.filled = o.size - rem;
  if (rem === 0n) {
    o.terminal = true;
    o.inBook = false;
  }
}

function trade(s: Store, m: Address, a: Args): void {
  const orders = s.orders.get(m);
  if (!orders) return;
  fill(orders, a.makerOrderId, a.makerRemaining);
  fill(orders, a.takerOrderId, a.takerRemaining);
}

function bountyEscrowed(s: Store, m: Address, a: Args): void {
  const oid = big(a.orderId);
  const orders = s.ordersOf(m);
  let o = orders.get(oid);
  if (!o) {
    // The escrow comes before the order's own creation event, in the same transaction.
    o = stubOrder(oid);
    orders.set(oid, o);
  }
  o.bounty += big(a.amount);
}

function bountyReleased(s: Store, m: Address, a: Args): void {
  const orders = s.orders.get(m);
  const o = orders?.get(big(a.orderId));
  if (!orders || !o) return;
  const amount = big(a.amount);
  o.bounty = o.bounty > amount ? o.bounty - amount : 0n;
  maybeForget(orders, o);
}

/** A finished order that holds no bounty has nothing left to do: forgotten. */
function maybeForget(orders: Map<bigint, Order>, o: Order): void {
  if (o.terminal && o.bounty === 0n) orders.delete(o.orderId);
}

/** An order known only from a bounty event that preceded its own (owner unknown: the zero address). */
const stubOrder = (orderId: bigint): Order => ({
  orderId,
  owner: ZERO_ADDRESS,
  orderType: 0,
  isLong: false,
  size: 0n,
  filled: 0n,
  triggerPrice: 0n,
  limitPrice: 0n,
  expiryBlock: 0,
  terminal: false,
  inBook: null,
  bounty: 0n,
  block: 0,
  known: false,
});

const UPDATES: Readonly<Record<string, Update>> = {
  PositionBucketUpdated: setPosition,
  OrderUpdated: orderUpdated,
  OrderAmended: orderAmended,
  Trade: trade,
  TriggerBountyEscrowed: bountyEscrowed,
  TriggerBountyReleased: bountyReleased,
};

interface Handlers {
  readonly byName: ReadonlyMap<string, PairHandler>;
  readonly byTopic: ReadonlyMap<Hex, PairHandler>;
  readonly pairDeployed: Hex;
}

let handlerTables: Handlers | null = null;

/** The pair events the store reacts to, by name and by topic0; built once. */
function handlers(): Handlers {
  if (handlerTables) return handlerTables;
  const P = pairCodec();
  const byName = new Map<string, PairHandler>();
  const byTopic = new Map<Hex, PairHandler>();
  const names = new Set([...STATE_EVENTS, ...BOOK_EVENTS, ...CLAIM_EVENTS, "PositionLiquidated", ...Object.keys(UPDATES)]);
  for (const name of names) {
    const h: PairHandler = {
      name,
      state: STATE_EVENTS.includes(name),
      book: BOOK_EVENTS.includes(name),
      liquidation: name === "PositionLiquidated",
      claims: CLAIM_EVENTS.includes(name),
      update: UPDATES[name] ?? null,
    };
    byName.set(name, h);
    const spec = P.eventByName.get(name);
    if (spec) byTopic.set(spec.topic0, h);
  }
  handlerTables = { byName, byTopic, pairDeployed: factoryCodec().topic("PairDeployed") };
  return handlerTables;
}

/** The names of the pair events the store reacts to (for tests that check them against the ABI). */
export function handledPairEvents(): string[] {
  return [...handlers().byName.keys()];
}

/** The arguments handed to a handler whose event is never decoded. */
const EMPTY_ARGS: Args = Object.freeze({}) as Args;

function addNewPair(fx: Effects, pairAddress: unknown): void {
  const p = pairAddress as Address;
  if (!fx.newPairs.includes(p)) fx.newPairs.push(p);
}

// ---- snapshots ----

interface PositionJson {
  account: Address;
  isLong: boolean;
  size: string;
  entryValue: string;
  collateral: string;
  entryFundingIndex: string;
  block: number;
}

interface OrderJson {
  orderId: string;
  owner: Address;
  orderType: number;
  isLong: boolean;
  size: string;
  filled: string;
  triggerPrice: string;
  limitPrice: string;
  expiryBlock: number;
  terminal: boolean;
  inBook: boolean | null;
  bounty: string;
  block: number;
  known: boolean;
}

interface SnapshotJson {
  version: number;
  chainId: number;
  factory: Address;
  head: number;
  headHash: string;
  markets: MarketStatic[];
  positions: Record<string, PositionJson[]>;
  orders: Record<string, OrderJson[]>;
}

class SnapshotFormatError extends Error {}

const DECIMAL = /^-?[0-9]+$/;
function decBig(x: unknown): bigint {
  if (typeof x !== "string" || !DECIMAL.test(x)) throw new SnapshotFormatError(`not a decimal integer: ${String(x)}`);
  return BigInt(x);
}
function decNum(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new SnapshotFormatError(`not a number: ${String(x)}`);
  return x;
}
function decBool(x: unknown): boolean {
  if (typeof x !== "boolean") throw new SnapshotFormatError(`not a boolean: ${String(x)}`);
  return x;
}
function decStr<T extends string = string>(x: unknown): T {
  if (typeof x !== "string") throw new SnapshotFormatError(`not a string: ${String(x)}`);
  return x as T;
}
function decObj(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new SnapshotFormatError("not an object");
  return x as Record<string, unknown>;
}
function decArr(x: unknown): unknown[] {
  if (!Array.isArray(x)) throw new SnapshotFormatError("not an array");
  return x;
}

const positionJson = (p: Position): PositionJson => ({
  account: p.account,
  isLong: p.isLong,
  size: p.size.toString(),
  entryValue: p.entryValue.toString(),
  collateral: p.collateral.toString(),
  entryFundingIndex: p.entryFundingIndex.toString(),
  block: p.block,
});

function positionFromJson(x: unknown): Position {
  const d = decObj(x);
  return {
    account: decStr<Address>(d.account),
    isLong: decBool(d.isLong),
    size: decBig(d.size),
    entryValue: decBig(d.entryValue),
    collateral: decBig(d.collateral),
    entryFundingIndex: decBig(d.entryFundingIndex),
    block: decNum(d.block),
  };
}

const orderJson = (o: Order): OrderJson => ({
  orderId: o.orderId.toString(),
  owner: o.owner,
  orderType: o.orderType,
  isLong: o.isLong,
  size: o.size.toString(),
  filled: o.filled.toString(),
  triggerPrice: o.triggerPrice.toString(),
  limitPrice: o.limitPrice.toString(),
  expiryBlock: o.expiryBlock,
  terminal: o.terminal,
  inBook: o.inBook,
  bounty: o.bounty.toString(),
  block: o.block,
  known: o.known,
});

function orderFromJson(x: unknown): Order {
  const d = decObj(x);
  return {
    orderId: decBig(d.orderId),
    owner: decStr<Address>(d.owner),
    orderType: decNum(d.orderType),
    isLong: decBool(d.isLong),
    size: decBig(d.size),
    filled: decBig(d.filled),
    triggerPrice: decBig(d.triggerPrice),
    limitPrice: decBig(d.limitPrice),
    expiryBlock: decNum(d.expiryBlock),
    terminal: decBool(d.terminal),
    inBook: d.inBook === null ? null : decBool(d.inBook),
    bounty: decBig(d.bounty),
    block: decNum(d.block),
    known: decBool(d.known),
  };
}

function marketFromJson(x: unknown): Market {
  const d = decObj(x);
  return marketFromStatic({
    address: decStr<Address>(d.address),
    pairId: decStr<Hex>(d.pairId),
    baseFeedId: decStr<Hex>(d.baseFeedId),
    legs: decArr(d.legs).map((l) => decStr<Hex>(l)),
    invertQuote: decBool(d.invertQuote),
    continuous: decBool(d.continuous),
    description: d.description === undefined ? "" : decStr(d.description),
    label: d.label === undefined ? "" : decStr(d.label),
  });
}

/** `snapshot.json` -> `snapshot.tmp`, as Python's `Path.with_suffix(".tmp")`. */
function tmpPath(path: string): string {
  return path.slice(0, path.length - extname(path).length) + ".tmp";
}

export class Store {
  markets = new Map<Address, Market>();
  /** open positions, by market, then account */
  positions = new Map<Address, Map<Address, Position>>();
  /** live orders and finished ones still holding a bounty, by market, then order id */
  orders = new Map<Address, Map<bigint, Order>>();
  /** last block whose logs are applied */
  head = -1;
  /** hash of `head` once a sync step completes there; "" while unknown */
  headHash = "";

  // ---- markets ----
  addMarket(m: Market): void {
    this.markets.set(m.address, m);
    if (!this.positions.has(m.address)) this.positions.set(m.address, new Map());
    if (!this.orders.has(m.address)) this.orders.set(m.address, new Map());
  }

  marketByPairId(pairId: Hex): Market | null {
    const id = pairId.toLowerCase();
    for (const m of this.markets.values()) if (m.pairId.toLowerCase() === id) return m;
    return null;
  }

  /** The market's positions (created empty if the market has none yet). */
  positionsOf(m: Address): Map<Address, Position> {
    let b = this.positions.get(m);
    if (!b) {
      b = new Map();
      this.positions.set(m, b);
    }
    return b;
  }

  /** The market's orders (created empty if the market has none yet). */
  ordersOf(m: Address): Map<bigint, Order> {
    let b = this.orders.get(m);
    if (!b) {
      b = new Map();
      this.orders.set(m, b);
    }
    return b;
  }

  // ---- applying logs ----

  /**
   * Apply a log as Chain.logs returns it: the factory's, the terminator's or a market's (anything else
   * is ignored). What it changed is added to `fx`, which is returned.
   */
  applyRaw(log: RawLog, wallets: ReadonlySet<Address>, factory: Address, terminator: Address, fx: Effects = new Effects()): Effects {
    const m = log.address;
    if (m === factory) {
      if (log.topics[0] === handlers().pairDeployed) {
        const d = factoryCodec().decodeLog(log);
        if (d) addNewPair(fx, d.args.pairAddress);
      }
      return fx;
    }
    if (m === terminator) {
      const d = terminatorCodec().decodeLog(log);
      if (d) this.terminatorEvent(d.args, fx);
      return fx;
    }
    if (!this.markets.has(m)) return fx;
    const t0 = log.topics[0];
    const h = t0 === undefined ? undefined : handlers().byTopic.get(t0);
    if (!h) return fx;
    if (h.update === null && !h.claims) {
      this.pairEvent(h, m, EMPTY_ARGS, log.blockNumber, wallets, fx);
      return fx;
    }
    const d = pairCodec().decodeLog(log);
    if (d) this.pairEvent(h, m, d.args, log.blockNumber, wallets, fx);
    return fx;
  }

  /** Apply a decoded log. What it changed is added to `fx`, which is returned. */
  apply(log: DecodedLog, wallets: ReadonlySet<Address>, factory: Address, terminator: Address, fx: Effects = new Effects()): Effects {
    const a = log.args;
    if (log.address === factory) {
      if (log.name === "PairDeployed") addNewPair(fx, a.pairAddress);
      return fx;
    }
    if (log.address === terminator) {
      this.terminatorEvent(a, fx);
      return fx;
    }
    const m = log.address;
    if (!this.markets.has(m)) return fx;
    const h = handlers().byName.get(log.name);
    if (h) this.pairEvent(h, m, a, log.blockNumber, wallets, fx);
    return fx;
  }

  private terminatorEvent(a: Args, fx: Effects): void {
    const p = a.pair;
    if (typeof p === "string" && this.markets.has(p as Address)) fx.dirty.add(p as Address);
    else for (const k of this.markets.keys()) fx.dirty.add(k);
  }

  private pairEvent(h: PairHandler, m: Address, a: Args, block: number, wallets: ReadonlySet<Address>, fx: Effects): void {
    if (h.state) fx.dirty.add(m);
    if (h.book) fx.bookChanged.add(m);
    if (h.liquidation) fx.liquidations.add(m);
    if (h.claims && wallets.has(a.recipient as Address)) fx.claimsChanged = true;
    if (h.update) h.update(this, m, a, block);
  }

  // ---- snapshots ----

  /** Write the store to `path` atomically: a temp file beside it, flushed, then renamed over it. */
  save(path: string, chainId: number, factory: Address): void {
    const positions: Record<string, PositionJson[]> = {};
    for (const [k, v] of this.positions) positions[k] = Array.from(v.values(), positionJson);
    const orders: Record<string, OrderJson[]> = {};
    for (const [k, v] of this.orders) orders[k] = Array.from(v.values(), orderJson);
    const data: SnapshotJson = {
      version: SNAPSHOT_VERSION,
      chainId,
      factory,
      head: this.head,
      headHash: this.headHash,
      markets: Array.from(this.markets.values(), marketStatic),
      positions,
      orders,
    };
    const tmp = tmpPath(path);
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, JSON.stringify(data), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  /**
   * The store saved at `path`, or null when there is none, it cannot be read, or it was written for
   * another snapshot version, chain or factory.
   */
  static load(path: string, chainId: number, factory: Address): Store | null {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    if (d.version !== SNAPSHOT_VERSION || d.chainId !== chainId) return null;
    if (typeof d.factory !== "string" || d.factory.toLowerCase() !== factory.toLowerCase()) return null;
    try {
      const s = new Store();
      for (const x of decArr(d.markets)) s.addMarket(marketFromJson(x));
      for (const [k, v] of Object.entries(decObj(d.positions))) {
        const book = s.positionsOf(k as Address);
        for (const x of decArr(v)) {
          const p = positionFromJson(x);
          book.set(p.account, p);
        }
      }
      for (const [k, v] of Object.entries(decObj(d.orders))) {
        const book = s.ordersOf(k as Address);
        for (const x of decArr(v)) {
          const o = orderFromJson(x);
          book.set(o.orderId, o);
        }
      }
      s.head = decNum(d.head);
      s.headHash = d.headHash === undefined ? "" : decStr(d.headHash);
      return s;
    } catch (e) {
      if (e instanceof SnapshotFormatError) return null;
      throw e;
    }
  }
}

