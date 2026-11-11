import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain, JsonRpc, type ProbeResult, type RawLog, type Receipt, RpcError, SendError, pair } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, keccak256, pad, parseTransaction, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { Action, Executor, Lane, Mutex, lockKey } from "../src/exec/executor.js";
import { DAY, Entry, Ledger, entryFromLine } from "../src/exec/ledger.js";
import { LocalSigner } from "../src/exec/wallets.js";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ME: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PAIR: Address = "0x1111111111111111111111111111111111111111";
const LENS: Address = "0x2222222222222222222222222222222222222222";
const TARGET: Address = "0x3333333333333333333333333333333333333333";
const PAIR_ID = pad("0x01");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bazaar-exec-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (ts: number, costUsd: number, kind = "profit", job = "liquidation", rewardUsd = 0) =>
  new Entry({ ts, job, market: "ETH/USD", wallet: ME, tx: "0x", status: "confirmed", kind, costUsd, rewardUsd });

describe("ledger", () => {
  it("appends one snake_case JSON line per entry and reads it back", () => {
    const path = join(dir, "state", "ledger.jsonl");
    const l = new Ledger(path);
    l.record(new Entry({ ...entry(1_731_000_000.25, 0.0123, "unpaid", "terminalSettlement"), gasUsed: 123_456n, extra: { big: 2n ** 70n } }));
    l.record(entry(1_731_000_001, 0.5));
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(lines[0]).toContain('"cost_usd": 0.0123');
    expect(lines[0]).toContain('"gas_used": 123456');
    expect(lines[0]).toContain('"big": 1180591620717411303424');
    const again = new Ledger(path);
    expect(again.entries).toHaveLength(2);
    expect(again.entries[0]!.gasUsed).toBe(123_456n);
    expect(again.entries[0]!.job).toBe("terminalSettlement");
    expect(again.entries[0]!.lossUsd).toBeCloseTo(0.0123);
  });

  it("reads snake_case lines, skips broken ones, and never continues a cut-off line", () => {
    const path = join(dir, "ledger.jsonl");
    const now = Date.now() / 1000;
    writeFileSync(
      path,
      `{"ts": ${now - 10}, "job": "sweep_expired", "market": "", "wallet": "${ME}", "tx": "0xab", "status": "confirmed", ` +
        `"kind": "loss", "cost_usd": 0.02, "reward_usd": 0.0, "expected_reward_usd": 0.0, "claimed_usd": 0.0, "gas_used": 99, "summary": "", "extra": {}}\n` +
        "not json\n" +
        `{"ts": ${now - 5}, "job": "adl", "market": "", "wallet": "", "tx": "", "status": "confirmed", "kind": "profit", "costUsd": 0.01}\n` +
        `{"ts": ${now}, "job": "adl", "mar`,
    );
    const l = new Ledger(path);
    expect(l.entries.map((e) => e.job)).toEqual(["sweepExpired", "adl"]);
    expect(l.entries[0]!.gasUsed).toBe(99n);
    expect(l.lossesToday("sweepExpired")).toBeCloseTo(0.02);
    expect(l.spentToday()).toBeCloseTo(0.03);
    l.record(entry(now + 1, 0.1));
    const again = new Ledger(path);
    expect(again.entries).toHaveLength(3);
    expect(entryFromLine(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)!.costUsd).toBe(0.1);
  });

  it("keeps the 24 h budgets as a sliding window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = 1_800_000_000;
    vi.setSystemTime(T * 1000);
    const l = new Ledger(null);
    l.record(entry(T - 90_000, 1, "loss", "adl"));
    l.record(entry(T - 100, 2, "loss", "adl", 0.5));
    l.record(entry(T, 0.25));
    l.record(entry(T - 1_000, 4, "unpaid", "refresh")); // out of time order
    expect(l.entries.map((e) => e.ts)).toEqual([T - 90_000, T - 1_000, T - 100, T]);
    expect(l.spentToday()).toBeCloseTo(6.25);
    expect(l.lossesToday()).toBeCloseTo(5.5);
    expect(l.lossesToday("adl")).toBeCloseTo(1.5);
    const r = l.reserve("adl", 0.5, 0.25, 10n);
    expect(l.spentToday()).toBeCloseTo(6.75);
    expect(l.lossesToday()).toBeCloseTo(5.75);
    expect(l.lossesToday("adl")).toBeCloseTo(1.75);
    expect(l.reserved).toBe(1);
    l.release(r);
    l.release(r); // idempotent
    expect(l.reserved).toBe(0);
    expect(l.spentToday()).toBeCloseTo(6.25);
    expect(l.lossesToday("adl")).toBeCloseTo(1.5);
    vi.setSystemTime((T + DAY - 200) * 1000);
    expect(l.spentToday()).toBeCloseTo(2.25);
    expect(l.lossesToday("refresh")).toBe(0);
    vi.setSystemTime((T + DAY - 50) * 1000);
    expect(l.spentToday()).toBeCloseTo(0.25);
    expect(l.lossesToday()).toBe(0);
    expect(l.lossesToday("adl")).toBe(0);
    expect(Object.keys(l.summary(0))).toEqual(["adl", "refresh", "liquidation"]);
    expect(l.summary(T - 150, "market")).toEqual({ "ETH/USD": { calls: 2, reward: 0.5, cost: 2.25, net: -1.75, claimed: 0, reverted: 0 } });
    expect(l.since(T - 100)).toHaveLength(2);
  });

  it("matches a full rescan", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = 1_800_000_000;
    vi.setSystemTime(T * 1000);
    const l = new Ledger(null);
    let seed = 7;
    const rnd = () => ((seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647);
    for (let i = 0; i < 400; i++) {
      const ts = T - DAY * 1.5 + i * 300 + rnd() * 2_000; // mostly in order, sometimes not
      l.record(entry(ts, rnd() * 0.1, rnd() < 0.5 ? "loss" : "profit", rnd() < 0.5 ? "a" : "b", rnd() * 0.05));
    }
    for (const at of [T, T + 3_600, T + 20_000, T + 60_000]) {
      vi.setSystemTime(at * 1000);
      const inDay = l.entries.filter((e) => e.ts >= at - DAY);
      expect(l.spentToday()).toBeCloseTo(inDay.reduce((s, e) => s + e.costUsd, 0), 9);
      expect(l.lossesToday("a")).toBeCloseTo(inDay.filter((e) => e.job === "a").reduce((s, e) => s + e.lossUsd, 0), 9);
      expect(l.lossesToday()).toBeCloseTo(inDay.reduce((s, e) => s + e.lossUsd, 0), 9);
    }
  });
});

