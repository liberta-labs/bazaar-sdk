/**
 * The Bazaar contract ABIs, vendored as typed `as const` modules from the Bazaar repository's abi/
 * directory (MIT). scripts/sync-abis.mjs refreshes them from a checkout and records the commit in
 * {@link ABI_SOURCE}.
 *
 * `bazaarPairAbi` also carries the events and errors of the external libraries the pair links: they
 * run by DELEGATECALL in the pair's context, so their logs carry the pair's address and their reverts
 * surface from its calls.
 */
export { bazaarFactoryAbi } from "./BazaarFactory.js";
export { bazaarOracleAbi } from "./BazaarOracle.js";
export { bazaarPairAbi } from "./BazaarPair.js";
export { bazaarPairLensAbi } from "./BazaarPairLens.js";
export { bazaarPairTerminatorAbi } from "./BazaarPairTerminator.js";
export { ABI_SOURCE } from "./source.js";

import { bazaarFactoryAbi } from "./BazaarFactory.js";
import { bazaarOracleAbi } from "./BazaarOracle.js";
import { bazaarPairAbi } from "./BazaarPair.js";
import { bazaarPairLensAbi } from "./BazaarPairLens.js";
import { bazaarPairTerminatorAbi } from "./BazaarPairTerminator.js";

export const ABIS = {
  BazaarFactory: bazaarFactoryAbi,
  BazaarOracle: bazaarOracleAbi,
  BazaarPair: bazaarPairAbi,
  BazaarPairLens: bazaarPairLensAbi,
  BazaarPairTerminator: bazaarPairTerminatorAbi,
} as const;

export type ContractName = keyof typeof ABIS;
export const CONTRACT_NAMES = Object.keys(ABIS) as ContractName[];
