/** bazaar keeper init: ask what cannot be discovered, check each answer, write the config and .env. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ETH_USD_FEED, JsonRpc, NETWORKS, ProClient } from "@liberta-labs/bazaar-sdk";
import { type Hex, getAddress, isAddress } from "viem";
import { parse as parseYaml } from "yaml";
import {
  type JobName,
  type KeeperConfig,
  PricesConfig,
  expandHome,
  hermesEndpointProblem,
  missingProKey,
  parseConfig,
  priceEndpoints,
} from "../config/index.js";
import { LocalSigner, newKey, writeKeystore } from "../exec/wallets.js";
import { safeLabel } from "../observe/logs.js";
import { CliExit, FAIL, OK, type Output, WARN, c, consoleOutput, errorText, groupedFixed } from "./format.js";

/** [config key, title, what it pays], in the order the keeper runs the jobs. */
export const JOB_CHOICES: readonly (readonly [JobName, string, string])[] = [
  ["liquidation", "Liquidation", "paid: $0.05+ per account seized"],
  ["triggers", "Trigger execution", "paid: the bounty the order's owner attached"],
  ["unload", "Vault unload", "paid: 2 bp of what sells, $0.25 floor"],
  ["adl", "ADL execution", "paid: 2 bp of what closes, or 0.1% of the bad debt averted"],
  ["refresh", "Price refresh", "paid: $0.10 on quiet markets"],
  ["terminalSettlement", "Terminal settlement", "paid: $0.05 per position settled, then finalizes"],
  ["collect", "Collect earnings", "claims a market once its balance reaches your threshold"],
  ["sweepExpired", "Expired-order cleanup", "unpaid public service, within a daily budget"],
];

// ---- prompts ----

export interface PromptChoice<T> {
  name: string;
  value: T;
  checked?: boolean;
  disabled?: boolean | string;
}

type Validate = (value: string) => boolean | string;

/** The prompts the CLI asks: @inquirer/prompts' shapes, narrowed to what is used (tests stub them). */
export interface Prompts {
  select<T>(q: { message: string; choices: readonly PromptChoice<T>[]; default?: T }): Promise<T>;
  input(q: { message: string; default?: string; validate?: Validate }): Promise<string>;
  confirm(q: { message: string; default?: boolean }): Promise<boolean>;
  password(q: { message: string; validate?: Validate }): Promise<string>;
  checkbox<T>(q: { message: string; choices: readonly PromptChoice<T>[] }): Promise<T[]>;
}

/** @inquirer/prompts, loaded on first use. Ctrl-C rejects with an ExitPromptError. */
export const inquirerPrompts: Prompts = {
  select: async <T>(q: { message: string; choices: readonly PromptChoice<T>[]; default?: T }) =>
    (await import("@inquirer/prompts")).select<T>(q),
  input: async (q) => (await import("@inquirer/prompts")).input(q),
  confirm: async (q) => (await import("@inquirer/prompts")).confirm(q),
  password: async (q) => (await import("@inquirer/prompts")).password({ ...q, mask: "*" }),
  checkbox: async <T>(q: { message: string; choices: readonly PromptChoice<T>[] }) =>
    (await import("@inquirer/prompts")).checkbox<T>(q),
};

/** Ctrl-C (or a closed input) inside a prompt. */
export function isPromptExit(e: unknown): boolean {
  return e instanceof Error && (e.name === "ExitPromptError" || e.name === "AbortPromptError");
}

// ---- what the wizard talks to ----

