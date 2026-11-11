// Every order type, built with createOrder; validation as the user types; caps, hints, descriptions.
import { Bazaar, InputError, OrderType, ZERO_ADDRESS, orders, parseUnits18, permits } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";
const MY_FRONTEND: Address = "0x0000000000000000000000000000000000000001";

// ANCHOR: integrator
const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: FACTORY,
  prices: { token: pythToken },
  integrator: MY_FRONTEND, // every order built through bz names it, and it earns the referral fee
});
// ANCHOR_END: integrator
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const { TimeInForce, blocksIn, CLOSE_POSITION } = orders;
const block = await bz.ctx.chain.blockNumber();

// ANCHOR: market
// Buy 0.5 ETH now, filling no worse than 0.5% above the oracle price; what cannot fill is canceled.
const market = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Market,
  isLong: true,
  size: parseUnits18("0.5"),
  maxSlippageBp: 50n,
});
// ANCHOR_END: market

// ANCHOR: market-fok
// All or nothing: the transaction reverts unless the whole size fills on arrival.
const marketFok = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Market,
  isLong: false,
  size: parseUnits18("2"),
  maxSlippageBp: 100n,
  tif: TimeInForce.FOK,
});
// ANCHOR_END: market-fok

// ANCHOR: limit
// Rest a bid at 2950 for a day; whatever crosses on arrival fills first.
const limit = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Limit,
  isLong: true,
  size: parseUnits18("1"),
  limitPrice: parseUnits18("2950"),
  expirationBlock: block + blocksIn(24 * 60 * 60),
});
// ANCHOR_END: limit

// ANCHOR: limit-ioc
// Take what is available at 3010 or better now; cancel the rest. No expiry: it never rests.
const ioc = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Limit,
  isLong: true,
  size: parseUnits18("1"),
  limitPrice: parseUnits18("3010"),
  tif: TimeInForce.IOC,
});
// ANCHOR_END: limit-ioc

// ANCHOR: post-only
// A maker-only ask: canceled (not filled) if it would cross the book on arrival.
const postOnly = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.Limit,
  isLong: false,
  size: parseUnits18("1"),
  limitPrice: parseUnits18("3100"),
  isPostOnly: true,
  expirationBlock: block + blocksIn(60 * 60),
});
// ANCHOR_END: post-only

// ANCHOR: stop-limit
// Once the oracle price reaches 3200, rest a buy at up to 3210 (a breakout entry). It pays a keeper
// 0.25 USDC to fire it, pulled from the wallet now.
const stopLimit = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.StopLimit,
  isLong: true,
  size: parseUnits18("1"),
  triggerPrice: parseUnits18("3200"),
  limitPrice: parseUnits18("3210"),
  bounty: parseUnits18("0.25"),
  expirationBlock: block + blocksIn(7 * 24 * 60 * 60),
});
stopLimit.pullsUsdc; // 250000000000000000n: the bounty, in BAZAAR precision
// ANCHOR_END: stop-limit

// ANCHOR: take-profit
// For a long position: sell the whole position when the price reaches 3600, at most 1% below it.
const takeProfit = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.TakeProfit,
  isLong: false, // the opposite side of the position
  size: CLOSE_POSITION, // whatever the position is when it fires
  triggerPrice: parseUnits18("3600"),
  maxSlippageBp: 100n,
  bounty: parseUnits18("0.5"),
});
// ANCHOR_END: take-profit

// ANCHOR: stop-loss
// For the same long: sell it all if the price falls to 2700, with up to 2% slippage. No bounty:
// this user fires it themselves (see Managing Orders).
const stopLoss = await bz.trade.createOrder(eth.address, user, {
  orderType: OrderType.StopLoss,
  isLong: false,
  size: CLOSE_POSITION,
  triggerPrice: parseUnits18("2700"),
  maxSlippageBp: 200n,
});
// ANCHOR_END: stop-loss

