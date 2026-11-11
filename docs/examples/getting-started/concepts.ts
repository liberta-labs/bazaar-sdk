// Core concepts: the context, the facade and the namespaces, prepared calls, units, errors.
import {
  Bazaar,
  CallError,
  InputError,
  OrderType,
  connect,
  errorMessage,
  formatUnits18,
  fromUsdcUnits,
  markets,
  orders,
  parseUnits18,
  toUsdcUnits,
  trade,
} from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const user: Address = "0x0000000000000000000000000000000000000001";

// ANCHOR: facade
// The facade: one object, the connection bound into every function.
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY });
const eth = await bz.markets.getMarket("ETH/USD");

// The same functions per area, taking the context first: what a library or a tree-shaken bundle uses.
const ctx = await connect({ transport: window.ethereum, factory: FACTORY });
const same = await markets.getMarket(ctx, "ETH/USD");

// Moving between them: bz.ctx is the context, and Bazaar.from wraps one.
const again = Bazaar.from(ctx);
console.log(bz.ctx.lens, again.deployment.usdc, same.label);

// Pure helpers, which need no connection, live only on the namespaces.
const expiry = (await bz.ctx.chain.blockNumber()) + orders.blocksIn(3600);
// ANCHOR_END: facade

// ANCHOR: prepared
const call = await trade.createOrder(ctx, eth.address, user, {
  orderType: OrderType.Limit, isLong: false, size: parseUnits18("1"), limitPrice: parseUnits18("3100"), expirationBlock: expiry,
});
call.action; // "createOrder"
call.to; // the pair
call.data; // the calldata
call.value; // ETH for the Pyth update fee (wei)
call.from; // the user it acts for
call.summary; // "Sell 1 at 3100 (limit, GTC)"
call.priceTime; // the attached print's publish time (unix seconds)
call.pullsUsdc; // USDC it takes from the wallet (18 decimals): a trigger order's bounty, a deposit

const sim = await bz.simulate(call); // eth_call as `from`, then eth_estimateGas
if (sim.ok) console.log(`gas ${sim.gas}`);
else console.log(sim.error!.name, sim.error!.message); // the decoded custom error, and a sentence for the user
// ANCHOR_END: prepared

// ANCHOR: units
const size = parseUnits18("0.25"); // 250000000000000000n: 0.25 ETH
const price = parseUnits18("3012.5"); // $3,012.50
const notional = (size * price) / 10n ** 18n; // $753.125, still 18 decimals
formatUnits18(notional, 2); // "753.12" (rounded toward zero)
toUsdcUnits(notional); // 753125000n: what USDC's own calls count (6 decimals), floored
fromUsdcUnits(1_000_000n); // 1000000000000000000n: one USDC back in 18 decimals
// ANCHOR_END: units

// ANCHOR: errors
try {
  const c = await bz.trade.createOrder(eth.address, user, { orderType: OrderType.Market, isLong: true, size: parseUnits18("2") });
  const s = await bz.simulate(c);
  if (!s.ok) throw new CallError(s.error!.message, s.error);
  await bz.waitForReceipt(await bz.send(window.ethereum, c));
} catch (e) {
  if (e instanceof InputError) console.log(`field ${e.field} was refused before anything was built`);
  console.log(errorMessage(e)); // here: "maxSlippageBp: Set a slippage limit between 0.01% and 10%."
}
// ANCHOR_END: errors
