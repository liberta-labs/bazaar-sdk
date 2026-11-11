// What the samples assume their page already has: a browser wallet, and a way to get Pyth Pro
// tokens from the app's own backend. Not part of the SDK.
import type { Transport } from "@liberta-labs/bazaar-sdk";

declare global {
  interface Window {
    /** An EIP-1193 provider injected by a browser wallet (MetaMask, Rabby, ...). */
    ethereum: Transport;
  }
  /**
   * The page's source of short-lived Pyth Pro tokens: a call to the app's own backend, which mints
   * them from its API key (the Connecting page builds one). The key itself never reaches a browser.
   */
  function pythToken(): Promise<string>;
}

export {};