// ANCHOR: bounty-funding
// A trigger order's bounty comes from the wallet, so it needs an allowance or a permit.
const funding = await bz.allowance.usdcFunding(user, eth.address, takeProfit.pullsUsdc ?? 0n);
let tpCall = takeProfit;
if (!funding.enoughAllowance) {
  const permit = await bz.permits.signPermit(window.ethereum, {
    owner: user,
    spender: eth.address,
    value: permits.permitValueFor(takeProfit.pullsUsdc ?? 0n),
  });
  tpCall = await bz.trade.createOrder(
    eth.address,
    user,
    { orderType: OrderType.TakeProfit, isLong: false, size: CLOSE_POSITION, triggerPrice: parseUnits18("3600"), maxSlippageBp: 100n, bounty: parseUnits18("0.5") },
    { permitData: permit.permitData },
  );
}
// ANCHOR_END: bounty-funding

// ANCHOR: validate
/** The form's fields as the user typed them. */
interface OrderForm {
  side: "buy" | "sell";
  size: string;
  limitPrice: string;
  hours: string;
}

/** Field -> message, or {} when the order is fine. Pure, so it runs on every keystroke. */
function validate(form: OrderForm, env: orders.OrderEnvironment): Record<string, string> {
  try {
    orders.buildOrderSpec(
      {
        orderType: OrderType.Limit,
        isLong: form.side === "buy",
        size: parseUnits18(form.size || "0"),
        limitPrice: parseUnits18(form.limitPrice || "0"),
        expirationBlock: (env.currentBlock ?? 0) + blocksIn(Number(form.hours || "0") * 3600),
      },
      bz.ctx.integrator,
      env,
    );
    return {};
  } catch (e) {
    if (e instanceof InputError) return { [e.field]: e.message.slice(e.field.length + 2) };
    return { size: "Enter a number." }; // parseUnits18 refused the text (UnitError)
  }
}

// What the checks are judged against: read once when the form opens, refreshed now and then.
const env: orders.OrderEnvironment = {
  currentBlock: await bz.ctx.chain.blockNumber(),
  price: (await bz.trade.livePairPrice(eth.address)).price.spot,
  account: await bz.orders.readOrderState(eth.address, user),
};
validate({ side: "buy", size: "0.001", limitPrice: "3000", hours: "24" }, env);
// { size: "This order is worth $3; the minimum is $5 (closing your whole position is exempt)." }
// ANCHOR_END: validate

// ANCHOR: caps
const state = await bz.orders.readOrderState(eth.address, user);
try {
  orders.checkOrderCaps({ orderType: OrderType.TakeProfit }, state);
} catch (e) {
  if (e instanceof InputError) console.log(e.message); // "...already has a take-profit order..."
}
state.activeLimitOrderIds.length; // live Limit GTC + StopLimit orders, of at most 32
// ANCHOR_END: caps

// ANCHOR: describe
const spec = orders.buildOrderSpec(
  { orderType: OrderType.StopLoss, isLong: false, size: CLOSE_POSITION, triggerPrice: parseUnits18("2700"), maxSlippageBp: 200n, bounty: parseUnits18("0.5") },
  ZERO_ADDRESS,
);
orders.describeOrder(spec);
// "Stop loss: sell the whole position when the price reaches 2700 (2% max slippage, $0.5 keeper bounty)"
// ANCHOR_END: describe

// ANCHOR: hints
// createOrder finds the insertion hint itself. To bound the arrival walk, pass maxSteps; to reuse
// hints you computed (several orders against one book read), pass hints.
const shortWalk = await bz.trade.createOrder(
  eth.address,
  user,
  { orderType: OrderType.Limit, isLong: true, size: parseUnits18("3"), limitPrice: parseUnits18("3005"), expirationBlock: block + blocksIn(3600) },
  { maxSteps: 8 }, // visit at most 8 resting orders on arrival, then rest or cancel the remainder
);

const pred = await bz.trade.findPredecessor(eth.address, true, parseUnits18("2950"));
const hinted = await bz.trade.createOrder(
  eth.address,
  user,
  { orderType: OrderType.Limit, isLong: true, size: parseUnits18("1"), limitPrice: parseUnits18("2950"), expirationBlock: block + blocksIn(3600) },
  { hints: { ...orders.NO_HINTS, pred } },
);
// ANCHOR_END: hints

export { market, marketFok, limit, ioc, postOnly, stopLimit, stopLoss, tpCall, shortWalk, hinted };