export interface WizardDeps {
  prompts: Prompts;
  out: Output;
  /** whether stdin is a terminal */
  isTTY: boolean;
  /** the RPC's chain id */
  chainId(url: string): Promise<number>;
  /** a line describing the ETH/USD print of `endpoint` (a `prices.endpoint` value), read with `token` */
  priceCheck(endpoint: string, token: string | null): Promise<string>;
  /** the factory's markets (the engine's listMarkets) */
  listMarkets(cfg: KeeperConfig): Promise<readonly { label: string; address: string }[]>;
  newKey(): Hex;
  writeKeystore(key: string, password: string, path: string): Promise<string>;
  /**
   * where new keystores go; by default `keys/` next to the config, so that the config, its .env, the
   * keystore and the state all live in one directory (the one a container mounts at /config)
   */
  keysDir?: string;
}

async function rpcChainId(url: string): Promise<number> {
  const rpc = new JsonRpc(url, { retries: 1 });
  const id = await rpc.request({ method: "eth_chainId" });
  const n = typeof id === "string" ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`eth_chainId answered ${JSON.stringify(id)}`);
  return n;
}

async function priceCheck(endpoint: string, token: string | null): Promise<string> {
  // One request to the request API: no stream is opened, so no WebSocket is needed here.
  const pro = new ProClient({ ...priceEndpoints(PricesConfig.parse({ endpoint })), token });
  try {
    const p = (await pro.latest([ETH_USD_FEED]))[0];
    if (!p) throw new Error("the endpoint served no ETH/USD print");
    return `ETH/USD print ${groupedFixed(Number(p.price) * 10 ** p.expo, 2)}`;
  } finally {
    await pro.close();
  }
}

function defaults(): WizardDeps {
  return {
    prompts: inquirerPrompts,
    out: consoleOutput,
    isTTY: Boolean(process.stdin.isTTY),
    chainId: rpcChainId,
    priceCheck,
    listMarkets: async (cfg) => (await import("../keeper/engine.js")).listMarkets(cfg),
    newKey,
    writeKeystore,
  };
}

// ---- small helpers ----

type Checked<T> = { value: T; error: null } | { value: null; error: string };

/** Run a check; its error as one line instead of a throw. */
async function check<T>(fn: () => Promise<T>): Promise<Checked<T>> {
  try {
    return { value: await fn(), error: null };
  } catch (e) {
    return { value: null, error: errorText(e) || (e instanceof Error ? e.name : "Error") };
  }
}

const digits: Validate = (s) => /^\d+$/.test(s.trim()) || "enter a whole number";
const nonEmpty: Validate = (s) => s.trim().length > 0 || "enter a URL";
const usdAmount: Validate = (s) => /^(?:\.\d+|\d+(?:\.\d*)?)$/.test(s.trim()) || "enter an amount in USD, such as 0.05";
const anAddress: Validate = (s) => isAddress(s.trim()) || "not an address";
const aToken: Validate = (s) => s.trim().length > 0 || "enter the token";
const aProKey: Validate = (s) => s.trim().length > 0 || "enter your Pyth Pro API key: Pyth's own endpoints serve prices to no one without one";
/** A Pyth Pro compatible endpoint's URL: the token is sent there, so a Hermes service is refused. */
const aPriceUrl: Validate = (s) => (nonEmpty(s) === true ? (hermesEndpointProblem("prices.endpoint", s) ?? true) : nonEmpty(s));
const aKey: Validate = (s) => {
  try {
    void new LocalSigner(s.trim());
    return true;
  } catch (e) {
    return errorText(e);
  }
};

/**
 * `s` as a YAML scalar: plain when YAML reads it back as the same string (`BTC/USD`, a path), else
 * double-quoted (JSON's escapes are a subset of YAML's). `flow` is for an item of `[a, b]`.
 */
export function yamlScalar(s: string, flow = false): string {
  if (s && s.trim() === s && !/[\r\n\t]/.test(s)) {
    try {
      const doc = parseYaml(flow ? `k: [${s}]` : `k: ${s}`, { logLevel: "silent" }) as { k?: unknown } | null;
      const v = flow ? (Array.isArray(doc?.k) && doc.k.length === 1 ? doc.k[0] : undefined) : doc?.k;
      if (v === s) return s;
    } catch {
      // not safe as a plain scalar
    }
  }
  return JSON.stringify(s);
}

