// The keeper inside a long-running service: a health endpoint, a metrics feed, a clean shutdown.
import { createServer } from "node:http";
import { type ActionResult, Keeper, loadConfig, setupLogging } from "@liberta-labs/bazaar-keeper";

const cfg = loadConfig(process.env.KEEPER_CONFIG ?? "bazaar-keeper.yaml");
setupLogging(cfg.log.level, "json");

// ANCHOR: service
const keeper = await Keeper.create(cfg);

// Running totals for a metrics system, fed by the "action" event (sent transactions only).
const totals = { sent: 0, reverted: 0, rewardUsd: 0, gasUsd: 0 };
keeper.on("action", (r: ActionResult) => {
  totals.sent += 1;
  if (r.status === "reverted") totals.reverted += 1;
  totals.rewardUsd += r.rewardUsd;
  totals.gasUsd += r.costUsd;
});

// GET /health: 200 while the keeper is running, has live prices and is allowed to send.
// GET /status: what `bazaar keeper status` reads (the same object as status.json).
const server = createServer((req, res) => {
  const s = keeper.statusDict();
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...s, totals }));
    return;
  }
  const healthy = keeper.running && s.prices.healthy && !s.halted && s.block - s.indexed < 64;
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy, block: s.block, indexed: s.indexed, prices: s.prices, halted: s.halted }));
});
server.listen(9464, "127.0.0.1");

let stopping: Promise<void> | null = null;
const shutdown = (): void => {
  stopping ??= keeper.stop().finally(() => server.close());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await keeper.start(); // rejects if connecting fails (wrong chain, bad wiring, no deployment block)
} catch (e) {
  console.error(`the keeper could not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
  server.close();
} finally {
  await keeper.close();
}
// ANCHOR_END: service
