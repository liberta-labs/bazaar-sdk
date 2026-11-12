// Samples for Security Notes for Integrators: the checks a frontend makes before it asks for a signature.
import { type Address } from "viem";
import {
  Bazaar,
  type PreparedCall,
  errorMessage,
  formatUnits18,
  type markets,
  parseUnits18,
  signing,
  uma,
} from "@liberta-labs/bazaar-sdk";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000",
  chainId: 42161, // refuse to run against any other chain
  prices: PRICES, // the Pyth Pro key stays on a server: see Connecting
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];

/** Where the app shows text to the user; a stand-in for your UI. */
function show(text: string): void {
  console.log(text);
}
/** Ask the user to confirm what will be signed; a stand-in for your confirmation dialog. */
async function confirm(lines: readonly string[]): Promise<boolean> {
  lines.forEach(show);
  return true;
}

// ANCHOR: pair
// A market named in a link (?market=0x...) is untrusted. getMarket resolves it against the factory's
// own pair list and throws InputError for anything else; every builder checks it again (requirePair).
const fromLink = new URLSearchParams(location.search).get("market") ?? "ETH/USD";
let market: markets.MarketInfo;
try {
  market = await bz.markets.getMarket(fromLink);
} catch (e) {
  show(errorMessage(e)); // "There is no market called ..."
  throw e;
}
// ANCHOR_END: pair

// ANCHOR: confirm
async function deposit(amount: string): Promise<void> {
  const call = await bz.trade.depositCollateral(market.address, user, parseUnits18(amount));

  // 1. Exact approval: the shortfall only, never unlimited unless the user chose it.
  const funding = await bz.allowance.usdcFunding(user, call.to, call.pullsUsdc ?? 0n);
  if (!funding.enoughBalance) return show("Your wallet does not hold enough USDC for this deposit.");
  const steps: PreparedCall[] = [];
  if (funding.approveUsdc > 0n) steps.push(await bz.allowance.approveUsdc(user, call.to, funding.approveUsdc));
  steps.push(call);

  // 2. Show every step before the wallet opens: the summary is the SDK's, the amounts are exact.
  if (!(await confirm(steps.map((s) => s.summary)))) return;

  for (const step of steps) {
    // 3. Simulate as the user. The deposit is simulated after its approval has landed, since
    //    simulating it before would fail on the allowance it is about to get.
    const sim = await bz.simulate(step);
    if (!sim.ok) return show(sim.error!.message);
    try {
      await bz.waitForReceipt(await bz.send(window.ethereum, step));
    } catch (e) {
      return show(errorMessage(e));
    }
  }
}
// ANCHOR_END: confirm

// ANCHOR: costed
/** The lines a confirmation screen shows for a call that posts a bond, a seed or a levy. */
function costLines(call: uma.CostedCall): string[] {
  const amount = (c: uma.Cost) =>
    c.unit === "USDC" ? uma.usdcText(c.amount) : c.unit === "ETH" ? uma.ethText(c.amount) : c.unit === "shares" ? uma.sharesText(c.amount) : `${c.amount} units of ${c.token}`;
  return [
    call.summary,
    ...call.costs.map((c) => `${c.contingent ? "At most " : ""}${amount(c)}: ${c.label}. ${c.returned}`),
    ...call.requires.map((r) => `Needs: ${r}`),
    ...call.notes,
    ...call.approvals.map((a) => `First: ${a.summary}`),
  ];
}
// ANCHOR_END: costed

// ANCHOR: text
/** On-chain and subgraph strings (descriptions, reasons) go into the page as text, never as HTML. */
function renderReason(el: HTMLElement, reason: string): void {
  el.textContent = reason; // never el.innerHTML = reason
}
// ANCHOR_END: text

// ANCHOR: skew
async function permitFor(amountUsdc: bigint) {
  try {
    return await bz.permits.signPermit(window.ethereum, { owner: user, spender: market.address, value: amountUsdc });
  } catch (e) {
    // The RPC's chain time and this device's clock disagree by more than signing.MAX_CLOCK_SKEW
    // seconds: nothing was signed. Its message says what to fix; errorMessage() would not.
    if (e instanceof signing.ClockSkewError) show(e.message);
    else show(errorMessage(e));
    return null;
  }
}
// ANCHOR_END: skew

export { costLines, deposit, permitFor, renderReason, formatUnits18 };
