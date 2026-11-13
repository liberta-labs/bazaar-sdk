/**
 * `Bazaar`: the SDK as one object bound to one connection.
 *
 *     import { Bazaar } from "@liberta-labs/bazaar-sdk";
 *
 *     const bz = await Bazaar.connect({
 *       transport: "https://arb1.example/rpc",    // or an EIP-1193 provider, or a viem client
 *       factory: "0x...",
 *       prices: { token: process.env.PYTH_PRO_TOKEN }, // Pyth Pro, on a server; or any PriceUpdateSource
 *       subgraph: "https://subgraph.example/...", // optional: history
 *       integrator: "0xYourFrontend",             // optional: your referral fee address
 *     });
 *
 *     const eth = await bz.markets.getMarket("ETH/USD");
 *     const me = await bz.account.accountSnapshot(eth, user);
 *     const call = await bz.trade.createOrder(eth.address, user, { orderType: OrderType.Limit, isLong: true, ... });
 *     const sim = await bz.simulate(call);        // explained before anything is signed
 *     if (sim.ok) await bz.send(wallet, call);    // wallet: an EIP-1193 provider that signs for `user`
 *
 * A web page holds no Pyth Pro key: it connects without `prices`, and its trades go through a relayer
 * that attaches the price (`bz.relay.signRelayed`).
 *
 * Every context-first function of each area is here with the context already bound
 * (`bz.trade.createOrder(...)` is `trade.createOrder(bz.ctx, ...)`). The pure helpers (packing,
 * formatting, type strings) stay on the area modules, which the package also exports
 * (`import { orders } from "@liberta-labs/bazaar-sdk"`).
 */

import type { Address, Hex } from "viem";
import type { Receipt } from "../chain/client.js";
import type { Transport } from "../chain/rpc.js";
import { ProClient, type ProClientOptions, printable } from "../prices/pro.js";
import * as accountNs from "./account.js";
import * as allowanceNs from "./allowance.js";
import * as batchingNs from "./batching.js";
import { CTX_FUNCTIONS } from "./bindings.generated.js";
import { InputError, type PreparedCall, type Simulation, sendCall, simulate, waitForReceipt } from "./calls.js";
import { type BazaarContext, type ConnectOptions, type PriceUpdateSource, type SubgraphSource, connect } from "./context.js";
import * as governanceNs from "./governance.js";
import * as historyNs from "./history.js";
import * as insuranceNs from "./insurance.js";
import * as listingsNs from "./listings.js";
import * as liveNs from "./live.js";
import * as marketsNs from "./markets.js";
import * as ordersNs from "./orders.js";
import * as permitsNs from "./permits.js";
import * as previewsNs from "./previews.js";
import * as pricesNs from "./prices.js";
import * as relayNs from "./relay.js";
import * as signingNs from "./signing.js";
import * as terminationNs from "./termination.js";
import * as tradeNs from "./trade.js";
import * as umaNs from "./uma.js";

type DropCtx<F> = F extends (ctx: BazaarContext, ...args: infer A) => infer R ? (...args: A) => R : never;
type Bound<NS, K extends readonly string[]> = { readonly [P in K[number] & keyof NS]: DropCtx<NS[P]> };
type Area<M extends keyof typeof CTX_FUNCTIONS, NS> = Bound<NS, (typeof CTX_FUNCTIONS)[M]>;

function bind<NS extends object>(ctx: BazaarContext, ns: NS, names: readonly string[]): never {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const fn = (ns as Record<string, unknown>)[n];
    if (typeof fn === "function") out[n] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(ctx, ...args);
  }
  return Object.freeze(out) as never;
}

export interface BazaarOptions extends Omit<ConnectOptions, "prices" | "subgraph"> {
  /**
   * Where signed Pyth Pro updates come from: options for a client of the SDK's own (`{ token }`, the
   * API key), a {@link ProClient}, or any PriceUpdateSource. A client for Pyth's own endpoints, the
   * default ones, needs the key: options without it throw an InputError on `prices.token`, and so do
   * options with it in a web page, where it would be public. A page leaves `prices` out and sends its
   * priced calls through a relayer, or points `restUrl` and `streamUrls` at a proxy of its own.
   */
  prices?: PriceUpdateSource | ProClient | ProClientOptions | null;
  /**
   * Bazaar's subgraph (URL, or { url, apiKey }), or any SubgraphSource; null for none. Needed only for
   * history. Left out, the official network's subgraph when the factory is its official one.
   */
  subgraph?: SubgraphSource | string | { url: string; apiKey?: string | null } | null;
}

/** Every option a ProClient takes: the compiler holds this to ProClientOptions' keys. */
const PRO_CLIENT_OPTIONS = {
  token: true,
  streamUrls: true,
  restUrl: true,
  symbolsUrl: true,
  channel: true,
  headers: true,
  timeout: true,
  fetch: true,
  WebSocket: true,
  streamAuth: true,
  isTrustedSigner: true,
  signerCheckInterval: true,
  allowInsecure: true,
  clock: true,
  maxUpdateAhead: true,
} as const satisfies Record<keyof ProClientOptions, true>;

const PRICES_SHAPE =
  "it takes Pyth Pro client options ({ token, restUrl, streamUrls, symbolsUrl, ... }), a ProClient, or any PriceUpdateSource; the token goes in token, the endpoints in restUrl, streamUrls and symbolsUrl";

/**
 * The context's price source. A value of another shape is refused rather than read as client options:
 * a URL, or `{ url, apiKey }`, would otherwise become a client of Pyth's default endpoints without a
 * token, which fails later and far less clearly.
 */
