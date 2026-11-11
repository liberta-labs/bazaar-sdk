// The keeper from TypeScript: build it from the YAML config, listen to it, run one call, run it all.
import { ConfigError, Keeper, WalletError, loadConfig, setupLogging } from "@liberta-labs/bazaar-keeper";

// ANCHOR: create
// Reads bazaar-keeper.yaml, the .env beside it and the environment, with the same rules as the CLI.
const cfg = loadConfig("bazaar-keeper.yaml");

// The CLI configures logging itself; a program does it once, before the keeper logs anything.
setupLogging(cfg.log.level, cfg.log.format);

let keeper: Keeper;
try {
  // Loads the wallets now: a keystore without a password in the config asks for it on a terminal.
  keeper = await Keeper.create(cfg);
} catch (e) {
  if (e instanceof ConfigError || e instanceof WalletError) {
    console.error(e.message); // one readable line, never a key or a password
    process.exit(2);
  }
  throw e;
}
// ANCHOR_END: create

// ANCHOR: events
// A sent transaction's result, once its receipt is in.
const offAction = keeper.on("action", (r) => {
  console.log(`${r.job} ${r.market}: ${r.status}, earned $${r.rewardUsd.toFixed(4)} for $${r.costUsd.toFixed(4)} (${r.txHash})`);
});
// The moment a transaction is submitted, before its receipt.
keeper.on("sent", ([action, txHash]) => console.log(`sent ${action.job} ${action.summary}: ${txHash}`));
// lowBalance, jobPaused and endpointDown, whether or not an alert channel is configured.
keeper.on("alert", ([kind, message]) => console.warn(`alert ${kind}: ${message}`));
// Each `on` returns the function that unsubscribes.
offAction();
// ANCHOR_END: events

// ANCHOR: oneshot
// One call, the market named on the call. A dry run simulates and reports, and sends nothing.
for (const r of await keeper.run.liquidate("ETH/USD", { dryRun: true })) {
  console.log(r.status, r.summary, r.reason);
  if (r.status === "simulated" && r.wouldSend) {
    console.log(`would earn $${r.expectedRewardUsd.toFixed(4)} for about $${r.costUsd.toFixed(4)} of gas`);
  }
}

// A manual operation returns one result. Reverts in simulation come back decoded.
const fin = await keeper.run.finalizeTermination("0x0000000000000000000000000000000000000000", { dryRun: true });
if (fin.error) console.log(`would revert: ${fin.error.toString()}`);
if (fin.opensAt) console.log(`opens at ${new Date(fin.opensAt * 1000).toISOString()}`);
// ANCHOR_END: oneshot

// ANCHOR: start-stop
// start() connects, then runs until stop(); it resolves once the shutdown is done.
const stopOnce = (): void => {
  // Waits up to 60 s for in-flight sends, claims earnings if jobs.collect.onShutdown, saves the snapshot.
  void keeper.stop({ timeout: 60 });
};
process.once("SIGINT", stopOnce);
process.once("SIGTERM", stopOnce);

try {
  await keeper.start();
} finally {
  await keeper.close(); // releases the price stream, the subgraph and alert clients
}
// ANCHOR_END: start-stop
