/**
 * Pyth Pro signed updates: read one, and build one.
 *
 * An update is what a call's `priceUpdate: bytes[]` carries, one element each. It is an envelope
 * around a signed payload, all big-endian:
 *
 *     envelope  magic u32 (ENVELOPE_MAGIC) | r 32 | s 32 | recovery id u8 (0 or 1) | payload size u16 | payload
 *     payload   magic u32 (PAYLOAD_MAGIC) | timestamp u64 (µs) | channel u8 | feed count u8 | feeds
 *     feed      feed id u32 | property count u8 | properties
 *     property  property id u8 | value
 *
 * The signature is over keccak256(payload). A property's value is 8 bytes for the price, best bid,
 * best ask, EMA price, EMA confidence and confidence; 2 bytes for the publisher count, the exponent
 * and the market session; and a presence byte followed by 8 bytes only when it is set for the three
 * funding properties and the feed update timestamp.
 *
 * {@link parsePayload} reads a payload exactly as BazaarOracle does (LazerPayloadLib.readFeeds): the
 * same bytes are malformed, a feed listed twice is read from its first entry, a property listed twice
 * takes its last value, and `included` says which properties the payload carries, so a property left
 * out of the request is never mistaken for one that is present and zero. {@link splitUpdate} and
 * {@link recoverSigner} read the envelope as Pyth's verifier does. Nothing here trusts anything but
 * the bytes.
 *
 * Updates are viem `Hex` strings and are read from that text directly.
 */

import { type Address, type Hex, keccak256, recoverAddress, stringToHex } from "viem";
import { sign } from "viem/accounts";

/** The first four bytes of an update in the EVM envelope. */
export const ENVELOPE_MAGIC = 706910618;
/** The first four bytes of a payload (LazerPayloadLib.PAYLOAD_MAGIC). */
export const PAYLOAD_MAGIC = 2479346549;
/** Envelope bytes before the payload: magic, r, s, recovery id, payload size. */
export const ENVELOPE_HEADER_BYTES = 71;
/** The longest payload an envelope can frame: its size field is two bytes. */
export const MAX_PAYLOAD_BYTES = 0xffff;
/** The largest update there can be: the envelope's header and the longest payload it can frame. */
export const MAX_UPDATE_BYTES = ENVELOPE_HEADER_BYTES + MAX_PAYLOAD_BYTES;
/** The most feeds one payload carries: its feed count is one byte. */
export const MAX_FEEDS_PER_UPDATE = 0xff;
/** Payload bytes before the first feed: magic, timestamp, channel, feed count. */
const PAYLOAD_HEADER_BYTES = 14;

export const MICROS_PER_SECOND = 1_000_000n;

/** The channels Pyth Pro produces updates on, as the subscription API names them. */
export type Channel = "real_time" | "fixed_rate@50ms" | "fixed_rate@200ms" | "fixed_rate@1000ms";

/** Each channel's number in a payload. */
export const CHANNEL_IDS: Readonly<Record<Channel, number>> = {
  real_time: 1,
  "fixed_rate@50ms": 2,
  "fixed_rate@200ms": 3,
  "fixed_rate@1000ms": 4,
};

/** The channel whose updates are stamped once per second, on whole seconds (LazerPayloadLib.CHANNEL_FIXED_RATE_1000). */
export const CHANNEL_FIXED_RATE_1000 = CHANNEL_IDS["fixed_rate@1000ms"];

/** A payload channel number's name, or null for a number Pyth does not define. */
export function channelName(id: number): Channel | null {
  for (const [name, n] of Object.entries(CHANNEL_IDS)) if (n === id) return name as Channel;
  return null;
}

