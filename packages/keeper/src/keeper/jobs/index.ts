import type { JobName } from "../../config/index.js";
import { AdlJob } from "./adl.js";
import type { JobClass } from "./base.js";
import { CollectJob } from "./collect.js";
import { LiquidationJob } from "./liquidation.js";
import { RefreshJob } from "./refresh.js";
import { SweepExpiredJob } from "./sweep.js";
import { TerminalSettlementJob } from "./terminal.js";
import { TriggersJob } from "./triggers.js";
import { UnloadJob } from "./unload.js";

export { AdlJob } from "./adl.js";
export { ALL_STATUSES, type ActionExtras, Job, type JobClass, LIVE, LIVE_OR_ADL, PricedCall, monotonic } from "./base.js";
export { CollectJob } from "./collect.js";
export { LiquidationJob, belowMaintenance } from "./liquidation.js";
export { RefreshJob } from "./refresh.js";
export { SweepExpiredJob } from "./sweep.js";
export { TerminalSettlementJob } from "./terminal.js";
export { TriggersJob } from "./triggers.js";
export { UnloadJob } from "./unload.js";

/**
 * Config key (camelCase, as JobsConfig names them) -> job class. The keeper runs the enabled jobs in
 * the config's order (JOB_NAMES), with the latency-critical ones first.
 */
export const JOBS: Readonly<Record<JobName, JobClass>> = {
  liquidation: LiquidationJob,
  triggers: TriggersJob,
  adl: AdlJob,
  unload: UnloadJob,
  refresh: RefreshJob,
  terminalSettlement: TerminalSettlementJob,
  sweepExpired: SweepExpiredJob,
  collect: CollectJob,
};
