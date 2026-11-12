/** bazaar keeper doctor: check everything `start` relies on, and say how to fix what fails. */

import { ETH_USD_FEED, type ProClient, isUrl, redactUrl } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";
import { ConfigError, type KeeperConfig, UNCHECKED_SIGNERS_WARNING, enabledJobs } from "../config/index.js";
import { enforcesProfit } from "../exec/policy.js";
import { WalletError } from "../exec/wallets.js";
import type * as Engine from "../keeper/engine.js";
import { type Output, FAIL, OK, WARN, c, consoleOutput, errorText, formatG, grouped, redactUrls } from "./format.js";

export interface DoctorOptions {
  /** The engine's Keeper class; by default imported from ../keeper/engine.js. */
  Keeper?: typeof Engine.Keeper;
  out?: Output;
}

/** Seconds the doctor waits for the price stream's first update. */
const STREAM_CHECK_SECONDS = 5;

/**
 * The shortest configured value the doctor masks, as the price client masks them: nothing shorter can
 * hold a credential, and masking a value of a character or two would garble every line.
 */
const MIN_SECRET = 4;

/**
 * Every line the doctor prints goes through this: the config's URLs masked wherever they appear (an
 * error message may quote one), then any other URL, then the config's tokens and keys and the
 * `prices.headers` values, each whole and word by word (an auth scheme, then its credential).
 */
function scrubber(cfg: KeeperConfig): (text: string) => string {
  const p = cfg.prices;
  const urls = [cfg.rpc.http, cfg.rpc.send, cfg.subgraph.url, p.endpoint, p.restUrl, p.symbolsUrl, ...(p.streamUrls ?? []), cfg.alerts.webhook?.url, cfg.alerts.discord?.webhook]
    .filter((u): u is string => typeof u === "string" && isUrl(u))
    .sort((a, b) => b.length - a.length);
  const values = [p.token, ...Object.values(p.headers), cfg.subgraph.apiKey, cfg.alerts.telegram?.botToken].filter((v): v is string => typeof v === "string");
  const keys = [...new Set(values.flatMap((v) => [v, v.trim(), ...v.trim().split(/\s+/)]))]
    .filter((k) => k.length >= MIN_SECRET)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const u of urls) if (out.includes(u)) out = out.split(u).join(redactUrl(u));
    out = redactUrls(out);
    for (const k of keys) if (out.includes(k)) out = out.split(k).join("***");
    return out;
  };
}

/**
 * Why the price stream brought no ETH/USD print within `seconds`, or null when it brought one. ETH/USD
 * is the one feed every keeper streams: it prices gas.
 */
