// Connecting: every option of Bazaar.connect and connect(), transports, prices, the subgraph, errors.
import {
  Bazaar,
  ConnectError,
  JsonRpc,
  ProClient,
  cachedToken,
  connect,
  errorMessage,
  history,
  proPriceSource,
  requirePair,
} from "@liberta-labs/bazaar-sdk";
import { type Address, createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const MY_FEE_ADDRESS: Address = "0x0000000000000000000000000000000000000001";

// ANCHOR: token
// In a browser: short-lived Pyth Pro tokens from your own backend, which holds the API key. The
// endpoint answers { token, expiresAt }; a new one is fetched a minute before the held one expires.
const pythToken = cachedToken(() => fetch("/api/pyth-token").then((r) => r.json()));
// ANCHOR_END: token

// ANCHOR: options
const bz = await Bazaar.connect({
  transport: window.ethereum, // an EIP-1193 provider, a viem client, a JsonRpc, or a JSON-RPC URL
  factory: FACTORY, // the deployment: everything else is read from it
  chainId: 42161, // optional: refuse any other chain
  prices: { token: pythToken }, // optional: Pyth Pro client options, a ProClient, or any source
  subgraph: "https://subgraph.example.com/bazaar", // optional: a URL, { url, apiKey }, or a source
  integrator: MY_FEE_ADDRESS, // optional: named on every order this connection creates
});

bz.chainId; // 42161
bz.deployment; // { factory, lens, terminator, oracle, usdc }
bz.ctx; // the BazaarContext every function runs on
// ANCHOR_END: options

// ANCHOR: transports
// A browser wallet: reads, and the wallet the user signs with.
const viaWallet = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY });

// A viem client (wagmi's clients are viem clients too).
const client = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc") });
const viaViem = await Bazaar.connect({ transport: client, factory: FACTORY });

// A URL: the SDK builds a JsonRpc with its defaults.
const viaUrl = await Bazaar.connect({ transport: "https://arb1.arbitrum.io/rpc", factory: FACTORY });

// A JsonRpc of your own, to change those defaults.
const rpc = new JsonRpc(`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`, {
  perSecond: 10, // requests per second (default 25)
  timeoutMs: 15_000, // per request (default 30 s)
  retries: 5, // after transient failures, doubling from 500 ms (default 3); never for sends
  headers: { "x-client": "my-bot" }, // sent with every request
  maxResponseBytes: 32 * 1024 * 1024, // default 64 MiB
});
const viaJsonRpc = await Bazaar.connect({ transport: rpc, factory: FACTORY });
console.log(rpc.displayUrl); // "https://arb-mainnet.g.alchemy.com/v2/***": safe to log
// ANCHOR_END: transports

// ANCHOR: prices
// The options form of `prices` builds this source; build it yourself to keep hold of its client.
const prices = proPriceSource({
  token: process.env.PYTH_PRO_API_KEY, // sent as "Authorization: Bearer <key>": the key itself, on servers only
  channel: "fixed_rate@200ms", // the default; also "real_time", "fixed_rate@50ms", "fixed_rate@1000ms"
  timeout: 5, // seconds per request (default 10)
});
const withPrices = await Bazaar.connect({ transport: rpc, factory: FACTORY, prices });

// One ProClient can serve both the calls' updates and a live stream.
const pro = new ProClient({ token: pythToken });
const shared = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: pro });
const live = await shared.livePrices(); // streams through the same client

// Connecting has the source refuse any update not signed by a signer the deployment's Pyth verifier
// trusts (one cached read per signer). The chain checks every update a call carries either way.
const unchecked = await Bazaar.connect({ transport: rpc, factory: FACTORY, prices: { token: pythToken }, checkSigners: false });
// ANCHOR_END: prices

// ANCHOR: subgraph
const withHistory = await Bazaar.connect({
  transport: rpc,
  factory: FACTORY,
  subgraph: history.httpSubgraph("https://gateway.thegraph.com/api/subgraphs/id/...", process.env.GRAPH_API_KEY, {
    timeoutMs: 10_000, // per query (default 30 s)
  }),
});
const lag = await withHistory.history.subgraphLag(); // how far the index trails the chain
// ANCHOR_END: subgraph

// ANCHOR: low-level
// connect() is what Bazaar.connect calls: it takes sources, not URLs, and returns the bare context.
const ctx = await connect({
  transport: rpc,
  factory: FACTORY,
  chainId: 42161,
  prices: proPriceSource({ token: pythToken }),
  subgraph: history.httpSubgraph("https://subgraph.example.com/bazaar"),
  integrator: null, // zero address: no integrator fee on this connection's orders
});
const wrapped = Bazaar.from(ctx);
// ANCHOR_END: low-level

// ANCHOR: errors
try {
  await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, chainId: 42161 });
} catch (e) {
  if (e instanceof ConnectError) {
    // "connected to chain 421614, expected 42161", or
    // "0x... does not answer as a Bazaar factory on chain 42161"
    console.error(e.message);
  } else {
    console.error(errorMessage(e)); // the wallet or the RPC failed
  }
}
// ANCHOR_END: errors

// ANCHOR: require-pair
// An address from a link or a query string is untrusted: ask the factory before using it.
const fromLink = new URLSearchParams(location.search).get("market") as Address;
const pair = await requirePair(bz.ctx, fromLink); // checksummed, or an InputError on "pair"
// ANCHOR_END: require-pair

console.log(viaWallet, viaViem, viaUrl, viaJsonRpc, withPrices, live, unchecked, lag, wrapped, pair);
