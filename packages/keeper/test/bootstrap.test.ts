import { type Market, SubgraphError } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { Store } from "../src/state/store.js";
import { bootstrap } from "../src/sync/bootstrap.js";

const PAIR = getAddress("0x" + "ab".repeat(20));
const OTHER = "0x" + "cd".repeat(20); // a pair the keeper does not follow
const ALICE = "0x" + "aa".repeat(20);
const ID = ("0x" + "01".repeat(32)) as Hex;

function store(): Store {
  const s = new Store();
  const m: Market = {
    address: PAIR, pairId: ID, baseFeedId: ID, legs: [ID], invertQuote: false, continuous: true,
    description: "", label: "", state: null, dirty: true, lastRead: 0,
  };
  s.addMarket(m);
  return s;
}

const order = (kw: Record<string, unknown>) => ({
  id: "x", pair: { id: PAIR.toLowerCase() }, orderId: "7", owner: { id: ALICE }, orderType: "StopLoss", isLong: false, size: "10",
  filledSize: "0", triggerPrice: ((5n << 128n) | 1950n).toString(), limitPrice: "0", expiryBlock: "18446744073709551615",
  status: "Waiting", inBook: false, bountyHeld: "5", ...kw,
});

/** A subgraph whose pages are answered from `rows` by entity and filter. */
function subgraph(rows: Record<string, unknown[]>, failOn?: string) {
  const calls: { entity: string; where: string; block: number }[] = [];
  return {
    calls,
    async pages<T>(entity: string, _fields: string, where: string, block: number): Promise<T[]> {
      calls.push({ entity, where, block });
      if (failOn && where.includes(failOn)) throw new SubgraphError("subgraph returned HTTP 503: busy");
      return (rows[`${entity} ${where}`] ?? []) as T[];
    },
  };
}

describe("subgraph bootstrap", () => {
  it("loads open positions and live or bounty-holding orders as of one block", async () => {
    const sg = subgraph({
      "positions isOpen: true": [
        { id: "p1", pair: { id: PAIR.toLowerCase() }, account: { id: ALICE }, isLong: true, size: "5", entryValue: "10000", collateral: "900", entryFundingIndex: "-3" },
        { id: "p2", pair: { id: OTHER }, account: { id: ALICE }, isLong: true, size: "1", entryValue: "1", collateral: "1", entryFundingIndex: "0" },
      ],
      "orders status_in: [Waiting, Fired, Resting]": [order({})],
      'orders status_in: [Filled, Canceled], bountyHeld_gt: "0"': [order({ orderId: "8", status: "Canceled", bountyHeld: "2" })],
    });
    const s = store();
    expect(await bootstrap(sg, s, 900)).toEqual([1, 2]);
    expect(sg.calls.map((c) => c.block)).toEqual([900, 900, 900]);
    expect(s.positions.get(PAIR)!.get(getAddress(ALICE))).toEqual({
      account: getAddress(ALICE), isLong: true, size: 5n, entryValue: 10_000n, collateral: 900n, entryFundingIndex: -3n, block: 900,
    });
    expect(s.orders.get(PAIR)!.get(7n)).toEqual({
      orderId: 7n, owner: getAddress(ALICE), orderType: 4, isLong: false, size: 10n, filled: 0n, triggerPrice: 1950n, limitPrice: 0n,
      expiryBlock: 2 ** 64, terminal: false, inBook: false, bounty: 5n, block: 900, known: true,
    });
    expect(s.orders.get(PAIR)!.get(8n)).toMatchObject({ terminal: true, bounty: 2n });
    expect(s.positions.has(OTHER as Address)).toBe(false);
  });

  it("leaves the store as it was when the subgraph fails part-way", async () => {
    const rows = { "positions isOpen: true": [{ id: "p1", pair: { id: PAIR }, account: { id: ALICE }, isLong: true, size: "5", entryValue: "1", collateral: "1", entryFundingIndex: "0" }] };
    const s = store();
    await expect(bootstrap(subgraph(rows, "Filled"), s, 1)).rejects.toBeInstanceOf(SubgraphError);
    expect(s.positions.get(PAIR)!.size).toBe(0);
    const odd = subgraph({ "orders status_in: [Waiting, Fired, Resting]": [order({ orderType: "Iceberg" })] });
    await expect(bootstrap(odd, s, 1)).rejects.toThrow(/unknown order type Iceberg/);
    expect(s.orders.get(PAIR)!.size).toBe(0);
  });
});
