// Live prices: the LivePrices stream, Pyth Pro directly, and PriceService.
import {
  Bazaar,
  LivePrices,
  PriceService,
  ProClient,
  formatUnits18,
  livePrices,
  marketFromStatic,
  proPriceSource,
} from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: { token: pythToken } });
const eth = await bz.markets.getMarket("ETH/USD");
const render = (text: string) => console.log(text);

// ANCHOR: stream
const prices = await bz.livePrices(); // every listed market, each streamed as its own set of feeds
await prices.ready; // the first request for each market's latest print has answered

const unsubscribe = prices.subscribe((changed) => {
  for (const [, p] of changed) {
    const flag = p.venueClosed ? "closed" : p.fresh ? "live" : `${p.age} s old`;
    render(`${formatUnits18(p.spot, 2)} ± ${p.confidenceBp.toFixed(1)} bp (${flag})`);
  }
}); // every watched market; pass [eth] as a second argument for one

const now = prices.price(eth); // from memory: null while a feed has no print yet
prices.fresh(eth); // inside the pair's 3 s window, and the confidence clears the 2% cap
prices.venueClosed(eth); // a trading-hours market whose feed stopped generating prices

// When the view goes away:
unsubscribe(); // one subscriber
prices.stop(); // the stream itself, for good
// ANCHOR_END: stream

// ANCHOR: options
const tuned = await bz.livePrices({
  closedAfter: 30, // seconds without a newly generated price before a trading-hours venue reads closed (default 15)
  tickMs: 500, // how often fresh/venueClosed flips are re-checked for subscribers (default 1000)
  reuseAge: 1, // a price generated this recently is reused as a call's update (default 1 s)
  stream: true, // the WebSocket stream, falling back to polling (default true)
  pollInterval: 2, // seconds between polls while not streaming (default 1)
  maxFutureSkew: 120, // seconds a print may be dated ahead of this clock (default here 120)
  logger: null, // silence endpoint warnings (default console)
});

// Some markets only, with a Pyth Pro client of their own, without a connection:
const some = await livePrices([eth], { pro: { token: pythToken, channel: "fixed_rate@1000ms" } });
// ANCHOR_END: options

// ANCHOR: for-calls
// A LivePrices is also a PriceUpdateSource: give it to a second facade over the same context, and its
// order builders reuse the stream's updates instead of asking the endpoint again.
const trading = Bazaar.from({ ...bz.ctx, prices: tuned });
// ...then trading.trade.createOrder(...) attaches the stream's update when its price is at most 1 s old.
// ANCHOR_END: for-calls

// ANCHOR: pro
// Pyth Pro directly: prints read from the signed update itself, never from the JSON beside it.
const source = proPriceSource({ token: pythToken });
const [print] = await source.prints(eth.legs); // feedId, price, conf, expo, publishTime, generatedUs, blob
const update = await source.latest(eth.legs); // { update: Hex[], publishTime }: what a call attaches

const client = new ProClient({ token: pythToken, timeout: 5 });
const ctl = new AbortController();
// One set of feeds: every update carries exactly the market's legs, from whichever endpoint is first.
for await (const batch of client.stream(eth.legs, ctl.signal, { idleTimeout: 10 })) {
  render(`${batch.length} prints`);
  ctl.abort(); // or break: the stream ends at once
}
// ANCHOR_END: pro

// ANCHOR: service
// PriceService: the engine under LivePrices and the keeper, for code that wants the raw parts.
const service = new PriceService(client, { stream: true, maxFutureSkew: 120 });
const model = marketFromStatic(eth); // the per-market functions take the SDK's Market model
service.watchMarkets([model]);
const stopListening = service.onPrints((feeds) => {
  const pp = service.price(model); // spot, low, high, publishTime, confidenceOk
  if (pp) render(`${feeds.size} feeds updated, spot ${formatUnits18(pp.spot, 2)}, fresh: ${service.fresh(model, null, 0)}`);
});
void service.run(); // follows the stream (or polls) until stop(); never rejects
// ... later
stopListening();
service.stop();
// ANCHOR_END: service

console.log(now, some, trading, print, update, LivePrices);
