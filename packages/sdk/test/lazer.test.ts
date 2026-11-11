import { type Hex, keccak256 } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  CHAIN_PROPERTIES,
  CHANNEL_FIXED_RATE_1000,
  CHANNEL_IDS,
  HAS_CONFIDENCE,
  HAS_EXPONENT,
  HAS_FEED_UPDATE_TIMESTAMP,
  HAS_PRICE,
  LIVE_PROPERTIES,
  LOCAL_SIGNER_LABEL,
  LazerError,
  TICK_PROPERTIES,
  buildUpdate,
  channelName,
  encodePayload,
  feedIdHex,
  isRawFeedId,
  localSignerKey,
  normalizeHex,
  parsePayload,
  parseUpdate,
  proFeedId,
  readUpdate,
  recoverSigner,
  signPayload,
  splitUpdate,
} from "../src/prices/lazer.js";
import { MAX_FEEDS_PER_UPDATE, MAX_UPDATE_BYTES, canonicalUpdate, legEntries } from "../src/prices/lazer.js";
import { unsigned } from "./pro-fakes.js";

// The contracts repository's reference vectors (its test signer, real-time channel).
const SIGNER = "0x8E3f6fe466E82bfb972c3F3F7D8B27185973B5BE";
const BTC: Hex =
  "0x2a22999a424eea8400afa9c1e084ca86a05fc271b3cbb5307354264ce84e47bd2258d66a043f7bc649c26d4091c54a4a0c3045f40715db35fe73e225b8b3c35533048fa400003293c7d37500060a24181e400001010000000104000000048c2739500004fff80500000000000000000c0100060a24181e4000";
const ETH: Hex =
  "0x2a22999aef90c5dfe38aaebcd6fbc4f63bda8dba328daeb3249d73e74628eef3b08ef1e200ee4c231b4e608d8c54ff4c6edaafe8decd15bcc15449582f813c4cf49a2e0c00003293c7d37500060a241f7314c001010000000204000000002e90edd00004fff80500000000000000000c0100060a241f7314c0";

// The same two prices as the contracts repository's shell encoder writes them: confidence a
// thousandth of the price, so the oracle takes them as live prices.
const BTC_LIVE: Hex =
  "0x2a22999a079a38ecd5ab46a05c14e23826175819be52e611bae98447893d8bb61016394e3a3e3109ed7718e268cd0e4fb3179ad3c22ef449076c5a3073372bc8dacf90bc01003293c7d37500060a24181e400001010000000104000000048c2739500004fff805000000012a05f2000c0100060a24181e4000";
const ETH_LIVE: Hex =
  "0x2a22999adc3099ca18e92d4425114efd168a4acf7759696ba9431c48c313f758657a01b64e57016bf3d5b869473c0057fae98dc246aeeb996e4cf99d1548fef4eca0d9e000003293c7d37500060a241f7314c001010000000204000000002e90edd00004fff805000000000bebc2000c0100060a241f7314c0";

const KEY = localSignerKey();
const US = 1_000_000n;

/** A payload header: magic, timestamp, channel, feed count. */
const header = (feeds: number, channel = 1, ts = 1_700_000_000n * US) =>
  `93c7d375${ts.toString(16).padStart(16, "0")}${channel.toString(16).padStart(2, "0")}${feeds.toString(16).padStart(2, "0")}`;
/** A feed entry: id, property count, properties (already encoded). */
const entry = (id: number, count: number, props: string) => `${id.toString(16).padStart(8, "0")}${count.toString(16).padStart(2, "0")}${props}`;
const u64 = (v: bigint) => BigInt.asUintN(64, v).toString(16).padStart(16, "0");
const PRICE = (v: bigint) => `00${u64(v)}`;
const EXPO = (v: number) => `04${(v & 0xffff).toString(16).padStart(4, "0")}`;
const CONF = (v: bigint) => `05${u64(v)}`;
const GENERATED = (us: bigint) => (us === 0n ? "0c00" : `0c01${u64(us)}`);
const payload = (...parts: string[]): Hex => `0x${parts.join("")}`;

