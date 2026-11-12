/** Follow the chain's logs for the factory, the terminator and every market. */

import { type Chain, HttpError, type RawLog, RpcError } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import { Effects, type Store } from "../state/store.js";

/** blocks re-read when the stored head's hash no longer matches the chain */
export const REORG_REWIND = 64;
/** requests in a row that succeed at a reduced range before trying one twice as wide */
export const REGROW_AFTER = 8;

/** Where the tail reports what it does. `console` fits; the default prints warnings only. */
export interface TailLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const QUIET: TailLogger = {
  info() {},
  warn: (msg) => console.warn(msg),
};

/** The contracts the tail follows besides the markets (the SDK's Deployment fits). */
export interface TailDeployment {
  readonly factory: Address;
  readonly terminator: Address;
}

/**
 * Whether the node answered and turned the request down, as providers do when a log query spans too
 * many blocks or would return too many logs. A connection failure or a timeout is not a refusal.
 */
export function refused(e: unknown): boolean {
  if (e instanceof RpcError) return true;
  // The SDK's HttpError, or a transport's own error carrying the HTTP status (viem's HttpRequestError).
  const status = e instanceof HttpError ? e.status : e instanceof Error ? (e as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

const byPosition = (x: RawLog, y: RawLog) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LogTail {
  /**
   * What the chunks applied by an advance() that then failed changed; the advance that completes
   * returns it.
   */
  private pending: Effects | null = null;
  /** Blocks a log request asks for after the node refused a wider range; null asks for `chunk`. */
  private size: number | null = null;
  /** Requests in a row that succeeded at the full reduced size. */
  private run = 0;
  /** Whether a refusal has been logged. */
  private toldRefusal = false;

  constructor(
    public chain: Pick<Chain, "logs" | "block">,
    public store: Store,
    public dep: TailDeployment,
    public wallets: ReadonlySet<Address>,
    public chunk = 2_000,
    public log: TailLogger = QUIET,
  ) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  private async checkReorg(): Promise<boolean> {
    if (!this.store.headHash || this.store.head < 0) return false;
    const b = await this.chain.block(this.store.head);
    if (b.hash === this.store.headHash) return false;
    this.log.warn(`chain reorganized below block ${this.store.head}; re-reading the last ${REORG_REWIND} blocks`);
    this.store.head = Math.max(-1, this.store.head - REORG_REWIND);
    this.store.headHash = "";
    return true;
  }

  /**
   * Apply the logs of `addresses` from `fromBlock` to `toBlock`, at most `chunk` blocks a request.
   *
   * A range the node refuses is halved and asked for again, down to one block. The reduced range
   * carries over to later scans: a provider with a fixed block limit would otherwise refuse the first
   * request of every tick. After REGROW_AFTER requests in a row succeed at the full reduced range it
   * tries one twice as wide, since a refusal for too many logs may have been one busy stretch. Only
   * the first refusal is logged; the later ones are those wider tries. With `trackHead`, store.head
   * moves to the end of each chunk as it is applied, so a failure part-way leaves what was applied
   * recorded.
   */
  async scan(
    fromBlock: number,
    toBlock: number,
    addresses: readonly Address[],
    opts: { fx?: Effects; trackHead?: boolean } = {},
  ): Promise<Effects> {
    const fx = opts.fx ?? new Effects();
    if (fromBlock <= toBlock && fx.firstBlock === null) fx.firstBlock = fromBlock;
    const { store, wallets } = this;
    const { factory, terminator } = this.dep;
    let start = fromBlock;
    while (start <= toBlock) {
      const size = Math.min(this.size ?? this.chunk, this.chunk);
      const end = Math.min(toBlock, start + size - 1);
      let logs: RawLog[];
      try {
        logs = await this.chain.logs(start, end, addresses);
      } catch (e) {
        if (end === start || !refused(e)) throw e;
        this.size = Math.max(1, Math.floor((end - start + 1) / 2));
        this.run = 0;
        if (!this.toldRefusal) {
          this.toldRefusal = true;
          this.log.info(
            `the node refused logs for ${end - start + 1} blocks (${errorText(e)}); asking for ${this.size} at a time. ` +
              "A lower rpc.logChunk avoids the refused requests",
          );
        }
        continue;
      }
      logs.sort(byPosition);
      for (const lg of logs) store.applyRaw(lg, wallets, factory, terminator, fx);
      if (opts.trackHead) {
        store.head = end;
        store.headHash = "";
      }
      const width = end - start + 1;
      start = end + 1;
      // A short request (the end of the range) says nothing about whether the full size still works.
      if (this.size === null || this.size >= this.chunk || width < size) continue;
      this.run += 1;
      if (this.run >= REGROW_AFTER) {
        this.size = Math.min(this.chunk, this.size * 2);
        this.run = 0;
      }
    }
    return fx;
  }

  /**
   * Apply the logs after store.head up to `toBlock`, and return what they changed.
   *
   * Progress is recorded after each chunk, so after a request fails the next call resumes past the
   * last applied chunk instead of replaying it: fills and bounty movements are deltas and would count
   * twice. What the applied chunks changed is kept and returned by the call that completes, with
   * firstBlock where the catch-up began.
   */
  async advance(toBlock: number): Promise<Effects> {
    const fx = this.pending ?? new Effects();
    this.pending = fx;
    if (await this.checkReorg()) for (const a of this.store.markets.keys()) fx.dirty.add(a);
    const start = this.store.head + 1;
    if (start <= toBlock) {
      const addresses = [this.dep.factory, this.dep.terminator, ...this.store.markets.keys()];
      await this.scan(start, toBlock, addresses, { fx, trackHead: true });
      this.store.headHash = (await this.chain.block(toBlock)).hash;
    }
    this.pending = null;
    return fx;
  }
}