// Property ids, as Pyth numbers them (LazerPayloadLib.PROP_*).
const PROP_PRICE = 0;
const PROP_BEST_BID_PRICE = 1;
const PROP_BEST_ASK_PRICE = 2;
const PROP_PUBLISHER_COUNT = 3;
const PROP_EXPONENT = 4;
const PROP_CONFIDENCE = 5;
const PROP_FUNDING_RATE = 6;
const PROP_FUNDING_TIMESTAMP = 7;
const PROP_FUNDING_RATE_INTERVAL = 8;
const PROP_MARKET_SESSION = 9;
const PROP_EMA_PRICE = 10;
const PROP_EMA_CONFIDENCE = 11;
const PROP_FEED_UPDATE_TIMESTAMP = 12;
/** The highest market session value Pyth defines (LazerPayloadLib.MAX_MARKET_SESSION). */
const MAX_MARKET_SESSION = 4;

// Bits of LazerFeed.included (LazerPayloadLib.HAS_*).
export const HAS_PRICE = 1;
export const HAS_EXPONENT = 2;
export const HAS_CONFIDENCE = 4;
export const HAS_FEED_UPDATE_TIMESTAMP = 8;
/** What a feed must carry to price a live call (BazaarOracle.LIVE_PROPERTIES). */
export const LIVE_PROPERTIES = HAS_PRICE | HAS_EXPONENT | HAS_CONFIDENCE | HAS_FEED_UPDATE_TIMESTAMP;
/** What a one-second update must carry for a feed to settle a pair at it: no confidence, since settlement applies no confidence cap (BazaarOracle.TICK_PROPERTIES). */
export const TICK_PROPERTIES = HAS_PRICE | HAS_EXPONENT;
/** What a one-second update must carry to prove a chain sample: the generation time too, which places the price before or after a target (BazaarOracle.CHAIN_PROPERTIES). */
export const CHAIN_PROPERTIES = TICK_PROPERTIES | HAS_FEED_UPDATE_TIMESTAMP;

export class LazerError extends Error {
  override readonly name = "LazerError";
}

/** One feed's fields in one payload (LazerPayloadLib.Feed). */
export interface LazerFeed {
  /** The Pyth Pro feed id, a 32-bit integer. */
  readonly id: number;
  /** Which of the properties below the payload carries for the feed (HAS_* bits). */
  readonly included: number;
  /** The price mantissa; zero when the feed has no price at the payload's timestamp, or the property is not included. */
  readonly price: bigint;
  /** The power of ten both mantissas are scaled by. */
  readonly exponent: number;
  /** The confidence mantissa. */
  readonly confidence: bigint;
  /**
   * When the price was generated, in microseconds: earlier than the payload's timestamp when the price
   * is carried forward from an earlier update, and zero when the feed has never produced a price or the
   * property is not included.
   */
  readonly feedUpdateTimestamp: bigint;
}

/** A payload's contents. */
export interface LazerPayload {
  /** The update's own timestamp, in microseconds. */
  readonly timestampUs: bigint;
  /** The channel number the update was produced on ({@link CHANNEL_IDS}); any byte, as the payload holds it. */
  readonly channel: number;
  /** Every feed the payload carries, in its order; a feed it lists twice appears once, from its first entry. */
  readonly feeds: readonly LazerFeed[];
}

/** An update, read from its bytes. */
export interface LazerUpdate extends LazerPayload {
  /** The address the envelope's signature recovers to. */
  readonly signer: Address;
  /** The signed payload. */
  readonly payload: Hex;
}

/** An update's envelope, split. */
export interface Envelope {
  readonly r: Hex;
  readonly s: Hex;
  /** The recovery id as the envelope stores it: 0 or 1 in a valid signature. */
  readonly recovery: number;
  readonly payload: Hex;
}

function malformed(what: string): LazerError {
  return new LazerError(`malformed Pyth Pro update: ${what}`);
}

const HEX = /^(?:0x)?((?:[0-9a-fA-F]{2})*)$/;

/** The lowercase hex digits of `data` (with or without 0x), or null when it is not whole bytes of hex. */
function digits(data: unknown): string | null {
  if (typeof data !== "string") return null;
  const m = HEX.exec(data);
  return m ? m[1]!.toLowerCase() : null;
}

