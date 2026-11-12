// Turning every failure a Bazaar call can raise into one sentence for the user.
import {
  Bazaar,
  CallError,
  ConnectError,
  DecodedError,
  InputError,
  OrderType,
  USER_MESSAGES,
  decodeError,
  errorMessage,
  parseUnits18,
  signing,
  userMessage,
  walletErrorMessage,
} from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);

// ANCHOR: error-message
try {
  const call = await bz.trade.createOrder(eth.address, user, {
    orderType: OrderType.Market,
    isLong: true,
    size: parseUnits18("1"),
    maxSlippageBp: 50n,
  });
  const sim = await bz.simulate(call);
  if (!sim.ok) throw sim.error!; // a DecodedError
  await bz.waitForReceipt(await bz.send(window.ethereum, call));
} catch (e) {
  show(errorMessage(e)); // one sentence, whatever failed
}
// ANCHOR_END: error-message

// ANCHOR: decoded
const sim = await bz.simulate(await bz.trade.withdrawCollateral(eth.address, user, parseUnits18("1000000")));
if (sim.error) {
  sim.error.name; // e.g. "CollateralLib__InsufficientCollateral"
  sim.error.args; // { amount: 1000000000000000000000000n, available: 2500000000000000000000n }
  sim.error.message; // "You asked for $1,000,000.00, but only $2,500.00 is available."
  sim.error.hint; // the operator-facing hint, or ""
  sim.error.data; // the raw revert data
  sim.error.opensAt(); // for a "too early" error, when the call opens (unix seconds); else null
  String(sim.error); // "CollateralLib__InsufficientCollateral(amount=..., available=...)", for logs
}
// ANCHOR_END: decoded

// ANCHOR: by-name
userMessage("OrderManagementLib__TooManyActiveLimitOrders");
// "You have the maximum of 32 open limit and stop-limit orders on this market. Cancel some first."
userMessage("MetaTx__InvalidNonce", { expected: 7n }); // arguments are formatted into the text
Object.keys(USER_MESSAGES).length; // one per custom error the five contracts declare
// ANCHOR_END: by-name

// ANCHOR: wallet
try {
  await bz.send(window.ethereum, await bz.trade.cancelOrders(eth.address, user, [1n]));
} catch (e) {
  const wallet = walletErrorMessage(e); // null unless the wallet itself refused
  if (wallet) show(wallet); // "You rejected the request in your wallet."
}
// ANCHOR_END: wallet

// ANCHOR: input-error
try {
  await bz.trade.depositCollateral(eth.address, user, parseUnits18("2"));
} catch (e) {
  if (e instanceof InputError) {
    e.field; // "amount": put the message next to that input
    e.message; // "amount: The minimum deposit is 5 USDC."
    e.message.slice(e.field.length + 2); // "The minimum deposit is 5 USDC."
  }
}
// ANCHOR_END: input-error

// ANCHOR: show-error
/** Errors the SDK's ABIs do not declare, by the name decodeError gives them. */
const EXTRA_MESSAGES: Record<string, string> = {
  // Pyth's StalePrice(): the price update aged past the pair's 3 s window before the call landed.
  "Unknown(0x19abf40e)": "The price moved on before your transaction landed. Try again.",
};

/** What to show for any error a Bazaar call can throw. */
function explain(e: unknown): string {
  // A decoded revert the SDK has no sentence for (e.g. Pyth's own errors).
  const decoded = e instanceof DecodedError ? e : e instanceof CallError ? e.decoded : null;
  if (decoded && EXTRA_MESSAGES[decoded.name]) return EXTRA_MESSAGES[decoded.name]!;
  // The builders' input errors: the sentence without its "field: " prefix.
  if (e instanceof InputError) return e.message.slice(e.field.length + 2);
  // Signing (declined, clock skew, a smart-account signature) and connection errors carry their own
  // sentence, which errorMessage does not pass through.
  if (e instanceof signing.SigningError || e instanceof ConnectError) {
    return walletErrorMessage(e) ?? e.message;
  }
  // A receipt that reverted carries no reason: say so plainly.
  if (e instanceof CallError && !e.decoded && /reverted$/.test(e.message)) {
    return "The transaction was reverted on chain. Nothing changed; check the market and try again.";
  }
  return errorMessage(e);
}

explain(decodeError("0x19abf40e")); // "The price moved on before your transaction landed. Try again."
// ANCHOR_END: show-error
