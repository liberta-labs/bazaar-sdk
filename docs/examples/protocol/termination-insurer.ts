// Ending a market by insurer vote: a bare proposal, voting shares, and executing the vote.
import { Bazaar, CallError, type Receipt, errorMessage, parseUnits18, termination, uma } from "@liberta-labs/bazaar-sdk";
import type { Address, Hex } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const aapl = await bz.markets.getMarket("AAPL/USD");

// As in the UMA example: show the costs, send the approvals, simulate, send.
async function sendCosted(call: uma.CostedCall): Promise<Receipt> {
  for (const n of [call.summary, ...call.requires, ...call.notes]) console.log(n);
  for (const a of call.approvals) await bz.waitForReceipt(await bz.send(window.ethereum, a));
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
  return bz.waitForReceipt(await bz.send(window.ethereum, call));
}

// ANCHOR: propose
// A bare proposal: a cutoff 2 hours to 14 days out, a fixed 1,000 USDC bond, no UMA claim behind it.
const now = await bz.uma.chainNow();
const proposal = await bz.termination.proposeInsurerTermination({ pair: aapl.address, cutoffTs: now + 2 * 86_400, from: user! });
const receipt = await sendCosted(proposal);
const id = bz.termination.proposalIdsFromReceipt(receipt).insurerProposalId!;
// ANCHOR_END: propose

// ANCHOR: read
const p = await bz.termination.insurerProposal(id);
if (p) {
  console.log(`${p.state}: ${uma.sharesText(p.yesShares)} of ${uma.sharesText(p.thresholdShares)} needed`);
  console.log(`voting ${uma.timeText(p.windowOpenTs)} to ${uma.timeText(p.votingClosesAt)}; cutoff ${uma.timeText(p.cutoffTs)}`);
  console.log(p.claimBacked ? "Backed by a UMA claim." : "A bare vote: it settles under the chain rule.");
}
const mine = await bz.termination.getLockedShares({ pair: aapl.address, user: user! });
console.log(`your shares locked by live votes: ${uma.sharesText(mine)}`);
// ANCHOR_END: read

// ANCHOR: vote
try {
  const vote = await bz.termination.voteForInsurerTermination({ pair: aapl.address, id, shares: parseUnits18("100"), from: user! });
  // costs: the lock on the voted shares, and (contingent) the worst-case levy if this vote ends the market.
  for (const c of vote.costs) console.log(`${c.label}: ${uma.sharesText(c.amount)}${c.contingent ? " at worst" : ""}. ${c.returned}`);
  await sendCosted(vote);
} catch (e) {
  console.error(errorMessage(e));
}
// ANCHOR_END: vote

// ANCHOR: execute
async function executeVote(voteId: Hex): Promise<string> {
  const call = await bz.termination.executeInsurerTermination({ pair: aapl.address, id: voteId, from: user! });
  // outcome: "schedule" | "preempted" | "voided" | "failedRefund" | "failedForfeit"
  console.log(call.outcome, call.notes[0]);
  await sendCosted(call);
  return call.outcome;
}

console.log(await executeVote(id).catch(errorMessage));
// The levy an unjudged outcome would charge, for a vote that ended at 70% yes:
console.log(`${termination.unjudgedLevyBp(1_000n, 700n)} bp`); // 1500 bp: half the 30% that did not vote yes
// ANCHOR_END: execute
