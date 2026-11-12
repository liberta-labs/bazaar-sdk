/**
 * Gasless calls end to end: the user signs, a relayer submits.
 *
 * Frontend: {@link signRelayed} checks the action, optionally has the wallet sign a USDC permit for
 * what the call pulls, then has it sign the EIP-712 request, and returns a {@link RelayedRequest} to
 * post to the relayer ({@link serializeRelayed} makes it JSON).
 *
 * Relayer (browser-safe, so it runs on a server too): {@link parseRelayed} the body,
 * {@link verifyRelayed} it (signer, deadline, nonce, fee cap, the action's own bounds, the permit),
 * then {@link encodeRelayed} it into the PreparedCall it sends from its own account. Encoding attaches
 * what sits outside the signature: a fresh `priceUpdate`, and for createOrder fresh MatchHints
 * (amendment hints are inside the signed words and cannot change). The relayer pays the gas and
 * the Pyth fee in ETH and is credited the signed `relayerFee` in USDC on that pair, collected with
 * `claimFees` (trade.ts).
 *
 * Timing: a request's deadline is at most 10 s past the chain time it was signed at
 * (MAX_DEADLINE_WINDOW), so it cannot be warehoused, and neither can its price: the pair accepts a
 * print at most 3 s from the block's time. A relayer must verify, encode and submit at once, and a
 * frontend should re-sign rather than retry a request whose deadline has passed. Nonces are
 * sequential per user per pair: a request lands only at the signer's current nonce, so several
 * pending requests from one user must be submitted in nonce order.
 *
 * Only an account's own ECDSA signature is accepted (the pair uses `ECDSA.recover`): smart accounts
 * send their calls directly, batched (batching.ts).
 */

import { type Address, type Hex, getAddress, isHex, recoverTypedDataAddress } from "viem";
import { lens as lensCodec, pair as pairCodec } from "../chain/codec.js";
import type { Transport } from "../chain/rpc.js";
import { MIN_COLLATERAL_DEPOSIT, USDC_TO_BAZAAR } from "../constants.js";
import { InputError, type PreparedCall } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { MAX_INSURANCE_DEPOSIT, MIN_INSURANCE_DEPOSIT } from "./insurance.js";
import {
  type AmendInput,
  type MatchHints,
  type OrderInput,
  type OrderSpec,
  decodeAmends,
  describeOrder,
  specBounty,
  validateOrderSpec,
} from "./orders.js";
import { usdcAllowance } from "./allowance.js";
import { requirePair } from "./guard.js";
import { checkPermit, permitValueFor, signPermit } from "./permits.js";
import {
  MAX_RELAYER_FEE,
  RELAYED_ACTIONS,
  type RelayedAction,
  type SignedFields,
  chainDeadline,
  chainTime,
  eip712Limits,
  encodePairWrite,
  floorRelayerFee,
  normalizeSignature,
  readMetaTxNonce,
  signTypedDataV4,
  takesPriceUpdate,
  typedDataFor,
} from "./signing.js";
import { checkCancelIds, matchHintsFor, optionalUpdate, prepareAmends, prepareOrder, priceFields, terminalPayoutNote, terminalWithdrawal } from "./trade.js";
import { floorToUsdc, formatUnits18, toUsdcUnitsCeil } from "./units.js";

/** A signed gasless request: every signed field, the signer, the signature and the permit. */
export type RelayedRequest = SignedFields & {
  readonly pair: Address;
  readonly chainId: number;
  readonly signer: Address;
  readonly nonce: bigint;
  /** Unix seconds, chain time. */
  readonly deadline: number;
  /** BAZAAR precision, floored to micro-USDC. */
  readonly relayerFee: bigint;
  readonly signature: Hex;
  /** `abi.encode(value, deadline, v, r, s)` of a USDC permit, or "0x". */
  readonly permitData: Hex;
};