/** `data` as a lowercase 0x-prefixed hex string, or null when it is not whole bytes of hex (the prefix is optional). */
export function normalizeHex(data: unknown): Hex | null {
  const d = digits(data);
  return d === null ? null : `0x${d}`;
}

/** Big-endian reads over hex digits, by byte position; a read past the end is malformed. */
class Reader {
  readonly length: number;
  constructor(private readonly hex: string) {
    this.length = hex.length / 2;
  }

  private at(pos: number, width: number): string {
    if (pos + width > this.length) throw malformed("it ends before its last field does");
    return this.hex.slice(pos * 2, (pos + width) * 2);
  }

  u8(pos: number): number {
    return parseInt(this.at(pos, 1), 16);
  }
  u16(pos: number): number {
    return parseInt(this.at(pos, 2), 16);
  }
  i16(pos: number): number {
    const v = this.u16(pos);
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u32(pos: number): number {
    return parseInt(this.at(pos, 4), 16);
  }
  u64(pos: number): bigint {
    return BigInt(`0x${this.at(pos, 8)}`);
  }
  i64(pos: number): bigint {
    return BigInt.asIntN(64, this.u64(pos));
  }
}

/**
 * Reads a signed payload as LazerPayloadLib.readFeeds does. Throws a LazerError where the contract
 * reverts with LazerPayloadLib__Malformed: another magic, a property id Pyth does not define (its
 * width cannot be known), a market session above the highest Pyth defines, a payload that ends inside
 * a field, and bytes left after the last property.
 */
export function parsePayload(payload: Hex): LazerPayload {
  const hex = digits(payload);
  if (hex === null) throw malformed("the payload is not hex");
  const r = new Reader(hex);
  if (r.u32(0) !== PAYLOAD_MAGIC) throw malformed("the payload does not start with Pyth Pro's magic");
  const timestampUs = r.u64(4);
  const channel = r.u8(12);
  const count = r.u8(13);
  let pos = PAYLOAD_HEADER_BYTES;
  const feeds: LazerFeed[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const id = r.u32(pos);
    const properties = r.u8(pos + 4);
    pos += 5;
    let included = 0;
    let price = 0n;
    let exponent = 0;
    let confidence = 0n;
    let feedUpdateTimestamp = 0n;
    for (let j = 0; j < properties; j++) {
      const property = r.u8(pos);
      pos += 1;
      switch (property) {
        case PROP_PRICE:
          price = r.i64(pos);
          included |= HAS_PRICE;
          pos += 8;
          break;
        case PROP_EXPONENT:
          exponent = r.i16(pos);
          included |= HAS_EXPONENT;
          pos += 2;
          break;
        case PROP_CONFIDENCE:
          confidence = r.u64(pos);
          included |= HAS_CONFIDENCE;
          pos += 8;
          break;
        case PROP_FEED_UPDATE_TIMESTAMP: {
          // A presence byte, then the timestamp only when it is set.
          const exists = r.u8(pos) !== 0;
          included |= HAS_FEED_UPDATE_TIMESTAMP;
          feedUpdateTimestamp = exists ? r.u64(pos + 1) : 0n;
          pos += exists ? 9 : 1;
          break;
        }
        case PROP_BEST_BID_PRICE:
        case PROP_BEST_ASK_PRICE:
        case PROP_EMA_PRICE:
        case PROP_EMA_CONFIDENCE:
          pos += 8;
          break;
        case PROP_PUBLISHER_COUNT:
          pos += 2;
          break;
        case PROP_MARKET_SESSION:
          if (r.u16(pos) > MAX_MARKET_SESSION) throw malformed("a market session Pyth does not define");
          pos += 2;
          break;
        case PROP_FUNDING_RATE:
        case PROP_FUNDING_TIMESTAMP:
        case PROP_FUNDING_RATE_INTERVAL:
          // A presence byte, then eight bytes only when it is set.
          pos += r.u8(pos) !== 0 ? 9 : 1;
          break;
        default:
          throw malformed(`property ${property}, which Pyth does not define`);
      }
    }
    if (!seen.has(id)) {
      seen.add(id);
      feeds.push({ id, included, price, exponent, confidence, feedUpdateTimestamp });
    }
  }
  // A skipped property is stepped over without being read, so the walk can pass the end.
  if (pos !== r.length) throw malformed(pos > r.length ? "it ends before its last field does" : "bytes follow its last property");
  return { timestampUs, channel, feeds };
}

/**
 * Splits an update into its signature and its payload as Pyth's verifier does: at least the 71
 * header bytes, the envelope magic, and a payload as long as its size field says. Bytes after the
 * payload are ignored, as the verifier ignores them ({@link canonicalUpdate} drops them). Throws a
 * LazerError otherwise.
 */
export function splitUpdate(update: Hex): Envelope {
  const hex = digits(update);
  if (hex === null) throw malformed("not hex");
  const length = hex.length / 2;
  if (length < ENVELOPE_HEADER_BYTES) throw malformed("shorter than an envelope");
  if (parseInt(hex.slice(0, 8), 16) !== ENVELOPE_MAGIC) throw malformed("it does not start with the EVM envelope's magic");
  const size = parseInt(hex.slice(138, 142), 16);
  if (length < ENVELOPE_HEADER_BYTES + size) throw malformed("shorter than its payload size says");
  return {
    r: `0x${hex.slice(8, 72)}`,
    s: `0x${hex.slice(72, 136)}`,
    recovery: parseInt(hex.slice(136, 138), 16),
    payload: `0x${hex.slice(142, 142 + size * 2)}`,
  };
}

/**
 * `update` exactly as the verifier reads it: the envelope's header and the payload its size field
 * names, as lowercase hex, without any bytes after them. Those bytes change nothing on chain but
 * would ride along in a call's calldata, costing gas, so every update the SDK keeps is cut to this.
 * Throws a LazerError where {@link splitUpdate} does.
 */
export function canonicalUpdate(update: Hex): Hex {
  const { payload } = splitUpdate(update);
  return `0x${digits(update)!.slice(0, ENVELOPE_HEADER_BYTES * 2)}${payload.slice(2)}`;
}

/** Half the secp256k1 group order: a signature whose s is above it is refused, as the verifier's ECDSA recovery refuses it. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function invalidSignature(): LazerError {
  return new LazerError("invalid Pyth Pro update: its signature recovers to no address");
}

/** The address an envelope's signature recovers to over keccak256(payload); throws a LazerError where the verifier answers "invalid signature". */
async function recover(e: Envelope): Promise<Address> {
  if (e.recovery > 1 || BigInt(e.s) > HALF_ORDER) throw invalidSignature();
  try {
    return await recoverAddress({ hash: keccak256(e.payload), signature: { r: e.r, s: e.s, yParity: e.recovery } });
  } catch {
    throw invalidSignature();
  }
}

/**
 * The address that signed `update`. Whether Pyth trusts that address is the verifier contract's to
 * say (its `isValidSigner`); this only recovers it.
 */
export async function recoverSigner(update: Hex): Promise<Address> {
  return recover(splitUpdate(update));
}

/** Reads an update without recovering its signer: its payload, from the bytes the signature covers. */
export function readUpdate(update: Hex): LazerPayload & { readonly payload: Hex } {
  const { payload } = splitUpdate(update);
  return { ...parsePayload(payload), payload };
}

/** Reads an update and recovers its signer. Throws a LazerError when the envelope, the signature or the payload is not valid. */
export async function parseUpdate(update: Hex): Promise<LazerUpdate> {
  const e = splitUpdate(update);
  const parsed = parsePayload(e.payload);
  return { ...parsed, signer: await recover(e), payload: e.payload };
}

/** One leg as BazaarOracle reads it out of a call's updates. */
export interface LegEntry {
  /** The leg's entry in the update it is read from, whether or not it holds a usable price. */
  readonly feed: LazerFeed;
  /** That update's own timestamp, in microseconds. */
  readonly timestampUs: bigint;
  /** Which of the updates it is read from: an index into them. */
  readonly index: number;
}

/**
 * Each leg as BazaarOracle.verifyAndFetchPrice reads it out of a call's updates: the leg's entry in
 * the update holding its most recently generated price (the earlier update on a tie), whether or not
 * that entry is complete or holds a usable price; null for a leg no update carries. `legs` are bytes32
 * feed ids; one that is not a raw feed id is carried by no update. Throws a LazerError for an update
 * that cannot be read, which the oracle refuses too.
 */
export function legEntries(updates: readonly Hex[], legs: readonly Hex[]): (LegEntry | null)[] {
  const ids = legs.map((l) => (isRawFeedId(l) ? proFeedId(l) : 0));
  const out: (LegEntry | null)[] = legs.map(() => null);
  updates.forEach((update, index) => {
    const p = readUpdate(update);
    for (const feed of p.feeds) {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === 0 || feed.id !== ids[i]) continue;
        const cur = out[i];
        if (cur === null || cur === undefined || feed.feedUpdateTimestamp > cur.feed.feedUpdateTimestamp) out[i] = { feed, timestampUs: p.timestampUs, index };
      }
    }
  });
  return out;
}

