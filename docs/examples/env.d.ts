// What the samples assume their page already has: a browser wallet, and a source of signed Pyth Pro
// prices. Not part of the SDK.
import type { ProClientOptions, Transport } from "@liberta-labs/bazaar-sdk";

declare global {
  interface Window {
    /** An EIP-1193 provider injected by a browser wallet (MetaMask, Rabby, ...). */
    ethereum: Transport;
  }
  /**
   * Where the samples get signed Pyth Pro prices. On a server, `{ token }` with the Pyth Pro API key.
   * A web page must not hold the key: there it is `{ restUrl, streamUrls }` of a price proxy of the
   * app's own that adds the key on its server, or the page leaves `prices` out and sends its trades
   * through a relayer, which attaches the price (Gasless Trading).
   */
  const PRICES: ProClientOptions;
}

export {};