// ---- the executor, against a fake chain ----

function feeLog(topic: Hex, recipient: Address, amount: bigint, address: Address = PAIR): RawLog {
  return {
    address,
    topics: [topic, PAIR_ID, pad(recipient.toLowerCase() as Hex)],
    data: toHex(amount, { size: 32 }),
    blockNumber: 1,
    blockHash: pad("0x02"),
    transactionHash: pad("0x03"),
    logIndex: 0,
  };
}

class FakeChain {
  overridesSupported: boolean | null = true;
  calls: string[] = [];
  nonceValue = 5;
  probeResult: ProbeResult = {
    ok: true,
    ret: "0x",
    claimBefore: 0n,
    claimAfter: 10n ** 17n,
    gasUsed: 100_000n,
    adlPendingAfter: false,
    settlementFixedAfter: 0n,
    reward: 10n ** 17n, // $0.10
  };
  estimate = 200_000n;
  gasPriceValue = 100_000_000n; // 0.1 gwei
  /** errors thrown before the transaction reached the node */
  sendErrors: (Error | ((raw: Hex) => Error))[] = [];
  sendDelayMs = 0;
  sent: Hex[] = [];
  receiptStatus: "success" | "reverted" = "success";
  balanceValue = 10n ** 18n;

  async balance() {
    this.calls.push("balance");
    return this.balanceValue;
  }

  async supportsOverrides() {
    this.calls.push("supportsOverrides");
    return this.overridesSupported ?? true;
  }
  async probe() {
    this.calls.push("probe");
    return this.probeResult;
  }
  async call() {
    this.calls.push("call");
    return "0x" as Hex;
  }
  async estimateGas() {
    this.calls.push("estimateGas");
    return this.estimate;
  }
  async gasPrice() {
    this.calls.push("gasPrice");
    return this.gasPriceValue;
  }
  async nonce() {
    this.calls.push("nonce");
    return this.nonceValue;
  }
  /** errors thrown after the transaction was accepted: its answer got lost */
  lostErrors: (Error | ((raw: Hex) => Error))[] = [];
  /** what the node answers instead of the hash */
  answer: Hex | null = null;

