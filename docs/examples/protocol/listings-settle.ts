// After a listing is proposed: where it stands, settling it, releasing a stuck one, the seed refund,
// and reading listings from the chain's events and the subgraph.
import { Bazaar, type RawLog, errorMessage, listings, uma } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
  subgraph: "https://subgraph.example.com/bazaar", // for listingProposals
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const assertionId: Hex = "0x4444444444444444444444444444444444444444444444444444444444444444"; // from listingFromReceipt
const pairId: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111"; // = the proposal's baseFeedId

// ANCHOR: status
const p = await bz.listings.deploymentProposal(assertionId);
if (!p) {
  console.log("The factory has no listing with this id.");
} else {
  switch (p.status) {
    case "inReview":
      console.log(`Disputable until ${uma.timeText(p.livenessEndsAt)}.`);
      break;
    case "settleable":
      console.log("Past its liveness without a dispute: anyone can settle it now.");
      break;
    case "disputed":
      console.log("Disputed: UMA's voters decide it.");
      break;
    case "deployed":
      console.log(`Deployed as pair id ${p.pairId}.`);
      break;
    case "notDeployed":
      console.log("Rejected, voided or released: the seed was credited back.");
      break;
  }
}

// The listing pending for an asset, by pair id or by feed (which also finds a composite of the same asset).
const pending = await bz.listings.pendingDeployment({ baseFeedId: pairId });
// ANCHOR_END: status

// ANCHOR: open
// fromBlock is used only without a subgraph: no listing can be older than the factory's deployment block.
const open = await bz.listings.openListings({ fromBlock: 250_000_000 });
for (const l of open.listings) {
  console.log(l.description, l.status, uma.timeText(l.livenessEndsAt)); // render the description as text, never HTML
}
// ANCHOR_END: open

// ANCHOR: settle
try {
  const settle = await bz.listings.settleDeploymentProposal({ assertionId, from: user });
  console.log(settle.notes[0]); // what settling will do: deploy, void, or wait on UMA's voters
  const sim = await bz.simulate(settle);
  if (!sim.ok) console.error(sim.error!.message); // a disputed listing the DVM has not ruled on yet
  else await bz.waitForReceipt(await bz.send(window.ethereum, settle));
} catch (e) {
  console.error(errorMessage(e)); // "assertionId: UMA's liveness window is still open: ..."
}
// ANCHOR_END: settle

// ANCHOR: expire
if (pending && pending.status !== "inReview") {
  try {
    // Takes the pair id, not the assertion id: it frees the asset's listing slot.
    const release = await bz.listings.expireStuckDeploymentProposal({ pairId, from: user });
    const sim = await bz.simulate(release);
    if (sim.ok) await bz.waitForReceipt(await bz.send(window.ethereum, release));
    else console.error(sim.error!.message);
  } catch (e) {
    console.error(errorMessage(e)); // "pairId: This listing cannot be released before 2026-11-24 14:00:00 UTC."
  }
}
// ANCHOR_END: expire

// ANCHOR: refund
const owed = await bz.listings.seedRefundOwed(user); // USDC units, 6 decimals
if (owed > 0n) {
  const claim = await bz.listings.claimSeedRefund({ from: user });
  console.log(claim.summary); // "Withdraw your 4,000 USDC listing seed refund"
  await bz.waitForReceipt(await bz.send(window.ethereum, claim));
}
// ANCHOR_END: refund

// ANCHOR: history
const page = await bz.history.listingProposals({ status: ["Pending", "Disputed"], first: 50 });
for (const l of page.items) {
  console.log(l.description, l.status, uma.timeText(l.livenessEndsAt)); // render the description as text, never HTML
}
// page.next is the cursor for the next page: pass it as `after`.
// ANCHOR_END: history

// ANCHOR: events
function describeFactoryLog(log: RawLog): string | null {
  const d = listings.decodeFactoryLog(log);
  return d ? (listings.LISTING_EVENT_TEXT[d.name] ?? null) : null;
}
// ANCHOR_END: events
void describeFactoryLog;
