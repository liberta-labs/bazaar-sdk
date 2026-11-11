// Reader, models and formulas: the keeper's batched market reads, from your own code.
import { type Address } from "viem";
import {
  Chain,
  Reader,
  Status,
  bucketState,
  effectiveMmrBp,
  formatUnits18,
  freeCapital,
  marginRatio,
  marketStatus,
} from "@liberta-labs/bazaar-sdk";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const user: Address = "0x0000000000000000000000000000000000000001";
const chain = Chain.fromUrl(process.env.RPC_HTTP_URL!);

// ANCHOR: reader
const reader = new Reader(chain);
const dep = await reader.deployment(FACTORY); // factory, lens, terminator, oracle, usdc
const problems = await reader.wiringProblems();
if (problems.length) throw new Error(`not a consistent Bazaar deployment: ${problems.join("; ")}`);

const markets = await reader.describe(await reader.pairAddresses()); // pairId, feed, legs, calendar
const head = await chain.block("latest");
const states = await reader.marketStates(markets, head.number, head.timestamp); // one batched read

for (const m of markets) {
  const s = states.get(m.address);
  if (!s) continue; // its price, margin or vault read failed
  const status = marketStatus(s, head.timestamp);
  console.log(m.address, status, "stored price", formatUnits18(s.spot), "free insurance", formatUnits18(freeCapital(s)));
  if (status === Status.Adl) console.log("  ADL window open since", s.adlAuctionStart);
}
console.log("oracle", dep.oracle);
// ANCHOR_END: reader

// ANCHOR: health
// One account's health on each market, at the stored price, with the contract's own formula.
for (const m of markets) {
  const s = states.get(m.address);
  const b = (await reader.buckets(m.address, [user])).get(user);
  if (!s || !b || b.size === 0n) continue;
  const mmr = effectiveMmrBp(s.mmrBp, s.laggedMmrBp);
  const st = bucketState(b.isLong, b.size, b.entryValue, b.collateral, b.entryFundingIndex, s.spot, s.projectedFundingIndex, mmr);
  console.log(m.address, "equity", formatUnits18(st.equity), "needs", formatUnits18(st.minRequiredCollateral), "ratio", marginRatio(st).toFixed(2));
  if (!st.isSolvent) console.log("  below maintenance margin: liquidatable");
}
// ANCHOR_END: health

// ANCHOR: orders
const [first] = markets;
if (first) {
  const recs = await reader.orders(first.address, [1n, 2n, 3n]);
  for (const [id, o] of recs) {
    if (o.creator === "0x0000000000000000000000000000000000000000") continue; // never held an order
    console.log(id, o.orderType, formatUnits18(o.size - o.filledSize), "left, bounty", formatUnits18(o.bounty));
  }
  const owed = await reader.claimable(user); // pair -> claimable balance
  for (const [p, amount] of owed) console.log(p, "claimable", formatUnits18(amount));
}
// ANCHOR_END: orders