/** What {@link signRelayed} takes: the signed fields themselves, or an order / amendments to check and build first. */
export type RelayedInput =
  | SignedFields
  | { readonly action: "createOrder"; readonly order: OrderInput }
  | { readonly action: "amendOrders"; readonly amendments: readonly AmendInput[] };

export interface SignRelayedOptions {
  /** The user's EIP-1193 wallet. */
  readonly wallet: Transport;
  readonly signer: Address;
  readonly pair: Address;
  /** What the relayer charges, BAZAAR precision, at most $1; floored to micro-USDC. Default 0. */
  readonly relayerFee?: bigint;
  /** Seconds the signature stays valid past chain time, at most 10 (the default). */
  readonly deadlineWindow?: number;
  /** The nonce to sign; read from the pair when omitted (pass it to sign several requests in a row). */
  readonly nonce?: bigint;
  /**
   * Also sign a USDC permit for what the call pulls from the wallet (signed first, as its own
   * prompt), unless the pair's current allowance already covers it: a permit SETS the allowance, so
   * one signed anyway would replace a larger approval with this call's amount. `value` (USDC units)
   * overrides the amount, `deadline` (unix seconds) its expiry, `always` signs one regardless.
   */
  readonly permit?: boolean | { readonly value?: bigint; readonly deadline?: number; readonly always?: boolean };
}

async function resolveFields(ctx: BazaarContext, pair: Address, signer: Address, input: RelayedInput): Promise<SignedFields> {
  if (input.action === "createOrder" && "order" in input) {
    return { action: "createOrder", spec: (await prepareOrder(ctx, pair, signer, input.order)).spec };
  }
  if (input.action === "amendOrders" && "amendments" in input) {
    return { action: "amendOrders", amends: (await prepareAmends(ctx, pair, signer, input.amendments)).words };
  }
  const f = input as SignedFields;
  if (f.action === "depositCollateral" || f.action === "depositToInsurance") return { ...f, amount: floorToUsdc(f.amount) };
  return f;
}

/**
 * The bounds of each action that need no chain read, as the pair enforces them for a relayed call:
 * deposits of at least 5 USDC that exceed the fee, a withdrawal larger than the fee, a non-zero share
 * amount, 1-34 distinct cancel ids, 1-32 well-formed amendments, a spec the order rules accept.
 * `terminalPayout`: for a withdrawal on a terminated pair, what it pays ({@link terminalWithdrawal},
 * `amount × principalRatio`), which is what the fee is judged against there; a payout of 0 takes
 * the fee from the wallet instead and passes this check.
 */
export function checkSignedFields(fields: SignedFields, relayerFee: bigint, terminalPayout?: bigint): void {
  switch (fields.action) {
    case "depositCollateral":
    case "depositToInsurance": {
      const amount = floorToUsdc(fields.amount);
      const min = fields.action === "depositCollateral" ? MIN_COLLATERAL_DEPOSIT : MIN_INSURANCE_DEPOSIT;
      if (amount < min) throw new InputError("amount", `The minimum ${fields.action === "depositCollateral" ? "deposit" : "insurance deposit"} is 5 USDC.`);
      if (fields.action === "depositToInsurance" && amount > MAX_INSURANCE_DEPOSIT) throw new InputError("amount", "That amount is too large.");
      if (relayerFee >= amount) throw new InputError("relayerFee", "The relayer fee must be less than the deposit.");
      return;
    }
    case "withdrawCollateral": {
      if (fields.amount <= 0n) throw new InputError("amount", "Enter an amount to withdraw.");
      // _sendWithRelayerFee: a payout at or under the fee reverts; a zero payout pulls the fee instead.
      const paid = terminalPayout ?? fields.amount;
      if (relayerFee > 0n && paid > 0n && paid <= relayerFee) {
        throw new InputError(
          "relayerFee",
          terminalPayout === undefined
            ? "The withdrawal must be larger than the relayer fee."
            : `This market is terminated: the withdrawal pays ${formatUnits18(paid, 6)} USDC, which must be more than the relayer fee.`,
        );
      }
      return;
    }
    case "requestInsuranceWithdrawal":
      if (fields.shareAmount <= 0n) throw new InputError("shareAmount", "Enter a number of shares to withdraw.");
      return;
    case "executeInsuranceWithdrawal":
      return;
    case "createOrder":
      validateOrderSpec(fields.spec);
      return;
    case "cancelOrders":
      checkCancelIds(fields.orderIds);
      return;
    case "amendOrders":
      decodeAmends(fields.amends);
      return;
    default:
      throw new InputError("action", `${String((fields as { action: unknown }).action)} has no gasless form.`);
  }
}

