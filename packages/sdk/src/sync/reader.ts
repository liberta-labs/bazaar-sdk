/**
 * Batched chain reads: deployment wiring, market discovery, per-block market state, candidates.
 *
 * Browser-safe: everything goes through a {@link Chain}, so a frontend can read markets with the same
 * calls the keeper makes. Reads for many markets go out as one `chain.batch` (the probe's aggregate,
 * Multicall3, or parallel eth_calls, whichever the node allows), never one request per market.
 */

import { type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress } from "viem";
import type { Chain, Read } from "../chain/client.js";
import { type ContractCodec, factory, lens, oracle, pair, terminator } from "../chain/codec.js";
import type { Inventory, Market, MarketState } from "../models.js";

/** The contracts a factory is wired to. */
export interface Deployment {
  readonly factory: Address;
  readonly lens: Address;
  readonly terminator: Address;
  readonly oracle: Address;
  readonly usdc: Address;
}

/** `positionBuckets(account)` on a pair: an account's position as the chain holds it now. */
export interface PositionBucket {
  readonly isLong: boolean;
  readonly size: bigint;
  readonly entryValue: bigint;
  readonly collateral: bigint;
  readonly entryFundingIndex: bigint;
  readonly takeProfitOrderId: bigint;
  readonly stopLossOrderId: bigint;
}

/**
 * `orders(id)` on a pair, with the lens's `triggerBounty` for it. Block numbers, enums and sequence
 * numbers are `number`, order ids, quantities and rates `bigint`, whatever width the getter declares.
 * A slot that never held an order reads back with a zero creator.
 */
export interface OrderRecord {
  readonly creator: Address;
  readonly canceledBlock: number;
  readonly orderType: number;
  readonly isLong: boolean;
  readonly isPostOnly: boolean;
  readonly tif: number;
  readonly integrator: Address;
  /** 2^64 - 1 (as a number, 1.8446744073709552e19) for an order that never expires */
  readonly expiryBlock: number;
  readonly inBook: boolean;
  readonly maxSlippageBp: bigint;
  readonly triggerPrice: bigint;
  readonly limitPrice: bigint;
  readonly size: bigint;
  readonly filledSize: bigint;
  readonly prioritySeq: number;
  readonly filledBlock: number;
  readonly restedBlock: number;
  readonly restedPremiumPpm: bigint;
  readonly prevInBook: bigint;
  readonly nextInBook: bigint;
  /** the trigger bounty the order still holds (lens.triggerBounty); 0 when that read failed */
  bounty: bigint;
}

// ---- decoded return values, as viem decodes them ----

interface PairPrice {
  spotPrice: bigint;
  updateTs: bigint;
}
interface MarginRequirements {
  imrBp: bigint;
  mmrBp: bigint;
}
interface FundingRate {
  fundingIndex: bigint;
}
interface VaultInventory {
  size: bigint;
  entryNotional: bigint;
  bankruptcyNotional: bigint;
  seized: bigint;
  entryFundingIndex: bigint;
  seizedTs: bigint | number;
}
interface PairVault {
  totalLongOI: bigint;
  totalShortOI: bigint;
  insuranceFundBalance: bigint;
  deficit: bigint;
  longInv: VaultInventory;
  shortInv: VaultInventory;
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

const ZERO32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * What one market's state read asks for, in order: [function, read through the lens]. Lens reads take
 * the pair's address; the others are argument-free calls on the pair itself.
 */
const STATE_READS: readonly (readonly [fn: string, viaLens: boolean])[] = [
  ["lastPairPrice", false],
  ["marginRequirements", false],
  ["getLaggedMmr", false],
  ["currentFundingIndex", false],
  ["fundingRate", true],
  ["isAdlPending", false],
  ["adlAuctionStartTs", false],
  ["adlTerminationTs", true],
  ["settlementPriceFixedTs", false],
  ["scheduledTerminationTs", false],
  ["isPairTerminated", false],
  ["pairVault", false],
];
const DESCRIBE_READS = ["pairId", "baseFeedId", "isContinuouslyTraded"] as const;

// The pair's calldata for STATE_READS is the same for every market (argument-free calls): encoded once.
let pairStateCalldata: (Hex | null)[] | null = null;
function stateCalldata(): (Hex | null)[] {
  if (!pairStateCalldata) {
    const P = pair();
    pairStateCalldata = STATE_READS.map(([fn, viaLens]) => (viaLens ? null : P.encode(fn)));
  }
  return pairStateCalldata;
}

const inv = (d: VaultInventory): Inventory => ({
  size: d.size,
  entryNotional: d.entryNotional,
  bankruptcyNotional: d.bankruptcyNotional,
  seized: d.seized,
  entryFundingIndex: d.entryFundingIndex,
  seizedTs: Number(d.seizedTs),
});

const toOrderRecord = (o: RawOrder, bounty: bigint): OrderRecord => ({
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
});

export class Reader {
  /** Set by {@link deployment}; every read below needs it. */
  dep: Deployment | null = null;

