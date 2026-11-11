// Proposing a new market: the constants, a composite feed, the proposal itself and its receipt.
import { Bazaar, type PreparedCall, errorMessage, formatUnits18, listings, parseUnits18, uma } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];

// Pyth Pro feed IDs are numbers, from Pyth Pro's symbols registry (placeholders here). The builders
// also take the bytes32 the contracts hold them in.
const AAPL_USD_FEED = 9001;
const DAX_EUR_FEED = 9002;
const EUR_USD_FEED = 9003;

// ANCHOR: constants
const c = await bz.listings.deploymentConstants();
console.log(`deposit at least ${formatUnits18(c.minDeploymentAmount)} USD`); // "4000"
console.log(`the bond posted now: ${uma.usdcText(c.requiredDeploymentBondUsdc)}`); // "1,000 USDC" or UMA's minimum if higher
console.log(`liveness: ${uma.durationText(c.deploymentLiveness)}`); // "2 days"
// ANCHOR_END: constants

// ANCHOR: description
// Check the description as the user types: null means the factory accepts it.
const problem = listings.descriptionProblem("Apple Inc. common stock on NASDAQ");
if (problem) console.log(problem);
// ANCHOR_END: description

// ANCHOR: composite
// A non-USD asset trades against a composite: DAX (in EUR) x EUR/USD. Register it once, then list
// the composite id. EUR/USD is CCY/USD, so the FX leg multiplies: invertQuote is false.
const id = listings.compositeId(DAX_EUR_FEED, EUR_USD_FEED, false);
if ((await bz.listings.getComposite(id)) === null) {
  const reg = await bz.listings.registerComposite({ baseId: DAX_EUR_FEED, quoteId: EUR_USD_FEED, invertQuote: false, from: user });
  await bz.waitForReceipt(await bz.send(window.ethereum, reg));
}
// `id` (also `reg.compositeId`) is now the baseFeedId to propose, with isContinuouslyTraded: false.
// ANCHOR_END: composite

// ANCHOR: send
/** Send a call's approvals, then simulate the call itself and send it. */
async function sendWithApprovals(call: PreparedCall & { approvals: readonly PreparedCall[] }) {
  for (const approval of call.approvals) {
    await bz.waitForReceipt(await bz.send(window.ethereum, approval));
  }
  // Simulate only after the approvals have landed: before, transferFrom would revert.
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new Error(sim.error!.message);
  return bz.waitForReceipt(await bz.send(window.ethereum, call));
}
// ANCHOR_END: send

// ANCHOR: propose
try {
  const call = await bz.listings.proposePairDeployment({
    baseFeedId: AAPL_USD_FEED,
    isContinuouslyTraded: false, // a stock has sessions; true only for 24/7 assets (crypto)
    totalAmount: parseUnits18("5000"), // the bond plus the seed, 18 decimals
    description: "Apple Inc. common stock on NASDAQ",
    from: user,
  });

  // Show the user what this costs and what happens next before asking for a signature.
  console.log(call.summary);
  for (const cost of call.costs) console.log(`${cost.label}: ${uma.usdcText(cost.amount)}. ${cost.returned}`);
  for (const line of [...call.requires, ...call.notes]) console.log(line);

  const receipt = await sendWithApprovals(call);
  const listing = bz.listings.listingFromReceipt(receipt);
  console.log(`assertion ${listing?.assertionId}, pair id ${listing?.pairId}`);
} catch (e) {
  console.error(errorMessage(e)); // an InputError ("Another listing of this asset is in UMA's review until ..."), a revert, a rejection
}
// ANCHOR_END: propose