  async sendRaw(raw: Hex) {
    this.calls.push("sendRaw");
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    const e = this.sendErrors.shift();
    if (e) throw typeof e === "function" ? e(raw) : e;
    this.sent.push(raw);
    const lost = this.lostErrors.shift();
    if (lost) throw typeof lost === "function" ? lost(raw) : lost;
    return this.answer ?? keccak256(raw);
  }
  async receipt(txHash: Hex): Promise<Receipt | null> {
    this.calls.push("receipt");
    if (!this.sent.some((raw) => keccak256(raw) === txHash)) return null; // never sent: no receipt
    const fee = pair().topic("FeeAccrued");
    return {
      transactionHash: txHash,
      blockNumber: 1,
      status: this.receiptStatus,
      gasUsed: 150_000n,
      effectiveGasPrice: 100_000_000n,
      from: ME,
      to: TARGET,
      logs: [
        feeLog(fee, ME, 10n ** 17n),
        feeLog(fee, OTHER, 10n ** 18n), // someone else's
        feeLog(fee, ME, 10n ** 18n, "0x4444444444444444444444444444444444444444"), // another pair
        feeLog(pair().topic("FeesClaimed"), ME, 5n * 10n ** 18n),
      ],
    };
  }
}

function setup(extra: Record<string, unknown> = {}) {
  const cfg = parseConfig({
    network: "anvil",
    factory: "0x" + "12".repeat(20),
    rpc: { http: "http://x" },
    prices: { endpoint: "http://p" },
    jobs: { liquidation: {} },
    ...extra,
  });
  const chain = new FakeChain();
  const ledger = new Ledger(null);
  const lane = new Lane("default", new LocalSigner(KEY));
  const events: [string, unknown][] = [];
  const ex = new Executor(chain as unknown as Chain, cfg, ledger, new Map([["default", lane]]), 42161, LENS, () => 2000, (k, p) =>
    events.push([k, p]),
  );
  ex.recheckDelaysMs = [1, 1];
  ex.receiptTimeoutS = 0.3;
  return { cfg, chain, ledger, lane, ex, events, job: cfg.jobs.liquidation! };
}

const action = (extra: Partial<ConstructorParameters<typeof Action>[0]> = {}) =>
  new Action({ job: "liquidation", market: null, target: TARGET, data: "0xabcdef", summary: "liquidate 1", rewardPair: PAIR, ...extra });