  constructor(readonly chain: Pick<Chain, "call" | "batch">) {}

  private get d(): Deployment {
    if (!this.dep) throw new Error("Reader.deployment() has not been called");
    return this.dep;
  }

  /** One call to `to`, decoded. */
  async one<T = unknown>(to: Address, c: ContractCodec, fn: string, ...args: readonly unknown[]): Promise<T> {
    return c.decode<T>(fn, await this.chain.call(to, c.encode(fn, ...args)));
  }

  async deployment(factoryAddress: Address): Promise<Deployment> {
    const F = factory();
    const at = getAddress(factoryAddress);
    const names = ["lens", "pairTerminator", "oracle", "usdc"] as const;
    const res = await this.chain.batch(names.map((n) => ({ to: at, data: F.encode(n) })));
    if (!res.every(([ok]) => ok)) throw new Error(`${at} does not answer as a Bazaar factory`);
    const [lensAt, term, orc, usdc] = names.map((n, i) => F.decode<Address>(n, res[i]![1]));
    this.dep = { factory: at, lens: lensAt!, terminator: term!, oracle: orc!, usdc: usdc! };
    return this.dep;
  }

  /** What is wrong with the deployment's wiring: a lens or terminator that belongs to another factory. */
  async wiringProblems(): Promise<string[]> {
    const d = this.d;
    const L = lens();
    const T = terminator();
    const res = await this.chain.batch([
      { to: d.lens, data: L.encode("factory") },
      { to: d.terminator, data: T.encode("factory") },
    ]);
    const out: string[] = [];
    const checks = [
      ["lens", L],
      ["terminator", T],
    ] as const;
    checks.forEach(([name, c], i) => {
      const [ok, data] = res[i]!;
      if (!ok) out.push(`the ${name} does not report a factory`);
      else if (c.decode<Address>("factory", data) !== d.factory) out.push(`the ${name} belongs to a different factory`);
    });
    return out;
  }

  async pairAddresses(): Promise<Address[]> {
    return [...(await this.one<readonly Address[]>(this.d.factory, factory(), "getAllPairs"))];
  }

