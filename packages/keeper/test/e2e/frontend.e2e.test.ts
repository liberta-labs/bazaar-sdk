/**
 * End-to-end: the frontend SDK on the replayed ETH/USD scenario.
 *
 * The SDK connects with `connect()` over a JsonRpc transport, takes prices from the keeper's mock
 * Hermes server through `hermesPriceSource`, and signs and sends through small test EIP-1193
 * wallets: a viem local account answering eth_accounts, eth_chainId, eth_signTypedData_v4 and
 * eth_sendTransaction (signed here, sent raw), and forwarding everything else to Anvil. Every write is
 * simulated first (`simulate`), then sent and checked on chain.
 *
 * Accounts: 8 is the frontend's trader, 9 a relayer, 5 the scenario's insurer (votes on a
 * termination), 0 the deployer (the bug-bounty address, which earns the fee skim).
 *
 * The cases share one chain and run in order: each builds on the state the last left. Clock warps
 * (13 days for the insurance exit, 48 hours for a listing) come late, and the termination last: a
 * UMA claim and an insurer vote that schedules the market, the claim settled on the mock oracle,
 * the settlement price fixed from the mock's archived prints after the cutoff, and finalize after
 * the 14-day escape hatch (no keeper settles positions here).
 *
 * markets.ts, account.ts, live.ts and prices.ts are imported from their sources: the SDK index does
 * not export them yet.
 *
 *     anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
 *     npx vitest run -c vitest.e2e.config.ts packages/keeper/test/e2e/frontend.e2e.test.ts
 */

import { fileURLToPath } from "node:url";
import { type Address, type Hex, decodeFunctionData, getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BazaarContext,
  CallError,
  type DecodedLog,
  JsonRpc,
  LIMIT,
  MARKET,
  type PreparedCall,
  type Receipt,
  STOP_LOSS,
  type Transport,
  USER_MESSAGES,
  allowance,
  bazaarPairAbi,
  connect,
  governance,
  insurance,
  listings,
  permits,
  previews,
  relay,
  sendCall,
  signing,
  simulate,
  termination,
  trade,
  userMessage,
  waitForReceipt,
} from "@liberta-labs/bazaar-sdk";
import type { CostedCall } from "../../../sdk/src/client/uma.js";
import { hermesPriceSource } from "../../../sdk/src/client/prices.js";
import * as markets from "../../../sdk/src/client/markets.js";
import * as account from "../../../sdk/src/client/account.js";
import * as live from "../../../sdk/src/client/live.js";
import { MockHermes, startMockHermes } from "../../src/index.js";
import type { MockHermesServer } from "../../src/devtools/mock-hermes.js";
import { Anvil, E18, FACTORY, FEED, LENS, MOCKS, PAIR, Scenario, clientVersion, deploy, keys } from "./chain.js";

const RPC = process.env.BAZAAR_E2E_RPC ?? "http://127.0.0.1:8546";
const BROADCAST = fileURLToPath(new URL("./fixtures/run-latest.json", import.meta.url));
const ARBSYS_ARTIFACT = fileURLToPath(new URL("./fixtures/MockArbSys.json", import.meta.url));
const BTC_FEED: Hex = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const USDC = 10n ** 6n;

const version = await clientVersion(RPC);
const anvilUp = version !== null && version.toLowerCase().startsWith("anvil");
if (!anvilUp) console.warn(`e2e: no Anvil answers at ${RPC} (${version ?? "no answer"}); skipping`);

// ---- a test EIP-1193 wallet ----

type TypedField = { name: string; type: string };

/** eth_signTypedData_v4 JSON carries integers as decimal strings: back to bigint, by the types. */
function coerce(types: Record<string, TypedField[]>, type: string, value: unknown): unknown {
  if (type.endsWith("]")) return (value as unknown[]).map((v) => coerce(types, type.slice(0, type.lastIndexOf("[")), v));
  const struct = types[type];
  if (struct) {
    const out: Record<string, unknown> = {};
    for (const f of struct) out[f.name] = coerce(types, f.type, (value as Record<string, unknown>)[f.name]);
    return out;
  }
  if (/^u?int\d*$/.test(type)) return BigInt(value as string | number | bigint);
  return value;
}

interface TestWallet extends Transport {
  readonly address: Address;
  readonly sent: Hex[];
}

