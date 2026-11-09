import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { Bazaar, Chain, type BazaarContext, type Transport, factory, lens, pair, trade } from "../src/index.js";
import { CTX_FUNCTIONS } from "../src/client/bindings.generated.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PAIR: Address = "0x1111111111111111111111111111111111111111";
const LENS: Address = "0x2222222222222222222222222222222222222222";
const USER: Address = "0x3333333333333333333333333333333333333333";

/** Answers lens.claimableFees with 5 USDC owed; records calls. */
function fakeCtx(): BazaarContext {
  const claimable = lens().selector("claimableFees");
  const isPair = factory().selector("isPair");
  const transport: Transport = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_call") {
        const tx = (params as [{ to: string; data: Hex }])[0];
        if (tx.data.startsWith(claimable)) return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n * 10n ** 18n, 5n * 10n ** 18n]);
        // every builder first confirms the pair with the factory (guard.ts requirePair)
        if (tx.data.startsWith(isPair)) return encodeAbiParameters([{ type: "bool" }], [true]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const z = "0x0000000000000000000000000000000000000000" as Address;
  return { chain: new Chain(transport), chainId: 31337, factory: z, lens: LENS, terminator: z, oracle: z, usdc: z, prices: null, subgraph: null, integrator: z };
}

describe("the Bazaar facade", () => {
  it("binds every context-first function the generator lists", () => {
    const bz = Bazaar.from(fakeCtx()) as unknown as Record<string, Record<string, unknown>>;
    for (const [area, names] of Object.entries(CTX_FUNCTIONS)) {
      if (area === "prices") continue; // livePrices is a method on Bazaar itself
      for (const n of names) expect(typeof bz[area]?.[n], `${area}.${n}`).toBe("function");
    }
  });

  it("gives the same call as passing the context by hand", async () => {
    const ctx = fakeCtx();
    const bz = Bazaar.from(ctx);
    const viaFacade = await bz.trade.claimFees(PAIR, USER);
    const direct = await trade.claimFees(ctx, PAIR, USER);
    expect(viaFacade).toEqual(direct);
    expect(viaFacade.data).toBe(pair().encode("claimFees"));
    expect(viaFacade.summary).toContain("5");
  });

  it("keeps the generated bindings up to date", () => {
    expect(() => execFileSync(process.execPath, ["scripts/gen-bindings.mjs", "--check"], { cwd: ROOT, stdio: "pipe" })).not.toThrow();
  });
});
