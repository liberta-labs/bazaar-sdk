// UMA assertions: where one stands, disputing it, previewing and settling it.
import { Bazaar, type RawLog, errorMessage, uma } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
// A listing's or identifier upgrade's assertion id; for a termination claim pass home: "terminator".
const assertionId: Hex = "0x4444444444444444444444444444444444444444444444444444444444444444";

// ANCHOR: status
const st = await bz.uma.assertionStatus(assertionId, { home: "factory" });
console.log(uma.ASSERTION_PHASE_TEXT[st.phase]);
if (st.phase === "liveness") {
  console.log(`Disputable until ${uma.timeText(st.disputableUntil!)}; settleable from ${uma.timeText(st.canSettleAt!)}.`);
}
if (st.assertion) {
  console.log(`bond ${uma.usdcText(st.assertion.bond)}, asserter ${st.assertion.asserter}, identifier ${uma.identifierText(st.assertion.identifier)}`);
}
// ANCHOR_END: status

// ANCHOR: dispute
try {
  const dispute = await bz.uma.disputeAssertion({ assertionId, from: user, home: "factory" });

  // The confirmation screen: the bond, what it wins or loses, and any warning.
  console.log(dispute.summary);
  for (const cost of dispute.costs) console.log(`${cost.label}: ${uma.usdcText(cost.amount)}. ${cost.returned}`);
  for (const line of [...dispute.requires, ...dispute.notes]) console.log(line);

  // The oracle pulls the bond with transferFrom: approve it first (exactly the bond), then dispute.
  for (const approval of dispute.approvals) await bz.waitForReceipt(await bz.send(window.ethereum, approval));
  const sim = await bz.simulate(dispute);
  if (!sim.ok) throw new Error(sim.error!.message);
  await bz.waitForReceipt(await bz.send(window.ethereum, dispute));
} catch (e) {
  console.error(errorMessage(e)); // "assertionId: UMA's dispute window closed at ...", a revert, a rejection
}
// ANCHOR_END: dispute

// ANCHOR: preview
// For a disputed assertion this is the only way to see whether UMA's voters have ruled, and how.
const pv = await bz.uma.previewSettlement(assertionId, { home: "factory", from: user });
if (pv.settleable) console.log(pv.result ? "Settling now accepts the claim." : "Settling now rejects the claim.");
else console.log(`Cannot settle yet: ${pv.error?.message}`); // UMA's oracle reverts until the DVM rules
// ANCHOR_END: preview

// ANCHOR: settle
if (pv.settleable) {
  const settle = await bz.uma.settleAssertion({ assertionId, from: user, home: "factory" });
  await bz.waitForReceipt(await bz.send(window.ethereum, settle));
}
// ANCHOR_END: settle

// ANCHOR: logs
function describeOracleLog(log: RawLog): string | null {
  const d = uma.decodeAssertionLog(log); // AssertionMade, AssertionDisputed, AssertionSettled
  return d ? (uma.ASSERTION_EVENT_TEXT[d.name] ?? null) : null;
}
// ANCHOR_END: logs
void describeOracleLog;