describe("executor", () => {
  it("simulates, prices, sends with priority fee 0 and base fee × feeMultiplier, and books the receipt", async () => {
    const { chain, ledger, lane, ex, events, job } = setup();
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(r.kind).toBe("profit");
    // The balance is read once, before the first send (the low-balance halt).
    expect(chain.calls).toEqual(["probe", "estimateGas", "gasPrice", "balance", "nonce", "sendRaw", "receipt"]);
    const tx = parseTransaction(chain.sent[0]!);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(42161);
    expect(tx.nonce).toBe(5);
    expect(tx.to).toBe(TARGET.toLowerCase());
    expect(tx.gas).toBe(260_000n); // 200k × 1.25 + 10k
    expect(tx.maxFeePerGas).toBe(200_000_000n); // 0.1 gwei × 2
    expect(tx.maxPriorityFeePerGas ?? 0n).toBe(0n);
    expect(r.expectedRewardUsd).toBeCloseTo(0.1);
    expect(r.rewardUsd).toBeCloseTo(0.1); // only this wallet's accrual on the reward pair
    expect(r.claimedUsd).toBeCloseTo(5);
    expect(r.gasUsed).toBe(150_000n);
    expect(r.costUsd).toBeCloseTo(0.03); // 150k gas × 0.1 gwei × $2000
    expect(r.txHash).toBe(keccak256(chain.sent[0]!));
    expect(lane.nonce).toBe(6);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ job: "liquidation", status: "confirmed", kind: "profit", gasUsed: 150_000n, wallet: ME });
    expect(ledger.entries[0]!.costWei).toBe(15_000_000_000_000n); // 150k gas × 0.1 gwei
    expect(ledger.spentWeiToday()).toBe(15_000_000_000_000n);
    expect(ledger.reserved).toBe(0);
    expect(events.map(([k]) => k)).toEqual(["sent", "action"]);

    // The next send uses the cached nonce and the engine's base fee: no extra round trips.
    chain.calls = [];
    ex.baseFee = 100_000_000n;
    await ex.run(action(), { jobCfg: job });
    expect(chain.calls).toEqual(["probe", "estimateGas", "sendRaw", "receipt"]);
    expect(parseTransaction(chain.sent[1]!).nonce).toBe(6);
  });

  it("re-reads the nonce and retries once on a nonce error", async () => {
    const { chain, lane, ex, job } = setup();
    chain.sendErrors = [new RpcError(-32000, "nonce too low")];
    chain.nonceValue = 9;
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(chain.calls.filter((c) => c === "nonce")).toHaveLength(2);
    expect(parseTransaction(chain.sent[0]!).nonce).toBe(9);
    expect(lane.nonce).toBe(10);
  });

  it("gives up on other send errors, and re-reads the nonce after any of them", async () => {
    const { chain, ledger, lane, ex, job } = setup();
    chain.sendErrors = [new RpcError(-32000, "insufficient funds for gas * price + value")];
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("send refused: insufficient funds for gas * price + value");
    expect(lane.nonce).toBeNull();
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.reserved).toBe(0);
    expect(ledger.spentToday()).toBe(0); // the refused send's reservation is gone
    expect(lane.lock.locked).toBe(false);
  });

  it("hands out consecutive nonces to concurrent sends on one lane", async () => {
    const { chain, ex, job } = setup();
    chain.sendDelayMs = 20;
    const rs = await Promise.all([ex.run(action(), { jobCfg: job }), ex.run(action(), { jobCfg: job }), ex.run(action(), { jobCfg: job })]);
    expect(rs.map((r) => r.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(chain.sent.map((raw) => parseTransaction(raw).nonce).sort()).toEqual([5, 6, 7]);
    expect(chain.calls.filter((c) => c === "nonce")).toHaveLength(1);
  });

  it("does not sign a call whose price aged past the pair's window less prices.sendMarginSeconds", async () => {
    const { chain, ledger, lane, ex, events, job } = setup();
    // The chain's time is 1000.5; sendMarginSeconds is 1 by default, so a call may carry a 2 s old price.
    ex.clock = () => 1000.5;
    const r = await ex.run(action({ priceTime: 998 }), { jobCfg: job });
    expect(r.status).toBe("skipped");
    expect(r.priceAged).toBe(true);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(
      "not sent: the price it relies on is from second 998, 2.5 s before the chain's time now, past the 2 s a call may carry " +
        "(the pair's 3 s window less prices.sendMarginSeconds); planned again with a newer price",
    );
    // Judged after the simulation and the balance check, before the nonce is read or anything signed.
    expect(chain.calls).toContain("probe");
    expect(chain.calls).not.toContain("nonce");
    expect(chain.sent).toHaveLength(0);
    expect(lane.nonce).toBeNull();
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.reserved).toBe(0);
    expect(events.filter(([k]) => k === "sent")).toEqual([]);

    // A price inside the limit, at its edge, or none to judge (a call that relies on no price): sent.
    for (const priceTime of [999, null]) {
      const ok = await ex.run(action({ priceTime }), { jobCfg: job });
      expect(ok.status, String(priceTime)).toBe("confirmed");
      expect(ok.priceAged).toBe(false);
    }
    ex.clock = () => 1000;
    expect((await ex.run(action({ priceTime: 998 }), { jobCfg: job })).status).toBe("confirmed");
    expect(chain.sent).toHaveLength(3);
  });

  it("judges the price's age with the margin configured", async () => {
    const { chain, ex, job } = setup({ prices: { endpoint: "http://p", sendMarginSeconds: 2.5 } });
    ex.clock = () => 1000.6;
    const r = await ex.run(action({ priceTime: 1000 }), { jobCfg: job });
    expect(r.priceAged).toBe(true);
    expect(r.reason).toContain("0.6 s before the chain's time now, past the 0.5 s a call may carry");
    expect(chain.sent).toHaveLength(0);
  });

  it("stops at a revert, a dry run, a watch-only lane and a fee ceiling", async () => {
    const { chain, ex, job } = setup();
    chain.probeResult = { ...chain.probeResult, ok: false };
    let r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("skipped");
    expect(r.error?.name).toBe("Reverted");
    expect(chain.calls).toEqual(["probe"]);

    const s = setup();
    r = await s.ex.run(action(), { jobCfg: s.job, dryRun: true });
    expect(r.status).toBe("simulated");
    expect(r.wouldSend).toBe(true);
    r = await s.ex.run(action({ wallet: "none" }), { jobCfg: s.job });
    expect(r.status).toBe("simulated");
    expect(r.reason).toMatch(/\(watch-only: no wallet configured\)$/);
    r = await s.ex.run(action({ wallet: "none", probe: false }), { jobCfg: s.job });
    expect(r.reason).toBe("needs a wallet to simulate (watch-only)");

    s.ex.baseFee = 200_000_000n; // 0.2 gwei, above the 0.1 gwei background ceiling
    r = await s.ex.run(action({ background: true }), { jobCfg: s.job });
    expect(r.wouldSend).toBe(false);
    expect(r.reason).toBe("base fee 0.2000 gwei is above the 0.1 gwei ceiling");
    expect(s.chain.calls).not.toContain("sendRaw");
  });

  it("pauses a job after repeated on-chain reverts", async () => {
    const { chain, ex, events, job } = setup({ safety: { pauseAfterReverts: 2, pauseMinutes: 15 } });
    chain.receiptStatus = "reverted";
    for (let i = 0; i < 2; i++) expect((await ex.run(action(), { jobCfg: job })).status).toBe("reverted");
    expect(ex.paused("liquidation", "")).toBe(true);
    expect(events.find(([k]) => k === "alert")?.[1]).toEqual(["jobPaused", "liquidation paused on all markets for 15 min after repeated reverts"]);
  });

  it("keeps polling for a receipt through RPC failures until the timeout", async () => {
    const { chain, ex } = setup();
    let polls = 0;
    chain.receipt = async () => {
      polls++;
      if (polls === 1) throw new TypeError("fetch failed");
      return null as unknown as Receipt;
    };
    // polls at 0, 250 and 625 ms (the delay grows 1.5× a time)
    expect(await ex.waitForReceipt("0xab", 1)).toBeNull();
    expect(polls).toBe(3);
  });

  it("locks in-flight keys", () => {
    const { ex } = setup();
    const a = [lockKey("liq", PAIR, ME)];
    expect(ex.tryLock(a)).toBe(true);
    expect(ex.tryLock([lockKey("liq", PAIR, ME), lockKey("liq", PAIR, OTHER)])).toBe(false);
    expect(ex.inflight.has(lockKey("liq", PAIR, OTHER))).toBe(false);
    ex.unlock(a);
    expect(ex.inflight.size).toBe(0);
  });

  it("Mutex is FIFO and free locks need no wait", async () => {
    const m = new Mutex();
    expect(m.acquire()).toBeUndefined();
    const order: number[] = [];
    const w1 = m.acquire()!.then(() => order.push(1));
    const w2 = m.acquire()!.then(() => order.push(2));
    m.release();
    await w1;
    m.release();
    await w2;
    m.release();
    expect(order).toEqual([1, 2]);
    expect(m.locked).toBe(false);
  });
});

