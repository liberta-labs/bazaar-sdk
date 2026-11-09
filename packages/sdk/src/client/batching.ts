/**
 * Several PreparedCalls in one transaction, from a smart account.
 *
 * Bazaar has no batch form of createOrder: each order is one call (cancelOrders and amendOrders are
 * batched already, up to 200 and 32). A contract account that calls the pair several times in one
 * transaction gets most of what a batch entry point would (docs/guide/batching.md): one
 * transaction's overhead, warm storage for the second and later calls, one price store. The account
 * is then the trader: collateral, positions, resting orders and claimable fees belong to its address,
 * so build every call with `from` = the account, approve USDC to the pair from the account (or have
 * the batch do it), and claim through the account.
 *
 * What still holds per order, because the pair sees ordinary calls:
 * - The account is one trader: one net position per market, 32 active Limit + StopLimit orders, one
 *   TakeProfit and one StopLoss, shared by everything it does.
 * - Its own orders never fill each other: a later order that crosses an earlier one is a self-match
 *   and is cancelled. Quote both sides at prices that do not cross.
 * - An auto-cancel (margin, self-match) returns normally and the batch goes on; a fill-or-kill that
 *   cannot fill, a bad hint, or a margin failure at creation reverts the call and the whole batch.
 * - Gas per order is unchanged: a crossing order can walk 32 makers at ~90k gas each, so keep batches
 *   of takers short (about nine full walks reach Arbitrum's 32M per-transaction limit).
 * - Hints are computed per order against the live book (trade.ts does), right before submitting.
 * - Meta-transaction fields stay empty: the account submits for itself. Bazaar's gasless path checks a
 *   plain ECDSA signature, so a smart account cannot sign relayed requests; it sends directly.
 *
 * Two ways to submit: a wallet that batches natively (EIP-5792 `wallet_sendCalls`, which ERC-4337
 * accounts, Safes and many smart wallets speak) with {@link sendCalls}, or the example
 * BazaarTradingAccount contract (examples/BazaarTradingAccount.sol) with {@link tradingAccountExecute}.
 */

import { type Address, type Hex, decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, toHex } from "viem";
import { bazaarPairAbi } from "../abi/index.js";
import { pair as pairCodec } from "../chain/codec.js";
import { type Transport, toRpcError } from "../chain/rpc.js";
import { CallError, InputError, type PreparedCall } from "./calls.js";
import type { BazaarContext } from "./context.js";

/** The generic call shape smart wallets take (ERC-4337 / Safe / EIP-5792). */
export interface BatchCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** The calls in the generic shape, in order. */
export function toBatchCalls(calls: readonly PreparedCall[]): BatchCall[] {
  return calls.map((c) => ({ to: getAddress(c.to), data: c.data, value: c.value }));
}

/** ETH the batch needs: the sum of the calls' values (Pyth fees). */
export function batchValue(calls: readonly { value: bigint }[]): bigint {
  return calls.reduce((s, c) => s + c.value, 0n);
}

// The pair functions whose call always resolves, and so stores, a fresh price when it carries one.
const PRICE_STORING = new Set(["createOrder", "amendOrders", "executeTriggeredOrders", "refreshPrice"]);

/**
 * Carry the Pyth update once per pair: the first call that always stores a price (createOrder,
 * amendOrders, executeTriggeredOrders, refreshPrice) keeps its update and fee; later calls in the
 * batch to the same pair are re-encoded with an empty `priceUpdate` and no ETH, since they find the
 * price that call stored (the pair reads the on-chain price first and parses an update only when it
 * is more than 3 s old). Calls to other contracts are left as they are. The batch must run in one
 * transaction, in this order.
 */
export function shareOnePriceUpdate(calls: readonly PreparedCall[]): PreparedCall[] {
  const pc = pairCodec();
  const stored = new Set<Address>();
  return calls.map((c) => {
    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: bazaarPairAbi, data: c.data }) as typeof decoded;
    } catch {
      return c; // not a pair call
    }
    const idx = pc.fn(decoded.functionName).inputs.findIndex((p) => p.name === "priceUpdate");
    if (idx < 0) return c;
    const args = [...(decoded.args ?? [])];
    const key = getAddress(c.to);
    if (stored.has(key)) {
      if ((args[idx] as readonly Hex[]).length === 0) return c;
      args[idx] = [];
      const { priceTime: _unused, ...rest } = c;
      return { ...rest, data: pc.encode(decoded.functionName, ...args), value: 0n };
    }
    if (PRICE_STORING.has(decoded.functionName) && (args[idx] as readonly Hex[]).length > 0) stored.add(key);
    return c;
  });
}

// ---- EIP-5792 ----