/** A viem local account behind EIP-1193: it signs; Anvil answers everything else. */
function testWallet(pk: Hex, rpc: JsonRpc, chainId = 31337): TestWallet {
  const acct = privateKeyToAccount(pk);
  const sent: Hex[] = [];
  const ask = (method: string, params: readonly unknown[] = []) => rpc.request({ method, params });
  return {
    address: acct.address,
    sent,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [acct.address];
        case "eth_chainId":
          return toHex(chainId);
        case "eth_signTypedData_v4": {
          const [who, json] = params as [string, string];
          if (getAddress(who) !== acct.address) throw Object.assign(new Error("unknown account"), { code: 4100 });
          const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, TypedField[]>; primaryType: string; message: unknown };
          const { EIP712Domain: _, ...types } = td.types;
          const sign = acct.signTypedData as (p: { domain: unknown; types: unknown; primaryType: string; message: unknown }) => Promise<Hex>;
          return sign({ domain: td.domain, types, primaryType: td.primaryType, message: coerce(types, td.primaryType, td.message) });
        }
        case "eth_sendTransaction": {
          const [tx] = params as [{ from: string; to: Address; data?: Hex; value?: Hex; gas?: Hex }];
          if (getAddress(tx.from) !== acct.address) throw Object.assign(new Error("unknown account"), { code: 4100 });
          const value = BigInt(tx.value ?? "0x0");
          // As a wallet does: estimate (a revert surfaces here, with its data), then sign and send raw.
          const gas = tx.gas
            ? BigInt(tx.gas)
            : (BigInt((await ask("eth_estimateGas", [{ from: acct.address, to: tx.to, data: tx.data ?? "0x", value: toHex(value) }])) as string) * 13n) / 10n + 50_000n;
          const [nonce, block] = await Promise.all([
            ask("eth_getTransactionCount", [acct.address, "pending"]) as Promise<string>,
            ask("eth_getBlockByNumber", ["latest", false]) as Promise<{ baseFeePerGas: string }>,
          ]);
          const raw = await acct.signTransaction({
            type: "eip1559",
            chainId,
            nonce: Number(BigInt(nonce)),
            to: tx.to,
            data: tx.data ?? "0x",
            value,
            gas,
            maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + 1n,
            maxPriorityFeePerGas: 0n,
          });
          const hash = (await ask("eth_sendRawTransaction", [raw])) as Hex;
          sent.push(hash);
          return hash;
        }
        default:
          return ask(method, params);
      }
    },
  };
}

// ---- helpers ----

const decodeLogs = (r: Receipt): DecodedLog[] => r.logs.map((l) => PAIR.decodeLog(l)).filter((d): d is DecodedLog => d !== null);
const named = (r: Receipt, name: string) => decodeLogs(r).filter((d) => d.name === name);