// ---- budgets, sends and fee ceilings against hostile inputs ----

const sweep = (i: number) =>
  new Action({ job: "sweepExpired", market: null, target: TARGET, data: "0x01", summary: "sweep", paid: false, locks: [`sweep:${i}`] });

describe("budgets hold under concurrency", () => {
  it("concurrent unpaid calls stay within the job's daily loss budget", async () => {
    // each call: 200k gas × 0.1 gwei × $2000 = $0.04 of loss; a $0.05 budget lets one through
    const { chain, ledger, ex, cfg } = setup({ jobs: { sweepExpired: { lossBudgetUsdPerDay: 0.05, maxLossUsdPerCall: 0.05 } } });
    chain.sendDelayMs = 20;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ex.run(sweep(i), { jobCfg: cfg.jobs.sweepExpired! })));
    expect(chain.sent).toHaveLength(1);
    expect(rs.filter((r) => r.sent)).toHaveLength(1);
    expect(rs.filter((r) => r.reason.includes("daily loss budget is spent"))).toHaveLength(9);
    expect(ledger.lossesToday("sweepExpired")).toBeLessThanOrEqual(0.05);
    expect(ledger.reserved).toBe(0);
  });

  it("concurrent calls stay within maxSpendUsdPerDay", async () => {
    const { chain, ledger, ex, cfg } = setup({
      budget: { maxSpendUsdPerDay: 0.05 },
      jobs: { sweepExpired: { lossBudgetUsdPerDay: 100, maxLossUsdPerCall: 1 } },
    });
    chain.sendDelayMs = 20;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ex.run(sweep(i), { jobCfg: cfg.jobs.sweepExpired! })));
    expect(chain.sent).toHaveLength(1);
    expect(rs.filter((r) => r.reason.startsWith("daily gas budget reached"))).toHaveLength(9);
    expect(ledger.spentToday()).toBeLessThanOrEqual(0.05);
  });

  it("a reservation counts from the decision until the entry is booked, and is released when nothing went out", async () => {
    const { chain, ledger, ex, job } = setup();
    chain.sendDelayMs = 30;
    const run = ex.run(action(), { jobCfg: job });
    await new Promise((r) => setTimeout(r, 10)); // decided, sending
    expect(ledger.reserved).toBe(1);
    expect(ledger.spentToday()).toBeCloseTo(0.04); // the estimate: 200k gas × 0.1 gwei × $2000
    expect(ledger.spentWeiToday()).toBe(20_000_000_000_000n);
    await run;
    expect(ledger.reserved).toBe(0);
    expect(ledger.spentToday()).toBeCloseTo(0.03); // the receipt's 150k gas
    chain.sendErrors = [new RpcError(-32000, "insufficient funds for gas * price + value")];
    expect((await ex.run(action(), { jobCfg: job })).status).toBe("skipped");
    expect(ledger.reserved).toBe(0);
    expect(ledger.spentToday()).toBeCloseTo(0.03);
  });
});

