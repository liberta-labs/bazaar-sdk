/**
 * Pyth accumulator updates ("PNAU"): parse them, and re-encode one with only some of its feeds.
 *
 * An accumulator update carries one signed Merkle root (inside its VAA) and, per feed, the price
 * message and a proof against that root. Each feed's proof stands alone, so dropping feeds leaves a
 * valid update: a pair's call then verifies only its own legs, not every feed the stream carried.
 *
 * Layout (big-endian): "PNAU", major u8, minor u8, trailing-header size u8 + bytes, update type u8
 * (0 = WormholeMerkle), VAA size u16 + VAA, update count u8, then per update: message size u16 +
 * message, proof size u8 + proof size × 20-byte nodes. A price message is: type u8 (0), feed id 32,
 * price i64, conf u64, expo i32, publish time i64, previous publish time i64, EMA price i64, EMA conf
 * u64.
 *
 * Blobs are viem `Hex` strings, and the re-encoding works on that text directly: a subset is the
 * blob's signed prefix, a new count and the kept updates, sliced out of the blob and joined, so cutting
 * a pair's update out of a stream message never round-trips through bytes.
 */

import type { Hex } from "viem";

/** "PNAU" */
export const MAGIC: Hex = "0x504e4155";
const MAGIC_HEX = "504e4155";

export class AccumulatorError extends Error {
  override readonly name = "AccumulatorError";
}

export interface PriceMessage {
  readonly feedId: Hex;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: number;
  readonly prevPublishTime: number;
  readonly emaPrice: bigint;
  readonly emaConf: bigint;
}

export interface AccumulatorUpdate {
  /** the update's bytes as the blob holds them: message size, message, proof */
  readonly raw: Hex;
  /** its price message, or null when it is not one */
  readonly message: PriceMessage | null;
}

export class Accumulator {
  constructor(
    /** everything before the update count: header, trailing header, type, VAA */
    readonly prefix: Hex,
    readonly updates: readonly AccumulatorUpdate[],
  ) {}

  feedIds(): Hex[] {
    const out: Hex[] = [];
    for (const u of this.updates) if (u.message !== null) out.push(u.message.feedId);
    return out;
  }
}

// ---- the layout, found once per blob ----

/**
 * Where each part of a blob sits, as offsets into its hex text. Found once per blob (the stream's
 * parser keeps it with the prints it maps), so each pair's subset after that only slices and joins.
 * @internal
 */
export interface Scan {
  /** the whole blob: lowercase, 0x-prefixed */
  readonly hex: Hex;
  /** the blob up to (not including) the update count */
  readonly prefix: Hex;
  readonly updates: readonly ScanUpdate[];
}

/** @internal */
export interface ScanUpdate {
  /** null when the update's message is not a price message */
  readonly feedId: Hex | null;
  /** the update's hex text is `hex.slice(from, to)` */
  readonly from: number;
  readonly to: number;
}

const LOWER = /^[0-9a-f]*$/;
const LOWER_FROM_2 = /[0-9a-f]*$/y; // sticky: tested from lastIndex 2, past a 0x, without slicing
const ANY_HEX = /^[0-9a-fA-F]*$/;

/**
 * Lowercase, 0x-prefixed form of hex text given with or without 0x, or null when it is not an even
 * number of hex digits. Returns its argument unchanged when it is already in that form. Lowercase
 * input (what Hermes sends) costs one scan and no copy.
 * @internal
 */
export function normalizeHex(h: string): Hex | null {
  if ((h.length & 1) !== 0) return null;
  const prefixed = h.length >= 2 && h.charCodeAt(0) === 48 && (h.charCodeAt(1) | 0x20) === 120;
  if (prefixed && h.charCodeAt(1) === 120) {
    LOWER_FROM_2.lastIndex = 2;
    if (LOWER_FROM_2.test(h)) return h as Hex;
  } else if (!prefixed && LOWER.test(h)) {
    return `0x${h}`;
  }
  const body = prefixed ? h.slice(2) : h;
  return ANY_HEX.test(body) ? `0x${body.toLowerCase()}` : null;
}

function blobHex(blob: string): Hex {
  const h = normalizeHex(blob);
  if (h === null) throw new AccumulatorError("update data is not hex");
  return h;
}

function nibble(c: number): number {
  return c <= 57 ? c - 48 : (c | 0x20) - 87;
}

/** Byte `i` of validated hex text (0x-prefixed). */
function byteAt(hex: string, i: number): number {
  const p = 2 + 2 * i;
  return (nibble(hex.charCodeAt(p)) << 4) | nibble(hex.charCodeAt(p + 1));
}

function u8(hex: string, size: number, i: number): number {
  if (i >= size) throw new AccumulatorError("malformed accumulator update: index out of range");
  return byteAt(hex, i);
}

