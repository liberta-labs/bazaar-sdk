import { type Abi, type Address, type Hex, encodeAbiParameters, getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { Chain } from "../src/chain/client.js";
import { ContractCodec, factory as factoryCodec, oracle as oracleCodec } from "../src/chain/codec.js";
import type { Transport } from "../src/chain/rpc.js";
import { Bazaar } from "../src/client/bazaar.js";
import { type PriceUpdateSource, connect } from "../src/client/context.js";
import { proPriceSource } from "../src/client/prices.js";
import { VERIFIER_SIGNER_ABI, verifierSignerCheck } from "../src/client/signers.js";
import { ProClient, type SignerCheck } from "../src/prices/pro.js";
import { SIGNER, evm, fakeFetch, fid, json, signed } from "./pro-fakes.js";
import { ADDR, FakeChain } from "./termination-fakes.js";

const verifier = new ContractCodec(VERIFIER_SIGNER_ABI as unknown as Abi);
const VERIFIER = getAddress("0x00000000000000000000000000000000000000fe");
const STRANGER = getAddress("0x00000000000000000000000000000000000000ab");

/** A chain whose oracle names VERIFIER, which trusts the addresses in `trusted`. */
function chainWith(trusted: Set<Address>) {
  const fake = new FakeChain();
  let failing = false;
  fake.on(ADDR.oracle, oracleCodec(), "pythLazer", VERIFIER).on(VERIFIER, verifier, "isValidSigner", ([s]) => {
    if (failing) throw new Error("rpc down");
    return trusted.has(getAddress(s));
  });
  return { fake, chain: new Chain(fake.transport), fail: (v: boolean) => (failing = v) };
}

describe("verifierSignerCheck", () => {
  it("asks the oracle's verifier whether it trusts a signer, once per signer while the answer is young", async () => {
    let now = 1_000;
    const { fake, chain } = chainWith(new Set([SIGNER]));
    const check = verifierSignerCheck(chain, ADDR.oracle, { clock: () => now });
    expect(await Promise.all([check(SIGNER), check(SIGNER.toLowerCase() as Address), check(STRANGER)])).toEqual([true, true, false]);
    expect(fake.called("pythLazer")).toHaveLength(1); // the verifier's address is read once
    expect(fake.called("isValidSigner").map((c) => [c.to, c.args[0]])).toEqual([
      [VERIFIER, SIGNER],
      [VERIFIER, STRANGER],
    ]);
    now += 59;
    expect([check(SIGNER), check(STRANGER)]).toEqual([true, false]); // answered from memory, at once
    expect(fake.called("isValidSigner")).toHaveLength(2);
  });

  it("refreshes a trusted answer in the background, and asks again before reusing a refusal", async () => {
    let now = 1_000;
    const trusted = new Set([SIGNER]);
    const { fake, chain, fail } = chainWith(trusted);
    const check = verifierSignerCheck(chain, ADDR.oracle, { clock: () => now, ttl: 60, maxAge: 600 });
    expect([await check(SIGNER), await check(STRANGER)]).toEqual([true, false]);
    now += 61;
    // older than the ttl: the trusted answer is still used at once, and asked again behind it
    expect(check(SIGNER)).toBe(true);
    expect(check(SIGNER)).toBe(true); // one refresh at a time
    await vi.waitFor(() => expect(fake.called("isValidSigner")).toHaveLength(3));
    // a refusal that old is not reused: the verifier is asked first
    trusted.add(STRANGER);
    expect(await check(STRANGER)).toBe(true);
    // Pyth drops the signer: the next refresh learns it
    trusted.delete(SIGNER);
    now += 61;
    expect(check(SIGNER)).toBe(true); // this call still rides the held answer
    await vi.waitFor(async () => expect(await check(SIGNER)).toBe(false));
    // a refresh that fails changes nothing while the answer is young enough
    trusted.add(SIGNER);
    now += 61;
    expect(await check(SIGNER)).toBe(true);
    fail(true);
    now += 300;
    expect(check(SIGNER)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(check(SIGNER)).toBe(true);
    // past maxAge it must be confirmed, and cannot be
    now += 301;
    await expect(check(SIGNER)).rejects.toThrow();
    fail(false);
    expect(await check(SIGNER)).toBe(true);
  });

  it("rejects when the verifier cannot be read, and tries again the next time", async () => {
    const { fake, chain, fail } = chainWith(new Set([SIGNER]));
    const check = verifierSignerCheck(chain, ADDR.oracle);
    fail(true);
    await expect(check(SIGNER)).rejects.toThrow(); // never answered: not trusted, not refused
    fail(false);
    expect(await check(SIGNER)).toBe(true);
    // an oracle that cannot name its verifier
    const broken = new FakeChain();
    let calls = 0;
    broken.on(ADDR.oracle, oracleCodec(), "pythLazer", () => {
      calls++;
      throw new Error("no such oracle");
    });
    const c2 = verifierSignerCheck(new Chain(broken.transport), ADDR.oracle);
    await expect(c2(SIGNER)).rejects.toThrow();
    await expect(c2(SIGNER)).rejects.toThrow();
    expect(calls).toBe(2); // the failed read is not kept
    expect(fake.called("pythLazer")).toHaveLength(1);
  });
});

describe("connect", () => {
  const f = factoryCodec();
  const addr = (a: Address) => encodeAbiParameters([{ type: "address" }], [a]);
  /** A deployment whose factory reports its wiring, and whose verifier trusts `trusted`. */
  function deployment(trusted: Set<Address>) {
    const answers = new Map<string, Hex>([
      [`${ADDR.factory.toLowerCase()}:${f.selector("lens")}`, addr(ADDR.lens)],
      [`${ADDR.factory.toLowerCase()}:${f.selector("pairTerminator")}`, addr(ADDR.terminator)],
      [`${ADDR.factory.toLowerCase()}:${f.selector("oracle")}`, addr(ADDR.oracle)],
      [`${ADDR.factory.toLowerCase()}:${f.selector("usdc")}`, addr(ADDR.usdc)],
      [`${ADDR.oracle.toLowerCase()}:${oracleCodec().selector("pythLazer")}`, addr(VERIFIER)],
    ]);
    const transport: Transport = {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0xa4b1";
        if (method === "eth_getCode") return "0x";
        if (method === "eth_call") {
          const [tx, , overrides] = params as [{ to: string; data: Hex }, unknown, unknown];
          if (overrides) throw { code: -32602, message: "state overrides are not supported" };
          const fixed = answers.get(`${tx.to.toLowerCase()}:${tx.data.slice(0, 10)}`);
          if (fixed) return fixed;
          if (tx.to.toLowerCase() === VERIFIER.toLowerCase()) {
            const signer = getAddress(`0x${tx.data.slice(-40)}`);
            return encodeAbiParameters([{ type: "bool" }], [trusted.has(signer)]);
          }
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    return transport;
  }

  it("has the price source check signers against the deployment's verifier", async () => {
    const good = await signed({ at: 100, feeds: [{ id: 1 }] });
    const { fetch } = fakeFetch(() => json(evm(good)));
    const prices = proPriceSource({ token: "fake-pyth-pro-key", fetch });
    const ctx = await connect({ transport: deployment(new Set([SIGNER])), factory: ADDR.factory, prices });
    expect(ctx.oracle).toBe(ADDR.oracle);
    expect(prices.client.isTrustedSigner).not.toBeNull();
    expect((await prices.latest([fid(1)])).update).toEqual([good]);
    // the same update against a verifier that does not trust its signer never becomes a price
    const prices2 = proPriceSource({ token: "fake-pyth-pro-key", fetch });
    await connect({ transport: deployment(new Set()), factory: ADDR.factory, prices: prices2 });
    await expect(prices2.latest([fid(1)])).rejects.toThrow(`a price update is signed by ${SIGNER}, which is not a signer Pyth's verifier trusts: refusing it`);
  });

  it("leaves the source alone when told to, when it has a check of its own, and when it cannot check", async () => {
    const off = proPriceSource({ token: "fake-pyth-pro-key", fetch: fakeFetch(() => json({})).fetch });
    await connect({ transport: deployment(new Set()), factory: ADDR.factory, prices: off, checkSigners: false });
    expect(off.client.isTrustedSigner).toBeNull();
    const own: SignerCheck = () => true;
    const mine = proPriceSource(new ProClient({ token: "fake-pyth-pro-key", isTrustedSigner: own }));
    await connect({ transport: deployment(new Set()), factory: ADDR.factory, prices: mine });
    expect(mine.client.isTrustedSigner).toBe(own);
    const plain: PriceUpdateSource = { latest: async () => ({ update: [], publishTime: 0 }) };
    expect((await connect({ transport: deployment(new Set()), factory: ADDR.factory, prices: plain })).prices).toBe(plain);
  });

  it("Bazaar.connect builds a Pyth Pro source from options, a client, or takes any source", async () => {
    const transport = deployment(new Set([SIGNER]));
    const fromOptions = await Bazaar.connect({ transport, factory: ADDR.factory, prices: { token: "t0ken", restUrl: "https://pro.test" } });
    const src = fromOptions.ctx.prices as ReturnType<typeof proPriceSource>;
    expect(src.client).toBeInstanceOf(ProClient);
    expect(src.client.restUrl).toBe("https://pro.test");
    expect(src.client.isTrustedSigner).not.toBeNull();
    const client = new ProClient({ token: "t0ken" });
    expect(((await Bazaar.connect({ transport, factory: ADDR.factory, prices: client })).ctx.prices as typeof src).client).toBe(client);
    const plain: PriceUpdateSource = { latest: async () => ({ update: [], publishTime: 0 }) };
    expect((await Bazaar.connect({ transport, factory: ADDR.factory, prices: plain })).ctx.prices).toBe(plain);
    expect((await Bazaar.connect({ transport, factory: ADDR.factory })).ctx.prices).toBeNull();
  });
});
