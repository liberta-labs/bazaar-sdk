/**
 * Smoke test for the end-to-end harness: replay the fixture deployment on a fresh Anvil, build the
 * ETH/USD scenario, and check through the SDK's reads that the chain holds what the scenario meant
 * to build.
 *
 * Start a fresh Anvil (one-second blocks, a low base fee, Bazaar's contract sizes), then run:
 *
 *     anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
 *     npx vitest run -c vitest.e2e.config.ts
 *
 * BAZAAR_E2E_RPC overrides the URL (default http://127.0.0.1:8546). With no Anvil answering there,
 * the suite is skipped. The run snapshots the chain before the replay and reverts to it afterwards,
 * so the next e2e file finds the deployer's nonce at 0 again and can replay on the same Anvil.
 *
 * The keeper run (keeper.e2e.test.ts, the port of the Python keeper's tests/e2e/run_e2e.py) and the
 * frontend SDK run (frontend.e2e.test.ts) build on the same deploy + Scenario setup.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ContractCodec, STOP_LOSS, TRIGGER_PRICE_MASK } from "@liberta-labs/bazaar-sdk";
import { ARBSYS, Anvil, E18, FACTORY, FEED, LENS, MOCKS, PAIR, Scenario, clientVersion, deploy } from "./chain.js";

const RPC = process.env.BAZAAR_E2E_RPC ?? "http://127.0.0.1:8546";
const BROADCAST = fileURLToPath(new URL("./fixtures/run-latest.json", import.meta.url));
const ARBSYS_ARTIFACT = fileURLToPath(new URL("./fixtures/MockArbSys.json", import.meta.url));

const version = await clientVersion(RPC);
const anvilUp = version !== null && version.toLowerCase().startsWith("anvil");
if (!anvilUp) console.warn(`e2e: no Anvil answers at ${RPC} (${version ?? "no answer"}); skipping`);

interface Ask {
  label: string;
  price: bigint;
  size: bigint;
  filled: bigint;
}

/** Fill `qty` against the asks, best price first; returns the notional paid (BAZAAR precision). */
function take(asks: Ask[], qty: bigint): bigint {
  let left = qty;
  let notional = 0n;
  for (const a of asks) {
    const q = left < a.size - a.filled ? left : a.size - a.filled;
    a.filled += q;
    left -= q;
    notional += (q * a.price) / E18;
    if (left === 0n) break;
  }
  if (left !== 0n) throw new Error("the model's book ran dry");
  return notional;
}