function u16(hex: string, size: number, i: number): number {
  if (i + 2 > size) throw new AccumulatorError("malformed accumulator update: unpack requires a buffer of 2 bytes");
  return (byteAt(hex, i) << 8) | byteAt(hex, i + 1);
}

export function isAccumulator(blob: Hex | string): boolean {
  const o = blob.length >= 2 && blob.charCodeAt(0) === 48 && (blob.charCodeAt(1) | 0x20) === 120 ? 2 : 0;
  if (blob.length < o + 8) return false;
  for (let k = 0; k < 8; k++) if ((blob.charCodeAt(o + k) | 0x20) !== MAGIC_HEX.charCodeAt(k)) return false;
  return true;
}

/**
 * The layout of a blob already in normalized form (see {@link normalizeHex}).
 * @internal
 */
export function scan(hex: Hex): Scan {
  if (!isAccumulator(hex)) throw new AccumulatorError("not an accumulator update");
  const size = (hex.length - 2) >>> 1;
  let i = 6; // magic, major, minor
  const trailing = u8(hex, size, i);
  i += 1 + trailing;
  const type = u8(hex, size, i);
  if (type !== 0) throw new AccumulatorError(`unsupported update type ${type}`);
  i += 1;
  const vaaSize = u16(hex, size, i);
  i += 2 + vaaSize;
  const prefixEnd = i;
  const count = u8(hex, size, i);
  i += 1;
  const updates: ScanUpdate[] = [];
  for (let k = 0; k < count; k++) {
    const start = i;
    const msize = u16(hex, size, i);
    const msg = i + 2;
    i += 2 + msize;
    const proofLen = u8(hex, size, i); // past the message, so the message is all there
    i += 1 + 20 * proofLen;
    if (i > size) throw new AccumulatorError("truncated update");
    const feedId: Hex | null = msize >= 85 && byteAt(hex, msg) === 0 ? `0x${hex.slice(4 + 2 * msg, 4 + 2 * (msg + 32))}` : null;
    updates.push({ feedId, from: 2 + 2 * start, to: 2 + 2 * i });
  }
  return { hex, prefix: hex.slice(0, 2 + 2 * prefixEnd) as Hex, updates };
}

/**
 * The same update carrying only `feedIds`, in the order the blob holds them, from its layout.
 * @internal
 */
export function subsetOf(s: Scan, feedIds: Iterable<Hex>): Hex {
  // feed id -> whether the blob's update for it is kept yet: a feed the blob carries twice is cut
  // once (its first update, the one parseResponse reads), and every asked feed must be found.
  const want = new Map<string, boolean>();
  for (const f of feedIds) want.set(f.toLowerCase(), false);
  let kept = "";
  let n = 0;
  for (const u of s.updates) {
    if (u.feedId !== null && want.get(u.feedId) === false) {
      want.set(u.feedId, true);
      kept += s.hex.slice(u.from, u.to);
      n++;
    }
  }
  if (n !== want.size) {
    const missing = [...want].filter(([, found]) => !found).map(([f]) => f.slice(2));
    throw new AccumulatorError(`update does not carry feed(s) ${missing.join(", ")}`);
  }
  return `${s.prefix}${hexByte(n)}${kept}` as Hex;
}

// ---- the public API ----

const PRICE_MESSAGE_SIZE = 85;

/**
 * The largest exponent magnitude a price may carry. Pyth's feeds use -5 to -12; anything past ±30
 * is refused, so converting a price to 18 decimals never builds an outsized power of ten.
 */
export const MAX_EXPO = 30;

function fieldAt(hex: string, byte: number, bytes: number): bigint {
  const p = 2 + 2 * byte;
  return BigInt(`0x${hex.slice(p, p + 2 * bytes)}`);
}

// The fields are read from the hex text's character codes, without slicing or parsing it: a stream
// message carries one price message per watched feed, and this runs for each.

/** The 4 bytes at `byte` of validated hex text, as an unsigned number. */
function u32At(hex: string, byte: number): number {
  let p = 2 + 2 * byte;
  let v = 0;
  for (let k = 0; k < 8; k++) v = (v << 4) | nibble(hex.charCodeAt(p++));
  return v >>> 0;
}

const TWO_32 = 0x1_0000_0000;
const SAFE_HI = 0x200000; // a high word below this keeps a u64 under 2^53

/** An i64 field as a number: -1 unless it is a non-negative safe integer (below 2^53). */
function timeAt(hex: string, byte: number): number {
  const hi = u32At(hex, byte);
  return hi < SAFE_HI ? hi * TWO_32 + u32At(hex, byte + 4) : -1;
}

function u64At(hex: string, byte: number): bigint {
  const hi = u32At(hex, byte);
  return hi < SAFE_HI ? BigInt(hi * TWO_32 + u32At(hex, byte + 4)) : fieldAt(hex, byte, 8);
}

