// One-shot runs and manual operations from TypeScript, and the scan for available operations.
import type { Address, Hex } from "viem";
import { type ActionResult, Keeper, findOpportunities, loadConfig } from "@liberta-labs/bazaar-keeper";

const MARKET: Address = "0x0000000000000000000000000000000000000000"; // a market's address (or its label)
const ASSERTION: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

const keeper = await Keeper.create(loadConfig("bazaar-keeper.yaml"));

function show(r: ActionResult): void {
  console.log(`${r.status}  ${r.job}  ${r.market}  ${r.summary}`);
  if (r.reason) console.log(`   ${r.reason}`);
  if (r.txHash) console.log(`   tx ${r.txHash}`);
}

// ANCHOR: auto
// Automatic jobs, once. Each keeps its job's profit and loss rules unless force is set.
for (const r of await keeper.run.executeTriggers(MARKET, { dryRun: true })) show(r);
for (const r of await keeper.run.liquidate(MARKET, ["0x0000000000000000000000000000000000000001"], { force: true })) show(r);
for (const r of await keeper.run.sweepExpired(MARKET, [12n, 13n], { dryRun: true })) show(r);
for (const r of await keeper.run.collect("all")) show(r);
// ANCHOR_END: auto

// ANCHOR: manual
// Manual operations: simulate first, look at the result, then send.
const preview = await keeper.run.terminateScheduledPair(MARKET, { dryRun: true });
show(preview);
if (preview.status === "simulated" && preview.wouldSend) {
  show(await keeper.run.terminateScheduledPair(MARKET));
}

// The factory's operations sit under run.factory.
show(await keeper.run.factory.settleDeploymentProposal(ASSERTION, { dryRun: true }));
// ANCHOR_END: manual

// ANCHOR: opportunities
// Every manual operation that a dry run shows would go through now, or that opens later.
for (const o of await findOpportunities(keeper)) {
  console.log(o.describe());
  if (o.ready) console.log(`   bazaar keeper ${o.command}`);
}
// ANCHOR_END: opportunities

await keeper.close();
