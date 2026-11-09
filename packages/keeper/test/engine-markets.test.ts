/**
 * Markets from outside the keeper's control: labels several markets share (a relisting, a composite),
 * labels and subgraph rows written to mislead a terminal, a chat or a shell, and a first start whose
 * subgraph answers with something the keeper cannot read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORACLE_DEAD_THRESHOLD, SubgraphError } from "@liberta-labs/bazaar-sdk";
import type { Hex } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Action, ActionResult } from "../src/exec/executor.js";
import type { Keeper } from "../src/keeper/engine.js";
import { findOpportunities } from "../src/keeper/ops/opportunities.js";
import { setupLogging } from "../src/observe/index.js";
import { Effects } from "../src/state/store.js";
import { FEED, FEED2, fake, marketAt, marketState } from "./keeper-harness.js";

const logged: string[] = [];
beforeAll(() => {
  setupLogging("warning", "json", (line) => logged.push(line));
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-markets-"));
  logged.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The engine's private parts these tests drive. */
type Inside = {
  label(markets: unknown[], descriptions?: unknown): Promise<void>;
  bootstrapIndex(): Promise<void>;
  registerNew(addresses: readonly string[], fromBlock: number): Promise<void>;
  subgraph: unknown;
};
const inside = (k: Keeper): Inside => k as unknown as Inside;

const warnings = (): string[] => logged.map((l) => (JSON.parse(l) as { msg: string }).msg);

describe("labels several markets share", () => {
  it("cover every market carrying them, each job acting in its own statuses, with one warning", () => {
    const f = fake(dir, {
      jobs: { liquidation: { markets: ["BTC/USD"] }, terminalSettlement: { markets: ["btc/usd"] }, triggers: { exclude: ["BTC/USD"] } },
    });
    const old = marketAt(2);
    old.label = "BTC/USD";
    old.state = marketState(f.now, { settlementFixedTs: f.now - 100, terminated: true });
    f.k.store.addMarket(old);
    f.k.resolveScopes();
    expect(warnings()).toEqual([]);

    // Relisted after the termination: the same label.
    const relisted = marketAt(3);
    relisted.label = "BTC/USD";
    relisted.state = marketState(f.now);
    f.k.store.addMarket(relisted);
    f.k.resolveScopes();
    f.k.resolveScopes(); // warned once, not on every resolve

    const [liq, settle, trig] = ["liquidation", "terminalSettlement", "triggers"].map((n) => f.k.jobs.get(n)!);
    expect(liq!.scope).toEqual(new Set([old.address, relisted.address]));
    // The live market is the one liquidation acts on; settlement still reaches the terminated one.
    expect([liq!.runnable(relisted), liq!.runnable(old), liq!.runnable(f.m)]).toEqual([true, false, false]);
    expect([settle!.runnable(old), settle!.runnable(relisted)]).toEqual([true, false]);
    expect([trig!.runnable(old), trig!.runnable(relisted), trig!.runnable(f.m)]).toEqual([false, false, true]);
    expect(warnings()).toEqual(
      // in the order the jobs run
      ["jobs.liquidation.markets: 'BTC/USD'", "jobs.triggers.exclude: 'BTC/USD'", "jobs.terminalSettlement.markets: 'btc/usd'"].map(
        (at) =>
          `${at} names 2 markets (${old.address}, ${relisted.address}); it covers each of them, in the statuses each job runs in. ` +
          "Write an address to choose one",
      ),
    );
    // A one-shot call names one market: there the label stays ambiguous.
    expect(() => f.k.resolveMarket("BTC/USD")).toThrow(/matches several markets .*; use an address/);
  });

  it("a new listing never stops the keeper: the scopes stay as they were when they cannot be resolved", async () => {
    const f = fake(dir, { jobs: { liquidation: { markets: ["ETH/USD"] } } });
    f.k.resolveScopes();
    const liq = f.k.jobs.get("liquidation")!;
    (liq.cfg.markets as string[]).push("GONE/USD"); // a name that no longer resolves
    const listed = marketAt(4);
    f.k.reader.describe = async () => [listed];
    inside(f.k).label = async () => {};
    const scans: number[][] = [];
    f.k.tail = { scan: async (from: number, to: number) => (scans.push([from, to]), new Effects()) } as never;
    await inside(f.k).registerNew([listed.address], 900);
    expect(f.k.store.markets.has(listed.address)).toBe(true);
    expect(scans).toEqual([[900, f.k.store.head]]);
    expect(liq.scope).toEqual(new Set([f.m.address]));
    expect(warnings()).toEqual([
      "the jobs' markets were not updated for the new listing: no market called 'GONE/USD'. Markets: ETH/USD, M4",
    ]);
  });
});

