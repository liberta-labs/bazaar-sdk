/**
 * A fake EIP-1193 transport for the write-builder tests: answers eth_call by contract and selector
 * (decoding the calldata against the ABI and encoding what the handler returns), serves blocks, signs
 * eth_signTypedData_v4 with local keys, and records every request.
 */

import { type Abi, type Address, type Hex, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, toHex } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { bazaarFactoryAbi, bazaarOracleAbi, bazaarPairAbi, bazaarPairLensAbi, bazaarPairTerminatorAbi } from "../src/abi/index.js";
import { Chain } from "../src/chain/client.js";
import { RpcError, type Transport } from "../src/chain/rpc.js";
import { ERC20_ABI } from "../src/client/allowance.js";
import type { BazaarContext, PriceUpdateSource } from "../src/client/context.js";

export const PAIR = getAddress("0x00000000000000000000000000000000000000a1");
export const LENS = getAddress("0x00000000000000000000000000000000000000b2");
export const ORACLE = getAddress("0x00000000000000000000000000000000000000c3");
export const TERMINATOR = getAddress("0x00000000000000000000000000000000000000d4");
export const USDC = getAddress("0x00000000000000000000000000000000000000e5");
export const FACTORY = getAddress("0x00000000000000000000000000000000000000f6");
export const INTEGRATOR = getAddress("0x00000000000000000000000000000000000001e7");
export const FEED = ("0x" + "ab".repeat(32)) as Hex;

export const ALICE_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const BOB_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const alice: PrivateKeyAccount = privateKeyToAccount(ALICE_KEY);
export const bob: PrivateKeyAccount = privateKeyToAccount(BOB_KEY);

type Impl = (args: readonly any[], call: { from: Address | null; value: bigint }) => unknown;

export class Revert extends Error {
  constructor(readonly data: Hex = "0x") {
    super("execution reverted");
  }
}

interface Route {
  abi: Abi;
  impls: Map<string, Impl>;
}

function toResult(abi: Abi, fn: string, value: unknown): unknown {
  const f = abi.find((e) => e.type === "function" && e.name === fn) as { outputs: readonly { name?: string }[] } | undefined;
  if (!f) throw new Error(`no function ${fn}`);
  if (f.outputs.length <= 1 || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  return f.outputs.map((p) => o[p.name ?? ""]);
}

/** Converts eth_signTypedData_v4 JSON back into what viem signs: integers as bigint. */
export function reviveTypedData(json: string) {
  const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  const revive = (type: string, v: unknown): unknown => {
    if (type.endsWith("[]")) return (v as unknown[]).map((x) => revive(type.slice(0, -2), x));
    if (/^u?int\d*$/.test(type)) return BigInt(v as string);
    const struct = td.types[type];
    if (struct) return Object.fromEntries(struct.map((f) => [f.name, revive(f.type, (v as Record<string, unknown>)[f.name])]));
    return v;
  };
  return { ...td, message: revive(td.primaryType, td.message) as Record<string, unknown> };
}

export class FakeChain implements Transport {
  chainId = 42161;
  blockNumber = 1_000;
  timestamp = 1_700_000_000;
  readonly requests: { method: string; params: readonly unknown[] }[] = [];
  readonly calls: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  readonly accounts = new Map<string, PrivateKeyAccount>();
  /** Replace the signature the wallet returns (e.g. a smart account's). */
  signOverride: ((account: Address, json: string) => Hex) | null = null;
  private readonly routes = new Map<string, Route>();

  constructor() {
    this.accounts.set(alice.address.toLowerCase(), alice);
    this.accounts.set(bob.address.toLowerCase(), bob);
  }

  on(to: Address, abi: Abi, fn: string, impl: Impl | unknown): this {
    const k = to.toLowerCase();
    let r = this.routes.get(k);
    if (!r) this.routes.set(k, (r = { abi, impls: new Map() }));
    r.impls.set(fn, typeof impl === "function" ? (impl as Impl) : () => impl);
    return this;
  }

  pair(fn: string, impl: Impl | unknown) {
    return this.on(PAIR, bazaarPairAbi as unknown as Abi, fn, impl);
  }
  lens(fn: string, impl: Impl | unknown) {
    return this.on(LENS, bazaarPairLensAbi as unknown as Abi, fn, impl);
  }
  oracle(fn: string, impl: Impl | unknown) {
    return this.on(ORACLE, bazaarOracleAbi as unknown as Abi, fn, impl);
  }
  terminator(fn: string, impl: Impl | unknown) {
    return this.on(TERMINATOR, bazaarPairTerminatorAbi as unknown as Abi, fn, impl);
  }
  usdc(fn: string, impl: Impl | unknown) {
    return this.on(USDC, ERC20_ABI as unknown as Abi, fn, impl);
  }
  factory(fn: string, impl: Impl | unknown) {
    return this.on(FACTORY, bazaarFactoryAbi as unknown as Abi, fn, impl);
  }

  /** The calls made to `fn`, decoded. */
  callsTo(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }

  async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    this.requests.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return toHex(this.chainId);
      case "eth_blockNumber":
        return toHex(this.blockNumber);
      case "eth_getBlockByNumber":
        return {
          number: toHex(this.blockNumber),
          timestamp: toHex(this.timestamp),
          hash: "0x" + "11".repeat(32),
          parentHash: "0x" + "22".repeat(32),
          baseFeePerGas: "0x0",
        };
      case "eth_getCode":
        return "0x";
      case "eth_call": {
        if (params.length > 2) throw new RpcError(-32602, "state overrides not supported");
        const tx = params[0] as { to: Address; data: Hex; from?: Address; value?: Hex };
        const r = this.routes.get(tx.to.toLowerCase());
        if (!r) throw new Error(`no contract at ${tx.to}`);
        const { functionName, args } = decodeFunctionData({ abi: r.abi, data: tx.data });
        const impl = r.impls.get(functionName);
        if (!impl) throw new Error(`no handler for ${functionName} at ${tx.to}`);
        this.calls.push({ to: getAddress(tx.to), fn: functionName, args: args ?? [] });
        try {
          const out = impl(args ?? [], { from: tx.from ? getAddress(tx.from) : null, value: tx.value ? BigInt(tx.value) : 0n });
          return encodeFunctionResult({ abi: r.abi, functionName, result: toResult(r.abi, functionName, out) } as never);
        } catch (e) {
          if (e instanceof Revert) throw new RpcError(3, "execution reverted", e.data);
          throw e;
        }
      }
      case "eth_signTypedData_v4": {
        const [who, json] = params as [Address, string];
        if (this.signOverride) return this.signOverride(who, json);
        const acct = this.accounts.get(who.toLowerCase());
        if (!acct) throw Object.assign(new Error("unknown account"), { code: 4100 });
        return acct.signTypedData(reviveTypedData(json) as never);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

// MockPyth update data: abi.encode(PriceFeed(id, price, emaPrice), prevPublishTime)
const PRICE_STRUCT = [
  { name: "price", type: "int64" },
  { name: "conf", type: "uint64" },
  { name: "expo", type: "int32" },
  { name: "publishTime", type: "uint256" },
] as const;
export function mockUpdate(feedId: Hex, price: bigint, publishTime: number, conf = 0n, expo = -8): Hex {
  const p = { price, conf, expo, publishTime: BigInt(publishTime) };
  return encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "id", type: "bytes32" }, { name: "price", type: "tuple", components: PRICE_STRUCT }, { name: "emaPrice", type: "tuple", components: PRICE_STRUCT }] }, { type: "uint64" }],
    [{ id: feedId, price: p, emaPrice: p }, BigInt(publishTime - 1)],
  );
}

