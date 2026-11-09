/**
 * Anvil helpers for the end-to-end run: replay a Bazaar deployment, then build a market to keep.
 *
 * The deployment is replayed from a Foundry broadcast record (broadcast/DeployBazaar.s.sol/31337/
 * run-latest.json in a built Bazaar checkout; a stripped copy lives in ./fixtures), so no contract is
 * compiled here. Replaying the same transactions from the same account on a fresh Anvil reproduces
 * the same addresses.
 *
 * Every account here is one of Anvil's ten unlocked dev accounts (the public test mnemonic), so
 * transactions go through `eth_sendTransaction` and Anvil signs them.
 */

import fs from "node:fs";
import { type Address, type Hex, getAddress, keccak256, parseAbi, toBytes, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  BAZAAR_SCALE,
  Chain,
  ContractCodec,
  ETH_USD_FEED,
  JsonRpc,
  LIMIT,
  MARKET,
  MAX_UINT256,
  type Receipt,
  RpcError,
  STOP_LOSS,
  ZERO_ADDRESS,
  decodeError,
  factory,
  lens,
  pair,
  sleep,
} from "@liberta-labs/bazaar-sdk";

export const MNEMONIC = "test test test test test test test test test test test junk";
export const FEED: Hex = ETH_USD_FEED; // ETH/USD
export const E18 = BAZAAR_SCALE;
export const PAIR = pair();
export const LENS = lens();
export const FACTORY = factory();
/** ArbSys's precompile address, where the pair reads its block number. */
export const ARBSYS: Address = "0x0000000000000000000000000000000000000064";

/** The mocks the anvil deployment uses in place of Pyth and USDC (HelperConfig.getOrCreateAnvilConfig). */
export const MOCKS = new ContractCodec(
  parseAbi([
    "function createPriceFeedUpdateData(bytes32 id, int64 price, uint64 conf, int32 expo, int64 emaPrice, uint64 emaConf, uint64 publishTime, uint64 prevPublishTime) pure returns (bytes)",
    "function getUpdateFee(bytes[] updateData) view returns (uint256)",
    "function updatePriceFeeds(bytes[] updateData) payable",
    "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address who) view returns (uint256)",
  ]),
);

const keyCache: Hex[] = [];

/** Private keys of Anvil's dev accounts, m/44'/60'/0'/0/i of the test mnemonic (derived once). */
export function keys(n = 10): Hex[] {
  for (let i = keyCache.length; i < n; i++) {
    const pk = mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
    if (!pk) throw new Error(`no private key at index ${i}`);
    keyCache.push(toHex(pk));
  }
  return keyCache.slice(0, n);
}

export function sel(sig: string): Hex {
  return keccak256(toBytes(sig)).slice(0, 10) as Hex;
}

export class Reverted extends Error {
  override readonly name = "Reverted";
}

/** What `web3_clientVersion` answers at `url` (e.g. "anvil/v1.4.3"), or null when nothing answers. */
export async function clientVersion(url: string, timeoutMs = 2_000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const out = (await r.json()) as { result?: unknown };
    return typeof out.result === "string" ? out.result : null;
  } catch {
    return null;
  }
}

export interface SendOptions {
  value?: bigint;
  gas?: bigint;
  label?: string;
}

interface CallFrame {
  output?: Hex;
  error?: string;
  calls?: CallFrame[];
}

export class Anvil {
  readonly chain: Chain;

  constructor(readonly url: string) {
    this.chain = new Chain(new JsonRpc(url, { perSecond: 1_000, timeoutMs: 120_000, retries: 2 }));
  }

