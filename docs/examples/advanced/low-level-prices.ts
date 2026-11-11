// PriceService and ProClient: live Pyth Pro prints and per-market updates, as the keeper uses them.
import { type Address } from "viem";
import {
  Chain,
  PriceService,
  ProClient,
  ProError,
  Reader,
  feedIdHex,
  fetchSymbols,
  formatUnits18,
  lazer,
  marketLabel,
  pairPrice,
  proFeedId,
  verifierSignerCheck,
} from "@liberta-labs/bazaar-sdk";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const chain = Chain.fromUrl(process.env.RPC_HTTP_URL!);
const reader = new Reader(chain);
const deployment = await reader.deployment(FACTORY);
const markets = await reader.describe(await reader.pairAddresses());

// ANCHOR: pro
// One client for Pyth Pro's request API, its stream endpoints and its symbols registry. The token is
// sent as a Bearer header and masked in every error. Node 22 and later have the WebSocket the stream
// runs over; on Node 20 pass one (the `ws` package's) as the WebSocket option.
const pro = new ProClient({
  token: process.env.PYTH_PRO_API_KEY, // a server may hold the API key itself
  timeout: 5,
  // Use only updates signed by a signer the deployment's Pyth verifier trusts.
  isTrustedSigner: verifierSignerCheck(chain, deployment.oracle),
});

try {
  // One request, one signed update carrying every feed asked for.
  const prints = await pro.latest(markets.flatMap((m) => m.legs));
  for (const p of prints) console.log(proFeedId(p.feedId), p.price, "e", p.expo, "generated in second", p.publishTime);
} catch (e) {
  if (e instanceof ProError) console.error(e.message); // unreachable, refused (401/403), an untrusted signer, not JSON
  else throw e;
}

// Labels from Pyth Pro's symbols registry: "ETH/USD", or "XAU/USD" for a composite.
const symbols = await fetchSymbols(pro, markets.flatMap((m) => m.legs));
for (const m of markets) m.label = marketLabel(symbols.get(m.legs[0]!), m.legs[1] ? symbols.get(m.legs[1]) : null);
// ANCHOR_END: pro

// ANCHOR: service
const prices = new PriceService(pro, { sendMargin: 1, logger: console });
prices.watchMarkets(markets); // one subscription per market's legs (ETH/USD is always watched, for gas)
void prices.run(); // follows the stream, falls back to polling, never rejects; prices.stop() ends it

const off = prices.onPrints((feeds) => {
  for (const m of markets) {
    if (!m.legs.some((leg) => feeds.has(leg))) continue;
    const pp = prices.price(m); // the oracle's composition: spot, low, high, confidenceOk
    if (!pp) continue;
    const sendable = prices.fresh(m); // every leg generated within 3 s less sendMargin, and inside the 2% cap
    console.log(m.label, formatUnits18(pp.spot), sendable ? "fresh" : "stale");
  }
});
// ANCHOR_END: service

// ANCHOR: update
// The signed update a call on one market attaches: the one update that carries exactly its legs.
const [m] = markets;
if (m && prices.fresh(m)) {
  const update = prices.updateFor(m);
  const fee = await reader.updateFee(update); // wei to send with the call: Pyth's fee per update
  console.log(update.length, "update(s), Pyth fee", fee);
}
// ANCHOR_END: update

// ANCHOR: updates
// Work with a signed update directly: read its payload, and recover who signed it.
const print = m ? prices.legs(m)?.[0] : undefined;
if (print) {
  const u = await lazer.parseUpdate(print.blob); // { signer, timestampUs, channel, feeds, payload }
  console.log(u.signer, lazer.channelName(u.channel), u.timestampUs);
  for (const f of u.feeds) console.log(f.id, f.price, f.exponent, f.confidence, f.feedUpdateTimestamp);
}
console.log(feedIdHex(1)); // Pyth Pro feed 1 (BTC/USD) as the bytes32 the contracts hold: 0x00…01
// The price a set of prints composes to, without a service:
if (print) console.log(pairPrice([print], false)?.spot);
// ANCHOR_END: updates

off();
prices.stop();
await pro.close();