/** A price source serving MockPyth updates at `prices[feed]` (8-decimal integers). */
export class FakePrices implements PriceUpdateSource {
  readonly prices = new Map<string, bigint>();
  publishTime: number;
  calls = 0;
  constructor(publishTime: number) {
    this.publishTime = publishTime;
  }
  set(feed: Hex, price8dp: bigint) {
    this.prices.set(feed.toLowerCase(), price8dp);
    return this;
  }
  async latest(feedIds: readonly Hex[]) {
    this.calls++;
    return {
      update: feedIds.map((f) => {
        const p = this.prices.get(f.toLowerCase());
        if (p === undefined) throw new Error(`no price for ${f}`);
        return mockUpdate(f, p, this.publishTime);
      }),
      publishTime: this.publishTime,
    };
  }
}

/**
 * A context over the fake, with the pair priced off one plain feed and a 7-wei-per-update Pyth fee.
 * The factory knows PAIR (and only PAIR) as one of its pairs, and the pair is live (not terminated,
 * no terminal entitlement) until a test says otherwise.
 */
export function fakeContext(opts: { prices?: PriceUpdateSource | null } = {}) {
  const fake = new FakeChain();
  const prices = opts.prices === undefined ? new FakePrices(fake.timestamp).set(FEED, 2000_00000000n) : opts.prices;
  fake.factory("isPair", ([a]: readonly [Address]) => getAddress(a) === PAIR);
  fake.pair("isPairTerminated", false);
  fake.lens("getTerminalEntitlement", { collateral: 0n, registeredClaim: 0n, principalRatio: 0n, profitRatio: 0n, payout: 0n });
  fake.pair("baseFeedId", FEED);
  fake.oracle("composites", { baseId: "0x" + "00".repeat(32), quoteId: "0x" + "00".repeat(32), invertQuote: false });
  fake.oracle("getUpdateFee", ([u]: readonly [readonly Hex[]]) => BigInt(u.length) * 7n);
  const ctx: BazaarContext = {
    chain: new Chain(fake),
    chainId: fake.chainId,
    factory: FACTORY,
    lens: LENS,
    terminator: TERMINATOR,
    oracle: ORACLE,
    usdc: USDC,
    prices,
    subgraph: null,
    integrator: INTEGRATOR,
  };
  return { fake, ctx, prices: prices as FakePrices | null };
}

/** A stored order as `pair.orders(id)` returns it. */
export function storedOrder(o: Partial<Record<string, unknown>> = {}) {
  return {
    creator: alice.address,
    canceledBlock: 0n,
    orderType: 1,
    isLong: true,
    isPostOnly: false,
    tif: 0,
    integrator: INTEGRATOR,
    expiryBlock: 100_000n,
    inBook: true,
    maxSlippageBp: 0,
    triggerPrice: 0n,
    limitPrice: 1990n * 10n ** 18n,
    size: 10n ** 18n,
    filledSize: 0n,
    prioritySeq: 5,
    filledBlock: 0n,
    restedBlock: 900,
    restedPremiumPpm: 0,
    prevInBook: 0,
    nextInBook: 0,
    ...o,
  };
}

export const bucket = (o: Partial<Record<string, unknown>> = {}) => ({
  isLong: false,
  size: 0n,
  entryValue: 0n,
  collateral: 0n,
  entryFundingIndex: 0n,
  takeProfitOrderId: 0n,
  stopLossOrderId: 0n,
  ...o,
});