describe("Pyth Pro updates", () => {
  it("derives the local signing key from its label", () => {
    expect(LOCAL_SIGNER_LABEL).toBe("bazaar.test.pyth-lazer-signer");
    expect(privateKeyToAddress(KEY)).toBe(SIGNER);
  });

  it("reads the reference updates from their signed bytes and recovers their signer", async () => {
    const btc = await parseUpdate(BTC);
    expect(btc.signer).toBe(SIGNER);
    expect(btc.timestampUs).toBe(1_700_000_000n * US);
    expect(btc.channel).toBe(CHANNEL_IDS.real_time);
    expect(btc.feeds).toEqual([{ id: 1, included: LIVE_PROPERTIES, price: 5_000_000_000_000n, exponent: -8, confidence: 0n, feedUpdateTimestamp: 1_700_000_000n * US }]);
    expect(btc.payload).toBe(`0x${BTC.slice(144)}`);
    const eth = await parseUpdate(ETH);
    expect(eth.signer).toBe(SIGNER);
    expect(eth.feeds).toEqual([{ id: 2, included: LIVE_PROPERTIES, price: 200_000_000_000n, exponent: -8, confidence: 0n, feedUpdateTimestamp: 1_700_000_123n * US }]);
    expect(await recoverSigner(ETH)).toBe(SIGNER);
    // without recovery, the same payload; and an update without its 0x reads the same
    expect(readUpdate(BTC).feeds).toEqual(btc.feeds);
    expect((await parseUpdate(BTC.slice(2) as Hex)).signer).toBe(SIGNER);
  });

  it("builds the reference updates byte for byte", async () => {
    const feed = (id: number, price: bigint, at: bigint) => ({ id, price, exponent: -8, confidence: 0n, feedUpdateTimestamp: at * US });
    expect(await buildUpdate({ timestampUs: 1_700_000_000n * US, channel: "real_time", feeds: [feed(1, 5_000_000_000_000n, 1_700_000_000n)] }, KEY)).toBe(BTC);
    expect(await buildUpdate({ timestampUs: 1_700_000_123n * US, channel: 1, feeds: [feed(2, 200_000_000_000n, 1_700_000_123n)] }, KEY)).toBe(ETH);
    // with a confidence, as a live call needs one
    const live = (id: number, price: bigint, at: bigint) => ({ ...feed(id, price, at), confidence: price / 1_000n });
    expect(await buildUpdate({ timestampUs: 1_700_000_000n * US, channel: "real_time", feeds: [live(1, 5_000_000_000_000n, 1_700_000_000n)] }, KEY)).toBe(BTC_LIVE);
    expect(await buildUpdate({ timestampUs: 1_700_000_123n * US, channel: "real_time", feeds: [live(2, 200_000_000_000n, 1_700_000_123n)] }, KEY)).toBe(ETH_LIVE);
    const parsed = await parseUpdate(BTC_LIVE);
    expect([parsed.signer, parsed.feeds[0]!.confidence]).toEqual([SIGNER, 5_000_000_000n]);
    expect((await parseUpdate(ETH_LIVE)).feeds[0]).toEqual({ id: 2, included: LIVE_PROPERTIES, price: 200_000_000_000n, exponent: -8, confidence: 200_000_000n, feedUpdateTimestamp: 1_700_000_123n * US });
  });

  it("round-trips what it encodes: negative values, several feeds, properties left out", async () => {
    const input = {
      timestampUs: 1_700_000_005n * US,
      channel: "fixed_rate@1000ms" as const,
      feeds: [
        { id: 7, price: -12_345n, exponent: -12, confidence: 99n, feedUpdateTimestamp: 1_700_000_001n * US + 250_000n },
        { id: 4_294_967_295, price: 0n, exponent: 3, confidence: 0n, feedUpdateTimestamp: 0n }, // no price, never priced
        { id: 9, price: 1n }, // only the price requested
        { id: 10 }, // nothing requested
      ],
    };
    const update = await buildUpdate(input, KEY);
    const u = await parseUpdate(update);
    expect(u.signer).toBe(SIGNER);
    expect(u.channel).toBe(CHANNEL_FIXED_RATE_1000);
    expect(u.timestampUs).toBe(input.timestampUs);
    expect(u.feeds).toEqual([
      { id: 7, included: LIVE_PROPERTIES, price: -12_345n, exponent: -12, confidence: 99n, feedUpdateTimestamp: 1_700_000_001_250_000n },
      { id: 4_294_967_295, included: LIVE_PROPERTIES, price: 0n, exponent: 3, confidence: 0n, feedUpdateTimestamp: 0n },
      { id: 9, included: HAS_PRICE, price: 1n, exponent: 0, confidence: 0n, feedUpdateTimestamp: 0n },
      { id: 10, included: 0, price: 0n, exponent: 0, confidence: 0n, feedUpdateTimestamp: 0n },
    ]);
    expect(await buildUpdate(input, KEY)).toBe(update); // deterministic
    expect(() => encodePayload({ ...input, feeds: [{ id: 1, price: 1n << 63n }] })).toThrow(LazerError);
    expect(() => encodePayload({ ...input, feeds: [{ id: 1, exponent: 40_000 }] })).toThrow(LazerError);
    expect(() => encodePayload({ ...input, feeds: [{ id: -1 }] })).toThrow(LazerError);
    expect(() => encodePayload({ ...input, channel: "fixed_rate@10ms" as never })).toThrow("unknown Pyth Pro channel");
  });

  it("tells a property that is absent from one that is present and zero", () => {
    const some = parsePayload(payload(header(1), entry(1, 2, PRICE(0n) + GENERATED(0n))));
    expect(some.feeds[0]).toEqual({ id: 1, included: HAS_PRICE | HAS_FEED_UPDATE_TIMESTAMP, price: 0n, exponent: 0, confidence: 0n, feedUpdateTimestamp: 0n });
    const settle = parsePayload(payload(header(1), entry(1, 3, PRICE(5n) + EXPO(-8) + GENERATED(7n)))).feeds[0]!;
    expect(settle.included & CHAIN_PROPERTIES).toBe(CHAIN_PROPERTIES);
    expect(settle.included & HAS_CONFIDENCE).toBe(0);
    expect(settle.included & LIVE_PROPERTIES).not.toBe(LIVE_PROPERTIES);
    const tick = parsePayload(payload(header(1), entry(1, 2, PRICE(5n) + EXPO(-8)))).feeds[0]!;
    expect(tick.included & TICK_PROPERTIES).toBe(TICK_PROPERTIES);
    expect(tick.included & CHAIN_PROPERTIES).not.toBe(CHAIN_PROPERTIES);
    expect(HAS_PRICE | HAS_EXPONENT).toBe(TICK_PROPERTIES);
    expect(TICK_PROPERTIES | HAS_FEED_UPDATE_TIMESTAMP).toBe(CHAIN_PROPERTIES);
    expect(CHAIN_PROPERTIES | HAS_CONFIDENCE).toBe(LIVE_PROPERTIES);
  });

  it("reads a repeated feed from its first entry and a repeated property from its last value", () => {
    const p = parsePayload(
      payload(
        header(3),
        entry(5, 3, PRICE(1n) + PRICE(2n) + GENERATED(9n)),
        entry(5, 1, PRICE(777n)), // the same feed again: ignored, but still walked
        entry(6, 3, GENERATED(9n) + GENERATED(0n) + EXPO(-2)), // the timestamp set, then unset
      ),
    );
    expect(p.feeds.map((f) => [f.id, f.price, f.feedUpdateTimestamp])).toEqual([
      [5, 2n, 9n],
      [6, 0n, 0n],
    ]);
    expect(p.feeds[1]!.included).toBe(HAS_FEED_UPDATE_TIMESTAMP | HAS_EXPONENT);
  });

  it("steps over the properties it does not read, each by its own width", () => {
    const others =
      `01${u64(11n)}` + // best bid
      `02${u64(12n)}` + // best ask
      "030009" + // publisher count
      `0601${u64(5n)}` + // funding rate, present
      "0700" + // funding timestamp, absent
      `0801${u64(8n)}` + // funding rate interval, present
      "090004" + // market session: closed
      `0a${u64(13n)}` + // EMA price
      `0b${u64(14n)}`; // EMA confidence
    const p = parsePayload(payload(header(1, 3), entry(2, 13, PRICE(42n) + others + EXPO(-5) + CONF(3n) + GENERATED(77n))));
    expect(p.channel).toBe(3);
    expect(channelName(p.channel)).toBe("fixed_rate@200ms");
    expect(channelName(9)).toBeNull();
    expect(p.feeds).toEqual([{ id: 2, included: LIVE_PROPERTIES, price: 42n, exponent: -5, confidence: 3n, feedUpdateTimestamp: 77n }]);
  });

  it("refuses what the contract's parser refuses", () => {
    const ok = payload(header(1), entry(1, 4, PRICE(1n) + EXPO(-8) + CONF(0n) + GENERATED(5n)));
    expect(parsePayload(ok).feeds).toHaveLength(1);
    const bad: [string, Hex][] = [
      ["another magic", `0x93c7d376${ok.slice(10)}` as Hex],
      ["an unknown property", payload(header(1), entry(1, 1, `0d${u64(1n)}`))],
      ["a market session past the last", payload(header(1), entry(1, 1, "090005"))],
      ["a trailing byte", `${ok}00` as Hex],
      ["a missing byte", ok.slice(0, -2) as Hex],
      ["a feed count past the feeds", payload(header(2), entry(1, 1, PRICE(1n)))],
      ["a property count past the properties", payload(header(1), entry(1, 2, PRICE(1n)))],
      ["a skipped property cut short", payload(header(1), entry(1, 1, "0a0011"))],
      ["a funding property cut short", payload(header(1), entry(1, 1, "060100"))],
      ["a header cut short", "0x93c7d37500060a24181e4000" as Hex],
      ["an empty payload", "0x" as Hex],
      ["not hex", "0x93c7d3zz" as Hex],
      ["half a byte", `${ok}0` as Hex],
    ];
    for (const [what, p] of bad) expect(() => parsePayload(p), what).toThrow(LazerError);
    // a count of zero feeds, or of zero properties, is a payload like any other
    expect(parsePayload(payload(header(0))).feeds).toEqual([]);
    expect(parsePayload(payload(header(1), entry(3, 0, ""))).feeds[0]!.included).toBe(0);
  });

  it("splits the envelope as the verifier does", async () => {
    const e = splitUpdate(BTC);
    expect(e.recovery).toBe(0);
    expect(e.r).toBe(`0x${BTC.slice(10, 74)}`);
    expect(e.s).toBe(`0x${BTC.slice(74, 138)}`);
    expect(keccak256(e.payload)).toBe(keccak256(`0x${BTC.slice(144)}`));
    // bytes after the payload are outside it: the same payload, the same signer
    expect((await parseUpdate(`${BTC}deadbeef` as Hex)).feeds[0]!.price).toBe(5_000_000_000_000n);
    for (const [what, u] of [
      ["shorter than its header", BTC.slice(0, 2 + 70 * 2)],
      ["shorter than its payload", BTC.slice(0, -2)],
      ["another magic", `0x2a22999b${BTC.slice(10)}`],
      ["not hex", "0xzz"],
    ] as const) {
      expect(() => splitUpdate(u as Hex), what).toThrow(LazerError);
      await expect(parseUpdate(u as Hex), what).rejects.toThrow(LazerError);
    }
  });

  it("recovers another address, or none, once the bytes change", async () => {
    // one payload byte flipped (the price): the signature recovers to some other address
    const forged = `${BTC.slice(0, 200)}${BTC[200] === "0" ? "1" : "0"}${BTC.slice(201)}` as Hex;
    expect(forged).not.toBe(BTC);
    const signer = await recoverSigner(forged).catch(() => null);
    expect(signer).not.toBe(SIGNER);
    // a recovery id other than 0 or 1, and an s in the upper half of the order, recover to nothing
    const badRecovery = `${BTC.slice(0, 138)}02${BTC.slice(140)}` as Hex;
    await expect(recoverSigner(badRecovery)).rejects.toThrow("its signature recovers to no address");
    const highS = `${BTC.slice(0, 74)}${"f".repeat(64)}${BTC.slice(138)}` as Hex;
    await expect(recoverSigner(highS)).rejects.toThrow(LazerError);
    const zeroR = `${BTC.slice(0, 10)}${"0".repeat(64)}${BTC.slice(74)}` as Hex;
    await expect(recoverSigner(zeroR)).rejects.toThrow(LazerError);
    // signed by another key: a valid update from a signer nobody trusts
    const other = await signPayload(splitUpdate(BTC).payload, `0x${"11".repeat(32)}`);
    expect(await recoverSigner(other)).toBe(privateKeyToAddress(`0x${"11".repeat(32)}`));
  });

  it("refuses a payload too long for an envelope", async () => {
    await expect(signPayload(`0x${"00".repeat(65_536)}`, KEY)).rejects.toThrow("does not fit an envelope");
    await expect(signPayload("0xzz" as Hex, KEY)).rejects.toThrow(LazerError);
  });
});

