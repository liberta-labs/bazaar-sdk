// The introduction's short tour: connect a browser wallet, read an account, place a limit order.
import { Bazaar, OrderType, errorMessage, formatUnits18, orders, parseUnits18 } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000"; // the deployment's factory

// ANCHOR: taste
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES }); // signed Pyth Pro prices, for the order

const eth = await bz.markets.getMarket("ETH/USD");
const me = await bz.account.accountSnapshot(eth, user!);
console.log(`position ${formatUnits18(me.position.size)}, margin ratio ${me.health?.marginRatio ?? "-"}`);

const call = await bz.trade.createOrder(eth.address, user!, {
  orderType: OrderType.Limit, isLong: true, size: parseUnits18("0.5"), limitPrice: parseUnits18("2400"),
  expirationBlock: me.block + orders.blocksIn(3600), // one hour of Arbitrum blocks
});
const sim = await bz.simulate(call); // as the user, before anything is signed
if (sim.ok) await bz.send(window.ethereum, call); // the wallet signs and sends
else console.error(errorMessage(sim.error)); // "This order needs $1,240.50 of collateral ..."
// ANCHOR_END: taste
