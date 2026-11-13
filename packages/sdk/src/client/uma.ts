/**
 * UMA's Optimistic Oracle V3, as Bazaar's listing, termination and identifier-upgrade flows use it,
 * and the bond plumbing those flows share.
 *
 * Every UMA-gated action in Bazaar is an *assertion*: a claim posted with a USDC bond that anyone may
 * dispute during its liveness window. Undisputed, it resolves true once the liveness ends; disputed,
 * UMA's DVM votes on it (days, up to about 12) and the losing side forfeits its bond. Bazaar never
 * holds the verdict itself: the factory and the terminator learn it through OOv3's callbacks when
 * someone settles the assertion.
 *
 * The OO address comes from the deployment: `factory.oo()` (immutable), or per assertion from
 * `factory.assertionOo(id)` (listings and identifier upgrades) or `terminator.assertionOo(id)`
 * (termination claims).
 *
 * The ABI below is hand-written from UMA's `OptimisticOracleV3Interface`: Bazaar's generated ABIs do
 * not include the oracle.
 */

import { type Abi, type Address, type Hex, erc20Abi, getAddress, hexToString, stringToHex } from "viem";
import { ContractCodec, type DecodedLog, type RawLog, factory as factoryCodec, terminator as terminatorCodec } from "../chain/codec.js";
import { type DecodedError, decodeError } from "../chain/errors.js";
import { toRpcError } from "../chain/rpc.js";
import { ZERO_ADDRESS } from "../constants.js";
import { InputError, type PreparedCall } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { formatDecimal } from "./units.js";

// ---------------------------------------------------------------------------------------------
// The Optimistic Oracle V3 ABI fragment
// ---------------------------------------------------------------------------------------------

const ASSERTION_COMPONENTS = [
  {
    name: "escalationManagerSettings",
    type: "tuple",
    components: [
      { name: "arbitrateViaEscalationManager", type: "bool" },
      { name: "discardOracle", type: "bool" },
      { name: "validateDisputers", type: "bool" },
      { name: "assertingCaller", type: "address" },
      { name: "escalationManager", type: "address" },
    ],
  },
  { name: "asserter", type: "address" },
  { name: "assertionTime", type: "uint64" },
  { name: "settled", type: "bool" },
  { name: "currency", type: "address" },
  { name: "expirationTime", type: "uint64" },
  { name: "settlementResolution", type: "bool" },
  { name: "domainId", type: "bytes32" },
  { name: "identifier", type: "bytes32" },
  { name: "bond", type: "uint256" },
  { name: "callbackRecipient", type: "address" },
  { name: "disputer", type: "address" },
] as const;

const id32 = [{ name: "assertionId", type: "bytes32" }] as const;

/**
 * The slice of UMA's OptimisticOracleV3Interface these flows need. Field order of the Assertion
 * struct mirrors OOv3's own (escalation-manager settings nested first): `getAssertion` encodes it
 * positionally, so a reordered declaration would decode the wrong words without failing.
 */