function i64At(hex: string, byte: number): bigint {
  const hi = u32At(hex, byte);
  if (hi < SAFE_HI) return BigInt(hi * TWO_32 + u32At(hex, byte + 4));
  if (hi >= TWO_32 - SAFE_HI) return BigInt((hi - TWO_32) * TWO_32 + u32At(hex, byte + 4)); // small negatives
  return BigInt.asIntN(64, fieldAt(hex, byte, 8));
}

/** A price message's fields but its feed id and EMA: what a print needs. @internal */
export interface MessageCore {
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: number;
  readonly prevPublishTime: number;
}

/** Byte offset, in its blob, of an update's price message (past the update's 2-byte size). @internal */
export function messageAt(u: ScanUpdate): number {
  return (u.from - 2) / 2 + 2;
}

/**
 * The price message at byte `msg` of validated hex text (the bytes are known to be there), checked:
 * the exponent within ±{@link MAX_EXPO}, the publish times non-negative safe integers. Throws
 * AccumulatorError otherwise.
 * @internal
 */
export function readCore(hex: string, msg: number): MessageCore {
  const expo = u32At(hex, msg + 49) | 0;
  const publishTime = timeAt(hex, msg + 53);
  const prevPublishTime = timeAt(hex, msg + 61);
  if (expo > MAX_EXPO || expo < -MAX_EXPO || publishTime < 0 || prevPublishTime < 0) {
    const what = publishTime < 0 || prevPublishTime < 0 ? "a publish time out of range" : `exponent ${expo}, outside ±${MAX_EXPO}`;
    throw new AccumulatorError(`price message for feed 0x${hex.slice(4 + 2 * msg, 12 + 2 * msg)}… has ${what}`);
  }
  return { price: i64At(hex, msg + 33), conf: u64At(hex, msg + 41), expo, publishTime, prevPublishTime };
}

function readMessage(hex: string, msg: number): PriceMessage {
  const c = readCore(hex, msg);
  return {
    feedId: `0x${hex.slice(4 + 2 * msg, 4 + 2 * (msg + 32))}`,
    price: c.price,
    conf: c.conf,
    expo: c.expo,
    publishTime: c.publishTime,
    prevPublishTime: c.prevPublishTime,
    emaPrice: BigInt.asIntN(64, fieldAt(hex, msg + 69, 8)),
    emaConf: fieldAt(hex, msg + 77, 8),
  };
}

export function parsePriceMessage(msg: Hex): PriceMessage | null {
  const h = blobHex(msg);
  if (h.length < 2 + 2 * PRICE_MESSAGE_SIZE || byteAt(h, 0) !== 0) return null;
  return readMessage(h, 0);
}

export function parse(blob: Hex): Accumulator {
  const s = scan(blobHex(blob));
  const updates = s.updates.map(
    (u): AccumulatorUpdate => ({
      raw: `0x${s.hex.slice(u.from, u.to)}`,
      message: u.feedId === null ? null : readMessage(s.hex, messageAt(u)),
    }),
  );
  return new Accumulator(s.prefix, updates);
}

/** The same update carrying only `feedIds`, in the order the blob holds them. */
export function subset(blob: Hex, feedIds: readonly Hex[]): Hex {
  return subsetOf(scan(blobHex(blob)), feedIds);
}

// ---- encoding (tests and tools) ----

function hexByte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function body(h: Hex): string {
  return blobHex(h).slice(2);
}

function fixed(v: bigint, bits: number, signed: boolean): string {
  const lo = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const hi = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (v < lo || v > hi) throw new RangeError(`${v} does not fit in ${signed ? "i" : "u"}${bits}`);
  return BigInt.asUintN(bits, v).toString(16).padStart(bits / 4, "0");
}

/** Assemble an accumulator from a prefix and (message, proof nodes) pairs. Used by tests. */
export function build(prefix: Hex, messages: readonly (readonly [message: Hex, proof: readonly Hex[]])[]): Hex {
  if (messages.length > 255) throw new RangeError("an accumulator holds at most 255 updates");
  let out = body(prefix) + hexByte(messages.length);
  for (const [msg, proof] of messages) {
    const m = body(msg);
    if (proof.length > 255) throw new RangeError("a proof holds at most 255 nodes");
    out += fixed(BigInt(m.length / 2), 16, false) + m + hexByte(proof.length);
    for (const node of proof) out += body(node);
  }
  return `0x${out}`;
}

export function encodePriceMessage(m: PriceMessage): Hex {
  return `0x00${body(m.feedId)}${fixed(m.price, 64, true)}${fixed(m.conf, 64, false)}${fixed(BigInt(m.expo), 32, true)}${fixed(
    BigInt(m.publishTime),
    64,
    true,
  )}${fixed(BigInt(m.prevPublishTime), 64, true)}${fixed(m.emaPrice, 64, true)}${fixed(m.emaConf, 64, false)}`;
}
