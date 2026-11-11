// A complete relayer: receives signed requests over HTTP, verifies them, submits them from its own key,
// and claims the fees it earns. Node 20+, no dependencies beyond the SDK and viem.
//
//   RPC_URL=... PYTH_PRO_API_KEY=... BAZAAR_FACTORY=0x... RELAYER_PRIVATE_KEY=0x... node relayer.js
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { Bazaar, InputError, errorMessage, formatUnits18, parseUnits18, relay } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, createWalletClient, http, nonceManager, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

// ANCHOR: setup
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const FACTORY = (process.env.BAZAAR_FACTORY ?? "0x0000000000000000000000000000000000000000") as Address;
const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://app.example.com";

/** The least this relayer accepts per request, and the most Pyth fee it will pay for one. */
const MIN_FEE = parseUnits18("0.02");
const MAX_PYTH_FEE = parseEther("0.0005");

const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex, { nonceManager });
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(RPC_URL) });

const bz = await Bazaar.connect({
  transport: RPC_URL,
  factory: FACTORY,
  chainId: arbitrum.id,
  prices: { token: process.env.PYTH_PRO_API_KEY }, // the relayer attaches fresh prices; a server may hold the key
});

// Refuse to start if what users sign is not what this deployment verifies.
const typehashes = await bz.signing.verifyTypehashes();
if (!typehashes.ok) throw new Error(`EIP-712 mismatch: ${typehashes.mismatches.join("; ")}`);
// ANCHOR_END: setup

// ANCHOR: handle
interface Answer {
  status: number;
  body: { hash?: Hex; error?: string; problems?: readonly { field: string; message: string }[] };
}

async function relayOne(body: string): Promise<Answer> {
  let req: relay.RelayedRequest;
  try {
    req = relay.parseRelayed(body); // shape and types; the signature canonicalized
  } catch (e) {
    return { status: 400, body: { error: e instanceof InputError ? e.message : "expected a JSON request" } };
  }
  if (req.relayerFee < MIN_FEE) {
    return { status: 402, body: { error: `this relayer charges at least ${formatUnits18(MIN_FEE)} USDC per request` } };
  }

  const check = await bz.relay.verifyRelayed(req); // signer, chain, deadline, nonce, fee cap, bounds, permit
  if (!check.ok) return { status: 422, body: { error: "the request would revert", problems: check.problems } };
  for (const w of check.warnings) console.warn(`${req.signer}: ${w}`);
  if (check.secondsLeft < 2) return { status: 422, body: { error: "the signature expires too soon: sign again" } };

  // Built now: a fresh price update and fresh book hints, outside the signature.
  const call = await bz.relay.encodeRelayed(req, { relayer: account.address });
  if (call.value > MAX_PYTH_FEE) return { status: 503, body: { error: "the price update fee is unusually high; try again" } };

  const sim = await bz.simulate(call);
  if (!sim.ok) return { status: 422, body: { error: sim.error!.message } };

  try {
    const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
    console.log(`${call.summary}: ${hash}`);
    return { status: 202, body: { hash } };
  } catch (e) {
    return { status: 502, body: { error: errorMessage(e) } };
  }
}
// ANCHOR_END: handle

// ANCHOR: queue
// A signer's requests on one pair land only in nonce order, so handle them one at a time, each after
// the previous one has been mined. Different signers run in parallel.
const queues = new Map<string, Promise<unknown>>();

function inOrder<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function relayInOrder(body: string): Promise<Answer> {
  let key = "malformed";
  try {
    const o = JSON.parse(body) as { pair?: unknown; signer?: unknown };
    key = `${String(o.pair).toLowerCase()}:${String(o.signer).toLowerCase()}`;
  } catch {
    // relayOne answers 400
  }
  return inOrder(key, async () => {
    const answer = await relayOne(body);
    if (answer.body.hash) await bz.waitForReceipt(answer.body.hash, { timeoutMs: 30_000 }).catch(() => undefined);
    return answer;
  });
}
// ANCHOR_END: queue

// ANCHOR: server
const MAX_BODY = 16 * 1024;
const perIp = new Map<string, { count: number; since: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = perIp.get(ip);
  if (!e || now - e.since > 60_000) {
    perIp.set(ip, { count: 1, since: now });
    return false;
  }
  return ++e.count > 30; // 30 requests a minute per address
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-headers": "content-type",
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST" || req.url !== "/relay") return send(res, 404, { error: "POST /relay" });
  if (rateLimited(req.socket.remoteAddress ?? "?")) return send(res, 429, { error: "slow down" });
  try {
    const answer = await relayInOrder(await readBody(req));
    send(res, answer.status, answer.body);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "the relayer failed; try again" });
  }
}).listen(PORT, () => console.log(`relaying as ${account.address} on :${PORT}`));
// ANCHOR_END: server

// ANCHOR: claim
// Every hour, collect the fees earned on each market (claimFees refuses when nothing is owed).
async function claimAll(): Promise<void> {
  for (const m of await bz.markets.listMarkets({ refresh: true })) {
    try {
      const call = await bz.trade.claimFees(m.address, account.address);
      const sim = await bz.simulate(call);
      if (!sim.ok) continue;
      const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
      await bz.waitForReceipt(hash);
      console.log(`${m.label}: ${call.summary}`);
    } catch (e) {
      if (!(e instanceof InputError)) console.error(`${m.label}: ${errorMessage(e)}`);
    }
  }
}
setInterval(() => void claimAll(), 60 * 60 * 1000);
// ANCHOR_END: claim
