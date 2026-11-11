import { type Abi, type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, padHex, toHex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractCodec, factory as factoryCodec, oracle as oracleCodec, pair as pairCodec } from "../src/chain/codec.js";
import { InputError } from "../src/client/calls.js";
import {
  LISTING_EVENT_TEXT,
  PAIR_DEPLOYMENT_PROPOSAL_VOIDED,
  asFeedId,
  claimSeedRefund,
  compositeId,
  decodeFactoryLog,
  deploymentConstants,
  deploymentProposal,
  descriptionProblem,
  expireStuckDeploymentProposal,
  getComposite,
  listingFromReceipt,
  MAX_OPEN_LISTINGS,
  openListings,
  pendingDeployment,
  proposePairDeployment,
  registerComposite,
  seedRefundOwed,
  settleDeploymentProposal,
} from "../src/client/listings.js";
import { proPriceSource } from "../src/client/prices.js";
import { BondQuoteError, erc20Codec, optimisticOracleCodec } from "../src/client/uma.js";
import { ProClient, ProError, type ProSymbol } from "../src/prices/pro.js";
import { PYTH_PRO } from "../src/networks.js";
import { fakeFetch, json } from "./pro-fakes.js";
import { cachedRegistry, feedInfoFor } from "../src/client/registry.js";
import { ADDR, FakeChain, Revert, b32, makeCtx } from "./termination-fakes.js";
import { SubgraphError } from "../src/client/history.js";
import type { SubgraphSource } from "../src/client/context.js";

