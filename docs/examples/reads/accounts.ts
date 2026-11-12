// Accounts: one market's snapshot, health, orders, withdrawals, fees, and the whole portfolio.
import { Bazaar, account, formatUnits18, fromUsdcUnits } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const user: Address = "0x0000000000000000000000000000000000000001";
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });
const eth = await bz.markets.getMarket("ETH/USD");

// ANCHOR: snapshot
const me = await bz.account.accountSnapshot(eth, user);
console.log(`valued at ${me.price ? formatUnits18(me.price.spot, 2) : "no price"} (${me.price?.source ?? "-"})`);
if (me.hasPosition && me.health) {
  const h = me.health;
  console.log(`${me.position.isLong ? "long" : "short"} ${formatUnits18(me.position.size)} from ${formatUnits18(me.position.entryPrice, 2)}`);
  console.log(`equity ${formatUnits18(h.equity, 2)}, PnL ${formatUnits18(h.unrealizedPnl, 2)} + funding ${formatUnits18(h.fundingPnl, 2)}`);
  console.log(`margin ratio ${h.marginRatio.toFixed(2)} (liquidatable below 1), leverage ${h.leverage?.toFixed(1) ?? "-"}x`);
}
// ANCHOR_END: snapshot

// ANCHOR: orders
for (const o of me.orders) {
  const life = o.neverExpires ? "never expires" : `${o.blocksLeft} blocks left`;
  console.log(`#${o.orderId} ${o.typeName} ${o.isLong ? "buy" : "sell"} ${formatUnits18(o.remaining)} @ ${formatUnits18(o.limitPrice, 2)}, ${life}`);
}
if (me.stopLoss) console.log(`stop loss at ${formatUnits18(me.stopLoss.triggerPrice, 2)}, bounty ${formatUnits18(me.stopLoss.bounty)}`);
console.log(`resting buys ${formatUnits18(me.exposure.longNotional, 2)} USD, sells ${formatUnits18(me.exposure.shortNotional, 2)} USD`);
// ANCHOR_END: orders

// ANCHOR: withdraw
// maxWithdrawable is the lens's figure; withdrawalBlocked is what the market's flags forbid now.
const canWithdraw = me.withdrawalBlocked ? 0n : me.maxWithdrawable;
console.log(me.withdrawalBlocked ?? `up to ${formatUnits18(canWithdraw, 2)} USDC can be withdrawn`);
console.log(`claimable fees ${formatUnits18(me.claimableFees, 2)} USDC`); // claim with bz.trade.claimFees
console.log(`wallet ${formatUnits18(fromUsdcUnits(me.wallet.usdcBalance), 2)} USDC, allowance ${me.wallet.usdcAllowance} units`);
if (me.terminal) console.log(`the market is winding down: a withdrawal pays ${formatUnits18(me.terminal.payout, 2)} USDC`);
// ANCHOR_END: withdraw

// ANCHOR: health
// Revalue at a new price without a read: for a display that follows the live price.
const prices = await bz.livePrices();
prices.subscribe((changed) => {
  const p = changed.get(eth.address);
  const h = p && account.accountHealth(me, p);
  if (h) console.log(`margin ratio ${h.marginRatio.toFixed(2)} at ${formatUnits18(h.price, 2)}`);
}, [eth]);

// Or value at a price you hold, with the market's state from a snapshot read at the same block.
const snap = await bz.markets.marketSnapshot(eth);
const atMine = await bz.account.accountSnapshot(eth, user, { market: snap, price: { spot: 2_900n * 10n ** 18n } });
const whatIf = account.positionHealth(atMine.position, atMine.state, 2_500n * 10n ** 18n);
// ANCHOR_END: health

// ANCHOR: portfolio
const book = await bz.account.portfolio(user); // every market where the account holds anything
for (const a of book.accounts) {
  console.log(`${a.market.label}: collateral ${formatUnits18(a.position.collateral, 2)}, ${a.orders.length} orders`);
}
const t = book.totals;
console.log(`equity ${formatUnits18(t.equity, 2)}, withdrawable ${formatUnits18(t.maxWithdrawable, 2)}, fees ${formatUnits18(t.claimableFees, 2)}`);
const two = await bz.account.portfolio(user, ["ETH/USD", "BTC/USD"], { prices }); // chosen markets, live prices
// ANCHOR_END: portfolio

console.log(whatIf, two);
