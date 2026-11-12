/**
 * Built-in networks and price endpoints.
 *
 * The factory addresses must match the Bazaar docs' deployments page, the canonical registry of
 * official deployments. Until a network launches its factory is null and a config must give one.
 */

import type { Address } from "viem";

export interface NetworkPreset {
  readonly name: string;
  readonly chainId: number;
  readonly factory: Address | null;
  readonly startBlock: number;
  readonly subgraphUrl: string | null;
  readonly official: boolean;
  /** the sequencer's own submission endpoint, where the network has one */
  readonly sendUrl: string | null;
}

export const NETWORKS: Readonly<Record<string, NetworkPreset>> = {
  "arbitrum-one": {
    name: "arbitrum-one",
    chainId: 42161,
    factory: null,
    startBlock: 0,
    subgraphUrl: null,
    official: true,
    sendUrl: "https://arb1-sequencer.arbitrum.io/rpc",
  },
  "arbitrum-sepolia": {
    name: "arbitrum-sepolia",
    chainId: 421614,
    factory: null,
    startBlock: 0,
    subgraphUrl: null,
    official: true,
    sendUrl: null,
  },
  anvil: {
    name: "anvil",
    chainId: 31337,
    factory: null,
    startBlock: 0,
    subgraphUrl: null,
    official: false,
    sendUrl: null,
  },
};

/** Where Pyth Pro is served: its price stream, its request API, and its symbols registry. */
export interface ProEndpoints {
  /** WebSocket stream endpoints. A client connects to every one of them, since any single one may go down. */
  readonly streamUrls: readonly string[];
  /** Base URL of the request API (`POST /v1/latest_price`, `POST /v1/price`). */
  readonly restUrl: string;
  /** Base URL of the symbols registry (`GET /v1/symbols`), which needs no token. */
  readonly symbolsUrl: string;
}

/**
 * Pyth's own Pyth Pro endpoints. Their request API and stream serve prices only to the holder of a Pyth
 * Pro API key: a client for them must present the key or a token minted from it.
 */
export const PYTH_PRO: ProEndpoints = {
  streamUrls: [
    "wss://pyth-lazer-0.dourolabs.app/v1/stream",
    "wss://pyth-lazer-1.dourolabs.app/v1/stream",
    "wss://pyth-lazer-2.dourolabs.app/v1/stream",
  ],
  restUrl: "https://pyth-lazer.dourolabs.app",
  symbolsUrl: "https://pyth.dourolabs.app",
};

/** The hosts of Pyth's own request API and stream endpoints ({@link PYTH_PRO}). */
const PYTH_PRO_PRICE_HOSTS: ReadonlySet<string> = new Set([PYTH_PRO.restUrl, ...PYTH_PRO.streamUrls].map((u) => new URL(u).hostname));

/**
 * Whether `url` is one of Pyth's own price endpoints: its host is that of {@link PYTH_PRO}'s request API
 * or of one of its stream endpoints. The symbols registry, which needs no key, is not one.
 */
export function isPythProPriceEndpoint(url: string): boolean {
  try {
    // A host written with a trailing dot (an absolute domain name) is the same host.
    return PYTH_PRO_PRICE_HOSTS.has(new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, ""));
  } catch {
    return false;
  }
}

/** `prices.endpoint` shortcuts: `pyth` is Pyth's own endpoints, which need a Pyth Pro API key. */
export const PRICE_ENDPOINTS: Readonly<Record<string, ProEndpoints>> = {
  pyth: PYTH_PRO,
};
