/**
 * Simulate, decide, send and track: the one path every action takes, automatic or manual.
 *
 * probe simulation → spend policy → send → receipt → ledger. Each wallet is a lane: a mutex around
 * nonce assignment, the nonce cached and re-read after any send error. Arbitrum's sequencer orders
 * transactions first come, first served, so a priority fee buys nothing: transactions go out with
 * priority fee 0 and maxFeePerGas = base fee × gas.feeMultiplier, capped at the fee ceiling.
 *
 * A send's cost and loss are reserved in the ledger the moment it is decided, so concurrent sends
 * cannot overshoot a budget. A transaction is tracked by the hash of the bytes signed (never by what
 * the node answers), and a send whose outcome is unclear is never signed again blindly: it is looked
 * up by that hash, and if it cannot be found it is booked as unknown at its estimated cost while its
 * candidate stays locked.
 */

import {
  type Chain,
  type DecodedError,
  MAX_PRICE_STALENESS,
  type Market,
  type ProbeResult,
  type Receipt,
  RpcError,
  SendError,
  decodeError,
  pair,
  sleep,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, keccak256 } from "viem";
import type { JobConfig, KeeperConfig } from "../config/index.js";
import { getLogger } from "../observe/logs.js";
import { Entry, type Ledger, type Reservation } from "./ledger.js";
import { type Decision, Quote, SpendPolicy, fmtG } from "./policy.js";
import type { Signer, TxRequest } from "./wallets.js";

const log = getLogger("bazaar_sdk.exec");

const FEE_ACCRUED = pair().topic("FeeAccrued");
const FEES_CLAIMED = pair().topic("FeesClaimed");
/** The node already holds this very transaction (same bytes, same hash): it went out. */
const KNOWN = /already known|known transaction|already imported/i;
/** The nonce is taken: by another transaction, or by this one if an earlier copy of the send got through. */
const NONCE_TAKEN = /nonce too low|nonce has already been used/i;
/** Send errors worth one immediate retry with a re-read nonce. */
const RETRYABLE = /nonce|underpriced/i;
/** How long a send without an outcome keeps its candidate's in-flight keys after its run ends (s). */
const HOLD_SECONDS = 300;
/**
 * A balance check older than this (s) is redone before the next send. The running keeper checks every
 * 60 s, so this only fires before the first send and in one-shot runs.
 */
const BALANCE_MAX_AGE = 120;
const WEI_PER_ETH = 1e18;
const BAZAAR_ONE = 1e18; // BAZAAR_SCALE as a double, for USD amounts

/**
 * One key in the executor's in-flight set, joined from its parts:
 * `lockKey("liq", market.address, account)`.
 */
export function lockKey(...parts: readonly (string | number | bigint)[]): string {
  return parts.join(":");
}

export interface ActionInit {
  job: string;
  market: Market | null;
  target: Address;
  data: Hex;
  value?: bigint;
  summary?: string;
  /** in-flight keys (see lockKey): an action whose keys are taken is not dispatched */
  locks?: readonly string[];
  wallet?: string;
  /** the pair whose claimable balance measures the reward */
  rewardPair?: Address | null;
  paid?: boolean;
  /** an unpaid duty the operator switched on, and its per-call cap */
  consentCapUsd?: number | null;
  /** may wait for a quiet chain (gas.backgroundMaxFeeGwei) */
  background?: boolean;
  /** a skip reason, or null/undefined/"" to proceed */
  requires?: ((sim: ProbeResult) => string | null | undefined) | null;
  /** replaces the spend policy (collect, forward) */
  decide?: ((q: Quote) => Decision) | null;
  minGas?: bigint;
  /**
   * Simulate through the probe (to measure the reward). A call whose effect depends on who sends it
   * (claimFees pays msg.sender, a token transfer spends the sender's balance) is simulated from the
   * wallet itself instead.
   */
  probe?: boolean;
  /**
   * The second the price the call relies on was generated in (the update it carries) or stored in
   * (the pair's own price, when it carries none), for a call that reverts once that price is more
   * than 3 s from the block's time; null or left out for a call that does not. Checked again just
   * before the call is signed.
   */
  priceTime?: number | null;
}

