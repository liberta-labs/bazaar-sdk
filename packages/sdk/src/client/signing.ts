/**
 * EIP-712 for Bazaar's gasless calls: the typed data of the eight relayable actions, the domain each
 * pair signs under, nonces, deadlines, relayer fees, signing through an EIP-1193 wallet, and the
 * calldata each action is submitted with.
 *
 * Every pair is its own domain: `EIP712Domain(string name,string version,uint256 chainId,address
 * verifyingContract)` with name "BazaarPair", version "1", the chain id and the pair's address. The
 * primary types are exactly MetaTxLib's (docs/protocol/meta-transactions.md "Type strings"):
 * `CreateOrder` lists its fields in its own order rather than the struct's, signs `orderType` and
 * `tif` as uint8 and `expirationBlock` as uint256; `CancelOrders` and `AmendOrders` hash their
 * arrays as EIP-712 hashes an array. The pair verifies with plain ECDSA (OpenZeppelin
 * `ECDSA.recover`), so only an EOA's signature is accepted: a smart account trades by sending its
 * calls directly (batching.ts).
 *
 * The rules a signature must meet when it lands (MetaTxLib.verifyAndConsume):
 * - `nonce` is the signer's current `metaTxNonces` on that pair, strictly sequential: one nonce, one
 *   landed call, whatever the action.
 * - `deadline` has not passed and is at most {@link MAX_DEADLINE_WINDOW} (10 s) past the block's
 *   timestamp, so a signature cannot be warehoused. The SDK stamps it from the lower of chain time
 *   and the device's clock, and refuses when the two disagree by more than 2 minutes (an RPC
 *   reporting a future block must not stretch a deadline); the user has those seconds to approve
 *   the signature and the relayer to land it.
 * - `relayerFee` is at most {@link MAX_RELAYER_FEE} ($1, BAZAAR precision) and is charged at its USDC
 *   floor; the SDK floors it before signing so the signed fee is the fee charged.
 */

