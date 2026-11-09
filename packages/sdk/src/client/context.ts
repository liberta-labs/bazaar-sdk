/**
 * The connection every frontend helper works through: one chain, one Bazaar deployment, and the
 * optional price and subgraph services.
 */

import { type Address, type Hex, getAddress } from "viem";
import { Chain } from "../chain/client.js";
import { factory as factoryCodec } from "../chain/codec.js";
import type { Transport } from "../chain/rpc.js";
import { ZERO_ADDRESS } from "../constants.js";
import { installUserMessages } from "../errors/messages.js";

/** Signed Pyth price updates, as the pair's calls carry them. */
export interface PriceUpdateSource {
  /**
   * The freshest signed update the endpoint has for these feeds: `update` is what a call's
   * `priceUpdate: bytes[]` takes, `publishTime` the oldest publish time among the feeds (seconds).
   */
  latest(feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number }>;
  /**
   * The first update at or after `publishTime` for these feeds (Hermes' historical route), for
   * settlement prints. Optional: only termination settlement needs it.
   */
  atOrAfter?(publishTime: number, feedIds: readonly Hex[]): Promise<{ update: Hex[]; publishTime: number; prevPublishTime: number | null }[]>;
}

/** A GraphQL endpoint serving Bazaar's subgraph. */
export interface SubgraphSource {
  query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface BazaarContext {
  readonly chain: Chain;
  readonly chainId: number;
  readonly factory: Address;
  readonly lens: Address;
  readonly terminator: Address;
  readonly oracle: Address;
  readonly usdc: Address;
  /** Signed price updates for the calls that need one; null for a read-only connection. */
  readonly prices: PriceUpdateSource | null;
  readonly subgraph: SubgraphSource | null;
  /** The address every order this frontend creates names as its integrator (zero for none). */
  readonly integrator: Address;
}

export interface ConnectOptions {
  /** An EIP-1193 provider (a browser wallet, a viem client) or a JSON-RPC URL. */
  transport: Transport | string;
  factory: Address;
  prices?: PriceUpdateSource | null;
  subgraph?: SubgraphSource | null;
  integrator?: Address | null;
  /** Expected chain id: connect fails on any other chain. */
  chainId?: number;
}

export class ConnectError extends Error {
  override readonly name = "ConnectError";
}

/** Read the deployment's wiring from its factory and return a context bound to it. */
export async function connect(opts: ConnectOptions): Promise<BazaarContext> {
  // Decoded reverts read as sentences for users from here on (idempotent; survives tree-shaking).
  installUserMessages();
  const chain = typeof opts.transport === "string" ? Chain.fromUrl(opts.transport) : new Chain(opts.transport);
  const factory = getAddress(opts.factory);
  const f = factoryCodec();
  const names = ["lens", "pairTerminator", "oracle", "usdc"] as const;
  const [chainId, res] = await Promise.all([
    chain.chainId(),
    chain.batch(names.map((n) => ({ to: factory, data: f.encode(n) }))),
  ]);
  if (opts.chainId !== undefined && chainId !== opts.chainId) {
    throw new ConnectError(`connected to chain ${chainId}, expected ${opts.chainId}`);
  }
  if (!res.every(([ok]) => ok)) throw new ConnectError(`${factory} does not answer as a Bazaar factory on chain ${chainId}`);
  const [lens, terminator, oracle, usdc] = res.map(([, data], i) => f.decode<Address>(names[i]!, data));
  return {
    chain,
    chainId,
    factory,
    lens: lens!,
    terminator: terminator!,
    oracle: oracle!,
    usdc: usdc!,
    prices: opts.prices ?? null,
    subgraph: opts.subgraph ?? null,
    integrator: opts.integrator ? getAddress(opts.integrator) : ZERO_ADDRESS,
  };
}

export function requirePrices(ctx: BazaarContext): PriceUpdateSource {
  if (!ctx.prices) throw new ConnectError("this call needs a fresh Pyth price: connect with a price source (prices)");
  return ctx.prices;
}

export function requireSubgraph(ctx: BazaarContext): SubgraphSource {
  if (!ctx.subgraph) throw new ConnectError("history comes from Bazaar's subgraph: connect with a subgraph source");
  return ctx.subgraph;
}