describe("names from outside", () => {
  it("labels are cleaned of control characters, shell metacharacters and mentions where they are made", async () => {
    const f = fake(dir);
    f.k.hermes.priceFeeds = async () => [{ id: FEED.slice(2), attributes: { symbol: "Crypto.BTC/USD\x1b[2J; rm -rf ~ @everyone" } }] as never;
    const a = marketAt(5, [FEED]);
    const b = marketAt(6, [FEED2]); // no symbol: labelled by its description
    b.description = "Gold`id`\n#spot";
    const c = marketAt(7, [FEED2]);
    c.description = "‮\x07";
    await inside(f.k).label([a, b, c]);
    expect(a.label).toBe("BTC/USD 2J rm -rf everyone");
    expect(b.label).toBe("Goldid spot");
    expect(c.label).toBe(c.address.slice(0, 10)); // nothing printable left
  });

  it("suggested commands name markets by address and carry only ids checked to be ids", async () => {
    const f = fake(dir);
    f.addWallet();
    f.k.connected = true;
    f.k.updateBlock = async () => {};
    f.k.syncStep = async () => {};
    f.k.readStates = async () => {};
    f.k.prices.fetch = async () => {};
    f.k.executor.run = async (a: Action) =>
      new ActionResult({ status: "simulated", job: a.job, market: a.market?.label ?? "", summary: a.summary, reason: "test" });
    f.k.chain.call = async () => `0x${"00".repeat(96)}` as Hex;
    // A stale oracle, on a market whose label reads like a command.
    f.m.label = "ETH/USD; curl x | sh";
    f.m.state = marketState(f.now, { updateTs: f.now - ORACLE_DEAD_THRESHOLD - 60 });
    const good = `0x${"ab".repeat(32)}`;
    inside(f.k).subgraph = {
      proposals: async () => ({
        terminationProposals: [
          { id: `${good}; rm -rf ~`, pair: { id: f.m.address }, livenessEndsAt: "0" },
          { id: good, pair: { id: f.m.address }, livenessEndsAt: "0" },
        ],
        insurerProposals: [{ id: good, pair: { id: "$(reboot)" } }, null],
        listingProposals: [{ id: good, pairId: good, description: "Evil\x1b[2J @everyone", livenessEndsAt: "0" }, { id: "x", pairId: good, livenessEndsAt: "0" }],
      }),
      close: async () => {},
    };
    const found = await findOpportunities(f.k);
    expect(found.map((o) => [o.operation, o.market, o.command])).toEqual([
      ["terminateStalePair", "ETH/USD curl x sh", `run terminate-stale --market ${f.m.address}`],
      ["settleTerminationProposal", "ETH/USD curl x sh", `run settle-termination --assertion ${good}`],
      ["settleDeploymentProposal", "Evil 2J everyone", `run settle-listing --assertion ${good}`],
      ["expireStuckDeploymentProposal", "Evil 2J everyone", `run expire-listing --pair-id ${good}`],
    ]);
    for (const o of found) expect(o.describe()).not.toMatch(/[\x00-\x1f;|&$`]/);
  });
});

describe("first start", () => {
  it("indexes from chain logs whatever the subgraph fails with, not only a SubgraphError", async () => {
    const failures: [string, Error][] = [
      ["descriptions", new TypeError("Cannot read properties of null (reading 'description')")],
      ["pages", new SyntaxError("Unexpected token < in JSON at position 0")],
      ["pages", new SubgraphError("subgraph returned HTTP 503: busy")],
    ];
    for (const [where, err] of failures) {
      const f = fake(dir);
      const scans: number[][] = [];
      inside(f.k).label = async () => {};
      f.k.tail = { scan: async (from: number, to: number) => (scans.push([from, to]), new Effects()) } as never;
      f.k.chain.block = async () => ({ number: 1_000, hash: `0x${"cd".repeat(32)}`, timestamp: f.now, baseFee: 1n }) as never;
      inside(f.k).subgraph = {
        meta: async () => [900, `0x${"00".repeat(32)}`, false],
        descriptions: async () => {
          if (where === "descriptions") throw err;
          return new Map();
        },
        pages: async () => {
          throw err;
        },
        close: async () => {},
      };
      await inside(f.k).bootstrapIndex();
      expect(scans, err.message).toEqual([[f.k.net.startBlock, 1_000]]);
      expect(f.k.store.head).toBe(1_000);
      expect(f.k.store.headHash).toBe(`0x${"cd".repeat(32)}`);
      expect(warnings().at(-1)).toBe(`subgraph unavailable (${err.message}); indexing from chain logs instead`);
    }
  });
});
