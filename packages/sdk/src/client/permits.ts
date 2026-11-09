/**
 * USDC permits (ERC-2612): an approval signed rather than sent, carried in a pair call's
 * `permitData` so the user needs no approve transaction and, relayed, no ETH at all.
 *
 * The pair decodes `permitData` as `abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r,
 * bytes32 s)` and calls `usdc.permit(signer, pair, value, deadline, v, r, s)` best-effort before it
 * pulls: a permit that fails (already used, expired, front-run) emits `PermitExecutionFailed` and the
 * call falls through to the allowance already in place. A permit SETS the allowance to `value`; it
 * does not add to it. So `value` (USDC units) must cover everything the call pulls:
 * - depositCollateral / depositToInsurance: the deposit plus the relayer fee;
 * - createOrder: the relayer fee plus the trigger bounty the order carries (the fee is pulled first,
 *   then the bounty, against the same allowance);
 * - cancelOrders, amendOrders, requestInsuranceWithdrawal and the locking executeInsuranceWithdrawal:
 *   the relayer fee alone (a direct call of these ignores the permit);
 * - withdrawCollateral and the paying executeInsuranceWithdrawal take no permit: the fee comes out of
 *   the payout.
 * A permit consumes the token's nonce for the owner, so sign one at a time and submit it before
 * signing the next.
 */

import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, getAddress, hashDomain, hexToBytes, bytesToHex, recoverTypedDataAddress } from "viem";
import type { Transport } from "../chain/rpc.js";
import { InputError } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { erc20Data } from "./allowance.js";
import { requirePair } from "./guard.js";
import { SigningError, chainTime, deadlineBase, signTypedDataV4, type TypedDataDomain } from "./signing.js";
import { toUsdcUnitsCeil } from "./units.js";

/** How long a permit the SDK signs stays valid by default (seconds past the lower of chain time and the device's clock). */
export const DEFAULT_PERMIT_WINDOW = 30 * 60;

// secp256k1's group order over two: FiatToken's ECRecover refuses an s above it, as OpenZeppelin's ECDSA does.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export const PERMIT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const PERMIT_DATA = [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }] as const;

const domains = new WeakMap<BazaarContext, Promise<TypedDataDomain>>();

/**
 * USDC's EIP-712 domain: its `name()`, its `version()` ("2" on native Arbitrum USDC; "1" only when
 * the token has no version()), the chain id, and its address. Checked against the token's own
 * `DOMAIN_SEPARATOR()` when it has one, so a wrong name or version fails here rather than as a permit
 * the token silently refuses. Cached per context.
 */
export function usdcPermitDomain(ctx: BazaarContext): Promise<TypedDataDomain> {
  let d = domains.get(ctx);
  if (!d) {
    d = loadDomain(ctx);
    d.catch(() => domains.delete(ctx));
    domains.set(ctx, d);
  }
  return d;
}

async function loadDomain(ctx: BazaarContext): Promise<TypedDataDomain> {
  const [[okN, n], [okV, v], [okD, ds]] = await ctx.chain.batch([
    { to: ctx.usdc, data: erc20Data("name") },
    { to: ctx.usdc, data: erc20Data("version") },
    { to: ctx.usdc, data: erc20Data("DOMAIN_SEPARATOR") },
  ]);
  if (!okN || !n || n === "0x") throw new Error(`${ctx.usdc} does not answer name(): not a permit token`);
  const name = decodeAbiParameters([{ type: "string" }], n)[0];
  const version = okV && v && v !== "0x" ? decodeAbiParameters([{ type: "string" }], v)[0] : "1";
  const domain: TypedDataDomain = { name, version, chainId: ctx.chainId, verifyingContract: getAddress(ctx.usdc) };
  if (okD && ds && ds.length === 66) {
    const ours = hashDomain({ domain, types: { EIP712Domain: PERMIT_TYPES.EIP712Domain } } as unknown as Parameters<typeof hashDomain>[0]);
    if (ours.toLowerCase() !== ds.toLowerCase()) {
      throw new Error(`USDC's DOMAIN_SEPARATOR does not match name "${name}", version "${version}" on chain ${ctx.chainId}`);
    }
  }
  return domain;
}

/** The owner's current permit nonce on USDC. */
export async function permitNonce(ctx: BazaarContext, owner: Address): Promise<bigint> {
  return decodeAbiParameters([{ type: "uint256" }], await ctx.chain.call(ctx.usdc, erc20Data("nonces", getAddress(owner))))[0];
}

export interface PermitMessage {
  readonly owner: Address;
  /** The pair that will pull. */
  readonly spender: Address;
  /** USDC units. */
  readonly value: bigint;
  readonly nonce: bigint;
  /** Unix seconds. */
  readonly deadline: number;
}

/** The typed data of a USDC permit. */
export function permitTypedData(domain: TypedDataDomain, msg: PermitMessage) {
  return {
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: getAddress(msg.owner), spender: getAddress(msg.spender), value: msg.value, nonce: msg.nonce, deadline: BigInt(msg.deadline) },
  };
}

