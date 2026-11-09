/**
 * A Keeper over hand-built store state, for the job and engine tests: no RPC and no price endpoint.
 * The Reader's candidate reads are stubbed (answering from `chainBuckets` / `chainOrders`, or from the
 * store when those leave an entry out) and recorded in `calls`.
 */

import {
  type Market,
  type MarketState,
  type Order,
  type OrderRecord,
  type Position,
  type PositionBucket,
  type Print,
  STOP_LOSS,
  ZERO_ADDRESS,
  emptyInventory,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, getAddress } from "viem";
import { parseConfig } from "../src/config/index.js";
import { Lane } from "../src/exec/executor.js";
import { LocalSigner } from "../src/exec/wallets.js";
import { Keeper } from "../src/keeper/engine.js";

export const S = 10n ** 18n;
export const FEED = `0x${"01".repeat(32)}` as Hex;
export const FEED2 = `0x${"02".repeat(32)}` as Hex;
/** Anvil's first key, and its address: the keeper's own wallet in these tests. */
export const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ME = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
export const FACTORY = getAddress(`0x${"12".repeat(20)}`);
export const DEP = {
  factory: FACTORY,
  lens: getAddress(`0x${"1e".repeat(20)}`),
  terminator: getAddress(`0x${"7e".repeat(20)}`),
  oracle: getAddress(`0x${"0c".repeat(20)}`),
  usdc: getAddress(`0x${"0d".repeat(20)}`),
};
export const FEE = 7n;
export const NEVER = 2 ** 64 - 1; // an order that never expires

/** A distinct account address per number. */
export const acct = (n: number): Address => getAddress(`0x${"ac".repeat(18)}${n.toString(16).padStart(4, "0")}`);

export function marketAt(n: number, legs: Hex[] = [FEED], continuous = true): Market {
  const b = n.toString(16).padStart(2, "0");
  return {
    address: getAddress(`0x${b.repeat(20)}`),
    pairId: `0x${b.repeat(32)}` as Hex,
    baseFeedId: legs[0]!,
    legs,
    invertQuote: false,
    continuous,
    description: `market ${n}`,
    label: n === 1 ? "ETH/USD" : `M${n}`,
    state: null,
    dirty: false,
    lastRead: 0,
  };
}

export function marketState(now: number, o: Partial<MarketState> = {}): MarketState {
  return {
    block: 1_000,
    timestamp: now,
    spot: 2_000n * S,
    updateTs: now - 10,
    imrBp: 1_000n,
    mmrBp: 500n,
    laggedMmrBp: 0n,
    fundingIndex: 0n,
    projectedFundingIndex: 0n,
    adlPending: false,
    adlAuctionStart: 0,
    adlTerminationTs: 0,
    settlementFixedTs: 0,
    scheduledTs: 0,
    terminated: false,
    longOi: 0n,
    shortOi: 0n,
    insurance: 0n,
    deficit: 0n,
    longInv: emptyInventory(),
    shortInv: emptyInventory(),
    ...o,
  };
}

/** One unit, long or short, entered at `entryUsd`, holding `collateralUsd`. */
export function position(account: Address, collateralUsd: number, o: Partial<Position> = {}): Position {
  return {
    account,
    isLong: true,
    size: S,
    entryValue: 2_000n * S,
    collateral: BigInt(collateralUsd) * S,
    entryFundingIndex: 0n,
    block: 1,
    ...o,
  };
}

export function order(orderId: bigint, o: Partial<Order> = {}): Order {
  return {
    orderId,
    owner: acct(900),
    orderType: STOP_LOSS,
    isLong: false,
    size: S,
    filled: 0n,
    triggerPrice: 1_950n * S,
    limitPrice: 0n,
    expiryBlock: NEVER,
    terminal: false,
    inBook: false,
    bounty: S / 10n,
    block: 1,
    known: true,
    ...o,
  };
}

export function recordOf(o: Order): OrderRecord {
  return {
    creator: o.owner,
    canceledBlock: 0,
    orderType: o.orderType,
    isLong: o.isLong,
    isPostOnly: false,
    tif: 0,
    integrator: ZERO_ADDRESS,
    expiryBlock: o.expiryBlock,
    inBook: Boolean(o.inBook),
    maxSlippageBp: 0n,
    triggerPrice: o.triggerPrice,
    limitPrice: o.limitPrice,
    size: o.size,
    filledSize: o.filled,
    prioritySeq: 0,
    filledBlock: 0,
    restedBlock: 0,
    restedPremiumPpm: 0n,
    prevInBook: 0n,
    nextInBook: 0n,
    bounty: o.bounty,
  };
}