  async rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    try {
      return await this.chain.request<T>(method, params);
    } catch (e) {
      if (e instanceof RpcError) throw new Error(`${method}: ${e.message}`, { cause: e });
      throw e;
    }
  }

  /** The latest block's [number, timestamp]. */
  async latest(): Promise<[number, number]> {
    const b = await this.chain.block("latest");
    return [b.number, b.timestamp];
  }

  /** Move the clock forward and mine a block at the new time. */
  async warp(seconds: number): Promise<void> {
    await this.rpc("evm_increaseTime", [toHex(seconds)]);
    await this.rpc("evm_mine", []);
  }

  async mine(blocks: number): Promise<void> {
    await this.rpc("anvil_mine", [toHex(blocks)]);
  }

  async call(to: Address, data: Hex): Promise<Hex> {
    return this.chain.call(to, data);
  }

  /** Send from an unlocked account and wait for the receipt; a revert throws {@link Reverted}. */
  async send(sender: Address, to: Address | null, data: Hex, opts: SendOptions = {}): Promise<Receipt> {
    const tx: Record<string, string> = {
      from: sender,
      data,
      value: toHex(opts.value ?? 0n),
      gas: toHex(opts.gas ?? 25_000_000n),
    };
    if (to) tx.to = to;
    const h = await this.rpc<Hex>("eth_sendTransaction", [tx]);
    const r = await this.waitForReceipt(h, 120);
    if (r.status !== "success") throw new Reverted(`${opts.label || "tx"} reverted: ${await this.revertReason(h)}`);
    return r;
  }

  async waitForReceipt(txHash: Hex, timeout = 120): Promise<Receipt> {
    const t0 = Date.now();
    for (;;) {
      const r = await this.chain.receipt(txHash);
      if (r) return r;
      if (Date.now() - t0 > timeout * 1_000) throw new Error(`no receipt for ${txHash} after ${timeout}s`);
      await sleep(100);
    }
  }

  /** The decoded error of a mined, reverted transaction, from the deepest failing call. */
  async revertReason(txHash: Hex): Promise<string> {
    let t: CallFrame;
    try {
      t = await this.rpc<CallFrame>("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
    } catch (e) {
      return `(trace failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    const deepest = (c: CallFrame): Hex | null => {
      for (const sub of c.calls ?? []) {
        if (sub.error) {
          const d = deepest(sub);
          if (d) return d;
        }
      }
      return c.error ? (c.output ?? null) : null;
    };
    const out = deepest(t) || t.output || "0x";
    return String(decodeError(out));
  }

  // ---- state helpers (Anvil's cheat methods) ----
  async snapshot(): Promise<Hex> {
    return this.rpc<Hex>("evm_snapshot", []);
  }

  /** Back to a snapshot; true when Anvil had it. A snapshot is consumed by reverting to it. */
  async revert(id: Hex): Promise<boolean> {
    return this.rpc<boolean>("evm_revert", [id]);
  }

  async setNextBlockTimestamp(ts: number): Promise<void> {
    await this.rpc("evm_setNextBlockTimestamp", [toHex(ts)]);
  }

  async impersonate(address: Address): Promise<void> {
    await this.rpc("anvil_impersonateAccount", [address]);
  }

  async stopImpersonating(address: Address): Promise<void> {
    await this.rpc("anvil_stopImpersonatingAccount", [address]);
  }

  async setBalance(address: Address, wei: bigint): Promise<void> {
    await this.rpc("anvil_setBalance", [address, toHex(wei)]);
  }

  async setCode(address: Address, code: Hex): Promise<void> {
    await this.rpc("anvil_setCode", [address, code]);
  }
}

/** A Foundry broadcast record, as far as the replay reads it. */
interface BroadcastRecord {
  transactions: {
    contractName?: string | null;
    contractAddress?: string | null;
    transaction: { from: string; to?: string | null; gas: string; value?: string | null; input: string; nonce: string };
  }[];
}

/** Replay the recorded deployment; returns contract name -> address. */
export async function deploy(anvil: Anvil, broadcastPath: string, arbsysPath: string): Promise<Record<string, Address>> {
  const record = JSON.parse(fs.readFileSync(broadcastPath, "utf8")) as BroadcastRecord;
  const first = record.transactions[0];
  if (!first) throw new Error(`${broadcastPath} records no transactions`);
  const sender = getAddress(first.transaction.from);
  if ((await anvil.chain.nonce(sender, "latest")) !== 0) {
    throw new Error("the deployer has already sent transactions here; start a fresh Anvil");
  }
  const hashes: [BroadcastRecord["transactions"][number], Hex][] = [];
  for (const t of record.transactions) {
    const tx = t.transaction;
    const req: Record<string, string> = { from: sender, data: tx.input, gas: tx.gas, value: tx.value || "0x0", nonce: tx.nonce };
    if (tx.to) req.to = getAddress(tx.to);
    hashes.push([t, await anvil.rpc<Hex>("eth_sendTransaction", [req])]);
  }
  const names: Record<string, Address> = {};
  for (const [t, h] of hashes) {
    const r = await anvil.waitForReceipt(h, 180);
    if (r.status !== "success") throw new Error(`replaying ${t.contractName} failed: ${await anvil.revertReason(h)}`);
    if (t.contractName && t.contractAddress && !(t.contractName in names)) {
      names[t.contractName] = getAddress(t.contractAddress);
    }
  }
  const art = JSON.parse(fs.readFileSync(arbsysPath, "utf8")) as { deployedBytecode: { object: Hex } };
  await anvil.rpc("anvil_setCode", [ARBSYS, art.deployedBytecode.object]);
  return names;
}

/** BazaarPair.positionBuckets / BazaarPairLens.getPositionBucket. */
export interface PositionBucket {
  isLong: boolean;
  size: bigint;
  entryValue: bigint;
  collateral: bigint;
  entryFundingIndex: bigint;
  takeProfitOrderId: bigint;
  stopLossOrderId: bigint;
}

/** BazaarPair.orders, with block numbers as numbers and order ids and rates as bigints. */
export interface OrderRecord {
  creator: Address;
  canceledBlock: number;
  orderType: number;
  isLong: boolean;
  isPostOnly: boolean;
  tif: number;
  integrator: Address;
  expiryBlock: number;
  inBook: boolean;
  maxSlippageBp: bigint;
  triggerPrice: bigint;
  limitPrice: bigint;
  size: bigint;
  filledSize: bigint;
  prioritySeq: number;
  filledBlock: number;
  restedBlock: number;
  restedPremiumPpm: bigint;
  prevInBook: bigint;
  nextInBook: bigint;
}

type Num = number | bigint;

export interface CreateOptions {
  /** Trigger price in the low 128 bits, keeper bounty in the high 128 (BAZAAR precision). */
  trigger?: bigint;
  limit?: bigint;
  /** Maximum slippage, basis points. */
  slip?: bigint;
  /** Expiry block; 400,000 blocks from now by default. */
  exp?: number;
}

/**
 * One ETH/USD market with makers, takers, insurance, a stop-loss and a position to liquidate.
 *
 * Accounts: 0 lists the market, 1 and 2 make the book, 3 and 4 take, 5 insures, 6 is the position
 * that gets liquidated, 7 is the keeper.
 */
export class Scenario {
  readonly k: Hex[];
  readonly w: Address[];
  readonly factory: Address;
  readonly lens: Address;
  readonly pyth: Address;
  readonly usdc: Address;
  /** Set by setup(). */
  pair: Address = ZERO_ADDRESS;
  /** The mock feed's USD price the scenario's own calls carry. */
  price = 2000.0;
  readonly orders: Record<string, bigint> = {};
  mmrBp = 0n;
  /** The victim's long (account 6), set by setup(). */
  victimSize = 0n;

  constructor(
    readonly a: Anvil,
    names: Record<string, Address>,
  ) {
    this.k = keys();
    this.w = this.k.map((k) => privateKeyToAccount(k).address);
    this.factory = need(names, "BazaarFactory");
    this.lens = need(names, "BazaarPairLens");
    this.pyth = need(names, "MockPyth");
    this.usdc = need(names, "MockUSDC");
  }

  // ---- prices ----
  /** A signed MockPyth update for FEED at `price` USD, published at `ts` (confidence 1 bp). */
  async update(price: number, ts: number): Promise<Hex> {
    const p = BigInt(Math.round(price * 1e8));
    const data = MOCKS.encode("createPriceFeedUpdateData", FEED, p, p / 10_000n, -8, p, p / 10_000n, BigInt(ts), BigInt(ts - 1));
    return MOCKS.decode<Hex>("createPriceFeedUpdateData", await this.a.call(this.pyth, data));
  }

  /** An update stamped one second after the latest block, and the fee MockPyth charges for it. */
  async pu(price?: number): Promise<[Hex[], bigint]> {
    const [, ts] = await this.a.latest();
    const ups = [await this.update(price ?? this.price, ts + 1)];
    const fee = MOCKS.decode<bigint>("getUpdateFee", await this.a.call(this.pyth, MOCKS.encode("getUpdateFee", ups)));
    return [ups, fee];
  }

  // ---- orders ----
  async expiry(blocks = 400_000): Promise<number> {
    const [n] = await this.a.latest();
    return n + blocks;
  }

  /** Create an order from account `i`, remember its id under `label`, and return the id. */
  async create(i: number, otype: number, isLong: boolean, size: bigint, label: string, opts: CreateOptions = {}): Promise<bigint> {
    const { trigger = 0n, limit = 0n, slip = 0n } = opts;
    let pred = 0n;
    if (otype === LIMIT) {
      const r = LENS.decode<{ pred: bigint; found: boolean }>(
        "findPredecessor",
        await this.a.call(this.lens, LENS.encode("findPredecessor", this.pair, isLong, limit, 0n, 64n)),
      );
      pred = r.pred;
    }
    const spec = {
      orderType: otype,
      isLong,
      isPostOnly: false,
      tif: 0,
      size,
      triggerPrice: trigger,
      limitPrice: limit,
      maxSlippageBp: slip,
      expirationBlock: BigInt(opts.exp || (await this.expiry())),
      integrator: ZERO_ADDRESS,
    };
    const [ups, fee] = await this.pu();
    const hints = { pred, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 };
    const data = PAIR.encode("createOrder", spec, hints, ups, 0n, 0n, 0n, "0x", "0x");
    await this.a.send(this.w[i]!, this.pair, data, { value: fee, label });
    const oid = LENS.decode<bigint>("nextOrderId", await this.a.call(this.lens, LENS.encode("nextOrderId", this.pair))) - 1n;
    this.orders[label] = oid;
    return oid;
  }

  async bucket(i: number): Promise<PositionBucket> {
    return PAIR.decode<PositionBucket>("positionBuckets", await this.a.call(this.pair, PAIR.encode("positionBuckets", this.w[i]!)));
  }

  async order(oid: bigint): Promise<OrderRecord> {
    const o = PAIR.decode<Record<string, unknown>>("orders", await this.a.call(this.pair, PAIR.encode("orders", oid)));
    const n = (k: string) => Number(o[k] as Num);
    const b = (k: string) => BigInt(o[k] as Num);
    return {
      creator: o.creator as Address,
      canceledBlock: n("canceledBlock"),
      orderType: n("orderType"),
      isLong: o.isLong as boolean,
      isPostOnly: o.isPostOnly as boolean,
      tif: n("tif"),
      integrator: o.integrator as Address,
      expiryBlock: n("expiryBlock"),
      inBook: o.inBook as boolean,
      maxSlippageBp: b("maxSlippageBp"),
      triggerPrice: b("triggerPrice"),
      limitPrice: b("limitPrice"),
      size: b("size"),
      filledSize: b("filledSize"),
      prioritySeq: n("prioritySeq"),
      filledBlock: n("filledBlock"),
      restedBlock: n("restedBlock"),
      restedPremiumPpm: b("restedPremiumPpm"),
      prevInBook: b("prevInBook"),
      nextInBook: b("nextInBook"),
    };
  }

  /** Units the vault holds from liquidations, long and short together. */
  async inventory(): Promise<bigint> {
    const inv = LENS.decode<{ longInv: { size: bigint }; shortInv: { size: bigint } }>(
      "getPendingLiquidationExposure",
      await this.a.call(this.lens, LENS.encode("getPendingLiquidationExposure", this.pair)),
    );
    return inv.longInv.size + inv.shortInv.size;
  }

  // ---- setup ----
  async setup(log: (line: string) => void = console.log): Promise<void> {
    const [a, w] = [this.a, this.w as [Address, ...Address[]]];
    for (const who of w.slice(0, 7)) {
      // the keeper (account 7) needs no USDC: it holds only what it collects
      await a.send(w[0], this.usdc, MOCKS.encode("mint", who, 2_000_000n * 10n ** 6n));
    }
    let [ups, fee] = await this.pu();
    await a.send(w[0], this.pyth, MOCKS.encode("updatePriceFeeds", ups), { value: fee });
    await a.send(w[0], this.usdc, MOCKS.encode("approve", this.factory, 5000n * 10n ** 6n));
    const r = await a.send(w[0], this.factory, FACTORY.encode("proposePairDeployment", FEED, true, 5000n * E18, "ETH/USD"), {
      label: "propose listing",
    });
    const topic = FACTORY.topic("PairDeploymentProposed");
    const lg = r.logs.find((x) => x.topics[0] === topic);
    if (!lg) throw new Error("the listing proposal emitted no PairDeploymentProposed");
    const [pairId, assertion] = [lg.topics[1]!, lg.topics[2]!];
    await a.warp(48 * 3600 + 1);
    await a.send(w[0], this.factory, FACTORY.encode("settleDeploymentProposal", assertion), { label: "settle listing" });
    this.pair = FACTORY.decode<Address>("getPairAddress", await a.call(this.factory, FACTORY.encode("getPairAddress", pairId)));
    log(`   market listed at ${this.pair}`);
    for (let i = 0; i < 7; i++) await a.send(w[i]!, this.usdc, MOCKS.encode("approve", this.pair, MAX_UINT256));
    for (const [i, amount] of [[1, 40_000n], [2, 40_000n], [3, 10_000n], [4, 10_000n]] as const) {
      await a.send(w[i]!, this.pair, PAIR.encode("depositCollateral", amount * E18, 0n, 0n, 0n, "0x", "0x"));
    }
    [ups, fee] = await this.pu();
    await a.send(w[5]!, this.pair, PAIR.encode("depositToInsurance", 20_000n * E18, ups, 0n, 0n, 0n, "0x", "0x"), {
      value: fee,
      label: "insurance deposit",
    });
    for (const price of [1990n, 1980n, 1970n]) {
      await this.create(1, LIMIT, true, E18, `bid${price}`, { limit: price * E18 });
    }
    for (const [price, size] of [[2010n, (3n * E18) / 2n], [2020n, E18], [2030n, 2n * E18]] as const) {
      await this.create(2, LIMIT, false, size, `ask${price}`, { limit: price * E18 });
    }
    await this.create(3, MARKET, true, 2n * E18, "market-buy", { slip: 300n });
    // A sell stop under account 3's long, with a $1 keeper bounty.
    await this.create(3, STOP_LOSS, false, 2n * E18, "stop-loss", { trigger: (E18 << 128n) | (1950n * E18), slip: 500n });
    const mr = PAIR.decode<{ imrBp: bigint; mmrBp: bigint }>("marginRequirements", await a.call(this.pair, PAIR.encode("marginRequirements")));
    // The victim's size in thousandths of a unit: as large as 85% of its $1,000 margins at $2,045, at most 5.
    const milli = BigInt(Math.round(Math.min((0.85 * 1000 * 10_000) / Number(mr.imrBp) / 2045, 5.0) * 1000));
    const size = milli * 10n ** 15n;
    await this.create(2, LIMIT, false, size + E18, "ask2045", { limit: 2045n * E18 });
    await a.send(w[6]!, this.pair, PAIR.encode("depositCollateral", 1000n * E18, 0n, 0n, 0n, "0x", "0x"));
    await this.create(6, MARKET, true, size, "victim-buy", { slip: 500n });
    log(`   victim long ${Number(milli) / 1000} ETH on $1,000 (imr ${mr.imrBp} bp, mmr ${mr.mmrBp} bp)`);
    this.mmrBp = mr.mmrBp;
    this.victimSize = size;
  }

  /** A price a little under the victim's maintenance line, in USD. */
  async liquidationPrice(): Promise<number> {
    const b = await this.bucket(6);
    const [size, entryValue, collateral] = [Number(b.size) / 1e18, Number(b.entryValue) / 1e18, Number(b.collateral) / 1e18];
    const mmr = Number(this.mmrBp) / 10_000;
    return Math.round(((entryValue - collateral) / (size * (1 - mmr)) - (0.02 * entryValue) / size) * 100) / 100;
  }
}

function need(names: Record<string, Address>, name: string): Address {
  const a = names[name];
  if (!a) throw new Error(`the deployment has no ${name}`);
  return a;
}

export interface WaitOptions {
  /** Seconds. */
  timeout?: number;
  /** Seconds between polls. */
  every?: number;
  what?: string;
}

/** Poll `fn` until it returns something truthy, and return that; throws after `timeout` seconds. */
export async function waitUntil<T>(fn: () => T | Promise<T>, opts: WaitOptions = {}): Promise<NonNullable<T>> {
  const { timeout = 90, every = 0.5, what = "condition" } = opts;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout * 1_000) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await sleep(every * 1_000);
  }
  throw new Error(`timed out after ${timeout.toFixed(0)}s waiting for ${what}`);
}