export class Action {
  job: string;
  market: Market | null;
  target: Address;
  data: Hex;
  value: bigint;
  summary: string;
  locks: readonly string[];
  wallet: string;
  rewardPair: Address | null;
  paid: boolean;
  consentCapUsd: number | null;
  background: boolean;
  requires: ((sim: ProbeResult) => string | null | undefined) | null;
  decide: ((q: Quote) => Decision) | null;
  minGas: bigint;
  probe: boolean;
  priceTime: number | null;

  constructor(a: ActionInit) {
    this.job = a.job;
    this.market = a.market;
    this.target = a.target;
    this.data = a.data;
    this.value = a.value ?? 0n;
    this.summary = a.summary ?? "";
    this.locks = a.locks ?? [];
    this.wallet = a.wallet ?? "default";
    this.rewardPair = a.rewardPair ?? null;
    this.paid = a.paid ?? true;
    this.consentCapUsd = a.consentCapUsd ?? null;
    this.background = a.background ?? false;
    this.requires = a.requires ?? null;
    this.decide = a.decide ?? null;
    this.minGas = a.minGas ?? 0n;
    this.probe = a.probe ?? true;
    this.priceTime = a.priceTime ?? null;
  }
}

export type ResultStatus = "confirmed" | "reverted" | "unknown" | "skipped" | "simulated";

export interface ActionResultInit {
  status: ResultStatus;
  job: string;
  market: string;
  summary: string;
  reason?: string;
  kind?: string;
}

export class ActionResult {
  status: ResultStatus;
  job: string;
  market: string;
  summary: string;
  reason: string;
  kind: string;
  txHash: Hex | "" = "";
  gasUsed = 0n;
  costUsd = 0;
  rewardUsd = 0;
  expectedRewardUsd = 0;
  claimedUsd = 0;
  error: DecodedError | null = null;
  wouldSend = false;
  returned: Hex = "0x";
  /**
   * Not sent because the price the call relies on had aged too far by the time it would have been
   * signed: nothing about the candidate was refused, so it is planned again with a newer price.
   */
  priceAged = false;

  constructor(r: ActionResultInit) {
    this.status = r.status;
    this.job = r.job;
    this.market = r.market;
    this.summary = r.summary;
    this.reason = r.reason ?? "";
    this.kind = r.kind ?? "";
  }

  /** For a "too early" revert, when the call opens. */
  get opensAt(): number | null {
    return this.error ? this.error.opensAt() : null;
  }

  get sent(): boolean {
    return this.status === "confirmed" || this.status === "reverted" || this.status === "unknown";
  }
}

/** A small FIFO mutex: acquire() returns nothing when the lock is free, so the free path never waits. */
export class Mutex {
  private busy = false;
  private readonly waiters: (() => void)[] = [];

  get locked(): boolean {
    return this.busy;
  }

