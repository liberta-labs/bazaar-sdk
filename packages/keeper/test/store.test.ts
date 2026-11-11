import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContractCodec, type DecodedLog, type Market, type RawLog, factory, pair, terminator } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, encodeAbiParameters, getAddress } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Effects, SNAPSHOT_VERSION, Store, handledPairEvents } from "../src/state/store.js";

const PAIR = getAddress("0x" + "11".repeat(20));
const FACTORY = getAddress("0x" + "22".repeat(20));
const TERMINATOR = getAddress("0x" + "33".repeat(20));
const ALICE = getAddress("0x" + "aa".repeat(20));
const KEEPER = getAddress("0x" + "bb".repeat(20));
const NEW_PAIR = getAddress("0x" + "44".repeat(20));
const PAIR_ID = ("0x" + "01".repeat(32)) as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

function log(name: string, args: Record<string, unknown>, address: Address = PAIR, block = 10): DecodedLog {
  return { name, address, args, blockNumber: block, blockHash: "0x", txHash: "0x", logIndex: 0 };
}

/** A log as the chain returns it: `name`'s topics and data encoded from `args`. */
function rawLog(c: ContractCodec, name: string, address: Address, args: Record<string, unknown>, block = 10): RawLog {
  const spec = c.eventByName.get(name)!;
  const all: Record<string, unknown> = { pairId: PAIR_ID, ...args };
  const topics: Hex[] = [spec.topic0];
  const plain = [];
  const values = [];
  for (const p of spec.inputs) {
    if (p.indexed) topics.push(encodeAbiParameters([p], [all[p.name!]]));
    else {
      plain.push(p);
      values.push(all[p.name!]);
    }
  }
  const data = plain.length ? encodeAbiParameters(plain, values) : "0x";
  return { address, topics, data, blockNumber: block, blockHash: ZERO32, transactionHash: ZERO32, logIndex: 0 };
}

/** OrderUpdated's payload as viem decodes it: uint8s as numbers, wider integers as bigints. */
function payload(kw: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 0, orderType: 4, isLong: false, isPostOnly: false, size: 10n, filledSize: 0n, triggerPrice: (5n << 128n) | 1950n,
    limitPrice: 0n, maxSlippageBp: 500n, canceledBlock: 0n, filledBlock: 0n, expiryBlock: 2n ** 64n - 1n, prioritySeq: 1n, tif: 0,
    integrator: "0x" + "00".repeat(20), cancelReason: 0,
    ...kw,
  };
}

function market(address: Address = PAIR, label = "ETH/USD"): Market {
  return {
    address, pairId: PAIR_ID, baseFeedId: PAIR_ID, legs: [PAIR_ID], invertQuote: false, continuous: true,
    description: "", label, state: null, dirty: true, lastRead: 0,
  };
}

function store(): Store {
  const s = new Store();
  s.addMarket(market());
  return s;
}

const WALLETS = new Set([KEEPER]);
const apply = (s: Store, lg: DecodedLog, fx?: Effects) => s.apply(lg, WALLETS, FACTORY, TERMINATOR, fx);
const applyRaw = (s: Store, lg: RawLog, fx?: Effects) => s.applyRaw(lg, WALLETS, FACTORY, TERMINATOR, fx);

