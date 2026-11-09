/** Vault unload: sell the vault's liquidated inventory into the book. */

import { type Market, type ProbeResult, UNLOAD_FLOOR_DECAY, inventorySize, pair } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";
import type { UnloadJob as UnloadJobConfig } from "../../config/index.js";
import { type Action, lockKey } from "../../exec/executor.js";
import { fmtG } from "../../exec/policy.js";
import { Job, monotonic, units } from "./base.js";

const PAIR = pair();

function soldSomething(sim: ProbeResult): string | null {
  const size = sim.ret && sim.ret !== "0x" ? PAIR.decode<bigint>("unloadVault", sim.ret) : 0n;
  return size ? null : "the book has nothing the vault may sell into at this price";
}

export class UnloadJob extends Job<UnloadJobConfig> {
  override readonly name = "unload";
  /** market -> monotonic time of the next simulation */
  readonly nextCheck = new Map<Address, number>();

  /** Re-simulate at the next tick: the book or the inventory changed. */
  wake(market: Address): void {
    this.nextCheck.set(market, 0);
  }

  override async plan(m: Market): Promise<Action[]> {
    const st = m.state!;
    const held = inventorySize(st);
    if (held === 0n) return [];
    if ((this.nextCheck.get(m.address) ?? 0) > monotonic()) return [];
    const lock = lockKey("unload", m.address);
    if (this.k.executor.inflight.has(lock)) return [];
    const pc = this.priced(m); // against the stored price the walk sells nothing and pays nothing
    if (pc === null) return [];
    const mono = monotonic();
    let next = mono + this.cfg.recheckSeconds;
    // Bids past the band edge become fillable as the vault's floor slides toward them, so look again
    // when that slide completes even if nothing else changes.
    const now = this.k.now();
    for (const inv of [st.longInv, st.shortInv]) {
      if (inv.size && inv.seizedTs && now < inv.seizedTs + UNLOAD_FLOOR_DECAY) {
        next = Math.min(next, mono + (inv.seizedTs + UNLOAD_FLOOR_DECAY - now) + 1);
      }
    }
    this.nextCheck.set(m.address, next);
    const updates = pc.updates; // before the first await: the print the walk is priced at
    const fee = await this.k.reader.updateFee(updates);
    return [
      this.action(m, m.address, PAIR.encode("unloadVault", this.cfg.maxSteps, updates), `unload inventory (${fmtG(units(held))} units held)`, {
        value: fee,
        locks: [lock],
        rewardPair: m.address,
        requires: soldSomething,
      }),
    ];
  }
}
