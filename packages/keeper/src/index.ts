/**
 * The Bazaar keeper: Bazaar's permissionless upkeep, for its bounties, run from your own wallet.
 *
 *     import { Keeper, loadConfig } from "@liberta-labs/bazaar-keeper";
 *
 *     const keeper = await Keeper.create(loadConfig("bazaar-keeper.yaml"));
 *     keeper.on("action", (r) => console.log(r.job, r.market, r.status, r.rewardUsd, r.costUsd));
 *     await keeper.run.liquidate("BTC/USD", { dryRun: true });   // one-shot, market named per call
 *     await keeper.start();                                        // runs the enabled jobs until keeper.stop()
 *
 * The chain, price, formula and market layers come from @liberta-labs/bazaar-sdk.
 */

export * from "./config/index.js";
export * from "./exec/index.js";
export * from "./observe/index.js";
export * from "./state/index.js";
export * from "./sync/index.js";
export * from "./keeper/index.js";
export { runDoctor } from "./cli/doctor.js";
export { runWizard } from "./cli/wizard.js";
export { startMockHermes, serveMockHermes, MockHermes } from "./devtools/mock-hermes.js";

export const VERSION = "0.1.0";
