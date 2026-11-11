import { type Hex, concatHex, encodeAbiParameters, getAddress, keccak256, padHex, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { type RawLog, decodeError, lens, pair } from "../src/index.js";

const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");
const PAIR_ID = ("0x" + "01".repeat(32)) as Hex;
const sel = (sig: string) => keccak256(toBytes(sig)).slice(0, 10) as Hex;
const topicAddress = (a: string) => padHex(a as Hex, { size: 32 }).toLowerCase() as Hex;

function log(topics: Hex[], data: Hex): RawLog {
  return { address: ALICE, topics, data, blockNumber: 9, blockHash: ("0x" + "00".repeat(32)) as Hex, transactionHash: ("0x" + "11".repeat(32)) as Hex, logIndex: 2 };
}

describe("codec", () => {
  it("encodes with the ABI's selector and types", () => {
    const data = pair().encode("liquidate", [ALICE], ["0x1234"]);
    expect(data.slice(0, 10)).toBe(sel("liquidate(address[],bytes[])"));
    const execs = [{ orderId: 7n, hints: { pred: 3n, pred2: 0n, pred3: 0n, pred4: 0n, maxSteps: 0 } }];
    const d2 = pair().encode("executeTriggeredOrders", execs, []);
    expect(d2.slice(0, 10)).toBe(sel("executeTriggeredOrders((uint64,(uint64,uint64,uint64,uint64,uint32))[],bytes[])"));
  });

  it("decodes named outputs and structs", () => {
    const raw = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, 9n]);
    expect(lens().decode("claimableFees", raw)).toEqual({ owed: 5n, total: 9n });
    const inv = [1n, 2n, 3n, 4n, -5n, 6n] as const;
    const t = { type: "tuple", components: [
      { name: "a", type: "uint256" }, { name: "b", type: "uint256" }, { name: "c", type: "uint256" },
      { name: "d", type: "uint256" }, { name: "e", type: "int192" }, { name: "f", type: "uint64" },
    ] } as const;
    const raw2 = encodeAbiParameters([t, t], [
      { a: inv[0], b: inv[1], c: inv[2], d: inv[3], e: inv[4], f: inv[5] },
      { a: inv[0], b: inv[1], c: inv[2], d: inv[3], e: inv[4], f: inv[5] },
    ]);
    const out = lens().decode<{ longInv: { entryFundingIndex: bigint }; shortInv: { seizedTs: bigint } }>("getPendingLiquidationExposure", raw2);
    expect(out.longInv.entryFundingIndex).toBe(-5n);
    expect(out.shortInv.seizedTs).toBe(6n);
  });

  it("decodes a position bucket log", () => {
    const p = pair();
    const data = encodeAbiParameters(
      ["bool", "uint256", "uint256", "uint256", "int256", "int256", "uint256", "uint256"].map((type) => ({ type })),
      [true, 10n, 20000n, 300n, -4n, 7n, 500n, 300n],
    );
    const d = p.decodeLog<{ owner: string; size: bigint; entryFundingIndex: bigint }>(
      log([p.topic("PositionBucketUpdated"), PAIR_ID, topicAddress(ALICE)], data),
    )!;
    expect(d.name).toBe("PositionBucketUpdated");
    expect(d.args.owner).toBe(ALICE);
    expect(d.args.size).toBe(10n);
    expect(d.args.entryFundingIndex).toBe(-4n);
  });

  it("decodes an order update's payload struct", () => {
    const p = pair();
    const spec = p.eventByName.get("OrderUpdated")!;
    const plain = spec.inputs.filter((x) => !x.indexed);
    const payloadType = plain[0]!;
    const comps = (payloadType as unknown as { components: readonly { name: string }[] }).components.map((c) => c.name);
    const values = [1, 4, false, false, 10n, 0n, 1950n, 0n, 500n, 0n, 0n, 2n ** 64n - 1n, 77n, 0, ALICE, 0];
    const payload = Object.fromEntries(comps.map((n, i) => [n, values[i]]));
    const data = encodeAbiParameters(plain, [payload, ...plain.slice(1).map(() => 0n)] as never);
    const d = p.decodeLog<{ orderId: bigint; payload: { orderType: number; triggerPrice: bigint } }>(
      log([p.topic("OrderUpdated"), PAIR_ID, padHex("0x4d", { size: 32 }), topicAddress(ALICE)], data),
    )!;
    expect(d.args.orderId).toBe(77n);
    expect(d.args.payload.orderType).toBe(4);
    expect(d.args.payload.triggerPrice).toBe(1950n);
  });

  it("decodes custom errors with hints and times", () => {
    const e = decodeError(sel("BazaarPair__LiquidationPriceTooOld()"));
    expect(e.name).toBe("BazaarPair__LiquidationPriceTooOld");
    expect(e.hint).toContain("the pair's stored price is more than 3 seconds old, which never decides a liquidation. Attach Pyth's latest update");
    expect(e.hint).toContain("at most a minute old");
    const e2 = decodeError(concatHex([sel("Factory__DeploymentNotExpired(uint256)"), encodeAbiParameters([{ type: "uint256" }], [1_800_000_000n])]));
    expect(e2.opensAt()).toBe(1_800_000_000);
    const e3 = decodeError(concatHex(["0x08c379a0", encodeAbiParameters([{ type: "string" }], ["nope"])]));
    expect(e3.name).toBe("Error");
    expect(e3.hint).toBe("nope");
    expect(decodeError("0x").name).toBe("Reverted");
    expect(decodeError("0xdeadbeef").name.startsWith("Unknown")).toBe(true);
  });
});
