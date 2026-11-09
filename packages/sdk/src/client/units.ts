/**
 * Units at the boundary between people and the contracts.
 *
 * The pair takes and reports amounts in BAZAAR precision (18 decimals, 1e18 = $1 or one unit) and
 * floors them to USDC's 6 decimals when it moves cash. USDC's own calls (balanceOf, allowance, approve,
 * permit) are in USDC units (6 decimals).
 */

import { BAZAAR_SCALE, USDC_TO_BAZAAR } from "../constants.js";

/** BAZAAR precision -> USDC units, floored as the pair floors it. */
export function toUsdcUnits(amount: bigint): bigint {
  return amount / USDC_TO_BAZAAR;
}

/** USDC units -> BAZAAR precision. */
export function fromUsdcUnits(amount: bigint): bigint {
  return amount * USDC_TO_BAZAAR;
}

/** BAZAAR precision rounded up to the next whole USDC unit (for allowances and permits that must cover it). */
export function toUsdcUnitsCeil(amount: bigint): bigint {
  return (amount + USDC_TO_BAZAAR - 1n) / USDC_TO_BAZAAR;
}

/** Floor to what the pair actually moves: a multiple of 1e12 (one micro-USDC). */
export function floorToUsdc(amount: bigint): bigint {
  return amount - (amount % USDC_TO_BAZAAR);
}

export class UnitError extends Error {
  override readonly name = "UnitError";
}

/** A decimal string ("12.5", "1e-3" is refused) -> fixed point with `decimals` (default 18). Throws on more decimals than fit. */
export function parseDecimal(value: string, decimals = 18): bigint {
  const v = value.trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new UnitError(`${JSON.stringify(value)} is not a decimal number`);
  const frac = m[3] ?? "";
  if (frac.length > decimals) throw new UnitError(`${JSON.stringify(value)} has more than ${decimals} decimals`);
  const n = BigInt((m[2] || "0") + frac.padEnd(decimals, "0"));
  return m[1] ? -n : n;
}

/** Fixed point -> decimal string, trimming trailing zeros; `maxDecimals` rounds toward zero. */
export function formatDecimal(value: bigint, decimals = 18, maxDecimals?: number): string {
  const neg = value < 0n;
  let v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  let whole = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0");
  if (maxDecimals !== undefined && maxDecimals < decimals) frac = frac.slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");
  if (whole === 0n && frac === "") v = 0n;
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg && v !== 0n ? `-${s}` : s;
}

/** "12.34" dollars or units -> BAZAAR precision. */
export const parseUnits18 = (value: string) => parseDecimal(value, 18);
/** BAZAAR precision -> "12.34". */
export const formatUnits18 = (value: bigint, maxDecimals?: number) => formatDecimal(value, 18, maxDecimals);

/** Basis points -> a fraction as a number (for display only). */
export const bpToFraction = (bp: bigint) => Number(bp) / 10_000;

/** A BAZAAR-precision value as a JS number (display only: loses precision past 2^53 / 1e18). */
export const toNumber18 = (value: bigint) => Number(value) / Number(BAZAAR_SCALE);