  /** Hold the lock: undefined when it was free, else a promise that resolves once it is handed over. */
  acquire(): Promise<void> | undefined {
    if (!this.busy) {
      this.busy = true;
      return undefined;
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // handed straight to the next waiter: stays held
    else this.busy = false;
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const wait = this.acquire();
    if (wait) await wait;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** One wallet: its signer and its nonce sequence. */
export class Lane {
  nonce: number | null = null;
  readonly lock = new Mutex();

  constructor(
    readonly name: string,
    readonly signer: Signer,
  ) {}

  get address(): Address {
    return this.signer.address;
  }
}

interface Pause {
  reverts: number;
  /** seconds since the epoch */
  until: number;
}

/** What the executor reports: "alert" [kind, message], "sent" [action, txHash], "action" (a sent call's result). */
export interface ExecutorEvents {
  alert: readonly [kind: string, message: string];
  sent: readonly [action: Action, txHash: Hex];
  action: ActionResult;
}
export type Emit = <K extends keyof ExecutorEvents>(kind: K, payload: ExecutorEvents[K]) => void;

export interface RunOptions {
  dryRun?: boolean;
  /**
   * one-shot calls only: skip the profit and loss rules. The daily spend caps, the low-balance halt
   * and the fee ceilings still apply.
   */
  force?: boolean;
  jobCfg?: JobConfig | null;
}

export class Executor {
  readonly policy: SpendPolicy;
  readonly emit: Emit;
  /** the latest block's base fee (the engine keeps it current); 0 makes the executor ask eth_gasPrice */
  baseFee = 0n;
  readonly inflight = new Set<string>();
  readonly pauses = new Map<string, Pause>();
  /**
   * Pauses (ms) between the looks for a transaction whose send had an unclear answer: is the one
   * signed on chain? (Only on that error path.)
   */
  recheckDelaysMs: readonly number[] = [250, 500, 1000];
  /** How long a sent transaction's receipt is waited for (s). */
  receiptTimeoutS = 90;
  /**
   * The chain's time in unix seconds, fractions included, from the newest head known: what an
   * action's `priceTime` is judged against just before it is signed. The engine sets it to its own
   * chain clock; this machine's clock until then.
   */
  clock: () => number = () => Date.now() / 1000;
  /** in-flight keys kept past their run (see hold), with the timer that frees each */
  private readonly held = new Map<string, ReturnType<typeof setTimeout>>();
  private haltReason = "";
  /** monotonic seconds of the last balance check (see halted) */
  private balancesAt = -Infinity;
  private balanceCheck: Promise<void> | null = null;

  /**
   * `lens` is the deployment's lens; the engine sets it once the deployment is read (until then pass
   * any address: nothing is probed before it).
   */
  constructor(
    readonly chain: Chain,
    readonly cfg: KeeperConfig,
    readonly ledger: Ledger,
    readonly lanes: Map<string, Lane>,
    public chainId: number,
    public lens: Address,
    readonly ethUsdSource: () => number | null | undefined,
    emit?: Emit | null,
  ) {
    this.policy = new SpendPolicy(cfg, ledger);
    this.emit = emit ?? (() => {});
  }

  /**
   * Set when sending must stop (low balance), "" to resume; forced calls stop too. Whoever sets it
   * has just read the balances (the keeper's periodic check, or {@link checkBalances}), so setting it
   * also marks the balances as fresh.
   */
  get halted(): string {
    return this.haltReason;
  }

  set halted(reason: string) {
    this.haltReason = reason;
    this.balancesAt = performance.now() / 1000;
  }

  // ---- bookkeeping ----
  /**
   * ETH/USD for pricing gas: the price source's, or gas.ethUsdFallback when it has none it vouches
   * for (or not a finite positive number), and never below gas.ethUsdFloor.
   */
  ethUsd(): number {
    const v = this.ethUsdSource();
    const g = this.cfg.gas;
    const p = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : g.ethUsdFallback;
    return p > g.ethUsdFloor ? p : g.ethUsdFloor;
  }

  usd(wei: bigint, ethUsd: number = this.ethUsd()): number {
    return (Number(wei) / WEI_PER_ETH) * ethUsd;
  }

  paused(job: string, market: string): boolean {
    const p = this.pauses.get(lockKey(job, market));
    return p !== undefined && p.until > Date.now() / 1000;
  }

  tryLock(keys: readonly string[] | ReadonlySet<string>): boolean {
    for (const k of keys) if (this.inflight.has(k)) return false;
    for (const k of keys) this.inflight.add(k);
    return true;
  }

  /** Free `keys`, except those {@link hold} keeps. */
  unlock(keys: readonly string[] | ReadonlySet<string>): void {
    for (const k of keys) if (!this.held.has(k)) this.inflight.delete(k);
  }

  /**
   * Keep `keys` in flight for `seconds` after the run ends: a send without an outcome may still land,
   * and its candidate must not be sent again meanwhile.
   */
  hold(keys: readonly string[], seconds = HOLD_SECONDS): void {
    for (const k of keys) {
      this.inflight.add(k);
      const prev = this.held.get(k);
      if (prev !== undefined) clearTimeout(prev);
      const timer = setTimeout(() => {
        this.held.delete(k);
        this.inflight.delete(k);
      }, seconds * 1000);
      (timer as { unref?: () => void }).unref?.();
      this.held.set(k, timer);
    }
  }

  /**
   * Read every wallet's ETH balance; halt sending while one is below budget.minEthBalance, resume
   * once none is.
   */
  async checkBalances(): Promise<void> {
    const lanes = [...this.lanes.values()];
    const balances = await Promise.all(lanes.map((lane) => this.chain.balance(lane.address)));
    const min = this.cfg.budget.minEthBalance * 1e18;
    const low: string[] = [];
    lanes.forEach((lane, i) => {
      const bal = Number(balances[i]!);
      if (bal < min) low.push(`${lane.name} (${lane.address}) holds ${(bal / 1e18).toFixed(5)} ETH`);
    });
    this.halted = low.length ? "sending paused: " + low.join("; ") + ", below budget.minEthBalance" : "";
    if (low.length) this.emit("alert", ["lowBalance", this.halted]);
  }

  /** A balance check when the last one is stale (before the first send, in one-shot runs); one at a time. */
  private balancesFresh(): Promise<void> | null {
    if (performance.now() / 1000 - this.balancesAt < BALANCE_MAX_AGE) return null;
    this.balanceCheck ??= this.checkBalances().finally(() => {
      this.balanceCheck = null;
    });
    return this.balanceCheck;
  }

  private noteOutcome(job: string, market: string, reverted: boolean): void {
    const key = lockKey(job, market);
    let p = this.pauses.get(key);
    if (!p) {
      p = { reverts: 0, until: 0 };
      this.pauses.set(key, p);
    }
    if (!reverted) {
      p.reverts = 0;
      return;
    }
    p.reverts += 1;
    const safety = this.cfg.safety;
    if (p.reverts >= safety.pauseAfterReverts) {
      p.until = Date.now() / 1000 + safety.pauseMinutes * 60;
      p.reverts = 0;
      this.emit("alert", [
        "jobPaused",
        `${job} paused on ${market || "all markets"} for ${fmtG(safety.pauseMinutes)} min after repeated reverts`,
      ]);
    }
  }

  // ---- the pipeline ----
  async run(a: Action, opts: RunOptions = {}): Promise<ActionResult> {
    const dryRun = opts.dryRun ?? false;
    const force = opts.force ?? false;
    const jobCfg = opts.jobCfg ?? null;
    const res = new ActionResult({ status: "skipped", job: a.job, market: a.market ? a.market.label : "", summary: a.summary });
    const lane = this.lanes.get(a.wallet);
    const sender = lane ? lane.address : null;

    // 1. Simulate through the probe: does it succeed, and what does it earn?
    if (!a.probe && sender === null) {
      res.reason = "needs a wallet to simulate (watch-only)";
      return res;
    }
    let sim: ProbeResult;
    try {
      const overrides = a.probe && (this.chain.overridesSupported ?? (await this.chain.supportsOverrides()));
      if (overrides) {
        sim = await this.chain.probe(sender, a.target, a.data, a.value, this.lens, a.rewardPair);
      } else {
        // Without state overrides the call is simulated directly: reverts are still caught, but the
        // reward is unknown, so only unpaid duties and loss-taking jobs can send.
        const ret = await this.chain.call(a.target, a.data, { from: sender, value: a.value });
        sim = {
          ok: true,
          ret,
          claimBefore: 0n,
          claimAfter: 0n,
          gasUsed: 0n,
          adlPendingAfter: false,
          settlementFixedAfter: 0n,
          reward: 0n,
        };
      }
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      const data = e.revertData;
      if (data !== null) {
        res.error = decodeError(data);
        res.reason = res.error.toString();
      } else {
        res.reason = `simulation failed: ${e.rpcMessage}`;
      }
      return res;
    }
    if (!sim.ok) {
      res.error = decodeError(sim.ret);
      res.reason = res.error.toString();
      return res;
    }
    res.returned = sim.ret;
    if (a.requires) {
      const why = a.requires(sim);
      if (why) {
        res.reason = why;
        return res;
      }
    }

    // 2. Cost.
    let gas = 0n;
    if (sender) {
      try {
        gas = await this.chain.estimateGas(sender, a.target, a.data, a.value);
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        const data = e.revertData;
        res.error = data !== null ? decodeError(data) : null;
        res.reason = `gas estimate failed: ${res.error ? res.error.toString() : e.rpcMessage}`;
        return res;
      }
    }
    if (gas === 0n) gas = sim.gasUsed + 60_000n;
    if (a.minGas > gas) gas = a.minGas;
    const baseFee = this.baseFee > 0n ? this.baseFee : await this.chain.gasPrice();
    const costWei = gas * baseFee + a.value;
    const ethUsd = this.ethUsd(); // one price for the quote and the booking
    const quote = new Quote(a.rewardPair ? Number(sim.reward) / BAZAAR_ONE : 0, this.usd(costWei, ethUsd), costWei);
    res.costUsd = quote.costUsd;
    res.expectedRewardUsd = quote.rewardUsd;
    const sending = !dryRun && lane !== undefined && !(jobCfg && jobCfg.dryRun);
    // A send needs a recent balance check (the low-balance halt): before the decision, so nothing is
    // awaited between the decision and its reservation. Only stale checks wait: the first send, and
    // one-shot runs.
    const check = sending ? this.balancesFresh() : null;
    if (check) {
      try {
        await check;
      } catch (e) {
        const why = e instanceof RpcError ? e.rpcMessage : e instanceof Error ? e.message : String(e);
        res.reason = `could not read the wallets' balances, so nothing is sent: ${why}`;
        return res;
      }
    }

    // 3. Decide. Forced or not, every call fits the daily spend caps.
    let decision: Decision;
    if (a.decide && !force) {
      decision = a.decide(quote);
      if (decision.send) decision = this.policy.spendCaps(quote) ?? decision;
    } else {
      decision = this.policy.decide(a.job, jobCfg, quote, { paid: a.paid, consentCapUsd: a.consentCapUsd, force });
    }
    res.kind = decision.kind;
    res.reason = decision.reason;
    res.wouldSend = decision.send;
    const g = this.cfg.gas;
    // gas.maxFeeGwei is the hard ceiling; background calls have their own, lower one on top.
    let ceiling = a.background ? g.backgroundMaxFeeGwei : g.maxFeeGwei;
    if (a.background && g.maxFeeGwei != null && (ceiling == null || g.maxFeeGwei < ceiling)) ceiling = g.maxFeeGwei;
    if (decision.send && ceiling != null && Number(baseFee) > ceiling * 1e9) {
      res.wouldSend = false;
      res.reason = `base fee ${(Number(baseFee) / 1e9).toFixed(4)} gwei is above the ${fmtG(ceiling)} gwei ceiling`;
    }
    if (!sending || !lane) {
      res.status = "simulated";
      if (!lane && res.wouldSend) res.reason += " (watch-only: no wallet configured)";
      return res;
    }
    if (!res.wouldSend) return res;
    if (this.halted) {
      res.reason = this.halted;
      return res;
    }

    // 4. Reserve the cost and the loss at once (no await since the decision), then send and wait.
    const reservation = this.ledger.reserve(
      a.job,
      quote.costUsd,
      decision.kind === "loss" || decision.kind === "unpaid" ? quote.lossUsd : 0,
      costWei,
    );
    const ceilingWei = ceiling != null && Number.isFinite(ceiling * 1e9) ? BigInt(Math.floor(ceiling * 1e9)) : null;
    try {
      return await this.send(a, lane, gas, baseFee, ceilingWei, ethUsd, quote, decision, res, reservation);
    } finally {
      this.ledger.release(reservation); // a no-op once the send's entry is recorded
    }
  }

  private async send(
    a: Action,
    lane: Lane,
    gas: bigint,
    baseFee: bigint,
    ceiling: bigint | null,
    ethUsd: number,
    quote: Quote,
    decision: Decision,
    res: ActionResult,
    reservation: Reservation,
  ): Promise<ActionResult> {
    const g = this.cfg.gas;
    // The multipliers are config floats, so both limits are scaled in double precision and truncated.
    const gasLimit = BigInt(Math.trunc(Number(gas) * g.gasLimitMultiplier)) + 10_000n;
    const scaledFee = BigInt(Math.trunc(Number(baseFee) * g.feeMultiplier));
    let maxFee = scaledFee > baseFee + 1n ? scaledFee : baseFee + 1n;
    // A ceiling caps what the transaction may pay per gas, not only the base fee it is sent at.
    if (ceiling !== null && maxFee > ceiling) maxFee = ceiling > baseFee ? ceiling : baseFee;
    let txHash: Hex | null = null;
    /** set when the send got no answer: the transaction may or may not have gone out */
    let unclear: unknown = null;
    for (let attempt = 0; attempt < 2 && txHash === null; attempt++) {
      const wait = lane.lock.acquire();
      if (wait) await wait;
      try {
        // The last moment before the call is signed: planning, the simulation and the wallet's queue
        // all took time, and a price outside the pair's window on inclusion reverts the call.
        const aged = this.priceAge(a);
        if (aged !== null) {
          res.status = "skipped";
          res.priceAged = true;
          res.reason = aged;
          return res;
        }
        if (lane.nonce === null) lane.nonce = await this.chain.nonce(lane.address, "pending");
        const tx: TxRequest = {
          type: "eip1559",
          chainId: this.chainId,
          nonce: lane.nonce,
          to: a.target,
          value: a.value,
          data: a.data,
          gas: gasLimit,
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: 0n,
        };
        let raw: Hex;
        try {
          raw = await lane.signer.sign(tx);
        } catch (e) {
          lane.nonce = null; // nothing went out; the next send re-reads the nonce all the same
          throw e;
        }
        // Tracked by the hash of the bytes signed, never by what the node answers.
        const hash = keccak256(raw);
        let answered: unknown = hash;
        try {
          answered = await this.chain.sendRaw(raw);
          txHash = hash;
          lane.nonce += 1;
        } catch (e) {
          // Whatever went wrong, the next send re-reads the nonce.
          lane.nonce = null;
          if (e instanceof TypeError) {
            // Chain.sendRaw refuses bytes it cannot send before anything leaves: nothing went out, so
            // the reservation is released and the candidate's keys are not held.
            res.status = "skipped";
            res.reason = `not sent: ${e.message}`;
            return res;
          } else if (!(e instanceof RpcError)) {
            // No settled answer (Chain.sendRaw's SendError: a timeout, a dropped connection, an odd
            // answer): the transaction may be out. It is never signed again: its receipt decides,
            // and without one it is booked as unknown.
            txHash = hash;
            unclear = e;
            if (e instanceof SendError && e.hash.toLowerCase() !== hash) {
              log.warning("%s: the send's error names transaction %s, not %s; tracking %s", a.job, e.hash, hash, hash);
            }
          } else if (KNOWN.test(e.rpcMessage)) {
            txHash = hash; // the node holds this very transaction
          } else if (NONCE_TAKEN.test(e.rpcMessage) && (await this.onChain(hash))) {
            txHash = hash; // its nonce went to this very transaction: an earlier copy of the send got through
          } else if (attempt === 0 && RETRYABLE.test(e.rpcMessage)) {
            continue;
          } else {
            res.status = "skipped";
            res.reason = `send refused: ${e.rpcMessage}`;
            return res;
          }
        }
        if (typeof answered !== "string" || answered.toLowerCase() !== hash) {
          log.warning("%s: the node answered %s for transaction %s; tracking it by its own hash", a.job, String(answered) || "nothing", hash);
        }
      } finally {
        lane.lock.release();
      }
    }
    if (txHash === null) return res; // unreachable: the second attempt returns or throws
    res.txHash = txHash;
    if (unclear === null) {
      this.emit("sent", [a, txHash]);
      log.info("%s %s: sent %s (%s)", a.job, res.market || "-", txHash, decision.reason);
    } else {
      log.warning(
        "%s %s: the send of %s got no answer (%s); waiting for its receipt before anything else is decided about it",
        a.job,
        res.market || "-",
        txHash,
        unclear instanceof Error ? unclear.message : String(unclear),
      );
    }
    const receipt = await this.waitForReceipt(txHash);
    if (receipt === null) {
      res.status = "unknown";
      res.reason =
        unclear === null
          ? "no receipt within the timeout; the nonce is re-read before the next send"
          : "the send got no answer and no receipt showed up: it may have gone out, so it is booked at its estimated cost";
      lane.nonce = null;
      // It may still land: its candidate stays locked meanwhile, and its estimated cost stays booked.
      this.hold(a.locks);
      this.record(a, lane, res, quote.costWei, reservation);
      if (unclear !== null) {
        this.emit("alert", [
          "endpointDown",
          `${a.job} ${res.market || "-"}: the send endpoint gave no answer and transaction ${txHash} has no receipt; ` +
            "booked as unknown at its estimated cost",
        ]);
      }
      return res;
    }
    const ok = receipt.status === "success";
    res.gasUsed = receipt.gasUsed;
    const price = receipt.effectiveGasPrice > 0n ? receipt.effectiveGasPrice : baseFee;
    const gasWei = res.gasUsed * price;
    res.costUsd = this.usd(gasWei, ethUsd);
    let reward = 0n;
    let claimed = 0n;
    const me = lane.address.slice(2).toLowerCase();
    const rewardPair = a.rewardPair ? a.rewardPair.toLowerCase() : null;
    for (const lg of receipt.logs) {
      const topics = lg.topics;
      if (topics.length < 3) continue;
      // the recipient: the low 20 bytes of the second indexed topic
      if (topics[2]!.slice(-40).toLowerCase() !== me) continue;
      const word = lg.data.slice(2, 66);
      const amount = word ? BigInt("0x" + word) : 0n;
      if (topics[0] === FEE_ACCRUED && (rewardPair === null || lg.address.toLowerCase() === rewardPair)) reward += amount;
      else if (topics[0] === FEES_CLAIMED) claimed += amount;
    }
    res.rewardUsd = Number(reward) / BAZAAR_ONE;
    res.claimedUsd = Number(claimed) / BAZAAR_ONE;
    res.status = ok ? "confirmed" : "reverted";
    if (!ok) res.reason = "the transaction reverted on chain (state changed after the simulation)";
    this.noteOutcome(a.job, res.market, !ok);
    // The ETH that left the wallet: the gas, and the value the call carried unless it reverted.
    this.record(a, lane, res, ok ? gasWei + a.value : gasWei, reservation);
    this.emit("action", res);
    return res;
  }

  /**
   * Why `a` must not be signed now, or null: the price it relies on is older, at the chain's time
   * now, than the pair's 3 s window less `prices.sendMarginSeconds`, the margin left for the call to
   * be included.
   */
  private priceAge(a: Action): string | null {
    if (a.priceTime === null) return null;
    const limit = MAX_PRICE_STALENESS - this.cfg.prices.sendMarginSeconds;
    const age = this.clock() - a.priceTime;
    if (age <= limit) return null;
    return (
      `not sent: the price it relies on is from second ${a.priceTime}, ${age.toFixed(1)} s before the chain's time now, past the ` +
      `${fmtG(limit)} s a call may carry (the pair's 3 s window less prices.sendMarginSeconds); planned again with a newer price`
    );
  }

  /**
   * Whether the transaction `hash` is on chain, looked up a few times over a few seconds (the node
   * that answered the send may be ahead of the one that serves receipts). Only on the error path.
   */
  private async onChain(hash: Hex): Promise<boolean> {
    for (let i = 0; i <= this.recheckDelaysMs.length; i++) {
      try {
        if ((await this.chain.receipt(hash)) !== null) return true;
      } catch {
        // not an answer: look again
      }
      if (i < this.recheckDelaysMs.length) await sleep(this.recheckDelaysMs[i]!);
    }
    return false;
  }

  /**
   * Poll for the receipt until `timeoutS` passes. A failed poll counts as "not yet": the transaction
   * was sent, so it must reach the ledger whatever the RPC does meanwhile.
   */
  async waitForReceipt(txHash: Hex, timeoutS = this.receiptTimeoutS): Promise<Receipt | null> {
    const deadline = performance.now() + timeoutS * 1000;
    let delay = 250;
    while (performance.now() < deadline) {
      let r: Receipt | null = null;
      try {
        r = await this.chain.receipt(txHash);
      } catch (e) {
        if (!(e instanceof RpcError)) log.debug("receipt poll for %s failed: %s", txHash, e);
      }
      if (r !== null) return r;
      await sleep(delay);
      delay = Math.min(2000, delay * 1.5);
    }
    return null;
  }

  /** Book a sent call: its reservation turns into its entry, in one step. */
  private record(a: Action, lane: Lane, res: ActionResult, costWei: bigint, reservation: Reservation): void {
    this.ledger.release(reservation);
    this.ledger.record(
      new Entry({
        ts: Date.now() / 1000,
        job: a.job,
        market: res.market,
        wallet: lane.address,
        tx: res.txHash,
        status: res.status,
        kind: res.kind,
        costUsd: res.costUsd,
        rewardUsd: res.rewardUsd,
        expectedRewardUsd: res.expectedRewardUsd,
        claimedUsd: res.claimedUsd,
        gasUsed: res.gasUsed,
        summary: a.summary,
        costWei,
      }),
    );
  }
}