const bucket = (kw: Record<string, unknown>) => ({
  owner: ALICE, isLong: true, size: 5n, entryValue: 10_000n, collateral: 900n, entryFundingIndex: 3n, globalFundingIndex: 3n,
  imrBp: 500n, mmrBp: 300n, ...kw,
});

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bazaar-store-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("store", () => {
  it("positions follow bucket events", () => {
    const s = store();
    apply(s, log("PositionBucketUpdated", bucket({})));
    expect(s.positions.get(PAIR)!.get(ALICE)!.size).toBe(5n);
    apply(s, log("PositionBucketUpdated", bucket({ size: 0n, entryValue: 0n, collateral: 0n, entryFundingIndex: 0n, globalFundingIndex: 0n, imrBp: 0n, mmrBp: 0n })));
    expect(s.positions.get(PAIR)!.has(ALICE)).toBe(false);
  });

  it("orders, bounties and fills", () => {
    const s = store();
    // The bounty is escrowed before the order's own creation event, in the same transaction.
    apply(s, log("TriggerBountyEscrowed", { orderId: 7n, amount: 5n }));
    apply(s, log("OrderUpdated", { orderId: 7n, owner: ALICE, payload: payload() }));
    const o = s.orders.get(PAIR)!.get(7n)!;
    expect(o.bounty).toBe(5n);
    expect(o.triggerPrice).toBe(1950n);
    expect(o.terminal).toBe(false);
    expect(o.inBook).toBeNull();
    apply(s, log("Trade", {
      maker: ALICE, taker: KEEPER, makerOrderId: 9n, takerOrderId: 7n, takerIsLong: false, fillSize: 4n, price: 1n, makerFee: 0n,
      takerFee: 0n, makerRemaining: 0n, takerRemaining: 6n,
    }));
    expect(o.filled).toBe(4n);
    expect(o.terminal).toBe(false);
    apply(s, log("TriggerBountyReleased", { orderId: 7n, recipient: KEEPER, amount: 2n }));
    expect(o.bounty).toBe(3n);
    apply(s, log("OrderUpdated", { orderId: 7n, owner: ALICE, payload: payload({ action: 2, canceledBlock: 12n }) }));
    expect(s.orders.get(PAIR)!.get(7n)!.terminal).toBe(true);
    expect(s.orders.get(PAIR)!.get(7n)!.bounty).toBe(3n); // kept: a sweep returns the bounty
    apply(s, log("TriggerBountyReleased", { orderId: 7n, recipient: ALICE, amount: 3n }));
    expect(s.orders.get(PAIR)!.has(7n)).toBe(false); // finished and nothing held: forgotten
  });

  it("effects mark markets and claims", () => {
    const s = store();
    let fx = apply(s, log("NewPriceUpdateAdded", { targetPublishTs: 1n, spotPrice: 1n, exponent: -18, fundingIndex: 0n }));
    expect(fx.dirty.has(PAIR)).toBe(true);
    fx = apply(s, log("FeeAccrued", { recipient: KEEPER, amount: 1n }));
    expect(fx.claimsChanged).toBe(true);
    fx = apply(s, log("PairDeployed", { pairAddress: NEW_PAIR }, FACTORY));
    expect(fx.newPairs).toEqual([NEW_PAIR]);
    fx = apply(s, log("SettlementPriceFixed", { pair: PAIR }, TERMINATOR));
    expect(fx.dirty).toEqual(new Set([PAIR]));
  });

  it("snapshot round trip", () => {
    const s = store();
    apply(s, log("PositionBucketUpdated", bucket({ isLong: false, entryFundingIndex: -3n, globalFundingIndex: 0n })));
    apply(s, log("OrderUpdated", { orderId: 7n, owner: ALICE, payload: payload() }));
    s.head = 42;
    s.headHash = "0xabc";
    const path = join(tmpDir(), "snap.json");
    s.save(path, 31337, FACTORY);
    const t = Store.load(path, 31337, FACTORY)!;
    expect(t.head).toBe(42);
    expect(t.positions.get(PAIR)!.get(ALICE)!.entryFundingIndex).toBe(-3n);
    expect(t.orders.get(PAIR)!.get(7n)!.orderType).toBe(4);
    expect(Store.load(path, 1, FACTORY)).toBeNull(); // another chain's snapshot is ignored
  });
});

