import { type Abi, type Hex, decodeAbiParameters, stringToHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { ContractCodec, factory as factoryCodec } from "../src/chain/codec.js";
import { InputError } from "../src/client/calls.js";
import {
  activateIdentifierUpgrade,
  expireStuckIdentifierUpgradeProposal,
  identifierGovernance,
  identifierUpgradeConstants,
  identifierUpgradeProposal,
  isAssertTruthIdentifier,
  parseIdentifier,
  proposeUmaIdentifierUpgrade,
  settleIdentifierUpgradeProposal,
  umaIdentifier,
  umaIdentifierIsLive,
} from "../src/client/governance.js";
import { BondQuoteError, erc20Codec, identifierFromText, identifierText, identifierWhitelisted, optimisticOracleCodec } from "../src/client/uma.js";
import { ADDR, FakeChain, Revert, b32, makeCtx } from "./termination-fakes.js";

const NOW = 1_900_000_000;
const D = 86_400;
const USDC = 10n ** 6n;
const F = () => factoryCodec();
const T2 = identifierFromText("ASSERT_TRUTH2");
const T3 = identifierFromText("ASSERT_TRUTH3");
const registry = new ContractCodec([
  { type: "function", name: "getImplementationAddress", stateMutability: "view", inputs: [{ name: "n", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isIdentifierSupported", stateMutability: "view", inputs: [{ name: "i", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as unknown as Abi);

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
    ident: T2,
    live: true,
    pending: b32(0),
    queued: { assertionId: b32(0), newIdentifier: b32(0), effectiveTs: 0n },
    proposals: new Map<string, Record<string, unknown>>(),
    bond: 5_000n * USDC,
    allowance: 0n,
    balance: 10_000n * USDC,
    assertions: new Map<string, Record<string, unknown>>(),
    whitelist: new Set<string>([T2, T3]),
    preview: new Revert("0x") as unknown,
  };
  fake
    .on(ADDR.factory, F(), "umaIdentifier", () => st.ident)
    .on(ADDR.factory, F(), "umaIdentifierIsLive", () => st.live)
    .on(ADDR.factory, F(), "pendingIdentifierUpgradeAssertionId", () => st.pending)
    .on(ADDR.factory, F(), "queuedIdentifierUpgrade", () => st.queued)
    .on(ADDR.factory, F(), "getIdentifierUpgradeProposal", ([id]) => st.proposals.get(id) ?? {})
    .on(ADDR.factory, F(), "requiredIdentifierUpgradeBond", () => st.bond)
    .on(ADDR.factory, F(), "IDENTIFIER_UPGRADE_BOND_USDC", 5_000n * USDC)
    .on(ADDR.factory, F(), "IDENTIFIER_UPGRADE_LIVENESS", 2 * D)
    .on(ADDR.factory, F(), "IDENTIFIER_UPGRADE_TIMELOCK", BigInt(7 * D))
    .on(ADDR.factory, F(), "IDENTIFIER_UPGRADE_MIN_NOTICE", BigInt(4 * D))
    .on(ADDR.factory, F(), "DVM_DISPUTE_GRACE", BigInt(14 * D))
    .on(ADDR.factory, F(), "assertionOo", ADDR.oo)
    .on(ADDR.factory, F(), "oo", ADDR.oo)
    .on(ADDR.oo, optimisticOracleCodec(), "getAssertion", ([id]) => st.assertions.get(id) ?? {})
    .on(ADDR.oo, optimisticOracleCodec(), "finder", ADDR.finder)
    .on(ADDR.oo, optimisticOracleCodec(), "settleAndGetAssertionResult", () => {
      if (st.preview instanceof Revert) throw st.preview;
      return st.preview;
    })
    .on(ADDR.finder, registry, "getImplementationAddress", ([name]) => {
      expect(name).toBe(stringToHex("IdentifierWhitelist", { size: 32 }));
      return ADDR.whitelist;
    })
    .on(ADDR.whitelist, registry, "isIdentifierSupported", ([id]) => st.whitelist.has(id))
    .on(ADDR.usdc, erc20Codec(), "allowance", () => st.allowance)
    .on(ADDR.usdc, erc20Codec(), "balanceOf", () => st.balance);
  return { fake, ctx, st };
}

const upgrade = (o: Record<string, unknown> = {}) => ({ proposer: ADDR.bob, newIdentifier: T3, proposalTs: BigInt(NOW - D), resolved: false, settlementResolution: false, disputed: false, ...o });

describe("identifiers", () => {
  it("converts between names and bytes32", () => {
    expect(T2).toBe(("0x" + Buffer.from("ASSERT_TRUTH2").toString("hex").padEnd(64, "0")) as Hex);
    expect(identifierText(T2)).toBe("ASSERT_TRUTH2");
    expect(identifierText(b32(0))).toBeNull();
    expect(identifierText(b32(1))).toBeNull(); // not printable
    expect(parseIdentifier("x", "ASSERT_TRUTH3")).toBe(T3);
    expect(parseIdentifier("x", T3.toUpperCase().replace("0X", "0x"))).toBe(T3);
    expect(() => parseIdentifier("x", "é")).toThrow(InputError);
    expect(() => identifierFromText("x".repeat(33))).toThrow(InputError);
  });

  it("isAssertTruthIdentifier checks the first 12 bytes", () => {
    expect(isAssertTruthIdentifier(identifierFromText("ASSERT_TRUTH"))).toBe(true);
    expect(isAssertTruthIdentifier(T3)).toBe(true);
    expect(isAssertTruthIdentifier(identifierFromText("ASSERT_TRUTX"))).toBe(false);
    expect(isAssertTruthIdentifier(identifierFromText("EURUSD"))).toBe(false);
  });

  it("identifierWhitelisted resolves oracle -> finder -> whitelist", async () => {
    const { ctx, st } = scene();
    expect(await identifierWhitelisted(ctx, T3)).toBe(true);
    st.whitelist.delete(T3);
    expect(await identifierWhitelisted(ctx, T3)).toBe(false);
    expect(await umaIdentifier(ctx)).toBe(T2);
    expect(await umaIdentifierIsLive(ctx)).toBe(true);
  });
});

describe("proposeUmaIdentifierUpgrade", () => {
  let s: ReturnType<typeof scene>;
  beforeEach(() => (s = scene()));

  it("posts the live bond with an approval for the factory", async () => {
    const c = await proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice });
    expect(c.to).toBe(ADDR.factory);
    expect(decodeCall(F(), "proposeUmaIdentifierUpgrade", c.data)).toEqual([T3]);
    expect(c.costs).toEqual([expect.objectContaining({ kind: "bond", amount: 5_000n * USDC })]);
    expect(c.pullsUsdc).toBe(5_000n * 10n ** 18n);
    expect(c.summary).toMatch(/ASSERT_TRUTH3: posts a 5,000 USDC bond/);
    expect(decodeCall(erc20Codec(), "approve", c.approvals[0]!.data)).toEqual([ADDR.factory, 5_000n * USDC]);
  });

  // Audit F10: the bond is quoted at build time and pulled at execution.
  it("refuses a bond quote below the 5,000 USDC floor, and warns when the allowance exceeds the quote", async () => {
    s.st.bond = 0n;
    await expect(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice })).rejects.toThrow(BondQuoteError);
    s.st.bond = 4_999n * USDC;
    await expect(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice })).rejects.toThrow(/identifier-upgrade bond of 4,999 USDC, below the 5,000 USDC/);
    s.st.bond = 5_000n * USDC;
    s.st.allowance = (1n << 256n) - 1n;
    const c = await proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice });
    expect(c.approvals).toEqual([]);
    expect(c.notes.join(" ")).toMatch(/Warning: this wallet already lets the Bazaar factory .* take up to an unlimited amount, more than the 5,000 USDC quoted/);
  });

  it("notes the routing when the incumbent is off the whitelist", async () => {
    s.st.live = false;
    const c = await proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice });
    expect(c.notes.join(" ")).toMatch(/asserted under the proposed identifier/);
  });

  it("refuses what the factory would refuse", async () => {
    await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: b32(0), from: ADDR.alice }), "newIdentifier");
    await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "EURUSD", from: ADDR.alice }), "newIdentifier");
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH2", from: ADDR.alice }), "newIdentifier")).message).toMatch(/already/);
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH9", from: ADDR.alice }), "newIdentifier")).message).toMatch(/whitelist/);
    // one pending at a time
    s.st.pending = b32(0xa1);
    s.st.proposals.set(b32(0xa1), upgrade());
    s.st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW + D), currency: ADDR.usdc, bond: 1n });
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice }), "newIdentifier")).message).toMatch(/in UMA's review/);
    s.st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n });
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice }), "newIdentifier")).message).toMatch(/passed UMA's review/);
    s.st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n, disputer: ADDR.alice });
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice }), "newIdentifier")).message).toMatch(/not ruled yet/);
    s.st.preview = true;
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice }), "newIdentifier")).message).toMatch(/approved it/);
    s.st.preview = false;
    expect((await proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice })).notes[0]).toMatch(/rejected it/);
    s.st.pending = b32(0);
    // a queued upgrade blocks until it may activate, then is activated first
    s.st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(NOW + D) };
    expect((await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH4", from: ADDR.alice }), "newIdentifier")).message).toMatch(/timelock/);
    s.st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(NOW) };
    s.st.whitelist.add(identifierFromText("ASSERT_TRUTH4"));
    expect((await proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH4", from: ADDR.alice })).notes[0]).toMatch(/activates the queued upgrade/);
    // ... so the queued identifier is the one in force by then
    await inputError(proposeUmaIdentifierUpgrade(s.ctx, { newIdentifier: "ASSERT_TRUTH3", from: ADDR.alice }), "newIdentifier");
  });
});

