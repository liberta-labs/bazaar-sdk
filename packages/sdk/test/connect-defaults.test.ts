import { type Address, type Hex, encodeAbiParameters, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factory as factoryCodec } from "../src/chain/codec.js";
import type { Transport } from "../src/chain/rpc.js";
import { Bazaar } from "../src/client/bazaar.js";
import { ConnectError, type SubgraphSource, connect } from "../src/client/context.js";
import { NETWORKS, officialNetwork } from "../src/networks.js";

const SEPOLIA = NETWORKS["arbitrum-sepolia"]!;
const OFFICIAL = getAddress(SEPOLIA.factory!);
const FORK = getAddress("0x00000000000000000000000000000000000000f0");
const WIRED = getAddress("0x00000000000000000000000000000000000000aa");

/** A chain `chainId` on which every factory in `factories` answers its four wiring reads. */
function chainWith(chainId: number, factories: readonly Address[]): Transport {
  const f = factoryCodec();
  const wiring = new Set(["lens", "pairTerminator", "oracle", "usdc"].map((n) => f.selector(n as "lens")));
  const known = new Set(factories.map((a) => a.toLowerCase()));
  return {
    async request({ method, params }) {
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_getCode") return "0x";
      if (method === "eth_call") {
        const [tx, , overrides] = params as [{ to: string; data: Hex }, unknown, unknown];
        if (overrides) throw { code: -32602, message: "state overrides are not supported" };
        if (known.has(tx.to.toLowerCase()) && wiring.has(tx.data.slice(0, 10) as Hex)) {
          return encodeAbiParameters([{ type: "address" }], [WIRED]);
        }
        throw { code: 3, message: "execution reverted", data: "0x" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect without a factory", () => {
  it("reads the official deployment of the chain it is on, with that network's subgraph", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: { ok: true } }), { headers: { "content-type": "application/json" } });
    });
    const ctx = await connect({ transport: chainWith(SEPOLIA.chainId, [OFFICIAL]) });
    expect(ctx.factory).toBe(OFFICIAL);
    expect(ctx.chainId).toBe(SEPOLIA.chainId);
    expect(ctx.subgraph).not.toBeNull();
    await (ctx.subgraph as SubgraphSource).query("{ ok }");
    expect(urls).toEqual([SEPOLIA.subgraphUrl]);
  });

  it("refuses a chain with no official deployment, and names the way out", async () => {
    expect(officialNetwork(42161)).toBeNull();
    const e = await connect({ transport: chainWith(42161, [OFFICIAL]) }).catch((x) => x);
    expect(e).toBeInstanceOf(ConnectError);
    expect((e as Error).message).toBe("chain 42161 has no official Bazaar deployment: pass the factory of the deployment to use");
  });

  it("checks the expected chain before looking for its deployment", async () => {
    const e = await connect({ transport: chainWith(42161, []), chainId: SEPOLIA.chainId }).catch((x) => x);
    expect((e as Error).message).toBe(`connected to chain 42161, expected ${SEPOLIA.chainId}`);
  });

  it("does the same through Bazaar.connect", async () => {
    const bz = await Bazaar.connect({ transport: chainWith(SEPOLIA.chainId, [OFFICIAL]) });
    expect(bz.deployment.factory).toBe(OFFICIAL);
    expect(bz.ctx.subgraph).not.toBeNull();
  });
});

describe("connect's subgraph default", () => {
  it("gives the official factory, named explicitly, its network's subgraph too", async () => {
    const ctx = await connect({ transport: chainWith(SEPOLIA.chainId, [OFFICIAL]), factory: OFFICIAL.toLowerCase() as Address });
    expect(ctx.factory).toBe(OFFICIAL);
    expect(ctx.subgraph).not.toBeNull();
  });

  it("gives any other factory no subgraph, rather than the official deployment's history", async () => {
    const ctx = await connect({ transport: chainWith(SEPOLIA.chainId, [FORK]), factory: FORK });
    expect(ctx.subgraph).toBeNull();
    expect((await Bazaar.connect({ transport: chainWith(SEPOLIA.chainId, [FORK]), factory: FORK })).ctx.subgraph).toBeNull();
  });

  it("keeps an explicit null, and an explicit source", async () => {
    const transport = chainWith(SEPOLIA.chainId, [OFFICIAL]);
    expect((await connect({ transport, subgraph: null })).subgraph).toBeNull();
    expect((await Bazaar.connect({ transport, subgraph: null })).ctx.subgraph).toBeNull();
    const mine: SubgraphSource = { query: async () => ({}) as never };
    expect((await connect({ transport, subgraph: mine })).subgraph).toBe(mine);
  });
});