// ---- feed ids ----

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT32 = 0xffffffff;

/**
 * Whether `id` has the form of a raw Pyth Pro feed id: a non-zero 32-bit integer held in a bytes32
 * (BazaarOracle.isRawFeedId). Says nothing about whether Pyth publishes such a feed. Anything else
 * (a composite id, which is a hash; zero; not a bytes32) is false.
 */
export function isRawFeedId(id: Hex): boolean {
  if (typeof id !== "string" || !BYTES32.test(id)) return false;
  const v = BigInt(id);
  return v !== 0n && v <= BigInt(MAX_UINT32);
}

/** The bytes32 feed id that holds Pyth Pro feed `n` (1 → 0x00…01). Throws a LazerError unless `n` is an integer from 1 to 2^32 − 1. */
export function feedIdHex(n: number): Hex {
  if (!Number.isInteger(n) || n < 1 || n > MAX_UINT32) throw new LazerError(`${String(n)} is not a Pyth Pro feed id: it must be an integer from 1 to ${MAX_UINT32}`);
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** The Pyth Pro feed number a raw bytes32 feed id holds. Throws a LazerError on anything {@link isRawFeedId} refuses. */
export function proFeedId(id: Hex): number {
  if (!isRawFeedId(id)) throw new LazerError(`${String(id).slice(0, 80)} is not a raw Pyth Pro feed id (a non-zero 32-bit integer in a bytes32)`);
  return Number(BigInt(id));
}

// ---- building updates ----

/** One feed to encode. A property left undefined is left out of the payload. */
export interface LazerFeedInput {
  readonly id: number;
  /** Zero encodes a feed with no price. */
  readonly price?: bigint;
  readonly exponent?: number;
  readonly confidence?: bigint;
  /** Microseconds; zero writes the property with its presence byte unset, as Pyth does for a feed that has never produced a price. */
  readonly feedUpdateTimestamp?: bigint;
}

export interface LazerPayloadInput {
  readonly timestampUs: bigint;
  /** A channel name, or its number. */
  readonly channel: Channel | number;
  readonly feeds: readonly LazerFeedInput[];
}

function integer(value: bigint | number, what: string): bigint {
  if (typeof value === "number" && !Number.isInteger(value)) throw new LazerError(`${what} ${String(value)} is not an integer`);
  return BigInt(value);
}

/** `value` as `bytes` big-endian bytes of hex; throws unless it is an unsigned integer that fits. */
function unsigned(value: bigint | number, bytes: number, what: string): string {
  const v = integer(value, what);
  if (v < 0n || v >> BigInt(bytes * 8) !== 0n) throw new LazerError(`${what} ${String(value)} does not fit ${bytes} unsigned bytes`);
  return v.toString(16).padStart(bytes * 2, "0");
}

/** `value` as `bytes` big-endian bytes of two's complement hex; throws unless it is a signed integer that fits. */
function signed(value: bigint | number, bytes: number, what: string): string {
  const v = integer(value, what);
  if (BigInt.asIntN(bytes * 8, v) !== v) throw new LazerError(`${what} ${String(value)} does not fit ${bytes} signed bytes`);
  return BigInt.asUintN(bytes * 8, v).toString(16).padStart(bytes * 2, "0");
}

/**
 * Encodes a payload. Each feed's properties are written in the order price, exponent, confidence,
 * feed update timestamp, the ones a feed leaves undefined left out.
 */
export function encodePayload(p: LazerPayloadInput): Hex {
  const channel = typeof p.channel === "number" ? p.channel : Object.hasOwn(CHANNEL_IDS, p.channel) ? CHANNEL_IDS[p.channel] : undefined;
  if (channel === undefined) throw new LazerError(`unknown Pyth Pro channel ${String(p.channel).slice(0, 40)}`);
  let out = unsigned(PAYLOAD_MAGIC, 4, "magic") + unsigned(p.timestampUs, 8, "timestamp") + unsigned(channel, 1, "channel") + unsigned(p.feeds.length, 1, "feed count");
  for (const f of p.feeds) {
    let properties = "";
    let count = 0;
    if (f.price !== undefined) {
      properties += unsigned(PROP_PRICE, 1, "property") + signed(f.price, 8, "price");
      count++;
    }
    if (f.exponent !== undefined) {
      properties += unsigned(PROP_EXPONENT, 1, "property") + signed(f.exponent, 2, "exponent");
      count++;
    }
    if (f.confidence !== undefined) {
      properties += unsigned(PROP_CONFIDENCE, 1, "property") + unsigned(f.confidence, 8, "confidence");
      count++;
    }
    if (f.feedUpdateTimestamp !== undefined) {
      properties += unsigned(PROP_FEED_UPDATE_TIMESTAMP, 1, "property");
      properties += f.feedUpdateTimestamp === 0n ? "00" : "01" + unsigned(f.feedUpdateTimestamp, 8, "feed update timestamp");
      count++;
    }
    out += unsigned(f.id, 4, "feed id") + unsigned(count, 1, "property count") + properties;
  }
  return `0x${out}`;
}

/**
 * Wraps `payload` in the EVM envelope, signed with `privateKey` over keccak256(payload). The
 * signature is deterministic, so the same payload and key always give the same update.
 */
export async function signPayload(payload: Hex, privateKey: Hex): Promise<Hex> {
  const hex = digits(payload);
  if (hex === null) throw new LazerError("the payload is not hex");
  const size = hex.length / 2;
  if (size > MAX_PAYLOAD_BYTES) throw new LazerError(`a payload of ${size} bytes does not fit an envelope (at most ${MAX_PAYLOAD_BYTES})`);
  const sig = await sign({ hash: keccak256(`0x${hex}`), privateKey });
  const recovery = sig.yParity ?? Number((sig.v ?? 27n) - 27n);
  return `0x${unsigned(ENVELOPE_MAGIC, 4, "magic")}${sig.r.slice(2).padStart(64, "0")}${sig.s.slice(2).padStart(64, "0")}${unsigned(recovery, 1, "recovery id")}${unsigned(size, 2, "payload size")}${hex}`;
}

/** {@link encodePayload}, then {@link signPayload}: a signed update carrying these feeds. */
export async function buildUpdate(p: LazerPayloadInput, privateKey: Hex): Promise<Hex> {
  return signPayload(encodePayload(p), privateKey);
}

/** The label the local signing key is derived from. */
export const LOCAL_SIGNER_LABEL = "bazaar.test.pyth-lazer-signer";

/**
 * The private key Bazaar's local deployments sign Pyth Pro updates with: keccak256 of
 * {@link LOCAL_SIGNER_LABEL}. Public by construction, so only a local chain's mock verifier may
 * trust it; no verifier on a live chain ever does.
 */
export function localSignerKey(): Hex {
  return keccak256(stringToHex(LOCAL_SIGNER_LABEL));
}
