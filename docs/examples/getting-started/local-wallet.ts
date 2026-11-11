// An EIP-1193 "wallet" over a local viem account, for the SDK functions that ask a wallet to sign
// typed data (permits.signPermit, relay.signRelayed). The SDK has no such helper of its own.
import type { Transport } from "@liberta-labs/bazaar-sdk";
import { type LocalAccount, getAddress } from "viem";

// ANCHOR: local-wallet
/**
 * Answers the two requests the SDK's signing helpers make, eth_accounts and eth_signTypedData_v4,
 * by signing with `account`'s key in this process. Everything else is refused with EIP-1193's
 * "unsupported method" (4200): send transactions with a viem WalletClient.
 */
export function localWallet(account: LocalAccount): Transport {
  return {
    async request({ method, params = [] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const [signer, typedData] = params as [string, string]; // the address, then the typed data as JSON
        if (getAddress(signer) !== account.address) {
          throw Object.assign(new Error(`this wallet signs only as ${account.address}`), { code: 4100 });
        }
        return account.signTypedData(JSON.parse(typedData));
      }
      throw Object.assign(new Error(`${method} is not supported by this wallet`), { code: 4200 });
    },
  };
}
// ANCHOR_END: local-wallet
