// Leaving the insurance fund: the exit plan, the next call, and the reads behind it.
import { Bazaar, CallError, type PreparedCall, buildAndSend, errorMessage, formatUnits18, insurance } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
  prices: PRICES, // both execute calls carry a fresh Pyth Pro price
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const at = (t: number | null) => (t === null ? "-" : new Date(t * 1000).toLocaleString());

// ANCHOR: plan
const plan = await bz.insurance.insuranceExitPlan(eth.address, user!);
console.log(plan.step, plan.message); // e.g. "cooldown" "Your withdrawal's cooldown ends in 9 d 4 h; ..."
for (const note of plan.notes) console.log(`note: ${note}`);
console.log(`shares ${formatUnits18(plan.shares, 4)}, requested ${formatUnits18(plan.requestedShares, 4)}, locked by votes ${formatUnits18(plan.lockedForVoting, 4)}`);
console.log(`window ${at(plan.windowOpensTs)} to ${at(plan.windowEndTs)}; next call from ${at(plan.nextCallAt)} until ${at(plan.nextCallBy)}`);
if (plan.payoutEstimate !== null) console.log(`the paying call would pay at most ${formatUnits18(plan.payoutEstimate, 2)} USDC now`);
// ANCHOR_END: plan

// ANCHOR: next
/** Take the LP's next exit step, if one can land now. `shares` sizes a new request (all free shares by default). */
async function nextExitStep(shares?: bigint): Promise<string> {
  const p = await bz.insurance.insuranceExitPlan(eth.address, user!, { quote: false });
  if (p.nextAction === null || p.nextCallAt === null || p.nextCallAt > p.now) return p.message;
  let build: () => Promise<PreparedCall>;
  if (p.nextAction === "requestInsuranceWithdrawal") {
    const amount = shares ?? p.shares - p.lockedForVoting; // shares backing a vote cannot leave
    build = () => bz.insurance.requestInsuranceWithdrawal(eth.address, user!, amount);
  } else {
    // The lock and the paying call are the same function; both carry a fresh price on a live market.
    build = () => bz.insurance.executeInsuranceWithdrawal(eth.address, user!);
  }
  const { call, hash } = await buildAndSend(window.ethereum, async () => {
    const c = await build();
    const sim = await bz.simulate(c);
    if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
    return c;
  });
  await bz.waitForReceipt(hash);
  return `Done: ${call.summary}`;
}

try {
  console.log(await nextExitStep());
} catch (e) {
  console.error(errorMessage(e));
}
// ANCHOR_END: next

// ANCHOR: budget
const [budget, lock, k] = await Promise.all([
  bz.insurance.getInsuranceWithdrawalBudget(eth.address), // at the live price
  bz.insurance.getInsuranceWithdrawalLock(eth.address, user!),
  bz.insurance.getInsuranceWithdrawalConstants(),
]);
if (budget.unlimited) console.log("No withdrawal budget applies (terminated, or no open interest).");
else console.log(`${formatUnits18(budget.remaining, 2)} of ${formatUnits18(budget.cap, 2)} USDC left until ${at(budget.resetsAt)}`);
console.log(`coverage ${budget.coverageRatioBp} bp against a target of ${budget.targetRatioBp} bp`);
if (lock.isLocked) console.log(`locked at ${formatUnits18(lock.lockedAmount, 2)} USDC; collect from ${at(lock.claimOpensTs)} to ${at(lock.windowEndTs)}`);
console.log(`cooldown ${k.cooldown / 86_400} days; windows ${k.continuousWindow / 86_400} or ${k.sessionWindow / 86_400} days`);
// The claim delay, in the SDK's own terms: 5 minutes after the lock and after the last 2% jump,
// 30 minutes after the end of a price gap of an hour or more.
const opens = insurance.claimOpensAt(lock.lockTs, 0, 0);
console.log(`with no jump or gap since, the claim would open at ${at(opens)}`);
// ANCHOR_END: budget
