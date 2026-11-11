// ANCHOR: all
// A two-sided quoting bot for one Bazaar market.
//
// It keeps one post-only bid and one post-only ask resting around the live Pyth price, requotes both in
// a single amendOrders call when the price moves, stops adding to a side once its position reaches a
// limit, replaces orders before they expire, and cancels everything on shutdown.
//
//   RPC_URL=https://arb1.example/rpc PYTH_PRO_API_KEY=... \
//   BAZAAR_FACTORY=0x... BOT_PRIVATE_KEY=0x... MARKET=ETH/USD node market-maker.js
import {
  Bazaar,
  InputError,
  JsonRpc,
  OrderType,
  type PreparedCall,
  ProClient,
  Status,
  errorMessage,
  formatUnits18,
  livePrices,
  orders,
  parseUnits18,
  account,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, createWalletClient, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

// ANCHOR: config
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`set ${name}`);
  return v;
}

const config = {
  rpcUrl: env("RPC_URL"),
  pythKey: env("PYTH_PRO_API_KEY"),
  factory: env("BAZAAR_FACTORY") as Address,
  market: env("MARKET", "ETH/USD"),
  /** Each quote's distance from the live price, in basis points. */
  spreadBp: BigInt(env("SPREAD_BP", "20")),
  /** Quotes snap to this price grid (a choice of the bot, not a protocol tick). */
  tick: parseUnits18(env("TICK", "0.01")),
  /** Size of each quote, in base units. */
  size: parseUnits18(env("QUOTE_SIZE", "0.5")),
  /** Stop quoting the side that would grow the position past this. */
  maxPosition: parseUnits18(env("MAX_POSITION", "5")),
  /** Requote when the price has moved this far from the last quote, in basis points. */
  requoteBp: BigInt(env("REQUOTE_BP", "5")),
  /** Keep at least this much collateral on the market (USDC, BAZAAR precision). */
  collateral: parseUnits18(env("COLLATERAL", "2000")),
  /** How long each quote lives; replaced 10 minutes before it expires. */
  orderLifetimeSeconds: 6 * 60 * 60,
  /** The least time between two requotes. */
  minRequoteMs: 2_000,
};
// ANCHOR_END: config

const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

// ANCHOR: connect
const key = privateKeyToAccount(env("BOT_PRIVATE_KEY") as Hex, { nonceManager });
const wallet = createWalletClient({ account: key, chain: arbitrum, transport: http(config.rpcUrl) });
const me = key.address;

// One Pyth Pro client for the calls' updates and the stream. Node 22 and later have the WebSocket it
// streams over; on Node 20 pass one, e.g. the `ws` package's, as its WebSocket option.
const pro = new ProClient({ token: config.pythKey });
const base = await Bazaar.connect({
  transport: new JsonRpc(config.rpcUrl, { perSecond: 10 }), // stay under the RPC provider's rate limit
  factory: config.factory,
  chainId: arbitrum.id,
  prices: pro,
});
const market = await base.markets.getMarket(config.market);

// One price stream for the market. It is also a price source: calls built through `bz` reuse its
// update (a price generated at most 1 s ago) instead of asking Pyth Pro again.
const live = await livePrices([market], { client: pro });
await live.ready;
const bz = Bazaar.from({ ...base.ctx, prices: live });
// ANCHOR_END: connect

// ANCHOR: state
const state: { snap: account.AccountSnapshot | null; lastTxBlock: number; lastQuoted: bigint; busy: boolean; failures: number; stopping: boolean } = {
  snap: null, // the account on the market, refreshed by the watcher
  lastTxBlock: 0, // the block of the bot's last transaction
  lastQuoted: 0n, // the price the resting quotes were built around
  busy: false,
  failures: 0,
  stopping: false,
};

const watch = bz.live.watchAccount(
  me,
  [market],
  (u) => {
    if (u.type === "account") state.snap = u.snapshot;
    else if (u.type === "event" && u.event.source === "pair" && u.event.name === "Trade") {
      const t = u.event.args;
      if (t.maker === me) log(`filled ${formatUnits18(t.fillSize)} at ${formatUnits18(t.price)} (${t.takerIsLong ? "sold" : "bought"})`);
    } else if (u.type === "error") log("watch error:", errorMessage(u.error));
  },
  { prices: live, refreshMs: 10_000, pollMs: 2_000 },
);
await watch.ready;
// ANCHOR_END: state

// ANCHOR: act
/**
 * Build, simulate and send one call, then wait for it. `build` runs right before sending, so a call
 * that carries a price is inside the 3 s window; one that aged during simulation is rebuilt once.
 */
async function act(build: () => Promise<PreparedCall>): Promise<boolean> {
  try {
    let call = await build();
    let sim = await bz.simulate(call);
    if (sim.ok && call.priceTime !== undefined && Date.now() / 1000 - call.priceTime > 2) {
      call = await build();
      sim = await bz.simulate(call);
    }
    if (!sim.ok) {
      log(`skipped "${call.summary}": ${sim.error!.message}`);
      return false;
    }
    const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
    const receipt = await bz.waitForReceipt(hash, { timeoutMs: 60_000 });
    state.lastTxBlock = receipt.blockNumber;
    state.failures = 0;
    log(`${call.summary} (block ${receipt.blockNumber})`);
    return true;
  } catch (e) {
    state.failures++;
    log(e instanceof InputError ? `refused: ${e.message}` : `failed: ${errorMessage(e)}`);
    return false;
  }
}
// ANCHOR_END: act

