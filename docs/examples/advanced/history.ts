// History from Bazaar's subgraph: the samples of the History page.
import { type Address } from "viem";
import { Bazaar, errorMessage, formatUnits18, history } from "@liberta-labs/bazaar-sdk";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const user: Address = "0x0000000000000000000000000000000000000001";
const MY_FRONTEND: Address = "0x0000000000000000000000000000000000000002";

// ANCHOR: connect
const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: FACTORY,
  prices: PRICES,
  // A URL, { url, apiKey }, or any object with query(query, variables).
  subgraph: "https://subgraph.example.com/subgraphs/name/bazaar-arbitrum-one",
});
// ANCHOR_END: connect

const eth = await bz.markets.getMarket("ETH/USD");

// ANCHOR: tape
// The 50 newest fills on ETH/USD.
const tape = await bz.history.trades({ pair: eth.address, first: 50 });
for (const t of tape.items) {
  const side = t.takerIsLong ? "buy" : "sell";
  console.log(new Date(t.timestamp * 1000).toISOString(), side, formatUnits18(t.size), "@", formatUnits18(t.price));
}

// The next 50: pass the page's cursor back as `after`.
if (tape.next) {
  const older = await bz.history.trades({ pair: eth.address, first: 50, after: tape.next });
  console.log(older.items.length);
}
// ANCHOR_END: tape

// ANCHOR: all-pages
/** Every row of a paginated history list, following `next` until it is null. */
async function readAll<T>(read: (after: string | null) => Promise<history.Page<T>>, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: history.Page<T> = await read(after);
    out.push(...page.items);
    if (!page.next) return out;
    after = page.next;
  }
  throw new Error(`more than ${maxPages} pages: narrow the time range`);
}

// Every trade the user took part in (as maker or taker) in the last 7 days.
const now = Math.floor(Date.now() / 1000);
const myWeek = await readAll((after) =>
  bz.history.trades({ account: user, from: now - 7 * 86_400, to: now, first: 1000, after }),
);
console.log(`${myWeek.length} fills this week`);
// ANCHOR_END: all-pages

// ANCHOR: snapshot
// Pin every page to one block, so rows indexed while you page do not shift the pages.
const lag = await bz.history.subgraphLag();
const atBlock = lag.indexedBlock;
const openPositions = await readAll((after) =>
  bz.history.positions({ pair: eth.address, openOnly: true, first: 1000, after, atBlock }),
);
console.log(`${openPositions.length} open positions as of block ${atBlock}`);
// ANCHOR_END: snapshot

// ANCHOR: candles
// One day of 15-minute candles, with the quiet periods filled in for the chart.
const interval = 900;
const to = now - (now % interval) + interval; // the end of the current period
const from = to - 86_400;
const rows = await readAll((after) => bz.history.candles(eth.address, interval, { from, to, first: 1000, after }));
// The last candle before the range, so a quiet start is filled at its close rather than left empty.
const before = await bz.history.candles(eth.address, interval, { to: from, order: "desc", first: 1 });
const chart = history.fillCandleGaps([...before.items, ...rows], interval, from, to);
for (const c of chart) {
  console.log(c.periodStart, formatUnits18(c.open), formatUnits18(c.high), formatUnits18(c.low), formatUnits18(c.close), c.tradeCount);
}
// ANCHOR_END: candles

// ANCHOR: day-data
const days = await bz.history.pairDayData(eth.address, { from: now - 30 * 86_400 });
for (const d of days.items) {
  console.log(new Date(d.date * 1000).toISOString().slice(0, 10), "volume $" + formatUnits18(d.volumeNotional, 0), "trades", d.tradeCount);
}
// ANCHOR_END: day-data

// ANCHOR: orders
// The user's orders that can still trade, newest first.
const open = await bz.history.orders({ account: user, openOnly: true });
for (const o of open.items) {
  console.log(o.orderId, o.orderType, o.isLong ? "long" : "short", formatUnits18(o.remaining), "left", o.status);
}

