// Quick start, bot: a Node script that reads a market and its own account, tops up collateral with a
// USDC permit, rests a post-only limit order and cancels it. It reads RPC_URL, BAZAAR_FACTORY,
// PYTH_PRO_API_KEY, BOT_PRIVATE_KEY and MARKET (optional) from the environment.
import {
  BAZAAR_SCALE,
  CallError,
  Bazaar,
  OrderType,
  type PreparedCall,
  type Receipt,
  formatUnits18,
  fromUsdcUnits,
  live,
  orders,
  parseUnits18,
  toTransactionRequest,
  toUsdcUnitsCeil,
} from "@liberta-labs/bazaar-sdk";
import { type Address, type Hex, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, arbitrum, arbitrumSepolia } from "viem/chains";
import { localWallet } from "./local-wallet.js";

// ANCHOR: setup
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} in the environment`);
  return value;
}

const RPC_URL = env("RPC_URL"); // any JSON-RPC provider; a key in the URL never appears in errors
const account = privateKeyToAccount(env("BOT_PRIVATE_KEY") as Hex); // the key stays in this process
const me = account.address;
// ANCHOR_END: setup

// ANCHOR: connect
const bz = await Bazaar.connect({
  transport: RPC_URL, // reads through the SDK's own JSON-RPC client (rate limited, retried)
  factory: env("BAZAAR_FACTORY") as Address,
  prices: { token: env("PYTH_PRO_API_KEY") }, // Pyth Pro: a server may hold the API key itself
});

const chain = [arbitrum, arbitrumSepolia, anvil].find((c) => c.id === bz.chainId);
if (!chain) throw new Error(`no viem chain for chain id ${bz.chainId}`);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) }); // signs locally
// ANCHOR_END: connect

// ANCHOR: send
/** Simulate as the bot, send with the WalletClient, wait for the receipt. */
async function send(call: PreparedCall): Promise<Receipt> {
  const sim = await bz.simulate(call);
  if (!sim.ok) throw new CallError(`${call.summary}: ${sim.error!.message}`, sim.error);
  const hash = await wallet.sendTransaction({
    ...toTransactionRequest(call), // to, data, value (the Pyth fee, if any)
    account, // the local account itself: given only its address, viem would ask the node to sign
    ...(sim.gas !== null ? { gas: (sim.gas * 12n) / 10n } : {}), // the simulation's estimate, plus 20%
  });
  const receipt = await bz.waitForReceipt(hash); // throws CallError if it reverted
  console.log(`${call.summary}: ${hash} (block ${receipt.blockNumber})`);
  return receipt;
}

/**
 * For calls that carry a Pyth print (orders, amendments, withdrawals with a position): the pair
 * takes a print at most 3 s from the block's time, so build, simulate and send in one go, and
 * rebuild when the print is already more than 2 s old.
 */
async function sendPriced(build: () => Promise<PreparedCall>): Promise<Receipt> {
  for (let attempt = 1; ; attempt++) {
    const call = await build();
    if (attempt < 3 && Date.now() / 1000 - (call.priceTime ?? 0) > 2) continue;
    return send(call);
  }
}
// ANCHOR_END: send

// ANCHOR: read
async function readState(label: string) {
  const market = await bz.markets.getMarket(label); // a label, a pair address or a pair id
  const snap = await bz.markets.marketSnapshot(market);
  console.log(
    `${market.label} is ${snap.status}: stored price ${formatUnits18(snap.price.spot, 2)} (${snap.price.age} s old),` +
      ` funding ${formatUnits18(snap.funding.currentRatePerHour * 100n, 4)}%/h, max leverage ${snap.margin.maxLeverage ?? "-"}x`,
  );
  if (snap.marketOrdersDisabled) console.log(snap.reasons.marketOrdersDisabled);

  const mine = await bz.account.accountSnapshot(market, me);
  console.log(
    `collateral ${formatUnits18(mine.position.collateral, 2)} USDC, wallet ${formatUnits18(fromUsdcUnits(mine.wallet.usdcBalance), 2)} USDC,` +
      ` ${mine.hasPosition ? `position ${formatUnits18(mine.position.size)}` : "flat"}, ${mine.orders.length} open orders`,
  );
  return { market, snap, mine };
}
// ANCHOR_END: read

// ANCHOR: deposit
async function topUp(pair: Address, collateral: bigint): Promise<void> {
  const target = parseUnits18("50"); // keep $50 of collateral on this market
  if (collateral >= parseUnits18("20")) return;
  const amount = target - collateral;
  // A USDC permit instead of an approve transaction: a signature the deposit carries.
  const permit = await bz.permits.signPermit(localWallet(account), { owner: me, spender: pair, value: toUsdcUnitsCeil(amount) });
  await send(await bz.trade.depositCollateral(pair, me, amount, { permitData: permit.permitData }));
}
// ANCHOR_END: deposit

// ANCHOR: order
async function placeOrder(pair: Address): Promise<bigint | null> {
  const { price } = await bz.trade.livePairPrice(pair); // the composed Pyth price the pair will see
  const limitPrice = (price.spot * 98n) / 100n; // 2% under the market: it rests rather than fills
  const size = (parseUnits18("20") * BAZAAR_SCALE) / limitPrice; // about $20 of notional (the minimum is $5)
  const expirationBlock = (await bz.ctx.chain.blockNumber()) + orders.blocksIn(3600); // an hour of L2 blocks

  const receipt = await sendPriced(() =>
    bz.trade.createOrder(pair, me, { orderType: OrderType.Limit, isLong: true, size, limitPrice, expirationBlock, isPostOnly: true }),
  );
  // The new order's id is in its OrderUpdated event (action 0: created).
  for (const log of receipt.logs) {
    const e = live.decodeLiveLog(log);
    if (e?.source === "pair" && e.name === "OrderUpdated" && e.args.owner === me && e.args.payload.action === 0) return e.args.orderId;
  }
  return null;
}

async function cancel(pair: Address, orderId: bigint): Promise<void> {
  await send(await bz.trade.cancelOrders(pair, me, [orderId])); // any bounty returns to claimable fees
}
// ANCHOR_END: order

// ANCHOR: main
async function main(): Promise<void> {
  const { market, mine } = await readState(process.env.MARKET ?? "ETH/USD");
  await topUp(market.address, mine.position.collateral);
  const orderId = await placeOrder(market.address);
  if (orderId === null) throw new Error("the order did not rest (a post-only order that would cross is canceled)");
  console.log(`order #${orderId} is resting`);
  await cancel(market.address, orderId);
  await readState(market.label);
}

main().catch((e: unknown) => {
  // The SDK's errors say what happened in their message (with any URL's key masked). A user-facing
  // app would show errorMessage(e) instead; an operator wants the detail.
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
});
// ANCHOR_END: main