describe("activation, settlement and release", () => {
  it("activateIdentifierUpgrade waits out the timelock, or the notice once the incumbent is removed", async () => {
    const { ctx, st } = scene();
    await inputError(activateIdentifierUpgrade(ctx), "assertionId");
    const effective = NOW + 5 * D; // approved 2 days ago
    st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(effective) };
    expect((await inputError(activateIdentifierUpgrade(ctx))).message).toMatch(/2030-03-22 17:46:40 UTC/);
    st.whitelist.delete(T2); // the incumbent is off UMA's whitelist: 4 days after approval
    expect((await inputError(activateIdentifierUpgrade(ctx))).message).toMatch(/2030-03-19 17:46:40 UTC/);
    st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(NOW + 3 * D) }; // approved 4 days ago
    const c = await activateIdentifierUpgrade(ctx);
    expect(c.data).toBe(F().selector("activateIdentifierUpgrade"));
    expect(c.notes[0]).toMatch(/new listings and termination claims are asserted under ASSERT_TRUTH3/);
    st.whitelist.delete(T3);
    st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(NOW) };
    expect((await activateIdentifierUpgrade(ctx)).notes[0]).toMatch(/cancels the upgrade/);
  });

  it("settleIdentifierUpgradeProposal refuses during liveness", async () => {
    const { ctx, st } = scene();
    st.proposals.set(b32(0xa1), upgrade());
    st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW + D), currency: ADDR.usdc, bond: 1n });
    await inputError(settleIdentifierUpgradeProposal(ctx, { assertionId: b32(0xa1) }), "assertionId");
    st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW), currency: ADDR.usdc, bond: 1n });
    const c = await settleIdentifierUpgradeProposal(ctx, { assertionId: b32(0xa1) });
    expect(decodeCall(F(), "settleIdentifierUpgradeProposal", c.data)).toEqual([b32(0xa1)]);
    expect(c.notes[0]).toMatch(/queued for 7 days/);
    await inputError(settleIdentifierUpgradeProposal(ctx, { assertionId: b32(0xbad) }), "assertionId");
  });

  it("expireStuckIdentifierUpgradeProposal opens after liveness, or the dispute grace", async () => {
    const { ctx, st } = scene();
    await inputError(expireStuckIdentifierUpgradeProposal(ctx));
    st.pending = b32(0xa1);
    st.proposals.set(b32(0xa1), upgrade({ proposalTs: BigInt(NOW - D) }));
    expect((await inputError(expireStuckIdentifierUpgradeProposal(ctx))).message).toMatch(/before/);
    st.proposals.set(b32(0xa1), upgrade({ proposalTs: BigInt(NOW - 2 * D) }));
    const c = await expireStuckIdentifierUpgradeProposal(ctx);
    expect(c.data).toBe(F().selector("expireStuckIdentifierUpgradeProposal"));
    expect(c.notes.at(-1)).toMatch(/approved and queued/);
    st.proposals.set(b32(0xa1), upgrade({ proposalTs: BigInt(NOW - 2 * D), disputed: true }));
    st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW - 1), currency: ADDR.usdc, bond: 1n, identifier: T2, disputer: ADDR.alice });
    await inputError(expireStuckIdentifierUpgradeProposal(ctx));
    st.whitelist.delete(T2);
    expect((await expireStuckIdentifierUpgradeProposal(ctx)).notes[0]).toMatch(/released at once/);
  });
});