export interface SendCallsOptions {
  /** Require the wallet to run the calls atomically (default true: a Bazaar batch is meant as one). */
  readonly atomicRequired?: boolean;
  /** Wallet capabilities (paymaster service and the like), passed through. */
  readonly capabilities?: Record<string, unknown>;
  /** EIP-5792 request version; default "2.0.0". */
  readonly version?: string;
}

/** The `wallet_sendCalls` request for these calls from `from` (the smart account). */
export function walletSendCallsRequest(ctx: BazaarContext, from: Address, calls: readonly PreparedCall[], opts: SendCallsOptions = {}) {
  if (!calls.length) throw new InputError("calls", "Nothing to send.");
  return {
    method: "wallet_sendCalls" as const,
    params: [
      {
        version: opts.version ?? "2.0.0",
        chainId: toHex(ctx.chainId),
        from: getAddress(from),
        atomicRequired: opts.atomicRequired ?? true,
        calls: toBatchCalls(calls).map((c) => ({ to: c.to, data: c.data, value: toHex(c.value) })),
        ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      },
    ],
  };
}

/**
 * Send the calls as one batch through an EIP-5792 wallet. Returns the wallet's batch id (track it
 * with `wallet_getCallsStatus`, {@link getCallsStatus}). Build price-carrying calls right before this.
 */
export async function sendCalls(wallet: Transport, ctx: BazaarContext, from: Address, calls: readonly PreparedCall[], opts: SendCallsOptions = {}): Promise<string> {
  try {
    const r = await wallet.request(walletSendCallsRequest(ctx, from, calls, opts));
    if (typeof r === "string") return r;
    if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") return (r as { id: string }).id;
    throw new CallError("the wallet returned no batch id", null);
  } catch (e) {
    if (e instanceof CallError) throw e;
    const rpc = toRpcError(e);
    throw new CallError(rpc ? rpc.rpcMessage : String(e), null, e);
  }
}

/** `wallet_getCallsStatus` for a batch id, as the wallet reports it. */
export async function getCallsStatus(wallet: Transport, id: string): Promise<unknown> {
  return wallet.request({ method: "wallet_getCallsStatus", params: [id] });
}

// ---- BazaarTradingAccount (examples/BazaarTradingAccount.sol) ----

/** The example account's interface, hand-written from examples/BazaarTradingAccount.sol. */
export const TRADING_ACCOUNT_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "error", name: "BazaarTradingAccount__NotOwner", inputs: [] },
  { type: "error", name: "BazaarTradingAccount__ZeroOwner", inputs: [] },
] as const;

/** `execute(Call[] calls)` calldata, each call as (target, value, data). */
export function encodeTradingAccountExecute(calls: readonly BatchCall[]): Hex {
  if (!calls.length) throw new InputError("calls", "Nothing to send.");
  return encodeFunctionData({
    abi: TRADING_ACCOUNT_ABI,
    functionName: "execute",
    args: [calls.map((c) => ({ target: getAddress(c.to), value: c.value, data: c.data }))],
  });
}

/**
 * One transaction through a BazaarTradingAccount: `execute` runs the calls in order as the account,
 * with `value` = the sum of their values (the account forwards each call's own; the pair refunds any
 * unspent Pyth fee to the account). The first call that fails reverts the batch with that call's own
 * revert data, so a simulation decodes like a direct call's. Only the account's `owner` may call it;
 * build the inner calls with `from` = the account. `pullsUsdc` sums what the inner calls pull, which
 * comes from the ACCOUNT's USDC (and its allowance to each pair), not the owner's wallet.
 */
export function tradingAccountExecute(account: Address, owner: Address, calls: readonly PreparedCall[]): PreparedCall {
  const batch = toBatchCalls(calls);
  const times = calls.map((c) => c.priceTime).filter((t): t is number => t !== undefined);
  const pulls = calls.reduce((s, c) => s + (c.pullsUsdc ?? 0n), 0n);
  return {
    action: "execute",
    to: getAddress(account),
    data: encodeTradingAccountExecute(batch),
    value: batchValue(batch),
    from: getAddress(owner),
    summary: calls.length === 1 ? calls[0]!.summary : `${calls.length} calls: ${calls.map((c) => c.summary).join("; ")}`,
    ...(times.length ? { priceTime: Math.min(...times) } : {}),
    pullsUsdc: pulls,
  };
}

/** The per-call return data `execute` returns. */
export function decodeTradingAccountResults(returnData: Hex): Hex[] {
  return [...decodeAbiParameters([{ type: "bytes[]" }], returnData)[0]];
}

/** The account's owner (who alone may call execute). */
export async function readTradingAccountOwner(ctx: BazaarContext, account: Address): Promise<Address> {
  const data = encodeFunctionData({ abi: TRADING_ACCOUNT_ABI, functionName: "owner" });
  return getAddress(decodeAbiParameters([{ type: "address" }], await ctx.chain.call(getAddress(account), data))[0]);
}