import {
  type Address,
  type Hex,
  bytesToHex,
  getAddress,
  hashDomain,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from "viem";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import { type Transport, toRpcError } from "../chain/rpc.js";
import { BAZAAR_SCALE, USDC_TO_BAZAAR } from "../constants.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { type MatchHints, NO_HINTS, type OrderSpec } from "./orders.js";

export const BAZAAR_DOMAIN_NAME = "BazaarPair";
export const BAZAAR_DOMAIN_VERSION = "1";
/** MetaTxLib.MAX_RELAYER_FEE: $1 per action, BAZAAR precision. */
export const MAX_RELAYER_FEE = BAZAAR_SCALE;
/** MetaTxLib.MAX_DEADLINE_WINDOW: a deadline at most this many seconds past the block's timestamp. */
export const MAX_DEADLINE_WINDOW = 10;

export const EIP712_DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** The primary types, verbatim from MetaTxLib (whose hashes lens.getTypehashes returns). */
export const TYPE_STRINGS = {
  DepositCollateral: "DepositCollateral(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  WithdrawCollateral: "WithdrawCollateral(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  DepositToInsurance: "DepositToInsurance(uint256 amount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  RequestInsuranceWithdrawal: "RequestInsuranceWithdrawal(uint256 shareAmount,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  ExecuteInsuranceWithdrawal: "ExecuteInsuranceWithdrawal(uint256 nonce,uint256 deadline,uint256 relayerFee)",
  CreateOrder:
    "CreateOrder(uint8 orderType,uint256 triggerPrice,uint256 limitPrice,uint256 maxSlippageBp,uint256 size,bool isLong,bool isPostOnly,uint8 tif,uint256 expirationBlock,address integrator,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  CancelOrders: "CancelOrders(uint256[] orderIds,uint256 nonce,uint256 deadline,uint256 relayerFee)",
  AmendOrders: "AmendOrders(uint256[] amends,uint256 nonce,uint256 deadline,uint256 relayerFee)",
} as const;
export type PrimaryType = keyof typeof TYPE_STRINGS;

const u256 = (name: string) => ({ name, type: "uint256" }) as const;
const META = [u256("nonce"), u256("deadline"), u256("relayerFee")] as const;

export const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The same types as viem / eth_signTypedData_v4 field lists; they encode to {@link TYPE_STRINGS}. */
export const BAZAAR_TYPES = {
  DepositCollateral: [u256("amount"), ...META],
  WithdrawCollateral: [u256("amount"), ...META],
  DepositToInsurance: [u256("amount"), ...META],
  RequestInsuranceWithdrawal: [u256("shareAmount"), ...META],
  ExecuteInsuranceWithdrawal: [...META],
  CreateOrder: [
    { name: "orderType", type: "uint8" },
    u256("triggerPrice"),
    u256("limitPrice"),
    u256("maxSlippageBp"),
    u256("size"),
    { name: "isLong", type: "bool" },
    { name: "isPostOnly", type: "bool" },
    { name: "tif", type: "uint8" },
    u256("expirationBlock"),
    { name: "integrator", type: "address" },
    ...META,
  ],
  CancelOrders: [{ name: "orderIds", type: "uint256[]" }, ...META],
  AmendOrders: [{ name: "amends", type: "uint256[]" }, ...META],
} as const satisfies Record<PrimaryType, readonly { name: string; type: string }[]>;

/** The pair functions that take a signature. `claimFees` has no relayed form. */
export const RELAYED_ACTIONS = [
  "depositCollateral",
  "withdrawCollateral",
  "depositToInsurance",
  "requestInsuranceWithdrawal",
  "executeInsuranceWithdrawal",
  "createOrder",
  "cancelOrders",
  "amendOrders",
] as const;
export type RelayedAction = (typeof RELAYED_ACTIONS)[number];

export const PRIMARY_TYPE: Readonly<Record<RelayedAction, PrimaryType>> = {
  depositCollateral: "DepositCollateral",
  withdrawCollateral: "WithdrawCollateral",
  depositToInsurance: "DepositToInsurance",
  requestInsuranceWithdrawal: "RequestInsuranceWithdrawal",
  executeInsuranceWithdrawal: "ExecuteInsuranceWithdrawal",
  createOrder: "CreateOrder",
  cancelOrders: "CancelOrders",
  amendOrders: "AmendOrders",
};

/**
 * What each action signs besides (nonce, deadline, relayerFee): its own arguments. Amounts are
 * BAZAAR precision; `amends` is the flat word-triple array (orders.ts `encodeAmends`).
 */
export type SignedFields =
  | { readonly action: "depositCollateral"; readonly amount: bigint }
  | { readonly action: "withdrawCollateral"; readonly amount: bigint }
  | { readonly action: "depositToInsurance"; readonly amount: bigint }
  | { readonly action: "requestInsuranceWithdrawal"; readonly shareAmount: bigint }
  | { readonly action: "executeInsuranceWithdrawal" }
  | { readonly action: "createOrder"; readonly spec: OrderSpec }
  | { readonly action: "cancelOrders"; readonly orderIds: readonly bigint[] }
  | { readonly action: "amendOrders"; readonly amends: readonly bigint[] };

export interface MetaFields {
  /** The signer's metaTxNonces on the pair. */
  readonly nonce: bigint;
  /** Unix seconds; at most 10 s past the landing block's timestamp. */
  readonly deadline: number;
  /** BAZAAR precision, at most $1, a multiple of 1e12 (see {@link floorRelayerFee}). */
  readonly relayerFee: bigint;
}

/** The (nonce, deadline, relayerFee, signature, permitData) tail of a pair call; all zero/empty for a direct call. */
export interface MetaArgs {
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly relayerFee: bigint;
  readonly signature: Hex;
  readonly permitData: Hex;
}

export const DIRECT_META: MetaArgs = { nonce: 0n, deadline: 0n, relayerFee: 0n, signature: "0x", permitData: "0x" };

export interface TypedDataDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

/** Typed data as eth_signTypedData_v4 and viem take it. */
export interface PairTypedData {
  readonly domain: TypedDataDomain;
  readonly types: { readonly EIP712Domain: typeof EIP712_DOMAIN_FIELDS } & Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: PrimaryType;
  readonly message: Readonly<Record<string, unknown>>;
}

/** The pair's EIP-712 domain. */
export function pairDomain(chainId: number, pair: Address): TypedDataDomain {
  return { name: BAZAAR_DOMAIN_NAME, version: BAZAAR_DOMAIN_VERSION, chainId, verifyingContract: getAddress(pair) };
}

/** What `pair.DOMAIN_SEPARATOR()` should equal. */
export function domainSeparator(chainId: number, pair: Address): Hex {
  return hashDomain({ domain: pairDomain(chainId, pair), types: { EIP712Domain: EIP712_DOMAIN_FIELDS } } as unknown as Parameters<typeof hashDomain>[0]);
}

/** keccak256 of the primary type's string: what lens.getTypehashes reports for it. */
export function typeHash(primaryType: PrimaryType): Hex {
  return keccak256(toBytes(TYPE_STRINGS[primaryType]));
}

function message(fields: SignedFields, meta: MetaFields): Record<string, unknown> {
  const m = { nonce: meta.nonce, deadline: BigInt(meta.deadline), relayerFee: meta.relayerFee };
  switch (fields.action) {
    case "depositCollateral":
    case "withdrawCollateral":
    case "depositToInsurance":
      return { amount: fields.amount, ...m };
    case "requestInsuranceWithdrawal":
      return { shareAmount: fields.shareAmount, ...m };
    case "executeInsuranceWithdrawal":
      return m;
    case "createOrder": {
      const s = fields.spec;
      return {
        orderType: s.orderType,
        triggerPrice: s.triggerPrice,
        limitPrice: s.limitPrice,
        maxSlippageBp: s.maxSlippageBp,
        size: s.size,
        isLong: s.isLong,
        isPostOnly: s.isPostOnly,
        tif: s.tif,
        expirationBlock: s.expirationBlock,
        integrator: getAddress(s.integrator),
        ...m,
      };
    }
    case "cancelOrders":
      return { orderIds: [...fields.orderIds], ...m };
    case "amendOrders":
      return { amends: [...fields.amends], ...m };
  }
}

/** The typed data a user signs for `fields` on `pair`. */
export function typedDataFor(chainId: number, pair: Address, fields: SignedFields, meta: MetaFields): PairTypedData {
  const primaryType = PRIMARY_TYPE[fields.action];
  if (!primaryType) throw new InputError("action", `${String((fields as { action: unknown }).action)} has no gasless form.`);
  return {
    domain: pairDomain(chainId, pair),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, [primaryType]: BAZAAR_TYPES[primaryType] },
    primaryType,
    message: message(fields, meta),
  };
}

/** The EIP-712 digest the pair recovers the signer from. */
export function relayedDigest(td: PairTypedData): Hex {
  return hashTypedData(td as never);
}

/** The typed data as the JSON string eth_signTypedData_v4 takes (integers as decimal strings). */
export function typedDataJson(td: PairTypedData): string {
  return JSON.stringify(td, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Check a relayer fee and floor it to USDC precision, as `_resolveUser` charges it: the signed fee is
 * then exactly the USDC the user pays. BAZAAR precision in and out; at most $1.
 */
export function floorRelayerFee(fee: bigint): bigint {
  if (fee < 0n) throw new InputError("relayerFee", "A relayer fee cannot be negative.");
  if (fee > MAX_RELAYER_FEE) throw new InputError("relayerFee", "A relayer fee is at most $1 per action.");
  return fee - (fee % USDC_TO_BAZAAR);
}

/** The signer's next nonce on the pair (`pair.metaTxNonces(user)`). */
export async function readMetaTxNonce(ctx: BazaarContext, pair: Address, user: Address): Promise<bigint> {
  const pc = pairCodec();
  return pc.decode<bigint>("metaTxNonces", await ctx.chain.call(pair, pc.encode("metaTxNonces", user)));
}

const limitsCache = new WeakMap<BazaarContext, Promise<{ maxRelayerFee: bigint; maxDeadlineWindow: number }>>();

/**
 * The fee cap and deadline window the deployment enforces, from `lens.getEip712Constants()` (read
 * once per context). Falls back to the SDK's copies ({@link MAX_RELAYER_FEE}, {@link MAX_DEADLINE_WINDOW})
 * when the lens cannot be read, and never exceeds them.
 */
export function eip712Limits(ctx: BazaarContext): Promise<{ maxRelayerFee: bigint; maxDeadlineWindow: number }> {
  let p = limitsCache.get(ctx);
  if (!p) {
    const lc = lensCodec();
    p = ctx.chain
      .call(ctx.lens, lc.encode("getEip712Constants"))
      .then((d) => {
        const k = lc.decode<{ maxRelayerFee: bigint; maxDeadlineWindow: bigint }>("getEip712Constants", d);
        return {
          maxRelayerFee: k.maxRelayerFee < MAX_RELAYER_FEE ? k.maxRelayerFee : MAX_RELAYER_FEE,
          maxDeadlineWindow: Math.min(Number(k.maxDeadlineWindow), MAX_DEADLINE_WINDOW),
        };
      })
      .catch(() => ({ maxRelayerFee: MAX_RELAYER_FEE, maxDeadlineWindow: MAX_DEADLINE_WINDOW }));
    limitsCache.set(ctx, p);
  }
  return p;
}

/** The latest block's timestamp: the clock deadlines are judged against. */
export async function chainTime(ctx: BazaarContext): Promise<number> {
  return (await ctx.chain.block("latest")).timestamp;
}

/**
 * How far, in seconds, the chain time the RPC reports may sit from this device's clock before the
 * SDK refuses to count a deadline from it.
 */
export const MAX_CLOCK_SKEW = 120;

/**
 * Check the chain time an RPC reported against this device's clock and return the lower of the two:
 * the time every deadline the SDK signs is counted from. The RPC is not trusted with the clock alone:
 * one reporting a block far in the future would have the user sign a gasless request or a permit that
 * stays valid long after they meant it to, a signature someone can store and use later. Throws
 * {@link ClockSkewError} when the two differ by more than {@link MAX_CLOCK_SKEW}.
 */
export function checkClockSkew(chainNow: number, localNow: number = Date.now() / 1000): number {
  const local = Math.floor(localNow);
  if (!Number.isSafeInteger(chainNow) || Math.abs(chainNow - local) > MAX_CLOCK_SKEW) {
    const by = Number.isSafeInteger(chainNow) ? `${Math.abs(chainNow - local)} s ${chainNow > local ? "ahead of" : "behind"}` : "far off";
    throw new ClockSkewError(
      `The network time your RPC reports is ${by} this device's clock (at most ${MAX_CLOCK_SKEW} s is allowed), so nothing is signed with a deadline from it. Set this device's clock to update automatically, or connect through another RPC.`,
      chainNow,
      local,
    );
  }
  return Math.min(chainNow, local);
}

/**
 * Local development chains (Anvil and Hardhat 31337, Ganache and geth --dev 1337), whose clocks
 * tests move at will: their deadlines are counted from chain time unchecked. A signature made for
 * one is void on every public chain, since its chain id is part of every domain the SDK signs under.
 */
export const DEV_CHAIN_IDS: readonly number[] = [31337, 1337];

/** `chainNow` checked against this device's clock ({@link checkClockSkew}), except on a {@link DEV_CHAIN_IDS} chain. */
const baseFor = (ctx: BazaarContext, chainNow: number) => (DEV_CHAIN_IDS.includes(ctx.chainId) ? chainNow : checkClockSkew(chainNow));

/**
 * The time a deadline is counted from: min(latest block's timestamp, this device's clock), checked
 * by {@link checkClockSkew}.
 * @internal Not bound on the Bazaar facade (bindings.generated.ts); call it as `signing.deadlineBase(ctx)`.
 */
export async function deadlineBase(ctx: BazaarContext): Promise<number> {
  return baseFor(ctx, await chainTime(ctx));
}

/**
 * A deadline `windowSeconds` (default: the whole window) past the lower of the latest block's
 * timestamp and this device's clock, never more than the deployment's `maxDeadlineWindow` (10 s).
 * The two clocks must agree within {@link MAX_CLOCK_SKEW} ({@link ClockSkewError} otherwise; a local
 * dev chain, {@link DEV_CHAIN_IDS}, uses its own time), and a device clock so far behind the chain
 * that the deadline would already have passed by chain time is refused too. Take it right before asking the wallet to sign; if the user takes longer than the
 * window to approve, the signature arrives expired and has to be requested again.
 */
export async function chainDeadline(ctx: BazaarContext, windowSeconds?: number): Promise<number> {
  const [{ maxDeadlineWindow }, chainNow] = await Promise.all([eip712Limits(ctx), chainTime(ctx)]);
  const w = windowSeconds ?? maxDeadlineWindow;
  if (!(w > 0) || w > maxDeadlineWindow) {
    throw new InputError("deadline", `A gasless signature can be valid for at most ${maxDeadlineWindow} seconds.`);
  }
  const base = baseFor(ctx, chainNow);
  const deadline = base + Math.floor(w);
  if (deadline <= chainNow) {
    throw new ClockSkewError(
      `This device's clock is ${chainNow - base} s behind the network's, so a gasless signature (valid ${Math.floor(w)} s) would expire before it lands. Set this device's clock to update automatically, then try again.`,
      chainNow,
      base,
    );
  }
  return deadline;
}

// secp256k1's group order over two: OpenZeppelin's ECDSA refuses an s above it.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** A signing step the wallet refused or could not do in the form Bazaar accepts. */
export class SigningError extends Error {
  override readonly name: string = "SigningError";
}

/**
 * The RPC's chain time and this device's clock disagree too much to stamp a deadline
 * ({@link checkClockSkew}, {@link chainDeadline}). Nothing was signed.
 */
export class ClockSkewError extends SigningError {
  override readonly name: string = "ClockSkewError";
  constructor(
    message: string,
    /** The latest block's timestamp, as the RPC reported it. */
    readonly chainTime: number,
    /** This device's clock (unix seconds). */
    readonly localTime: number,
  ) {
    super(message);
  }
}

/**
 * A wallet's signature in the 65-byte r ‖ s ‖ v form OpenZeppelin's ECDSA accepts: v as 27/28 (some
 * wallets return 0/1), an EIP-2098 64-byte signature expanded, and a high-s signature refused.
 */
export function normalizeSignature(sig: Hex): Hex {
  const b = hexToBytes(sig);
  let out: Uint8Array;
  if (b.length === 64) {
    out = new Uint8Array(65);
    out.set(b.subarray(0, 32), 0);
    out.set(b.subarray(32, 64), 32);
    const yParity = out[32]! >> 7;
    out[32] = out[32]! & 0x7f;
    out[64] = 27 + yParity;
  } else if (b.length === 65) {
    out = new Uint8Array(b);
    if (out[64]! < 27) out[64] = out[64]! + 27;
    if (out[64] !== 27 && out[64] !== 28) throw new SigningError("the wallet returned a signature Bazaar cannot verify (unexpected v)");
  } else {
    throw new SigningError(`the wallet returned a ${b.length}-byte signature; Bazaar accepts only an account's own 65-byte ECDSA signature`);
  }
  const s = BigInt(bytesToHex(out.subarray(32, 64)));
  if (s > HALF_N) throw new SigningError("the wallet returned a high-s signature, which Bazaar refuses");
  return bytesToHex(out);
}

/**
 * Ask an EIP-1193 wallet to sign typed data with eth_signTypedData_v4, so it shows the user every
 * field it signs. The domain's chainId must match the wallet's active chain (wallets refuse
 * otherwise). The signature is normalized and recovered locally: one that does not recover to
 * `signer` (a smart-account wallet signing through ERC-1271) is refused here, since the pair would
 * act for whatever address it recovers.
 */
export async function signTypedDataV4(wallet: Transport, signer: Address, td: PairTypedData | { domain: object; types: object; primaryType: string; message: object }): Promise<Hex> {
  let raw: unknown;
  try {
    raw = await wallet.request({ method: "eth_signTypedData_v4", params: [getAddress(signer), typedDataJson(td as PairTypedData)] });
  } catch (e) {
    const rpc = toRpcError(e);
    if (rpc?.code === 4001) throw new SigningError("You declined the signature.");
    throw new SigningError(rpc ? rpc.rpcMessage : String(e));
  }
  if (typeof raw !== "string" || !raw.startsWith("0x")) throw new SigningError("the wallet returned no signature");
  const sig = normalizeSignature(raw as Hex);
  const recovered = await recoverTypedDataAddress({ ...(td as object), signature: sig } as never);
  if (getAddress(recovered) !== getAddress(signer)) {
    throw new SigningError(
      `the signature recovers to ${recovered}, not ${getAddress(signer)}: this wallet does not sign as a plain account. Gasless calls need an account's own signature; send the transaction directly instead`,
    );
  }
  return sig;
}

// ---- calldata ----

/** The actions whose call takes `priceUpdate`: a relayer attaches a fresh one at submission. */
export function takesPriceUpdate(action: RelayedAction): boolean {
  return action === "withdrawCollateral" || action === "depositToInsurance" || action === "executeInsuranceWithdrawal" || action === "createOrder" || action === "amendOrders";
}

/**
 * Calldata for one of the eight actions, direct (`DIRECT_META`) or relayed. `priceUpdate` and, for
 * createOrder, `hints` ride outside the signature. withdrawCollateral takes no permit.
 */
export function encodePairWrite(fields: SignedFields, extra: { priceUpdate?: readonly Hex[]; hints?: MatchHints }, meta: MetaArgs): Hex {
  const p = pairCodec();
  const u = [...(extra.priceUpdate ?? [])];
  const { nonce, deadline, relayerFee: fee, signature: sig, permitData: permit } = meta;
  switch (fields.action) {
    case "depositCollateral":
      return p.encode("depositCollateral", fields.amount, nonce, deadline, fee, sig, permit);
    case "withdrawCollateral":
      if (permit !== "0x") throw new InputError("permitData", "A withdrawal takes no permit: its fee comes out of the payout.");
      return p.encode("withdrawCollateral", fields.amount, u, nonce, deadline, fee, sig);
    case "depositToInsurance":
      return p.encode("depositToInsurance", fields.amount, u, nonce, deadline, fee, sig, permit);
    case "requestInsuranceWithdrawal":
      return p.encode("requestInsuranceWithdrawal", fields.shareAmount, nonce, deadline, fee, sig, permit);
    case "executeInsuranceWithdrawal":
      return p.encode("executeInsuranceWithdrawal", u, nonce, deadline, fee, sig, permit);
    case "createOrder":
      return p.encode("createOrder", fields.spec, extra.hints ?? NO_HINTS, u, nonce, deadline, fee, sig, permit);
    case "cancelOrders":
      return p.encode("cancelOrders", [...fields.orderIds], nonce, deadline, fee, sig, permit);
    case "amendOrders":
      return p.encode("amendOrders", [...fields.amends], u, nonce, deadline, fee, sig, permit);
  }
}

// ---- verification against the chain ----

const LENS_TYPEHASH_KEYS: Readonly<Record<PrimaryType, string>> = {
  DepositCollateral: "depositCollateral",
  WithdrawCollateral: "withdrawCollateral",
  DepositToInsurance: "depositToInsurance",
  RequestInsuranceWithdrawal: "requestInsuranceWithdrawal",
  ExecuteInsuranceWithdrawal: "executeInsuranceWithdrawal",
  CreateOrder: "createOrder",
  CancelOrders: "cancelOrders",
  AmendOrders: "amendOrders",
};

export interface TypehashReport {
  /** Everything the SDK signs with matches the deployment. */
  readonly ok: boolean;
  /** One line per mismatch. */
  readonly mismatches: readonly string[];
  readonly typehashes: Readonly<Record<PrimaryType, { readonly sdk: Hex; readonly chain: Hex }>>;
  readonly constants: { readonly maxRelayerFee: bigint; readonly maxDeadlineWindow: number };
  /** Present when a pair was given: its DOMAIN_SEPARATOR against the one the SDK derives. */
  readonly domain?: { readonly sdk: Hex; readonly chain: Hex };
}

/**
 * Confirm that what the SDK signs is what the deployment verifies: each type string's hash against
 * `lens.getTypehashes()`, the domain's type, name and version hashes and the fee and deadline caps
 * against `lens.getEip712Constants()`, and, given a pair, the domain the SDK derives against
 * `pair.DOMAIN_SEPARATOR()`. Run it once per deployment (at startup, or in CI against a fork).
 */
export async function verifyTypehashes(ctx: BazaarContext, pair?: Address): Promise<TypehashReport> {
  const lc = lensCodec();
  const pc = pairCodec();
  const [th, k, ds] = await Promise.all([
    ctx.chain.call(ctx.lens, lc.encode("getTypehashes")),
    ctx.chain.call(ctx.lens, lc.encode("getEip712Constants")),
    pair ? ctx.chain.call(pair, pc.encode("DOMAIN_SEPARATOR")) : Promise.resolve(null),
  ]);
  const chainHashes = lc.decode<Record<string, Hex>>("getTypehashes", th);
  const consts = lc.decode<{ domainTypehash: Hex; nameHash: Hex; versionHash: Hex; maxRelayerFee: bigint; maxDeadlineWindow: bigint }>("getEip712Constants", k);
  const mismatches: string[] = [];
  const typehashes = {} as Record<PrimaryType, { sdk: Hex; chain: Hex }>;
  for (const pt of Object.keys(TYPE_STRINGS) as PrimaryType[]) {
    const sdk = typeHash(pt);
    const chain = (chainHashes[LENS_TYPEHASH_KEYS[pt]] ?? "0x").toLowerCase() as Hex;
    typehashes[pt] = { sdk, chain };
    if (sdk !== chain) mismatches.push(`${pt} typehash: SDK ${sdk}, lens ${chain}`);
  }
  const eq = (label: string, sdk: Hex, chain: Hex) => {
    if (sdk.toLowerCase() !== chain.toLowerCase()) mismatches.push(`${label}: SDK ${sdk}, lens ${chain}`);
  };
  eq("EIP712Domain typehash", keccak256(toBytes(EIP712_DOMAIN_TYPE_STRING)), consts.domainTypehash);
  eq("domain name hash", keccak256(toBytes(BAZAAR_DOMAIN_NAME)), consts.nameHash);
  eq("domain version hash", keccak256(toBytes(BAZAAR_DOMAIN_VERSION)), consts.versionHash);
  if (consts.maxRelayerFee !== MAX_RELAYER_FEE) mismatches.push(`max relayer fee: SDK ${MAX_RELAYER_FEE}, lens ${consts.maxRelayerFee}`);
  if (Number(consts.maxDeadlineWindow) !== MAX_DEADLINE_WINDOW) mismatches.push(`max deadline window: SDK ${MAX_DEADLINE_WINDOW} s, lens ${consts.maxDeadlineWindow} s`);
  let domain: { sdk: Hex; chain: Hex } | undefined;
  if (pair && ds) {
    domain = { sdk: domainSeparator(ctx.chainId, pair), chain: pc.decode<Hex>("DOMAIN_SEPARATOR", ds).toLowerCase() as Hex };
    if (domain.sdk !== domain.chain) mismatches.push(`DOMAIN_SEPARATOR of ${pair}: SDK ${domain.sdk}, pair ${domain.chain}`);
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    typehashes,
    constants: { maxRelayerFee: consts.maxRelayerFee, maxDeadlineWindow: Number(consts.maxDeadlineWindow) },
    ...(domain ? { domain } : {}),
  };
}