describe("identifierGovernance", () => {
  it("reads the identifier, the pending and the queued upgrade in one call", async () => {
    const { ctx, st } = scene();
    st.pending = b32(0xa1);
    st.proposals.set(b32(0xa1), upgrade({ newIdentifier: identifierFromText("ASSERT_TRUTH4") }));
    st.assertions.set(b32(0xa1), { asserter: ADDR.bob, expirationTime: BigInt(NOW + D), currency: ADDR.usdc, bond: 1n });
    st.queued = { assertionId: b32(0xa2), newIdentifier: T3, effectiveTs: BigInt(NOW + D) };
    const g = await identifierGovernance(ctx);
    expect([g.umaIdentifierText, g.umaIdentifierIsLive]).toEqual(["ASSERT_TRUTH2", true]);
    expect(g.pending).toEqual(
      expect.objectContaining({ newIdentifierText: "ASSERT_TRUTH4", livenessEndsAt: NOW + D, releaseOpensAt: NOW + D, assertion: expect.objectContaining({ phase: "liveness", canSettleAt: NOW + D }) }),
    );
    expect(g.queued).toEqual(expect.objectContaining({ newIdentifierText: "ASSERT_TRUTH3", approvedAt: NOW - 6 * D, activationOpensAt: NOW + D, canActivate: false, newIdentifierWhitelisted: true }));
    expect(g.constants).toEqual({
      identifierUpgradeBondUsdc: 5_000n * USDC,
      requiredIdentifierUpgradeBondUsdc: 5_000n * USDC,
      identifierUpgradeLiveness: 2 * D,
      identifierUpgradeTimelock: 7 * D,
      identifierUpgradeMinNotice: 4 * D,
      dvmDisputeGrace: 14 * D,
    });
    expect(await identifierUpgradeConstants(ctx)).toEqual(g.constants);
    expect((await identifierUpgradeProposal(ctx, b32(0xa1)))!.proposer).toBe(ADDR.bob);
    expect(await identifierUpgradeProposal(ctx, b32(0xa9))).toBeNull();
  });
});