async function streamProblem(pro: ProClient, seconds: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  let noticed = "";
  try {
    for await (const prints of pro.stream([[ETH_USD_FEED]], ctl.signal, { idleTimeout: seconds, onNotice: (m) => (noticed ||= m) })) {
      if (prints.length > 0) return null;
    }
    return noticed || `no ETH/USD print within ${seconds} s`;
  } catch (e) {
    return errorText(e);
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** Run every check; true when nothing failed (warnings allowed). */
export async function runDoctor(cfg: KeeperConfig, opts: DoctorOptions = {}): Promise<boolean> {
  const io = opts.out ?? consoleOutput;
  const scrub = scrubber(cfg);
  const line = (sym: string, name: string, msg: string): void => io.out(`${sym} ${name.padEnd(14)} ${scrub(msg)}`);
  const ok = (name: string, msg: string): void => line(OK(), name, msg);
  const warn = (name: string, msg: string): void => line(WARN(), name, msg);
  const fail = (name: string, msg: string): void => line(FAIL(), name, msg);

  const Keeper = opts.Keeper ?? (await import("../keeper/engine.js")).Keeper;
  let good = true;
  let k: Engine.Keeper;
  try {
    k = await Keeper.create(cfg);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof WalletError) {
      fail("Config", e.message);
      return false;
    }
    throw e;
  }
  try {
    // RPC
    let cid: number;
    let ms: number;
    try {
      const t0 = performance.now();
      cid = await k.chain.chainId();
      ms = performance.now() - t0;
    } catch (e) {
      // Never the raw URL: it often holds the provider's key.
      fail("RPC", `${redactUrl(cfg.rpc.http)} unreachable: ${errorText(e)}`);
      return false;
    }
    if (cid !== k.net.chainId) {
      fail("RPC", `chain ${cid}, but network ${k.net.name} is chain ${k.net.chainId}`);
      return false;
    }
    const overrides = await k.chain.supportsOverrides();
    (overrides ? ok : warn)(
      "RPC",
      `chain ${cid}, latency ${ms.toFixed(0)} ms, ` +
        (overrides
          ? "eth_call state overrides supported"
          : "no eth_call state overrides: rewards cannot be measured before sending, so paid jobs will skip"),
    );

    // Factory and wiring
    let problems: string[];
    let pairs: readonly Address[];
    try {
      const dep = await k.reader.deployment(k.net.factory);
      k.dep = dep;
      k.executor.lens = dep.lens;
      k.checkSigners();
      problems = await k.reader.wiringProblems();
      pairs = await k.reader.pairAddresses();
    } catch (e) {
      fail("Factory", `${k.net.factory}: ${errorText(e)}`);
      return false;
    }
    const label = k.net.official ? "official deployment" : c.yellow("not an official deployment");
    ok("Factory", `${k.net.factory} ${label}, ${pairs.length} market(s)`);
    if (problems.length) {
      fail("Wiring", problems.join("; "));
      good = false;
    } else {
      ok("Wiring", "lens and terminator both point back at this factory");
    }

    // Subgraph
    if (k.subgraph == null) {
      warn("Subgraph", "none configured: the first start indexes from chain logs");
    } else {
      try {
        const [n, , errors] = await k.subgraph.meta();
        const head = await k.chain.blockNumber();
        const lag = head - n;
        (errors ? warn : ok)(
          "Subgraph",
          `synced to block ${grouped(n)} (${grouped(lag)} blocks behind)` + (errors ? ", with indexing errors" : ""),
        );
      } catch (e) {
        fail("Subgraph", `${errorText(e)}; the keeper falls back to chain logs`);
      }
    }

    // Prices
    if (!cfg.prices.checkSigners) warn("Prices", UNCHECKED_SIGNERS_WARNING);
    const markets = await k.discoverMarkets();
    const feeds = new Set<Hex>([ETH_USD_FEED]);
    for (const m of markets) for (const leg of m.legs) feeds.add(leg);
    let answered = false;
    try {
      await k.prices.fetch(feeds);
      answered = true;
      await k.updateBlock();
      const priced = markets.filter((m) => k.prices.legs(m) != null);
      const closed = priced.filter((m) => !k.prices.fresh(m, null, 0)).map((m) => m.label);
      let msg = `${priced.length}/${markets.length} markets have a print`;
      if (closed.length) msg += `; ${closed.length} not fresh right now (${closed.slice(0, 5).join(", ")})`;
      (priced.length === markets.length ? ok : warn)("Prices", msg);
      if (k.prices.ethUsd() == null) {
        warn(
          "Prices",
          `no fresh, plausible ETH/USD print: gas is priced at the $${formatG(cfg.gas.ethUsdFallback)} fallback ` +
            `(never below gas.ethUsdFloor, $${formatG(cfg.gas.ethUsdFloor)})`,
        );
      }
    } catch (e) {
      fail("Prices", errorText(e));
      good = false;
    }
    // The stream is what a running keeper lives on; the request API above only backs it up.
    if (answered && cfg.prices.stream) {
      const why = await streamProblem(k.pro, STREAM_CHECK_SECONDS);
      if (why === null) ok("Prices", `the ${cfg.prices.channel} stream is delivering`);
      else {
        warn("Prices", `the ${cfg.prices.channel} stream is not delivering (${why}): the keeper would poll the request API every ${formatG(cfg.prices.pollInterval)} s instead`);
      }
    }

    // Wallets
    if (k.executor.lanes.size === 0) warn("Wallets", "none configured: watch-only, nothing will be sent");
    for (const [name, lane] of k.executor.lanes) {
      const wei = await k.chain.balance(lane.address);
      const bal = Number(wei) / 1e18;
      const fee = k.executor.baseFee || (await k.chain.gasPrice());
      const calls = fee ? wei / (fee * 600_000n) : 0n;
      if (bal < cfg.budget.minEthBalance) {
        fail(`Wallet ${name}`, `${lane.address}, ${bal.toFixed(5)} ETH: below budget.minEthBalance; fund it`);
        good = false;
      } else {
        const many = calls < 1_000_000n ? `roughly ${grouped(calls)}` : "over a million";
        ok(`Wallet ${name}`, `${lane.address}, ${bal.toFixed(5)} ETH (${many} calls at today's base fee)`);
      }
    }

    // Jobs
    const enabled = enabledJobs(cfg.jobs);
    const names = Object.keys(enabled);
    if (!names.length) warn("Jobs", "no job is enabled");
    for (const [name, j] of Object.entries(enabled)) {
      if (!j) continue;
      if (!enforcesProfit(cfg, j)) {
        warn("Jobs", `${name} has the profit rule off: it sends calls whatever they earn, held only by the daily spend caps`);
      } else if (name === "sweepExpired") {
        warn("Jobs", `sweepExpired pays nothing; its daily loss budget is $${formatG(j.lossBudgetUsdPerDay)}`);
      } else if (j.allowLoss) {
        warn("Jobs", `${name} takes losses: up to $${formatG(j.maxLossUsdPerCall)} a call, $${formatG(j.lossBudgetUsdPerDay)} a day`);
      }
    }
    try {
      k.store.markets = new Map(markets.map((m) => [m.address, m]));
      k.resolveScopes();
      ok("Jobs", names.join(", ") || "none");
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      fail("Jobs", e.message);
      good = false;
    }
  } finally {
    await k.close();
  }
  return good;
}
