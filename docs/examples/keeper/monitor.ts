// A watchdog for a keeper running elsewhere: read its status.json and exit non-zero when it is unwell.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type KeeperStatus, loadConfig, stateDirFor } from "@liberta-labs/bazaar-keeper";

// ANCHOR: monitor
// The same directory the keeper writes to: <state.dir>/keeper/<chainId>-<first 8 hex digits of the factory>.
const cfg = loadConfig("/srv/keeper/bazaar-keeper.yaml");
const path = join(stateDirFor(cfg), "status.json");

const problems: string[] = [];
let s: KeeperStatus | null = null;
try {
  s = JSON.parse(readFileSync(path, "utf8")) as KeeperStatus;
} catch (e) {
  problems.push(`no readable status at ${path}: ${e instanceof Error ? e.message : String(e)}`);
}
if (s) {
  const age = Date.now() / 1000 - s.updated; // the keeper rewrites the file every 5 s
  if (age > 30) problems.push(`status is ${Math.round(age)} s old: the keeper is not running`);
  if (!s.prices.healthy) problems.push(`prices down: ${s.prices.error || "no print yet"}`);
  if (s.halted) problems.push(s.halted); // e.g. a wallet below budget.minEthBalance
  if (s.block - s.indexed > 64) problems.push(`the index is ${s.block - s.indexed} blocks behind the head`);
  // Not a problem in itself, but worth a look: positions close to their maintenance requirement.
  for (const m of s.markets) if (m.atRisk) console.log(`${m.label} (${m.address}): ${m.atRisk} position(s) near liquidation`);
}
for (const p of problems) console.error(p);
process.exitCode = problems.length ? 1 : 0;
// ANCHOR_END: monitor