describe("costs cannot be made to look free", () => {
  it("prices gas at no less than gas.ethUsdFloor, so a $0.0001 ETH/USD print does not zero the budgets", async () => {
    const { chain, ledger, ex, cfg } = setup({
      budget: { maxSpendUsdPerDay: 0.06, maxLossUsdPerDay: 0.06 },
      jobs: { sweepExpired: { lossBudgetUsdPerDay: 0.06, maxLossUsdPerCall: 0.05 } },
    });
    (ex as { ethUsdSource: () => number }).ethUsdSource = () => 0.0001;
    expect(ex.ethUsd()).toBe(1000);
    for (let i = 0; i < 20; i++) await ex.run(sweep(i), { jobCfg: cfg.jobs.sweepExpired! });
    // $0.02 estimated, $0.015 booked per call at $1000: three fit the $0.06 budgets
    expect(chain.sent).toHaveLength(3);
    expect(ledger.entries[0]!.costUsd).toBeCloseTo(0.015);
  });

  it("falls back to gas.ethUsdFallback when the source has no finite positive price", () => {
    const { ex } = setup();
    const src = ex as { ethUsdSource: () => number | null };
    for (const v of [null, Number.NaN, Infinity, -5, 0]) {
      src.ethUsdSource = () => v;
      expect(ex.ethUsd()).toBe(3000);
    }
    src.ethUsdSource = () => 2500;
    expect(ex.ethUsd()).toBe(2500);
  });

  it("caps the ETH spent per day in wei, whatever the price", async () => {
    const { chain, ex, cfg } = setup({
      gas: { ethUsdFloor: 1e-9 },
      budget: { maxSpendEthPerDay: 0.00006 },
      jobs: { sweepExpired: { lossBudgetUsdPerDay: 100, maxLossUsdPerCall: 1 } },
    });
    (ex as { ethUsdSource: () => number }).ethUsdSource = () => 1e-9; // every cost rounds to $0
    const rs = [];
    for (let i = 0; i < 10; i++) rs.push(await ex.run(sweep(i), { jobCfg: cfg.jobs.sweepExpired! }));
    // 2e13 wei estimated, 1.5e13 booked per call: three fit 6e13
    expect(chain.sent).toHaveLength(3);
    expect(rs[2]!.costUsd).toBeLessThan(1e-9);
    expect(rs[3]!.reason).toBe("daily ETH spend cap reached (0.000045 of 0.00006 ETH spent; budget.maxSpendEthPerDay)");
  });

  it("keeps each entry's wei under extra.cost_wei across restarts", () => {
    const path = join(dir, "ledger.jsonl");
    const now = Date.now() / 1000;
    const l = new Ledger(path);
    l.record(new Entry({ ...entry(now, 0.03), costWei: 12_345_678_901_234_567_890n }));
    const line = readFileSync(path, "utf8").trim();
    expect(line).toContain('"extra": {"cost_wei": "12345678901234567890"}');
    expect(Object.keys(JSON.parse(line) as object)).not.toContain("cost_wei");
    const again = new Ledger(path);
    expect(again.entries[0]!.costWei).toBe(12_345_678_901_234_567_890n);
    expect(again.spentWeiToday()).toBe(12_345_678_901_234_567_890n);
    expect(entryFromLine(line.replace('"12345678901234567890"', '"junk"'))!.costWei).toBe(0n);
  });

  it("books a cost that is not a finite number as a refusal, never as $0", () => {
    const l = new Ledger(null);
    const now = Date.now() / 1000;
    const r = l.reserve("adl", Number.NaN, Number.NaN, 0n);
    expect(l.spentToday()).toBe(Infinity);
    expect(l.lossesToday("adl")).toBe(Infinity);
    l.release(r);
    expect(l.spentToday()).toBe(0);
    l.record(entry(now, Infinity, "unpaid", "adl"));
    expect(l.spentToday()).toBe(Infinity);
    expect(l.lossesToday()).toBe(Infinity);
  });
});