/**
 * What a relayed call takes from the signer's wallet, BAZAAR precision: a deposit plus the fee; the
 * fee plus a trigger order's bounty for createOrder; the fee alone for cancel, amend, request and the
 * locking executeInsuranceWithdrawal; nothing for a withdrawal or a paying execute, whose fee comes
 * out of the payout, unless the payout is nothing (a withdrawal on a terminated pair whose payout
 * ratio leaves 0), when the fee comes from the wallet. A permit has to cover this (rounded up to
 * USDC units).
 */
export async function relayedPull(ctx: BazaarContext, pair: Address, signer: Address, fields: SignedFields, relayerFee: bigint): Promise<bigint> {
  switch (fields.action) {
    case "depositCollateral":
    case "depositToInsurance":
      return floorToUsdc(fields.amount) + relayerFee;
    case "withdrawCollateral":
      return relayerFee === 0n ? 0n : withdrawalPull(relayerFee, await terminalWithdrawal(ctx, pair, signer, fields.amount));
    case "createOrder":
      return relayerFee + specBounty(fields.spec);
    case "executeInsuranceWithdrawal": {
      if (relayerFee === 0n) return 0n;
      const lc = lensCodec();
      const pc = pairCodec();
      const [[okL, l], [okT, t]] = await ctx.chain.batch([
        { to: ctx.lens, data: lc.encode("getInsuranceWithdrawalLock", pair, signer) },
        { to: pair, data: pc.encode("isPairTerminated") },
      ]);
      if (okT && pc.decode<boolean>("isPairTerminated", t!)) return 0n;
      const locked = okL ? lc.decode<{ isLocked: boolean }>("getInsuranceWithdrawalLock", l!).isLocked : false;
      return locked ? 0n : relayerFee; // the lock pays nothing, so its fee comes from the wallet
    }
    default:
      return relayerFee;
  }
}

/** A relayed withdrawal's wallet pull: its fee when the (terminal) payout is 0, else nothing. */
const withdrawalPull = (relayerFee: bigint, terminal: { payout: bigint } | null) => (relayerFee > 0n && terminal !== null && terminal.payout === 0n ? relayerFee : 0n);

/**
 * Have the user sign a gasless request. Checks that `pair` is one of the deployment's pairs
 * (guard.ts `requirePair`) and the action (an order or amendments against the chain, as trade.ts
 * does for direct calls; a withdrawal on a terminated pair against what it pays), floors the fee,
 * signs the permit if asked (its own prompt, before the request's deadline starts), then reads the
 * nonce and stamps the deadline from the lower of chain time and the device's clock
 * (signing.ts `chainDeadline`) and asks the wallet to sign the typed data (eth_signTypedData_v4).
 * Post the result to the relayer at once: it is valid for at most 10 seconds.
 */