describe.skipIf(!anvilUp)(`frontend SDK end to end on ${version}`, () => {
  const anvil = new Anvil(RPC);
  const rpc = new JsonRpc(RPC, { perSecond: 1_000, timeoutMs: 60_000 });
  let snap: Hex | null = null;
  let sc: Scenario;
  let srv: MockHermesServer | null = null;
  let ctx: BazaarContext;
  let pair: Address;
  const k = keys();
  const user = testWallet(k[8]!, rpc);
  const relayer = testWallet(k[9]!, rpc);
  const insurer = testWallet(k[5]!, rpc);
  const deployer = testWallet(k[0]!, rpc);
  const ids: Record<string, bigint> = {};
  const liveUpdates: live.MarketUpdate[] = [];
  let watch: live.WatchHandle | null = null;

  const read = async <T>(to: Address, codec: typeof PAIR, fn: string, ...args: unknown[]): Promise<T> =>
    codec.decode<T>(fn, await anvil.call(to, codec.encode(fn, ...args)));
  const bucket = (who: Address) =>
    read<{ isLong: boolean; size: bigint; entryValue: bigint; collateral: bigint; stopLossOrderId: bigint }>(sc.pair, PAIR, "positionBuckets", who);
  const claimable = async (who: Address) => (await read<{ owed: bigint }>(sc.lens, LENS, "claimableFees", sc.pair, who)).owed;

  /** Simulate as the call's sender, then send through `wallet` and wait for the receipt. */
  async function run(wallet: TestWallet, call: PreparedCall, label = call.action): Promise<Receipt> {
    const sim = await simulate(ctx, call, { from: call.from ?? wallet.address });
    expect(sim.ok, `${label} simulation: ${sim.error ? `${sim.error.name}: ${sim.error.message}` : ""}`).toBe(true);
    const hash = await sendCall(wallet, call, { from: call.from ?? wallet.address });
    return waitForReceipt(ctx, hash, { pollMs: 200 });
  }

  /** A costed call's approvals first, then the call. */
  async function runCosted(wallet: TestWallet, call: CostedCall, label = call.action): Promise<Receipt> {
    for (const a of call.approvals) await run(wallet, a, `${label} approval`);
    return run(wallet, call, label);
  }

  /** A resting order's expiry: 100,000 L2 blocks out. */
  const expiry = async () => (await ctx.chain.blockNumber()) + 100_000;

  /** The id of the order a receipt created (its first OrderUpdated). */
  const createdId = (r: Receipt): bigint => {
    const u = named(r, "OrderUpdated")[0];
    if (!u) throw new Error("no OrderUpdated in the receipt");
    return u.args.orderId as bigint;
  };

  beforeAll(async () => {
    snap = await anvil.snapshot();
    const names = await deploy(anvil, BROADCAST, ARBSYS_ARTIFACT);
    sc = new Scenario(anvil, names);
    await sc.setup((line) => console.log(line));
    pair = sc.pair;
    for (const who of [user.address, relayer.address]) {
      await anvil.send(sc.w[0]!, sc.usdc, MOCKS.encode("mint", who, 2_000_000n * USDC));
    }
    srv = await startMockHermes(new MockHermes(RPC, sc.pyth, { [FEED]: 2000.0 }, { [FEED]: "Crypto.ETH/USD" }), { port: 0 });
    ctx = await connect({ transport: rpc, factory: names.BazaarFactory!, prices: hermesPriceSource(srv.url), chainId: 31337 });
  });

  afterAll(async () => {
    watch?.stop();
    try {
      await srv?.close();
    } finally {
      if (snap) await anvil.revert(snap);
    }
  });

  // ---- connection and reads ----

  it("connects to the replayed deployment", () => {
    expect(ctx.chainId).toBe(31337);
    expect(ctx.lens).toBe(sc.lens);
    expect(ctx.usdc).toBe(sc.usdc);
  });

  it("signing.verifyTypehashes matches the deployed pair", async () => {
    const rep = await signing.verifyTypehashes(ctx, pair);
    expect(rep.mismatches).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.domain?.sdk).toBe(rep.domain?.chain);
    expect(rep.constants.maxDeadlineWindow).toBe(signing.MAX_DEADLINE_WINDOW);
  });

  it("markets: listMarkets, getMarket, marketSnapshot and getBook read the scenario", async () => {
    const list = await markets.listMarkets(ctx);
    expect(list.map((m) => m.address)).toEqual([pair]);
    expect(list[0]!.label).toBe("ETH/USD");
    const m = await markets.getMarket(ctx, "ETH/USD");
    expect(m.address).toBe(pair);
    const snapM = await markets.marketSnapshot(ctx, m);
    expect(snapM.status).toBe("live");
    expect(snapM.price.spot).toBe(2000n * E18);
    const book = await markets.getBook(ctx, m, 10);
    expect(book.bids.levels.map((l) => l.price)).toEqual([1990n * E18, 1980n * E18, 1970n * E18]);
    const depth = await read<{ prices: readonly bigint[] }>(sc.lens, LENS, "getBookDepth", pair, false, 0n, 10n);
    expect(book.asks.levels.map((l) => l.price)).toEqual([...depth.prices]);
  });

  it("account: accountSnapshot and portfolio match the chain", async () => {
    const b = await bucket(sc.w[6]!);
    const a = await account.accountSnapshot(ctx, pair, sc.w[6]!);
    expect([a.position.isLong, a.position.size, a.position.entryValue, a.position.collateral]).toEqual([b.isLong, b.size, b.entryValue, b.collateral]);
    expect(a.hasPosition).toBe(true);
    const p = await account.portfolio(ctx, user.address);
    expect(p).toBeDefined();
  });

  it("live: watchMarket starts and delivers a first snapshot", async () => {
    watch = live.watchMarket(ctx, pair, (u) => liveUpdates.push(u), { refreshMs: 0, pollMs: 500 });
    await watch.ready;
    expect(liveUpdates.some((u) => u.type === "snapshot")).toBe(true);
  });

  // ---- collateral and fees ----

  it("trade.claimFees: the bug-bounty address claims its fee skim", async () => {
    const owed = await claimable(deployer.address);
    expect(owed).toBeGreaterThan(0n);
    const bal0 = await allowance.usdcBalance(ctx, deployer.address);
    const r = await run(deployer, await trade.claimFees(ctx, pair, deployer.address));
    const ev = named(r, "FeesClaimed")[0]!;
    expect(ev.args.amount).toBe(owed);
    expect((await allowance.usdcBalance(ctx, deployer.address)) - bal0).toBe(owed / 10n ** 12n);
    expect(await claimable(deployer.address)).toBeLessThan(10n ** 12n);
  });

  it("trade.depositCollateral with a permits.signPermit permit (no allowance)", async () => {
    expect(await allowance.usdcAllowance(ctx, user.address, pair)).toBe(0n);
    const permit = await permits.signPermit(ctx, user, { owner: user.address, spender: pair, value: 1_000n * USDC });
    const chk = await permits.checkPermit(ctx, permit.permitData, { owner: user.address, spender: pair, needUsdc: 1_000n * USDC });
    expect(chk.problems).toEqual([]);
    const bal0 = await allowance.usdcBalance(ctx, user.address);
    const call = await trade.depositCollateral(ctx, pair, user.address, 1_000n * E18, { permitData: permit.permitData });
    const r = await run(user, call);
    expect(named(r, "CollateralDeposited")[0]!.args.amount).toBe(1_000n * E18);
    expect((await bucket(user.address)).collateral).toBe(1_000n * E18);
    expect(bal0 - (await allowance.usdcBalance(ctx, user.address))).toBe(1_000n * USDC);
  });

  it("trade.depositCollateral direct, after allowance.approveUsdc", async () => {
    await run(user, await allowance.approveUsdc(ctx, user.address, pair, 200_000n * USDC));
    const r = await run(user, await trade.depositCollateral(ctx, pair, user.address, 5_000n * E18));
    expect(named(r, "CollateralDeposited")[0]!.args.amount).toBe(5_000n * E18);
    expect((await bucket(user.address)).collateral).toBe(6_000n * E18);
  });

  it("trade.withdrawCollateral", async () => {
    const bal0 = await allowance.usdcBalance(ctx, user.address);
    const r = await run(user, await trade.withdrawCollateral(ctx, pair, user.address, 500n * E18));
    expect(named(r, "CollateralWithdrawn")[0]!.args.amount).toBe(500n * E18);
    expect((await bucket(user.address)).collateral).toBe(5_500n * E18);
    expect((await allowance.usdcBalance(ctx, user.address)) - bal0).toBe(500n * USDC);
  });

  // ---- orders ----

  it("trade.createOrder: a Limit bid placed with hints rests behind the better bid", async () => {
    const call = await trade.createOrder(ctx, pair, user.address, { orderType: LIMIT, isLong: true, size: E18, limitPrice: 1985n * E18, expirationBlock: await expiry() });
    const args = decodeFunctionData({ abi: bazaarPairAbi, data: call.data }).args as readonly unknown[];
    const hints = args[1] as { pred: bigint };
    expect(hints.pred).toBe(sc.orders.bid1990);
    const r = await run(user, call);
    ids.bidA = createdId(r);
    const o = await sc.order(ids.bidA);
    expect([o.creator, o.inBook, o.prevInBook, o.limitPrice]).toEqual([user.address, true, sc.orders.bid1990, 1985n * E18]);
    const depth = await read<{ orderIds: readonly bigint[] }>(sc.lens, LENS, "getBookDepth", pair, true, 0n, 10n);
    expect([...depth.orderIds]).toEqual([sc.orders.bid1990, ids.bidA, sc.orders.bid1980, sc.orders.bid1970]);
  });

  it("previews.previewOrder, then trade.createOrder Market: the preview matches the fills and position", async () => {
    const order = { orderType: MARKET, isLong: true, size: E18 / 2n, maxSlippageBp: 300n } as const;
    const lp = await trade.livePairPrice(ctx, pair);
    const pv = await previews.previewOrder(ctx, pair, user.address, order, {
      price: { spot: lp.price.spot, low: lp.price.low, high: lp.price.high, publishTime: lp.price.publishTime },
    });
    expect(pv.blockers).toEqual([]);
    const call = await trade.createOrder(ctx, pair, user.address, order);
    const r = await run(user, call);
    ids.market = createdId(r);
    const trades = named(r, "Trade").filter((t) => getAddress(t.args.taker as string) === user.address);
    const fills = pv.fills.filter((f) => f.role === "taker" && !f.later);
    console.log(
      `   preview: ${fills.map((f) => `${Number(f.size) / 1e18}@${Number(f.price) / 1e18} fee ${f.fee.total}`).join(", ")}; ` +
        `chain: ${trades.map((t) => `${Number(t.args.fillSize) / 1e18}@${Number(t.args.price) / 1e18} fee ${t.args.takerFee}`).join(", ")}`,
    );
    expect(fills.map((f) => [f.price, f.size, f.fee.total])).toEqual(trades.map((t) => [t.args.price, t.args.fillSize, t.args.takerFee]));
    expect(pv.takerSize).toBe(trades.reduce((s, t) => s + (t.args.fillSize as bigint), 0n));
    expect(pv.fees.total).toBe(trades.reduce((s, t) => s + (t.args.takerFee as bigint), 0n));
    const b = await bucket(user.address);
    console.log(`   entry funding index: preview ${pv.afterArrival.entryFundingIndex}, chain ${(await read<{ entryFundingIndex: bigint }>(sc.pair, PAIR, "positionBuckets", user.address)).entryFundingIndex}`);
    expect([b.isLong, b.size, b.entryValue, b.collateral]).toEqual([
      pv.afterArrival.isLong,
      pv.afterArrival.size,
      pv.afterArrival.entryValue,
      pv.afterArrival.collateral,
    ]);
  });

  it("live: the watch saw the market buy's Trade", async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000 && !liveUpdates.some((u) => u.type === "event" && u.event.name === "Trade")) await new Promise((r) => setTimeout(r, 200));
    expect(liveUpdates.some((u) => u.type === "event" && u.event.name === "Trade")).toBe(true);
  });

  it("trade.createOrder: a StopLoss with a keeper bounty escrows the bounty", async () => {
    const bounty = E18 / 2n; // $0.50
    const bal0 = await allowance.usdcBalance(ctx, user.address);
    const call = await trade.createOrder(ctx, pair, user.address, {
      orderType: STOP_LOSS,
      isLong: false,
      size: E18 / 2n,
      triggerPrice: 1900n * E18,
      bounty,
      maxSlippageBp: 500n,
    });
    expect(call.pullsUsdc).toBe(bounty);
    const r = await run(user, call);
    ids.stop = createdId(r);
    expect(await read<bigint>(sc.lens, LENS, "triggerBounty", pair, ids.stop)).toBe(bounty);
    expect(bal0 - (await allowance.usdcBalance(ctx, user.address))).toBe(bounty / 10n ** 12n);
    const o = await sc.order(ids.stop);
    expect([o.orderType, o.isLong, o.triggerPrice, o.inBook]).toEqual([STOP_LOSS, false, 1900n * E18, false]);
    expect((await bucket(user.address)).stopLossOrderId).toBe(ids.stop);
  });

  it("previews.previewOrder, then a reducing Market sell: closing fee, realized PnL and position match", async () => {
    const order = { orderType: MARKET, isLong: false, size: E18 / 5n, maxSlippageBp: 300n } as const;
    const lp = await trade.livePairPrice(ctx, pair);
    const pv = await previews.previewOrder(ctx, pair, user.address, order, {
      price: { spot: lp.price.spot, low: lp.price.low, high: lp.price.high, publishTime: lp.price.publishTime },
    });
    expect(pv.blockers).toEqual([]);
    expect([pv.reduces, pv.opens, pv.closes]).toEqual([true, false, false]);
    const r = await run(user, await trade.createOrder(ctx, pair, user.address, order));
    const trades = named(r, "Trade").filter((t) => getAddress(t.args.taker as string) === user.address);
    const fills = pv.fills.filter((f) => f.role === "taker" && !f.later);
    expect(fills.map((f) => [f.price, f.size, f.fee.total])).toEqual(trades.map((t) => [t.args.price, t.args.fillSize, t.args.takerFee]));
    const mod = named(r, "PositionModified").filter((e) => getAddress(e.args.user as string) === user.address);
    const realized = mod.reduce((acc, e) => acc + (e.args.realizedPnl as bigint), 0n);
    console.log(`   reduce: realized PnL preview ${pv.realizedPnl}, chain ${realized}; fees ${pv.fees.total} vs ${trades.reduce((acc, t) => acc + (t.args.takerFee as bigint), 0n)}`);
    expect(pv.realizedPnl).toBe(realized);
    const b = await bucket(user.address);
    expect([b.isLong, b.size, b.entryValue, b.collateral]).toEqual([
      pv.afterArrival.isLong,
      pv.afterArrival.size,
      pv.afterArrival.entryValue,
      pv.afterArrival.collateral,
    ]);
  });

  it("account.accountSnapshot shows the trader's position and its stop-loss", async () => {
    const b = await bucket(user.address);
    const a = await account.accountSnapshot(ctx, pair, user.address);
    expect([a.position.isLong, a.position.size, a.position.entryValue, a.position.collateral]).toEqual([b.isLong, b.size, b.entryValue, b.collateral]);
    expect(a.stopLoss?.orderId).toBe(ids.stop);
    expect(a.orders.map((o) => o.orderId)).toContain(ids.bidA);
  });

  it("trade.amendOrders: one amendment moves, a best-effort one that would cross is skipped", async () => {
    const r0 = await run(user, await trade.createOrder(ctx, pair, user.address, { orderType: LIMIT, isLong: true, size: E18, limitPrice: 1960n * E18, expirationBlock: await expiry() }));
    ids.bidB = createdId(r0);
    const call = await trade.amendOrders(ctx, pair, user.address, [
      { orderId: ids.bidA!, limitPrice: 1984n * E18, size: (3n * E18) / 2n },
      { orderId: ids.bidB, limitPrice: 2100n * E18, size: E18, bestEffort: true },
    ]);
    const r = await run(user, call);
    const amended = named(r, "OrderAmended");
    const skipped = named(r, "OrderAmendSkipped");
    expect(amended.map((e) => [e.args.orderId, e.args.limitPrice, e.args.size])).toEqual([[ids.bidA, 1984n * E18, (3n * E18) / 2n]]);
    expect(skipped.map((e) => e.args.orderId)).toEqual([ids.bidB]);
    const a = await sc.order(ids.bidA!);
    const b = await sc.order(ids.bidB);
    expect([a.limitPrice, a.size, a.inBook]).toEqual([1984n * E18, (3n * E18) / 2n, true]);
    expect([b.limitPrice, b.inBook]).toEqual([1960n * E18, true]);
  });

  it("trade.cancelOrders cancels both bids", async () => {
    const r = await run(user, await trade.cancelOrders(ctx, pair, user.address, [ids.bidA!, ids.bidB!]));
    expect(named(r, "OrderUpdated").length).toBeGreaterThanOrEqual(2);
    for (const id of [ids.bidA!, ids.bidB!]) {
      const o = await sc.order(id);
      expect([o.canceledBlock > 0, o.inBook]).toEqual([true, false]);
    }
  });

  // ---- the error path ----

  it("a refused call comes back from simulate with a decoded error and its user-facing message", async () => {
    const call = await trade.withdrawCollateral(ctx, pair, user.address, 1_000_000n * E18);
    const sim = await simulate(ctx, call);
    expect(sim.ok).toBe(false);
    const err = sim.error!;
    console.log(`   refused: ${err.name}: ${err.message}`);
    expect(err.name in USER_MESSAGES).toBe(true);
    expect(err.message).toBe(userMessage(err.name, err.args));
    expect(err.message).not.toBe(err.name);
    // A wallet refuses it at estimation; sendCall reports the same decoded reason.
    const e = await sendCall(user, call).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CallError);
    expect((e as CallError).decoded?.name).toBe(err.name);
    expect((e as CallError).message).toBe(err.message);
  });

  // ---- gasless ----

  it("relay: a signed createOrder is verified, encoded and sent by the relayer, who earns the fee", async () => {
    const fee = E18 / 10n;
    const owed0 = await claimable(relayer.address);
    const req = await relay.signRelayed(
      ctx,
      { action: "createOrder", order: { orderType: LIMIT, isLong: true, size: E18, limitPrice: 1975n * E18, expirationBlock: await expiry() } },
      { wallet: user, signer: user.address, pair, relayerFee: fee },
    );
    const chk = await relay.verifyRelayed(ctx, req);
    expect(chk.problems).toEqual([]);
    expect(chk.signer).toBe(user.address);
    const call = await relay.encodeRelayed(ctx, req, { relayer: relayer.address });
    const r = await run(relayer, call, "relayed createOrder");
    ids.relayed = createdId(r);
    const o = await sc.order(ids.relayed);
    expect([o.creator, o.inBook, o.limitPrice]).toEqual([user.address, true, 1975n * E18]);
    expect((await claimable(relayer.address)) - owed0).toBe(fee);
  });

  it("relay: a signed cancelOrders, sent by the relayer", async () => {
    const fee = E18 / 10n;
    const owed0 = await claimable(relayer.address);
    const req = await relay.signRelayed(ctx, { action: "cancelOrders", orderIds: [ids.relayed!] }, { wallet: user, signer: user.address, pair, relayerFee: fee });
    expect((await relay.verifyRelayed(ctx, req)).problems).toEqual([]);
    await run(relayer, await relay.encodeRelayed(ctx, req, { relayer: relayer.address }), "relayed cancelOrders");
    expect((await sc.order(ids.relayed!)).canceledBlock).toBeGreaterThan(0);
    expect((await claimable(relayer.address)) - owed0).toBe(fee);
  });

  it("relay: a signed deposit with a permit, sent by the relayer", async () => {
    const fee = E18 / 10n;
    const owed0 = await claimable(relayer.address);
    const col0 = (await bucket(user.address)).collateral;
    const req = await relay.signRelayed(
      ctx,
      { action: "depositCollateral", amount: 100n * E18 },
      { wallet: user, signer: user.address, pair, relayerFee: fee, permit: { always: true } },
    );
    expect(req.permitData).not.toBe("0x");
    const chk = await relay.verifyRelayed(ctx, req);
    expect([chk.problems, chk.warnings]).toEqual([[], []]);
    await run(relayer, await relay.encodeRelayed(ctx, req, { relayer: relayer.address }), "relayed deposit");
    expect((await bucket(user.address)).collateral - col0).toBe(100n * E18);
    expect((await claimable(relayer.address)) - owed0).toBe(fee);
  });

  it("trade.claimFees: the relayer claims what it earned", async () => {
    const owed = await claimable(relayer.address);
    expect(owed).toBeGreaterThanOrEqual((3n * E18) / 10n);
    const bal0 = await allowance.usdcBalance(ctx, relayer.address);
    await run(relayer, await trade.claimFees(ctx, pair, relayer.address));
    expect((await allowance.usdcBalance(ctx, relayer.address)) - bal0).toBe(owed / 10n ** 12n);
  });

  it("live: stopping the watch", () => {
    watch?.stop();
    expect(watch?.stopped).toBe(true);
  });

  // ---- insurance ----

  it("insurance: deposit, request a withdrawal, wait out the cooldown, lock", async () => {
    await run(user, await allowance.approveUsdc(ctx, user.address, pair, 1_000n * USDC));
    const r = await run(user, await insurance.depositToInsurance(ctx, pair, user.address, 100n * E18));
    const dep = named(r, "InsuranceDeposited")[0]!;
    const shares = dep.args.sharesReceived as bigint;
    expect(await insurance.insuranceShares(ctx, pair, user.address)).toBe(shares);
    expect((await insurance.insuranceExitPlan(ctx, pair, user.address)).step).toBe("request");
    const rq = await run(user, await insurance.requestInsuranceWithdrawal(ctx, pair, user.address, shares));
    expect(named(rq, "InsuranceWithdrawalRequested")[0]!.args.shareAmount).toBe(shares);
    const p1 = await insurance.insuranceExitPlan(ctx, pair, user.address);
    expect(p1.step).toBe("cooldown");
    console.log(`   exit plan: ${p1.message}`);
    await anvil.warp(p1.nextCallAt! - p1.now + 5);
    const p2 = await insurance.insuranceExitPlan(ctx, pair, user.address);
    expect(p2.step).toBe("lock");
    const lk = await run(user, await insurance.executeInsuranceWithdrawal(ctx, pair, user.address), "insurance lock");
    const locked = named(lk, "InsuranceWithdrawalLocked")[0]!;
    expect(locked.args.shareAmount).toBe(shares);
    const p3 = await insurance.insuranceExitPlan(ctx, pair, user.address);
    console.log(`   after the lock: ${p3.step}: ${p3.message}`);
    expect(["waitClaim", "claim"]).toContain(p3.step);
    expect(p3.lockedAmount).toBe(locked.args.lockedAmount);
    // The paying call, once the claim opens.
    if (p3.step === "waitClaim") await anvil.warp(p3.nextCallAt! - p3.now + 5);
    const p4 = await insurance.insuranceExitPlan(ctx, pair, user.address);
    expect(p4.step).toBe("claim");
    const bal0 = await allowance.usdcBalance(ctx, user.address);
    const cl = await run(user, await insurance.executeInsuranceWithdrawal(ctx, pair, user.address), "insurance claim");
    const paid = named(cl, "InsuranceWithdrawalExecuted")[0]!;
    expect(paid.args.usdcAmount as bigint).toBeGreaterThan(0n);
    // usdcAmount is BAZAAR precision (BazaarTypes.sol); the wallet receives it floored to micro-USDC.
    expect((await allowance.usdcBalance(ctx, user.address)) - bal0).toBe((paid.args.usdcAmount as bigint) / 10n ** 12n);
    console.log(`   claimed ${Number(paid.args.usdcAmount) / 1e18} USDC for ${Number(paid.args.shareAmount) / 1e18} shares`);
    expect((await insurance.insuranceExitPlan(ctx, pair, user.address)).step).toBe("none");
  });

  // ---- listings and governance ----

  it("listings: propose a second market (BTC/USD) and settle it after the liveness", async () => {
    const [, t] = await anvil.latest();
    const p = 60_000n * 10n ** 8n;
    const blob = MOCKS.decode<Hex>(
      "createPriceFeedUpdateData",
      await anvil.call(sc.pyth, MOCKS.encode("createPriceFeedUpdateData", BTC_FEED, p, p / 10_000n, -8, p, p / 10_000n, BigInt(t), BigInt(t - 1))),
    );
    await anvil.send(sc.w[0]!, sc.pyth, MOCKS.encode("updatePriceFeeds", [blob]));
    const call = await listings.proposePairDeployment(ctx, {
      baseFeedId: BTC_FEED,
      isContinuouslyTraded: true,
      totalAmount: 5_000n * E18,
      description: "BTC/USD",
      from: user.address,
    });
    const r = await runCosted(user, call, "proposePairDeployment");
    const ids2 = listings.listingFromReceipt(ctx, r);
    expect(ids2).not.toBeNull();
    expect((await listings.deploymentProposal(ctx, ids2!.assertionId))?.resolved).toBe(false);
    await anvil.warp(48 * 3600 + 1);
    await runCosted(user, await listings.settleDeploymentProposal(ctx, { assertionId: ids2!.assertionId, from: user.address }), "settleDeploymentProposal");
    const pairs = await read<Address[]>(ctx.factory, FACTORY, "getAllPairs");
    expect(pairs).toHaveLength(2);
    expect(await read<Address>(ctx.factory, FACTORY, "getPairAddress", ids2!.pairId)).not.toBe("0x0000000000000000000000000000000000000000");
  });

  it("governance.identifierGovernance reads the identifier in force", async () => {
    const g = await governance.identifierGovernance(ctx);
    expect(g.umaIdentifierText).toBe("ASSERT_TRUTH2");
    expect(g.umaIdentifierIsLive).toBe(true);
    expect([g.pending, g.queued]).toEqual([null, null]);
  });

  // ---- termination ----

  it("termination: terminationStatus, then a UMA claim with its bond approval", async () => {
    const st = await termination.terminationStatus(ctx, pair);
    expect([st.phase, st.isPairTerminated, st.scheduledTerminationTs]).toEqual(["live", false, null]);
    const [, now] = await anvil.latest();
    const call = await termination.proposeTermination(ctx, {
      pair,
      category: 1,
      lastTradingTs: now + 3 * 86_400,
      reason: "Pyth decommissions the ETH/USD feed: notice at https://example.org/pyth-notice",
      from: user.address,
    });
    expect(call.approvals.length).toBeGreaterThan(0);
    const r = await runCosted(user, call, "proposeTermination");
    const got = termination.proposalIdsFromReceipt(ctx, r);
    expect(got.assertionId).not.toBeNull();
    ids.claim = BigInt(got.assertionId!);
    // No subgraph here: the open proposals come from the terminator's logs.
    const st2 = await termination.terminationStatus(ctx, pair, { fromBlock: 0 });
    expect(st2.openProposals.source).toBe("logs");
    expect(st2.openProposals.termination.map((p) => p.assertionId)).toContain(got.assertionId);
  });

  it("termination: an insurer proposal, a vote that passes, and its execution schedule the cutoff", async () => {
    const [, now] = await anvil.latest();
    const cutoff = now + 2 * 86_400;
    const call = await termination.proposeInsurerTermination(ctx, { pair, cutoffTs: cutoff, from: insurer.address });
    const r = await runCosted(insurer, call, "proposeInsurerTermination");
    const id = termination.proposalIdsFromReceipt(ctx, r).insurerProposalId;
    expect(id).not.toBeNull();
    const shares = await insurance.insuranceShares(ctx, pair, insurer.address);
    await runCosted(insurer, await termination.voteForInsurerTermination(ctx, { pair, id: id!, shares, from: insurer.address }), "voteForInsurerTermination");
    const ex = await termination.executeInsurerTermination(ctx, { pair, id: id!, from: insurer.address });
    expect(ex.outcome).toBe("schedule");
    await runCosted(insurer, ex, "executeInsurerTermination");
    const st = await termination.terminationStatus(ctx, pair);
    expect([st.phase, st.insurerScheduled, st.scheduledTerminationTs]).toEqual(["scheduled", true, cutoff]);
  });

  it("termination: the UMA claim settles after its liveness on the mock oracle", async () => {
    const claim = toHex(ids.claim!, { size: 32 });
    const tp = await termination.terminationProposal(ctx, claim);
    expect(tp?.resolved).toBe(false);
    const [, now] = await anvil.latest();
    await anvil.warp(tp!.livenessEndsAt - now + 5);
    await runCosted(user, await termination.settleTerminationProposal(ctx, { assertionId: claim, from: user.address }), "settleTerminationProposal");
    expect((await termination.terminationProposal(ctx, claim))?.resolved).toBe(true);
    const st = await termination.terminationStatus(ctx, pair);
    console.log(`   after the claim: phase ${st.phase}, cutoff ${st.scheduledTerminationTs}, accepted ${st.acceptedTerminationAssertionId}, UMA cap ${st.umaCutoffCap}`);
    expect(st.acceptedTerminationAssertionId).toBe(claim);
  });
  it("termination: past the cutoff, terminateScheduledPair fixes the settlement price from archived prints", async () => {
    const st0 = await termination.terminationStatus(ctx, pair);
    const [, now] = await anvil.latest();
    // Past the cutoff and the five chained samples (600 s apart) the chain rule reads.
    await anvil.warp(st0.scheduledTerminationTs! - now + 6 * 600);
    const plan = await termination.terminateScheduledPair(ctx, { pair, from: user.address });
    console.log(`   settlement plan: under ${plan.under}, ${plan.prints.length} prints, reason ${plan.reason}`);
    expect(plan.call, plan.reason ?? "").not.toBeNull();
    await runCosted(user, plan.call!, "terminateScheduledPair");
    const st = await termination.terminationStatus(ctx, pair);
    expect([st.phase, st.settlementPrice]).toEqual(["settling", 2000n * E18]);
  });

  it("termination: finalizeTermination after the escape hatch", async () => {
    const st0 = await termination.terminationStatus(ctx, pair);
    const [, now] = await anvil.latest();
    if (st0.finalizeOpensAt! > now) await anvil.warp(st0.finalizeOpensAt! - now + 5);
    await runCosted(user, await termination.finalizeTermination(ctx, { pair, from: user.address }), "finalizeTermination");
    const st = await termination.terminationStatus(ctx, pair);
    expect([st.phase, st.isPairTerminated]).toEqual(["terminated", true]);
  });
});