describe("a send is never signed twice blindly", () => {
  // Chain.sendRaw's contract: SendError (with the hash) when the outcome is unknown, RpcError when
  // the node refused, TypeError when the bytes could not be sent at all.
  const unanswered = (raw: Hex) => new SendError(`the transaction ${keccak256(raw)} was submitted but no answer settled it`, keccak256(raw));

  it("a lost answer to an accepted send: confirmed by its own hash, never re-signed", async () => {
    const { chain, ledger, lane, ex, job } = setup();
    chain.lostErrors = [unanswered];
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(chain.calls.filter((c) => c === "sendRaw")).toHaveLength(1);
    expect(r.txHash).toBe(keccak256(chain.sent[0]!));
    expect(ledger.entries).toHaveLength(1);
    expect(lane.nonce).toBeNull(); // re-read before the next send
  });

  it("'already known' is this very transaction", async () => {
    const { chain, ex, job } = setup();
    chain.lostErrors = [new RpcError(-32000, "already known")];
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(chain.calls.filter((c) => c === "sendRaw")).toHaveLength(1);
    expect(chain.calls.filter((c) => c === "nonce")).toHaveLength(1);
  });

  it("'nonce too low' is looked up by hash first: this very transaction took the nonce", async () => {
    const { chain, ex, job } = setup();
    chain.lostErrors = [new RpcError(-32000, "nonce too low: address 0xf39f, tx: 5 state: 6")];
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);
    expect(chain.calls.filter((c) => c === "sendRaw")).toHaveLength(1);
    expect(r.txHash).toBe(keccak256(chain.sent[0]!));
  });

  it("a send with no answer and no receipt is booked as unknown at its estimate, and its keys stay held", async () => {
    const { chain, ledger, lane, ex, events, job } = setup();
    chain.sendErrors = [unanswered];
    const keys = [lockKey("liq", PAIR, OTHER)];
    expect(ex.tryLock(keys)).toBe(true);
    const r = await ex.run(action({ locks: keys }), { jobCfg: job });
    ex.unlock(keys); // as the engine does once the run ends
    expect(r.status).toBe("unknown");
    expect(r.reason).toMatch(/no answer and no receipt/);
    expect(chain.calls.filter((c) => c === "sendRaw")).toHaveLength(1);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: "unknown", costWei: 20_000_000_000_000n });
    expect(ledger.entries[0]!.costUsd).toBeCloseTo(0.04);
    expect(lane.nonce).toBeNull();
    expect(ex.inflight.has(keys[0]!)).toBe(true);
    expect(ex.tryLock(keys)).toBe(false);
    expect(events.find(([k]) => k === "alert")?.[1]).toEqual([
      "endpointDown",
      `liquidation -: the send endpoint gave no answer and transaction ${r.txHash} has no receipt; booked as unknown at its estimated cost`,
    ]);
    ex.hold(keys, 0.01);
    await new Promise((res) => setTimeout(res, 30));
    expect(ex.inflight.size).toBe(0);
  });

  it("a TypeError from sendRaw means nothing was sent: no entry, no reservation, no held keys", async () => {
    const { chain, ledger, ex, events, job } = setup();
    chain.sendErrors = [new TypeError("sendRaw takes a signed transaction as 0x-prefixed hex bytes")];
    const keys = [lockKey("liq", PAIR, OTHER)];
    expect(ex.tryLock(keys)).toBe(true);
    const r = await ex.run(action({ locks: keys }), { jobCfg: job });
    ex.unlock(keys);
    expect(r.status).toBe("skipped");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("not sent: sendRaw takes a signed transaction as 0x-prefixed hex bytes");
    expect(chain.calls.filter((c) => c === "sendRaw")).toHaveLength(1); // not re-signed either
    expect(chain.calls).not.toContain("receipt");
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.reserved).toBe(0);
    expect(ledger.spentToday()).toBe(0);
    expect(ex.inflight.size).toBe(0);
    expect(events.filter(([k]) => k === "alert" || k === "sent")).toEqual([]);
  });

  it("tracks the hash of the bytes signed, not the node's answer", async () => {
    const { chain, ex, job } = setup();
    chain.answer = `0x${"ee".repeat(32)}`;
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.txHash).toBe(keccak256(chain.sent[0]!));
    expect(r.status).toBe("confirmed");
  });

  // Through the real JsonRpc: whether it retries the send (it used to; the retry then reads "nonce too
  // low") or not (the executor sees the lost answer), the call goes out once.
  it("an accepted send whose answer is lost over JsonRpc goes out once", async () => {
    let accepted = 0;
    let chainNonce = 5;
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
      const reply = (result: unknown, error?: unknown) =>
        new Response(JSON.stringify(error ? { jsonrpc: "2.0", id: body.id, error } : { jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "eth_getTransactionCount") return reply("0x" + chainNonce.toString(16));
      if (body.method === "eth_sendRawTransaction") {
        const raw = body.params[0] as Hex;
        if (parseTransaction(raw).nonce! < chainNonce) return reply(null, { code: -32000, message: "nonce too low" });
        accepted++;
        chainNonce++;
        if (accepted === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); // executed, answer lost
        return reply(keccak256(raw));
      }
      if (body.method === "eth_getTransactionReceipt") {
        return reply({ transactionHash: body.params[0], blockNumber: "0x1", status: "0x1", gasUsed: "0x30d40", effectiveGasPrice: "0x5f5e100", from: ME, to: TARGET, logs: [] });
      }
      throw new Error("unexpected " + body.method);
    };
    const real = new Chain(new JsonRpc("http://rpc", { fetch: fetchFn, perSecond: 1000 }));
    const { chain, ex, ledger, job } = setup();
    Object.assign(chain, {
      nonce: (a: Address, t: "pending") => real.nonce(a, t),
      sendRaw: (raw: Hex) => real.sendRaw(raw),
      receipt: (h: Hex) => real.receipt(h),
    });
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.status).toBe("confirmed");
    expect(accepted).toBe(1);
    expect(ledger.entries).toHaveLength(1);
  });
});

