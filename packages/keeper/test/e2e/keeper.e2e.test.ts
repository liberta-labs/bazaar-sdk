/**
 * End-to-end: replay a Bazaar deployment on Anvil, build the ETH/USD market, and run the real keeper
 * against it.
 *
 * The keeper runs in this process with every automatic job enabled, prices streamed from the mock
 * Pyth Pro server (its updates signed with the test key the local verifier trusts, and checked
 * against that verifier by the keeper), no subgraph (it indexes from logs) and Anvil's eighth account
 * as its wallet. Each step moves the price or the clock to give one job its work and checks the
 * result on chain. The steps share one chain and one keeper, so they run in order and each builds on
 * the last.
 *
 * It also measures how fast the keeper reacts to a price move: from the moment the mock's price
 * changes, to the keeper receiving the print, to its "sent" event for the trigger and liquidation
 * transactions. The mock streams on fixed_rate@200ms, so up to an interval of the first leg is the
 * mock's cadence, not the keeper. Each move waits first until the chain's clock has passed the
 * second of the pair's stored price: a call carrying a print from that second is judged at the
 * stored price (the pair keeps the first price of a second), so the keeper plans the move only on
 * the next second's print, for any sender.
 *
 *     anvil --port 8546 --block-time 1 --base-fee 10000000 --code-size-limit 100000
 *     npx vitest run -c vitest.e2e.config.ts packages/keeper/test/e2e/keeper.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMIT } from "@liberta-labs/bazaar-sdk";
import { Keeper, MockPro, type MockProServer, findOpportunities, parseConfig, setupLogging, startMockPro } from "../../src/index.js";
import type { Entry } from "../../src/exec/ledger.js";
import { Anvil, E18, FEED, LENS, PAIR, Scenario, clientVersion, deploy, keys, waitUntil } from "./chain.js";

const RPC = process.env.BAZAAR_E2E_RPC ?? "http://127.0.0.1:8546";
const BROADCAST = fileURLToPath(new URL("./fixtures/deployment.json", import.meta.url));
const ARBSYS_ARTIFACT = fileURLToPath(new URL("./fixtures/MockArbSys.json", import.meta.url));

const version = await clientVersion(RPC);
const anvilUp = version !== null && version.toLowerCase().startsWith("anvil");
if (!anvilUp) console.warn(`e2e: no Anvil answers at ${RPC} (${version ?? "no answer"}); skipping`);

/** Poll `fn` until it returns something truthy; null after `timeout` seconds (run_e2e's `wait`). */
async function wait<T>(fn: () => T | Promise<T>, timeout: number, what: string, every = 0.5): Promise<NonNullable<T> | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout * 1000) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
  console.log(`      (timed out after ${timeout}s waiting for ${what})`);
  return null;
}

function entries(keeper: Keeper, job: string, status = "confirmed"): Entry[] {
  return keeper.ledger.entries.filter((e) => e.job === job && e.status === status);
}

/** The job's confirmed ledger entries, once the keeper has read the receipt. */
async function recorded(keeper: Keeper, job: string, timeout = 30): Promise<Entry[]> {
  return (await wait(() => (entries(keeper, job).length ? entries(keeper, job) : null), timeout, `${job} in the ledger`, 0.25)) ?? [];
}

const usd = (xs: readonly Entry[], f: (e: Entry) => number = (e) => e.rewardUsd) => xs.reduce((s, e) => s + f(e), 0);

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  expect(ok, `${name}${detail ? `: ${detail}` : ""}`).toBe(true);
}

interface Latency {
  what: string;
  /** ms from the price move to the keeper holding a print at the new price */
  toPrint: number | null;
  /** ms from that print to the keeper's "sent" event */
  printToSent: number | null;
  /** ms from the price move to the "sent" event */
  total: number | null;
}