describe("store: logs as the chain returns them", () => {
  it("dispatches a market's logs by topic0 and decodes only what a handler needs", () => {
    const s = store();
    const P = pair();
    const decode = vi.spyOn(P, "decodeLog");
    try {
      let fx = applyRaw(s, rawLog(P, "NewPriceUpdateAdded", PAIR, { targetPublishTs: 1n, spotPrice: 1n, exponent: -18, fundingIndex: 0n }));
      expect(fx.dirty).toEqual(new Set([PAIR]));
      fx = applyRaw(s, rawLog(P, "PositionLiquidated", PAIR, {
        liquidatedUser: ALICE, liquidator: KEEPER, size: 1n, isLong: true, bankruptcyPrice: 1n, triggerPrice: 1n, collateralSeized: 1n, timestamp: 1n,
      }));
      expect(fx.liquidations).toEqual(new Set([PAIR]));
      fx = applyRaw(s, rawLog(P, "CollateralDeposited", PAIR, { user: ALICE, amount: 5n })); // nothing the store follows
      expect(fx.dirty.size + fx.bookChanged.size + fx.liquidations.size).toBe(0);
      expect(decode).not.toHaveBeenCalled(); // none of these needed their arguments

      fx = applyRaw(s, rawLog(P, "FeeAccrued", PAIR, { recipient: KEEPER, amount: 1n }));
      expect(fx.claimsChanged).toBe(true);
      expect(applyRaw(s, rawLog(P, "FeesClaimed", PAIR, { recipient: ALICE, amount: 1n })).claimsChanged).toBe(false);
      expect(decode).toHaveBeenCalledTimes(2);
    } finally {
      decode.mockRestore();
    }
  });

  it("applies positions, orders, fills and bounties from encoded logs", () => {
    const s = store();
    const P = pair();
    applyRaw(s, rawLog(P, "PositionBucketUpdated", PAIR, bucket({ size: 2n ** 127n, entryFundingIndex: -(2n ** 200n) }), 11));
    const p = s.positions.get(PAIR)!.get(ALICE)!;
    expect(p).toEqual({ account: ALICE, isLong: true, size: 2n ** 127n, entryValue: 10_000n, collateral: 900n, entryFundingIndex: -(2n ** 200n), block: 11 });

    applyRaw(s, rawLog(P, "TriggerBountyEscrowed", PAIR, { orderId: 7n, amount: 5n }));
    applyRaw(s, rawLog(P, "OrderUpdated", PAIR, { orderId: 7n, owner: ALICE, payload: payload() }, 12));
    const o = s.orders.get(PAIR)!.get(7n)!;
    expect(o).toMatchObject({ orderId: 7n, owner: ALICE, orderType: 4, size: 10n, triggerPrice: 1950n, bounty: 5n, expiryBlock: 2 ** 64, block: 12, known: true });

    const fx = applyRaw(s, rawLog(P, "Trade", PAIR, {
      maker: ALICE, taker: KEEPER, makerOrderId: 9n, takerOrderId: 7n, takerIsLong: false, fillSize: 10n, price: 1n, makerFee: 0n,
      takerFee: 0n, makerRemaining: 0n, takerRemaining: 0n,
    }));
    expect(fx.bookChanged).toEqual(new Set([PAIR]));
    expect(o).toMatchObject({ filled: 10n, terminal: true, inBook: false });

    applyRaw(s, rawLog(P, "OrderAmended", PAIR, { orderId: 7n, owner: ALICE, limitPrice: 3n, size: 12n, prioritySeq: 2n }, 13));
    expect(o).toMatchObject({ limitPrice: 3n, size: 12n, block: 13 });
    applyRaw(s, rawLog(P, "TriggerBountyReleased", PAIR, { orderId: 7n, recipient: KEEPER, amount: 9n }));
    expect(s.orders.get(PAIR)!.has(7n)).toBe(false); // finished, and the release took more than it held
  });

  it("follows the factory and the terminator, and ignores other contracts", () => {
    const s = store();
    s.addMarket(market(getAddress("0x" + "55".repeat(20)), "BTC/USD"));
    let fx = applyRaw(s, rawLog(factory(), "PairDeployed", FACTORY, {
      pairAddress: NEW_PAIR, deployer: ALICE, baseFeedId: PAIR_ID, isContinuouslyTraded: true, seedAmount: 1n, description: "x",
    }));
    expect(fx.newPairs).toEqual([NEW_PAIR]);
    fx = applyRaw(s, rawLog(terminator(), "SettlementPriceFixed", TERMINATOR, { pair: PAIR, settlementPrice: 1n }));
    expect(fx.dirty).toEqual(new Set([PAIR]));
    fx = applyRaw(s, rawLog(terminator(), "TerminationProposalDisputed", TERMINATOR, { assertionId: PAIR_ID }));
    expect(fx.dirty.size).toBe(2); // no pair named: every market is re-read
    fx = applyRaw(s, rawLog(pair(), "NewPriceUpdateAdded", NEW_PAIR, { targetPublishTs: 1n, spotPrice: 1n, exponent: -18, fundingIndex: 0n }));
    expect(fx.dirty.size).toBe(0); // not a market the store holds
  });

  it("accumulates into the caller's effects", () => {
    const s = store();
    const fx = new Effects();
    const deployed = log("PairDeployed", { pairAddress: NEW_PAIR }, FACTORY);
    expect(apply(s, deployed, fx)).toBe(fx);
    apply(s, deployed, fx);
    apply(s, log("NewPriceUpdateAdded", {}), fx);
    expect(fx.newPairs).toEqual([NEW_PAIR]);
    expect(fx.dirty).toEqual(new Set([PAIR]));

    const other = new Effects();
    other.firstBlock = 5;
    other.newPairs.push(NEW_PAIR, PAIR);
    fx.firstBlock = 9;
    fx.merge(other);
    expect(fx.firstBlock).toBe(5);
    expect(fx.newPairs).toEqual([NEW_PAIR, PAIR]);
  });

  it("handles only events the pair ABI declares", () => {
    const names = new Set(pair().eventByName.keys());
    expect(handledPairEvents().filter((n) => !names.has(n))).toEqual([]);
  });
});

