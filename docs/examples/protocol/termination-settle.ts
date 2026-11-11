// Winding a market down: its status, fixing the settlement price, settling positions, finalizing,
// and withdrawing what a terminated market pays.
import { Bazaar, CallError, type PreparedCall, errorMessage, formatUnits18, pair as pairCodec, termination, uma } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
  prices: { token: pythToken }, // Pyth Pro also serves the archived one-second updates settlement needs
  subgraph: "https://subgraph.example.com", // optional: finds open proposals and open positions
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const aapl = await bz.markets.getMarket("AAPL/USD");

async function simulateAndSend(call: PreparedCall): Promise<void> {
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
  await bz.waitForReceipt(await bz.send(window.ethereum, call));
}

// ANCHOR: status
const s = await bz.termination.terminationStatus(aapl.address);
console.log(`phase: ${s.phase}`); // live | scheduled | limbo | settling | terminated
if (s.scheduledTerminationTs) console.log(`cutoff ${uma.timeText(s.scheduledTerminationTs)}; trading halts ${uma.timeText(s.haltsAt!)}`);
console.log(s.settlementRule.key, "-", s.settlementRule.meaning);
if (s.settlementPrice !== null) console.log(`settlement price ${formatUnits18(s.settlementPrice)}`);
if (s.finalizeOpensAt !== null) console.log(`finalize opens ${uma.timeText(s.finalizeOpensAt)}`);
for (const tp of s.openProposals.termination) console.log(`UMA claim ${tp.assertionId}: ${tp.categoryName}, cutoff ${uma.timeText(tp.lastTradingTs)}`);
for (const ip of s.openProposals.insurer) console.log(`vote ${ip.id}: ${ip.state}, ${uma.sharesText(ip.yesShares)} yes`);
// Without a subgraph, find the ids in the terminator's logs instead: terminationStatus(pair, { fromBlock }).
// ANCHOR_END: status

// ANCHOR: stale
try {
  // Only for a market whose oracle has been silent for more than 21 days.
  await simulateAndSend(await bz.termination.terminateStalePair({ pair: aapl.address, from: user! }));
} catch (e) {
  console.log(errorMessage(e)); // e.g. "pair: This market stored a price within the last 21 days: ..."
}
// ANCHOR_END: stale

// ANCHOR: scheduled
const plan = await bz.termination.terminateScheduledPair({ pair: aapl.address, from: user! });
if (plan.call) {
  console.log(`settles under ${plan.under} at ${formatUnits18(plan.settlementPrice!)} with ${plan.updates.length} update(s)`);
  for (const n of plan.call.notes) console.log(n);
  // Already simulated as `from`; its value is the Pyth fee (plan.call.costs), any excess refunded.
  await bz.waitForReceipt(await bz.send(window.ethereum, plan.call));
} else {
  console.log(plan.reason);
  for (const a of plan.attempts) console.log(`${a.under}: ${a.ok ? "accepted" : a.reason}`);
  if (plan.retryAt !== null) console.log(`try again from ${uma.timeText(plan.retryAt)}`);
}
// ANCHOR_END: scheduled

// ANCHOR: positions
// The SDK has no builder for settling positions in the settlement window: encode the pair's
// liquidate(accounts, []) directly. No price update and no ETH; each position you settle for
// someone else earns a $0.05 tip, claimable with claimFees.
async function settleOpenPositions(): Promise<void> {
  const accounts: Address[] = [];
  let after: string | null = null;
  do {
    const page = await bz.history.positions({ pair: aapl.address, openOnly: true, first: 1000, after });
    accounts.push(...page.items.map((p) => p.account));
    after = page.next;
  } while (after);
  for (let i = 0; i < accounts.length; i += 100) {
    const batch = accounts.slice(i, i + 100); // the keeper's default batch for this job
    await simulateAndSend({
      action: "liquidate",
      to: aapl.address,
      data: pairCodec().encode("liquidate", batch, []),
      value: 0n,
      from: user!,
      summary: `Settle ${batch.length} position(s) at the settlement price`,
    });
  }
}
if (s.phase === "settling") await settleOpenPositions();
// ANCHOR_END: positions

// ANCHOR: finalize
try {
  await simulateAndSend(await bz.termination.finalizeTermination({ pair: aapl.address, from: user! }));
} catch (e) {
  console.log(errorMessage(e)); // e.g. positions still open before the 14-day escape hatch
}
// ANCHOR_END: finalize

// ANCHOR: withdraw
const ent = await bz.termination.getTerminalEntitlement({ pair: aapl.address, account: user! });
if (!ent.finalized) {
  console.log("Not finalized yet: the payout ratios are not frozen.");
} else if (ent.payout > 0n) {
  console.log(`principal ratio ${formatUnits18(ent.principalRatio * 100n, 2)}%, profit ratio ${formatUnits18(ent.profitRatio * 100n, 2)}%`);
  console.log(`withdrawing everything pays ${formatUnits18(ent.payout, 2)} USDC`);
  // withdrawCollateral takes collateral units; the largest amount it accepts is the preview's maximum.
  const w = await bz.previews.previewWithdrawal(aapl.address, user!);
  await simulateAndSend(await bz.trade.withdrawCollateral(aapl.address, user!, w.maxWithdrawable));
}
// Tips and rewards (settlement tips, a UMA proposer's reward) are claimed separately:
await simulateAndSend(await bz.trade.claimFees(aapl.address, user!));
// ANCHOR_END: withdraw

console.log(termination.SETTLEMENT_RULE_TEXT.chain);