describe.skipIf(!anvilUp)(`replayed deployment and market scenario on ${version}`, () => {
  const anvil = new Anvil(RPC);
  let snap: Hex | null = null;
  let names: Record<string, Address> = {};
  let sc: Scenario;

  // What the scenario's trades should leave, from a model of the ask book it builds.
  const asks: Ask[] = [];
  let takerNotional = 0n;
  let victimNotional = 0n;

  const read = async <T>(to: Address, codec: ContractCodec, fn: string, ...args: unknown[]): Promise<T> =>
    codec.decode<T>(fn, await anvil.chain.call(to, codec.encode(fn, ...args)));

  beforeAll(async () => {
    snap = await anvil.snapshot();
    names = await deploy(anvil, BROADCAST, ARBSYS_ARTIFACT);
    sc = new Scenario(anvil, names);
    await sc.setup((line) => console.log(line));

    asks.push(
      { label: "ask2010", price: 2010n * E18, size: (3n * E18) / 2n, filled: 0n },
      { label: "ask2020", price: 2020n * E18, size: E18, filled: 0n },
      { label: "ask2030", price: 2030n * E18, size: 2n * E18, filled: 0n },
    );
    takerNotional = take(asks, 2n * E18);
    asks.push({ label: "ask2045", price: 2045n * E18, size: sc.victimSize + E18, filled: 0n });
    victimNotional = take(asks, sc.victimSize);
  });

  afterAll(async () => {
    // Back to before the replay, so another e2e file can replay on this Anvil.
    if (snap) await anvil.revert(snap);
  });

  it("replays every recorded contract and etches ArbSys", async () => {
    for (const n of ["BazaarFactory", "BazaarPair", "BazaarPairLens", "BazaarPairTerminator", "BazaarOracle", "MockPyth", "MockUSDC", "MockOptimisticOracleV3", "MatchingEngineLib"]) {
      expect(names[n], n).toBeDefined();
      expect((await anvil.chain.code(names[n]!)).length, n).toBeGreaterThan(2);
    }
    // Same transactions from the same account: every contract lands where the record says.
    const record = JSON.parse(readFileSync(BROADCAST, "utf8")) as { transactions: { contractName: string | null; contractAddress: string | null }[] };
    const recorded: Record<string, Address> = {};
    for (const t of record.transactions) if (t.contractName && t.contractAddress) recorded[t.contractName] ??= getAddress(t.contractAddress);
    expect(names).toEqual(recorded);
    const art = JSON.parse(readFileSync(ARBSYS_ARTIFACT, "utf8")) as { deployedBytecode: { object: string } };
    expect(await anvil.chain.code(ARBSYS)).toBe(art.deployedBytecode.object.toLowerCase());
  });

  it("wires the factory to the replayed contracts", async () => {
    const fns = ["lens", "oracle", "pairTerminator", "pairImplementation", "usdc", "oo"] as const;
    const out = await anvil.chain.batch(fns.map((f) => ({ to: names.BazaarFactory!, data: FACTORY.encode(f) })));
    const got = Object.fromEntries(fns.map((f, i) => [f, FACTORY.decode<Address>(f, out[i]![1])]));
    expect(out.every(([ok]) => ok)).toBe(true);
    expect(got).toEqual({
      lens: names.BazaarPairLens,
      oracle: names.BazaarOracle,
      pairTerminator: names.BazaarPairTerminator,
      pairImplementation: names.BazaarPair,
      usdc: names.MockUSDC,
      oo: names.MockOptimisticOracleV3,
    });
  });

  it("lists exactly the ETH/USD market", async () => {
    const pairs = await read<Address[]>(sc.factory, FACTORY, "getAllPairs");
    expect(pairs.map((p) => getAddress(p))).toEqual([sc.pair]);
    expect(await read<boolean>(sc.factory, FACTORY, "isPair", sc.pair)).toBe(true);
    expect(await read<Address>(sc.factory, FACTORY, "pairAddressByBaseFeed", FEED)).toBe(sc.pair);
    expect(await read<Hex>(sc.pair, PAIR, "baseFeedId")).toBe(FEED);
    expect(await read<boolean>(sc.pair, PAIR, "isContinuouslyTraded")).toBe(true);
    expect(await read<boolean>(sc.pair, PAIR, "isPairTerminated")).toBe(false);
    expect(await read<Address>(sc.pair, PAIR, "usdc")).toBe(names.MockUSDC);
    expect(await read<Address>(sc.pair, PAIR, "oracle")).toBe(names.BazaarOracle);
    const p = await read<{ spotPrice: bigint }>(sc.pair, PAIR, "lastPairPrice");
    expect(p.spotPrice).toBe(2000n * E18);
  });

  it("rests the three bids untouched", async () => {
    const depth = await read<{ orderIds: readonly bigint[]; prices: readonly bigint[] }>(sc.lens, LENS, "getBookDepth", sc.pair, true, 0n, 10n);
    expect([...depth.orderIds]).toEqual([sc.orders.bid1990, sc.orders.bid1980, sc.orders.bid1970]);
    expect([...depth.prices]).toEqual([1990n * E18, 1980n * E18, 1970n * E18]);
    for (const l of ["bid1990", "bid1980", "bid1970"]) {
      const o = await sc.order(sc.orders[l]!);
      expect([o.creator, o.isLong, o.inBook, o.size, o.filledSize], l).toEqual([sc.w[1], true, true, E18, 0n]);
    }
    const active = await read<{ count: bigint }>(sc.lens, LENS, "getUserActiveLimitOrders", sc.pair, sc.w[1]);
    expect(active.count).toBe(3n);
  });

  it("fills the asks the two market buys reach, best price first", async () => {
    for (const a of asks) {
      const o = await sc.order(sc.orders[a.label]!);
      expect([o.creator, o.isLong, o.limitPrice, o.size, o.filledSize, o.inBook], a.label).toEqual([
        sc.w[2],
        false,
        a.price,
        a.size,
        a.filled,
        a.filled < a.size,
      ]);
    }
    const resting = asks.filter((a) => a.filled < a.size);
    const depth = await read<{ orderIds: readonly bigint[]; prices: readonly bigint[] }>(sc.lens, LENS, "getBookDepth", sc.pair, false, 0n, 10n);
    expect([...depth.orderIds]).toEqual(resting.map((a) => sc.orders[a.label]));
    expect([...depth.prices]).toEqual(resting.map((a) => a.price));
    for (const l of ["market-buy", "victim-buy"]) {
      const o = await sc.order(sc.orders[l]!);
      expect(o.filledSize, l).toBe(o.size);
      expect(o.filledBlock, l).toBeGreaterThan(0);
    }
  });

  it("opens the positions the trades imply", async () => {
    const bucket = (i: number) => read<{ isLong: boolean; size: bigint; entryValue: bigint; collateral: bigint; stopLossOrderId: bigint }>(
      sc.lens, LENS, "getPositionBucket", sc.pair, sc.w[i],
    );
    const b3 = await bucket(3);
    expect([b3.isLong, b3.size, b3.entryValue]).toEqual([true, 2n * E18, takerNotional]);
    const b6 = await bucket(6);
    expect([b6.isLong, b6.size, b6.entryValue]).toEqual([true, sc.victimSize, victimNotional]);
    const b2 = await bucket(2);
    expect([b2.isLong, b2.size, b2.entryValue]).toEqual([false, 2n * E18 + sc.victimSize, takerNotional + victimNotional]);
    // The bucket the pair stores is the one the lens reports.
    expect((await sc.bucket(6)).size).toBe(b6.size);
    // Takers pay a fee out of collateral; untouched accounts keep exactly what they deposited.
    for (const [i, deposit] of [[3, 10_000n], [6, 1_000n]] as const) {
      const c = (await bucket(i)).collateral;
      expect(c, `account ${i}`).toBeLessThan(deposit * E18);
      expect(c, `account ${i}`).toBeGreaterThan(((deposit * E18) * 999n) / 1000n);
    }
    expect((await bucket(1)).collateral).toBe(40_000n * E18);
    expect((await bucket(4)).collateral).toBe(10_000n * E18);
    const open = [];
    for (let i = 0; i < 8; i++) if ((await sc.bucket(i)).size) open.push(sc.w[i]);
    expect(open).toEqual([sc.w[2], sc.w[3], sc.w[6]]);
    const vault = await read<{ totalLongOI: bigint; totalShortOI: bigint }>(sc.pair, PAIR, "pairVault");
    expect([vault.totalLongOI, vault.totalShortOI]).toEqual([2n * E18 + sc.victimSize, 2n * E18 + sc.victimSize]);
    expect(await sc.inventory()).toBe(0n);
  });

  it("rests the stop-loss under account 3's long with a $1 bounty", async () => {
    const id = sc.orders["stop-loss"]!;
    const o = await sc.order(id);
    expect([o.creator, o.orderType, o.isLong, o.size, o.filledSize, o.inBook]).toEqual([sc.w[3], STOP_LOSS, false, 2n * E18, 0n, false]);
    expect(o.triggerPrice & TRIGGER_PRICE_MASK).toBe(1950n * E18);
    expect([o.filledBlock, o.canceledBlock]).toEqual([0, 0]);
    expect(await read<bigint>(sc.lens, LENS, "triggerBounty", sc.pair, id)).toBe(E18);
    expect((await sc.bucket(3)).stopLossOrderId).toBe(id);
  });

  it("holds account 5's insurance deposit", async () => {
    expect(await read<bigint>(sc.pair, PAIR, "insuranceShares", sc.w[5])).toBeGreaterThan(0n);
    const value = await read<bigint>(sc.lens, LENS, "getInsuranceDepositValue", sc.pair, sc.w[5]);
    expect(value).toBeGreaterThanOrEqual(20_000n * E18);
    expect(value).toBeLessThan(20_010n * E18);
  });

  it("leaves the victim solvent now and liquidatable at the price the keeper run moves to", async () => {
    const liq = await sc.liquidationPrice();
    expect(liq).toBeGreaterThan(0);
    expect(liq).toBeLessThan(2000);
    const solvent = async (usd: number) =>
      (await read<{ isSolvent: boolean }>(sc.lens, LENS, "checkBucketSolvency", sc.pair, sc.w[6], BigInt(Math.round(usd * 100)) * 10n ** 16n)).isSolvent;
    expect(await solvent(2000)).toBe(true);
    expect(await solvent(liq)).toBe(false);
  });

  it("funds the makers and takers but not the keeper", async () => {
    expect(await read<bigint>(sc.usdc, MOCKS, "balanceOf", sc.w[7])).toBe(0n);
    expect(await read<bigint>(sc.usdc, MOCKS, "balanceOf", sc.w[4])).toBe(2_000_000n * 10n ** 6n - 10_000n * 10n ** 6n);
  });
});