// Orders the protocol canceled, and why, in a sentence for the owner.
const canceled = await bz.history.orders({ account: user, status: ["Canceled"], first: 20 });
for (const o of canceled.items) {
  if (o.cancelReason === "Owner") continue;
  console.log(`Order ${o.orderId}: ${history.CANCEL_REASON_TEXT[o.cancelReason]}`);
}
// ANCHOR_END: orders

// ANCHOR: order-events
// One order's lifecycle: created, triggered, amended, amend skipped, canceled.
const orderId = 42n;
const events = await bz.history.orderEvents({ pair: eth.address, orderId, order: "asc" });
for (const e of events.items) {
  const why =
    e.action === "Canceled" ? `: ${history.CANCEL_REASON_TEXT[e.cancelReason]}`
    : e.action === "AmendSkipped" ? ` (${e.amendSkipReason})`
    : "";
  console.log(e.timestamp, e.action + why);
}
// The order itself, or null when the subgraph has not seen it yet.
const one = await bz.history.order(eth.address, orderId);
console.log(one?.status ?? "not indexed yet");
// ANCHOR_END: order-events

// ANCHOR: positions
// The user's position on ETH/USD: lifetime figures and each trade's effect on it.
const [pos] = (await bz.history.positions({ account: user, pair: eth.address })).items;
if (pos) {
  console.log("realized PnL", formatUnits18(pos.realizedPnl), "fees paid", formatUnits18(pos.feesPaid));
}
const changes = await bz.history.positionChanges({ account: user, pair: eth.address, first: 20 });
for (const c of changes.items) {
  console.log(c.timestamp, formatUnits18(c.newSize), "@", formatUnits18(c.executionPrice), "pnl", formatUnits18(c.realizedPnl));
}
const cash = await bz.history.collateralTransfers({ account: user, pair: eth.address });
for (const t of cash.items) console.log(t.isDeposit ? "deposit" : "withdrawal", formatUnits18(t.amount));
// ANCHOR_END: positions

// ANCHOR: integrator
// What a frontend has routed, and what it can claim.
const routed = await bz.history.integratorStats(MY_FRONTEND);
if (routed) {
  console.log(routed.orderCount, "orders,", routed.fillCount, "fill sides");
  console.log("maker volume $" + formatUnits18(routed.makerVolumeNotional, 2), "taker volume $" + formatUnits18(routed.takerVolumeNotional, 2));
}
const balances = await bz.history.feeBalances({ recipient: MY_FRONTEND, claimableOnly: true });
for (const b of balances.items) console.log(b.pair, "claimable $" + formatUnits18(b.claimable, 2));
// ANCHOR_END: integrator

// ANCHOR: lag
try {
  const l = await bz.history.subgraphLag();
  if (l.hasIndexingErrors) console.warn("The history index hit an error and may have stopped.");
  else if (l.blocksBehind > 20) {
    const behind = l.secondsBehind !== null ? `${l.secondsBehind} s` : `${l.blocksBehind} blocks`;
    console.warn(`History is ${behind} behind the chain: the latest trades may not be listed yet.`);
  }
} catch (e) {
  // The subgraph is unreachable or refused the query: say so, and keep the page working.
  console.warn("History is unavailable right now.", e instanceof Error ? e.message : e);
}
// ANCHOR_END: lag

// ANCHOR: errors
try {
  await bz.history.trades({ pair: eth.address });
} catch (e) {
  if (e instanceof history.SubgraphError) {
    // unreachable, an HTTP error (e.status), a GraphQL error, or an answer without data
    console.error("history unavailable:", e.message, e.status);
  } else {
    // InputError (a bad argument: errorMessage shows it), or ConnectError (connected without a subgraph)
    console.error(errorMessage(e));
  }
}
// ANCHOR_END: errors

// ANCHOR: http-subgraph
// A source of your own: a proxy that adds the key server-side, a longer timeout, extra headers.
const sg = history.httpSubgraph("https://your-app.example.com/api/subgraph", null, {
  timeoutMs: 10_000,
  headers: { "x-client": "my-frontend" },
});
const bz2 = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, subgraph: sg });
// The same functions without the facade: history.trades(ctx, filter).
const page = await history.trades(bz2.ctx, { pair: eth.address, first: 10 });
console.log(page.items.length);
// ANCHOR_END: http-subgraph
