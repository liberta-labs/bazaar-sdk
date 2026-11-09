/**
 * Bazaar SDK: TypeScript tools for the Bazaar protocol, for browsers and Node.
 *
 * The chain, ABI, price, formula and market layers here are shared by the keeper
 * (@liberta-labs/bazaar-keeper) and by frontends.
 */

export * from "./abi/index.js";
export * from "./constants.js";
export * from "./urls.js";
export * from "./networks.js";
export * from "./models.js";
export * from "./formulas/index.js";
export * from "./chain/rpc.js";
export * from "./chain/codec.js";
export * from "./chain/errors.js";
export * from "./chain/client.js";
export * from "./probe/index.js";
export * from "./prices/index.js";
export * from "./sync/index.js";
export * from "./subgraph/index.js";

// ---- Frontend: the shared core, flat ----
export * from "./client/context.js";
export * from "./client/calls.js";
export * from "./client/feeds.js";
export * from "./client/units.js";
export { errorMessage, installUserMessages, userMessage, walletErrorMessage, USER_MESSAGES } from "./errors/messages.js";

export { hermesPriceSource, livePrices, LivePrices } from "./client/prices.js";
export { Bazaar, type BazaarOptions } from "./client/bazaar.js";
export { requirePair } from "./client/guard.js";

// ---- Frontend: one namespace per area (`trade.createOrder(ctx, ...)`), so area names never collide ----
export * as markets from "./client/markets.js";
export * as account from "./client/account.js";
export * as live from "./client/live.js";
export * as priceFeeds from "./client/prices.js";
export * as orders from "./client/orders.js";
export * as trade from "./client/trade.js";
export * as insurance from "./client/insurance.js";
export * as signing from "./client/signing.js";
export * as permits from "./client/permits.js";
export * as allowance from "./client/allowance.js";
export * as relay from "./client/relay.js";
export * as batching from "./client/batching.js";
export * as history from "./client/history.js";
export * as previews from "./client/previews.js";
export * as termination from "./client/termination.js";
export * as listings from "./client/listings.js";
export * as governance from "./client/governance.js";
export * as uma from "./client/uma.js";
export * as format from "./errors/messages.js";