describe.skipIf(!anvilUp)(`keeper end to end on ${version}`, () => {
  const anvil = new Anvil(RPC);
  let snap: Hex | null = null;
  let sc: Scenario;
  let mock: MockPro;
  let srv: MockProServer | null = null;
  let keeper: Keeper | null = null;
  let task: Promise<void> | null = null;
  let stateDir = "";
  let liq = 0;
  const sent: { job: string; txHash: Hex; at: number }[] = [];
  const latencies: Latency[] = [];

  /**
   * Wait until the latest block is past the second of the pair's stored price. A call carrying a
   * print from that second (or an earlier one) is judged at the stored price, so a move made before
   * then takes effect only with a later second's print, whoever sends. Waiting first makes the latency
   * below the keeper's own, not that rule's.
   */
  async function storedPriceBehind(): Promise<void> {
    const p = PAIR.decode<{ updateTs: bigint }>("lastPairPrice", await anvil.call(sc.pair, PAIR.encode("lastPairPrice")));
    await waitUntil(async () => (await anvil.latest())[1] > Number(p.updateTs), {
      timeout: 30,
      every: 0.1,
      what: "the chain to pass the stored price's second",
    });
  }

  /** Move the mock's price and time how long the keeper takes to send `job`'s transaction. */
  function timeMove(job: string, usdPrice: number, what: string): () => Latency {
    const k = keeper!;
    const target = BigInt(Math.round(usdPrice * 1e8));
    let printAt: number | null = null;
    const off = k.prices.onPrints(() => {
      const p = k.prices.latest.get(FEED);
      if (printAt === null && p && p.price === target) printAt = p.received * 1000;
    });
    const t0 = performance.now();
    mock.setPrice(FEED, usdPrice);
    sc.price = usdPrice; // the scenario's own calls carry the price the market now trades at
    return () => {
      off();
      const s = sent.find((x) => x.job === job && x.at >= t0);
      const l: Latency = {
        what,
        toPrint: printAt === null ? null : printAt - t0,
        printToSent: printAt === null || !s ? null : s.at - printAt,
        total: s ? s.at - t0 : null,
      };
      latencies.push(l);
      const ms = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(0)} ms`);
      console.log(`      latency ${what}: move -> print ${ms(l.toPrint)}, print -> sent ${ms(l.printToSent)}, move -> sent ${ms(l.total)}`);
      return l;
    };
  }

  beforeAll(async () => {
    snap = await anvil.snapshot();
    console.log("-- replaying the deployment");
    const names = await deploy(anvil, BROADCAST, ARBSYS_ARTIFACT);
    console.log(`   factory ${names.BazaarFactory}`);
    sc = new Scenario(anvil, names);
    console.log("-- building the market");
    await sc.setup((line) => console.log(line));

    mock = new MockPro({ rpc: RPC, prices: { [FEED]: 2000.0 }, symbols: { [FEED]: "Crypto.ETH/USD" } });
    await mock.sync();
    srv = await startMockPro(mock, { port: 0 });
    stateDir = mkdtempSync(join(tmpdir(), "bazaar-keeper-e2e-"));
    const cfg = parseConfig({
      network: "anvil",
      factory: names.BazaarFactory,
      rpc: { http: RPC, maxRequestsPerSecond: 200 },
      subgraph: { url: "none" },
      prices: { endpoint: srv.url, sendMarginSeconds: 0.5 },
      wallets: { default: { type: "privateKey", key: keys()[7] } },
      jobs: {
        liquidation: {},
        triggers: {},
        unload: { recheckSeconds: 2 },
        adl: {},
        refresh: {},
        terminalSettlement: { finalizeMaxCostUsd: 1.0 },
        sweepExpired: { minBatch: 1 },
        collect: { thresholdUsd: 0.01, intervalSeconds: 3 },
      },
      budget: { minEthBalance: 0.001 },
      state: { dir: stateDir },
      engine: { tickSeconds: 0.5, idleRefreshSeconds: 1.5, simCooldownSeconds: 1.0 },
      log: { level: "info" },
    });
    setupLogging("info");
    keeper = await Keeper.create(cfg);
    keeper.on("sent", ([a, h]) => {
      sent.push({ job: a.job, txHash: h, at: performance.now() });
    });
    task = keeper.start();
    task.catch((e: unknown) => console.log(`keeper.start failed: ${String(e)}`));
  });

  afterAll(async () => {
    try {
      if (keeper) {
        console.log("-- earnings");
        for (const [job, v] of Object.entries(keeper.ledger.summary(0))) {
          console.log(
            `   ${job.padEnd(20)} calls ${String(v.calls).padStart(2)}  earned $${v.reward.toFixed(4)}  gas $${v.cost.toFixed(6)}  claimed $${v.claimed.toFixed(2)}`,
          );
        }
        if (latencies.length) {
          console.log("-- keeper latency (price move -> sent)");
          for (const l of latencies) {
            const ms = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(0)} ms`);
            console.log(`   ${l.what.padEnd(12)} move->print ${ms(l.toPrint)}  print->sent ${ms(l.printToSent)}  total ${ms(l.total)}`);
          }
        }
        await keeper.stop({ collect: false });
        await task?.catch(() => undefined);
        await keeper.close();
      }
    } finally {
      await srv?.close();
      if (snap) await anvil.revert(snap);
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeper connected and indexed the market from logs", async () => {
    await wait(() => keeper!.connected, 120, "the keeper to connect");
    check("keeper connected and indexed the market from logs", keeper!.connected);
  });

  it("market labelled from feed metadata", () => {
    const m = keeper!.resolveMarket("ETH/USD");
    check("market labelled from feed metadata", m.label === "ETH/USD", m.address);
  });

  it("open positions indexed from logs match the chain", async () => {
    const m = keeper!.resolveMarket("ETH/USD");
    const onChain = new Set<string>();
    for (let i = 1; i < 7; i++) if ((await sc.bucket(i)).size) onChain.add(sc.w[i]!);
    const indexed = new Set<string>(keeper!.store.positions.get(m.address)?.keys() ?? []);
    const same = indexed.size === onChain.size && [...onChain].every((a) => indexed.has(a));
    check("open positions indexed from logs match the chain", same && onChain.size > 0, `${indexed.size} positions`);
  });

  it("trigger execution: the keeper fired the stop-loss", async () => {
    console.log("-- trigger execution");
    const stop = sc.orders["stop-loss"]!;
    await storedPriceBehind();
    const done = timeMove("triggers", 1940, "trigger");
    const o = await wait(async () => {
      const r = await sc.order(stop);
      return r.filledBlock || r.canceledBlock ? r : null;
    }, 90, "the stop-loss to fire");
    const trig = await recorded(keeper!, "triggers");
    done();
    check(
      "trigger execution: the keeper fired the stop-loss",
      o !== null && o.filledBlock !== 0 && trig.length > 0,
      trig.length ? `earned $${usd(trig).toFixed(4)} of the $1 bounty` : "",
    );
  });

  it("liquidation: the keeper seized the underwater position", async () => {
    console.log("-- liquidation");
    liq = await sc.liquidationPrice();
    await storedPriceBehind();
    const done = timeMove("liquidation", liq, "liquidation");
    const gone = await wait(async () => (await sc.bucket(6)).size === 0n, 90, "the victim's liquidation");
    const liqs = await recorded(keeper!, "liquidation");
    done();
    check(
      "liquidation: the keeper seized the underwater position",
      Boolean(gone) && liqs.length > 0,
      liqs.length ? `at ${liq}, earned $${usd(liqs).toFixed(4)}` : `at ${liq}`,
    );
  });

  it("vault unload: the keeper sold the inventory into a new bid", async () => {
    console.log("-- vault unload");
    const inv = await sc.inventory();
    if (inv) {
      await sc.create(1, LIMIT, true, inv + E18, "bid-unload", { limit: BigInt(Math.trunc(liq - 5)) * E18 });
      const done = await wait(async () => (await sc.inventory()) === 0n, 90, "the vault to unload");
      const unl = await recorded(keeper!, "unload");
      check(
        "vault unload: the keeper sold the inventory into the new bid",
        Boolean(done) && unl.length > 0,
        unl.length ? `${Number(inv) / 1e18} units, earned $${usd(unl).toFixed(4)}` : "",
      );
    } else {
      check("vault unload: nothing left after the liquidation's inline unload", true);
    }
  });

  it("price refresh: the heartbeat bounty after a quiet day", async () => {
    console.log("-- price refresh");
    await anvil.warp(86_400 + 120);
    const ref = await wait(() => (entries(keeper!, "refresh").length ? entries(keeper!, "refresh") : null), 90, "a paid refresh");
    check("price refresh: the heartbeat bounty after a quiet day", ref !== null, ref ? `earned $${ref[0]!.rewardUsd.toFixed(2)}` : "");
  });

  it("expired-order cleanup: swept as an accepted loss", async () => {
    console.log("-- expired-order cleanup");
    const life = LENS.decode<{ minOrderLifetimeBlocks: bigint }>(
      "getOrderLifetimeConstants",
      await anvil.call(sc.lens, LENS.encode("getOrderLifetimeConstants")),
    );
    const minLife = Number(life.minOrderLifetimeBlocks);
    const exp = await sc.expiry(minLife + 5);
    const oid = await sc.create(2, LIMIT, false, E18 / 2n, "ask-expiring", { limit: BigInt(Math.trunc(liq * 1.1)) * E18, exp });
    await anvil.mine(minLife + 10);
    const swept = await wait(async () => (await sc.order(oid)).canceledBlock !== 0, 90, "the expired order's sweep");
    const sw = await recorded(keeper!, "sweepExpired");
    check(
      "expired-order cleanup: swept as an accepted loss",
      Boolean(swept) && sw.length > 0 && sw[0]!.kind === "unpaid",
      sw.length ? `cost $${sw[0]!.costUsd.toFixed(6)}` : "",
    );
  });

  it("collect: earnings claimed to the keeper wallet", async () => {
    console.log("-- collect");
    const col = await wait(() => (entries(keeper!, "collect").length ? entries(keeper!, "collect") : null), 60, "a claim");
    const bal = await keeper!.reader.usdcBalance(keeper!.executor.lanes.get("default")!.address);
    check("collect: earnings claimed to the keeper wallet", col !== null && bal > 0n, `wallet holds $${(Number(bal) / 1e6).toFixed(4)} USDC`);
  });

  it("one-shot dry run reports without sending", async () => {
    console.log("-- one-shot dry run");
    const before = keeper!.ledger.entries.length;
    const res = await keeper!.run.refreshPrice("ETH/USD", { dryRun: true });
    check(
      "one-shot dry run reports without sending",
      keeper!.ledger.entries.length === before && res.length > 0 && !res[0]!.sent,
      res[0] ? `${res[0].status}: ${res[0].reason}` : "no result",
    );
  });

  it("opportunities: terminateStalePair offered", async () => {
    console.log("-- termination");
    // The feed goes quiet: its updates carry the last price forward, so nothing can refresh the pair.
    await mock.sync();
    mock.pause(FEED);
    await anvil.warp(22 * 86_400);
    const opps = await findOpportunities(keeper!);
    check(
      "opportunities: terminateStalePair offered",
      opps.some((o) => o.operation === "terminateStalePair" && o.ready),
      opps.map((o) => o.operation).join("; "),
    );
  });

  it("manual terminateStalePair sent and confirmed", async () => {
    const res = await keeper!.run.terminateStalePair("ETH/USD");
    check("manual terminateStalePair sent and confirmed", res.status === "confirmed", res.reason);
  });

  it("terminal settlement: positions settled and the market finalized", async () => {
    const terminated = await wait(
      async () => PAIR.decode<boolean>("isPairTerminated", await anvil.call(sc.pair, PAIR.encode("isPairTerminated"))),
      180,
      "settlement and finalize",
    );
    const settles = await recorded(keeper!, "terminalSettlement");
    check(
      "terminal settlement: positions settled and the market finalized",
      Boolean(terminated) && settles.length > 0,
      `${settles.length} call(s), earned $${usd(settles).toFixed(4)}`,
    );
  });
});