  /**
   * Static facts about each pair: its feed, its legs and its trading calendar. Throws when one of a
   * pair's reads fails: its revert data must not be decoded as a value.
   */
  async describe(addresses: readonly Address[]): Promise<Market[]> {
    const P = pair();
    const O = oracle();
    const oracleAt = this.d.oracle;
    const calldata = DESCRIBE_READS.map((fn) => P.encode(fn));
    const reads: Read[] = [];
    for (const a of addresses) for (const data of calldata) reads.push({ to: a, data });
    const res = await this.chain.batch(reads);
    const n = DESCRIBE_READS.length;
    const out = addresses.map((a, i) => {
      const data = DESCRIBE_READS.map((fn, j) => {
        const [ok, d] = res[i * n + j]!;
        if (!ok) throw new Error(`${a} does not answer as a Bazaar pair (its ${fn}() read failed)`);
        return d;
      });
      return {
        address: a,
        pairId: P.decode<Hex>("pairId", data[0]!),
        base: P.decode<Hex>("baseFeedId", data[1]!),
        continuous: P.decode<boolean>("isContinuouslyTraded", data[2]!),
      };
    });
    const comp = await this.chain.batch(out.map((o) => ({ to: oracleAt, data: O.encode("composites", o.base) })));
    return out.map((o, i): Market => {
      const [ok, data] = comp[i]!;
      const c = ok
        ? O.decode<{ baseId: Hex; quoteId: Hex; invertQuote: boolean }>("composites", data)
        : { baseId: ZERO32, quoteId: ZERO32, invertQuote: false };
      return {
        address: o.address,
        pairId: o.pairId,
        baseFeedId: o.base,
        legs: c.baseId !== ZERO32 ? [c.baseId, c.quoteId] : [o.base],
        invertQuote: Boolean(c.invertQuote),
        continuous: o.continuous,
        description: "",
        label: "",
        state: null,
        dirty: true,
        lastRead: 0,
      };
    });
  }