describe("store snapshots", () => {
  it("keep every bigint exact as a decimal string and stay plain JSON", () => {
    const s = store();
    const huge = 2n ** 255n - 1n;
    apply(s, log("PositionBucketUpdated", bucket({ size: huge, entryValue: 2n ** 128n + 1n, entryFundingIndex: -(2n ** 255n) })));
    apply(s, log("TriggerBountyEscrowed", { orderId: 2n ** 64n + 7n, amount: 10n ** 30n + 1n })); // a stub: owner unknown
    apply(s, log("OrderUpdated", { orderId: 7n, owner: ALICE, payload: payload() }));
    s.head = 123_456;
    s.headHash = "0x" + "ab".repeat(32);
    const dir = tmpDir();
    const path = join(dir, "snapshot.json");
    s.save(path, 42161, FACTORY);
    s.save(path, 42161, FACTORY); // over an existing snapshot
    expect(readdirSync(dir)).toEqual(["snapshot.json"]); // the temp file was renamed into place

    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.version).toBe(SNAPSHOT_VERSION);
    expect(raw.positions[PAIR][0].size).toBe(huge.toString());
    expect(raw.positions[PAIR][0].entryFundingIndex).toBe((-(2n ** 255n)).toString());

    const t = Store.load(path, 42161, FACTORY)!;
    expect(t.positions).toEqual(s.positions);
    expect(t.orders).toEqual(s.orders);
    expect(t.orders.get(PAIR)!.get(2n ** 64n + 7n)!.known).toBe(false);
    expect(t.orders.get(PAIR)!.get(7n)!.expiryBlock).toBe(s.orders.get(PAIR)!.get(7n)!.expiryBlock);
    expect([...t.markets.values()].map((m) => [m.address, m.label, m.state, m.dirty])).toEqual([[PAIR, "ETH/USD", null, true]]);
    expect([t.head, t.headHash]).toEqual([123_456, s.headHash]);
  });

  it("ignore what they cannot use: none, unreadable, version 1, another factory's, malformed", () => {
    const dir = tmpDir();
    const path = join(dir, "snapshot.json");
    expect(Store.load(path, 1, FACTORY)).toBeNull();
    writeFileSync(path, "{not json");
    expect(Store.load(path, 1, FACTORY)).toBeNull();
    // A version-1 snapshot: snake_case, integers as JSON numbers.
    writeFileSync(path, JSON.stringify({ version: 1, chain_id: 1, factory: FACTORY, head: 5, head_hash: "", markets: [], positions: {}, orders: {} }));
    expect(Store.load(path, 1, FACTORY)).toBeNull();

    const s = store();
    apply(s, log("PositionBucketUpdated", bucket({})));
    s.save(path, 1, FACTORY);
    expect(Store.load(path, 1, getAddress("0x" + "66".repeat(20)))).toBeNull();
    expect(Store.load(path, 1, FACTORY.toLowerCase() as Address)).not.toBeNull();
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.positions[PAIR][0].size = 5; // a number where a decimal string belongs
    writeFileSync(path, JSON.stringify(data));
    expect(Store.load(path, 1, FACTORY)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });
});