export async function signRelayed(ctx: BazaarContext, input: RelayedInput, opts: SignRelayedOptions): Promise<RelayedRequest> {
  const signer = getAddress(opts.signer);
  const relayerFee = floorRelayerFee(opts.relayerFee ?? 0n);
  // The pair is the domain the user signs under and the permit's spender: one of this deployment's, or nothing is asked for.
  const [limits, pair] = await Promise.all([eip712Limits(ctx), requirePair(ctx, opts.pair)]);
  if (relayerFee > limits.maxRelayerFee) throw new InputError("relayerFee", `A relayer fee is at most ${formatUnits18(limits.maxRelayerFee, 6)} USDC per action.`);
  if ((opts.deadlineWindow ?? limits.maxDeadlineWindow) > limits.maxDeadlineWindow) {
    throw new InputError("deadline", `A gasless signature can be valid for at most ${limits.maxDeadlineWindow} seconds.`);
  }
  const fields = await resolveFields(ctx, pair, signer, input);
  const terminal = fields.action === "withdrawCollateral" ? await terminalWithdrawal(ctx, pair, signer, fields.amount) : null;
  checkSignedFields(fields, relayerFee, terminal?.payout);
  if (terminal && terminal.payout === 0n) {
    throw new InputError("amount", "This market is terminated and, at its payout ratio, this withdrawal pays nothing.");
  }

  let permitData: Hex = "0x";
  if (opts.permit) {
    if (fields.action === "withdrawCollateral") throw new InputError("permit", "A withdrawal takes no permit: its fee comes out of the payout.");
    const o = typeof opts.permit === "object" ? opts.permit : {};
    const value = o.value ?? permitValueFor(await relayedPull(ctx, pair, signer, fields, relayerFee));
    const covered = !o.always && value > 0n && (await usdcAllowance(ctx, signer, pair)) >= value;
    if (value > 0n && !covered) {
      permitData = (await signPermit(ctx, opts.wallet, { owner: signer, spender: pair, value, ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) })).permitData;
    }
  }

  const [nonce, deadline] = await Promise.all([
    opts.nonce !== undefined ? Promise.resolve(opts.nonce) : readMetaTxNonce(ctx, pair, signer),
    chainDeadline(ctx, opts.deadlineWindow),
  ]);
  const td = typedDataFor(ctx.chainId, pair, fields, { nonce, deadline, relayerFee });
  const signature = await signTypedDataV4(opts.wallet, signer, td);
  return { ...fields, pair, chainId: ctx.chainId, signer, nonce, deadline, relayerFee, signature, permitData };
}

// ---- relayer side ----

/** The fee the pair charges for a signed fee: its USDC floor. */
const chargedFee = (fee: bigint) => fee - (fee % USDC_TO_BAZAAR);

// OpenZeppelin's ECDSA.recover, which the pair verifies with, takes only r ‖ s ‖ v with v 27 or 28.
const NON_CANONICAL =
  "the signature is not in the 65-byte r‖s‖v form (v 27 or 28) the pair accepts, so the pair would refuse it as sent; canonicalize it first (parseRelayed does)";

export interface RelayCheck {
  /** Safe to submit now: every problem below is empty. */
  readonly ok: boolean;
  /** The address the signature recovers to (null when it does not recover). */
  readonly signer: Address | null;
  /** What would make the call revert, by field. */
  readonly problems: readonly { readonly field: string; readonly message: string }[];
  /** What would not revert by itself (a permit that fails falls back to the allowance in place). */
  readonly warnings: readonly string[];
  /** Seconds until the deadline, by chain time (negative once passed). */
  readonly secondsLeft: number;
}

/**
 * Check a request before relaying it: the pair is one of the deployment's pairs (nothing else is
 * read from it otherwise), the chain id, the signature recovers to `signer` over exactly these
 * fields and is in the canonical form the pair accepts and {@link encodeRelayed} submits (65 bytes,
 * v 27 or 28, low s: {@link parseRelayed} canonicalizes it), the deadline is ahead and no more than
 * 10 s out by chain time, the nonce is the signer's current one on the pair, the fee is within the
 * cap, and the action's own bounds hold (a withdrawal on a terminated pair against what it pays).
 * A permit is checked too (signer, nonce, expiry, value, v and s), as a warning: the pair executes
 * it best-effort and falls back to the existing allowance.
 */