const NOW = 1_900_000_000;
const H = 3_600;
const D = 86_400;
const E18 = 10n ** 18n;
const USDC = 10n ** 6n;
const FEED = b32(0xaaa1);
const FX = b32(0xf0f0);
const F = () => factoryCodec();
const O = () => oracleCodec();
const registry = new ContractCodec([
  { type: "function", name: "getImplementationAddress", stateMutability: "view", inputs: [{ name: "n", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isIdentifierSupported", stateMutability: "view", inputs: [{ name: "i", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as unknown as Abi);
const OTHER_PAIR = getAddress("0x00000000000000000000000000000000000000e1");

const decodeCall = (c: ContractCodec, fn: string, data: Hex) => decodeAbiParameters(c.fn(fn).inputs, ("0x" + data.slice(10)) as Hex);

async function inputError(p: Promise<unknown>, field?: string): Promise<InputError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InputError);
    if (field) expect((e as InputError).field).toBe(field);
    return e as InputError;
  }
  throw new Error("expected an InputError");
}

function scene() {
  const fake = new FakeChain();
  fake.now = NOW;
  const ctx = makeCtx(fake);
  const st: Record<string, any> = {
    bond: 1_000n * USDC,
    live: true,
    byId: new Map<string, Address>(),
    byFeed: new Map<string, Address>(),
    pendingByFeed: new Map<string, Hex>(),
    pendingById: new Map<string, Hex>(),
    proposals: new Map<string, Record<string, unknown>>(),
    disputed: new Set<string>(),
    composites: new Map<string, Record<string, unknown>>(),
    terminated: new Set<string>(),
    allowance: 0n,
    balance: 10_000n * USDC,
    owed: 0n,
    assertions: new Map<string, Record<string, unknown>>(),
    whitelisted: () => true,
    preview: new Revert("0x") as unknown,
  };
  fake
    .on(ADDR.factory, F(), "requiredDeploymentBond", () => st.bond)
    .on(ADDR.factory, F(), "umaIdentifierIsLive", () => st.live)
    .on(ADDR.factory, F(), "pairAddressById", ([id]) => st.byId.get(id) ?? "0x0000000000000000000000000000000000000000")
    .on(ADDR.factory, F(), "pairAddressByBaseFeed", ([id]) => st.byFeed.get(id) ?? "0x0000000000000000000000000000000000000000")
    .on(ADDR.factory, F(), "pendingDeploymentByBaseFeed", ([id]) => st.pendingByFeed.get(id) ?? b32(0))
    .on(ADDR.factory, F(), "pendingDeploymentByPairId", ([id]) => st.pendingById.get(id) ?? b32(0))
    .on(ADDR.factory, F(), "getDeploymentProposal", ([id]) => st.proposals.get(id) ?? {})
    .on(ADDR.factory, F(), "deploymentDisputed", ([id]) => st.disputed.has(id))
    .on(ADDR.factory, F(), "seedRefundOwed", () => st.owed)
    .on(ADDR.factory, F(), "assertionOo", ADDR.oo)
    .on(ADDR.factory, F(), "oo", ADDR.oo)
    .on(ADDR.factory, F(), "MIN_DEPLOYMENT_AMOUNT", 4_000n * E18)
    .on(ADDR.factory, F(), "DEPLOYMENT_BOND_USDC", 1_000n * USDC)
    .on(ADDR.factory, F(), "DEPLOYMENT_LIVENESS", 48 * H)
    .on(ADDR.factory, F(), "DVM_DISPUTE_GRACE", BigInt(14 * D))
    .on(ADDR.oracle, O(), "composites", ([id]) => st.composites.get(id) ?? {})
    .on(OTHER_PAIR, pairCodec(), "isPairTerminated", () => st.terminated.has(OTHER_PAIR))
    .on(ADDR.pair, pairCodec(), "isPairTerminated", () => st.terminated.has(ADDR.pair))
    .on(ADDR.usdc, erc20Codec(), "allowance", () => st.allowance)
    .on(ADDR.usdc, erc20Codec(), "balanceOf", () => st.balance)
    .on(ADDR.oo, optimisticOracleCodec(), "getAssertion", ([id]) => st.assertions.get(id) ?? {})
    .on(ADDR.oo, optimisticOracleCodec(), "finder", ADDR.finder)
    .on(ADDR.oo, optimisticOracleCodec(), "settleAndGetAssertionResult", () => {
      if (st.preview instanceof Revert) throw st.preview;
      return st.preview;
    })
    .on(ADDR.finder, registry, "getImplementationAddress", ADDR.whitelist)
    .on(ADDR.whitelist, registry, "isIdentifierSupported", ([id]) => st.whitelisted(id));
  return { fake, ctx, st };
}

const proposal = (o: Record<string, unknown> = {}) => ({
  deployer: ADDR.bob,
  baseFeedId: FEED,
  isContinuouslyTraded: true,
  seedAmount: 3_000n * E18,
  seedAmountUsdc: 3_000n * USDC,
  description: "BTC",
  pairId: FEED,
  proposalTs: BigInt(NOW - H),
  resolved: false,
  deployed: false,
  ...o,
});

describe("descriptions and composites", () => {
  it("descriptionProblem follows the factory's charset and length", () => {
    expect(descriptionProblem("AAPL on NASDAQ")).toBeNull();
    expect(descriptionProblem("S&P 500, US large caps / index - v2.")).toBeNull();
    expect(descriptionProblem("")).toMatch(/Describe/);
    expect(descriptionProblem("AAPL: Apple")).toMatch(/":"/);
    expect(descriptionProblem("[AAPL]")).toMatch(/not allowed/);
    expect(descriptionProblem("Nestlé")).toMatch(/not allowed/);
    expect(descriptionProblem("x".repeat(200))).toBeNull();
    expect(descriptionProblem("x".repeat(201))).toMatch(/200/);
  });

  it("compositeId is keccak256(baseId ‖ quoteId ‖ invertQuote)", () => {
    expect(compositeId(FEED, FX, false)).toBe(keccak256(concatHex([FEED, FX, "0x00"])));
    expect(compositeId(FEED, FX, true)).toBe(keccak256(concatHex([FEED, FX, "0x01"])));
    expect(compositeId(0xaaa1, "61680", true)).toBe(compositeId(FEED, FX, true)); // legs by their Pyth Pro numbers
  });

  it("asFeedId takes a Pyth Pro feed number or the bytes32 that holds it", () => {
    for (const one of [1, 1n, "1", " 1 ", b32(1), b32(1).toUpperCase().replace("0X", "0x")]) expect(asFeedId("feed", one as never)).toBe(b32(1));
    expect(asFeedId("feed", 4_294_967_295)).toBe(b32(0xffffffffn));
    const composite = keccak256("0x01");
    expect(asFeedId("feed", composite)).toBe(composite); // a composite id passes as its bytes32
    for (const bad of [0, -1, 1.5, 4_294_967_296, "", "abc", "1e3", "0x01", "0x" + "zz".repeat(32), null, undefined, {}]) {
      let err: unknown;
      try {
        asFeedId("baseFeedId", bad as never);
      } catch (e) {
        err = e;
      }
      expect(err, String(bad)).toBeInstanceOf(InputError);
      expect((err as InputError).field).toBe("baseFeedId");
    }
  });

  it("registerComposite encodes the legs and refuses legs that are not two different raw feeds", async () => {
    const { ctx, st, fake } = scene();
    const c = await registerComposite(ctx, { baseId: FEED, quoteId: FX, invertQuote: true });
    expect(c.to).toBe(ADDR.oracle);
    expect(decodeCall(O(), "registerComposite", c.data)).toEqual([FEED, FX, true]);
    expect(c.compositeId).toBe(compositeId(FEED, FX, true));
    expect(c.costs).toEqual([]);
    expect(c.summary).toBe(`Register the composite feed ${c.compositeId.slice(0, 10)}… (feed 43681 ÷ FX feed 61680) on Bazaar's oracle (no cost but gas)`);
    // the legs as numbers encode the same call
    expect((await registerComposite(ctx, { baseId: 0xaaa1, quoteId: "61680", invertQuote: true })).data).toBe(c.data);
    await inputError(registerComposite(ctx, { baseId: FEED, quoteId: FEED, invertQuote: false }), "quoteId");
    await inputError(registerComposite(ctx, { baseId: b32(0), quoteId: FX, invertQuote: false }), "baseId");
    // a composite id (a hash) is not a raw feed: nesting is refused by its form, without a read
    const before = fake.calls.length;
    await inputError(registerComposite(ctx, { baseId: FEED, quoteId: compositeId(FEED, FX, true), invertQuote: false }), "quoteId");
    await inputError(registerComposite(ctx, { baseId: b32(0x1_0000_0000n), quoteId: FX, invertQuote: false }), "baseId");
    expect(fake.calls.length).toBe(before);
    st.composites.set(compositeId(FEED, FX, true), { baseId: FEED, quoteId: FX, invertQuote: true });
    expect((await registerComposite(ctx, { baseId: FEED, quoteId: FX, invertQuote: true })).notes[0]).toMatch(/already registered/);
    expect(await getComposite(ctx, compositeId(FEED, FX, true))).toEqual({ baseId: FEED, quoteId: FX, invertQuote: true });
    expect(await getComposite(ctx, FEED)).toBeNull();
  });
});

describe("proposePairDeployment", () => {
  let s: ReturnType<typeof scene>;
  beforeEach(() => (s = scene()));
  const args = (o: Record<string, unknown> = {}) => ({ baseFeedId: FEED, isContinuouslyTraded: true, totalAmount: 4_000n * E18, description: "BTC on Coinbase", from: ADDR.alice, ...o }) as never;

  it("splits the deposit into the live bond and the seed, with one approval for the factory", async () => {
    const c = await proposePairDeployment(s.ctx, args());
    expect(c.to).toBe(ADDR.factory);
    expect(decodeCall(F(), "proposePairDeployment", c.data)).toEqual([FEED, true, 4_000n * E18, "BTC on Coinbase"]);
    expect([c.pairId, c.bondUsdc, c.seedAmountUsdc]).toEqual([FEED, 1_000n * USDC, 3_000n * USDC]);
    expect(c.pullsUsdc).toBe(4_000n * E18);
    expect(c.costs.map((x) => [x.kind, x.amount])).toEqual([
      ["bond", 1_000n * USDC],
      ["seed", 3_000n * USDC],
    ]);
    expect(c.summary).toMatch(/pulls 4,000 USDC, a 1,000 USDC UMA bond .* 3,000 USDC insurance seed/);
    expect(c.approvals).toHaveLength(1);
    expect(decodeCall(erc20Codec(), "approve", c.approvals[0]!.data)).toEqual([ADDR.factory, 4_000n * USDC]);
    expect(c.notes.join(" ")).toMatch(/3,000 shares/);
  });

  it("floors to whole micro-USDC and skips a covered approval", async () => {
    s.st.allowance = 5_000n * USDC;
    const c = await proposePairDeployment(s.ctx, args({ totalAmount: 4_000n * E18 + 5n }));
    expect(c.approvals).toEqual([]);
    expect(c.notes.join(" ")).toMatch(/floored/);
    // More allowance than the quote does not bound what the factory pulls.
    expect(c.notes.join(" ")).toMatch(/Warning: this wallet already lets the Bazaar factory .* take up to 5,000 USDC, more than the 4,000 USDC quoted/);
  });

  // A node answering a bond below the factory's floor must not shape the listing.
  it("refuses a bond quote below the factory's 1,000 USDC floor", async () => {
    s.st.bond = 0n;
    await expect(proposePairDeployment(s.ctx, args())).rejects.toThrow(BondQuoteError);
    s.st.bond = 999n * USDC;
    await expect(proposePairDeployment(s.ctx, args())).rejects.toThrow(/listing bond of 999 USDC, below the 1,000 USDC the contract always charges/);
  });

  it("refuses a seed below 3,000 USDC once a raised bond is taken", async () => {
    s.st.bond = 1_500n * USDC;
    expect((await inputError(proposePairDeployment(s.ctx, args()), "totalAmount")).message).toMatch(/deposit at least 4,500 USDC/);
    await proposePairDeployment(s.ctx, args({ totalAmount: 4_500n * E18 }));
  });

  it("refuses inputs the factory would refuse", async () => {
    await inputError(proposePairDeployment(s.ctx, args({ totalAmount: 3_999n * E18 })), "totalAmount");
    await inputError(proposePairDeployment(s.ctx, args({ description: "BTC: the coin" })), "description");
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: b32(0) })), "baseFeedId");
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: "not a feed" })), "baseFeedId");
    // neither a raw Pyth Pro id nor a registered composite: a Pyth Core id, an unregistered composite
    const core = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    expect((await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: core })), "baseFeedId")).message).toMatch(/neither a Pyth Pro feed ID .* nor a composite registered/);
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: compositeId(FEED, FX, false), isContinuouslyTraded: false })), "baseFeedId");
    s.st.live = false;
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/whitelist/);
  });

  it("takes the feed as its Pyth Pro number, and needs no price on the chain", async () => {
    const byHex = await proposePairDeployment(s.ctx, args());
    for (const n of [0xaaa1, 43_681n, "43681"]) {
      const c = await proposePairDeployment(s.ctx, args({ baseFeedId: n }));
      expect(c.data).toBe(byHex.data);
      expect(c.pairId).toBe(FEED);
    }
    // only the factory, the oracle's composite registry and the token are read
    expect(new Set(s.fake.calls.map((c) => c.fn))).toEqual(new Set(["composites", "requiredDeploymentBond", "umaIdentifierIsLive", "pairAddressById", "pairAddressByBaseFeed", "pendingDeploymentByBaseFeed", "allowance", "balanceOf"]));
    expect(byHex.legFeeds).toEqual([null]); // no registry at hand: not checked, and nothing said
    expect(byHex.notes.join(" ")).not.toMatch(/registry/);
  });

  it("checks the feed against Pyth Pro's symbols registry when one is at hand", async () => {
    const btc: ProSymbol = { id: 0xaaa1, feedId: FEED, symbol: "Crypto.BTC/USD", name: "BTCUSD", description: "", assetType: "crypto", minChannel: "real_time", state: "stable", schedule: "", exponent: -8, hermesId: null };
    const fx: ProSymbol = { ...btc, id: 0xf0f0, feedId: FX, symbol: "FX.GBP/USD", assetType: "fx", minChannel: "fixed_rate@200ms", schedule: "America/New_York;O,O,O,O,O,C,C;" };
    const symbols = vi.fn(async () => [btc, fx]);
    const c = await proposePairDeployment(s.ctx, args({ registry: { symbols } }));
    expect(c.legFeeds).toEqual([btc]);
    expect(c.notes).toContain("Pyth Pro's registry lists feed 43681 as Crypto.BTC/USD (crypto, state stable, fastest channel real_time): UMA's voters check it against the description.");
    // a feed the registry does not list: the bond would be lost to a dispute
    const e = await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: 404, registry: { symbols } })), "baseFeedId");
    expect(e.message).toBe("baseFeedId: Pyth Pro's symbols registry lists no feed with ID 404: check the ID (Pyth Pro feed IDs are numbers; Pyth Core's 32-byte IDs are a different namespace).");
    // both legs of a composite are looked up
    const id = compositeId(FX, 404, false);
    s.st.composites.set(id, { baseId: FX, quoteId: b32(404), invertQuote: false });
    expect((await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: id, isContinuouslyTraded: false, registry: { symbols } })), "baseFeedId")).message).toMatch(/no feed with ID 404/);
    const ok = compositeId(FEED, FX, false);
    s.st.composites.set(ok, { baseId: FEED, quoteId: FX, invertQuote: false });
    const both = await proposePairDeployment(s.ctx, args({ baseFeedId: ok, isContinuouslyTraded: false, registry: { symbols } }));
    expect(both.legFeeds).toEqual([btc, fx]);
    expect(both.notes.filter((n) => n.startsWith("Pyth Pro's registry lists"))).toHaveLength(2);
    // a registry that cannot be read, or answers with nothing, does not block: the note says it was not checked
    for (const broken of [async () => Promise.reject(new Error("down")), async () => []]) {
      const u = await proposePairDeployment(s.ctx, args({ baseFeedId: 404, registry: { symbols: broken } }));
      expect(u.notes).toContain("Pyth Pro's symbols registry could not be read, so the feed was not checked against it: confirm the feed ID before sending.");
    }
    // null skips it; by default the context's own Pyth Pro client is asked
    expect((await proposePairDeployment(s.ctx, args({ baseFeedId: 404, registry: null }))).legFeeds).toEqual([null]);
    const { fetch, calls } = fakeFetch(() => json([{ pyth_lazer_id: 0xaaa1, symbol: "Crypto.BTC/USD", asset_type: "crypto", min_channel: "real_time", state: "stable" }]));
    const ctx = makeCtx(s.fake, { prices: proPriceSource(new ProClient({ token: "fake-pyth-pro-key", fetch, symbolsUrl: "https://listing-registry.test" })) });
    expect((await proposePairDeployment(ctx, args())).legFeeds[0]).toMatchObject({ symbol: "Crypto.BTC/USD" });
    await inputError(proposePairDeployment(ctx, args({ baseFeedId: 404 })), "baseFeedId");
    expect(calls).toHaveLength(1); // the listing is fetched once per registry
    expect(calls[0]!.url.href).toBe("https://listing-registry.test/v1/symbols");
  });

  it("quotes the registry's text in notes on one line, and bounded", async () => {
    const evil: ProSymbol = {
      id: 0xaaa1,
      feedId: FEED,
      symbol: `Crypto.BTC/USD\n\u001b[2J${"z".repeat(500)}`,
      name: "",
      description: "",
      assetType: "crypto\r\n",
      minChannel: "real_time",
      state: "stable\u202e",
      schedule: "",
      exponent: -8,
      hermesId: null,
    };
    const c = await proposePairDeployment(s.ctx, args({ registry: { symbols: async () => [evil] } }));
    const note = c.notes.find((n) => n.startsWith("Pyth Pro's registry lists"))!;
    expect(note).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(note).toMatch(/^Pyth Pro's registry lists feed 43681 as Crypto\.BTC\/USD \[2Jz{80,}… \(crypto, state stable, fastest channel real_time\): UMA's voters check it against the description\.$/);
    expect(note.length).toBeLessThan(260);
  });

  it("composites must be registered and non-continuous", async () => {
    const id = compositeId(FX, b32(0xeeee), false);
    s.st.composites.set(id, { baseId: FX, quoteId: b32(0xeeee), invertQuote: false });
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: id })), "isContinuouslyTraded");
    const c = await proposePairDeployment(s.ctx, args({ baseFeedId: id, isContinuouslyTraded: false }));
    expect(c.pairId).toBe(id);
    expect(c.legFeeds).toEqual([null, null]);
    // one market per asset is keyed on the raw base leg
    expect(s.fake.called("pairAddressByBaseFeed").at(-1)!.args[0]).toBe(FX);
  });

  it("one market per asset", async () => {
    s.st.byId.set(FEED, ADDR.pair);
    s.st.byFeed.set(FEED, ADDR.pair);
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/already exists/);
    s.st.terminated.add(ADDR.pair);
    await proposePairDeployment(s.ctx, args()); // a terminated pair releases its slot
    s.st.byId.clear();
    s.st.byFeed.set(FEED, OTHER_PAIR);
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/one market per asset/);
  });

  it("a pending listing of the same asset blocks while in review or headed for deployment", async () => {
    const pid = b32(0xa5);
    s.st.pendingByFeed.set(FEED, pid);
    s.st.proposals.set(pid, proposal());
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/in UMA's review until/);
    s.st.proposals.set(pid, proposal({ proposalTs: BigInt(NOW - 49 * H) }));
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/settleDeploymentProposal/);
    // past review, but its identifier was removed: settling voids it, so it no longer blocks
    s.st.assertions.set(pid, { asserter: ADDR.bob, expirationTime: BigInt(NOW - H), currency: ADDR.usdc, bond: 1n, identifier: b32(7) });
    s.st.whitelisted = () => false;
    expect((await proposePairDeployment(s.ctx, args())).notes.join(" ")).toMatch(/voids it first/);
    s.st.whitelisted = () => true;
    // disputed: what UMA's voters ruled decides
    s.st.disputed.add(pid);
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/not ruled yet/);
    s.st.preview = true;
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/approved it/);
    s.st.preview = false;
    const c = await proposePairDeployment(s.ctx, args());
    expect(c.notes.join(" ")).toMatch(/rejected it: your call settles it first/);
    expect(s.fake.called("settleAndGetAssertionResult").at(-1)!.from).toBe(ADDR.alice);
  });
});