export const optimisticOracleV3Abi = [
  { type: "function", name: "getAssertion", stateMutability: "view", inputs: id32, outputs: [{ name: "", type: "tuple", components: ASSERTION_COMPONENTS }] },
  {
    type: "function",
    name: "disputeAssertion",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assertionId", type: "bytes32" },
      { name: "disputer", type: "address" },
    ],
    outputs: [],
  },
  { type: "function", name: "settleAssertion", stateMutability: "nonpayable", inputs: id32, outputs: [] },
  { type: "function", name: "settleAndGetAssertionResult", stateMutability: "nonpayable", inputs: id32, outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "getAssertionResult", stateMutability: "view", inputs: id32, outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "getMinimumBond", stateMutability: "view", inputs: [{ name: "currency", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "defaultIdentifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "defaultCurrency", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "defaultLiveness", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "burnedBondPercentage", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "finder", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "event",
    name: "AssertionMade",
    anonymous: false,
    inputs: [
      { name: "assertionId", type: "bytes32", indexed: true },
      { name: "domainId", type: "bytes32", indexed: false },
      { name: "claim", type: "bytes", indexed: false },
      { name: "asserter", type: "address", indexed: true },
      { name: "callbackRecipient", type: "address", indexed: false },
      { name: "escalationManager", type: "address", indexed: false },
      { name: "caller", type: "address", indexed: false },
      { name: "expirationTime", type: "uint64", indexed: false },
      { name: "currency", type: "address", indexed: false },
      { name: "bond", type: "uint256", indexed: false },
      { name: "identifier", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AssertionDisputed",
    anonymous: false,
    inputs: [
      { name: "assertionId", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "disputer", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AssertionSettled",
    anonymous: false,
    inputs: [
      { name: "assertionId", type: "bytes32", indexed: true },
      { name: "bondRecipient", type: "address", indexed: true },
      { name: "disputed", type: "bool", indexed: false },
      { name: "settlementResolution", type: "bool", indexed: false },
      { name: "settleCaller", type: "address", indexed: false },
    ],
  },
] as const;

/** UMA's Finder and IdentifierWhitelist, as the factory resolves the live whitelist through them. */
const umaRegistryAbi = [
  { type: "function", name: "getImplementationAddress", stateMutability: "view", inputs: [{ name: "interfaceName", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isIdentifierSupported", stateMutability: "view", inputs: [{ name: "identifier", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as const;

let ooCache: ContractCodec | null = null;
let erc20Cache: ContractCodec | null = null;
let registryCache: ContractCodec | null = null;

/** Codec for the Optimistic Oracle V3 fragment. */
export function optimisticOracleCodec(): ContractCodec {
  return (ooCache ??= new ContractCodec(optimisticOracleV3Abi as unknown as Abi));
}

/** Codec for ERC-20 (USDC's approve, allowance, balanceOf, decimals). */
export function erc20Codec(): ContractCodec {
  return (erc20Cache ??= new ContractCodec(erc20Abi as unknown as Abi));
}

function registryCodec(): ContractCodec {
  return (registryCache ??= new ContractCodec(umaRegistryAbi as unknown as Abi));
}

// ---------------------------------------------------------------------------------------------
// Shared plumbing: batched reads, formatting, times
// ---------------------------------------------------------------------------------------------

/** True for the all-zero bytes32 the contracts use as "none". */
export const isZero32 = (h: Hex | null | undefined) => !h || BigInt(h) === 0n;

/** One read for {@link readMany}. */
export interface ContractRead {
  readonly to: Address;
  readonly codec: ContractCodec;
  readonly fn: string;
  readonly args?: readonly unknown[];
}

/** A read that reverted, with its decoded reason. */
export class ReadError extends Error {
  override readonly name = "ReadError";
  constructor(
    readonly read: { to: Address; fn: string },
    readonly decoded: DecodedError,
  ) {
    super(`${read.fn} on ${read.to} reverted: ${decoded.toString()}`);
  }
}

/**
 * Several reads in as few eth_calls as the node allows (Chain.batch), decoded. A read that reverts
 * throws ReadError, or comes back `undefined` with `allowFailure`.
 */
export async function readMany(ctx: BazaarContext, reads: readonly ContractRead[], opts: { allowFailure?: boolean } = {}): Promise<unknown[]> {
  const res = await ctx.chain.batch(reads.map((r) => ({ to: r.to, data: r.codec.encode(r.fn, ...(r.args ?? [])) })));
  return res.map(([ok, data], i) => {
    const r = reads[i]!;
    if (!ok) {
      if (opts.allowFailure) return undefined;
      throw new ReadError({ to: r.to, fn: r.fn }, decodeError(data));
    }
    return r.codec.decode(r.fn, data);
  });
}

/** One read. */
export async function readOne<T>(ctx: BazaarContext, to: Address, codec: ContractCodec, fn: string, ...args: readonly unknown[]): Promise<T> {
  return (await readMany(ctx, [{ to, codec, fn, args }]))[0] as T;
}

/** The latest block's timestamp: what the contracts' `block.timestamp` checks are judged against. */
export async function chainNow(ctx: BazaarContext): Promise<number> {
  return (await ctx.chain.block("latest")).timestamp;
}

const withCommas = (s: string) => {
  const [w, f] = s.split(".");
  const ww = w!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f ? `${ww}.${f}` : ww;
};

// Amounts are printed exactly (every significant decimal): these texts name costs, balances and
// limits, and a rounded figure would show a cost smaller (or a limit larger) than it is.

/** USDC units (6 decimals) as "1,000 USDC", exactly ("1,000.009999 USDC"). */
export function usdcText(units: bigint): string {
  return `${withCommas(formatDecimal(units, 6))} USDC`;
}

/** Insurance shares (18 decimals) as "1,234.5678 shares", exactly. */
export function sharesText(shares: bigint): string {
  return `${withCommas(formatDecimal(shares, 18))} shares`;
}

/** ETH in wei as "0.000001 ETH", exactly (7 wei is "0.000000000000000007 ETH"). */
export function ethText(wei: bigint): string {
  return `${formatDecimal(wei, 18)} ETH`;
}

/** The last second a JavaScript Date can show (8.64e15 ms after 1970). */
const MAX_DATE_SECONDS = 8_640_000_000_000;

/**
 * A unix time (seconds) as "2026-11-08 14:00:00 UTC". Contract times are uint256s whose sentinels
 * (uint64 or uint256 max) lie past any date: those read "a time beyond any calendar date".
 */
export function timeText(ts: number | bigint): string {
  const n = typeof ts === "bigint" ? (ts > BigInt(MAX_DATE_SECONDS) || ts < -BigInt(MAX_DATE_SECONDS) ? Number.NaN : Number(ts)) : ts;
  if (!Number.isFinite(n) || Math.abs(n) > MAX_DATE_SECONDS) return "a time beyond any calendar date";
  return new Date(Math.floor(n) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/** A duration in seconds as "12 hours", "14 days", "7 seconds". */
export function durationText(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [n, name] of units) {
    if (seconds >= n && seconds % n === 0) {
      const k = seconds / n;
      return `${k} ${name}${k === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** A bytes32 field the caller typed, checked. */
export function asBytes32(field: string, value: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new InputError(field, "must be a 32-byte id: 0x followed by 64 hex characters");
  }
  return value.toLowerCase() as Hex;
}

/** An address the caller typed, checked and checksummed. */
export function asAddress(field: string, value: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new InputError(field, "is not a valid address");
  }
}

// ---------------------------------------------------------------------------------------------
// Costs and bond approvals
// ---------------------------------------------------------------------------------------------

/** What a cost is: a bond (returned or forfeited by a verdict), an insurance seed, an ETH fee, a levy on shares, or shares locked. */
export type CostKind = "bond" | "seed" | "fee" | "levy" | "lock";

/** One thing a call costs or puts at risk, for a confirmation screen. */
export interface Cost {
  readonly kind: CostKind;
  /** What it is, in a trader's words. */
  readonly label: string;
  /**
   * The amount in `unit`'s own precision: USDC 6 decimals, ETH in wei, insurance shares 18 decimals,
   * and for "token" the units of the ERC-20 named by `token` (`decimals` of them per whole token).
   */
  readonly amount: bigint;
  /** "token" is an ERC-20 other than USDC (a bond posted in another currency): see `token` and `decimals`. */
  readonly unit: "USDC" | "ETH" | "shares" | "token";
  /** The ERC-20 it is paid in (null for ETH and shares). */
  readonly token: Address | null;
  /** For unit "token": the token's decimals. */
  readonly decimals?: number;
  /** Who takes or holds it: the contract pulling a bond, the OO holding it, the pair. Null when nothing moves now. */
  readonly payee: Address | null;
  /** When and how it comes back, if ever. */
  readonly returned: string;
  /** True when this is a worst case that depends on what happens later (a levy that depends on a verdict). */
  readonly contingent: boolean;
}

/**
 * A prepared write that posts a bond, moves money or locks shares, with what it costs. It is a
 * {@link PreparedCall} (simulate and send it as one) plus:
 * - `costs`: every bond, seed, fee, levy and lock, with when it comes back;
 * - `approvals`: ERC-20 approvals to send first (empty when the allowance already covers it); the
 *   SDK never assumes an approval exists;
 * - `requires`: preconditions in words (balances, allowances, timing) the UI should show;
 * - `notes`: what will happen, and warnings.
 */
export interface CostedCall extends PreparedCall {
  readonly costs: readonly Cost[];
  readonly approvals: readonly PreparedCall[];
  readonly requires: readonly string[];
  readonly notes: readonly string[];
}

/** A bond or seed an ERC-20 `transferFrom` will pull from the caller. */
export interface TokenPull {
  readonly token: Address;
  /** The contract that calls transferFrom. */
  readonly spender: Address;
  /** For the approval's summary, e.g. "the Bazaar terminator". */
  readonly spenderName: string;
  /** Token units (USDC: 6 decimals). */
  readonly amount: bigint;
  /** For the approval's summary, e.g. "the termination bond". */
  readonly purpose: string;
}

async function tokenDecimals(ctx: BazaarContext, token: Address): Promise<number> {
  if (token === ctx.usdc) return 6;
  try {
    return Number(await readOne<number>(ctx, token, erc20Codec(), "decimals"));
  } catch {
    return 18;
  }
}

/** A token amount as text, exactly: USDC as "1,000 USDC". */
async function formatToken(ctx: BazaarContext, token: Address, amount: bigint): Promise<string> {
  if (token === ctx.usdc) return usdcText(amount);
  return `${withCommas(formatDecimal(amount, await tokenDecimals(ctx, token)))} tokens of ${token}`;
}

/** An allowance this large reads as unlimited (the usual "approve max" is 2^256 - 1). */
const UNLIMITED_ALLOWANCE = 1n << 255n;

/** The least bond any Bazaar assertion posts (USDC units): the listing and termination floors; an identifier upgrade's is 5,000 USDC. */
export const MIN_ASSERTION_BOND_USDC = 1_000n * 10n ** 6n;

/**
 * A bond quote read from the chain that cannot be right: below the floor the contract itself
 * enforces (an RPC answering 0, say). Nothing is built on it, because the contract pulls the real
 * bond when the call runs, and an approval sized to the quote would be wrong.
 */
export class BondQuoteError extends Error {
  override readonly name = "BondQuoteError";
}

/** Throws {@link BondQuoteError} when `quoted` (USDC units) is below `floor`, the contract's own minimum for `what`. */
export function requireBondFloor(what: string, quoted: bigint, floor: bigint): void {
  if (quoted < floor) {
    throw new BondQuoteError(
      `The node reports ${what} of ${usdcText(quoted)}, below the ${usdcText(floor)} the contract always charges: that answer cannot be right, so nothing was built. Check the RPC connection and try again.`,
    );
  }
}

/** An ERC-20 approve as a PreparedCall. `amount` is in the token's units. */
export function approveCall(token: Address, spender: Address, amount: bigint, from: Address | null, summary: string): PreparedCall {
  return { action: "approve", to: token, data: erc20Codec().encode("approve", spender, amount), value: 0n, from, summary };
}

/**
 * The approvals `owner` must send before a call that pulls `pulls`, and what to tell them.
 *
 * Reads the current allowance and balance; an approval is returned whenever the allowance is short
 * (for exactly the amount, never unlimited), and a shortfall in balance becomes a `requires` line
 * rather than an error, since the user may top up before sending. An allowance already larger than
 * the amount needs no approval, but it does not bound what the spender takes either (the contract
 * pulls what it charges when the call runs): each such case is returned in `warnings`, for the
 * call's notes.
 */
export async function bondApprovals(
  ctx: BazaarContext,
  owner: Address,
  pulls: readonly TokenPull[],
): Promise<{ approvals: PreparedCall[]; requires: string[]; warnings: string[] }> {
  const e = erc20Codec();
  const byKey = new Map<string, TokenPull>();
  for (const p of pulls) {
    const k = `${p.token}:${p.spender}`;
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, amount: prev.amount + p.amount, purpose: `${prev.purpose} and ${p.purpose}` } : p);
  }
  const merged = [...byKey.values()];
  const tokens = [...new Set(merged.map((p) => p.token))];
  const reads: ContractRead[] = [
    ...merged.map((p) => ({ to: p.token, codec: e, fn: "allowance", args: [owner, p.spender] })),
    ...tokens.map((t) => ({ to: t, codec: e, fn: "balanceOf", args: [owner] })),
  ];
  const res = await readMany(ctx, reads, { allowFailure: true });
  const approvals: PreparedCall[] = [];
  const requires: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const p = merged[i]!;
    const allowance = res[i] as bigint | undefined;
    const amt = await formatToken(ctx, p.token, p.amount);
    if (allowance === undefined || allowance < p.amount) {
      approvals.push(approveCall(p.token, p.spender, p.amount, owner, `Allow ${p.spenderName} to take ${amt} for ${p.purpose}`));
      requires.push(`An allowance of ${amt} for ${p.spenderName} (${p.spender}): send the approval first.`);
    } else if (allowance > p.amount) {
      const has = allowance >= UNLIMITED_ALLOWANCE ? "an unlimited amount" : await formatToken(ctx, p.token, allowance);
      warnings.push(
        `Warning: this wallet already lets ${p.spenderName} (${p.spender}) take up to ${has}, more than the ${amt} quoted for ${p.purpose}. The contract takes what it charges when the call runs, up to that allowance; to cap it at the quote, first approve exactly ${amt}.`,
      );
    }
  }
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]!;
    const bal = res[merged.length + j] as bigint | undefined;
    const need = merged.filter((p) => p.token === t).reduce((s, p) => s + p.amount, 0n);
    if (bal !== undefined && bal < need) {
      requires.push(`A balance of at least ${await formatToken(ctx, t, need)}: this wallet holds ${await formatToken(ctx, t, bal)}.`);
    }
  }
  return { approvals, requires, warnings };
}

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** "ASSERT_TRUTH2" -> its bytes32 (ASCII, right-padded with zeros), as UMA stores identifiers. */
export function identifierFromText(text: string): Hex {
  if (!/^[\x20-\x7e]{1,32}$/.test(text)) throw new InputError("identifier", "must be 1 to 32 printable ASCII characters");
  return stringToHex(text, { size: 32 }).toLowerCase() as Hex;
}

/** A bytes32 identifier as its ASCII text ("ASSERT_TRUTH2"), or null when it is not printable ASCII. */
export function identifierText(id: Hex): string | null {
  const trimmed = id.replace(/(00)+$/, "");
  if (trimmed === "0x") return null;
  const s = hexToString(trimmed as Hex);
  return /^[\x20-\x7e]+$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------
// Which oracle
// ---------------------------------------------------------------------------------------------

/** Where an assertion was made: the factory (listings, identifier upgrades) or the terminator (termination claims). */
export type AssertionHome = "factory" | "terminator";

/** The deployment's Optimistic Oracle: `factory.oo()`, immutable. */
export async function optimisticOracle(ctx: BazaarContext): Promise<Address> {
  return getAddress(await readOne<Address>(ctx, ctx.factory, factoryCodec(), "oo"));
}

/**
 * The oracle `assertionId` was made on: `factory.assertionOo(id)` or `terminator.assertionOo(id)`,
 * falling back to `factory.oo()` when the record is empty (an id neither contract made).
 */
export async function assertionOracle(ctx: BazaarContext, assertionId: Hex, home: AssertionHome): Promise<Address> {
  const recorded =
    home === "factory"
      ? await readOne<Address>(ctx, ctx.factory, factoryCodec(), "assertionOo", assertionId)
      : await readOne<Address>(ctx, ctx.terminator, terminatorCodec(), "assertionOo", assertionId);
  return recorded === ZERO_ADDRESS ? optimisticOracle(ctx) : getAddress(recorded);
}

/**
 * The oracle to act on for `assertionId`: the one it was made on ({@link assertionOracle}) or, when
 * the caller passes `override`, that address provided it is one of Bazaar's: `factory.oo()`, or the
 * oracle the factory or the terminator recorded for this assertion (`assertionOo(id)`). Any other
 * override is refused: it would be the call's target and, for a dispute, the bond's spender.
 */
async function oracleFor(ctx: BazaarContext, assertionId: Hex, home: AssertionHome, override: Address | undefined): Promise<Address> {
  if (override === undefined) return assertionOracle(ctx, assertionId, home);
  const want = asAddress("oo", override);
  const known = await readMany(
    ctx,
    [
      { to: ctx.factory, codec: factoryCodec(), fn: "oo" },
      { to: ctx.factory, codec: factoryCodec(), fn: "assertionOo", args: [assertionId] },
      { to: ctx.terminator, codec: terminatorCodec(), fn: "assertionOo", args: [assertionId] },
    ],
    { allowFailure: true },
  );
  if (known.some((a) => typeof a === "string" && a !== ZERO_ADDRESS && getAddress(a) === want)) return want;
  throw new InputError(
    "oo",
    "is neither Bazaar's Optimistic Oracle (factory.oo()) nor the oracle this assertion was recorded on: leave it out and the SDK finds the right oracle.",
  );
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

/** An OOv3 assertion record. Times are unix seconds. */
export interface UmaAssertion {
  readonly assertionId: Hex;
  readonly oo: Address;
  readonly asserter: Address;
  readonly assertionTime: number;
  readonly settled: boolean;
  /** The bond currency (USDC for every Bazaar assertion). */
  readonly currency: Address;
  /** From this instant OOv3 refuses disputes and an undisputed assertion may be settled (true). */
  readonly expirationTime: number;
  /** The verdict, meaningful only once `settled`. */
  readonly settlementResolution: boolean;
  readonly domainId: Hex;
  readonly identifier: Hex;
  /** The bond, in the currency's units (USDC: 6 decimals). */
  readonly bond: bigint;
  readonly callbackRecipient: Address;
  /** Null while undisputed. */
  readonly disputer: Address | null;
  readonly escalationManager: Address | null;
}

/**
 * Where an assertion stands, for a UI:
 * - `liveness`: undisputed and inside its liveness; disputable until `expirationTime`, settleable from it;
 * - `settleable`: undisputed and past its liveness: it can only resolve true, and anyone may settle it now;
 * - `disputed`: waiting on UMA's DVM vote; it settles once the DVM has ruled, which this view cannot see;
 * - `settledTrue` / `settledFalse`: resolved;
 * - `notFound`: no such assertion on this oracle.
 */
export type AssertionPhase = "notFound" | "liveness" | "settleable" | "disputed" | "settledTrue" | "settledFalse";

export interface AssertionStatus {
  readonly phase: AssertionPhase;
  readonly assertion: UmaAssertion | null;
  /** When it can be settled: `expirationTime` while in liveness, now when settleable, null when disputed or resolved. */
  readonly canSettleAt: number | null;
  /** The last second a dispute is accepted (OOv3 requires `expirationTime > now`), null when it no longer can be. */
  readonly disputableUntil: number | null;
  /** The chain time this status was judged at. */
  readonly now: number;
}

/** Text for each assertion phase. */
export const ASSERTION_PHASE_TEXT: Readonly<Record<AssertionPhase, string>> = {
  notFound: "No such assertion on UMA's oracle.",
  liveness: "In UMA's liveness window: anyone may dispute it until the window ends; undisputed, it is accepted then.",
  settleable: "UMA's liveness has ended without a dispute: it can only be accepted, and anyone may settle it now.",
  disputed: "Disputed: UMA's voters (the DVM) decide it, which takes days. It can be settled once they have ruled.",
  settledTrue: "Settled: UMA accepted the claim.",
  settledFalse: "Settled: UMA rejected the claim.",
};

function toAssertion(id: Hex, oo: Address, raw: Record<string, unknown>): UmaAssertion | null {
  const asserter = raw.asserter as Address;
  if (asserter === ZERO_ADDRESS) return null;
  const em = raw.escalationManagerSettings as { escalationManager: Address };
  const disputer = raw.disputer as Address;
  return {
    assertionId: id,
    oo,
    asserter: getAddress(asserter),
    assertionTime: Number(raw.assertionTime),
    settled: raw.settled as boolean,
    currency: getAddress(raw.currency as Address),
    expirationTime: Number(raw.expirationTime),
    settlementResolution: raw.settlementResolution as boolean,
    domainId: raw.domainId as Hex,
    identifier: raw.identifier as Hex,
    bond: raw.bond as bigint,
    callbackRecipient: getAddress(raw.callbackRecipient as Address),
    disputer: disputer === ZERO_ADDRESS ? null : getAddress(disputer),
    escalationManager: em.escalationManager === ZERO_ADDRESS ? null : getAddress(em.escalationManager),
  };
}

/** The assertion record on `oo`, or null for an unknown id (OOv3 returns an all-zero record). */
export async function getAssertion(ctx: BazaarContext, oo: Address, assertionId: Hex): Promise<UmaAssertion | null> {
  const raw = await readOne<Record<string, unknown>>(ctx, oo, optimisticOracleCodec(), "getAssertion", assertionId);
  return toAssertion(assertionId, oo, raw);
}

/** The phase of an assertion at chain time `now`. */
export function assertionPhase(a: UmaAssertion | null, now: number): AssertionPhase {
  if (!a) return "notFound";
  if (a.settled) return a.settlementResolution ? "settledTrue" : "settledFalse";
  if (a.disputer) return "disputed";
  return now < a.expirationTime ? "liveness" : "settleable";
}

/** The status of an assertion judged at `now`. */
export function statusOf(a: UmaAssertion | null, now: number): AssertionStatus {
  const phase = assertionPhase(a, now);
  return {
    phase,
    assertion: a,
    canSettleAt: phase === "liveness" ? a!.expirationTime : phase === "settleable" ? now : null,
    disputableUntil: phase === "liveness" ? a!.expirationTime - 1 : null,
    now,
  };
}

/**
 * Where an assertion stands: pending its liveness (with the time it can settle), settleable,
 * disputed (waiting on the DVM), or settled true or false. `home` says which Bazaar contract made
 * it, which names the oracle it lives on. An `oo` passed is used only if it is `factory.oo()` or
 * the oracle recorded for this assertion; any other is refused (InputError on "oo").
 */
export async function assertionStatus(
  ctx: BazaarContext,
  assertionId: Hex,
  opts: { home?: AssertionHome; oo?: Address } = {},
): Promise<AssertionStatus> {
  const id = asBytes32("assertionId", assertionId);
  const oo = await oracleFor(ctx, id, opts.home ?? "factory", opts.oo);
  const [a, now] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx)]);
  return statusOf(a, now);
}

/** The smallest bond OOv3 accepts in `currency` (USDC by default), in its units; 0 when OOv3 has never cached it. */
export async function getMinimumBond(ctx: BazaarContext, opts: { currency?: Address; oo?: Address } = {}): Promise<bigint> {
  const oo = opts.oo ?? (await optimisticOracle(ctx));
  return readOne<bigint>(ctx, oo, optimisticOracleCodec(), "getMinimumBond", opts.currency ?? ctx.usdc);
}

/** OOv3's default identifier. On the live OOv3 this is `ASSERT_TRUTH`, which UMA has de-whitelisted: Bazaar uses its own governed `umaIdentifier`. */
export async function defaultIdentifier(ctx: BazaarContext, opts: { oo?: Address } = {}): Promise<Hex> {
  const oo = opts.oo ?? (await optimisticOracle(ctx));
  return readOne<Hex>(ctx, oo, optimisticOracleCodec(), "defaultIdentifier");
}

/** The share of a disputed bond UMA burns as its fee, 1e18 = 100% (50% on the live OOv3), or null if the oracle does not report it. */
export async function burnedBondPercentage(ctx: BazaarContext, opts: { oo?: Address } = {}): Promise<bigint | null> {
  const oo = opts.oo ?? (await optimisticOracle(ctx));
  const [v] = await readMany(ctx, [{ to: oo, codec: optimisticOracleCodec(), fn: "burnedBondPercentage" }], { allowFailure: true });
  return (v as bigint | undefined) ?? null;
}

/**
 * Whether `identifier` is on UMA's live IdentifierWhitelist, resolved as the factory and OOv3 resolve
 * it: oracle -> finder -> IdentifierWhitelist -> isIdentifierSupported. Null when any hop fails to
 * answer (the factory then treats it as not whitelisted for its gates, and as not removed for the
 * paths a removal unlocks).
 */
export async function identifierWhitelisted(ctx: BazaarContext, identifier: Hex, opts: { oo?: Address } = {}): Promise<boolean | null> {
  try {
    const oo = opts.oo ?? (await optimisticOracle(ctx));
    const rc = registryCodec();
    const finder = await readOne<Address>(ctx, oo, optimisticOracleCodec(), "finder");
    const whitelist = await readOne<Address>(ctx, finder, rc, "getImplementationAddress", identifierFromText("IdentifierWhitelist"));
    return await readOne<boolean>(ctx, whitelist, rc, "isIdentifierSupported", identifier);
  } catch {
    return null;
  }
}

/** What settling an assertion would do right now. */
export interface SettlementPreview {
  /** True when a settle would go through now. */
  readonly settleable: boolean;
  /** The verdict a settle would apply (true = the claim is accepted), or null when it cannot settle yet. */
  readonly result: boolean | null;
  /** Why it cannot settle, decoded (a disputed assertion the DVM has not ruled on reverts in UMA's oracle). */
  readonly error: DecodedError | null;
}

/**
 * Simulate OOv3's `settleAndGetAssertionResult(assertionId)` without sending it. For a disputed
 * assertion this is the one way to see whether UMA's DVM has ruled, and how, before anyone records
 * the verdict on chain: Bazaar's own views read a disputed claim as pending until it is settled.
 * The simulation runs the Bazaar callback too, so a callback that would revert shows up here.
 * An `oo` passed is used only if it is `factory.oo()` or the oracle recorded for this assertion.
 */
export async function previewSettlement(
  ctx: BazaarContext,
  assertionId: Hex,
  opts: { home?: AssertionHome; oo?: Address; from?: Address } = {},
): Promise<SettlementPreview> {
  const id = asBytes32("assertionId", assertionId);
  const oo = await oracleFor(ctx, id, opts.home ?? "factory", opts.oo);
  return previewSettlementOn(ctx, oo, id, opts.from);
}

/**
 * {@link previewSettlement} on an oracle the caller already resolved with {@link assertionOracle}
 * (no check of `oo`, so never pass one a user gave).
 * @internal
 */
export async function previewSettlementOn(ctx: BazaarContext, oo: Address, id: Hex, from?: Address): Promise<SettlementPreview> {
  const oc = optimisticOracleCodec();
  try {
    const ret = await ctx.chain.call(oo, oc.encode("settleAndGetAssertionResult", id), { from: from ?? null });
    return { settleable: true, result: oc.decode<boolean>("settleAndGetAssertionResult", ret), error: null };
  } catch (e) {
    const rpc = toRpcError(e);
    if (!rpc) throw e;
    return { settleable: false, result: null, error: decodeError(rpc.revertData) };
  }
}

/** Decode an OOv3 log (AssertionMade, AssertionDisputed, AssertionSettled), or null for another contract's. */
export function decodeAssertionLog(log: RawLog): DecodedLog | null {
  return optimisticOracleCodec().decodeLog(log);
}

/** What each OOv3 event means, for an activity feed. */
export const ASSERTION_EVENT_TEXT: Readonly<Record<string, string>> = {
  AssertionMade: "A claim was posted to UMA with its bond; its liveness window started.",
  AssertionDisputed: "Someone disputed the claim and matched its bond; UMA's voters will decide it.",
  AssertionSettled: "The claim was settled: the bond went to the winning side and Bazaar applied the verdict.",
};

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/**
 * Dispute an assertion: you match its bond, and UMA's DVM votes on the claim.
 *
 * OOv3 pulls the bond (in the assertion's currency, USDC for Bazaar) from the caller with
 * `transferFrom`, so the bond needs an approval for the oracle first; it is returned in `approvals`
 * whenever the allowance is short. `disputer` (default: the caller) is who is paid if the dispute
 * wins: their bond back plus the asserter's, less the share UMA burns as its fee. A dispute that
 * loses forfeits the bond. Bazaar's contracts learn of the dispute through OOv3's callback: a listing
 * or identifier upgrade waits on the DVM, a termination claim's insurer vote keeps running.
 *
 * Refused up front: an unknown assertion, one already disputed or settled, and one past its liveness
 * (OOv3 accepts disputes only while `expirationTime > block.timestamp`); an `oo` that is neither
 * `factory.oo()` nor the oracle recorded for this assertion; and a USDC bond below the 1,000 USDC
 * every Bazaar claim posts (or a zero bond in another currency), which only a wrong node answer
 * produces ({@link BondQuoteError}).
 */
export async function disputeAssertion(
  ctx: BazaarContext,
  args: { assertionId: Hex; from: Address; disputer?: Address; home?: AssertionHome; oo?: Address },
): Promise<CostedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const from = asAddress("from", args.from);
  const disputer = args.disputer ? asAddress("disputer", args.disputer) : from;
  if (disputer === ZERO_ADDRESS) throw new InputError("disputer", "cannot be the zero address");
  const oo = await oracleFor(ctx, id, args.home ?? "factory", args.oo);
  const [a, now, burned] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx), burnedBondPercentage(ctx, { oo })]);
  const st = statusOf(a, now);
  if (!a) throw new InputError("assertionId", "UMA's oracle has no such assertion.");
  if (st.phase === "disputed") throw new InputError("assertionId", "This claim has already been disputed: UMA's voters are deciding it.");
  if (st.phase === "settledTrue" || st.phase === "settledFalse") throw new InputError("assertionId", "This claim is already settled.");
  if (st.phase === "settleable") {
    throw new InputError("assertionId", `UMA's dispute window closed at ${timeText(a.expirationTime)}: the claim can no longer be disputed.`);
  }
  const usdc = a.currency === ctx.usdc;
  if (usdc) requireBondFloor("this claim's dispute bond", a.bond, MIN_ASSERTION_BOND_USDC);
  else if (a.bond <= 0n) throw new BondQuoteError("The node reports a zero dispute bond for this claim: that answer cannot be right, so nothing was built. Check the RPC connection and try again.");
  const decimals = usdc ? 6 : await tokenDecimals(ctx, a.currency);
  const bondText = await formatToken(ctx, a.currency, a.bond);
  const won = burned === null ? null : a.bond * 2n - (a.bond * burned) / 10n ** 18n;
  const notes: string[] = [
    `You can dispute until ${timeText(a.expirationTime)}. UMA's voters then decide the claim, which takes days.`,
    won === null
      ? "If the dispute wins, the disputer receives both bonds less UMA's fee; if it loses, the bond is gone."
      : `If the dispute wins, ${disputer} receives ${await formatToken(ctx, a.currency, won)} (both bonds less UMA's fee); if it loses, the bond is gone.`,
  ];
  const live = await identifierWhitelisted(ctx, a.identifier, { oo });
  if (live === false) {
    notes.push(
      "Warning: this claim's identifier is no longer on UMA's whitelist, so UMA's voters can never rule on a dispute: the bond would stay locked in the oracle for good.",
    );
  }
  if (!usdc) {
    notes.push(`This claim's bond is posted in ${a.currency}, not USDC, so it is not a claim Bazaar made: check what you are disputing.`);
  }
  const { approvals, requires, warnings } = await bondApprovals(ctx, from, [
    { token: a.currency, spender: oo, spenderName: "UMA's Optimistic Oracle", amount: a.bond, purpose: "the dispute bond" },
  ]);
  notes.push(...warnings);
  return {
    action: "disputeAssertion",
    to: oo,
    data: optimisticOracleCodec().encode("disputeAssertion", id, disputer),
    value: 0n,
    from,
    summary: `Dispute UMA claim ${id.slice(0, 10)}…: posts a ${bondText} bond, lost if UMA's voters uphold the claim`,
    pullsUsdc: usdc ? a.bond * 10n ** 12n : undefined,
    costs: [
      {
        kind: "bond",
        label: "Dispute bond",
        amount: a.bond,
        unit: usdc ? "USDC" : "token",
        token: a.currency,
        ...(usdc ? {} : { decimals }),
        payee: oo,
        returned: "Returned with the asserter's bond (less UMA's fee) if UMA's voters reject the claim; forfeited if they uphold it.",
        contingent: false,
      },
    ],
    approvals,
    requires,
    notes,
  };
}

/**
 * Settle an assertion on the oracle directly. OOv3 pays the bond to the winning side, then calls
 * the Bazaar contract that made it, which applies the verdict (deploys or refunds a listing,
 * schedules or rejects a termination, queues an identifier upgrade). Bazaar's own settle functions
 * do the same through the contract; either works.
 *
 * Refused up front while the assertion is still in its liveness (OOv3 requires the liveness to have
 * ended), and once it is settled. A disputed assertion settles only after the DVM has ruled; until
 * then the call reverts, which this cannot see in advance. An `oo` passed is used only if it is
 * `factory.oo()` or the oracle recorded for this assertion.
 */
export async function settleAssertion(
  ctx: BazaarContext,
  args: { assertionId: Hex; from?: Address; home?: AssertionHome; oo?: Address; getResult?: boolean },
): Promise<PreparedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const oo = await oracleFor(ctx, id, args.home ?? "factory", args.oo);
  const [a, now] = await Promise.all([getAssertion(ctx, oo, id), chainNow(ctx)]);
  requireSettleable(statusOf(a, now), "assertionId");
  const fn = args.getResult ? "settleAndGetAssertionResult" : "settleAssertion";
  return {
    action: fn,
    to: oo,
    data: optimisticOracleCodec().encode(fn, id),
    value: 0n,
    from: args.from ? asAddress("from", args.from) : null,
    summary: `Settle UMA claim ${id.slice(0, 10)}…: pays the bond to the winning side and applies the verdict (no cost but gas)`,
  };
}

/** Throws the InputError a settle attempt deserves when the assertion cannot settle yet. */
export function requireSettleable(st: AssertionStatus, field: string): void {
  switch (st.phase) {
    case "notFound":
      throw new InputError(field, "UMA's oracle has no such assertion.");
    case "liveness":
      throw new InputError(field, `UMA's liveness window is still open: this can be settled from ${timeText(st.canSettleAt!)}.`);
    case "settledTrue":
    case "settledFalse":
      throw new InputError(field, "This claim is already settled.");
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Early settlement on a testnet's stand-in oracle
// ---------------------------------------------------------------------------------------------

/**
 * The owner-only override of the oracle a Bazaar testnet uses where UMA runs no OOv3
 * (`OwnedMockOptimisticOracleV3`, in the protocol repository's test/mocks), hand-written: it is a test
 * contract, not part of UMA's interface. UMA's own OOv3 has neither function, so on a mainnet
 * deployment {@link earlySettler} reports nobody and {@link settleEarly} refuses.
 */
export const EARLY_SETTLE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "mockForceSettle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assertionId", type: "bytes32" },
      { name: "result", type: "bool" },
    ],
    outputs: [],
  },
] as const;

let earlyCache: ContractCodec | null = null;

/** Codec for {@link EARLY_SETTLE_ABI}. */
export function earlySettleCodec(): ContractCodec {
  return (earlyCache ??= new ContractCodec(EARLY_SETTLE_ABI as unknown as Abi));
}

/**
 * Who can settle the deployment's claims before their liveness ends: the owner of a testnet's
 * stand-in oracle, or null when the oracle has no owner (UMA's own OOv3, on which nobody can).
 * `oo` defaults to `factory.oo()`.
 */
export async function earlySettler(ctx: BazaarContext, opts: { oo?: Address } = {}): Promise<Address | null> {
  const oo = opts.oo ?? (await optimisticOracle(ctx));
  const c = earlySettleCodec();
  const [res] = await ctx.chain.batch([{ to: oo, data: c.encode("owner") }]);
  const [ok, data] = res!;
  // An oracle without the function reverts, or answers empty data when it has a fallback.
  if (!ok || data.length < 66) return null;
  const owner = c.decode<Address>("owner", data);
  return owner === ZERO_ADDRESS ? null : getAddress(owner);
}

/**
 * Settle a claim now, without waiting for its liveness, with the verdict `result` (true, the default:
 * the claim is accepted). Only the owner of a testnet's stand-in oracle can send it
 * (`mockForceSettle`). The oracle pays out the bonds as UMA would for that verdict: an accepted
 * undisputed claim returns the proposer's bond, a disputed one pays both bonds to the side that wins,
 * and a rejected undisputed claim keeps the proposer's bond, with no disputer to receive it. Then it
 * calls the Bazaar contract that made the claim, which applies the verdict as after any settle:
 * deploys or refunds a listing, schedules or rejects a termination, queues or drops an identifier
 * upgrade. Costs only gas.
 *
 * Refused up front: an oracle with no owner (UMA's own OOv3, which has no early settlement), a `from`
 * that is not the owner, an unknown assertion, and one already settled. An `oo` passed is used only
 * if it is `factory.oo()` or the oracle recorded for this assertion.
 */
export async function settleEarly(
  ctx: BazaarContext,
  args: { assertionId: Hex; from: Address; result?: boolean; home?: AssertionHome; oo?: Address },
): Promise<CostedCall> {
  const id = asBytes32("assertionId", args.assertionId);
  const from = asAddress("from", args.from);
  const result = args.result ?? true;
  const oo = await oracleFor(ctx, id, args.home ?? "factory", args.oo);
  const [owner, a, now] = await Promise.all([earlySettler(ctx, { oo }), getAssertion(ctx, oo, id), chainNow(ctx)]);
  if (owner === null) throw new InputError("assertionId", "This deployment's oracle is UMA's own: a claim settles only once its liveness ends, and nobody can settle it early.");
  if (owner !== from) throw new InputError("from", `Only the oracle's owner, ${owner}, can settle a claim early.`);
  const st = statusOf(a, now);
  if (st.phase === "notFound") throw new InputError("assertionId", "UMA's oracle has no such assertion.");
  if (st.phase === "settledTrue" || st.phase === "settledFalse") throw new InputError("assertionId", "This claim is already settled.");
  const notes: string[] = [];
  if (st.phase === "liveness") {
    notes.push(`Its dispute window closes ${timeText(a!.expirationTime)}: settling now ends it at once, and nobody can dispute the claim after that.`);
    notes.push(result ? "Accepted, the proposer gets their bond back." : "Rejected undisputed, the proposer's bond stays in the oracle: there is no disputer to receive it.");
  } else if (st.phase === "disputed") {
    notes.push(`Disputed: this decides it in place of UMA's voters, and ${result ? "the proposer" : "the disputer"} receives both bonds.`);
  } else if (result) {
    notes.push("Its liveness has already ended: an ordinary settle, which anyone can send, accepts it the same way.");
  } else {
    notes.push("Its liveness has ended undisputed, so an ordinary settle would accept it: this rejects it instead, and the proposer's bond stays in the oracle.");
  }
  return {
    action: "mockForceSettle",
    to: oo,
    data: earlySettleCodec().encode("mockForceSettle", id, result),
    value: 0n,
    from,
    summary: `Settle UMA claim ${id.slice(0, 10)}… now, ${result ? "accepted" : "rejected"}, without waiting for its liveness (no cost but gas)`,
    costs: [],
    approvals: [],
    requires: [],
    notes,
  };
}