/** `abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`, as the pair decodes it. */
export function encodePermitData(value: bigint, deadline: number | bigint, v: number, r: Hex, s: Hex): Hex {
  return encodeAbiParameters(PERMIT_DATA, [value, BigInt(deadline), v, r, s]);
}

export function decodePermitData(data: Hex): { value: bigint; deadline: number; v: number; r: Hex; s: Hex } {
  const [value, deadline, v, r, s] = decodeAbiParameters(PERMIT_DATA, data);
  return { value, deadline: Number(deadline), v, r, s };
}

/** The permit value (USDC units, rounded up) that covers a pull of `pullBazaar` (BAZAAR precision). */
export function permitValueFor(pullBazaar: bigint): bigint {
  return toUsdcUnitsCeil(pullBazaar);
}

export interface SignedPermit extends PermitMessage {
  readonly signature: Hex;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
  /** What the pair call's `permitData` takes. */
  readonly permitData: Hex;
}

/**
 * Ask the owner's wallet (EIP-1193, eth_signTypedData_v4) to sign a USDC permit letting `spender`
 * (a pair of this deployment: anything else is refused before the wallet is asked) pull `value` USDC
 * units, valid until `deadline` (default: 30 minutes past the lower of chain time and the device's
 * clock, which must agree within 2 minutes). The nonce is read from the token unless given.
 */
export async function signPermit(
  ctx: BazaarContext,
  wallet: Transport,
  req: { owner: Address; spender: Address; value: bigint; deadline?: number; nonce?: bigint },
): Promise<SignedPermit> {
  if (req.value <= 0n) throw new InputError("value", "A permit must allow a positive amount.");
  const spender = await requirePair(ctx, req.spender);
  const [domain, nonce, now] = await Promise.all([
    usdcPermitDomain(ctx),
    req.nonce !== undefined ? Promise.resolve(req.nonce) : permitNonce(ctx, req.owner),
    req.deadline !== undefined ? Promise.resolve(0) : deadlineBase(ctx),
  ]);
  const deadline = req.deadline ?? now + DEFAULT_PERMIT_WINDOW;
  const msg: PermitMessage = { owner: getAddress(req.owner), spender, value: req.value, nonce, deadline };
  const signature = await signTypedDataV4(wallet, msg.owner, permitTypedData(domain, msg));
  const b = hexToBytes(signature);
  const r = bytesToHex(b.subarray(0, 32));
  const s = bytesToHex(b.subarray(32, 64));
  const v = b[64]!;
  // signTypedDataV4 normalizes to v = 27/28, the only values USDC's ecrecover takes; never encode another.
  if (v !== 27 && v !== 28) throw new SigningError("the wallet returned a permit signature USDC cannot verify (unexpected v)");
  return { ...msg, signature, v, r, s, permitData: encodePermitData(req.value, deadline, v, r, s) };
}

/**
 * Check a `permitData` a relayer received: it decodes, it is signed by `owner` for `spender` at the
 * owner's current nonce, it has not expired, and it covers `needUsdc`. Problems are returned, not
 * thrown: a failing permit does not fail the call, which then needs the allowance in place.
 */
export async function checkPermit(
  ctx: BazaarContext,
  permitData: Hex,
  req: { owner: Address; spender: Address; needUsdc: bigint },
): Promise<{ ok: boolean; problems: string[]; value: bigint | null }> {
  let p: ReturnType<typeof decodePermitData>;
  try {
    p = decodePermitData(permitData);
  } catch {
    return { ok: false, problems: ["permitData does not decode as (value, deadline, v, r, s)"], value: null };
  }
  const [domain, nonce, now] = await Promise.all([usdcPermitDomain(ctx), permitNonce(ctx, req.owner), chainTime(ctx)]);
  const problems: string[] = [];
  if (p.deadline < now) problems.push("the permit has expired");
  if (p.value < req.needUsdc) problems.push(`the permit allows ${p.value} USDC units; the call pulls ${req.needUsdc}`);
  // USDC's ecrecover takes v = 27 or 28 and a low s only; viem's recovery below would accept more.
  if (p.v !== 27 && p.v !== 28) problems.push(`the permit's v is ${p.v}; USDC accepts only 27 or 28`);
  if (BigInt(p.s) > HALF_N) problems.push("the permit's signature has a high s, which USDC refuses");
  const signature = `${p.r}${p.s.slice(2)}${p.v.toString(16).padStart(2, "0")}` as Hex;
  try {
    const td = permitTypedData(domain, { owner: req.owner, spender: req.spender, value: p.value, nonce, deadline: p.deadline });
    const who = await recoverTypedDataAddress({ ...td, signature } as never);
    if (getAddress(who) !== getAddress(req.owner)) problems.push("the permit is not signed by the owner for this pair at the owner's current nonce");
  } catch {
    problems.push("the permit's signature does not recover");
  }
  return { ok: problems.length === 0, problems, value: p.value };
}