export async function verifyRelayed(ctx: BazaarContext, req: RelayedRequest): Promise<RelayCheck> {
  const problems: { field: string; message: string }[] = [];
  const warnings: string[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!(RELAYED_ACTIONS as readonly string[]).includes(req.action)) {
    return { ok: false, signer: null, problems: [{ field: "action", message: `${req.action} has no gasless form` }], warnings, secondsLeft: 0 };
  }
  if (req.chainId !== ctx.chainId) add("chainId", `signed for chain ${req.chainId}, connected to ${ctx.chainId}`);
  if (req.relayerFee < 0n || req.relayerFee > MAX_RELAYER_FEE) add("relayerFee", "the relayer fee is above the $1 cap");
  try {
    await requirePair(ctx, req.pair);
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    add("pair", e.message.slice(e.field.length + 2));
    return { ok: false, signer: null, problems, warnings, secondsLeft: 0 };
  }
  const fee = chargedFee(req.relayerFee);
  const terminal = req.action === "withdrawCollateral" ? await terminalWithdrawal(ctx, req.pair, req.signer, req.amount) : null;
  try {
    checkSignedFields(req, fee, terminal?.payout);
  } catch (e) {
    if (e instanceof InputError) add(e.field, e.message.slice(e.field.length + 2));
    else throw e;
  }
  if (terminal && terminal.payout === 0n) {
    warnings.push(
      fee > 0n
        ? "the market is terminated and this withdrawal pays nothing: the relayer fee is pulled from the signer's wallet, which needs a USDC allowance to the pair covering it"
        : "the market is terminated and this withdrawal pays nothing",
    );
  }

  let recovered: Address | null = null;
  try {
    const sig = normalizeSignature(req.signature);
    const td = typedDataFor(req.chainId, req.pair, req, req);
    recovered = getAddress(await recoverTypedDataAddress({ ...td, signature: sig } as never));
    if (recovered !== getAddress(req.signer)) add("signature", `the signature is by ${recovered}, not ${getAddress(req.signer)}, for these fields`);
    else if (sig !== req.signature.toLowerCase()) add("signature", NON_CANONICAL);
  } catch {
    add("signature", "the signature does not recover");
  }

  const [nonce, now, limits] = await Promise.all([readMetaTxNonce(ctx, req.pair, req.signer), chainTime(ctx), eip712Limits(ctx)]);
  if (now > req.deadline) add("deadline", `expired ${now - req.deadline} s ago`);
  if (req.deadline > now + limits.maxDeadlineWindow) add("deadline", `more than ${limits.maxDeadlineWindow} s ahead of chain time`);
  if (req.nonce !== nonce) {
    add("nonce", req.nonce < nonce ? `nonce ${req.nonce} is already used (next is ${nonce})` : `nonce ${req.nonce} is ahead of the signer's next nonce ${nonce}: an earlier request has to land first`);
  }

  if (req.permitData !== "0x") {
    if (req.action === "withdrawCollateral") add("permitData", "a withdrawal takes no permit");
    else {
      const pull = await relayedPull(ctx, req.pair, req.signer, req, fee);
      const p = await checkPermit(ctx, req.permitData, { owner: req.signer, spender: req.pair, needUsdc: toUsdcUnitsCeil(pull) });
      for (const w of p.problems) warnings.push(`permit: ${w}; the call then needs an existing allowance`);
    }
  }
  return { ok: problems.length === 0, signer: recovered, problems, warnings, secondsLeft: req.deadline - now };
}

/**
 * The call a relayer sends for a request, from its own account (`relayer`): the signed fields, the
 * signature and permit, plus what sits outside the signature, built now: a fresh price update for
 * the actions that take one (`value` its Pyth fee, which the relayer pays) and, for createOrder,
 * fresh MatchHints (or `hints`). `pullsUsdc` is what the call takes from the SIGNER's wallet. Send it
 * at once; the deadline allows seconds.
 */
