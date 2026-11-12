// Markets: discovery, labels, snapshots, status and flags, funding, the book.
import { Bazaar, Status, formatUnits18, markets } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });

// ANCHOR: list
const list = await bz.markets.listMarkets(); // cached per connection after the first call
for (const m of list) {
  console.log(m.label, m.address, m.hours, m.composite ? `composite of ${m.legSymbols.join(" and ")}` : m.legSymbols[0]);
}
const fresh = await bz.markets.listMarkets({ refresh: true }); // only markets listed since are described

const eth = await bz.markets.getMarket("eth/usd"); // a label (any case), a pair address, or a pair id
const byAddress = await bz.markets.getMarket(eth.address);
// ANCHOR_END: list

// ANCHOR: snapshot
const snap = await bz.markets.marketSnapshot(eth); // one block, two batched reads
console.log(`${snap.market.label} at block ${snap.block}: ${snap.status}`);
console.log(`stored ${formatUnits18(snap.price.spot, 2)} (${snap.price.age} s old), mark ${formatUnits18(snap.markPrice, 2)}`);
console.log(`IMR ${snap.margin.imrBp} bp, max leverage ${snap.margin.maxLeverage?.toFixed(1) ?? "-"}x`);
console.log(`OI long ${formatUnits18(snap.openInterest.longNotional, 0)} / short ${formatUnits18(snap.openInterest.shortNotional, 0)} USD`);
console.log(`insurance ${formatUnits18(snap.insurance.fund, 0)} USD, ${formatUnits18(snap.insurance.freeCapital, 0)} free`);

// Many markets at one block, in the same two batched reads.
const all = await bz.markets.marketSnapshots(list);
const live = [...all.values()].filter((s) => s.status === Status.Live);
// ANCHOR_END: snapshot

// ANCHOR: flags
function tradeButtons(s: markets.MarketSnapshot) {
  return {
    marketOrder: { enabled: !s.marketOrdersDisabled, why: s.reasons.marketOrdersDisabled },
    // A position holder is frozen in more cases than a flat account.
    withdraw: (hasPosition: boolean) => {
      const blocked = s.allWithdrawalsPaused || (hasPosition && s.positionWithdrawalsFrozen);
      return { enabled: !blocked, why: s.allWithdrawalsPaused ? s.reasons.allWithdrawalsPaused : s.reasons.positionWithdrawalsFrozen };
    },
    // null: nothing could judge the venue (no live prices, no Pyth Pro source); false on a 24/7 market.
    venueClosed: s.venueClosed,
  };
}

// Countdowns without a new read: the status and the ADL threshold at another time.
const in30s = markets.marketStatusAt(snap, snap.timestamp + 30);
const threshold = markets.adlScoreThresholdAt(snap, snap.timestamp + 30);
// ANCHOR_END: flags

// ANCHOR: funding
const f = snap.funding;
const perHour = Number(f.currentRatePerHour) / 1e16; // percent per hour (1e18 = 100%)
const hoursPerYear = eth.hours === "24/7" ? 8_760 : 1_700; // a trading-hours market accrues only while open
const perYear = markets.annualizedFunding(f.currentRatePerHour, hoursPerYear) * 100; // percent a year
console.log(`${perHour.toFixed(4)}%/h (${perYear.toFixed(2)}% a year), ${f.currentRatePerHour > 0n ? "longs pay shorts" : "shorts pay longs"}`);
console.log(`cap ${formatUnits18(f.maxRatePerHour * 100n)}%/h; next stored price charges ${formatUnits18(f.accruingRatePerHour * 100n, 4)}%/h`);
// ANCHOR_END: funding

// ANCHOR: book
const { bids, asks } = await bz.markets.getBook(eth, 10); // ten levels a side, at one block
for (const l of asks.levels.slice().reverse()) console.log(`  ask ${formatUnits18(l.price, 2)}  ${formatUnits18(l.size, 4)}  (${l.orders})`);
for (const l of bids.levels) console.log(`  bid ${formatUnits18(l.price, 2)}  ${formatUnits18(l.size, 4)}  (${l.orders})`);
if (!bids.complete) console.log("more bids below");

const deep = await bz.markets.getBookDepth(eth, "bids", 100, { pageSize: 200, maxOrders: 5_000 });
// ANCHOR_END: book

console.log(fresh, byAddress, live, tradeButtons, in30s, threshold, deep);
