// Collateral in and out: balance and allowance checks, exact approvals, USDC permits, withdrawals.
import {
  Bazaar,
  type PreparedCall,
  allowance,
  errorMessage,
  formatUnits18,
  fromUsdcUnits,
  parseUnits18,
  permits,
  toUsdcUnits,
  toUsdcUnitsCeil,
  trade,
} from "@liberta-labs/bazaar-sdk";
import type { Address } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: { token: pythToken } });
const [user] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);

/** Simulate, send and wait: the path from Sending Transactions. Returns false when it did not land. */
async function run(call: PreparedCall): Promise<boolean> {
  const sim = await bz.simulate(call);
  if (!sim.ok) {
    show(sim.error!.message);
    return false;
  }
  try {
    await bz.waitForReceipt(await bz.send(window.ethereum, call));
    return true;
  } catch (e) {
    show(errorMessage(e));
    return false;
  }
}

// ANCHOR: units
const amount = parseUnits18("100"); // 100 USDC, BAZAAR precision: 100n * 10n ** 18n
toUsdcUnits(amount); // 100_000_000n: what USDC's own functions count in (6 decimals)
fromUsdcUnits(1_500_000n); // 1.5 USDC back in BAZAAR precision
toUsdcUnitsCeil(parseUnits18("0.0000005")); // 1n: rounded up, for an allowance that must cover it
formatUnits18(amount); // "100"
allowance.formatUsdcUnits(2_500_000n); // "2.5"
// ANCHOR_END: units

// ANCHOR: deposit-approve
const deposit = await bz.trade.depositCollateral(eth.address, user, amount);
const funding = await bz.allowance.usdcFunding(user, eth.address, deposit.pullsUsdc ?? 0n);

if (!funding.enoughBalance) {
  show(`You have ${allowance.formatUsdcUnits(funding.balance)} USDC; this deposit needs ${allowance.formatUsdcUnits(funding.needUsdc)}.`);
} else {
  // An approval replaces the previous one, so approve the whole amount the call pulls, not the difference.
  const approved = funding.enoughAllowance || (await run(await bz.allowance.approveUsdc(user, eth.address, funding.approveUsdc)));
  if (approved) await run(deposit); // "Deposit 100 USDC as collateral"
}
// ANCHOR_END: deposit-approve

// ANCHOR: deposit-permit
// One signature instead of an approve transaction. A permit SETS the allowance, so skip it when the
// allowance already covers the deposit: signing one anyway would replace a larger approval.
const needUsdc = permits.permitValueFor(amount); // USDC units, rounded up
const current = await bz.allowance.usdcAllowance(user, eth.address);

let permitData: `0x${string}` = "0x";
if (current < needUsdc) {
  const permit = await bz.permits.signPermit(window.ethereum, {
    owner: user,
    spender: eth.address, // must be one of the deployment's pairs
    value: needUsdc,
    // deadline: unix seconds; default 30 minutes from now
  });
  permitData = permit.permitData;
}
await run(await bz.trade.depositCollateral(eth.address, user, amount, { permitData }));
// ANCHOR_END: deposit-permit

// ANCHOR: unlimited
// Only on the user's explicit choice, with a way to undo it.
const unlimited = await bz.allowance.approveUsdc(user, eth.address, 0n, { unlimited: true });
unlimited.summary; // "Allow 0x... to take an unlimited amount of USDC from your wallet"

const revoke = await bz.allowance.approveUsdc(user, eth.address, 0n);
revoke.summary; // "Revoke 0x...'s USDC allowance"
// ANCHOR_END: unlimited

// ANCHOR: withdraw
const want = parseUnits18("40");
const preview = await bz.previews.previewWithdrawal(eth.address, user, want);

if (preview.freezes.length > 0) {
  show(preview.freezes[0]!.message); // why nothing can be withdrawn right now
} else if (!preview.ok) {
  show(`${preview.blocker!.message} (at most ${formatUnits18(preview.maxWithdrawable, 2)} USDC now)`);
} else {
  await run(await bz.trade.withdrawCollateral(eth.address, user, want));
}
// ANCHOR_END: withdraw

// ANCHOR: terminal
// On a terminated market a withdrawal pays amount x principalRatio; null on a live market.
const terminal = await trade.terminalWithdrawal(bz.ctx, eth.address, user, want);
if (terminal) {
  show(trade.terminalPayoutNote(terminal.payout, terminal.principalRatio));
  // "the market is terminated: it pays 38.5 USDC, 96.25% of the amount"
}
// ANCHOR_END: terminal
