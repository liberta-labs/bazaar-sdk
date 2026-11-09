/** Manual operations that are available right now, each confirmed by a simulation. */

import { ORACLE_DEAD_THRESHOLD, SubgraphError, TERMINAL_SETTLEMENT_ESCAPE, factory as factoryCodec } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import type { ActionResult } from "../../exec/executor.js";
import { safeLabel } from "../../observe/logs.js";
import type { Keeper } from "../engine.js";

const FACTORY = factoryCodec();
const ZERO32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * A manual operation someone could run: what, where (a market's label, for people), why, and the CLI
 * command that runs it (naming the market by its address, and only ids checked to be ids).
 */
export class Opportunity {
  constructor(
    readonly operation: string,
    readonly market: string,
    readonly detail: string,
    readonly command: string,
    readonly ready: boolean = true,
    /** for one not ready yet, when it opens (seconds since the epoch) */
    readonly opensAt: number | null = null,
  ) {}

  describe(): string {
    let when: string;
    if (this.ready) when = "ready now";
    else if (this.opensAt) {
      const iso = new Date(this.opensAt * 1000).toISOString();
      when = `opens at ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    } else when = "not ready";
    return `${this.operation} ${this.market}: ${this.detail} (${when}) — bazaar keeper ${this.command}`;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const idOf = (v: unknown): string => str((v as Row | null | undefined)?.id);

/**
 * What goes into a suggested command is checked first: the subgraph's rows are not verified, and a
 * command is made to be pasted into a shell. A bytes32 id, lowercase, or null.
 */
const bytes32 = (v: unknown): Hex | null => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as Hex) : null);
/** A checksummed address, or null. */
const address = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);

/**
 * Every manual operation that a dry run shows would go through now, or that a "too early" revert
 * shows will open later: scheduled cutoffs, finalizations, dead oracles, and (with a subgraph) open
 * termination claims, insurer votes, listings and identifier upgrades.
 */
export async function findOpportunities(k: Keeper): Promise<Opportunity[]> {
  const ops = k.run;
  await ops.ready();
  const markets = [...k.store.markets.values()];
  await k.readStates(true, markets);
  const now = k.now();
  const out: Opportunity[] = [];

  const check = async (operation: string, market: string, detail: string, command: string, run: () => Promise<ActionResult>): Promise<void> => {
    const res = await run();
    if (res.status === "simulated") out.push(new Opportunity(operation, market, detail, command));
    else if (res.opensAt) out.push(new Opportunity(operation, market, detail, command, false, res.opensAt));
  };

  for (const m of markets) {
    const st = m.state;
    if (st === null) continue;
    // Shown by its label, named by its address: labels are neither unique nor verified.
    const name = safeLabel(m.label) || m.address;
    const at = m.address;
    if (st.scheduledTs && !st.settlementFixedTs && now > st.scheduledTs) {
      await check("terminateScheduledPair", name, "its scheduled cutoff has passed", `run terminate-scheduled --market ${at}`, () =>
        ops.terminateScheduledPair(m.address, { dryRun: true }),
      );
    }
    if (st.settlementFixedTs && !st.terminated && ((st.longOi === 0n && st.shortOi === 0n) || now >= st.settlementFixedTs + TERMINAL_SETTLEMENT_ESCAPE)) {
      await check(
        "finalizeTermination",
        name,
        "every position is settled, or the escape hatch has opened",
        `run finalize --market ${at}`,
        () => ops.finalizeTermination(m.address, { dryRun: true }),
      );
    }
    if (!st.settlementFixedTs && st.updateTs && now - st.updateTs > ORACLE_DEAD_THRESHOLD) {
      await check("terminateStalePair", name, "its stored price is more than 21 days old", `run terminate-stale --market ${at}`, () =>
        ops.terminateStalePair(m.address, { dryRun: true }),
      );
    }
  }

  if (k.subgraph !== null) {
    let props: Record<string, Row[]>;
    try {
      props = await k.subgraph.proposals();
    } catch (e) {
      if (!(e instanceof SubgraphError)) throw e;
      props = {};
    }
    // Rows whose ids are not ids are skipped: an id goes into a command, and into the dry run.
    const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => r !== null && typeof r === "object") : []);
    const marketName = (a: Address | null): string => (a === null ? "an unknown market" : safeLabel(k.store.markets.get(a)?.label ?? "") || a);
    for (const p of rows(props.terminationProposals)) {
      const id = bytes32(p.id);
      if (id !== null && Number(p.livenessEndsAt) <= now) {
        await check(
          "settleTerminationProposal",
          marketName(address(idOf(p.pair))),
          "the claim's liveness has ended",
          `run settle-termination --assertion ${id}`,
          () => ops.settleTerminationProposal(id, { dryRun: true }),
        );
      }
    }
    for (const p of rows(props.insurerProposals)) {
      const pairAt = address(idOf(p.pair));
      const id = bytes32(p.id);
      if (pairAt === null || id === null) continue;
      await check(
        "executeInsurerTermination",
        marketName(pairAt),
        "the vote can be resolved",
        `run execute-insurer-termination --market ${pairAt} --proposal ${id}`,
        () => ops.executeInsurerTermination(pairAt, id, { dryRun: true }),
      );
    }
    for (const p of rows(props.listingProposals)) {
      const id = bytes32(p.id);
      const pairId = bytes32(p.pairId);
      if (id !== null && pairId !== null && Number(p.livenessEndsAt) <= now) {
        const name = safeLabel(str(p.description), 24) || pairId;
        await check("settleDeploymentProposal", name, "the listing's liveness has ended", `run settle-listing --assertion ${id}`, () =>
          ops.factory.settleDeploymentProposal(id, { dryRun: true }),
        );
        await check("expireStuckDeploymentProposal", name, "the listing cannot settle", `run expire-listing --pair-id ${pairId}`, () =>
          ops.factory.expireStuckDeploymentProposal(pairId, { dryRun: true }),
        );
      }
    }
  }
  const dep = k.dep!;
  const pending = FACTORY.decode<Hex>(
    "pendingIdentifierUpgradeAssertionId",
    await k.chain.call(dep.factory, FACTORY.encode("pendingIdentifierUpgradeAssertionId")),
  );
  if (pending.toLowerCase() !== ZERO32) {
    await check(
      "settleIdentifierUpgradeProposal",
      "factory",
      "an identifier upgrade is pending",
      `run settle-identifier-upgrade --assertion ${pending}`,
      () => ops.factory.settleIdentifierUpgradeProposal(pending, { dryRun: true }),
    );
    await check("expireStuckIdentifierUpgradeProposal", "factory", "the pending upgrade cannot settle", "run expire-identifier-upgrade", () =>
      ops.factory.expireStuckIdentifierUpgradeProposal({ dryRun: true }),
    );
  }
  const queued = FACTORY.decode<{ effectiveTs?: bigint }>(
    "queuedIdentifierUpgrade",
    await k.chain.call(dep.factory, FACTORY.encode("queuedIdentifierUpgrade")),
  );
  if (queued.effectiveTs) {
    await check("activateIdentifierUpgrade", "factory", "an approved identifier upgrade is queued", "run activate-identifier-upgrade", () =>
      ops.factory.activateIdentifierUpgrade({ dryRun: true }),
    );
  }
  return out;
}