/** A Pyth print for `feed` at `usd` (expo -8), published `age` seconds before `now`. */
export function print(feed: Hex, usd: number, publishTime: number): Print {
  return {
    feedId: feed,
    price: BigInt(Math.round(usd * 1e8)),
    conf: 10_000_000n,
    expo: -8,
    publishTime,
    prevPublishTime: publishTime - 1,
    blob: "0xaa",
    received: 0,
  };
}

export interface Calls {
  buckets: Address[][];
  orders: bigint[][];
  fees: Hex[][];
  deposits: Address[][];
  predecessors: bigint[];
  claimable: Address[];
}

export interface Fake {
  k: Keeper;
  m: Market;
  now: number;
  /** what the chain holds, where it differs from the store */
  chainBuckets: Map<Address, PositionBucket>;
  chainOrders: Map<bigint, Partial<OrderRecord>>;
  deposits: Map<Address, bigint>;
  claimable: Map<Address, bigint>;
  usdc: bigint;
  calls: Calls;
  /** a fresh print at `usd` for the market's leg */
  printAt(usd: number, age?: number): void;
  /** the keeper's own wallet, as a lane */
  addWallet(): void;
}

export function fake(dir: string, cfg: Record<string, unknown> = {}, opts: { continuous?: boolean } = {}): Fake {
  const config = parseConfig({
    network: "anvil",
    factory: FACTORY,
    rpc: { http: "http://127.0.0.1:1" },
    prices: { endpoint: "http://127.0.0.1:1" },
    subgraph: { url: "none" },
    state: { dir },
    ...cfg,
  });
  const k = new Keeper(config, { loadWallets: false });
  const now = k.now();
  const m = marketAt(1, [FEED], opts.continuous ?? true);
  m.state = marketState(now);
  k.store.addMarket(m);
  k.head = 1_000;
  k.dep = DEP;
  k.reader.dep = DEP;
  const f: Fake = {
    k,
    m,
    now,
    chainBuckets: new Map(),
    chainOrders: new Map(),
    deposits: new Map(),
    claimable: new Map(),
    usdc: 0n,
    calls: { buckets: [], orders: [], fees: [], deposits: [], predecessors: [], claimable: [] },
    printAt(usd: number, age = 0) {
      k.prices.ingest([print(FEED, usd, k.now() - age)]);
    },
    addWallet() {
      k.executor.lanes.set("default", new Lane("default", new LocalSigner(KEY)));
    },
  };
  k.reader.buckets = async (pairAt, accounts) => {
    f.calls.buckets.push([...accounts]);
    const out = new Map<Address, PositionBucket>();
    for (const a of accounts) {
      const b = f.chainBuckets.get(a);
      const p = k.store.positions.get(pairAt)?.get(a);
      if (b) out.set(a, b);
      else if (p) out.set(a, { ...p, takeProfitOrderId: 0n, stopLossOrderId: 0n });
    }
    return out;
  };
  k.reader.orders = async (pairAt, ids) => {
    f.calls.orders.push([...ids]);
    const out = new Map<bigint, OrderRecord>();
    for (const id of ids) {
      const o = k.store.orders.get(pairAt)?.get(id);
      const over = f.chainOrders.get(id);
      if (o) out.set(id, { ...recordOf(o), ...over });
    }
    return out;
  };
  k.reader.updateFee = async (updates) => {
    f.calls.fees.push([...updates]);
    return updates.length ? FEE : 0n;
  };
  k.reader.predecessor = async (_pair, _isLong, limitPrice) => {
    f.calls.predecessors.push(limitPrice);
    return 77n;
  };
  k.reader.windowDeposits = async (_pair, accounts) => {
    f.calls.deposits.push([...accounts]);
    return new Map(accounts.map((a) => [a, f.deposits.get(a) ?? 0n]));
  };
  k.reader.claimable = async (wallet) => {
    f.calls.claimable.push(wallet);
    return new Map(f.claimable);
  };
  k.reader.usdcBalance = async () => f.usdc;
  return f;
}
