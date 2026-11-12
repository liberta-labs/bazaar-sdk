// After an order is placed: reading it back, amending, canceling, firing your own triggers, claiming.
import { Bazaar, InputError, type PreparedCall, errorMessage, formatUnits18, parseUnits18, triggerReached } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: { token: pythToken } });
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);

async function run(call: PreparedCall): Promise<void> {
  const sim = await bz.simulate(call);
  if (!sim.ok) return show(sim.error!.message);
  try {
    await bz.waitForReceipt(await bz.send(window.ethereum, call));
  } catch (e) {
    show(errorMessage(e));
  }
}

// ANCHOR: read
const snap = await bz.account.accountSnapshot(eth, user);
for (const o of snap.orders) {
  console.log(
    `#${o.orderId} ${o.typeName} ${o.isLong ? "buy" : "sell"} ${formatUnits18(o.remaining)} of ${formatUnits18(o.size)}`,
    o.inBook ? `resting at ${formatUnits18(o.limitPrice)}` : `waiting for ${formatUnits18(o.triggerPrice)}`,
    o.neverExpires ? "" : `expires in ${o.blocksLeft} blocks`,
    o.bounty > 0n ? `bounty $${formatUnits18(o.bounty)}` : "",
  );
}
snap.takeProfit; // the position's attached TakeProfit, or null
snap.stopLoss;
snap.claimableFees; // refunded bounties, keeper rewards, relayer and integrator fees on this pair
// ANCHOR_END: read

// ANCHOR: amend-one
// Reprice order #42 to 2990 and make its total size 1.5 (filled part included).
await run(await bz.trade.amendOrders(eth.address, user, [{ orderId: 42n, limitPrice: parseUnits18("2990"), size: parseUnits18("1.5") }]));
// ANCHOR_END: amend-one

// ANCHOR: amend-batch
// Requote every resting limit order 0.2% higher in one call. bestEffort: an order that filled or
// expired meanwhile is skipped (OrderAmendSkipped) instead of reverting the whole batch.
const resting = snap.orders.filter((o) => o.typeName === "Limit" && o.inBook);
// Moving up: amend the asks first, so a bid's new price is not judged against an ask about to move.
resting.sort((a, b) => Number(a.isLong) - Number(b.isLong));
const amends = resting.map((o) => ({
  orderId: o.orderId,
  limitPrice: (o.limitPrice * 10_020n) / 10_000n,
  size: o.size, // unchanged size and a new price: the order goes to the back of its new level
  bestEffort: true,
}));
if (amends.length > 0) await run(await bz.trade.amendOrders(eth.address, user, amends));
// ANCHOR_END: amend-batch

// ANCHOR: prepare-amends
// The same checks and hints without building a call (a gasless amendment signs prep.words).
try {
  const prep = await bz.trade.prepareAmends(eth.address, user, [{ orderId: 42n, limitPrice: parseUnits18("2990"), size: parseUnits18("1") }]);
  console.log(prep.amends[0]!.pred, prep.words.length); // the hint found, and 3 words per amendment
} catch (e) {
  if (e instanceof InputError) show(e.message); // "orderId: Order #42 is no longer open."
}
// ANCHOR_END: prepare-amends

// ANCHOR: cancel
await run(await bz.trade.cancelOrders(eth.address, user, [42n, 43n]));

// Everything at once: every order an account can hold live fits in one call.
const ids = snap.orders.map((o) => o.orderId);
if (ids.length > 0) await run(await bz.trade.cancelOrders(eth.address, user, ids));
// ANCHOR_END: cancel

// ANCHOR: execute
// Fire this user's own trigger orders (the zero-bounty ones no keeper will) that the live price has reached.
const { price } = await bz.trade.livePairPrice(eth.address);
const due = snap.orders
  .filter((o) => !o.inBook && o.triggerPrice > 0n && triggerReached(o.orderType, o.isLong, o.triggerPrice, price.spot))
  .map((o) => o.orderId)
  .slice(0, 20);
if (due.length > 0) await run(await bz.trade.executeTriggeredOrders(eth.address, user, due));
// ANCHOR_END: execute

// ANCHOR: claim
if (snap.claimableFees > 0n) {
  const claim = await bz.trade.claimFees(eth.address, user); // "Claim 1.25 USDC"
  await run(claim);
}
// ANCHOR_END: claim