describe("feed ids", () => {
  const b32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

  it("holds a Pyth Pro feed number in a bytes32", () => {
    expect(feedIdHex(1)).toBe(b32(1n));
    expect(feedIdHex(4_294_967_295)).toBe(b32(0xffffffffn));
    expect(proFeedId(b32(2n))).toBe(2);
    expect(proFeedId(feedIdHex(1_304))).toBe(1_304);
    for (const n of [0, -1, 1.5, 4_294_967_296, Number.NaN]) expect(() => feedIdHex(n), String(n)).toThrow(LazerError);
  });

  it("tells a raw id from a composite, zero and anything malformed", () => {
    expect(isRawFeedId(b32(1n))).toBe(true);
    expect(isRawFeedId(b32(0xffffffffn))).toBe(true);
    expect(isRawFeedId(`0x${"0".repeat(56)}FFFFFFFF`)).toBe(true);
    const not: unknown[] = [b32(0n), b32(0x1_0000_0000n), keccak256("0x01"), "0x01", "0x", "1", 1, null, undefined, `${b32(1n)}00`];
    for (const id of not) {
      expect(isRawFeedId(id as Hex), String(id)).toBe(false);
      expect(() => proFeedId(id as Hex), String(id)).toThrow(LazerError);
    }
  });

  it("normalizes hex with or without its prefix", () => {
    expect(normalizeHex("ABcd")).toBe("0xabcd");
    expect(normalizeHex("0xABcd")).toBe("0xabcd");
    expect(normalizeHex("")).toBe("0x");
    for (const v of ["abc", "0xzz", 12, null]) expect(normalizeHex(v)).toBeNull();
  });
});

