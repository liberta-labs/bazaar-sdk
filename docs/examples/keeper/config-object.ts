// A keeper configured in code instead of a YAML file.
import { Keeper, parseConfig, setupLogging } from "@liberta-labs/bazaar-keeper";

/** An environment variable that must be set; never written into the source. */
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ANCHOR: parse
// The same schema as the YAML file, with the same defaults and the same refusal of unknown keys.
// parseConfig does not read .env, fill ${NAME} references or apply the file's secrets rule: the
// object is used as given, so take secrets from the environment (or a secret store) yourself.
const cfg = parseConfig({
  network: "arbitrum-sepolia",
  factory: "0x0000000000000000000000000000000000000000",
  rpc: { http: env("RPC_HTTP_URL") },
  subgraph: { url: "none" },
  prices: { endpoint: "pyth", token: env("PYTH_PRO_TOKEN") }, // channel defaults to fixed_rate@200ms
  wallets: {
    default: { type: "keystore", path: "/srv/keeper/keys/default.json", password: env("KEEPER_KEYSTORE_PASSWORD") },
    fast: { type: "privateKey", key: env("KEEPER_FAST_KEY") },
  },
  jobs: {
    liquidation: { wallet: "fast" }, // {} or an object turns a job on; leaving it out keeps it off
    triggers: { wallet: "fast", minBountyUsd: 0.05 },
    unload: {},
    refresh: {},
    collect: { thresholdUsd: 10 },
  },
  budget: { maxSpendUsdPerDay: 20, minEthBalance: 0.005 },
  state: { dir: "/srv/keeper/state" },
  log: { level: "info", format: "json" },
});
// ANCHOR_END: parse

setupLogging(cfg.log.level, cfg.log.format);
const keeper = await Keeper.create(cfg);
console.log([...keeper.jobs.keys()]); // ["liquidation", "triggers", "unload", "refresh", "collect"]
await keeper.close();