function priceSource(p: BazaarOptions["prices"]): PriceUpdateSource | null {
  if (!p) return null;
  if (p instanceof ProClient) return pricesNs.proPriceSource(p);
  const v: unknown = p;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new InputError("prices", `A ${typeof v === "string" ? "URL" : typeof v} is not a price source: ${PRICES_SHAPE}.`);
  }
  if (typeof (v as PriceUpdateSource).latest === "function") return v as PriceUpdateSource;
  const unknown = Object.keys(v).filter((k) => !Object.hasOwn(PRO_CLIENT_OPTIONS, k));
  if (unknown.length > 0) throw new InputError("prices", `Unknown option ${unknown.map((k) => printable(k, 40)).join(", ")}: ${PRICES_SHAPE}.`);
  return pricesNs.proPriceSource(v as ProClientOptions);
}

/** The context's subgraph; undefined, when left out, so that connect can supply the official one. */
function subgraphSource(s: BazaarOptions["subgraph"]): SubgraphSource | null | undefined {
  if (s === undefined) return undefined;
  if (!s) return null;
  if (typeof s === "string") return historyNs.httpSubgraph(s);
  if ("url" in s && typeof s.url === "string") return historyNs.httpSubgraph(s.url, s.apiKey ?? undefined);
  return s as SubgraphSource;
}

export class Bazaar {
  readonly markets: Area<"markets", typeof marketsNs>;
  readonly account: Area<"account", typeof accountNs>;
  readonly live: Area<"live", typeof liveNs>;
  readonly orders: Area<"orders", typeof ordersNs>;
  readonly trade: Area<"trade", typeof tradeNs>;
  readonly insurance: Area<"insurance", typeof insuranceNs>;
  readonly signing: Area<"signing", typeof signingNs>;
  readonly permits: Area<"permits", typeof permitsNs>;
  readonly allowance: Area<"allowance", typeof allowanceNs>;
  readonly relay: Area<"relay", typeof relayNs>;
  readonly batching: Area<"batching", typeof batchingNs>;
  readonly history: Area<"history", typeof historyNs>;
  readonly previews: Area<"previews", typeof previewsNs>;
  readonly termination: Area<"termination", typeof terminationNs>;
  readonly listings: Area<"listings", typeof listingsNs>;
  readonly governance: Area<"governance", typeof governanceNs>;
  readonly uma: Area<"uma", typeof umaNs>;

  private constructor(readonly ctx: BazaarContext) {
    this.markets = bind(ctx, marketsNs, CTX_FUNCTIONS.markets);
    this.account = bind(ctx, accountNs, CTX_FUNCTIONS.account);
    this.live = bind(ctx, liveNs, CTX_FUNCTIONS.live);
    this.orders = bind(ctx, ordersNs, CTX_FUNCTIONS.orders);
    this.trade = bind(ctx, tradeNs, CTX_FUNCTIONS.trade);
    this.insurance = bind(ctx, insuranceNs, CTX_FUNCTIONS.insurance);
    this.signing = bind(ctx, signingNs, CTX_FUNCTIONS.signing);
    this.permits = bind(ctx, permitsNs, CTX_FUNCTIONS.permits);
    this.allowance = bind(ctx, allowanceNs, CTX_FUNCTIONS.allowance);
    this.relay = bind(ctx, relayNs, CTX_FUNCTIONS.relay);
    this.batching = bind(ctx, batchingNs, CTX_FUNCTIONS.batching);
    this.history = bind(ctx, historyNs, CTX_FUNCTIONS.history);
    this.previews = bind(ctx, previewsNs, CTX_FUNCTIONS.previews);
    this.termination = bind(ctx, terminationNs, CTX_FUNCTIONS.termination);
    this.listings = bind(ctx, listingsNs, CTX_FUNCTIONS.listings);
    this.governance = bind(ctx, governanceNs, CTX_FUNCTIONS.governance);
    this.uma = bind(ctx, umaNs, CTX_FUNCTIONS.uma);
  }

  /** Connect to a deployment: reads its wiring from the factory and checks the chain. */
  static async connect(opts: BazaarOptions): Promise<Bazaar> {
    const ctx = await connect({ ...opts, prices: priceSource(opts.prices), subgraph: subgraphSource(opts.subgraph) });
    return new Bazaar(ctx);
  }

  /** Wrap an existing context (from `connect()`). */
  static from(ctx: BazaarContext): Bazaar {
    return new Bazaar(ctx);
  }

  get chainId(): number {
    return this.ctx.chainId;
  }

  /** The deployment's addresses. */
  get deployment(): { factory: Address; lens: Address; terminator: Address; oracle: Address; usdc: Address } {
    const { factory, lens, terminator, oracle, usdc } = this.ctx;
    return { factory, lens, terminator, oracle, usdc };
  }

  /** Run a prepared call as the user without sending it; a revert comes back decoded, with a user message. */
  simulate(call: PreparedCall, opts?: { from?: Address; estimateGas?: boolean }): Promise<Simulation> {
    return simulate(this.ctx, call, opts);
  }

  /** Send through the user's EIP-1193 wallet. */
  send(wallet: Transport, call: PreparedCall, opts?: { from?: Address; gas?: bigint }): Promise<Hex> {
    return sendCall(wallet, call, opts);
  }

  /** Wait for the receipt; throws CallError if it reverted. */
  waitForReceipt(hash: Hex, opts?: { timeoutMs?: number; pollMs?: number }): Promise<Receipt> {
    return waitForReceipt(this.ctx, hash, opts);
  }

  /** Live prices for the given markets (all listed markets by default), streamed in the browser. */
  livePrices(opts?: Parameters<typeof pricesNs.livePrices>[1]): ReturnType<typeof pricesNs.livePrices> {
    return pricesNs.livePrices(this.ctx, opts);
  }
}
