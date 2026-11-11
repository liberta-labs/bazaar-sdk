// The UMA identifier governance track: the status, proposing an upgrade, settling, activating, releasing.
import { Bazaar, errorMessage, governance, uma } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];

// ANCHOR: status
const g = await bz.governance.identifierGovernance();
console.log(`in force: ${g.umaIdentifierText}, live on UMA's whitelist: ${g.umaIdentifierIsLive}`);
if (g.pending) {
  console.log(`proposed: ${g.pending.newIdentifierText}, ${uma.ASSERTION_PHASE_TEXT[g.pending.assertion.phase]}`);
}
if (g.queued) {
  console.log(`queued: ${g.queued.newIdentifierText}, activation opens ${uma.timeText(g.queued.activationOpensAt)}`);
  if (g.queued.newIdentifierWhitelisted === false) console.log("UMA has removed it since: activating cancels the upgrade.");
}
// ANCHOR_END: status

// ANCHOR: monitor
// One read to alarm on: false means new listings and UMA termination claims are refused.
if (!(await bz.governance.umaIdentifierIsLive())) {
  console.warn("Bazaar's UMA identifier is off UMA's whitelist: an identifier upgrade is needed.");
}
// ANCHOR_END: monitor

// ANCHOR: propose
try {
  const call = await bz.governance.proposeUmaIdentifierUpgrade({ newIdentifier: "ASSERT_TRUTH3", from: user });
  console.log(call.summary); // "... posts a 5,000 USDC bond, returned if UMA approves, lost to a disputer if it rejects"
  for (const line of [...call.requires, ...call.notes]) console.log(line);

  for (const approval of call.approvals) await bz.waitForReceipt(await bz.send(window.ethereum, approval));
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new Error(sim.error!.message);
  await bz.waitForReceipt(await bz.send(window.ethereum, call));
} catch (e) {
  console.error(errorMessage(e)); // "newIdentifier: That identifier is not on UMA's live whitelist."
}
// ANCHOR_END: propose

// ANCHOR: settle
const now = await bz.governance.identifierGovernance();
if (now.pending && now.pending.assertion.phase !== "liveness") {
  const settle = await bz.governance.settleIdentifierUpgradeProposal({ assertionId: now.pending.assertionId, from: user });
  const sim = await bz.simulate(settle);
  if (sim.ok) await bz.waitForReceipt(await bz.send(window.ethereum, settle));
  else console.error(sim.error!.message); // a disputed proposal the DVM has not ruled on
}
// ANCHOR_END: settle

// ANCHOR: activate
if (now.queued?.canActivate) {
  const activate = await bz.governance.activateIdentifierUpgrade({ from: user });
  console.log(activate.notes[0]); // what changes, or that the upgrade will be canceled
  await bz.waitForReceipt(await bz.send(window.ethereum, activate));
}
// ANCHOR_END: activate

// ANCHOR: expire
if (now.pending && now.now >= now.pending.releaseOpensAt) {
  const release = await bz.governance.expireStuckIdentifierUpgradeProposal({ from: user });
  const sim = await bz.simulate(release);
  if (sim.ok) await bz.waitForReceipt(await bz.send(window.ethereum, release));
}
// ANCHOR_END: expire

// ANCHOR: parse
governance.parseIdentifier("newIdentifier", "ASSERT_TRUTH3"); // "0x4153534552545f5452555448330000..."
governance.isAssertTruthIdentifier(uma.identifierFromText("ASSERT_TRUTH3")); // true
// ANCHOR_END: parse