describe("force keeps the safety rails and the ceiling caps the fee", () => {
  it("force keeps the daily spend caps, the low-balance halt and the fee ceilings", async () => {
    const s = setup({ budget: { maxSpendUsdPerDay: 0.01 } });
    let r = await s.ex.run(action(), { jobCfg: s.job, force: true });
    expect(r.wouldSend).toBe(false);
    expect(r.reason).toMatch(/^daily gas budget reached/);

    const h = setup();
    h.ex.halted = "sending paused: default holds 0.00100 ETH, below budget.minEthBalance";
    r = await h.ex.run(action(), { jobCfg: h.job, force: true });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(h.ex.halted);

    const c = setup({ gas: { maxFeeGwei: 0.05 } });
    c.ex.baseFee = 100_000_000n;
    r = await c.ex.run(action(), { jobCfg: c.job, force: true });
    expect(r.wouldSend).toBe(false);
    expect(r.reason).toBe("base fee 0.1000 gwei is above the 0.05 gwei ceiling");
    for (const x of [s, h, c]) expect(x.chain.calls).not.toContain("sendRaw");
  });

  it("reads the balances before the first send, and halts on a low one", async () => {
    const { chain, ex, events, job } = setup();
    chain.balanceValue = 10n ** 15n; // 0.001 ETH, below the 0.002 default
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(`sending paused: default (${ME}) holds 0.00100 ETH, below budget.minEthBalance`);
    expect(chain.calls).not.toContain("sendRaw");
    expect(events.find(([k]) => k === "alert")?.[1]).toEqual(["lowBalance", r.reason]);
    // A balance check the keeper made (it sets halted) counts as fresh: no read before this send.
    ex.halted = "";
    chain.calls = [];
    expect((await ex.run(action(), { jobCfg: job })).status).toBe("confirmed");
    expect(chain.calls).not.toContain("balance");
  });

  it("sends nothing when the balances cannot be read", async () => {
    const { chain, ex, job } = setup();
    chain.balance = async () => {
      throw new RpcError(-32603, "header not found");
    };
    const r = await ex.run(action(), { jobCfg: job });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("could not read the wallets' balances, so nothing is sent: header not found");
    // a dry run needs no balance
    expect((await ex.run(action(), { jobCfg: job, dryRun: true })).status).toBe("simulated");
  });

  it("caps maxFeePerGas at the fee ceiling", async () => {
    const { chain, ex, job } = setup({ gas: { maxFeeGwei: 0.15 } });
    ex.baseFee = 100_000_000n; // 0.1 gwei: × 2 would be 0.2
    await ex.run(action(), { jobCfg: job });
    expect(parseTransaction(chain.sent[0]!).maxFeePerGas).toBe(150_000_000n);
    // background calls: their own ceiling, and never above the hard one
    ex.baseFee = 80_000_000n;
    await ex.run(action({ background: true }), { jobCfg: job });
    expect(parseTransaction(chain.sent[1]!).maxFeePerGas).toBe(100_000_000n);
    const low = setup({ gas: { maxFeeGwei: 0.05, backgroundMaxFeeGwei: 0.1 } });
    low.ex.baseFee = 80_000_000n;
    const r = await low.ex.run(action({ background: true }), { jobCfg: low.job });
    expect(r.reason).toBe("base fee 0.0800 gwei is above the 0.05 gwei ceiling");
  });
});