/**
 * A .env value that dotenv reads back unchanged: as given when that is safe (the usual case), else
 * quoted, because dotenv cuts an unquoted value at `#`, trims it, and strips quotes around it.
 */
export function envValue(v: string): string {
  if (/^[^#'"`\\$\r\n]*$/.test(v) && v.trim() === v) return v;
  if (!/[\r\n]/.test(v)) {
    if (!v.includes("'")) return `'${v}'`;
    if (!v.includes('"') && !v.includes("\\") && !v.includes("$")) return `"${v}"`;
    if (!v.includes("`")) return "`" + v + "`";
  }
  return v;
}

/**
 * Merge `values` into the .env at `path`: every `NAME=value` line already
 * there is kept as written (comments are not), the new values replace or follow them, and the file is
 * owner-only (0600) where the OS has POSIX permissions, before and after the secrets go in.
 */
export function writeEnv(path: string, values: ReadonlyMap<string, string>): void {
  const merged = new Map<string, string>();
  if (existsSync(path)) {
    for (const ln of readFileSync(path, "utf8").split(/\r?\n/)) {
      const i = ln.indexOf("=");
      if (i >= 0 && !ln.trimStart().startsWith("#")) merged.set(ln.slice(0, i).trim(), ln.slice(i + 1));
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // not every filesystem has POSIX permissions
    }
  }
  for (const [k, v] of values) merged.set(k, envValue(v));
  writeFileSync(path, [...merged].map(([k, v]) => `${k}=${v}\n`).join(""), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // as above
  }
}

/** The first of default.json, default-2.json, … that does not exist yet in `dir`. */
function freeKeystorePath(dir: string): string {
  let path = join(dir, "default.json");
  for (let i = 2; existsSync(path); i++) path = join(dir, `default-${i}.json`);
  return path;
}

// ---- the wizard ----

/**
 * Ask for the network, RPC, subgraph, price endpoint, wallet, jobs and markets, checking each answer,
 * then write the config at `configPath` and a `.env` beside it. Secrets, and every URL typed in (which
 * may carry a provider's key), go to the .env only; the YAML refers to them as ${NAME}. A new keystore
 * goes to `keys/` beside the config, and `state.dir` is `state/` beside it, both as absolute paths: one
 * directory then holds everything the keeper keeps (in a container, the one mounted at /config).
 */
export async function runWizard(configPath: string, deps: Partial<WizardDeps> = {}): Promise<void> {
  const d: WizardDeps = { ...defaults(), ...deps };
  if (!d.isTTY) {
    throw new CliExit(2, "init needs an interactive terminal. Copy bazaar-keeper.example.yaml and edit it instead.");
  }
  const state = { keystore: "" };
  try {
    await wizard(configPath, d, state);
  } catch (e) {
    if (!isPromptExit(e)) throw e;
    d.out.out(
      state.keystore
        ? `Setup cancelled; the config was not written (the new keystore at ${state.keystore} is kept).`
        : "Setup cancelled; nothing was written.",
    );
    throw new CliExit(1);
  }
}

async function wizard(configPath: string, d: WizardDeps, state: { keystore: string }): Promise<void> {
  const p = d.prompts;
  const say = (s: string): void => d.out.out(s);
  if (existsSync(configPath) && !(await p.confirm({ message: `${configPath} exists. Replace it?`, default: false }))) return;
  const env = new Map<string, string>();
  const setEnv = (name: string, value: string): string => {
    env.set(name, value);
    return "${" + name + "}";
  };
  const lines: string[] = ["# Written by bazaar keeper init. Secrets live in .env next to this file.", ""];
  // Absolute, as loadConfig resolves the config, so the paths written do not depend on the directory
  // the keeper is later started from.
  const cfgDir = dirname(resolve(expandHome(configPath)));

  // ---- network ----
  const net = await p.select({
    message: "Network",
    choices: [
      { name: "Arbitrum Sepolia (testnet)", value: "arbitrum-sepolia" },
      { name: "Arbitrum One", value: "arbitrum-one" },
      { name: "Local Anvil", value: "anvil" },
      { name: "Custom factory address", value: "custom" },
    ],
  });
  lines.push(`network: ${net}`);
  const preset = NETWORKS[net];
  const chainId = preset ? preset.chainId : Number((await p.input({ message: "Chain id", validate: digits })).trim());
  if (net === "custom") lines.push(`chainId: ${chainId}`);
  let factory: string | null = null;
  if (net === "custom" || (preset && preset.factory === null)) {
    factory = getAddress((await p.input({ message: "Factory address", validate: anAddress })).trim());
    lines.push(`factory: "${factory}"`);
    if (net === "custom") {
      const sb = (
        await p.input({
          message: "The factory's deployment block (leave empty to have the keeper find it)",
          default: "",
          validate: (v: string) => v.trim() === "" || digits(v),
        })
      ).trim();
      if (sb !== "") lines.push(`startBlock: ${sb}`);
    }
  }

  // ---- RPC ----
  let url: string;
  for (;;) {
    url = (
      await p.input({ message: "RPC URL (HTTPS)", default: net === "anvil" ? "http://127.0.0.1:8545" : undefined, validate: nonEmpty })
    ).trim();
    const r = await check(() => d.chainId(url));
    if (r.error !== null) {
      say(`${FAIL()} ${r.error}`);
      continue;
    }
    if (r.value !== chainId) {
      say(`${FAIL()} that RPC is on chain ${r.value}, not ${chainId}`);
      continue;
    }
    say(`${OK()} chain ${r.value}`);
    break;
  }
  lines.push("", "rpc:", `  http: ${setEnv("RPC_HTTP_URL", url)}`);
  if (preset?.sendUrl && (await p.confirm({ message: "Submit transactions straight to the sequencer (lower latency)?", default: true }))) {
    lines.push("  send: sequencer");
  }

  // ---- subgraph ----
  const sgChoices: PromptChoice<string>[] = [
    { name: "None: index from chain logs (slower first start)", value: "none" },
    { name: "Custom URL", value: "custom" },
  ];
  if (preset?.subgraphUrl) sgChoices.unshift({ name: "Bazaar's subgraph for this network", value: "default" });
  let sg = await p.select({ message: "Subgraph", choices: sgChoices });
  if (sg === "custom") {
    // Like the RPC URL, a custom URL lives in .env: hosted indexers carry their key in it.
    sg = setEnv("SUBGRAPH_URL", (await p.input({ message: "Subgraph GraphQL URL", validate: nonEmpty })).trim());
  }
  lines.push("", "subgraph:", `  url: ${sg}`);

  // ---- prices ----
  const pchoice = await p.select({
    message: "Price endpoint (Pyth Pro)",
    choices: [
      { name: "Pyth Pro, with my Pyth Pro API key", value: "pyth" },
      { name: "Custom Pyth Pro compatible URL (bazaar mock-prices, a proxy)", value: "custom" },
    ],
  });
  lines.push("", "prices:");
  let token: string | null = null;
  let endpoint: string;
  // Pyth's own endpoints serve prices only to the holder of a Pyth Pro API key, and the config refuses
  // to load without one, so the key is asked for wherever the endpoint is Pyth's.
  const proKey = async (): Promise<string> => (await p.password({ message: "Pyth Pro API key", validate: aProKey })).trim();
  if (pchoice === "pyth") {
    token = await proKey();
    endpoint = "pyth";
    lines.push("  endpoint: pyth", `  token: ${setEnv("PYTH_PRO_TOKEN", token)}`);
  } else {
    endpoint = (
      await p.input({ message: "Price endpoint URL", default: net === "anvil" ? "http://127.0.0.1:8787" : undefined, validate: aPriceUrl })
    ).trim();
    lines.push(`  endpoint: ${setEnv("PRICE_ENDPOINT_URL", endpoint)}`);
    if (missingProKey(PricesConfig.parse({ endpoint })) !== null) {
      token = await proKey();
      lines.push(`  token: ${setEnv("PYTH_PRO_TOKEN", token)}`);
    } else if (await p.confirm({ message: "Does it need an access token?", default: false })) {
      token = (await p.password({ message: "Access token", validate: aToken })).trim();
      lines.push(`  token: ${setEnv("PRICE_TOKEN", token)}`);
    }
  }
  const pr = await check(() => d.priceCheck(endpoint, token));
  say(pr.error === null ? `${OK()} ${pr.value}` : `${WARN()} could not read a print yet: ${pr.error}`);

  // ---- wallet ----
  const wchoice = await p.select({
    message: "Keeper wallet",
    choices: [
      { name: "Create a new wallet", value: "new" },
      { name: "Import a private key", value: "import" },
      { name: "Use an existing keystore file", value: "keystore" },
      { name: "No wallet: watch-only, nothing is sent", value: "none" },
    ],
  });
  if (wchoice !== "none") {
    let path: string;
    let chosen: string | null = null;
    if (wchoice === "keystore") {
      path = resolve(
        expandHome((await p.input({ message: "Keystore file", validate: (s) => existsSync(expandHome(s.trim())) || "no such file" })).trim()),
      );
    } else {
      path = freeKeystorePath(resolve(expandHome(d.keysDir ?? join(cfgDir, "keys"))));
      const k = wchoice === "new" ? d.newKey() : (await p.password({ message: "Private key (hex)", validate: aKey })).trim();
      let pw: string;
      for (;;) {
        pw = await p.password({ message: "Choose a keystore password" });
        if (pw && pw === (await p.password({ message: "Repeat it" }))) break;
        say(c.red("The passwords did not match."));
      }
      const addr = await d.writeKeystore(k, pw, path);
      state.keystore = path;
      say(`${OK()} ${addr} encrypted at ${path}. Fund it with a little ETH for gas.`);
      chosen = pw;
    }
    lines.push("", "wallets:", "  default:", "    type: keystore", `    path: ${yamlScalar(path)}`);
    // Asked for a new keystore too: whether its password sits in a file is the keeper's choice.
    if (await p.confirm({ message: "Store the keystore password in .env (otherwise you are asked at every start)?", default: true })) {
      env.set("KEEPER_KEYSTORE_PASSWORD", chosen ?? (await p.password({ message: "Keystore password" })));
      lines.push("    password: ${KEEPER_KEYSTORE_PASSWORD}");
    }
  }

  // ---- jobs and markets ----
  const picked = await p.checkbox({
    message: "Jobs to run automatically",
    choices: JOB_CHOICES.map(([value, title, note]) => ({ name: `${title.padEnd(24)} ${note}`, value, checked: value !== "sweepExpired" })),
  });
  // Chosen markets are written as addresses, each with its label as a comment: labels are not unique
  // (a market relisted after a termination, a composite named after its base) and not verified.
  let markets: { label: string; address: string }[] = [];
  if (picked.some((j) => j !== "collect")) {
    // In memory only: the market listing needs the URL and key themselves.
    const tmp: Record<string, unknown> = { network: net, rpc: { http: url }, prices: { endpoint, token }, subgraph: { url: "none" } };
    if (factory) tmp.factory = factory;
    if (net === "custom") tmp.chainId = chainId;
    const found = await check(() => d.listMarkets(parseConfig(tmp)));
    const byAddress = new Map<string, { label: string; address: string }>();
    for (const m of found.value ?? []) {
      if (!isAddress(m.address, { strict: false })) continue;
      const address = getAddress(m.address);
      byAddress.set(address, { label: safeLabel(m.label) || address.slice(0, 10), address });
    }
    markets = [...byAddress.values()].sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : x.address < y.address ? -1 : 1));
    if (found.error !== null) say(`${WARN()} could not list markets (${found.error}); every job will run on all markets`);
  }
  const width = Math.min(24, Math.max(0, ...markets.map((m) => m.label.length)));
  const labelOf = new Map(markets.map((m) => [m.address, m.label]));
  let lossy: JobName[] = [];
  let maxLoss = "";
  let budget = "";
  const mayLose = JOB_CHOICES.filter(([j]) => picked.includes(j) && j !== "collect" && j !== "sweepExpired");
  if (
    mayLose.length &&
    (await p.confirm({
      message: "Should any job also send calls that cost more than they earn (for protocol safety or as a public service)?",
      default: false,
    }))
  ) {
    lossy = await p.checkbox({ message: "Which jobs may take losses", choices: mayLose.map(([value, title]) => ({ name: title, value })) });
    maxLoss = (await p.input({ message: "Largest loss per call, in USD", default: "0.05", validate: usdAmount })).trim();
    budget = (await p.input({ message: "Daily loss budget per job, in USD", default: "1", validate: usdAmount })).trim();
  }
  lines.push("", "jobs:");
  let previous: "all" | string[] | null = null;
  for (const [jobKey, title] of JOB_CHOICES) {
    if (!picked.includes(jobKey)) continue;
    const body: string[] = [];
    if (jobKey !== "collect" && markets.length) {
      const opts: PromptChoice<string>[] = [
        { name: "All markets, including future listings", value: "all" },
        { name: "Choose markets…", value: "choose" },
      ];
      if (previous !== null) opts.unshift({ name: "Same as the previous job", value: "same" });
      const pick = await p.select({ message: `Markets for ${title}`, choices: opts });
      let scope: "all" | string[] = "all";
      if (pick === "same" && previous !== null) scope = previous;
      else if (pick === "choose") {
        const chosen = await p.checkbox({
          message: `Markets for ${title}`,
          choices: markets.map((m) => ({ name: `${m.label.padEnd(width)}  ${m.address}`, value: m.address })),
        });
        scope = chosen.length ? chosen : "all";
      }
      previous = scope;
      if (scope === "all") body.push("    markets: all");
      else body.push("    markets:", ...scope.map((a) => `      - "${a}"  # ${labelOf.get(a) ?? ""}`.trimEnd()));
    }
    if (jobKey === "collect") {
      const t = await p.input({ message: "Collect when a market's balance reaches (USD)", default: "5", validate: usdAmount });
      body.push(`    thresholdUsd: ${t.trim()}`);
      const fwd = (
        await p.input({
          message: "Forward collected USDC to another address (optional)",
          default: "",
          validate: (s) => !s.trim() || anAddress(s),
        })
      ).trim();
      if (fwd) body.push(`    forwardTo: "${getAddress(fwd)}"`);
    }
    if (lossy.includes(jobKey)) body.push("    allowLoss: true", `    maxLossUsdPerCall: ${maxLoss}`, `    lossBudgetUsdPerDay: ${budget}`);
    // A key with nothing under it would read as null, which turns the job off.
    lines.push(body.length ? `  ${jobKey}:` : `  ${jobKey}: {}`, ...body);
  }
  if (!picked.length) lines.push("  {}");
  lines.push("", "# The snapshot, the earnings ledger and the status file, so a restart resumes where it stopped.");
  lines.push("state:", `  dir: ${yamlScalar(join(cfgDir, "state"))}`);

  // ---- write ----
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, lines.join("\n") + "\n", "utf8");
  const envPath = join(dirname(configPath), ".env");
  writeEnv(envPath, env);
  say(`${OK()} wrote ${configPath} and ${envPath} (secrets only in .env)`);
  say(`Next: ${c.bold("bazaar keeper doctor")}, then ${c.bold("bazaar keeper start")}`);
}
