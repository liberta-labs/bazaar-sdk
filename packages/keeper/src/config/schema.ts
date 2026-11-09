/**
 * The keeper's configuration, as the YAML file or a plain object gives it (camelCase keys).
 *
 * Unknown keys are refused everywhere, so a typo is an error rather than a silently ignored setting.
 */

import { NETWORKS, PRICE_ENDPOINTS } from "@liberta-labs/bazaar-sdk";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";

const address = z.string().transform((v, ctx): Address => {
  if (!isAddress(v, { strict: false })) {
    // Never the value itself: a key pasted into the wrong field must not reach a terminal or a log.
    const key = /^(0[xX])?[0-9a-fA-F]{64}$/.test(v.trim());
    const message = key
      ? "not an address: it is 32 bytes of hex, the length of a private key; put the wallet's address here (0x and 40 hex digits), never a key"
      : "not an address: expected 0x and 40 hex digits";
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  }
  return getAddress(v);
});

const positive = (d: number) => z.number().gt(0).default(d);
const nonNegative = (d: number) => z.number().gte(0).default(d);

export const RpcConfig = z
  .object({
    http: z.string(),
    /** where to submit transactions; defaults to `http`. `sequencer` uses the network's sequencer. */
    send: z.string().nullish(),
    maxRequestsPerSecond: positive(25),
    /** blocks per eth_getLogs request */
    logChunk: z.number().int().gt(0).default(2_000),
  })
  .strict();

export const SubgraphConfig = z
  .object({
    /** default | none | a GraphQL URL */
    url: z.string().default("default"),
    apiKey: z.string().nullish(),
  })
  .strict();

export const PricesConfig = z
  .object({
    /** bazaar | pyth | any Hermes-compatible URL */
    endpoint: z.string().default("bazaar"),
    /** sent as "Authorization: Bearer <key>" */
    apiKey: z.string().nullish(),
    headers: z.record(z.string()).default({}),
    /** live prints over server-sent events; polls `latest` when off or failing */
    stream: z.boolean().default(true),
    pollInterval: positive(1.0),
    /**
     * A stream that sends nothing (not even a keep-alive) for this long is dropped and reconnected, so a
     * silently stalled connection cannot leave the keeper on old prices. 0 waits forever.
     */
    streamIdleTimeoutSeconds: nonNegative(10),
    /**
     * A print must be this much younger than the pair's 3 s limit before a call carries it, so it is
     * still fresh when the transaction lands.
     */
    sendMarginSeconds: z.number().gte(0).lt(3).default(1.0),
  })
  .strict();

const WALLET_NEEDS: Record<string, string[]> = {
  privateKey: ["key"],
  keystore: ["path"],
  mnemonic: ["phrase"],
  remote: ["url", "address"],
};

