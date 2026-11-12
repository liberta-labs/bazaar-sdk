// Becoming an insurance LP: reading the fund, quoting a deposit at the live price, and depositing.
import { Bazaar, CallError, buildAndSend, errorMessage, formatUnits18, insurance, parseUnits18 } from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const bz = await Bazaar.connect({
  transport: window.ethereum,
  factory: "0x0000000000000000000000000000000000000000", // the deployment's factory
  prices: PRICES, // quotes and deposits read the live Pyth Pro price
});
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");

// ANCHOR: read
const [sharePrice, myShares, myValue] = await Promise.all([
  bz.insurance.getInsuranceSharePrice(eth.address), // USDC per share at the stored mark
  bz.insurance.insuranceShares(eth.address, user!), // 18 decimals
  bz.insurance.getInsuranceDepositValue(eth.address, user!), // what they redeem for at the stored mark
]);
console.log(`1 share = ${formatUnits18(sharePrice, 6)} USDC`);
console.log(`you hold ${formatUnits18(myShares, 4)} shares, worth ${formatUnits18(myValue, 2)} USDC`);
// ANCHOR_END: read

// ANCHOR: quote
const amount = parseUnits18("250"); // 250 USDC, in 18 decimals
if (amount < insurance.MIN_INSURANCE_DEPOSIT) console.log("The minimum insurance deposit is 5 USDC.");
const quote = await bz.insurance.quoteInsuranceDeposit(eth.address, amount);
console.log(`250 USDC buys about ${formatUnits18(quote.value, 4)} shares at ${formatUnits18(quote.price, 2)}`);
// ANCHOR_END: quote

// ANCHOR: deposit
async function deposit(amount: bigint): Promise<string> {
  // The deposit pulls USDC from the wallet: approve the pair for exactly what it pulls.
  const draft = await bz.insurance.depositToInsurance(eth.address, user!, amount);
  const funding = await bz.allowance.usdcFunding(user!, eth.address, draft.pullsUsdc!);
  if (!funding.enoughBalance) return "Your wallet does not hold enough USDC.";
  if (!funding.enoughAllowance) {
    const approve = await bz.allowance.approveUsdc(user!, eth.address, funding.approveUsdc);
    await bz.waitForReceipt(await bz.send(window.ethereum, approve));
  }
  // Build again right before the wallet prompt: a deposit made while the vault holds liquidated
  // inventory carries a price update that must still be fresh when it lands.
  const { hash } = await buildAndSend(window.ethereum, async () => {
    const call = await bz.insurance.depositToInsurance(eth.address, user!, amount);
    const sim = await bz.simulate(call);
    if (!sim.ok) throw new CallError(sim.error!.message, sim.error);
    return call;
  });
  await bz.waitForReceipt(hash);
  return "Deposited.";
}

try {
  console.log(await deposit(amount));
} catch (e) {
  console.error(errorMessage(e)); // one sentence for the LP
}
// ANCHOR_END: deposit