export async function encodeRelayed(ctx: BazaarContext, req: RelayedRequest, opts: { relayer?: Address; hints?: MatchHints } = {}): Promise<PreparedCall> {
  if (req.chainId !== ctx.chainId) throw new InputError("chainId", `This request was signed for chain ${req.chainId}, not ${ctx.chainId}.`);
  // Submit exactly the signature verifyRelayed accepts: the canonical one, or nothing.
  let signature: Hex;
  try {
    signature = normalizeSignature(req.signature);
  } catch {
    throw new InputError("signature", "That is not a signature the pair can verify.");
  }
  if (signature !== req.signature.toLowerCase()) throw new InputError("signature", NON_CANONICAL);
  const pair = await requirePair(ctx, req.pair);
  const fee = chargedFee(req.relayerFee);
  const alwaysPriced = req.action === "createOrder" || req.action === "amendOrders";
  const freshP = takesPriceUpdate(req.action)
    ? optionalUpdate(ctx, pair, undefined, async () => alwaysPriced)
    : Promise.resolve({ update: [] as Hex[], fee: 0n, publishTime: null, attached: false, reason: null });
  const hintsP: Promise<MatchHints | undefined> =
    req.action === "createOrder" ? (opts.hints ? Promise.resolve(opts.hints) : matchHintsFor(ctx, pair, req.spec, 0)) : Promise.resolve(undefined);
  const terminalP = req.action === "withdrawCollateral" ? terminalWithdrawal(ctx, pair, req.signer, req.amount) : Promise.resolve(null);
  const pullP = req.action === "withdrawCollateral" ? terminalP.then((t) => withdrawalPull(fee, t)) : relayedPull(ctx, pair, req.signer, req, fee);
  const [fresh, hints, pull, terminal] = await Promise.all([freshP, hintsP, pullP, terminalP]);
  const data = encodePairWrite(
    req,
    { priceUpdate: fresh.update, ...(hints ? { hints } : {}) },
    { nonce: req.nonce, deadline: BigInt(req.deadline), relayerFee: req.relayerFee, signature, permitData: req.permitData },
  );
  const paid = terminal ? ` (${terminalPayoutNote(terminal.payout, terminal.principalRatio)})` : "";
  return {
    action: req.action,
    to: pair,
    data,
    value: fresh.fee,
    from: opts.relayer ? getAddress(opts.relayer) : null,
    summary: `Relay for ${getAddress(req.signer)}: ${describeRelayed(req)}${paid} (fee ${formatUnits18(req.relayerFee, 6)} USDC)`,
    ...priceFields(fresh),
    pullsUsdc: pull,
  };
}

/** One line describing what a request does. */
export function describeRelayed(req: SignedFields): string {
  const usdc = (v: bigint) => formatUnits18(v, 6);
  switch (req.action) {
    case "depositCollateral":
      return `deposit ${usdc(req.amount)} USDC collateral`;
    case "withdrawCollateral":
      return `withdraw ${usdc(req.amount)} USDC collateral`;
    case "depositToInsurance":
      return `deposit ${usdc(req.amount)} USDC into insurance`;
    case "requestInsuranceWithdrawal":
      return `request withdrawal of ${usdc(req.shareAmount)} insurance shares`;
    case "executeInsuranceWithdrawal":
      return "execute an insurance withdrawal";
    case "createOrder":
      return describeOrder(req.spec);
    case "cancelOrders":
      return `cancel ${req.orderIds.length} order${req.orderIds.length === 1 ? "" : "s"}`;
    case "amendOrders":
      return `amend ${req.amends.length / 3} order${req.amends.length === 3 ? "" : "s"}`;
  }
}

// ---- wire format ----

