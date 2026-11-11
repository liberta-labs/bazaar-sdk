// A keeper against a local Anvil deployment, with the mock price server in the same process.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ETH_USD_FEED } from "@liberta-labs/bazaar-sdk";
import { Keeper, MockPro, parseConfig, setupLogging, startMockPro } from "@liberta-labs/bazaar-keeper";

// The addresses of the e2e fixture's deployment, replayed on a fresh Anvil. Use your own
// deployment's addresses if you deployed differently.
const RPC = "http://127.0.0.1:8546";
const FACTORY = "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d";
// Anvil's eighth default account (m/44'/60'/0'/0/7 of the public test mnemonic): a test key only.
const KEEPER_KEY = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356";

// ANCHOR: mock
// Updates signed with the public test key the local verifier trusts, stamped with the chain's time
// so Anvil accepts them as fresh. ETH/USD is Pyth Pro feed 2.
const mock = new MockPro({ rpc: RPC, prices: { [ETH_USD_FEED]: 2000 }, symbols: { [ETH_USD_FEED]: "Crypto.ETH/USD" } });
const prices = await startMockPro(mock, { port: 0 }); // port 0: any free port
console.log(`mock Pyth Pro at ${prices.url}, streaming at ${prices.streamUrl}`);
// ANCHOR_END: mock

// ANCHOR: keeper
const cfg = parseConfig({
  network: "anvil",
  factory: FACTORY,
  rpc: { http: RPC, maxRequestsPerSecond: 200 },
  subgraph: { url: "none" }, // index from logs; on a fresh Anvil the scan is short
  prices: { endpoint: prices.url, sendMarginSeconds: 0.5 },
  wallets: { default: { type: "privateKey", key: KEEPER_KEY } },
  jobs: {
    liquidation: {},
    triggers: {},
    unload: { recheckSeconds: 2 },
    adl: {},
    refresh: {},
    terminalSettlement: { finalizeMaxCostUsd: 1 },
    sweepExpired: { minBatch: 1 },
    collect: { thresholdUsd: 0.01, intervalSeconds: 3 },
  },
  budget: { minEthBalance: 0.001 },
  state: { dir: mkdtempSync(join(tmpdir(), "bazaar-keeper-")) }, // a fresh index every run
  engine: { idleRefreshSeconds: 1.5, simCooldownSeconds: 1 },
});
setupLogging("info");
const keeper = await Keeper.create(cfg);
keeper.on("action", (r) => console.log(`${r.job}: ${r.status} ${r.summary}`));
const running = keeper.start();
// ANCHOR_END: keeper

// ANCHOR: move
// Move the price; the keeper sees it on the next update (the mock streams every 200 ms by default).
await new Promise((r) => setTimeout(r, 10_000));
mock.setPrice(ETH_USD_FEED, 1500);
// Stop the feed generating prices, as a market closing for the night would: its updates carry the
// last price forward, so on this 24/7 market the keeper attaches none of them (on a market with
// trading hours a liquidation could still carry the newest, for a minute after that price).
mock.pause(ETH_USD_FEED);
await new Promise((r) => setTimeout(r, 10_000));
mock.resume(ETH_USD_FEED);
// ANCHOR_END: move

await keeper.stop({ collect: false });
await running;
await keeper.close();
await prices.close();