export const WalletConfig = z
  .object({
    type: z.enum(["privateKey", "keystore", "mnemonic", "remote"]),
    key: z.string().nullish(),
    path: z.string().nullish(),
    password: z.string().nullish(),
    phrase: z.string().nullish(),
    index: z.number().int().gte(0).default(0),
    url: z.string().nullish(),
    address: address.nullish(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const missing = (WALLET_NEEDS[w.type] ?? []).filter((f) => {
      const v = (w as Record<string, unknown>)[f];
      return v === undefined || v === null || v === "";
    });
    if (missing.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${w.type} wallet needs ${missing.join(", ")}` });
  });

const jobShape = {
  enabled: z.boolean().default(true),
  markets: z.union([z.literal("all"), z.array(z.string())]).default("all"),
  exclude: z.array(z.string()).default([]),
  wallet: z.string().default("default"),
  dryRun: z.boolean().default(false),
  minProfitUsd: z.number().nullish(),
  gasSafetyMultiplier: z.number().nullish(),
  /**
   * Losing calls: a call whose gas costs more than it earns is skipped unless allowLoss is on. Then
   * it is sent as long as the loss fits both caps.
   */
  allowLoss: z.boolean().default(false),
  maxLossUsdPerCall: nonNegative(0.05),
  lossBudgetUsdPerDay: nonNegative(1.0),
};

export const JobConfig = z.object(jobShape).strict();

export const LiquidationJob = z
  .object({ ...jobShape, watchBufferPct: nonNegative(3.0), maxAccountsPerCall: z.number().int().gt(0).default(40) })
  .strict();

export const TriggersJob = z
  .object({ ...jobShape, minBountyUsd: nonNegative(0.01), includeUnbountied: z.boolean().default(false) })
  .strict();

export const UnloadJob = z
  .object({ ...jobShape, maxSteps: z.number().int().gt(0).lte(32).default(32), recheckSeconds: positive(15) })
  .strict();

export const AdlJob = z.object({ ...jobShape, maxWinnersPerSide: z.number().int().gt(0).lte(25).default(25) }).strict();

export const RefreshJob = z
  .object({
    ...jobShape,
    /**
     * Unpaid refreshes that would open an ADL window or end a timed-out one. Turning them on is consent
     * to pay for them, within healthPokeMaxCostUsd each and the job's loss budget.
     */
    healthPokes: z.boolean().default(false),
    healthPokeIntervalSeconds: positive(60),
    healthPokeMaxCostUsd: nonNegative(0.1),
  })
  .strict();

export const CollectJob = z
  .object({
    ...jobShape,
    thresholdUsd: nonNegative(5),
    maxAgeDays: positive(7),
    forwardTo: address.nullish(),
    forwardMinUsd: nonNegative(50),
    onShutdown: z.boolean().default(true),
    intervalSeconds: positive(600),
  })
  .strict();

export const TerminalSettlementJob = z
  .object({
    ...jobShape,
    /**
     * finalizeTermination pays nothing; finalize: true is consent to pay for it, within
     * finalizeMaxCostUsd and the job's loss budget.
     */
    finalize: z.boolean().default(true),
    finalizeMaxCostUsd: nonNegative(0.5),
    maxAccountsPerCall: z.number().int().gt(0).default(100),
  })
  .strict();

export const SweepExpiredJob = z
  .object({
    ...jobShape,
    /**
     * sweepExpired pays its caller nothing, so every call is a loss: this job is a public service and
     * runs only within its loss budget.
     */
    allowLoss: z.boolean().default(true),
    lossBudgetUsdPerDay: nonNegative(0.25),
    minBatch: z.number().int().gt(0).default(10),
    maxOrdersPerCall: z.number().int().gt(0).default(100),
    includeBountyRefunds: z.boolean().default(true),
  })
  .strict();

export const JobsConfig = z
  .object({
    liquidation: LiquidationJob.nullish(),
    triggers: TriggersJob.nullish(),
    unload: UnloadJob.nullish(),
    adl: AdlJob.nullish(),
    refresh: RefreshJob.nullish(),
    collect: CollectJob.nullish(),
    terminalSettlement: TerminalSettlementJob.nullish(),
    sweepExpired: SweepExpiredJob.nullish(),
  })
  .strict();

export const ProfitConfig = z
  .object({ minProfitUsd: z.number().default(0.001), gasSafetyMultiplier: z.number().gte(1).default(1.25) })
  .strict();

export const GasConfig = z
  .object({
    /** hard ceiling on the fee per gas; none by default */
    maxFeeGwei: z.number().nullish(),
    /** ceiling for collect, cleanup and finalize */
    backgroundMaxFeeGwei: z.number().nullable().default(0.1),
    /** maxFeePerGas = base fee × this */
    feeMultiplier: z.number().gte(1).default(2.0),
    gasLimitMultiplier: z.number().gte(1).default(1.25),
    /** prices gas when the endpoint serves no usable ETH/USD print (none, stale, or not a sane number) */
    ethUsdFallback: positive(3000),
    /**
     * The lowest ETH/USD gas is ever priced at, whatever the price endpoint says, so a tiny print
     * cannot make costs look free and the USD budgets meaningless.
     */
    ethUsdFloor: z.number().finite().gt(0).default(1000),
    /** An ETH/USD print older than this (seconds) is not used to price gas; ethUsdFallback is. */
    ethUsdMaxAgeSeconds: positive(60),
  })
  .strict();

export const BudgetConfig = z
  .object({
    /** all gas, every job */
    maxSpendUsdPerDay: nonNegative(10),
    /**
     * All ETH the keeper's transactions spend in a day (gas and the update fees they carry), counted
     * in wei, so no price can lift it. Left out, it is maxSpendUsdPerDay at gas.ethUsdFloor (with the
     * defaults, $10 at $1000: 0.01 ETH).
     */
    maxSpendEthPerDay: z.number().finite().gte(0).nullish(),
    /** every loss-taking call together */
    maxLossUsdPerDay: nonNegative(2),
    minEthBalance: nonNegative(0.002),
  })
  .strict();

export const SafetyConfig = z
  .object({ pauseAfterReverts: z.number().int().gt(0).default(3), pauseMinutes: positive(15) })
  .strict();

export const ALERT_KINDS = ["lowBalance", "jobPaused", "endpointDown", "opportunity", "dailySummary", "action"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const AlertsConfig = z
  .object({
    telegram: z.object({ botToken: z.string(), chatId: z.string() }).strict().nullish(),
    discord: z.object({ webhook: z.string() }).strict().nullish(),
    webhook: z.object({ url: z.string() }).strict().nullish(),
    notify: z.array(z.enum(ALERT_KINDS)).default(["lowBalance", "jobPaused", "endpointDown", "opportunity", "dailySummary"]),
  })
  .strict();

export const StateConfig = z.object({ dir: z.string().default("~/.bazaar") }).strict();

export const LogConfig = z
  .object({
    level: z.enum(["debug", "info", "warning", "error"]).default("info"),
    format: z.enum(["pretty", "json"]).default("pretty"),
  })
  .strict();

export const EngineConfig = z
  .object({
    /**
     * How often the keeper reads the head and new logs, then lets every job plan. Liquidation and
     * triggers also plan on each new print, without waiting for this.
     */
    tickSeconds: positive(0.5),
    /** wait before re-simulating a refused candidate */
    simCooldownSeconds: nonNegative(2.0),
    /** state reads for markets with nothing to do */
    idleRefreshSeconds: positive(5.0),
    snapshotSeconds: positive(60),
  })
  .strict();

export const KeeperConfig = z
  .object({
    network: z.string(),
    chainId: z.number().int().nullish(),
    factory: address.nullish(),
    startBlock: z.number().int().gte(0).nullish(),
    rpc: RpcConfig,
    subgraph: SubgraphConfig.default({}),
    prices: PricesConfig.default({}),
    wallets: z.record(WalletConfig).default({}),
    jobs: JobsConfig.default({}),
    profit: ProfitConfig.default({}),
    gas: GasConfig.default({}),
    budget: BudgetConfig.default({}),
    safety: SafetyConfig.default({}),
    alerts: AlertsConfig.default({}),
    state: StateConfig.default({}),
    log: LogConfig.default({}),
    engine: EngineConfig.default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const preset = NETWORKS[c.network];
    if (c.network !== "custom" && !preset) {
      issue(`network must be one of ${[...Object.keys(NETWORKS), "custom"].join(", ")}, not ${JSON.stringify(c.network)}`);
      return;
    }
    if (c.network === "custom" && (c.chainId == null || c.factory == null)) {
      issue("a custom network needs chainId and factory");
      return;
    }
    if (preset && preset.factory === null && c.factory == null) {
      issue(
        `${c.network} has no official factory address in this release yet; set factory to the deployment you want to keep`,
      );
      return;
    }
    if (Object.keys(c.wallets).length) {
      for (const [name, job] of Object.entries(enabledJobs(c.jobs))) {
        if (!(job.wallet in c.wallets)) issue(`job ${name} uses wallet '${job.wallet}', which is not under wallets`);
      }
    }
  });

export type RpcConfig = z.infer<typeof RpcConfig>;
export type SubgraphConfig = z.infer<typeof SubgraphConfig>;
export type PricesConfig = z.infer<typeof PricesConfig>;
export type WalletConfig = z.infer<typeof WalletConfig>;
export type JobConfig = z.infer<typeof JobConfig>;
export type LiquidationJob = z.infer<typeof LiquidationJob>;
export type TriggersJob = z.infer<typeof TriggersJob>;
export type UnloadJob = z.infer<typeof UnloadJob>;
export type AdlJob = z.infer<typeof AdlJob>;
export type RefreshJob = z.infer<typeof RefreshJob>;
export type CollectJob = z.infer<typeof CollectJob>;
export type TerminalSettlementJob = z.infer<typeof TerminalSettlementJob>;
export type SweepExpiredJob = z.infer<typeof SweepExpiredJob>;
export type JobsConfig = z.infer<typeof JobsConfig>;
export type ProfitConfig = z.infer<typeof ProfitConfig>;
export type GasConfig = z.infer<typeof GasConfig>;
export type BudgetConfig = z.infer<typeof BudgetConfig>;
export type SafetyConfig = z.infer<typeof SafetyConfig>;
export type AlertsConfig = z.infer<typeof AlertsConfig>;
export type StateConfig = z.infer<typeof StateConfig>;
export type LogConfig = z.infer<typeof LogConfig>;
export type EngineConfig = z.infer<typeof EngineConfig>;
export type KeeperConfig = z.infer<typeof KeeperConfig>;

/** The jobs in the order the keeper runs and reports them, by their config key. */
export const JOB_NAMES = [
  "liquidation",
  "triggers",
  "unload",
  "adl",
  "refresh",
  "collect",
  "terminalSettlement",
  "sweepExpired",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** The jobs switched on, by name. */
export function enabledJobs(jobs: JobsConfig): Partial<Record<JobName, JobConfig>> {
  const out: Partial<Record<JobName, JobConfig>> = {};
  for (const name of JOB_NAMES) {
    const j = jobs[name];
    if (j && j.enabled) out[name] = j;
  }
  return out;
}

/** The price endpoint's base URL. */
export function priceBaseUrl(p: PricesConfig): string {
  if (p.endpoint in PRICE_ENDPOINTS) {
    const url = PRICE_ENDPOINTS[p.endpoint];
    if (!url) {
      throw new Error(
        `the '${p.endpoint}' price endpoint has no URL yet; set prices.endpoint to 'pyth' with your own Pyth API key, ` +
          "or to the URL of a Hermes-compatible service",
      );
    }
    return url;
  }
  return p.endpoint.replace(/\/+$/, "");
}

export interface ResolvedNetwork {
  readonly name: string;
  readonly chainId: number;
  readonly factory: Address;
  readonly startBlock: number;
  readonly official: boolean;
  readonly subgraphUrl: string | null;
  readonly sendUrl: string | null;
}

export function resolvedNetwork(c: KeeperConfig): ResolvedNetwork {
  const preset = NETWORKS[c.network];
  const factory = (c.factory ?? preset?.factory) as Address;
  const official = Boolean(preset && preset.official && preset.factory && factory === preset.factory);
  return {
    name: c.network,
    chainId: (c.chainId ?? preset?.chainId) as number,
    factory,
    startBlock: c.startBlock ?? preset?.startBlock ?? 0,
    official,
    subgraphUrl: preset?.subgraphUrl ?? null,
    sendUrl: preset?.sendUrl ?? null,
  };
}

export function subgraphUrl(c: KeeperConfig): string | null {
  if (c.subgraph.url === "none") return null;
  if (c.subgraph.url === "default") return resolvedNetwork(c).subgraphUrl;
  return c.subgraph.url;
}
