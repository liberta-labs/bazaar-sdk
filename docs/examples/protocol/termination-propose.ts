// Ending a market through UMA: checking the reason, proposing with a bond, and settling the claim.
import { Bazaar, CallError, type Receipt, errorMessage, formatDecimal, termination, uma } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const aapl = await bz.markets.getMarket("AAPL/USD");

// ANCHOR: costed
/** A cost as text, in its own unit. */
function costText(c: uma.Cost): string {
  if (c.unit === "USDC") return uma.usdcText(c.amount);
  if (c.unit === "ETH") return uma.ethText(c.amount);
  if (c.unit === "shares") return uma.sharesText(c.amount);
  return `${formatDecimal(c.amount, c.decimals ?? 18)} of token ${c.token}`;
}

/** Show what a costed call takes, send its approvals, simulate it, then send it. */
async function sendCosted(call: uma.CostedCall): Promise<Receipt> {
  console.log(call.summary);
  for (const c of call.costs) {
    console.log(`${c.label}: ${costText(c)}${c.contingent ? " (worst case)" : ""}. ${c.returned}`);
  }
  for (const r of call.requires) console.log(`Needs: ${r}`);
  for (const n of call.notes) console.log(n);
  // Approvals first (each for the exact amount): the call itself reverts until they land.
  for (const a of call.approvals) await bz.waitForReceipt(await bz.send(window.ethereum, a));
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
  return bz.waitForReceipt(await bz.send(window.ethereum, call));
}
// ANCHOR_END: costed

// ANCHOR: reason
// Validate as the user types: null means the terminator accepts the text.
const reason = "Delisting announced for 2026-12-01: https://example.com/notice?id=42";
const problem = termination.reasonProblem(reason);
if (problem) console.log(problem); // e.g. 'The character "[" is not allowed: ...'

// The four grounds, with a sentence each for a picker.
for (const [id, info] of Object.entries(termination.TERMINATION_CATEGORY_INFO)) {
  console.log(id, info.name, "-", info.description);
}
// ANCHOR_END: reason

// ANCHOR: propose
try {
  const now = await bz.uma.chainNow(); // the chain's clock, not the browser's
  const call = await bz.termination.proposeTermination({
    pair: aapl.address,
    category: termination.TerminationCategory.AssetCessation,
    lastTradingTs: now + 3 * 86_400, // at least 12 hours out, so UMA's acceptance alone enforces it
    reason,
    from: user!,
  });
  const receipt = await sendCosted(call);
  const { assertionId, insurerProposalId } = bz.termination.proposalIdsFromReceipt(receipt);
  console.log(`claim ${assertionId}; its insurer vote has the same id: ${insurerProposalId}`);
} catch (e) {
  console.error(e instanceof uma.BondQuoteError ? e.message : errorMessage(e));
}
// ANCHOR_END: propose

// ANCHOR: settle
async function settleClaim(assertionId: `0x${string}`): Promise<string> {
  const st = await bz.uma.assertionStatus(assertionId, { home: "terminator" });
  console.log(uma.ASSERTION_PHASE_TEXT[st.phase]);
  if (st.phase === "liveness") return `It can be settled from ${uma.timeText(st.canSettleAt!)}.`;
  if (st.phase !== "settleable" && st.phase !== "disputed") return "Nothing to settle.";
  const call = await bz.termination.settleTerminationProposal({ assertionId, from: user! });
  // A disputed claim settles only once UMA's voters have ruled: the simulation says whether they have.
  await sendCosted(call);
  const tp = await bz.termination.terminationProposal(assertionId);
  return tp?.resolved ? "Settled." : "Not resolved yet.";
}
// ANCHOR_END: settle

console.log(await settleClaim("0x0000000000000000000000000000000000000000000000000000000000000001").catch(errorMessage));
