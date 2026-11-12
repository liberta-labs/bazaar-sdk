// Sending a PreparedCall from a browser: simulate, send through the wallet, wait for the receipt.
import { Bazaar, CallError, OrderType, type PreparedCall, buildAndSend, errorMessage, orders, parseUnits18, toTransactionRequest } from "@liberta-labs/bazaar-sdk";
import { type Address, createWalletClient, custom } from "viem";
import { arbitrum } from "viem/chains";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: FACTORY,
  prices: PRICES,
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text); // your UI's toast or inline error

// ANCHOR: prepared
const block = await bz.ctx.chain.blockNumber();
const call: PreparedCall = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Limit,
  isLong: true,
  size: parseUnits18("0.5"),
  limitPrice: parseUnits18("3000"),
  expirationBlock: block + orders.blocksIn(24 * 60 * 60), // about a day
});

call.action; // "createOrder"
call.to; // the pair
call.data; // the calldata
call.value; // the Pyth update fee in wei
call.from; // user
call.summary; // "Buy 0.5 at 3000 (limit, GTC)"
call.priceTime; // the update's publish time (unix seconds)
call.pullsUsdc; // 0n: a limit order pulls nothing from the wallet
// ANCHOR_END: prepared

// ANCHOR: simulate
const sim = await bz.simulate(call); // as call.from; pass { from } to simulate as someone else
if (!sim.ok) {
  show(sim.error!.message); // "A limit price must be within 50% of the market price..."
} else {
  console.log(`estimated gas: ${sim.gas}`);
}
// ANCHOR_END: simulate

// ANCHOR: send
try {
  const hash = await bz.send(window.ethereum, call); // eth_sendTransaction; resolves once the wallet accepts
  const receipt = await bz.waitForReceipt(hash); // throws CallError if it reverted
  console.log(`order placed in block ${receipt.blockNumber}`);
} catch (e) {
  show(errorMessage(e)); // "You rejected the request in your wallet.", a decoded revert, ...
}
// ANCHOR_END: send

// ANCHOR: viem
const walletClient = createWalletClient({ chain: arbitrum, transport: custom(window.ethereum) });
const request = toTransactionRequest(call); // { to, data, value, account }
const viaViem = await walletClient.sendTransaction({ ...request, account: request.account ?? user });
await bz.waitForReceipt(viaViem);
// ANCHOR_END: viem

// ANCHOR: build-and-send
// The price update is fetched inside build(), right before the wallet prompt.
const placeOrder = () =>
  bz.trade.createOrder(eth.address, user, {
    orderType: OrderType.Market,
    isLong: true,
    size: parseUnits18("0.5"),
    maxSlippageBp: 50n, // 0.5%
  });

try {
  const { call: sent, hash } = await buildAndSend(window.ethereum, placeOrder);
  console.log(`${sent.summary}: ${hash}`);
  await bz.waitForReceipt(hash);
} catch (e) {
  show(errorMessage(e));
}
// ANCHOR_END: build-and-send

// ANCHOR: fresh
/** Whether a call's price update is still young enough to send (the pair allows 3 s at landing). */
function priceStillFresh(c: PreparedCall, maxAgeSeconds = 2): boolean {
  return c.priceTime === undefined || Date.now() / 1000 - c.priceTime <= maxAgeSeconds;
}

// Simulate first, then rebuild if the simulation took long enough for the print to age.
let order = await placeOrder();
const check = await bz.simulate(order);
if (check.ok && !priceStillFresh(order)) order = await placeOrder();
// ANCHOR_END: fresh

// ANCHOR: call-error
try {
  const hash = await bz.send(window.ethereum, order);
  await bz.waitForReceipt(hash, { timeoutMs: 60_000, pollMs: 1_000 });
} catch (e) {
  if (e instanceof CallError && e.decoded) {
    // The wallet's own gas estimate reverted: the decoded custom error, with its arguments.
    console.log(e.decoded.name, e.decoded.args);
  }
  show(errorMessage(e));
}
// ANCHOR_END: call-error