  /**
   * Every market's state at `block`, in one batched read. A market whose price, margin or vault read
   * fails is left out of the result.
   */
  async marketStates(markets: readonly Market[], block: number, timestamp: number): Promise<Map<Address, MarketState>> {
    const P = pair();
    const L = lens();
    const lensAt = this.d.lens;
    const pairData = stateCalldata();
    const n = STATE_READS.length;
    const reads: Read[] = new Array(markets.length * n);
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i]!;
      for (let j = 0; j < n; j++) {
        const data = pairData[j];
        reads[i * n + j] = data ? { to: m.address, data } : { to: lensAt, data: L.encode(STATE_READS[j]![0], m.address) };
      }
    }
    const res = await this.chain.batch(reads, block);
    const out = new Map<Address, MarketState>();
    const vals: unknown[] = new Array(n);
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i]!;
      for (let j = 0; j < n; j++) {
        const [fn, viaLens] = STATE_READS[j]!;
        const [ok, data] = res[i * n + j]!;
        vals[j] = ok ? (viaLens ? L : P).decode(fn, data) : null;
      }
      const price = vals[0] as PairPrice | null;
      const mr = vals[1] as MarginRequirements | null;
      const vault = vals[11] as PairVault | null;
      if (price === null || mr === null || vault === null) continue;
      const storedFi = (vals[3] as bigint | null) ?? 0n;
      const fr = vals[4] as FundingRate | null;
      out.set(m.address, {
        block,
        timestamp,
        spot: price.spotPrice,
        updateTs: Number(price.updateTs),
        imrBp: mr.imrBp,
        mmrBp: mr.mmrBp,
        laggedMmrBp: (vals[2] as bigint | null) ?? 0n,
        fundingIndex: storedFi,
        projectedFundingIndex: fr ? fr.fundingIndex : storedFi,
        adlPending: Boolean(vals[5]),
        adlAuctionStart: Number((vals[6] as bigint | null) ?? 0n),
        adlTerminationTs: Number((vals[7] as bigint | null) ?? 0n),
        settlementFixedTs: Number((vals[8] as bigint | null) ?? 0n),
        scheduledTs: Number((vals[9] as bigint | null) ?? 0n),
        terminated: Boolean(vals[10]),
        longOi: vault.totalLongOI,
        shortOi: vault.totalShortOI,
        insurance: vault.insuranceFundBalance,
        deficit: vault.deficit,
        longInv: inv(vault.longInv),
        shortInv: inv(vault.shortInv),
      });
    }
    return out;
  }

  /** The accounts' position buckets on `pair`; an account whose read fails is left out. */
  async buckets(pairAt: Address, accounts: readonly Address[]): Promise<Map<Address, PositionBucket>> {
    const P = pair();
    const res = await this.chain.batch(accounts.map((a) => ({ to: pairAt, data: P.encode("positionBuckets", a) })));
    const out = new Map<Address, PositionBucket>();
    accounts.forEach((a, i) => {
      const [ok, data] = res[i]!;
      if (ok) out.set(a, P.decode<PositionBucket>("positionBuckets", data));
    });
    return out;
  }

  /** The orders with their trigger bounties; an order whose own read fails is left out. */
  async orders(pairAt: Address, ids: readonly bigint[]): Promise<Map<bigint, OrderRecord>> {
    const P = pair();
    const L = lens();
    const lensAt = this.d.lens;
    const reads: Read[] = ids.map((id) => ({ to: pairAt, data: P.encode("orders", id) }));
    for (const id of ids) reads.push({ to: lensAt, data: L.encode("triggerBounty", pairAt, id) });
    const res = await this.chain.batch(reads);
    const n = ids.length;
    const out = new Map<bigint, OrderRecord>();
    ids.forEach((oid, k) => {
      const [ok, data] = res[k]!;
      if (!ok) return;
      const [okb, b] = res[n + k]!;
      out.set(oid, toOrderRecord(P.decode<RawOrder>("orders", data), okb ? L.decode<bigint>("triggerBounty", b) : 0n));
    });
    return out;
  }

  /** The accounts' ADL score deposits on `pair` (0 where the read fails). */
  async windowDeposits(pairAt: Address, accounts: readonly Address[]): Promise<Map<Address, bigint>> {
    const P = pair();
    const res = await this.chain.batch(accounts.map((a) => ({ to: pairAt, data: P.encode("adlScoreDeposit", a) })));
    const out = new Map<Address, bigint>();
    accounts.forEach((a, i) => {
      const [ok, data] = res[i]!;
      out.set(a, ok ? P.decode<bigint>("adlScoreDeposit", data) : 0n);
    });
    return out;
  }

  /** lens.findPredecessor, followed through budget-limited pages. */
  async predecessor(pairAt: Address, isLong: boolean, limitPrice: bigint): Promise<bigint> {
    let start = 0n;
    for (let i = 0; i < 8; i++) {
      const r = await this.one<{ pred: bigint; found: boolean }>(
        this.d.lens, lens(), "findPredecessor", pairAt, isLong, limitPrice, start, 64n,
      );
      if (r.found) return r.pred;
      start = r.pred;
    }
    return start;
  }

  /** What `wallet` can claim, by pair; pairs that owe nothing are left out. */
  async claimable(wallet: Address): Promise<Map<Address, bigint>> {
    const r = await this.one<{ pairs: readonly Address[]; owed: readonly bigint[] }>(this.d.lens, lens(), "getClaimableFeesAll", wallet);
    const out = new Map<Address, bigint>();
    r.pairs.forEach((p, i) => {
      const o = r.owed[i] ?? 0n;
      if (o) out.set(p, o);
    });
    return out;
  }

  /** The oracle's fee, in wei, for verifying `updates`. */
  async updateFee(updates: readonly Hex[]): Promise<bigint> {
    if (!updates.length) return 0n;
    return this.one<bigint>(this.d.oracle, oracle(), "getUpdateFee", updates);
  }

  async sampleSetFee(baseFeedId: Hex, updates: readonly Hex[]): Promise<bigint> {
    return this.one<bigint>(this.d.oracle, oracle(), "getSampleSetFee", baseFeedId, updates);
  }

  async usdcBalance(account: Address): Promise<bigint> {
    const data = concatHex(["0x70a08231", encodeAbiParameters([{ type: "address" }], [account])]); // balanceOf(address)
    return decodeAbiParameters([{ type: "uint256" }], await this.chain.call(this.d.usdc, data))[0];
  }
}
