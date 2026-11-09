/**
 * Prepared calls: every write the SDK builds, for any contract, as one shape a frontend can simulate,
 * show, and hand to the user's wallet.
 *
 * The SDK never holds a user's key. A frontend sends a PreparedCall with its own wallet stack
 * ({@link toTransactionRequest} for viem/wagmi, or {@link sendCall} over any EIP-1193 provider), and
 * {@link simulate}s it first, as the user, so a revert is explained before anything is signed.
 */

import type { Address, Hex } from "viem";
import { toHex } from "viem";
import type { Receipt } from "../chain/client.js";
import { type DecodedError, decodeError } from "../chain/errors.js";
import { RpcError, type Transport, sleep, toRpcError } from "../chain/rpc.js";
import type { BazaarContext } from "./context.js";

export interface PreparedCall {
  /** The contract function, e.g. "createOrder", "proposeTermination". */
  readonly action: string;
  readonly to: Address;
  readonly data: Hex;
  /** ETH to send: the Pyth update fee when a price update is attached, else 0. */
  readonly value: bigint;
  /** The account the call acts for, when known (the sender of a direct call). */
  readonly from: Address | null;
  /** One line for a confirmation screen. */
  readonly summary: string;
  /**
   * When the call carries a Pyth update: the update's publish time (seconds). The pair refuses a print
   * more than 3 s from the block's time, so a call older than that should be rebuilt before sending.
   */
  readonly priceTime?: number;
  /** USDC the call pulls from the wallet (BAZAAR precision), so the UI can check balance and allowance. */
  readonly pullsUsdc?: bigint;
}

export interface Simulation {
  readonly ok: boolean;
  readonly returnData: Hex;
  /** Why it would revert, decoded, with a message for the user. */
  readonly error: DecodedError | null;
  /** eth_estimateGas, when it succeeded. */
  readonly gas: bigint | null;
}

/** Run the call as `from` (or call.from) without sending it. */
export async function simulate(
  ctx: BazaarContext,
  call: PreparedCall,
  opts: { from?: Address; estimateGas?: boolean } = {},
): Promise<Simulation> {
  const from = opts.from ?? call.from ?? undefined;
  try {
    const returnData = await ctx.chain.call(call.to, call.data, { from: from ?? null, value: call.value });
    let gas: bigint | null = null;
    if (opts.estimateGas !== false && from) {
      try {
        gas = await ctx.chain.estimateGas(from, call.to, call.data, call.value);
      } catch {
        gas = null;
      }
    }
    return { ok: true, returnData, error: null, gas };
  } catch (e) {
    const rpc = e instanceof RpcError ? e : toRpcError(e);
    if (!rpc) throw e;
    return { ok: false, returnData: rpc.revertData ?? "0x", error: decodeError(rpc.revertData), gas: null };
  }
}

/** The call as a viem / wagmi transaction request. */
export function toTransactionRequest(call: PreparedCall): { to: Address; data: Hex; value: bigint; account?: Address } {
  return call.from ? { to: call.to, data: call.data, value: call.value, account: call.from } : { to: call.to, data: call.data, value: call.value };
}

/** An argument a builder refused before building anything: `field` names it. */
export class InputError extends Error {
  override readonly name = "InputError";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

/** A send that reverted or was rejected, with the decoded reason when there is one. */
export class CallError extends Error {
  override readonly name = "CallError";
  constructor(
    message: string,
    readonly decoded: DecodedError | null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Send through an EIP-1193 wallet (eth_sendTransaction). Returns the transaction hash. */
export async function sendCall(wallet: Transport, call: PreparedCall, opts: { from?: Address; gas?: bigint } = {}): Promise<Hex> {
  const from = opts.from ?? call.from;
  if (!from) throw new CallError("sending needs the user's address (from)", null);
  const tx: Record<string, string> = { from, to: call.to, data: call.data, value: toHex(call.value) };
  if (opts.gas !== undefined) tx.gas = toHex(opts.gas);
  try {
    return (await wallet.request({ method: "eth_sendTransaction", params: [tx] })) as Hex;
  } catch (e) {
    const rpc = toRpcError(e);
    const decoded = rpc?.revertData && rpc.revertData !== "0x" ? decodeError(rpc.revertData) : null;
    throw new CallError(decoded ? decoded.message : rpc ? rpc.rpcMessage : String(e), decoded, e);
  }
}

/** Poll for the receipt; throws CallError if it reverted or did not land in time. */
export async function waitForReceipt(
  ctx: BazaarContext,
  hash: Hex,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Receipt> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const poll = opts.pollMs ?? 500;
  for (;;) {
    const r = await ctx.chain.receipt(hash);
    if (r) {
      if (r.status !== "success") throw new CallError(`transaction ${hash} reverted`, null);
      return r;
    }
    if (Date.now() > deadline) throw new CallError(`transaction ${hash} has no receipt after ${(opts.timeoutMs ?? 120_000) / 1000} s`, null);
    await sleep(poll);
  }
}

/**
 * Build, then send at once: for calls carrying a price update, build as late as possible so the print
 * is still inside the pair's 3 s window when the transaction lands. `build` is called right before the
 * wallet is asked to send.
 */
export async function buildAndSend(
  wallet: Transport,
  build: () => Promise<PreparedCall>,
  opts: { from?: Address; gas?: bigint } = {},
): Promise<{ call: PreparedCall; hash: Hex }> {
  const call = await build();
  return { call, hash: await sendCall(wallet, call, opts) };
}
