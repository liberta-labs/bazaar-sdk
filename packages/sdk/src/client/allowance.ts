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

/**
 * The faucet functions of Bazaar's testnet USDC (`TestnetUSDC`, in the protocol repository's
 * test/mocks), hand-written: it is a test token, not one of the five Bazaar ABIs. Native USDC has
 * none of them, so these reads fail on a mainnet deployment and {@link faucetStatus} reports the
 * faucet as absent.
 */
export const FAUCET_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "lastClaimTs", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "FAUCET_AMOUNT", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "FAUCET_COOLDOWN", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

type FaucetFn = (typeof FAUCET_ABI)[number]["name"];

function faucetData(fn: FaucetFn, ...args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: FAUCET_ABI, functionName: fn, args } as never);
}

/** Where an address stands with the deployment's USDC faucet. */
export interface FaucetStatus {
  /** The deployment's USDC has a faucet (a test token). False on native USDC, with every other field 0 or false but `now`. */
  readonly available: boolean;
  /** What one claim pays, in USDC units. */
  readonly amountUsdc: bigint;
  /** Seconds an address waits between claims. */
  readonly cooldown: number;
  /** When the address last claimed (unix seconds), 0 for never. */
  readonly lastClaimTs: number;
  /** The earliest chain time the address may claim: `now` when it may claim now. */
  readonly nextClaimTs: number;
  /** Whether a claim would land now. */
  readonly canClaimNow: boolean;
  /** The latest block's time, which the token compares against. */
  readonly now: number;
}

/**
 * Whether `owner` can claim from the testnet USDC faucet now, and when it can next: the faucet's
 * amount, cooldown and `owner`'s last claim in one batch, judged at the latest block's time. A token
 * without the faucet reads `available: false` rather than throwing.
 */
export async function faucetStatus(ctx: BazaarContext, owner: Address): Promise<FaucetStatus> {
  const who = getAddress(owner);
  const [res, block] = await Promise.all([
    ctx.chain.batch([
      { to: ctx.usdc, data: faucetData("FAUCET_AMOUNT") },
      { to: ctx.usdc, data: faucetData("FAUCET_COOLDOWN") },
      { to: ctx.usdc, data: faucetData("lastClaimTs", who) },
    ]),
    ctx.chain.block("latest"),
  ]);
  const now = block.timestamp;
  const read = (i: number): bigint | null => {
    const [ok, data] = res[i]!;
    // A contract without the function answers empty data (no fallback) or reverts.
    if (!ok || data.length < 66) return null;
    return uint(data);
  };
  const amount = read(0);
  const cooldown = read(1);
  const last = read(2);
  if (amount === null || cooldown === null || last === null || amount === 0n) {
    return { available: false, amountUsdc: 0n, cooldown: 0, lastClaimTs: 0, nextClaimTs: 0, canClaimNow: false, now };
  }
  const next = last === 0n ? now : Math.max(now, Number(last + cooldown));
  return { available: true, amountUsdc: amount, cooldown: Number(cooldown), lastClaimTs: Number(last), nextClaimTs: next, canClaimNow: next <= now, now };
}

/**
 * Claim test USDC from the deployment's testnet faucet: `FAUCET_AMOUNT` (10,000 USDC on Bazaar's
 * token) to `owner`, at most once per `FAUCET_COOLDOWN` (a day) per address. It has no gasless form:
 * `owner` sends it and pays the gas.
 *
 * Refuses up front, with an InputError on `owner`, when the deployment's USDC has no faucet and while
 * `owner` waits out its cooldown (naming when it ends). The token's own revert for the cooldown,
 * `TestnetUSDC__FaucetCooldown`, is not among the errors the SDK decodes, so the check runs here.
 */
export async function claimFaucet(ctx: BazaarContext, owner: Address): Promise<PreparedCall> {
  const s = await faucetStatus(ctx, owner);
  if (!s.available) throw new InputError("owner", "This deployment's USDC has no faucet: it is not a test token.");
  if (!s.canClaimNow) {
    const minutes = Math.ceil((s.nextClaimTs - s.now) / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const at = new Date(s.nextClaimTs * 1000).toISOString().slice(0, 16).replace("T", " ");
    throw new InputError("owner", `This address claimed test USDC recently. It can claim again at ${at} UTC (in ${h > 0 ? `${h} h ` : ""}${m} min).`);
  }
  return {
    action: "claim",
    to: ctx.usdc,
    data: faucetData("claim"),
    value: 0n,
    from: getAddress(owner),
    summary: `Claim ${formatUsdcUnits(s.amountUsdc)} test USDC from the faucet`,
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
