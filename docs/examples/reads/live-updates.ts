// Live updates: watchMarket, watchAccount, their updates, and the LogFollower underneath.
import { Bazaar, formatUnits18, live } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const user: Address = "0x0000000000000000000000000000000000000001";
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);

// ANCHOR: market
const prices = await bz.livePrices(); // optional: judges the venue without a Pyth Pro request per snapshot

const watch = bz.live.watchMarket(
  eth,
  (u) => {
    switch (u.type) {
      case "event": // one typed log as it lands
        if (u.event.source === "pair" && u.event.name === "Trade") {
          show(`trade ${formatUnits18(u.event.args.fillSize)} at ${formatUnits18(u.event.args.price, 2)}`);
        }
        break;
      case "snapshot": // a fresh MarketSnapshot at the head
        show(`${u.snapshot.status} (${u.cause})`);
        if (u.bookChanged) void bz.markets.getBook(eth, 10, { block: { number: u.snapshot.block } });
        break;
      case "head":
        show(`block ${u.block}`);
        break;
      case "reorg": // logs from fromBlock on are read again; the next snapshot reflects the new chain
        show(`reorg back to ${u.fromBlock}`);
        break;
      case "error": // retried after retryInMs; null means the watch could not start
        show(`live updates: ${String(u.error)} (retry in ${u.retryInMs ?? "never"} ms)`);
        break;
      case "undecodable": // a log the SDK could not decode: skipped
        break;
    }
  },
  { prices, refreshMs: 15_000, minSnapshotMs: 1_000 },
);
await watch.ready; // started, first snapshot delivered (or the reason it could not be)
// ANCHOR_END: market

// ANCHOR: account
const mine = bz.live.watchAccount(user, [eth, "BTC/USD"], (u) => {
  if (u.type === "account") {
    const a = u.snapshot; // an AccountSnapshot for the market an event touched
    show(`${a.market.label}: ${a.orders.length} orders, collateral ${formatUnits18(a.position.collateral, 2)} (${u.cause})`);
  } else if (u.type === "event" && u.event.source === "pair") {
    if (u.event.name === "PositionLiquidated") show("liquidated");
    if (u.event.name === "OrderUpdated") show(`order #${u.event.args.orderId}: action ${u.event.args.payload.action}`);
  }
}, { prices });
await mine.ready;
await mine.refresh(); // read the head and every snapshot now (after the user's own transaction, say)
// ANCHOR_END: account

// ANCHOR: stop
// In a React effect: return () => watch.stop();
watch.stop(); // nothing is delivered after this returns
mine.stop();
prices.stop();
// ANCHOR_END: stop

// ANCHOR: options
const tuned = bz.live.watchMarket(eth, () => {}, {
  pollMs: 2_000, // head polls (default 1000); with a subscription, a backup poll every 10 x this
  subscribe: true, // eth_subscribe("newHeads") when the transport emits "message" events (default true)
  fromBlock: 250_000_000, // deliver from this block (default: only what lands after the start)
  reorgDepth: 32, // blocks re-read after a reorg (default 32)
  logChunk: 2_000, // blocks per eth_getLogs, halved while the node refuses (default 2000)
  maxBlocksPerTick: 20_000, // blocks one tick reads (default 10 x logChunk)
  maxBackoffMs: 30_000, // the longest wait between retries (default 30 s)
  refreshMs: 0, // snapshots on events only (default 15000)
  initial: false, // no snapshot at start (default true)
  fetchPrices: false, // never ask Pyth Pro for the venue (default true)
});
// ANCHOR_END: options

// ANCHOR: follower
// The follower alone: any contracts' raw logs from a cursor, reorg-safe, typed with decodeLiveLog.
const follower = new live.LogFollower(
  bz.ctx.chain,
  () => [eth.address, bz.ctx.terminator],
  (logs, head) => {
    for (const log of logs) {
      const e = live.decodeLiveLog(log, bz.ctx.terminator);
      if (e) show(`${e.name} on ${e.market} in block ${e.blockNumber} (head ${head.number})`);
    }
  },
  (notice) => {
    if (notice.type === "error") console.warn(notice.error);
  },
  { pollMs: 1_000 },
);
await follower.start();
follower.cursor; // the next block it reads from
follower.subscribed; // true when new heads are pushed rather than polled
follower.stop();
// ANCHOR_END: follower

tuned.stop();
