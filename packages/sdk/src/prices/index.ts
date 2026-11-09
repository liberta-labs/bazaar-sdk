/**
 * Prices: the Hermes client, the live price service, and Pyth accumulator updates.
 *
 * The accumulator functions are generic names (parse, subset, build), so they are grouped under the
 * `accumulator` namespace, as the Python module is used: `accumulator.subset(p.blob, [p.feedId])`.
 */

export * as accumulator from "./accumulator.js";
export { AccumulatorError, Accumulator, type AccumulatorUpdate, type PriceMessage } from "./accumulator.js";
export {
  HermesClient,
  type HermesClientOptions,
  HermesError,
  type HermesParsedUpdate,
  type HermesPrice,
  type HermesUpdates,
  MAX_RESPONSE_BYTES,
  MAX_STREAM_LINE,
  type PriceFeedMetadata,
  type Print,
  STREAM_IDLE_TIMEOUT,
  type StreamOptions,
  parseResponse,
} from "./hermes.js";
export {
  ETH_USD_BOUNDS,
  ETH_USD_MAX_AGE,
  MAX_FUTURE_SKEW,
  type PriceLogger,
  PriceService,
  type PriceServiceOptions,
  type PriceSource,
  type PrintListener,
  feedLabel,
  fetchSymbols,
  marketLabel,
} from "./service.js";