describe("listing reads and the settle / release / refund calls", () => {
  it("deploymentProposal decodes the record and its status", async () => {
    const { ctx, st } = scene();
    const id = b32(0xa5);
    st.proposals.set(id, proposal());
    expect(await deploymentProposal(ctx, id)).toEqual(
      expect.objectContaining({ deployer: ADDR.bob, status: "inReview", livenessEndsAt: NOW - H + 48 * H, releaseOpensAt: NOW - H + 48 * H, seedAmountUsdc: 3_000n * USDC }),
    );
    st.disputed.add(id);
    expect((await deploymentProposal(ctx, id))!).toEqual(expect.objectContaining({ status: "disputed", releaseOpensAt: NOW - H + 48 * H + 14 * D }));
    st.proposals.set(id, proposal({ resolved: true, deployed: true }));
    expect((await deploymentProposal(ctx, id))!.status).toBe("deployed");
    st.proposals.set(id, proposal({ resolved: true }));
    expect((await deploymentProposal(ctx, id))!.status).toBe("notDeployed");
    expect(await deploymentProposal(ctx, b32(1))).toBeNull();
  });

  it("pendingDeployment looks a composite up by its raw base leg", async () => {
    const { ctx, st, fake } = scene();
    const id = compositeId(FEED, FX, false);
    st.composites.set(id, { baseId: FEED, quoteId: FX, invertQuote: false });
    st.pendingByFeed.set(FEED, b32(0xa5));
    st.proposals.set(b32(0xa5), proposal({ baseFeedId: id, pairId: id }));
    expect((await pendingDeployment(ctx, { baseFeedId: id }))!.assertionId).toBe(b32(0xa5));
    expect(fake.called("pendingDeploymentByBaseFeed")[0]!.args[0]).toBe(FEED);
    expect(await pendingDeployment(ctx, { pairId: id })).toBeNull();
  });

  it("settleDeploymentProposal refuses during liveness and warns of a void", async () => {
    const { ctx, st } = scene();
    const id = b32(0xa5);
    st.proposals.set(id, proposal());
    st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW + 47 * H), currency: ADDR.usdc, bond: 1n, identifier: b32(7) });
    expect((await inputError(settleDeploymentProposal(ctx, { assertionId: id }), "assertionId")).message).toMatch(/can be settled from/);
    st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n, identifier: b32(7) });
    const c = await settleDeploymentProposal(ctx, { assertionId: id });
    expect(decodeCall(F(), "settleDeploymentProposal", c.data)).toEqual([id]);
    expect(c.notes[0]).toMatch(/deployed and seeded/);
    st.whitelisted = () => false;
    expect((await settleDeploymentProposal(ctx, { assertionId: id })).notes[0]).toBe(PAIR_DEPLOYMENT_PROPOSAL_VOIDED);
  });

  it("expireStuckDeploymentProposal opens after liveness, or the dispute grace", async () => {
    const { ctx, st } = scene();
    const id = b32(0xa5);
    st.pendingById.set(FEED, id);
    st.proposals.set(id, proposal({ proposalTs: BigInt(NOW - 47 * H) }));
    await inputError(expireStuckDeploymentProposal(ctx, { pairId: FEED }), "pairId");
    st.proposals.set(id, proposal({ proposalTs: BigInt(NOW - 48 * H) }));
    const c = await expireStuckDeploymentProposal(ctx, { pairId: FEED });
    expect(decodeCall(F(), "expireStuckDeploymentProposal", c.data)).toEqual([FEED]);
    st.disputed.add(id);
    expect((await inputError(expireStuckDeploymentProposal(ctx, { pairId: FEED }), "pairId")).message).toMatch(/before/);
    st.assertions.set(id, { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n, identifier: b32(7), disputer: ADDR.alice });
    st.whitelisted = () => false;
    expect((await expireStuckDeploymentProposal(ctx, { pairId: FEED })).notes[0]).toMatch(/left UMA's whitelist/);
    await inputError(expireStuckDeploymentProposal(ctx, { pairId: b32(9) }), "pairId");
  });

  it("seedRefundOwed and claimSeedRefund", async () => {
    const { ctx, st } = scene();
    await inputError(claimSeedRefund(ctx, { from: ADDR.alice }), "from");
    st.owed = 3_000n * USDC;
    expect(await seedRefundOwed(ctx, ADDR.alice)).toBe(3_000n * USDC);
    const c = await claimSeedRefund(ctx, { from: ADDR.alice });
    expect([c.data, c.amountUsdc, c.summary]).toEqual([F().selector("claimSeedRefund"), 3_000n * USDC, "Withdraw your 3,000 USDC listing seed refund"]);
  });

  it("deploymentConstants", async () => {
    const { ctx } = scene();
    expect(await deploymentConstants(ctx)).toEqual({
      minDeploymentAmount: 4_000n * E18,
      deploymentBondUsdc: 1_000n * USDC,
      requiredDeploymentBondUsdc: 1_000n * USDC,
      deploymentLiveness: 48 * H,
      dvmDisputeGrace: 14 * D,
      minInsuranceSeed: 3_000n * E18,
      maxDescriptionLength: 200,
    });
  });

  it("logs: the receipt's ids, and what a voided listing means", () => {
    const { ctx } = scene();
    const ev = F().eventByName.get("PairDeploymentProposed")!;
    const log = {
      address: ADDR.factory,
      topics: [ev.topic0, FEED, b32(0xa5), padHex(ADDR.alice, { size: 32 })],
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }], [FEED, "BTC", 3_000n * E18]),
      blockNumber: 1,
      blockHash: b32(1),
      transactionHash: b32(2),
      logIndex: 0,
    };
    expect(listingFromReceipt(ctx, { transactionHash: b32(2), blockNumber: 1, status: "success", gasUsed: 1n, effectiveGasPrice: 1n, from: ADDR.alice, to: ADDR.factory, logs: [log] })).toEqual({
      assertionId: b32(0xa5),
      pairId: FEED,
    });
    expect(decodeFactoryLog(log)!.args).toEqual(expect.objectContaining({ description: "BTC", seedAmount: 3_000n * E18 }));
    const voided = F().eventByName.get("PairDeploymentProposalVoided")!;
    expect(decodeFactoryLog({ ...log, topics: [voided.topic0, b32(0xa5), padHex(ADDR.alice, { size: 32 })], data: "0x" })!.name).toBe("PairDeploymentProposalVoided");
    expect(LISTING_EVENT_TEXT.PairDeploymentProposalVoided).toBe(PAIR_DEPLOYMENT_PROPOSAL_VOIDED);
    expect(PAIR_DEPLOYMENT_PROPOSAL_VOIDED).toMatch(/claimSeedRefund/);
  });
});