describe("updates as the verifier reads them", () => {
  it("canonicalUpdate keeps the envelope and its payload and drops whatever follows", () => {
    const blob = unsigned({ at: 100, feeds: [{ id: 1 }] });
    expect(canonicalUpdate(`${blob}deadbeef` as Hex)).toBe(blob);
    expect(canonicalUpdate(blob.toUpperCase().replace("0X", "0x") as Hex)).toBe(blob);
    expect(canonicalUpdate(blob.slice(2) as Hex)).toBe(blob);
    expect(() => canonicalUpdate(blob.slice(0, -2) as Hex)).toThrow(LazerError);
    expect(MAX_UPDATE_BYTES).toBe(71 + 65_535);
    expect(MAX_FEEDS_PER_UPDATE).toBe(255);
  });

  it("legEntries reads each leg as the oracle does: the most recently generated across updates, the earlier on a tie, usable or not", () => {
    const one = unsigned({ at: 100, feeds: [{ id: 1, generated: 90 }, { id: 2, generated: 99 }] });
    const two = unsigned({ at: 101, feeds: [{ id: 1, generated: 95, conf: 0n }, { id: 2, generated: 99, price: 7n }] });
    const got = legEntries([one, two], [feedIdHex(1), feedIdHex(2), feedIdHex(3), `0x${"ab".repeat(32)}`]);
    expect(got[0]).toMatchObject({ index: 1, timestampUs: 101_000_000n, feed: { id: 1, confidence: 0n } }); // newer, though without a confidence
    expect(got[1]).toMatchObject({ index: 0, timestampUs: 100_000_000n, feed: { id: 2, price: 200_000_000_000n } }); // a tie: the earlier update
    expect(got.slice(2)).toEqual([null, null]); // carried by none, and not a raw feed id
    expect(() => legEntries([one, "0x1234"], [feedIdHex(1)])).toThrow(LazerError);
  });

  it("encodes only the channels Pyth names", () => {
    for (const channel of ["constructor", "__proto__", "toString"]) {
      expect(() => encodePayload({ timestampUs: 1n, channel: channel as never, feeds: [] })).toThrow(`unknown Pyth Pro channel ${channel}`);
    }
  });
});
