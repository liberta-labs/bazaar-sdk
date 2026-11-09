/**
 * The simulation probe, compiled from contracts/KeeperProbe.sol by scripts/build-probe.mjs.
 *
 * It is never deployed: its runtime code is placed at {@link PROBE_ADDRESS} through an eth_call state
 * override. `execute` runs a call from the probe and reports the probe's claimable balance on the pair
 * before and after (exactly what the call would earn), and `aggregate` batches reads into one eth_call.
 */

import { type Abi, type Address, toHex } from "viem";
import { ContractCodec } from "../chain/codec.js";
import { KEEPER_PROBE_RUNTIME, keeperProbeAbi } from "./artifact.js";

/**
 * Where the probe's code is placed by state override. Any address with no code of its own works; this
 * one sits above every precompile range, Arbitrum's included.
 */
export const PROBE_ADDRESS: Address = "0x0000000000000000000000000000000000bea7e5";
/** ETH the override gives the probe, to pay Pyth fees inside simulations. */
export const PROBE_BALANCE = 10n ** 20n;

let codecCache: ContractCodec | null = null;

export function probeCodec(): ContractCodec {
  if (!codecCache) codecCache = new ContractCodec(keeperProbeAbi as unknown as Abi);
  return codecCache;
}

export const runtimeCode = () => KEEPER_PROBE_RUNTIME;

/** The eth_call state override that places the probe. */
export type StateOverride = Record<Address, { code?: string; balance?: string }>;

const OVERRIDE: StateOverride = { [PROBE_ADDRESS]: { code: KEEPER_PROBE_RUNTIME, balance: toHex(PROBE_BALANCE) } };

export function stateOverride(): StateOverride {
  return OVERRIDE;
}
