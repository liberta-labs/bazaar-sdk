import { type Abi, type Address, type Hex, concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, padHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ContractCodec, factory as factoryCodec, oracle as oracleCodec, pair as pairCodec } from "../src/chain/codec.js";
import { InputError } from "../src/client/calls.js";
import {
  LISTING_EVENT_TEXT,
  PAIR_DEPLOYMENT_PROPOSAL_VOIDED,
  claimSeedRefund,
  compositeId,
  decodeFactoryLog,
  deploymentConstants,
  deploymentProposal,
  descriptionProblem,
  expireStuckDeploymentProposal,
  getComposite,
  listingFromReceipt,
  pendingDeployment,
  proposePairDeployment,
  registerComposite,
  seedRefundOwed,
  settleDeploymentProposal,
} from "../src/client/listings.js";
import { BondQuoteError, erc20Codec, optimisticOracleCodec } from "../src/client/uma.js";
import { ADDR, FakeChain, Revert, b32, makeCtx } from "./termination-fakes.js";

const NOW = 1_900_000_000;
const H = 3_600;
const D = 86_400;
const E18 = 10n ** 18n;
const USDC = 10n ** 6n;
const FEED = b32(0xaaa1);
const FX = b32(0xf0f0);
const F = () => factoryCodec();
const O = () => oracleCodec();
const pyth = new ContractCodec([
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "price", type: "tuple", components: [{ name: "price", type: "int64" }, { name: "conf", type: "uint64" }, { name: "expo", type: "int32" }, { name: "publishTime", type: "uint256" }] }],
  },
] as unknown as Abi);
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
    pythHas: new Set<string>([FEED]),
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
    .on(ADDR.oracle, O(), "pyth", ADDR.pyth)
    .on(ADDR.pyth, pyth, "getPriceUnsafe", ([id]) => {
      if (!st.pythHas.has(id)) throw new Revert("0x14aebe68");
      return { price: 100n, conf: 1n, expo: -2, publishTime: BigInt(NOW - 5) };
    })
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
  });

  it("registerComposite encodes the legs and refuses nested or equal legs", async () => {
    const { ctx, st } = scene();
    const c = await registerComposite(ctx, { baseId: FEED, quoteId: FX, invertQuote: true });
    expect(c.to).toBe(ADDR.oracle);
    expect(decodeCall(O(), "registerComposite", c.data)).toEqual([FEED, FX, true]);
    expect(c.compositeId).toBe(compositeId(FEED, FX, true));
    expect(c.costs).toEqual([]);
    await inputError(registerComposite(ctx, { baseId: FEED, quoteId: FEED, invertQuote: false }), "quoteId");
    await inputError(registerComposite(ctx, { baseId: b32(0), quoteId: FX, invertQuote: false }), "baseId");
    st.composites.set(FX, { baseId: FEED, quoteId: b32(1), invertQuote: false });
    await inputError(registerComposite(ctx, { baseId: FEED, quoteId: FX, invertQuote: false }), "quoteId");
    st.composites.delete(FX);
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
    // Audit F10: more allowance than the quote does not bound what the factory pulls.
    expect(c.notes.join(" ")).toMatch(/Warning: this wallet already lets the Bazaar factory .* take up to 5,000 USDC, more than the 4,000 USDC quoted/);
  });

  // Audit F10: a node answering a bond below the factory's floor must not shape the listing.
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
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: b32(0x404) })), "baseFeedId"); // no Pyth price
    s.st.live = false;
    expect((await inputError(proposePairDeployment(s.ctx, args()), "baseFeedId")).message).toMatch(/whitelist/);
  });

  it("composites must be registered, non-continuous, and skip the Pyth check", async () => {
    const id = compositeId(FX, b32(0xeeee), false);
    s.st.composites.set(id, { baseId: FX, quoteId: b32(0xeeee), invertQuote: false });
    await inputError(proposePairDeployment(s.ctx, args({ baseFeedId: id })), "isContinuouslyTraded");
    const c = await proposePairDeployment(s.ctx, args({ baseFeedId: id, isContinuouslyTraded: false }));
    expect(c.pairId).toBe(id);
    expect(s.fake.called("getPriceUnsafe")).toEqual([]);
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
