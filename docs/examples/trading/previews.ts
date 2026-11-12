// What an order or a withdrawal will do, before it is sent: previewOrder, previewWithdrawal, and the pure helpers.
import { Bazaar, OrderType, formatUnits18, parseUnits18, previews } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const usd = (v: bigint) => `$${formatUnits18(v, 2)}`;

// ANCHOR: preview-order
// Judge at the live price the call will carry, not the pair's last stored one.
const live = await bz.trade.livePairPrice(eth.address);
const price: previews.PriceInput = { spot: live.price.spot, low: live.price.low, high: live.price.high, publishTime: live.publishTime };

const p = await bz.previews.previewOrder(
  eth.address,
  user,
  { orderType: OrderType.Market, isLong: true, size: parseUnits18("2"), maxSlippageBp: 50n },
  { price },
);

if (p.blockers.length > 0) {
  console.log(p.blockers.map((b) => b.message)); // every reason the pair would refuse it
} else {
  console.log(`fills ${formatUnits18(p.takerSize)} at an average ${formatUnits18(p.takerAvgPrice ?? 0n, 2)}`);
  console.log(`fees ${usd(p.fees.total)}, ${usd(p.fees.toInsuranceFund)} of it to the insurance fund`);
  console.log(`needs ${usd(p.margin.requiredCollateral)} of collateral; has ${usd(p.margin.collateral)}`);
  console.log(`position after: ${formatUnits18(p.after.size)} ${p.after.isLong ? "long" : "short"}`);
  console.log(`liquidation price ~${p.after.liquidationPrice === null ? "none" : formatUnits18(p.after.liquidationPrice, 2)}`);
  if (p.canceledSize > 0n) console.log(`${formatUnits18(p.canceledSize)} canceled: ${p.cancelReason}`);
}
// ANCHOR_END: preview-order

// ANCHOR: preview-limit
// A resting bid: what fills now, what rests, and whether the rest would pass its margin gate later.
const bid = await bz.previews.previewOrder(eth.address, user, {
  orderType: OrderType.Limit,
  isLong: true,
  size: parseUnits18("5"),
  limitPrice: parseUnits18("2950"),
});
bid.restingSize; // the part that rests in the book
bid.laterFillOk; // null when nothing rests
bid.afterArrival; // the position after this transaction only
bid.after; // ...and once the resting part has filled at its limit, as maker
// ANCHOR_END: preview-limit

// ANCHOR: preview-withdrawal
const w = await bz.previews.previewWithdrawal(eth.address, user, parseUnits18("250"), { price });
w.maxWithdrawable; // the most withdrawCollateral accepts now
w.freezes; // what stops every withdrawal now, each { error, args, message, until? }
w.ok; // whether 250 goes through
w.blocker?.message; // if not, the pair's reason: "With a position open you must keep $812.40 of collateral ..."
// ANCHOR_END: preview-withdrawal

// ANCHOR: simulate-order
// A size slider: read the pair once, then re-run the arithmetic locally on every change.
const [snap, acct] = await Promise.all([bz.markets.marketSnapshot(eth), bz.account.accountSnapshot(eth, user)]);
const rates: previews.MarginRates = { imrBp: snap.margin.imrBp, mmrBp: snap.margin.mmrBp, laggedMmrBp: snap.margin.laggedMmrBp };

function quote(size: string): previews.OrderPreview {
  return previews.simulateOrder({
    order: { orderType: OrderType.Market, isLong: true, size: parseUnits18(size), maxSlippageBp: 50n },
    account: user,
    integrator: bz.ctx.integrator,
    bucket: acct.position,
    mark: price.spot,
    fundingIndex: snap.funding.projectedIndex,
    rates,
    fees: p.feeRates, // the taker rates the full preview above read
    continuous: snap.market.continuous,
  });
}
quote("0.5").margin.shortfall; // 0n when the collateral covers it
// ANCHOR_END: simulate-order

// ANCHOR: helpers
const pos = acct.position;
previews.liquidationPrice(pos, snap.funding.projectedIndex, rates); // estimated; null when flat
previews.maxLeverage(rates.imrBp); // 25 at a 4% initial margin

const fee = previews.takerFillFee(parseUnits18("1"), parseUnits18("3000"), true, pos, p.feeRates, true);
previews.feeBreakdown(fee); // { insurance, integrator, total, toInsuranceFund, toIntegrator, toBugBounty }
previews.makerFillFee(parseUnits18("1"), parseUnits18("3000"), true).total; // 0.5 bp of $3,000 = $0.15

previews.takerInsuranceFeeRates(150n, 200n); // below the 2% target: the taker rate rises above the base
// ANCHOR_END: helpers