/** The request as JSON for the POST to a relayer: integers as decimal strings. */
export function serializeRelayed(req: RelayedRequest): string {
  return JSON.stringify(req, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const big = (v: unknown, field: string): bigint => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  throw new InputError(field, "expected a non-negative integer");
};
const num = (v: unknown, field: string): number => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new InputError(field, "expected a non-negative integer");
  return n;
};
const hex = (v: unknown, field: string): Hex => {
  if (typeof v !== "string" || !isHex(v) || v.length % 2 !== 0) throw new InputError(field, "expected 0x-prefixed hex bytes");
  return v.toLowerCase() as Hex;
};
const addr = (v: unknown, field: string): Address => {
  try {
    return getAddress(v as string);
  } catch {
    throw new InputError(field, "expected an address");
  }
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new InputError(field, "expected true or false");
  return v;
};
/** The signature in the one form the pair accepts (65 bytes, v 27/28, low s), or an InputError. */
const sig = (v: unknown, field: string): Hex => {
  const h = hex(v, field);
  try {
    return normalizeSignature(h);
  } catch {
    throw new InputError(field, "expected an ECDSA signature the pair can verify (65-byte r‖s‖v or 64-byte compact, low s)");
  }
};

/**
 * A request from JSON (or an already-parsed body), every field checked for type and shape. The
 * signature is canonicalized (v 0/1 and EIP-2098 compact forms become the 65-byte, v 27/28 form the
 * pair accepts; a high-s one is refused), so what {@link verifyRelayed} checks is what
 * {@link encodeRelayed} submits. It does not verify the signature: call {@link verifyRelayed}.
 */
export function parseRelayed(body: string | Record<string, unknown>): RelayedRequest {
  const o = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new InputError("body", "expected a JSON object");
  const action = o.action as RelayedAction;
  if (!(RELAYED_ACTIONS as readonly string[]).includes(action)) throw new InputError("action", "not a gasless action");
  const head = {
    pair: addr(o.pair, "pair"),
    chainId: num(o.chainId, "chainId"),
    signer: addr(o.signer, "signer"),
    nonce: big(o.nonce, "nonce"),
    deadline: num(o.deadline, "deadline"),
    relayerFee: big(o.relayerFee, "relayerFee"),
    signature: sig(o.signature, "signature"),
    permitData: o.permitData === undefined ? ("0x" as Hex) : hex(o.permitData, "permitData"),
  };
  const list = (v: unknown, field: string) => {
    if (!Array.isArray(v)) throw new InputError(field, "expected an array");
    return v.map((x, i) => big(x, `${field}[${i}]`));
  };
  switch (action) {
    case "depositCollateral":
    case "withdrawCollateral":
    case "depositToInsurance":
      return { action, amount: big(o.amount, "amount"), ...head };
    case "requestInsuranceWithdrawal":
      return { action, shareAmount: big(o.shareAmount, "shareAmount"), ...head };
    case "executeInsuranceWithdrawal":
      return { action, ...head };
    case "cancelOrders":
      return { action, orderIds: list(o.orderIds, "orderIds"), ...head };
    case "amendOrders":
      return { action, amends: list(o.amends, "amends"), ...head };
    case "createOrder": {
      const s = o.spec as Record<string, unknown> | undefined;
      if (!s || typeof s !== "object") throw new InputError("spec", "expected the order spec");
      const spec: OrderSpec = {
        orderType: num(s.orderType, "spec.orderType") as OrderSpec["orderType"],
        isLong: bool(s.isLong, "spec.isLong"),
        isPostOnly: bool(s.isPostOnly, "spec.isPostOnly"),
        tif: num(s.tif, "spec.tif") as OrderSpec["tif"],
        size: big(s.size, "spec.size"),
        triggerPrice: big(s.triggerPrice, "spec.triggerPrice"),
        limitPrice: big(s.limitPrice, "spec.limitPrice"),
        maxSlippageBp: big(s.maxSlippageBp, "spec.maxSlippageBp"),
        expirationBlock: big(s.expirationBlock, "spec.expirationBlock"),
        integrator: addr(s.integrator, "spec.integrator"),
      };
      return { action, spec, ...head };
    }
  }
}