// ANCHOR: collateral
async function ensureCollateral(): Promise<void> {
  const s = state.snap!;
  const short = config.collateral - s.position.collateral;
  if (short < parseUnits18("5")) return; // the pair's minimum deposit is 5 USDC
  const funding = await bz.allowance.usdcFunding(me, market.address, short);
  if (!funding.enoughBalance) throw new Error(`the bot's wallet holds too little USDC to deposit ${formatUnits18(short)}`);
  if (!funding.enoughAllowance) await act(() => bz.allowance.approveUsdc(me, market.address, funding.approveUsdc)); // exact amount
  await act(() => bz.trade.depositCollateral(market.address, me, short));
}
// ANCHOR_END: collateral

// ANCHOR: quote
const snap = (p: bigint) => p - (p % config.tick);

/** Where the quotes should be, and how big, for a price and the current position. */
function targets(spot: bigint, s: account.AccountSnapshot) {
  const net = s.position.size === 0n ? 0n : s.position.isLong ? s.position.size : -s.position.size;
  return {
    bid: { price: snap((spot * (10_000n - config.spreadBp)) / 10_000n), size: net >= config.maxPosition ? 0n : config.size },
    ask: { price: snap((spot * (10_000n + config.spreadBp)) / 10_000n) + config.tick, size: -net >= config.maxPosition ? 0n : config.size },
  };
}

async function requote(spot: bigint): Promise<void> {
  const s = state.snap;
  if (!s || s.block < state.lastTxBlock) return; // wait for a snapshot that includes the last transaction
  if (s.status !== Status.Live) return log(`not quoting: the market is ${s.status}`);

  const t = targets(spot, s);
  const resting = s.orders.filter((o) => o.typeName === "Limit" && o.inBook);
  const bids = resting.filter((o) => o.isLong);
  const asks = resting.filter((o) => !o.isLong);

  // Cancel what should not be there: extra quotes, a side at its limit, quotes close to expiry.
  const expiring = (o: (typeof resting)[number]) => o.blocksLeft !== null && o.blocksLeft < orders.blocksIn(10 * 60);
  const drop = [
    ...bids.slice(1),
    ...asks.slice(1),
    ...(t.bid.size === 0n ? bids.slice(0, 1) : []),
    ...(t.ask.size === 0n ? asks.slice(0, 1) : []),
    ...resting.filter(expiring),
  ];
  if (drop.length > 0) {
    await act(() => bz.trade.cancelOrders(market.address, me, [...new Set(drop.map((o) => o.orderId))]));
    return; // the next round places replacements against the new snapshot
  }

  // Move what rests, in one call. Moving up, amend the ask first so the bid never crosses it.
  const amends: orders.AmendInput[] = [];
  const bid = bids[0];
  const ask = asks[0];
  const up = spot >= state.lastQuoted;
  const side = (o: typeof bid, q: { price: bigint; size: bigint }) =>
    o && o.limitPrice !== q.price ? [{ orderId: o.orderId, limitPrice: q.price, size: o.filled + q.size, bestEffort: true }] : [];
  amends.push(...(up ? [...side(ask, t.ask), ...side(bid, t.bid)] : [...side(bid, t.bid), ...side(ask, t.ask)]));
  if (amends.length > 0) await act(() => bz.trade.amendOrders(market.address, me, amends));

  // Place a missing side.
  const expiry = s.block + orders.blocksIn(config.orderLifetimeSeconds);
  for (const [isLong, q, existing] of [[true, t.bid, bid], [false, t.ask, ask]] as const) {
    if (existing || q.size === 0n) continue;
    await act(() =>
      bz.trade.createOrder(market.address, me, {
        orderType: OrderType.Limit,
        isLong,
        size: q.size,
        limitPrice: q.price,
        isPostOnly: true, // a quote that would cross is canceled, never filled as a taker
        expirationBlock: expiry,
      }),
    );
  }
  state.lastQuoted = spot;
}
// ANCHOR_END: quote

// ANCHOR: loop
let lastRequote = 0;

async function tick(force: boolean): Promise<void> {
  if (state.busy || state.stopping) return;
  const p = live.price(market);
  if (!p || !p.fresh) return; // no print yet, or the stream has fallen behind
  const moved = state.lastQuoted === 0n ? config.requoteBp : ((p.spot > state.lastQuoted ? p.spot - state.lastQuoted : state.lastQuoted - p.spot) * 10_000n) / state.lastQuoted;
  if (!force && (moved < config.requoteBp || Date.now() - lastRequote < config.minRequoteMs)) return;
  // Back off after repeated failures: 2 s, 4 s, ... up to a minute.
  if (state.failures > 0 && Date.now() - lastRequote < Math.min(60_000, 1_000 * 2 ** state.failures)) return;
  state.busy = true;
  lastRequote = Date.now();
  try {
    await requote(p.spot);
  } finally {
    state.busy = false;
  }
}

await ensureCollateral();
const unsubscribe = live.subscribe(() => void tick(false), [market]); // every new print
const timer = setInterval(() => void tick(true), 15_000); // expiries and missing sides, even when quiet
log(`quoting ${market.label} as ${me}`);
// ANCHOR_END: loop

// ANCHOR: shutdown
async function shutdown(signal: string): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  log(`${signal}: canceling quotes`);
  clearInterval(timer);
  unsubscribe();
  while (state.busy) await new Promise((r) => setTimeout(r, 100));
  await watch.refresh();
  const ids = (state.snap?.orders ?? []).filter((o) => o.typeName === "Limit").map((o) => o.orderId);
  if (ids.length > 0) await act(() => bz.trade.cancelOrders(market.address, me, ids.slice(0, orders.MAX_CANCELS_PER_CALL)));
  watch.stop();
  live.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// ANCHOR_END: shutdown
// ANCHOR_END: all
