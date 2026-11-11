// Low-level chain access for bots and services: Chain, JsonRpc, codecs, decodeError, logs, sendRaw.
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Chain,
  DeploymentBlockError,
  JsonRpc,
  RpcError,
  SendError,
  decodeError,
  findDeploymentBlock,
  formatUnits18,
  lens,
  pair,
  redactUrl,
} from "@liberta-labs/bazaar-sdk";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const PAIR: Address = "0x0000000000000000000000000000000000000003";
const LENS: Address = "0x0000000000000000000000000000000000000004";
const user: Address = "0x0000000000000000000000000000000000000001";

// ANCHOR: chain
// A server-side Chain over HTTP. Keep the URL (which often holds the provider's key) in the environment.
const chain = Chain.fromUrl(process.env.RPC_HTTP_URL!, {
  perSecond: 10, // this client's own rate limit (default 25)
  timeoutMs: 15_000, // per request (default 30 s)
  retries: 2, // transient failures (default 3); never a send
  sendUrl: process.env.SEQUENCER_URL ?? null, // optional: submit transactions elsewhere
});

console.log(await chain.chainId(), await chain.blockNumber());
const head = await chain.block("latest"); // number, timestamp, hash, parentHash, baseFee
console.log(head.timestamp);
// ANCHOR_END: chain

// ANCHOR: transport
// The same Chain over any EIP-1193 transport: a browser wallet, a viem client, or a JsonRpc.
const rpc = new JsonRpc(process.env.RPC_HTTP_URL!, { headers: { "x-api-key": process.env.RPC_KEY ?? "" } });
const viaRpc = new Chain(rpc, { send: new JsonRpc(process.env.SEQUENCER_URL ?? process.env.RPC_HTTP_URL!) });
console.log(rpc.displayUrl, redactUrl(process.env.RPC_HTTP_URL!)); // both safe to log
const inBrowser = new Chain(window.ethereum);
console.log(viaRpc.rpc === rpc, inBrowser.sendRpc === inBrowser.rpc);
// ANCHOR_END: transport

// ANCHOR: codec
// Encode a call, run it, decode the answer with the ABI's own names.
const P = pair();
const raw = await chain.call(PAIR, P.encode("lastPairPrice"));
const price = P.decode<{ spotPrice: bigint; updateTs: bigint }>("lastPairPrice", raw);
console.log("stored price", formatUnits18(price.spotPrice), "at", Number(price.updateTs));

// A struct output decodes to an object of its fields.
const bucket = P.decode<{ isLong: boolean; size: bigint; collateral: bigint }>(
  "positionBuckets",
  await chain.call(PAIR, P.encode("positionBuckets", user)),
);
console.log(bucket.isLong ? "long" : "short", formatUnits18(bucket.size));
// ANCHOR_END: codec

// ANCHOR: batch
// Many reads in as few eth_calls as the node allows. A failing read reports [false, revertData].
const L = lens();
const reads = [
  { to: PAIR, data: P.encode("lastPairPrice") },
  { to: PAIR, data: P.encode("marginRequirements") },
  { to: LENS, data: L.encode("triggerBounty", PAIR, 42n) },
];
const results = await chain.batch(reads);
const [ok, data] = results[2]!;
if (ok) console.log("bounty", formatUnits18(L.decode<bigint>("triggerBounty", data)));
else console.log("read failed:", decodeError(data).toString());
console.log("state overrides:", await chain.supportsOverrides());
// ANCHOR_END: batch

// ANCHOR: errors
try {
  await chain.call(PAIR, P.encode("claimFees"), { from: user });
} catch (e) {
  if (e instanceof RpcError && e.revertData) {
    const err = decodeError(e.revertData);
    console.log(err.name, err.args); // e.g. CollateralLib__NothingToClaim {}
    console.log(err.message); // the user-facing sentence, or the operator hint, or the name
    console.log(err.toString()); // name(args): hint, for logs
    const opens = err.opensAt(); // for a "too early" error, when the call opens (unix seconds)
    if (opens !== null) console.log("retry after", new Date(opens * 1000).toISOString());
  } else throw e;
}
// ANCHOR_END: errors

// ANCHOR: logs
// Raw logs for a block range, decoded by the pair's codec (which knows its libraries' events too).
const from = head.number - 1_000;
for (const log of await chain.logs(from, head.number, [PAIR])) {
  const ev = P.decodeLog<{ maker: Address; taker: Address; fillSize: bigint; price: bigint }>(log);
  if (ev?.name === "Trade") console.log(ev.blockNumber, ev.args.maker, formatUnits18(ev.args.fillSize), "@", formatUnits18(ev.args.price));
}
// topic0 for a filter of your own:
console.log(P.topic("Trade"));
// ANCHOR_END: logs

// ANCHOR: deployment-block
// The block the factory was deployed in, by binary search on eth_getCode (needs historical state).
try {
  const startBlock = await findDeploymentBlock(chain, FACTORY);
  console.log("index from block", startBlock);
} catch (e) {
  if (e instanceof DeploymentBlockError) console.error(e.message); // pruned node, or no code there
  else throw e;
}
// ANCHOR_END: deployment-block

// ANCHOR: probe
// Simulate a call from the probe (placed by state override) and read what it would earn.
const update: Hex[] = []; // a signed Pyth update for the pair's legs, from a PriceService
const pythFee = 0n; // Reader.updateFee(update): the oracle's fee in wei
const refresh = P.encode("refreshPrice", update);
const sim = await chain.probe(null, PAIR, refresh, pythFee, LENS, PAIR);
if (!sim.ok) console.log("would revert:", decodeError(sim.ret).toString());
else console.log("reward $" + formatUnits18(sim.reward), "gas", sim.gasUsed);
// ANCHOR_END: probe

// ANCHOR: send-raw
// Sign with your own key and submit exactly once; settle an unknown outcome by the hash.
const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as Hex);
const gas = await chain.estimateGas(account.address, PAIR, refresh, pythFee);
const signed = await account.signTransaction({
  chainId: await chain.chainId(),
  type: "eip1559",
  to: PAIR,
  data: refresh,
  value: pythFee,
  nonce: await chain.nonce(account.address),
  gas: (gas * 12n) / 10n,
  maxFeePerGas: head.baseFee * 2n,
  maxPriorityFeePerGas: 0n,
});
try {
  const hash = await chain.sendRaw(signed);
  const receipt = await chain.receipt(hash); // null until mined: poll it
  console.log(hash, receipt?.status);
} catch (e) {
  if (e instanceof SendError) {
    // Unknown outcome: it may still be mined. Look up e.hash; resending `signed` is safe, signing anew is not.
    console.warn(e.message, e.hash);
  } else if (e instanceof RpcError) {
    console.error("refused:", e.rpcMessage); // underpriced, insufficient funds, ...: not in the pool
  } else throw e; // TypeError: not signed hex, or a blob transaction
}
// ANCHOR_END: send-raw
