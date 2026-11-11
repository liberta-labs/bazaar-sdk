/**
 * The block a contract was deployed in, found from the chain alone.
 *
 * No Bazaar contract records its own deployment block, but code appears at an address in exactly one
 * block and never leaves (Bazaar's contracts cannot self-destruct), so a binary search on
 * `eth_getCode(address, block)` finds it in about log2(head) reads. Reads at old blocks need a node
 * that keeps historical state (hosted providers such as Alchemy, Infura and QuickNode do); a node that
 * has pruned it answers with an error, and the search fails rather than guess.
 */

import type { Address } from "viem";
import type { Chain } from "./client.js";

export class DeploymentBlockError extends Error {
  override readonly name = "DeploymentBlockError";
}

export interface FindDeploymentOptions {
  /** Search below this block (default: the chain's head). */
  readonly head?: number;
  /** Search at or above this block (default 0). */
  readonly from?: number;
}

/** The first block whose state holds code at `address`. */
export async function findDeploymentBlock(chain: Chain, address: Address, opts: FindDeploymentOptions = {}): Promise<number> {
  const head = opts.head ?? (await chain.blockNumber());
  let lo = Math.max(0, opts.from ?? 0);
  let hi = head;
  const hasCode = async (block: number): Promise<boolean> => {
    try {
      return (await chain.code(address, block)).length > 2;
    } catch (e) {
      throw new DeploymentBlockError(
        `could not read ${address}'s code at block ${block} (${e instanceof Error ? e.message : String(e)}): ` +
          "the node may not keep historical state",
      );
    }
  };
  if (!(await hasCode(hi))) throw new DeploymentBlockError(`${address} has no code at block ${hi}`);
  if (await hasCode(lo)) return lo;
  // Invariant: no code at lo, code at hi.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await hasCode(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
