/**
 * USDC balance and allowance, and the approve call a direct deposit or a trigger bounty needs.
 *
 * Every amount here is in USDC units (6 decimals), as the token counts. The pair's own calls take
 * BAZAAR precision (18 decimals) and pull what they move floored to whole USDC units; convert with
 * units.ts (`toUsdcUnitsCeil` for what an allowance has to cover). `PreparedCall.pullsUsdc` reports a
 * pair call's pull in BAZAAR precision; {@link usdcFunding} checks a wallet against it.
 *
 * Approve or permit? An approve is a transaction of its own; a permit (permits.ts) is a signature the
 * pair call carries, so a gasless user never needs ETH. Either way the allowance names the pair as
 * spender: each pair pulls for itself.
 */

import { type Address, type Hex, decodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import { MAX_UINT256 } from "../constants.js";
import { InputError, type PreparedCall } from "./calls.js";
import type { BazaarContext } from "./context.js";
import { requirePair } from "./guard.js";
import { toUsdcUnitsCeil } from "./units.js";

/** The ERC-20 / ERC-2612 functions the SDK calls on USDC, hand-written (USDC is not a Bazaar ABI). */
export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
] as const;

type Erc20Fn = (typeof ERC20_ABI)[number]["name"];

/** Calldata for one of the ERC-20 functions above. */
export function erc20Data(fn: Erc20Fn, ...args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: fn, args } as never);
}

const uint = (d: Hex) => decodeAbiParameters([{ type: "uint256" }], d)[0];

/** The owner's USDC balance, in USDC units. */
export async function usdcBalance(ctx: BazaarContext, owner: Address): Promise<bigint> {
  return uint(await ctx.chain.call(ctx.usdc, erc20Data("balanceOf", getAddress(owner))));
}

/** What `spender` (a pair) may pull from `owner`, in USDC units. */
export async function usdcAllowance(ctx: BazaarContext, owner: Address, spender: Address): Promise<bigint> {
  return uint(await ctx.chain.call(ctx.usdc, erc20Data("allowance", getAddress(owner), getAddress(spender))));
}

/**
 * Approve `spender` (a pair) to pull `amountUsdc` (USDC units) from `owner`'s wallet. The approval
 * replaces any earlier one and is spent down by each pull.
 *
 * Exact amounts are the default on purpose. An unlimited approval saves an approve per deposit, but
 * leaves the whole wallet balance pullable by that contract for as long as the approval stands: a
 * frontend that offers it should say so, and let the user revoke it (approve 0). Pass
 * `{ unlimited: true }` (with `amountUsdc` ignored) only on the user's explicit choice.
 *
 * `spender` must be a pair of this deployment (guard.ts `requirePair`): an approval for anything
 * else is refused (InputError on `pair`), revocations included, so a link cannot pass off another
 * contract as a market.
 */
export async function approveUsdc(
  ctx: BazaarContext,
  owner: Address,
  spender: Address,
  amountUsdc: bigint,
  opts: { unlimited?: boolean } = {},
): Promise<PreparedCall> {
  const value = opts.unlimited ? MAX_UINT256 : amountUsdc;
  if (value < 0n || value > MAX_UINT256) throw new InputError("amount", "That amount is out of range.");
  spender = await requirePair(ctx, spender);
  const shown = opts.unlimited ? "an unlimited amount of" : value === 0n ? "no" : `${formatUsdcUnits(value)}`;
  return {
    action: "approve",
    to: ctx.usdc,
    data: erc20Data("approve", spender, value),
    value: 0n,
    from: getAddress(owner),
    summary: value === 0n ? `Revoke ${spender}'s USDC allowance` : `Allow ${spender} to take ${shown} USDC from your wallet`,
    pullsUsdc: 0n,
  };
}

/** USDC units -> "12.5". */
export function formatUsdcUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface UsdcFunding {
  /** What the call pulls, in USDC units (rounded up). */
  readonly needUsdc: bigint;
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly enoughBalance: boolean;
  readonly enoughAllowance: boolean;
  /** USDC units to approve (0 when the allowance already covers it). */
  readonly approveUsdc: bigint;
}

/**
 * Whether `owner` can fund a pull of `pullBazaar` (BAZAAR precision, e.g. `PreparedCall.pullsUsdc`)
 * to `spender`: balance and allowance in one read.
 */
export async function usdcFunding(ctx: BazaarContext, owner: Address, spender: Address, pullBazaar: bigint): Promise<UsdcFunding> {
  const needUsdc = toUsdcUnitsCeil(pullBazaar);
  const res = await ctx.chain.batch([
    { to: ctx.usdc, data: erc20Data("balanceOf", getAddress(owner)) },
    { to: ctx.usdc, data: erc20Data("allowance", getAddress(owner), getAddress(spender)) },
  ]);
  if (!res.every(([ok]) => ok)) throw new Error(`could not read the USDC balance of ${owner}`);
  const balance = uint(res[0]![1]);
  const allowance = uint(res[1]![1]);
  return {
    needUsdc,
    balance,
    allowance,
    enoughBalance: balance >= needUsdc,
    enoughAllowance: allowance >= needUsdc,
    approveUsdc: allowance >= needUsdc ? 0n : needUsdc,
  };
}
