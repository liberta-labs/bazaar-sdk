// Copy a Bazaar build's deployment record and MockArbSys artifact here, keeping only what the
// replay in ../chain.ts reads. See README.md.
//
//   node packages/keeper/test/e2e/fixtures/strip.mjs <bazaar-build>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2];
if (!root) {
  console.error("usage: node strip.mjs <bazaar checkout that ran the anvil deployment>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const record = read("broadcast/DeployBazaar.s.sol/31337/run-latest.json");
const transactions = record.transactions.map((t) => {
  const tx = t.transaction;
  const kept = { from: tx.from, gas: tx.gas, input: tx.input, nonce: tx.nonce };
  if (tx.to) kept.to = tx.to;
  if (tx.value) kept.value = tx.value;
  return { contractName: t.contractName ?? null, contractAddress: t.contractAddress ?? null, transaction: kept };
});
fs.writeFileSync(path.join(here, "run-latest.json"), JSON.stringify({ transactions }, null, 1) + "\n");

const arbsys = read("out/MockArbSys.sol/MockArbSys.json");
fs.writeFileSync(
  path.join(here, "MockArbSys.json"),
  JSON.stringify({ deployedBytecode: { object: arbsys.deployedBytecode.object } }, null, 1) + "\n",
);
console.log(`${transactions.length} transactions, ArbSys runtime ${(arbsys.deployedBytecode.object.length - 2) / 2} bytes`);
