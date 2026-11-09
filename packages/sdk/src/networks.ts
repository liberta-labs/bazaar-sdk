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

/**
 * `prices.endpoint` shortcuts. "bazaar" is the shared endpoint Bazaar intends to run; it has no URL
 * until that service exists.
 */
export const PRICE_ENDPOINTS: Readonly<Record<string, string | null>> = {
  pyth: "https://pyth.dourolabs.app/hermes",
  bazaar: null,
};

/** Feed metadata (symbols for market labels) is served without a key here. */
export const PUBLIC_FEED_METADATA_URL = "https://hermes.pyth.network";
