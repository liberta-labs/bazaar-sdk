import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { Chain, DeploymentBlockError, type Transport, findDeploymentBlock } from "../src/index.js";

const FACTORY: Address = "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c";

/** A chain whose FACTORY has code from block `deployed` on; counts the code reads. */
function chainWith(deployed: number, head: number, opts: { prunedBelow?: number } = {}) {
  const reads: number[] = [];
  const transport: Transport = {
    async request({ method, params }) {
      if (method === "eth_blockNumber") return "0x" + head.toString(16);
      if (method === "eth_getCode") {
        const [, tag] = params as [string, string];
        const block = tag === "latest" ? head : Number(BigInt(tag));
        reads.push(block);
        if (opts.prunedBelow !== undefined && block < opts.prunedBelow) {
          throw Object.assign(new Error("missing trie node"), { code: -32000, data: undefined });
        }
        return block >= deployed ? "0x6080604052" : "0x";
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { chain: new Chain(transport), reads };
}

describe("findDeploymentBlock", () => {
  it("finds the first block with code in about log2(head) reads", async () => {
    const { chain, reads } = chainWith(287_654_321, 400_000_000);
    expect(await findDeploymentBlock(chain, FACTORY)).toBe(287_654_321);
    expect(reads.length).toBeLessThanOrEqual(31);
  });

  it("handles the edges: deployed at block 0, at the head, and one block after a guess", async () => {
    expect(await findDeploymentBlock(chainWith(0, 1000).chain, FACTORY)).toBe(0);
    expect(await findDeploymentBlock(chainWith(1000, 1000).chain, FACTORY)).toBe(1000);
    expect(await findDeploymentBlock(chainWith(1, 1000).chain, FACTORY)).toBe(1);
    expect(await findDeploymentBlock(chainWith(500, 1000).chain, FACTORY, { head: 900, from: 400 })).toBe(500);
  });

  it("refuses an address with no code at the head", async () => {
    await expect(findDeploymentBlock(chainWith(2000, 1000).chain, FACTORY)).rejects.toThrow(/has no code at block 1000/);
  });

  it("fails rather than guess when the node has pruned old state", async () => {
    const err = await findDeploymentBlock(chainWith(50_000, 1_000_000, { prunedBelow: 900_000 }).chain, FACTORY).catch((e) => e);
    expect(err).toBeInstanceOf(DeploymentBlockError);
    expect((err as Error).message).toMatch(/may not keep historical state/);
  });
});