describe("the symbols registry", () => {
  const entry = (id: number): ProSymbol => ({ id, feedId: b32(id), symbol: `Crypto.T${id}/USD`, name: "", description: "", assetType: "crypto", minChannel: "real_time", state: "stable", schedule: "", exponent: -8, hermesId: null });

  it("keeps a listing for its time to live, and never an empty or failed one", async () => {
    let now = 0;
    let answer: ProSymbol[] | Error = [];
    let reads = 0;
    const src = {
      base: "https://registry-ttl.test",
      symbols: async () => {
        reads++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const reg = cachedRegistry(src, { ttl: 600, clock: () => now });
    expect(await reg.symbols()).toEqual([]);
    answer = [entry(1)];
    expect(await reg.symbols()).toEqual([entry(1)]); // the empty answer was not kept
    answer = [entry(2)];
    now = 599;
    expect(await reg.symbols()).toEqual([entry(1)]); // still within its time to live
    now = 601;
    expect(await reg.symbols()).toEqual([entry(2)]); // read again once older
    answer = new Error("down");
    now = 1_300;
    await expect(reg.symbols()).rejects.toThrow("down");
    answer = [entry(3)];
    expect(await reg.symbols()).toEqual([entry(3)]); // the failure was not kept
    expect(reads).toBe(5);
  });

  it("reads only the context's own registry when its price source has one", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      asked.push(String(input));
      return json([]);
    });
    try {
      const { fetch } = fakeFetch(() => json([{ pyth_lazer_id: 7, symbol: "Test.SEVEN/USD" }]));
      const ctx = makeCtx(new FakeChain(), { prices: proPriceSource(new ProClient({ token: "fake-pyth-pro-key", fetch, symbolsUrl: "https://own-registry.test" })) });
      expect(await feedInfoFor(ctx, [b32(1)], undefined)).toEqual(new Map()); // its own lists no feed 1, and that is the answer
      expect((await feedInfoFor(ctx, [b32(7)], undefined)).get(b32(7))?.symbol).toBe("Test.SEVEN/USD");
      expect(asked).toEqual([]); // Pyth's registry was never asked
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a registry given by its URL, and Pyth's own, without a token", async () => {
    const asked: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      asked.push({ url: String(input), auth: new Headers(init.headers).get("authorization") });
      return json([{ pyth_lazer_id: 9, symbol: "Test.NINE/USD" }]);
    });
    try {
      const ctx = makeCtx(new FakeChain());
      expect((await feedInfoFor(ctx, [b32(9)], "https://url-registry.test")).get(b32(9))?.symbol).toBe("Test.NINE/USD");
      // a context without a Pyth Pro source reads Pyth's registry, which needs no key
      await expect(feedInfoFor(ctx, [b32(9)], undefined)).resolves.toBeInstanceOf(Map);
      expect(asked[0]!.url).toBe("https://url-registry.test/v1/symbols");
      expect(asked.every((a) => a.auth === null)).toBe(true);
      // what is wrong with a registry's URL is named as the registry's, and a Pyth price host given as one
      // asks for no key, since a registry read sends none
      expect(() => cachedRegistry("pyth")).toThrow(new ProError("the symbols registry URL is not an http(s) or ws(s) URL"));
      expect(() => cachedRegistry(PYTH_PRO.restUrl)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("openListings", () => {
  /** A raw PairDeploymentProposed log, as eth_getLogs returns it. */
  const proposedLog = (assertionId: Hex, n: number) => ({
    address: ADDR.factory,
    topics: [factoryCodec().topic("PairDeploymentProposed"), FEED, assertionId, padHex(ADDR.bob, { size: 32 })],
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }], [FEED, "BTC", 3_000n * E18]),
    blockNumber: toHex(900 + n),
    blockHash: "0x" + "11".repeat(32),
    transactionHash: "0x" + n.toString(16).padStart(64, "0"),
    logIndex: toHex(n),
  });

  /** A subgraph answering the open-listing query from `pages`, recording each query. */
  const fakeSubgraph = (pages: { id: unknown }[][]) => {
    const asked: string[] = [];
    const sg: SubgraphSource = {
      async query<T>(q: string) {
        asked.push(q);
        return { listingProposals: pages[asked.length - 1] ?? [] } as T;
      },
    };
    return { sg, asked };
  };

  it("finds them in the factory's logs and keeps only the unresolved, oldest first", async () => {
    const { fake, ctx, st } = scene();
    const [inReview, disputed, resolved] = [b32(0xa1), b32(0xa2), b32(0xa3)];
    st.proposals.set(inReview, proposal({ proposalTs: BigInt(NOW - H) }));
    st.proposals.set(disputed, proposal({ proposalTs: BigInt(NOW - 3 * H) }));
    st.disputed.add(disputed);
    st.proposals.set(resolved, proposal({ resolved: true, deployed: true }));
    fake.rawLogs = [proposedLog(inReview, 1), proposedLog(disputed, 2), proposedLog(resolved, 3)];
    const r = await openListings(ctx, { fromBlock: 0 });
    expect(r.source).toBe("logs");
    expect(r.listings.map((l) => [l.assertionId, l.status])).toEqual([
      [disputed, "disputed"],
      [inReview, "inReview"],
    ]);
  });

  it("reads the ids it is given, drops ids the factory does not know, and finds nothing with no source", async () => {
    const { ctx, st } = scene();
    st.proposals.set(b32(0xa1), proposal());
    const r = await openListings(ctx, { ids: [b32(0xa1), b32(0xdead)] });
    expect(r.source).toBe("ids");
    expect(r.listings.map((l) => l.assertionId)).toEqual([b32(0xa1)]);
    expect(await openListings(ctx)).toEqual({ listings: [], source: "none" });
  });

  it("asks the subgraph for pending and disputed listings, pages by id, and trusts the chain over the index", async () => {
    const { fake, st } = scene();
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: b32(0x1000 + i) }));
    const page2 = [{ id: b32(0x2000) }];
    for (const { id } of [...page1, ...page2]) st.proposals.set(id, proposal());
    st.proposals.set(b32(0x1005), proposal({ resolved: true })); // the index lags: resolved on chain
    const { sg, asked } = fakeSubgraph([page1, page2]);
    const r = await openListings(makeCtx(fake, { subgraph: sg }), { fromBlock: 0 });
    expect(r.source).toBe("subgraph");
    expect(r.listings).toHaveLength(100);
    expect(r.listings.some((l) => l.assertionId === b32(0x1005))).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("status_in: [Pending, Disputed]");
    expect(asked[1]).toContain(`id_gt: "${b32(0x1000 + 99)}"`);
  });

  it("refuses a subgraph answer it cannot use", async () => {
    const { fake } = scene();
    const bad: { id: unknown }[][][] = [
      [[{ id: b32(2) }, { id: b32(1) }]], // out of id order: paging would not advance
      [[{ id: "0x1234" }]], // not 32 bytes of hex
      [Array.from({ length: 101 }, (_, i) => ({ id: b32(i + 1) }))], // more than one page holds
    ];
    for (const pages of bad) {
      await expect(openListings(makeCtx(fake, { subgraph: fakeSubgraph(pages).sg }))).rejects.toBeInstanceOf(SubgraphError);
    }
    const many = Array.from({ length: Math.ceil(MAX_OPEN_LISTINGS / 100) + 1 }, (_, p) => Array.from({ length: 100 }, (_, i) => ({ id: b32(p * 100 + i + 1) })));
    await expect(openListings(makeCtx(fake, { subgraph: fakeSubgraph(many).sg }))).rejects.toThrow(/more than 1000 open listing proposals/);
  });
});
