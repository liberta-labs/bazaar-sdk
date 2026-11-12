// Several prepared calls in one transaction, from a smart account: EIP-5792 wallets and the example
// BazaarTradingAccount contract.
import { Bazaar, OrderType, type PreparedCall, batching, errorMessage, orders, parseUnits18, toUsdcUnits } from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, encodeFunctionData, erc20Abi, isAddressEqual } from "viem";

const FACTORY: Address = "0x0000000000000000000000000000000000000000";

const bz = await Bazaar.connect({ transport: window.ethereum, factory: FACTORY, prices: PRICES });
const eth = await bz.markets.getMarket("ETH/USD");
const show = (text: string) => console.log(text);
const { blocksIn } = orders;

// ANCHOR: build
// With a smart wallet, the connected address IS the account that trades: build every call from it.
const [account] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
const expiry = (await bz.ctx.chain.blockNumber()) + blocksIn(24 * 60 * 60);
const quote = (isLong: boolean, price: string) =>
  bz.trade.createOrder(eth.address, account, {
    orderType: OrderType.Limit,
    isLong,
    size: parseUnits18("1"),
    limitPrice: parseUnits18(price),
    isPostOnly: true,
    expirationBlock: expiry,
  });

const calls: PreparedCall[] = [
  await bz.allowance.approveUsdc(account, eth.address, toUsdcUnits(parseUnits18("2000"))),
  await bz.trade.depositCollateral(eth.address, account, parseUnits18("2000")),
  await quote(true, "2980"), // the first order carries the Pyth update...
  await quote(true, "2970"),
  await quote(false, "3020"), // ...the later ones are re-encoded without it
];
const batch = batching.shareOnePriceUpdate(calls);
// ANCHOR_END: build

// ANCHOR: eip5792
try {
  const id = await batching.sendCalls(window.ethereum, bz.ctx, account, batch); // atomic by default
  for (;;) {
    const status = (await batching.getCallsStatus(window.ethereum, id)) as { status?: number; receipts?: { transactionHash: Hex }[] };
    if (status.status === 200) {
      show(`batch landed: ${status.receipts?.[0]?.transactionHash}`);
      break;
    }
    if (status.status !== undefined && status.status >= 400) {
      show("the batch failed; nothing in it was applied");
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch (e) {
  show(errorMessage(e)); // a CallError: the wallet refused, or does not support wallet_sendCalls
}
// ANCHOR_END: eip5792

// ANCHOR: request
const request = bz.batching.walletSendCallsRequest(account, batch, {
  atomicRequired: true, // the default
  capabilities: { paymasterService: { url: "https://paymaster.example.com" } }, // passed through as given
});
// { method: "wallet_sendCalls", params: [{ version: "2.0.0", chainId: "0xa4b1", from, atomicRequired, calls, capabilities }] }
// ANCHOR_END: request

// ANCHOR: trading-account
// The example BazaarTradingAccount: the owner's EOA sends one execute() carrying every call.
const tradingAccount: Address = "0x0000000000000000000000000000000000000002";
const [owner] = (await window.ethereum.request({ method: "eth_accounts" })) as Address[];
if (!isAddressEqual(await bz.batching.readTradingAccountOwner(tradingAccount), owner)) throw new Error("only the account's owner may call execute");

const inner = batching.shareOnePriceUpdate([
  await bz.allowance.approveUsdc(tradingAccount, eth.address, toUsdcUnits(parseUnits18("2000"))),
  await bz.trade.depositCollateral(eth.address, tradingAccount, parseUnits18("2000")),
  await bz.trade.createOrder(eth.address, tradingAccount, { orderType: OrderType.Market, isLong: true, size: parseUnits18("0.5"), maxSlippageBp: 50n }),
]);
const exec = batching.tradingAccountExecute(tradingAccount, owner, inner);
exec.value; // the inner calls' Pyth fees, summed
exec.pullsUsdc; // from the trading account's USDC, not the owner's

const sim = await bz.simulate(exec);
if (!sim.ok) {
  show(sim.error!.message); // the first failing inner call's own revert, decoded
} else {
  const results = batching.decodeTradingAccountResults(sim.returnData); // one return value per inner call
  show(`${results.length} calls would succeed`);
  await bz.waitForReceipt(await bz.send(window.ethereum, exec));
}
// ANCHOR_END: trading-account

// ANCHOR: withdraw-to-owner
// withdrawCollateral pays the account, so move the USDC on to the owner in the same batch. The SDK has
// no transfer builder; encode USDC's transfer with viem.
const amount = parseUnits18("500");
const transfer: PreparedCall = {
  action: "transfer",
  to: bz.ctx.usdc,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, toUsdcUnits(amount)] }),
  value: 0n,
  from: tradingAccount,
  summary: `Send ${toUsdcUnits(amount) / 1_000_000n} USDC to ${owner}`,
};
const out = batching.tradingAccountExecute(tradingAccount, owner, [await bz.trade.withdrawCollateral(eth.address, tradingAccount, amount), transfer]);
if ((await bz.simulate(out)).ok) await bz.send(window.ethereum, out);
// ANCHOR_END: withdraw-to-owner

export { request };
